import type { VercelRequest, VercelResponse } from '@vercel/node';
import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt, buildUserPrompt } from '../prompts/feedback-system.js';
import { getSupabase, verifyAuth } from '../lib/auth.js';
import { getDisciplineForCourse } from '../data/nesa-courses.js';
import { VERB_DEPTH_MAP } from '../data/nesa-reference.js';
import { generateInlineSuggestions } from '../lib/generate-inline-suggestions.js';
import { extractTaskVerbs } from '../lib/task-verbs.js';
import { extractFirstJsonObject } from '../lib/extract-json.js';
import { checkAndLogRateLimit } from '../lib/rate-limit.js';

function buildCriteriaCheckPrompt(courseName?: string): string {
  const subjectLabel = courseName || "this HSC subject";
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
  const rateLimit = await checkAndLogRateLimit(getSupabase(), user?.id || null, {
    endpoint: 'generate-feedback',
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
    criteriaText: rawCriteriaText || undefined,
    studentText: draft,
    teacherNotes: teacherNotes || undefined,
    taskType: resolvedTaskType || undefined,
    priorDrafts: priorDrafts.length > 0 ? priorDrafts : undefined,
    draftVersion,
  });

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Pass 2 prompt (independent — doesn't depend on Pass 1)
    const criteriaBlock: string = rawCriteriaText
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
    // Pass 1 max_tokens raised to 5000 — diagnostic logs showed the model
    // hitting 4000 mid-self_check on rich drafts (the prompt asks for
    // exhaustive feedback). 5000 leaves comfortable closing-brace headroom.
    const t0 = Date.now();
    const [pass1Settled, pass2Settled, inlineSettled] = await Promise.allSettled([
      client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 5000,
        temperature: 0.2,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        temperature: 0.3,
        system: buildCriteriaCheckPrompt(resolvedCourse as string || undefined),
        messages: [{ role: 'user', content: criteriaCheckPrompt }],
      }),
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

    // Pass 1 is load-bearing — without it we have no feedback to return
    if (pass1Settled.status !== 'fulfilled') {
      console.error('[generate-feedback] Pass 1 rejected:', pass1Settled.reason?.message || pass1Settled.reason);
      return res.status(502).json({ error: 'Could not generate feedback. Please try again — your draft was not lost.' });
    }
    const pass1 = pass1Settled.value;
    const pass1Text = pass1.content[0].type === 'text' ? pass1.content[0].text : '';
    const pass1Json = extractFirstJsonObject(pass1Text);
    if (!pass1Json) {
      const stopReason = (pass1 as any).stop_reason || 'unknown';
      console.error('[generate-feedback] Pass 1 unparseable. stop_reason=', stopReason, 'tail=', pass1Text.slice(-400));
      const friendly = stopReason === 'max_tokens'
        ? 'Feedback generation ran out of room before finishing. Try shortening your draft slightly and resubmitting.'
        : 'Could not parse the feedback response. Please try again — your draft was not lost.';
      return res.status(502).json({ error: friendly });
    }

    let initialFeedback;
    try {
      initialFeedback = JSON.parse(pass1Json);
    } catch (e: any) {
      console.error('[generate-feedback] Pass 1 JSON.parse failed:', e?.message, 'raw=', pass1Json.slice(0, 600));
      return res.status(502).json({ error: 'Could not parse the feedback response. Please try again — your draft was not lost.' });
    }

    let criteriaFeedback: any = null;
    if (pass2Settled.status === 'fulfilled') {
      try {
        const pass2Text = pass2Settled.value.content[0].type === 'text' ? pass2Settled.value.content[0].text : '';
        const pass2Json = extractFirstJsonObject(pass2Text);
        if (pass2Json) {
          const pass2Data = JSON.parse(pass2Json);
          criteriaFeedback = pass2Data.criteria_feedback || null;
        }
      } catch (e: any) {
        console.warn('[generate-feedback] Pass 2 parse failed:', e?.message || e);
      }
    } else {
      console.warn('[generate-feedback] Pass 2 rejected:', pass2Settled.reason?.message || pass2Settled.reason);
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
    return res.status(500).json({ error: err.message || 'Failed to generate feedback' });
  }
}
