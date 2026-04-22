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
- "improvements": What needs to change to score higher on this criterion. Be specific — reference their actual text and give actionable steps.
- "band_estimate": Your honest estimate of which HSC band (1-6) this criterion sits at currently

VOICE: Write directly to the student using "you/your". Be warm but honest. Use Australian English spelling.

Keep each point tight — one sentence for the observation, one for the action. No padding.

DO NOT promise mark outcomes. The band_estimate field is the ONLY place you may reference a band. In "strengths" and "improvements", describe what is working and what would strengthen the response — NEVER say that a change will push the student to a higher band, add a mark, or move them into a specific mark range. Forbidden phrasing: "this will move you to Band X", "adding this will push you into the 13–15 range", "this will get you another mark". Focus on what makes the response better, not on what mark it will earn.

OUTPUT FORMAT:
Respond in JSON:
{
  "criteria_feedback": [
    {
      "criterion": "the criterion text",
      "strengths": "what's working for this criterion",
      "improvements": "specific actions to improve against this criterion",
      "band_estimate": 4
    }
  ]
}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await verifyAuth(req);
  const { question, course, criteria, criteria_text, outcomes, draft, notes, task_code, task_title, task_type } = req.body;

  if (!question || !draft) {
    return res.status(400).json({ error: 'Question and draft are required' });
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
    globalPerDay: 500,
  });
  if (!rateLimit.ok) {
    if (rateLimit.retryAfterSeconds) res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    return res.status(429).json({ error: rateLimit.reason || 'Rate limit exceeded. Please try again later.' });
  }

  // Resubmission handling: cap at 3 drafts per student per task
  const MAX_DRAFTS = 3;
  let draftVersion = 1;
  let priorDrafts: Array<{ draft_text: string; feedback: any; draft_version: number }> = [];
  if (user && task_code) {
    const supabase = getSupabase();
    const { data: priorSubs } = await supabase
      .from('submissions')
      .select('draft_text, feedback, draft_version')
      .eq('student_id', user.id)
      .eq('task_code', task_code)
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

  // If submitting against a teacher's task, fetch notes server-side (they're not exposed to students)
  let teacherNotes = notes || null;
  if (task_code && !teacherNotes) {
    const supabase = getSupabase();
    const { data: taskData } = await supabase.from('tasks').select('notes').eq('code', task_code).single();
    if (taskData?.notes) teacherNotes = taskData.notes;
  }

  const taskVerbs = extractTaskVerbs(question as string);
  const taskVerb = taskVerbs[0] || null;

  const taskDescription = course
    ? `${course}\n\nQuestion:\n${question}`
    : `Question:\n${question}`;

  // Support both structured criteria (old) and raw text (new)
  const rawCriteriaText = criteria_text || null;
  const mappedCriteria = !rawCriteriaText && Array.isArray(criteria)
    ? criteria.map((c: any) => {
        const marksStr = String(c.marks || '0');
        const maxMarks = parseInt(marksStr.includes('-') ? marksStr.split('-')[1] : marksStr) || 0;
        return { name: c.name || '', description: c.name || '', maxMarks };
      })
    : [];

  const outcomesList = (outcomes || []).map((o: any) =>
    typeof o === 'string' ? o : o.code || ''
  );

  const discipline = course ? getDisciplineForCourse(course as string) : null;
  const systemPrompt = buildSystemPrompt(course as string || undefined, discipline || undefined);
  const userPrompt = buildUserPrompt({
    taskDescription,
    taskVerb: taskVerb || undefined,
    taskVerbs: taskVerbs.length > 0 ? taskVerbs : undefined,
    outcomes: outcomesList,
    criteria: mappedCriteria,
    criteriaText: rawCriteriaText || undefined,
    studentText: draft,
    teacherNotes: teacherNotes || undefined,
    taskType: task_type || undefined,
    priorDrafts: priorDrafts.length > 0 ? priorDrafts : undefined,
    draftVersion,
  });

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // --- Pass 1: Generate initial feedback ---
    const pass1 = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      temperature: 0.2,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const pass1Text = pass1.content[0].type === 'text' ? pass1.content[0].text : '';
    const pass1Json = extractFirstJsonObject(pass1Text);

    if (!pass1Json) {
      return res.status(500).json({ error: 'Failed to parse feedback response' });
    }

    const initialFeedback = JSON.parse(pass1Json);

    // --- Pass 2: Independent criteria-coverage check ---
    // This is a fresh assessment — Pass 2 does NOT see Pass 1's output.
    // It evaluates the draft against each marking criterion independently.
    const criteriaBlock = rawCriteriaText
      || mappedCriteria.map((c, i) => `${i + 1}. ${c.name} (${c.maxMarks} marks): ${c.description}`).join('\n')
      || 'No specific criteria provided — assess against general HSC standards';

    const criteriaCheckPrompt = `ASSESSMENT TASK:
${taskDescription}

MARKING CRITERIA:
${criteriaBlock}

---

STUDENT'S DRAFT RESPONSE:
${draft}

---

Assess this draft against each marking criterion above. Address every criterion individually.`;

    // --- Pass 3: Inline annotations ---
    // Runs in parallel with Pass 2. Pass 3 references Pass 1's improvements so
    // inline notes stay coherent with the holistic feedback, but it can't run
    // until Pass 1 has returned.
    const improvementsSummary = Array.isArray(initialFeedback?.improvements?.summary)
      ? initialFeedback.improvements.summary
      : [];

    const [pass2, inlineResult] = await Promise.all([
      client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 3000,
        temperature: 0.3,
        system: buildCriteriaCheckPrompt(course as string || undefined),
        messages: [{ role: 'user', content: criteriaCheckPrompt }],
      }),
      generateInlineSuggestions(client, {
        taskDescription,
        taskVerbs: taskVerbs.length > 0 ? taskVerbs : undefined,
        studentText: draft,
        holisticImprovements: improvementsSummary,
        courseName: course as string || undefined,
        discipline: discipline || undefined,
      }),
    ]);
    const inlineSuggestions = inlineResult.annotations; // graceful: empty [] on either failure or no-usable-output

    const pass2Text = pass2.content[0].type === 'text' ? pass2.content[0].text : '';
    const pass2Json = extractFirstJsonObject(pass2Text);

    // Merge Pass 1 (general feedback) with Pass 2 (criteria-specific feedback)
    let criteriaFeedback = null;
    if (pass2Json) {
      try {
        const pass2Data = JSON.parse(pass2Json);
        criteriaFeedback = pass2Data.criteria_feedback || null;
      } catch { /* criteria check failed, continue without it */ }
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
        task_code: task_code || null,
        question,
        course: course || null,
        draft_text: draft,
        feedback,
        draft_version: draftVersion,
      });
    }

    return res.status(200).json({
      feedback,
      draft_text: draft,
      meta: { taskVerb, taskVerbs, question, course, title: task_title || null, draftVersion, maxDrafts: MAX_DRAFTS },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to generate feedback' });
  }
}
