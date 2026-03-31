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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await verifyAuth(req);
  const { question, course, criteria, criteria_text, outcomes, draft, notes, task_code } = req.body;

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

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      temperature: 0.2,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const outputText = response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = outputText.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      return res.status(500).json({ error: 'Failed to parse feedback response' });
    }

    const feedback = JSON.parse(jsonMatch[0]);

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
      meta: { taskVerb, question, course },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to generate feedback' });
  }
}
