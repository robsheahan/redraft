export type DraftEngagementMetrics = {
  submitted_assessments: number;
  average_feedback_drafts: number | null;
  no_feedback_percentage: number | null;
};

export function calculateDraftEngagement(rows: Array<{
  task_id?: string | null;
  student_id?: string | null;
  submitted_for_marking?: boolean | null;
}>): DraftEngagementMetrics {
  const attempts = new Map<string, { feedback: number; final: boolean }>();
  rows.forEach((s) => {
    if (!s.task_id || !s.student_id) return;
    const key = `${s.task_id}|${s.student_id}`;
    const row = attempts.get(key) || { feedback: 0, final: false };
    if (s.submitted_for_marking) row.final = true;
    else row.feedback++;
    attempts.set(key, row);
  });
  const completed = [...attempts.values()].filter(x => x.final);
  const totalFeedback = completed.reduce((sum, x) => sum + x.feedback, 0);
  const noFeedback = completed.filter(x => x.feedback === 0).length;
  return {
    submitted_assessments: completed.length,
    average_feedback_drafts: completed.length
      ? Math.round((totalFeedback / completed.length) * 10) / 10 : null,
    no_feedback_percentage: completed.length
      ? Math.round((noFeedback / completed.length) * 100) : null,
  };
}
