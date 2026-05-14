import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors } from '../lib/cors.js';
import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt, buildUserPrompt } from '../prompts/feedback-system.js';
import { getSupabase, verifyAuth } from '../lib/auth.js';
import { getDisciplineForCourse } from '../data/nesa-courses.js';
import { VERB_DEPTH_MAP } from '../data/nesa-reference.js';
import { generateInlineSuggestions } from '../lib/generate-inline-suggestions.js';
import { extractTaskVerbs } from '../lib/task-verbs.js';
import { checkAndLogRateLimit } from '../lib/rate-limit.js';
import { captureError } from '../lib/sentry.js';
import { callTool } from '../lib/anthropic-tool-call.js';
import { HOLISTIC_FEEDBACK_TOOL, CRITERIA_CHECK_TOOL } from '../lib/feedback-tools.js';
import { looksLikeBandRubric, stripBandLabels } from '../lib/rubric-detect.js';
import { postCompletionIfLinked } from '../lib/lti/ags.js';

function buildCriteriaCheckPrompt(courseName?: string, isBandRubric?: boolean): string {
  const subjectLabel = courseName || "this HSC subject";

  if (isBandRubric) {
    // Band-style rubrics describe quality levels of the overall response, not
    // separable criteria. Asking the model to assess "per criterion" against a
    // band rubric produces incoherent "strengths/improvements at Band 5"
    // output. Instead, have the model SYNTHESISE the distinct quality
    // dimensions described across the bands (e.g. "depth of analysis", "use
    // of evidence") and give feedback per dimension — no band labels, no
    // mark predictions.
    return `You are a senior ${subjectLabel} marker. The teacher has provided a band-style rubric — descriptors at different performance levels rather than separate criteria. You are independently assessing a student's draft. You have NOT seen any other feedback — you are making a fresh assessment.

YOUR TASK:
Identify 3–5 distinct QUALITY DIMENSIONS embedded in the band descriptors (e.g. "Depth of analysis", "Use of evidence", "Communication and structure", "Integration across the question"). For EACH dimension, give the student specific feedback on their draft.

For each dimension, provide:
- "criterion": The dimension name in your own plain-English words (e.g. "Depth of analysis"). Do NOT quote the rubric's wording verbatim. Do NOT include any band/grade label or mark range in this field.
- "strengths": What the student does well on this dimension. Genuine and specific — reference their actual text.
- "improvements": What needs to change on this dimension. Reference their actual text, give an actionable step.

VOICE: Write directly to the student using "you/your". Be warm but honest. Australian English spelling.

Keep each point tight — one sentence for the observation, one for the action. No padding.

ABSOLUTE RULES — do NOT do any of the following anywhere in your response:
- Reference any band, grade label, mark range, mark count, or quality level by name (e.g. "Band 5", "Grade A", "high-band", "21-25 range", "this would sit at the top band").
- Quote band descriptors verbatim. Synthesise the dimension yourself in plain language.
- Predict where the student would land in the rubric, or which level they're "currently at".
- Make any mark or band prediction whatsoever.

The band descriptors are reference material for YOUR judgement of quality — they are not something to share with the student. Describe what is working and what would strengthen the response in plain language.

OUTPUT FORMAT:
Respond in JSON:
{
  "criteria_feedback": [
    {
      "criterion": "Dimension name",
      "strengths": "what's working on this dimension",
      "improvements": "specific actions to strengthen the response on this dimension"
    }
  ]
}`;
  }

  return `You are a senior ${subjectLabel} marker. You are independently assessing a student's draft response against the marking criteria provided by their teacher. You have NOT seen any other feedback — you are making a fresh assessment.

YOUR TASK:
For EACH marking criterion the teacher has provided, assess the student's draft and produce specific feedback. You must address every criterion individually — do not skip any.

For each criterion, provide:
- "criterion": The criterion name/description (as the teacher wrote it)
- "strengths": What the student has done well against this specific criterion (be genuine — only list real strengths)
- "improvements": What needs to change to strengthen the response against this criterion. Be specific — reference their actual text and give actionable steps.

VOICE: Write directly to the student using "you/your". Be warm but honest. Use Australian English spelling.

Keep each point tight — one sentence for the observation, one for the action. No padding.

DO NOT make band or mark judgements. This is absolute. You must NOT reference any band, band range, mark count, or mark range in any field, ever. Forbidden: "this is at Band 4", "currently a 10-mark answer", "this will push you into the 13–15 range", "this will get you another mark", "around the B range". Describe what is working and what would strengthen the response in plain language. Say "push deeper into analysis" not "lift this to Band 5". Your internal knowledge of band descriptors is for calibrating your expectations — it is NOT something to share with the student.

OUTPUT FORMAT:
Respond in JSON:
{
  "criteria_feedback": [
    {
      "criterion": "the criterion text",
      "strengths": "what's working for this criterion",
      "improvements": "specific actions to strengthen the response against this criterion"
    }
  ]
}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await verifyAuth(req);
  const { question, course, criteria, criteria_text, outcomes, draft, notes, task_id, task_title, task_type } = req.body;

  if (!draft) return res.status(400).json({ error: 'A draft is required.' });
  // When submitting against a task, only the task_id is needed — we read the
  // question, criteria and other fields from the DB. The "own task" flow
  // requires question + criteria_text directly.
  if (!task_id && !question) {
    return res.status(400).json({ error: 'Task id or a question is required.' });
  }

  // Draft sanity limits: cheap rejection before we pay Anthropic for nonsense
  const draftStr = String(draft);
  if (draftStr.trim().length < 50) {
    return res.status(400).json({ error: 'Your draft is too short for meaningful feedback — write at least a paragraph and try again.' });
  }
  if (draftStr.length > 30000) {
    return res.status(400).json({ error: 'Your draft is too long. Please shorten it to under 30,000 characters.' });
  }

  // Rate limit / spend protection. Logged-in users get a per-user hourly
  // cap and count toward the global daily cap; anon users only count toward
  // the global cap (no identity to cap them individually).
  //
  // Own-task submissions (no task_id) get an additional per-user daily cap
  // and a separate endpoint key — without it, a student could bypass the
  // per-task 3-draft cap by spinning up a new "own task" for each new
  // attempt at the same draft. Teacher-task drafts have no daily user cap
  // because the per-task draft cap already protects against abuse.
  const isOwnTaskSubmission = !task_id;
  const rateLimit = await checkAndLogRateLimit(getSupabase(), user?.id || null, {
    endpoint: isOwnTaskSubmission ? 'generate-feedback-own' : 'generate-feedback',
    perUserPerHour: 10,
    perUserPerDay: isOwnTaskSubmission ? 5 : undefined,
    perUserPerDayMessage: isOwnTaskSubmission
      ? "You've reached your daily limit of 5 own-task submissions. To get more feedback today, submit through a class task your teacher has posted, or try again tomorrow."
      : undefined,
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

    const { data: priorSubs } = await supabase
      .from('submissions')
      .select('draft_text, feedback, draft_version')
      .eq('student_id', user.id)
      .eq('task_id', task_id)
      .order('draft_version', { ascending: true });
    if (priorSubs) {
      priorDrafts = priorSubs;
      if (priorSubs.length >= MAX_DRAFTS) {
        return res.status(400).json({
          error: `You've reached the maximum of ${MAX_DRAFTS} drafts for this task.`,
        });
      }
      draftVersion = priorSubs.length + 1;
    }
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
  const systemPrompt = buildSystemPrompt(resolvedCourse as string || undefined, discipline || undefined);
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
  });

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Pass 2 prompt (independent — doesn't depend on Pass 1). Runs for both
    // band-style and per-criterion rubrics; the system prompt switches on
    // isBandRubric (see buildCriteriaCheckPrompt above).
    const hasCriteria = !!(rawCriteriaText && rawCriteriaText.trim()) || mappedCriteria.length > 0;
    const criteriaBlock: string = (criteriaTextForModel && criteriaTextForModel.trim())
      || (mappedCriteria.length > 0
          ? mappedCriteria.map((c, i) => `${i + 1}. ${c.name} (${c.maxMarks} marks): ${c.description}`).join('\n')
          : 'No specific criteria provided — assess against general HSC standards');

    const criteriaCheckPrompt = `ASSESSMENT TASK:
${taskDescription}

MARKING CRITERIA:
${criteriaBlock}

---

STUDENT'S DRAFT RESPONSE:
${draft}

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
          model: 'claude-sonnet-4-6',
          max_tokens: 2000,
          temperature: 0.3,
          system: buildCriteriaCheckPrompt(resolvedCourse as string || undefined, isBandRubric),
          user: criteriaCheckPrompt,
          tool: CRITERIA_CHECK_TOOL,
        })
      : Promise.resolve(null);
    const [pass1Settled, pass2Settled, inlineSettled] = await Promise.allSettled([
      callTool<Record<string, any>>({
        client,
        model: 'claude-sonnet-4-6',
        max_tokens: 5000,
        temperature: 0.2,
        system: systemPrompt,
        user: userPrompt,
        tool: HOLISTIC_FEEDBACK_TOOL,
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

    const feedback = {
      ...initialFeedback,
      criteria_feedback: criteriaFeedback,
      inline_suggestions: inlineSuggestions,
      // Lets the renderer label the criteria_feedback section appropriately
      // — "Feedback by quality dimension" for band rubrics (where the model
      // synthesises dimensions from band descriptors), "Feedback by marking
      // criterion" for everything else.
      is_band_rubric: isBandRubric,
    };

    // Save submission if user is authenticated
    if (user) {
      const supabase = getSupabase();
      await supabase.from('submissions').insert({
        student_id: user.id,
        task_id: task_id || null,
        question: resolvedQuestion,
        course: resolvedCourse || null,
        draft_text: draft,
        feedback,
        draft_version: draftVersion,
      });

      if (task_id) {
        postCompletionIfLinked({
          taskId: task_id,
          studentId: user.id,
          comment: `Draft ${draftVersion} submitted via ProofReady`,
        }).catch(err => captureError(err, { stage: 'ags-passback', task_id, user_id: user.id }));
      }
    }

    return res.status(200).json({
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
    });
  } catch (err: any) {
    captureError(err, { stage: 'top-level', task_id, user_id: user?.id });
    return res.status(500).json({ error: err.message || 'Failed to generate feedback' });
  }
}
