import { withHandler } from '../../lib/with-handler.js';
import { syncTaskToCanvas } from '../../lib/lti/line-items.js';

export default withHandler({ methods: ['POST'], label: 'lti-sync-task' }, async (req, res, { user, supabase }) => {
  const taskId = String(req.body?.task_id || '').trim();
  if (!taskId) return res.status(400).json({ error: 'task_id is required.' });
  const { data: task } = await supabase
    .from('tasks').select('id, classes(teacher_id)').eq('id', taskId).maybeSingle();
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if ((task.classes as any)?.teacher_id !== user!.id) {
    return res.status(403).json({ error: 'Only the class teacher can sync this task.' });
  }
  try {
    const result = await syncTaskToCanvas(taskId);
    if (!result.synced) {
      const message = result.reason === 'class has no Canvas assignment service context'
        ? 'Open ProofReady once from this Canvas course, then return here and sync again.'
        : (result.reason || 'This task could not be synced to Canvas.');
      return res.status(409).json({ error: message, reason: result.reason });
    }
    return res.status(200).json(result);
  } catch (err: any) {
    return res.status(502).json({ error: err?.message || 'Canvas assignment sync failed.' });
  }
});
