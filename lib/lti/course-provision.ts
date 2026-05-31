import { getSupabase } from '../auth.js';

function randomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export async function provisionClass(opts: {
  platformId: string;
  canvasCourseId: string;
  courseTitle: string;
  teacherId: string;
}): Promise<{ classId: string; isNew: boolean }> {
  const supabase = getSupabase();

  const { data: mapping } = await supabase
    .from('lti_course_mappings')
    .select('class_id')
    .eq('platform_id', opts.platformId)
    .eq('canvas_course_id', opts.canvasCourseId)
    .maybeSingle();

  if (mapping?.class_id) {
    return { classId: mapping.class_id as string, isNew: false };
  }

  let code = randomCode();
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: existing } = await supabase.from('classes').select('id').eq('code', code).maybeSingle();
    if (!existing) break;
    code = randomCode();
  }

  const { data: created, error } = await supabase
    .from('classes')
    .insert({
      code,
      teacher_id: opts.teacherId,
      name: opts.courseTitle,
    })
    .select('id')
    .single();
  if (error || !created) throw new Error(`class create failed: ${error?.message}`);

  const { error: mapErr } = await supabase.from('lti_course_mappings').insert({
    platform_id: opts.platformId,
    canvas_course_id: opts.canvasCourseId,
    class_id: created.id,
  });
  if (mapErr) {
    // Concurrent teacher launches for the same course race past the lookup
    // above; the unique constraint on (platform_id, canvas_course_id) lets one
    // win. The loser gets 23505 — and has already created a throwaway class.
    // Re-read the winning mapping, drop our orphan class, and converge.
    if ((mapErr as { code?: string }).code === '23505') {
      const { data: raced } = await supabase
        .from('lti_course_mappings')
        .select('class_id')
        .eq('platform_id', opts.platformId)
        .eq('canvas_course_id', opts.canvasCourseId)
        .maybeSingle();
      if (raced?.class_id) {
        await supabase.from('classes').delete().eq('id', created.id);
        return { classId: raced.class_id as string, isNew: false };
      }
    }
    throw new Error(`course mapping insert failed: ${mapErr.message}`);
  }

  return { classId: created.id as string, isNew: true };
}

export async function enrolStudent(classId: string, studentId: string): Promise<void> {
  const supabase = getSupabase();
  await supabase
    .from('class_members')
    .upsert({ class_id: classId, student_id: studentId }, { onConflict: 'class_id,student_id' });
}
