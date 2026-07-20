import { getSupabase } from '../auth.js';
import { getPlatformById } from './config.js';
import { getServiceAccessToken, SCOPE_AGS_LINEITEM } from './service-auth.js';

const LINE_ITEM_TYPE = 'application/vnd.ims.lis.v2.lineitem+json';
const CANVAS_SUBMISSION_TYPE = 'https://canvas.instructure.com/lti/submission_type';

type SyncResult = { synced: boolean; reason?: string; lineItemUrl?: string };

function sydneyEndOfDay(date: string | null): string | undefined {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const [year, month, day] = date.split('-').map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day, 12));
  const offsetName = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney', timeZoneName: 'longOffset',
  }).formatToParts(probe).find(p => p.type === 'timeZoneName')?.value || 'GMT+10:00';
  const offset = offsetName.replace('GMT', '') || '+10:00';
  return `${date}T23:59:59${offset}`;
}

export function buildCanvasLineItem(task: {
  id: string; title: string | null; total_marks: number | null; due_date: string | null;
}) {
  return {
    scoreMaximum: typeof task.total_marks === 'number' && task.total_marks > 0 ? task.total_marks : 1,
    label: task.title || 'ProofReady task',
    resourceId: task.id,
    tag: 'proofready',
    endDateTime: sydneyEndOfDay(task.due_date) ?? null,
    [CANVAS_SUBMISSION_TYPE]: {
      type: 'external_tool',
      external_tool_url: 'https://api.proofready.app/lti/launch',
    },
  };
}

function lineItemsUrl(url: string): string {
  return url.replace(/[?&]$/, '');
}

/** Create or update the Canvas assignment corresponding to a published task. */
export async function syncTaskToCanvas(taskId: string): Promise<SyncResult> {
  const supabase = getSupabase();
  const { data: task, error: taskErr } = await supabase
    .from('tasks')
    .select('id, class_id, title, total_marks, due_date, published_at, lti_platform_id, lti_line_item_url')
    .eq('id', taskId).maybeSingle();
  if (taskErr || !task) return { synced: false, reason: 'task missing' };
  if (!task.published_at) return { synced: false, reason: 'task is not published' };

  const { data: courseMap } = await supabase
    .from('lti_course_mappings')
    .select('platform_id, lti_lineitems_url')
    .eq('class_id', task.class_id)
    .maybeSingle();
  if (!courseMap?.platform_id || !courseMap.lti_lineitems_url) {
    return { synced: false, reason: 'class has no Canvas assignment service context' };
  }

  const platform = await getPlatformById(courseMap.platform_id as string);
  if (!platform) return { synced: false, reason: 'Canvas platform missing' };
  const token = await getServiceAccessToken(platform, [SCOPE_AGS_LINEITEM]);
  const payload = buildCanvasLineItem(task as any);
  let target = task.lti_line_item_url as string | null;

  // Recover idempotently if a previous create reached Canvas but our database
  // update was interrupted. resourceId is the stable ProofReady task id.
  if (!target) {
    const listUrl = new URL(lineItemsUrl(courseMap.lti_lineitems_url as string));
    listUrl.searchParams.set('resource_id', task.id);
    listUrl.searchParams.set('limit', '10');
    const listRes = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${token}`, Accept: LINE_ITEM_TYPE },
    });
    if (listRes.ok) {
      const rows = await listRes.json() as Array<{ id?: string }>;
      target = rows.find(x => x?.id)?.id || null;
    }
  }

  // Canvas's create extension establishes the external-tool assignment. Its
  // update endpoint only accepts the standard mutable fields.
  const requestPayload = target ? { ...payload } : payload;
  if (target) delete (requestPayload as Record<string, unknown>)[CANVAS_SUBMISSION_TYPE];
  const res = await fetch(target || lineItemsUrl(courseMap.lti_lineitems_url as string), {
    method: target ? 'PUT' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': LINE_ITEM_TYPE,
      Accept: LINE_ITEM_TYPE,
    },
    body: JSON.stringify(requestPayload),
  });
  if (!res.ok) throw new Error(`Canvas line-item sync failed: ${res.status} ${await res.text()}`);
  const saved = await res.json() as { id?: string };
  const lineItemUrl = saved.id || target;
  if (!lineItemUrl) throw new Error('Canvas line-item sync returned no id');

  const { error: saveErr } = await supabase.from('tasks').update({
    lti_platform_id: platform.id,
    lti_line_item_url: lineItemUrl,
  }).eq('id', task.id);
  if (saveErr) throw new Error(`Could not save Canvas line-item id: ${saveErr.message}`);
  return { synced: true, lineItemUrl };
}
