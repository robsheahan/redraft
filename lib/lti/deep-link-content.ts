export function buildDeepLinkContentItem(task: {
  id: string;
  title: string;
  total_marks: number | null;
}, acceptLineItem: boolean): Record<string, unknown> {
  const item: Record<string, unknown> = {
    type: 'ltiResourceLink',
    url: 'https://api.proofready.app/lti/launch',
    title: task.title,
    custom: { proofready_task_id: task.id },
  };
  if (acceptLineItem) {
    item.lineItem = {
      scoreMaximum: typeof task.total_marks === 'number' && task.total_marks > 0 ? task.total_marks : 1,
      label: task.title,
      resourceId: task.id,
    };
  }
  return item;
}
