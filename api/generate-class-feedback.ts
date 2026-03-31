import type { VercelRequest, VercelResponse } from '@vercel/node';
import Anthropic from '@anthropic-ai/sdk';
import { getSupabase, verifyAuth } from '../lib/auth.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await verifyAuth(req);
  if (!user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'Task code is required' });
  }

  const supabase = getSupabase();

  // Verify teacher owns the task
  const { data: task, error: taskError } = await supabase
    .from('tasks')
    .select('*')
    .eq('code', code)
    .eq('teacher_id', user.id)
    .single();

  if (taskError || !task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  // Fetch all submissions with feedback
  const { data: submissions, error: subError } = await supabase
    .from('submissions')
    .select('feedback')
    .eq('task_code', code)
    .not('feedback', 'is', null);

  if (subError) {
    return res.status(500).json({ error: subError.message });
  }

  if (!submissions || submissions.length === 0) {
    return res.status(400).json({ error: 'No submissions with feedback found for this task' });
  }

  const feedbacks = submissions.map(s => s.feedback);

  const systemPrompt = `You are an experienced NSW Health and Movement Science teacher reviewing aggregated student feedback for a class. A teacher is looking at you for a concise snapshot of how their class performed on an assessment task.

You have been given the individual AI-generated feedback for each student submission. Your job is to synthesise these into a clear, actionable class-level overview.

VOICE AND TONE:
Write directly to the teacher. Be professional, concise, and practical. This is a colleague-to-colleague summary — not a report for parents or admin. Use "the class", "students", "most students", "a few students" etc.

OUTPUT FORMAT:
Respond in the following JSON structure:

{
  "class_strengths": [
    "Each point is a strength that appeared across multiple students. Be specific — name the concepts, skills, or approaches students handled well."
  ],
  "class_weaknesses": [
    "Each point is a common gap, misconception, or area where multiple students struggled. Be specific about what went wrong and how widespread it was (e.g. 'most students', 'several students', 'a common pattern')."
  ],
  "task_verb_adherence": "A short paragraph on how well the class handled the task verb requirements. Did most students actually do what the verb asked (e.g. analyse vs describe)? What was the common pattern?",
  "top_priorities": [
    "2-3 highest-impact things the teacher could address with the whole class to improve overall performance. These should be teachable moments — things that would help the most students."
  ],
  "overall_snapshot": "2-3 sentences giving an honest overall picture of class performance. Where does the class sit? What's the standout pattern?"
}`;

  const userPrompt = `ASSESSMENT TASK:
${task.course ? task.course + '\n' : ''}Question: ${task.question}

TOTAL SUBMISSIONS: ${feedbacks.length}

INDIVIDUAL STUDENT FEEDBACKS:
${feedbacks.map((f: any, i: number) => `--- Student ${i + 1} ---
Strengths: ${JSON.stringify(f.what_youve_done_well || [])}
Task verb check: ${f.task_verb_check || 'N/A'}
Improvements: ${JSON.stringify(f.improvements || [])}
Overall: ${f.overall || 'N/A'}
Top priority: ${f.top_priority || 'N/A'}`).join('\n\n')}

---

Synthesise the above into a class-level overview. Look for patterns — what comes up repeatedly? What are the common strengths and gaps? Be honest and specific.`;

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      temperature: 0.2,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const outputText = response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = outputText.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      return res.status(500).json({ error: 'Failed to parse class feedback response' });
    }

    const classFeedback = JSON.parse(jsonMatch[0]);
    return res.status(200).json({ feedback: classFeedback, submission_count: feedbacks.length });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to generate class feedback' });
  }
}
