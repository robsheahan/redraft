import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt, buildUserPrompt, buildCriteriaCheckPrompt } from '../prompts/feedback-system.js';
import { getSupabase } from '../lib/auth.js';
import { getDisciplineForCourse, skillDiscipline } from '../data/nesa-courses.js';
import { currentYearLevelFromGraduationYear } from '../data/nesa-reference.js';
import { VERB_DEPTH_MAP } from '../data/nesa-reference.js';
import { generateInlineSuggestions } from '../lib/generate-inline-suggestions.js';
import { extractTaskVerbs } from '../lib/task-verbs.js';
import { checkAndLogRateLimit } from '../lib/rate-limit.js';
import { captureError } from '../lib/sentry.js';
import { callTool } from '../lib/anthropic-tool-call.js';
import { HOLISTIC_FEEDBACK_TOOL, CRITERIA_CHECK_TOOL } from '../lib/feedback-tools.js';
import { looksLikeBandRubric, stripBandLabels } from '../lib/rubric-detect.js';
import { postCompletionIfLinked } from '../lib/lti/ags.js';
import { recordSkillSignals, readSkillProfile } from '../lib/skill-profile.js';
import { wrapUntrusted, capLen, sanitizeLabel } from '../lib/prompt-safety.js';
import { withHandler } from '../lib/with-handler.js';

