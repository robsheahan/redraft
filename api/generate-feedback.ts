import type { VercelRequest, VercelResponse } from '@vercel/node';
import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt, buildUserPrompt } from '../prompts/feedback-system.js';
import { getSupabase, verifyAuth } from '../lib/auth.js';

const TASK_VERBS = [
  'critically analyse', 'critically evaluate',
  'analyse', 'analyze', 'assess', 'compare', 'contrast',
  'describe', 'discuss', 'distinguish', 'evaluate',
  'examine', 'explain', 'identify', 'justify', 'outline', 'propose',
];

const REVIEW_SYSTEM_PROMPT = `You are a senior HSC Health and Movement Science marker and feedback quality reviewer. You have extensive experience with the NESA HSC marking process, SOLO Taxonomy, and Bloom's cognitive depth mapping. You have just received AI-generated feedback on a student's draft assessment response. Your job is to review this feedback for accuracy, calibration, and actionability, then return a refined version.

REVIEW CHECKLIST:
1. ACCURACY: Does the feedback correctly identify the key term requirements and expected cognitive depth? Are the strengths genuinely strong, or inflated? Are the identified issues real issues in the student's text? Is the SOLO level diagnosis correct?
2. CALIBRATION: Is the overall assessment honest and well-calibrated to HSC standards and band descriptors? Would an experienced marker agree with the performance band estimate? Remember: high achievement is NOT defined solely by quantity of information.
3. ACTIONABILITY: Can the student actually act on every improvement point? Are the steps specific enough? Is every improvement framed as a forward-looking revision action? Remove vague advice and replace with concrete actions.
4. CONCISENESS: Cut any filler, repetition, or padding. Every sentence should add value. Summaries should be punchy and scannable.
5. COMPLETENESS: Has any significant issue been missed? Has any strength been overlooked? Are common pitfalls checked (concept confusion, listing without connecting, one-sided responses, missing examples)?
6. SELF-REGULATION: Does the feedback include a useful self-check question the student can apply independently?

IMPORTANT:
- If the original feedback is already accurate and well-calibrated, make only minor refinements. Do not change for the sake of changing.
- If you find inaccuracies (e.g. praising something that isn't actually strong, or missing a major flaw), correct them.
- Verify the key term depth diagnosis matches the NESA glossary definition.
- Maintain the same warm, direct, teacher-to-student voice.
- Ensure all spelling uses Australian English (analyse, organisation, behaviour, colour, centre, etc.). Correct any US spellings.
- Return the SAME JSON structure as the input, refined.`;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await verifyAuth(req);
  const { question, course, criteria, criteria_text, outcomes, draft, notes, task_code, task_title } = req.body;

  if (!question || !draft) {
    return res.status(400).json({ error: 'Question and draft are required' });
  }

  const questionLower = (question as string).toLowerCase();
  const taskVerb = TASK_VERBS.find(v => questionLower.includes(v)) || 'explain';

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

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt({
    taskDescription,
    taskVerb,
    outcomes: outcomesList,
    criteria: mappedCriteria,
    criteriaText: rawCriteriaText || undefined,
    studentText: draft,
    teacherNotes: notes || undefined,
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
    const pass1Match = pass1Text.match(/\{[\s\S]*\}/);

    if (!pass1Match) {
      return res.status(500).json({ error: 'Failed to parse feedback response' });
    }

    const initialFeedback = JSON.parse(pass1Match[0]);

    // --- Pass 2: Review and refine for accuracy ---
    const reviewPrompt = `ORIGINAL TASK:
${taskDescription}

KEY TERM: "${taskVerb}"

STUDENT'S DRAFT:
${draft}

---

INITIAL AI FEEDBACK (to review and refine):
${JSON.stringify(initialFeedback, null, 2)}

---

Review this feedback against the student's actual draft. Check for accuracy, calibration, actionability, and conciseness per your checklist. Return the refined feedback as the same JSON structure. Only make changes where genuinely needed.`;

    const pass2 = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      temperature: 0.1,
      system: REVIEW_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: reviewPrompt }],
    });

    const pass2Text = pass2.content[0].type === 'text' ? pass2.content[0].text : '';
    const pass2Match = pass2Text.match(/\{[\s\S]*\}/);

    // Use refined feedback if pass 2 succeeded, otherwise fall back to pass 1
    const feedback = pass2Match ? JSON.parse(pass2Match[0]) : initialFeedback;

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
      });
    }

    return res.status(200).json({
      feedback,
      meta: { taskVerb, question, course, title: task_title || null },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to generate feedback' });
  }
}
