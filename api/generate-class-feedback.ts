import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors } from '../lib/cors.js';
import Anthropic from '@anthropic-ai/sdk';
import { getSupabase, verifyAuth } from '../lib/auth.js';
import { checkAndLogRateLimit } from '../lib/rate-limit.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await verifyAuth(req);
  if (!user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const taskId = (req.body?.task_id as string || '').trim();
  if (!taskId) return res.status(400).json({ error: 'task_id is required.' });

  // Rate limit / spend protection — same pattern as generate-feedback but
  // tighter, since class-feedback fans out across every student in a class.
  const supabase = getSupabase();
  const rateLimit = await checkAndLogRateLimit(supabase, user.id, {
    endpoint: 'generate-class-feedback',
    perUserPerHour: 5,
    globalPerDay: 500,
  });
  if (!rateLimit.ok) {
    if (rateLimit.retryAfterSeconds) res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    return res.status(429).json({ error: rateLimit.reason || 'Rate limit exceeded. Please try again later.' });
  }

  const { data: task, error: taskError } = await supabase
    .from('tasks')
    .select('*, classes(teacher_id)')
    .eq('id', taskId)
    .single();

  if (taskError || !task) return res.status(404).json({ error: 'Task not found' });
  const teacherId = (task.classes as any)?.teacher_id;
  if (teacherId !== user.id) return res.status(403).json({ error: 'Not authorised.' });

  const { data: allSubmissions, error: subError } = await supabase
    .from('submissions')
    .select('student_id, feedback, created_at')
    .eq('task_id', taskId)
    .not('feedback', 'is', null)
    .order('created_at', { ascending: false });

  if (subError) {
    return res.status(500).json({ error: subError.message });
  }

  if (!allSubmissions || allSubmissions.length === 0) {
    return res.status(400).json({ error: 'No submissions with feedback found for this task' });
  }

  // Keep only the latest submission per student
  const seen = new Set<string>();
  const submissions = allSubmissions.filter(s => {
    const key = s.student_id || 'unknown';
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const feedbacks = submissions.map(s => s.feedback);

  const subjectLabel = task.course || "this subject";
  const systemPrompt = `You are an experienced NSW ${subjectLabel} teacher reviewing aggregated student feedback for a class. A teacher is looking at you for a concise snapshot of how their class performed on an assessment task.

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
  "task_verb_adherence": "A short paragraph on how well the class handled the key term requirements. Did most students actually do what the key term asked (e.g. analyse vs describe)? What was the common pattern?",
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
Key term check: ${f.task_verb_check || 'N/A'}
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

    await supabase
      .from('tasks')
      .update({
        class_feedback: classFeedback,
        class_feedback_count: feedbacks.length,
        class_feedback_generated_at: new Date().toISOString(),
      })
      .eq('id', taskId);

    return res.status(200).json({ feedback: classFeedback, submission_count: feedbacks.length });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to generate class feedback' });
  }
}