export default withHandler({ methods: ['POST'], label: 'generate-feedback' }, async (req, res, ctx) => {
  const user = ctx.user!;
  const { question, course, criteria, criteria_text, outcomes, draft, notes, task_id, task_title, task_type,
    own_task_id, own_task_title, own_task_class_id, student_attachments,
    keystroke_count, paste_attempts_blocked, typing_session_count, total_typing_time_ms, time_to_first_keystroke_ms } = req.body;

  if (!draft) return res.status(400).json({ error: 'A draft is required.' });
  // When submitting against a task, only the task_id is needed — we read the
  // question, criteria and other fields from the DB. The "own task" flow
  // requires question + criteria_text directly.
  if (!task_id && !question) {
    return res.status(400).json({ error: 'Task id or a question is required.' });
  }

  // Lock: if the student already has a graded submission OR a
  // submitted-for-marking submission for this task, further drafts are
  // blocked.
  if (user && task_id) {
    // .limit(1) matters: without it maybeSingle() returns {data:null, error} when
    // MORE than one row matches (e.g. a teacher graded two draft rows), which
    // would silently unlock the task. And any read error fails CLOSED — we must
    // never let a transient DB error bypass the lock.
    const { data: locked, error: lockErr } = await getSupabase()
      .from('submissions')
      .select('id, graded_at, submitted_for_marking')
      .eq('student_id', user.id)
      .eq('task_id', task_id)
      .or('graded_at.not.is.null,submitted_for_marking.eq.true')
      .limit(1)
      .maybeSingle();
    if (lockErr) {
      captureError(lockErr, { stage: 'lock-check', task_id, user_id: user.id });
      return res.status(403).json({ error: 'Could not confirm this task is still open for drafts. Please try again in a moment.' });
    }
    if (locked) {
      const reason = locked.graded_at
        ? 'This task has been marked by your teacher. You cannot submit further drafts.'
        : 'You have already submitted this task for marking. AI feedback is disabled until your teacher marks it.';
      return res.status(403).json({ error: reason });
    }
  }

  // Draft sanity limits: cheap rejection before we pay Anthropic for nonsense
  const draftStr = String(draft);
  if (draftStr.trim().length < 50) {
    return res.status(400).json({ error: 'Your draft is too short for meaningful feedback — write at least a paragraph and try again.' });
  }
  if (draftStr.length > 30000) {
    return res.status(400).json({ error: 'Your draft is too long. Please shorten it to under 30,000 characters.' });
  }

  // Rate limit / spend protection: a per-user hourly cap plus a global
  // daily cap.
  //
  // Own-task submissions use a separate endpoint key for the per-hour and global
  // call limits. The per-DAY limit is enforced as "distinct tasks started today"
  // further down (3 own tasks / 5 class tasks per student per day) — a count the
  // blunt call-count limiter can't express now that own tasks are a 3-draft model.
  const isOwnTaskSubmission = !task_id;
  const rateLimit = await checkAndLogRateLimit(getSupabase(), user?.id || null, {
    endpoint: isOwnTaskSubmission ? 'generate-feedback-own' : 'generate-feedback',
    perUserPerHour: 10,
    globalPerDay: 5000,
  });
  if (!rateLimit.ok) {
    if (rateLimit.retryAfterSeconds) res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    return res.status(429).json({ error: rateLimit.reason || 'Rate limit exceeded. Please try again later.' });
  }

  // Resubmission handling: cap at 3 drafts per student per task
  const MAX_DRAFTS = 3;
  let draftVersion = 1;
  let priorDrafts: Array<{ draft_text: string; feedback: any; draft_version: number }> = [];

  // If a task_id was provided, load task + verify access + pull server-side fields
  let resolvedTask: any = null;
  let teacherNotes = notes || null;
  let resolvedQuestion = question || null;
  let resolvedCourse = course || null;
  let resolvedCriteriaText = criteria_text || null;
  let resolvedTaskType = req.body?.task_type || null;
  let resolvedCriteria = criteria || [];
  let resolvedOutcomes = outcomes || [];
  let resolvedTitle = task_title || null;

  // Daily "distinct tasks started today" count for the per-day caps. Counts the
  // distinct tasks (teacher task_id or own_task_id) this student STARTED — i.e.
  // submitted draft 1 of — in the last 24h. Drafts 2-3 of an already-started
  // task carry draft_version > 1 and so don't inflate the count. Returns -1 on a
  // read error (fail-open — the per-hour + global caps still protect spend).
  async function distinctTasksStartedToday(column: 'task_id' | 'own_task_id'): Promise<number> {
    const sb = getSupabase();
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await sb
      .from('submissions')
      .select(column)
      .eq('student_id', user!.id)
      .eq('draft_version', 1)
      .gte('created_at', oneDayAgo)
      .not(column, 'is', null);
    if (error) {
      console.warn('[daily-cap] distinct-task count failed, allowing:', error.message);
      return -1;
    }
    return new Set((data || []).map((r: any) => r[column])).size;
  }

  if (user && task_id) {
    const supabase = getSupabase();
    const { data: task } = await supabase.from('tasks').select('*').eq('id', task_id).maybeSingle();
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    if (!task.published_at) return res.status(400).json({ error: 'This task is a draft and not yet open for submissions.' });

    // Student must be a member of the task's class
    const { data: membership } = await supabase
      .from('class_members').select('student_id').eq('class_id', task.class_id).eq('student_id', user.id).maybeSingle();
    if (!membership) return res.status(403).json({ error: 'You are not a member of this task\'s class.' });

    resolvedTask = task;
    resolvedQuestion = task.question;
    resolvedCourse = task.course || null;
    resolvedCriteriaText = task.criteria_text || null;
    resolvedCriteria = task.criteria || [];
    resolvedOutcomes = task.outcomes || [];
    resolvedTaskType = task.task_type || null;
    resolvedTitle = task.title || null;
    teacherNotes = task.notes || null;

    // Fail closed: if we can't read the prior drafts we can't enforce the
    // 3-draft cap or the daily distinct-task cap — return 500 BEFORE spending
    // an Anthropic call rather than skipping the caps.
    const { data: priorSubs, error: priorErr } = await supabase
      .from('submissions')
      .select('draft_text, feedback, draft_version')
      .eq('student_id', user.id)
      .eq('task_id', task_id)
      .order('draft_version', { ascending: true });
    if (priorErr) {
      captureError(priorErr, { stage: 'prior-drafts-read', task_id, user_id: user.id });
      return res.status(500).json({ error: 'Could not check your draft history. Please try again.' });
    }
    priorDrafts = priorSubs || [];
    if (priorDrafts.length >= MAX_DRAFTS) {
      return res.status(400).json({
        error: `You've reached the maximum of ${MAX_DRAFTS} drafts for this task.`,
      });
    }
    draftVersion = priorDrafts.length + 1;

    // Daily cap: a student can START up to 5 distinct class tasks per day.
    // Adding drafts 2-3 to an already-started task does not count.
    if (priorDrafts.length === 0 && (await distinctTasksStartedToday('task_id')) >= 5) {
      return res.status(429).json({
        error: "You've started 5 different class tasks today — that's the daily limit. You can still add more drafts to a task you've already started, or come back tomorrow.",
      });
    }
  } else if (user && isOwnTaskSubmission) {
    const supabase = getSupabase();
    if (!own_task_id || !own_task_title) {
      return res.status(400).json({ error: 'Give your own task a title before getting feedback.' });
    }
    resolvedTitle = own_task_title;

    // Drafts of this own task share a stable own_task_id, so the same 3-draft
    // iterative model as teacher tasks applies. Fail closed on a read error —
    // never skip the caps and spend an Anthropic call blind.
    const { data: priorSubs, error: priorErr } = await supabase
      .from('submissions')
      .select('draft_text, feedback, draft_version')
      .eq('student_id', user.id)
      .eq('own_task_id', own_task_id)
      .order('draft_version', { ascending: true });
    if (priorErr) {
      captureError(priorErr, { stage: 'prior-drafts-read-own', own_task_id, user_id: user.id });
      return res.status(500).json({ error: 'Could not check your draft history. Please try again.' });
    }
    priorDrafts = priorSubs || [];
    if (priorDrafts.length >= MAX_DRAFTS) {
      return res.status(400).json({
        error: `You've reached the maximum of ${MAX_DRAFTS} drafts for this task.`,
      });
    }
    draftVersion = priorDrafts.length + 1;

    // Daily cap: a student can START up to 3 of their own tasks per day.
    if (priorDrafts.length === 0 && (await distinctTasksStartedToday('own_task_id')) >= 3) {
      return res.status(429).json({
        error: "You've started 3 of your own tasks today — that's the daily limit. You can still add more drafts to a task you've already started, or come back tomorrow.",
      });
    }
  }

  // Own-task fields arrive from req.body, student-authored and unbounded. Cap
  // each (P10) and sanitise the course label that lands in the system prompt;
  // the prompt builders fence the rest as untrusted (via `untrusted` below).
  // Teacher-task fields come from the DB and stay as-is.
  if (isOwnTaskSubmission) {
    if (resolvedQuestion) resolvedQuestion = capLen(resolvedQuestion, 5000);
    if (resolvedCriteriaText) resolvedCriteriaText = capLen(resolvedCriteriaText, 10000);
    if (teacherNotes) teacherNotes = capLen(teacherNotes, 2000);
    if (resolvedCourse) resolvedCourse = sanitizeLabel(resolvedCourse, 80);
    if (resolvedTitle) resolvedTitle = capLen(resolvedTitle, 200);
  }

  const taskVerbs = extractTaskVerbs(String(resolvedQuestion || ''));
  const taskVerb = taskVerbs[0] || null;

  const taskDescription = resolvedCourse
    ? `${resolvedCourse}\n\nQuestion:\n${resolvedQuestion}`
    : `Question:\n${resolvedQuestion}`;

  const rawCriteriaText = resolvedCriteriaText || null;
  const mappedCriteria = !rawCriteriaText && Array.isArray(resolvedCriteria)
    ? resolvedCriteria.map((c: any) => {
        const marksStr = String(c.marks || '0');
        const maxMarks = parseInt(marksStr.includes('-') ? marksStr.split('-')[1] : marksStr) || 0;
        return { name: c.name || '', description: c.name || '', maxMarks };
      })
    : [];

  // Band-style rubrics ("Grade A (21–25 marks): …", "Band 5 (17–20): …")
  // describe quality levels of the overall response, not separable
  // criteria. Two consequences:
  //   1. We strip the band labels and mark ranges before the criteria
  //      reach the model — otherwise it occasionally copy-pastes the
  //      label back at the student, violating the no-bands rule.
  //   2. Pass 2 still runs, but with a band-aware prompt that asks the
  //      model to synthesise the distinct quality dimensions described
  //      across the bands (e.g. "depth of analysis", "use of evidence")
  //      and give per-dimension strengths/improvements — no band labels.
  const isBandRubric = looksLikeBandRubric(rawCriteriaText);
  const criteriaTextForModel = rawCriteriaText && isBandRubric
    ? stripBandLabels(rawCriteriaText)
    : rawCriteriaText;

  const outcomesList = (resolvedOutcomes || []).map((o: any) =>
    typeof o === 'string' ? o : o.code || ''
  );

  const discipline = resolvedCourse ? getDisciplineForCourse(resolvedCourse as string) : null;
  const gradYear = (user?.user_metadata as any)?.graduation_year;
  const yearLevel = typeof gradYear === 'number' ? currentYearLevelFromGraduationYear(gradYear) : null;
  const systemPrompt = buildSystemPrompt(
    resolvedCourse as string || undefined,
    discipline || undefined,
    yearLevel || undefined,
  );

  // Graduated feedback prompts (Clarke): read the student's skill profile so
  // Pass 1 can pitch each improvement at the right support level (reminder /
  // scaffold / example). Best-effort and read-side only — on no data or any
  // error readSkillProfile returns [], and the prompt falls back to scaffolded
  // prompts for everyone. Discipline matches the write path's rollup key.
  const readiness = user
    ? await readSkillProfile(getSupabase(), user.id, skillDiscipline(resolvedCourse as string))
    : [];

  const userPrompt = buildUserPrompt({
    taskDescription,
    taskVerb: taskVerb || undefined,
    taskVerbs: taskVerbs.length > 0 ? taskVerbs : undefined,
    outcomes: outcomesList,
    criteria: mappedCriteria,
    criteriaText: criteriaTextForModel || undefined,
    studentText: draft,
    teacherNotes: teacherNotes || undefined,
    taskType: resolvedTaskType || undefined,
    priorDrafts: priorDrafts.length > 0 ? priorDrafts : undefined,
    draftVersion,
    readiness,
    untrusted: isOwnTaskSubmission,
  });

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });

    // Pass 2 prompt (independent — doesn't depend on Pass 1). Runs for both
    // band-style and per-criterion rubrics; the system prompt switches on
    // isBandRubric (see buildCriteriaCheckPrompt above).
    // hide_criteria_from_students: skip Pass 2 entirely. The student should
    // never see criterion-by-criterion AI feedback when the teacher has
    // chosen exam-style mode. The rubric + per-criterion teacher marks
    // reveal post-grading via feedback.html's teacher tab.
    const hideCriteriaFromStudent = !!(resolvedTask && (resolvedTask as any).hide_criteria_from_students);
    const hasCriteria = !hideCriteriaFromStudent && (!!(rawCriteriaText && rawCriteriaText.trim()) || mappedCriteria.length > 0);
    const criteriaBlock: string = (criteriaTextForModel && criteriaTextForModel.trim())
      || (mappedCriteria.length > 0
          ? mappedCriteria.map((c, i) => `${i + 1}. ${c.name} (${c.maxMarks} marks): ${c.description}`).join('\n')
          : 'No specific criteria provided — assess against general HSC standards');

    const criteriaCheckPrompt = `ASSESSMENT TASK:
${isOwnTaskSubmission ? wrapUntrusted('student_task_brief', taskDescription) : taskDescription}

MARKING CRITERIA:
${isOwnTaskSubmission ? wrapUntrusted('student_task_criteria', criteriaBlock) : criteriaBlock}

---

STUDENT'S DRAFT RESPONSE:
${wrapUntrusted('student_draft', draft)}

---

Assess this draft against each marking criterion above. Address every criterion individually.`;

    // All 3 passes in parallel. Total time = max(Pass1, Pass2, Pass3)
    // instead of Pass1 + max(Pass2, Pass3) = roughly half the wall clock.
    // Pass 3 used to receive Pass 1's improvements as context for its
    // linked_improvement_index field; we drop that to allow parallel
    // execution. The trade-off is that annotations no longer cross-link
    // back to specific holistic improvements, but they still anchor to
    // exact draft quotes which is the more important coherence signal.
    //
    // Each pass uses forced tool-use (`tool_choice` pinned to a named tool)
    // so the SDK returns structured input that conforms to the tool schema —
    // no JSON parsing, no "model wrote prose first" failure mode. callTool
    // also retries once on transient errors (429, 5xx, network blips,
    // missing tool_use block).
    const t0 = Date.now();
    const pass2Promise = hasCriteria
      ? callTool<{ criteria_feedback: any }>({
          client,
          model: 'claude-sonnet-5',
          max_tokens: 2000,
          system: buildCriteriaCheckPrompt(resolvedCourse as string || undefined, isBandRubric),
          user: criteriaCheckPrompt,
          tool: CRITERIA_CHECK_TOOL,
          cacheSystem: true,
          label: 'feedback:criteria',
          requiredKeys: ['criteria_feedback'],
        })
      : Promise.resolve(null);
    const [pass1Settled, pass2Settled, inlineSettled] = await Promise.allSettled([
      callTool<Record<string, any>>({
        client,
        model: 'claude-sonnet-5',
        max_tokens: 5000,
        system: systemPrompt,
        user: userPrompt,
        tool: HOLISTIC_FEEDBACK_TOOL,
        cacheSystem: true,
        label: 'feedback:holistic',
        // Student-facing essentials. A truncation that cuts into these makes
        // Pass 1 fail (→ friendly 502, draft NOT consumed) rather than persist
        // gutted feedback. The trailing skill_assessment is intentionally not
        // required — the schema orders it last so truncation drops it first.
        requiredKeys: ['what_youve_done_well', 'improvements', 'top_priority'],
      }),
      pass2Promise,
      generateInlineSuggestions(client, {
        taskDescription,
        taskVerbs: taskVerbs.length > 0 ? taskVerbs : undefined,
        studentText: draft,
        holisticImprovements: [],
        courseName: resolvedCourse as string || undefined,
        discipline: discipline || undefined,
      }),
    ]);
    console.log('[generate-feedback] all 3 passes settled in', (Date.now() - t0) + 'ms');

    // Pass 1 is load-bearing — without it we have no feedback to return.
    // With forced tool use + 1 retry, the only failure modes left are
    // hard API errors (auth, sustained outage, content filter). Surface
    // a friendly retry message in those cases.
    if (pass1Settled.status !== 'fulfilled') {
      const reason = pass1Settled.reason;
      console.error('[generate-feedback] Pass 1 rejected after retries:', reason?.message || reason);
      captureError(reason, { stage: 'pass1', task_id, user_id: user?.id });
      return res.status(502).json({ error: 'Could not generate feedback. Please try again — your draft was not lost.' });
    }
    const initialFeedback = pass1Settled.value.value;

    let criteriaFeedback: any = null;
    if (pass2Settled.status === 'fulfilled' && pass2Settled.value) {
      criteriaFeedback = pass2Settled.value.value?.criteria_feedback || null;
    } else if (pass2Settled.status === 'rejected') {
      console.warn('[generate-feedback] Pass 2 rejected after retries:', pass2Settled.reason?.message || pass2Settled.reason);
    }

    let inlineSuggestions: any[] = [];
    if (inlineSettled.status === 'fulfilled') {
      inlineSuggestions = inlineSettled.value.annotations;
    } else {
      console.warn('[generate-feedback] Pass 3 rejected:', inlineSettled.reason?.message || inlineSettled.reason);
    }

    // Pull the skill read out of the holistic output — it's captured for the
    // skill database, never shown to the student.
    const { skill_assessment: skillAssessment, ...holisticFields } = initialFeedback;

    const feedback = {
      ...holisticFields,
      criteria_feedback: criteriaFeedback,
      inline_suggestions: inlineSuggestions,
      // Lets the renderer label the criteria_feedback section appropriately
      // — "Feedback by quality dimension" for band rubrics (where the model
      // synthesises dimensions from band descriptors), "Feedback by marking
      // criterion" for everything else.
      is_band_rubric: isBandRubric,
    };

    const successPayload = {
      feedback,
      draft_text: draft,
      meta: {
        taskVerb,
        taskVerbs,
        question: resolvedQuestion,
        course: resolvedCourse,
        title: resolvedTitle,
        task_id: task_id || null,
        draftVersion,
        maxDrafts: MAX_DRAFTS,
      },
    };

    // Save submission if user is authenticated
    if (user) {
      const supabase = getSupabase();
      const { data: insertedSub, error: insertErr } = await supabase.from('submissions').insert({
        student_id: user.id,
        task_id: task_id || null,
        // Own-task columns are only written for own tasks — so a teacher-task
        // submission never references them, and teacher feedback keeps saving
        // even if the own-task migration hasn't been applied yet.
        ...(isOwnTaskSubmission ? {
          own_task_id: own_task_id || null,
          own_task_title: own_task_title || null,
          own_task_class_id: own_task_class_id || null,
          own_task_criteria_text: resolvedCriteriaText || null,
        } : {}),
        question: resolvedQuestion,
        course: resolvedCourse || null,
        draft_text: draft,
        feedback,
        skill_assessment: Array.isArray(skillAssessment) ? skillAssessment : null,
        draft_version: draftVersion,
        keystroke_count: typeof keystroke_count === 'number' ? keystroke_count : null,
        paste_attempts_blocked: typeof paste_attempts_blocked === 'number' ? paste_attempts_blocked : null,
        typing_session_count: typeof typing_session_count === 'number' ? typing_session_count : null,
        total_typing_time_ms: typeof total_typing_time_ms === 'number' ? total_typing_time_ms : null,
        time_to_first_keystroke_ms: typeof time_to_first_keystroke_ms === 'number' ? time_to_first_keystroke_ms : null,
        student_attachments: Array.isArray(student_attachments) ? student_attachments.slice(0, 5) : [],
      }).select('id').single();
      // 23505 = a concurrent/duplicate submit already stored this
      // draft_version (double-click). The unique index kept it from becoming a
      // second row + a second round of Sonnet spend; the student still gets
      // their feedback, so return it and skip the side-effects the winning
      // request already ran — don't 500.
      if (insertErr && (insertErr as any).code === '23505') {
        console.warn('[generate-feedback] duplicate draft insert ignored (idempotent)', { task_id, user_id: user.id, draftVersion });
        return res.status(200).json(successPayload);
      }
      // Any other failure means the draft was never stored — surfacing it (as
      // the maths path does) beats silently returning feedback that the 3-draft
      // model and teacher marking will never see.
      if (insertErr) {
        captureError(insertErr, { stage: 'submission-insert', task_id, user_id: user.id });
        return res.status(500).json({ error: 'Could not save your submission. Please try again.' });
      }

      // Post-submission side effects. These must never affect the feedback the
      // student just received (each swallows its own error), but they DO need to
      // finish before we respond: on Vercel the instance is frozen once the
      // response is sent, which tears down any in-flight socket and surfaces as
      // `write ETIMEDOUT` / `TypeError: fetch failed`. So collect them and await
      // in parallel right before returning rather than firing and forgetting.
      const bgWrites: PromiseLike<unknown>[] = [];

      // Fold the skill read into the student's rollup (the skill database).
      if (Array.isArray(skillAssessment) && skillAssessment.length > 0) {
        bgWrites.push(
          recordSkillSignals({
            supabase,
            studentId: user.id,
            discipline: skillDiscipline(resolvedCourse as string),
            family: 'writing',
            assessment: skillAssessment,
            submissionId: insertedSub?.id,
            taskId: task_id || null,
          }).catch(err => captureError(err, { stage: 'skill-rollup', user_id: user.id, task_id }))
        );
      }

      // Mark the longitudinal profile stale — AI feedback is treated as a
      // quality signal alongside teacher marks. The row is kept (not deleted)
      // so the class summary still has last-known-good data; the read path
      // regenerates on next individual view.
      bgWrites.push(
        supabase.from('student_profile_synthesis')
          .update({ stale: true })
          .eq('student_id', user.id)
          .then(({ error }) => {
            if (error) captureError(error, { stage: 'profile-cache-invalidate', user_id: user.id });
          })
      );

      if (task_id) {
        bgWrites.push(
          supabase.from('draft_autosaves')
            .delete()
            .eq('student_id', user.id)
            .eq('task_id', task_id)
            .then(({ error }) => {
              if (error) captureError(error, { stage: 'autosave-clear', task_id, user_id: user.id });
            })
        );

        bgWrites.push(
          postCompletionIfLinked({
            taskId: task_id,
            studentId: user.id,
            comment: `Draft ${draftVersion} submitted via ProofReady`,
          }).catch(err => captureError(err, { stage: 'ags-passback', task_id, user_id: user.id }))
        );
      }

      await Promise.allSettled(bgWrites);
    }

    return res.status(200).json(successPayload);
  } catch (err: any) {
    captureError(err, { stage: 'top-level', task_id, user_id: user?.id });
    return res.status(500).json({ error: 'Failed to generate feedback. Please try again.' });
  }
});
