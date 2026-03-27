import type { VercelRequest, VercelResponse } from '@vercel/node';
import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt, buildUserPrompt } from '../prompts/feedback-system.js';

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

  const { question, course, criteria, outcomes, draft, notes } = req.body;

  if (!question || !draft) {
    return res.status(400).json({ error: 'Question and draft are required' });
  }

  // Extract task verb from question
  const questionLower = (question as string).toLowerCase();
  const taskVerb = TASK_VERBS.find(v => questionLower.includes(v)) || 'explain';

  const taskDescription = course
    ? `${course}\n\nQuestion:\n${question}`
    : `Question:\n${question}`;

  // Map criteria — teachers enter { name, marks } with marks as string (e.g. "3" or "6-7")
  const mappedCriteria = (criteria || []).map((c: any) => {
    const marksStr = String(c.marks || '0');
    const maxMarks = parseInt(marksStr.includes('-') ? marksStr.split('-')[1] : marksStr) || 0;
    return {
      name: c.name || '',
      description: c.name || '',
      maxMarks,
    };
  });

  const outcomesList = (outcomes || []).map((o: any) =>
    typeof o === 'string' ? o : o.code || ''
  );

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt({
    taskDescription,
    taskVerb,
    outcomes: outcomesList,
    criteria: mappedCriteria,
    studentText: draft,
    teacherNotes: notes || undefined,
  });

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
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

    return res.status(200).json({
      feedback,
      meta: { taskVerb, question, course },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to generate feedback' });
  }
}
