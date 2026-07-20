import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabase, verifyAuth } from '../lib/auth.js';
import { captureError } from '../lib/sentry.js';
import { parseRubricWithAI } from '../lib/parse-rubric-with-ai.js';
import { withHandler } from '../lib/with-handler.js';
import { validateExamQuestions, studentTaskView, type ExamQuestion } from '../lib/exam-questions.js';
import { validateFeedbackQuestions, type FeedbackQuestion } from '../lib/feedback-questions.js';
import { validateMathsParts, studentPartsView, type MathsPart } from '../lib/maths-parts.js';
import { syncTaskToCanvas } from '../lib/lti/line-items.js';

/**
 * Task CRUD under the classes redesign.
 *
 * Tasks always live inside a class. A task has a published_at timestamp:
 *   null     → draft, only visible to the teacher owner
 *   non-null → published, visible to class members
 *
 *   GET    /api/task?id=<uuid>      → fetch a task (teacher owner: full; student member: published + notes stripped)
 *   POST   /api/task                → create task inside a class (teacher owner only). Pass publish:true to publish immediately.
 *   PUT    /api/task                → update task (teacher owner only). Pass publish:true/false to toggle published_at.
 *   DELETE /api/task                → delete task + its submissions (teacher owner only)
 */

// auth:'none' — each sub-handler does its own verifyAuth + ownership checks.
export default withHandler(
  { methods: ['GET', 'POST', 'PUT', 'DELETE'], auth: 'none', label: 'task' },
  async (req, res) => {
    switch (req.method) {
      case 'GET':    return handleGet(req, res);
      case 'POST':   return handleCreate(req, res);
      case 'PUT':    return handleUpdate(req, res);
      case 'DELETE': return handleDelete(req, res);
    }
  },
);

type TaskMode = 'feedback_task' | 'marked_task' | 'quick_task';

/**
 * Validate and normalise the task_mode supplied by the client.
 *
 * The UI exposes two choices: "Assessment task" (feedback_task) and
 * "Quick task" (quick_task). marked_task is kept in the DB CHECK constraint
 * so legacy rows still validate, but the API no longer produces new ones.
 *
 * Legacy clients that send student_feedback_enabled instead of task_mode
 * are tolerated for one transition: feedback_enabled=true → feedback_task,
 * false → quick_task. (The hybrid marked_task path is no longer reachable.)
 */
function resolveTaskMode(body: any): TaskMode {
  const raw = body && typeof body.task_mode === 'string' ? body.task_mode : null;
  if (raw === 'feedback_task' || raw === 'quick_task' || raw === 'marked_task') return raw;
  if (typeof body?.student_feedback_enabled === 'boolean') {
    return body.student_feedback_enabled ? 'feedback_task' : 'quick_task';
  }
  return 'feedback_task'; // default for legacy/unknown
}

async function handleGet(req: VercelRequest, res: VercelResponse) {
  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const id = (req.query.id as string || '').trim();
  if (!id) return res.status(400).json({ error: 'Task id is required.' });

  const supabase = getSupabase();
  const { data: task } = await supabase.from('tasks').select('*').eq('id', id).maybeSingle();
  if (!task) return res.status(404).json({ error: 'Task not found.' });

  const { data: cls } = await supabase
    .from('classes').select('id, name, course, teacher_id').eq('id', task.class_id).maybeSingle();
  if (!cls) return res.status(404).json({ error: 'Class for this task is missing.' });

  const isOwner = cls.teacher_id === user.id;
  let isMember = false;
  if (!isOwner) {
    const { data: m } = await supabase.from('class_members')
      .select('student_id').eq('class_id', cls.id).eq('student_id', user.id).maybeSingle();
    isMember = !!m;
  }
  if (!isOwner && !isMember) return res.status(403).json({ error: 'Not authorised to view this task.' });

  // Students can only see published tasks
  if (!isOwner && !task.published_at) {
    return res.status(404).json({ error: 'Task not found.' });
  }

  // Scrub teacher notes for non-owners
  let payload: any = { ...task };
  if (!isOwner) delete payload.notes;
  // The maths worked solution is the marker's correctness anchor — never sent to
  // a student, even post-grading (reveal-after-grading is a deliberate future
  // option). Strip unconditionally for non-owners: the hardest guarantee, not
  // dependent on subject_type or graded-status resolution below.
  if (!isOwner) delete payload.worked_solution;

  // Several student-facing reveals hinge on whether this student already has a
  // graded submission: criteria (hide_criteria_from_students), the maths marking
  // guideline, and the multi-question exam answer key. Resolve graded status
  // once, then apply each.
  const hasQuestions = Array.isArray((task as any).questions) && (task as any).questions.length > 0;
  if (!isOwner && (task.hide_criteria_from_students || task.subject_type === 'maths' || hasQuestions)) {
    const { data: gradedSub } = await supabase
      .from('submissions')
      .select('id')
      .eq('task_id', id)
      .eq('student_id', user.id)
      .not('graded_at', 'is', null)
      .limit(1)
      .maybeSingle();
    const isGraded = !!gradedSub;
    if (!isGraded) {
      if (task.hide_criteria_from_students) {
        payload.criteria_text = null;
        payload.criteria_structured = null;
        payload.criteria = [];
      }
      if (task.subject_type === 'maths') {
        payload.marking_guideline = null;
      }
    }
    // Multi-question exams: strip the MC answer key + scramble option order per
    // student. The key is revealed only once their submission is graded.
    if (hasQuestions) {
      payload = studentTaskView(payload, user.id, { revealAnswerKey: isGraded });
    }
    // Multi-part maths: strip each part's worked_solution (always) + marking
    // guideline (pre-grade) — the per-part analogue of the single-question strip.
    if (task.subject_type === 'maths' && Array.isArray(payload.parts)) {
      payload.parts = studentPartsView(payload.parts, { isGraded });
    }
  }

  return res.status(200).json({
    task: payload,
    class: { id: cls.id, name: cls.name, course: cls.course },
    role: isOwner ? 'teacher' : 'student',
  });
}

async function handleCreate(req: VercelRequest, res: VercelResponse) {
  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const supabase = getSupabase();
  const {
    class_id, course, title, instructions, question, questions, parts, task_type, total_marks, due_date,
    outcomes, criteria, criteria_text, notes, publish, typed_response_only,
    hide_criteria_from_students, completion_only,
    subject_type, marking_guideline, worked_solution, lesson_builder, attachments, time_limit_minutes,
    allow_student_attachments,
  } = req.body || {};

  if (!class_id) return res.status(400).json({ error: 'class_id is required — tasks must belong to a class.' });

  const { data: cls } = await supabase.from('classes').select('id, teacher_id').eq('id', class_id).maybeSingle();
  if (!cls) return res.status(404).json({ error: 'Class not found.' });
  if (cls.teacher_id !== user.id) return res.status(403).json({ error: 'You can only add tasks to your own classes.' });

  const taskMode = resolveTaskMode(req.body);
  const subjectType = subject_type === 'maths' ? 'maths' : 'essay';

  // Multi-question assessments share the tasks.questions jsonb column; which
  // validator runs is decided by task_mode. Exams (marked_task) get the flat
  // text+MC variant with a hidden answer key (lib/exam-questions); take-home
  // assessments (feedback_task) get the text-only, per-question-criteria variant
  // (lib/feedback-questions) where every question gets its own AI feedback. Both
  // are essay-subject only. The restriction lives here, not in the schema, so
  // widening it later is a validation change.
  let examQuestions: ExamQuestion[] | null = null;
  let feedbackQuestions: FeedbackQuestion[] | null = null;
  let questionsTotalMarks: number | null = null;
  if (questions !== undefined && questions !== null) {
    if (subjectType !== 'essay') {
      return res.status(400).json({ error: 'Multiple questions are only available on written tasks.' });
    }
    if (taskMode === 'marked_task') {
      const v = validateExamQuestions(questions);
      if ('error' in v) return res.status(400).json({ error: v.error });
      examQuestions = v.questions;
      questionsTotalMarks = v.totalMarks;
    } else if (taskMode === 'feedback_task') {
      const v = validateFeedbackQuestions(questions);
      if ('error' in v) return res.status(400).json({ error: v.error });
      feedbackQuestions = v.questions;
      questionsTotalMarks = v.totalMarks;
    } else {
      return res.status(400).json({ error: 'Multiple questions are only available on an assessment or in-class exam.' });
    }
  }
  const storedQuestions = examQuestions ?? feedbackQuestions;

  // Multi-part maths (take-home feedback): a maths feedback_task may carry an
  // ordered `parts` array (sub-questions (a)(b)(c) of one question) instead of a
  // flat scalar question. tasks.question holds the shared stem (optional here).
  let mathsParts: MathsPart[] | null = null;
  let mathsPartsTotal: number | null = null;
  if (parts !== undefined && parts !== null) {
    if (subjectType !== 'maths' || taskMode !== 'feedback_task') {
      return res.status(400).json({ error: 'Multi-part questions are only available on a take-home maths task.' });
    }
    const v = validateMathsParts(parts);
    if ('error' in v) return res.status(400).json({ error: v.error });
    mathsParts = v.parts;
    mathsPartsTotal = v.totalMarks;
  }

  // Single-question tasks still require a scalar question; multi-question
  // assessments/exams and multi-part maths carry their content in their arrays
  // (the stem is optional once parts/questions exist).
  if (!storedQuestions && !mathsParts && (!question || !String(question).trim())) {
    return res.status(400).json({ error: 'Task question is required.' });
  }
  const hasCriteria = !!(criteria_text && String(criteria_text).trim());
  const hasMarkingGuideline = !!(marking_guideline && String(marking_guideline).trim());
  // Maths assessment tasks need a marking guideline; single-question essay
  // assessment tasks need task-level marking criteria. Multi-question take-home
  // assessments carry criteria PER QUESTION (each optional), so the task-level
  // requirement doesn't apply. Quick tasks of either kind may skip.
  if (subjectType === 'essay' && taskMode === 'feedback_task' && !feedbackQuestions && !hasCriteria) {
    return res.status(400).json({ error: 'Assessment tasks need marking criteria. Either add criteria or switch to a quick task.' });
  }
  // Maths marking guidelines are OPTIONAL. They sharpen the per-line
  // diagnostic by enabling step_gap detection, but the system still produces
  // useful feedback without one — especially at Stage 4/5 where teachers
  // rarely have a formal HSC-style guideline for in-class work.

  // AI-parse the rubric synchronously so the renderer never has to. Returns
  // null on any failure — the renderer falls back to the client-side regex
  // parser in that case.
  const criteriaStructured = hasCriteria ? await parseRubricWithAI(String(criteria_text)) : null;

  // completion_only is only meaningful for quick_task. Client may send it
  // explicitly, but we derive a sensible default: quick_task + no criteria
  // → completion-only marking.
  let resolvedCompletionOnly = false;
  if (taskMode === 'quick_task') {
    resolvedCompletionOnly = typeof completion_only === 'boolean' ? completion_only : !hasCriteria;
  }

  const { data, error } = await supabase.from('tasks').insert({
    class_id,
    teacher_id: user.id,
    course: course || null,
    title: title || null,
    instructions: instructions || null,
    question: storedQuestions ? null : (question || null),
    questions: storedQuestions,
    parts: mathsParts,
    task_type: task_type || null,
    task_mode: taskMode,
    total_marks: questionsTotalMarks != null ? questionsTotalMarks
      : (mathsParts && mathsPartsTotal != null ? mathsPartsTotal : (total_marks || null)),
    due_date: due_date || null,
    outcomes: outcomes || [],
    criteria: criteria || [],
    criteria_text: criteria_text || null,
    criteria_structured: criteriaStructured,
    notes: notes || null,
    published_at: publish ? new Date().toISOString() : null,
    typed_response_only: typeof typed_response_only === 'boolean' ? typed_response_only : true,
    hide_criteria_from_students: typeof hide_criteria_from_students === 'boolean' ? hide_criteria_from_students : false,
    completion_only: resolvedCompletionOnly,
    subject_type: subjectType,
    marking_guideline: subjectType === 'maths' ? (marking_guideline || null) : null,
    // Hidden correctness anchor for Pass B. Maths-only; stripped for students.
    worked_solution: subjectType === 'maths' ? (worked_solution || null) : null,
    // Lesson Builder is offered for quick tasks only — assessments (feedback_task,
    // marked_task) must stay standardised. Coerce off for anything else so the
    // API enforces what the UI already restricts (no DB safety net otherwise).
    lesson_builder: taskMode === 'quick_task' ? !!lesson_builder : false,
    teacher_attachments: Array.isArray(attachments) ? attachments.slice(0, 5) : [],
    time_limit_minutes: (Number.isFinite(Number(time_limit_minutes)) && Number(time_limit_minutes) > 0)
      ? Math.round(Number(time_limit_minutes)) : null,
    allow_student_attachments: !!allow_student_attachments,
  }).select('*').single();

  if (error) return res.status(500).json({ error: error.message });
  // Canvas assignment creation is deliberately opt-in. Publishing a formative
  // ProofReady task must not silently add a column to the teacher's markbook.
  return res.status(200).json({ task: data });
}

async function handleUpdate(req: VercelRequest, res: VercelResponse) {
  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const {
    id, course, title, instructions, question, questions, parts, task_type, total_marks, due_date,
    outcomes, criteria, criteria_text, notes, publish, typed_response_only,
    hide_criteria_from_students,
    task_mode: incomingTaskMode, completion_only,
    subject_type, marking_guideline, worked_solution, lesson_builder, attachments, time_limit_minutes,
    allow_student_attachments,
  } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Task id is required.' });

  const supabase = getSupabase();
  const { data: existing } = await supabase
    .from('tasks').select('id, class_id, published_at, criteria_text, task_mode, subject_type, questions, classes(teacher_id)').eq('id', id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'Task not found.' });
  const teacherId = (existing.classes as any)?.teacher_id;
  if (teacherId !== user.id) return res.status(403).json({ error: 'You can only update your own tasks.' });

  // A task is "started" once any student has begun working on it — a submission
  // OR an in-progress autosaved draft. Before that it's fully editable; once a
  // student has started, only title / due date / teacher notes can change
  // (everything they answer against is locked to protect their work).
  // Fail CLOSED: if either count read errors, treat the task as started — a
  // transient DB error must not bypass the lock and let an edit destroy the
  // ground students are answering against.
  const [subRes, autoRes] = await Promise.all([
    supabase.from('submissions').select('id', { count: 'exact', head: true }).eq('task_id', id),
    supabase.from('draft_autosaves').select('task_id', { count: 'exact', head: true }).eq('task_id', id),
  ]);
  const started = !!subRes.error || !!autoRes.error
    || (subRes.count || 0) > 0 || (autoRes.count || 0) > 0;

  const patch: any = {
    course: course ?? undefined,
    title: title ?? undefined,
    instructions: instructions ?? undefined,
    question: question ?? undefined,
    task_type: task_type ?? undefined,
    total_marks: total_marks ?? undefined,
    due_date: due_date ?? undefined,
    outcomes: outcomes ?? undefined,
    criteria: criteria ?? undefined,
    criteria_text: criteria_text ?? undefined,
    notes: notes ?? undefined,
    typed_response_only: typeof typed_response_only === 'boolean' ? typed_response_only : undefined,
    hide_criteria_from_students: typeof hide_criteria_from_students === 'boolean' ? hide_criteria_from_students : undefined,
    subject_type: subject_type === 'essay' || subject_type === 'maths' ? subject_type : undefined,
    marking_guideline: typeof marking_guideline === 'string' ? marking_guideline : undefined,
    worked_solution: typeof worked_solution === 'string' ? worked_solution : undefined,
    lesson_builder: typeof lesson_builder === 'boolean' ? lesson_builder : undefined,
    teacher_attachments: Array.isArray(attachments) ? attachments.slice(0, 5) : undefined,
    time_limit_minutes: time_limit_minutes === undefined ? undefined
      : ((Number.isFinite(Number(time_limit_minutes)) && Number(time_limit_minutes) > 0) ? Math.round(Number(time_limit_minutes)) : null),
    allow_student_attachments: typeof allow_student_attachments === 'boolean' ? allow_student_attachments : undefined,
  };
  Object.keys(patch).forEach(k => patch[k] === undefined && delete patch[k]);

  // The subject/mode the task will have AFTER this update — used by the guards
  // below, which mirror the create-path restrictions (parts ⇒ maths take-home;
  // questions ⇒ essay).
  const effectiveSubject: string = (subject_type === 'essay' || subject_type === 'maths')
    ? subject_type : ((existing as any).subject_type || 'essay');
  const effectiveMode: TaskMode = typeof incomingTaskMode === 'string'
    ? resolveTaskMode(req.body) : (existing.task_mode as TaskMode);

  // Flipping subject_type to maths while the task carries (or is being given)
  // essay `questions` would leave an inconsistent hybrid — reject, matching the
  // create-path rule that multi-question is essay-only.
  if (patch.subject_type === 'maths') {
    const willHaveQuestions = questions !== undefined
      ? questions !== null
      : (Array.isArray((existing as any).questions) && (existing as any).questions.length > 0);
    if (willHaveQuestions) {
      return res.status(400).json({ error: 'Multiple questions are only available on written tasks. Remove the questions before switching to maths.' });
    }
  }

  // Multi-part maths: validate + set parts (and derive total_marks) when the
  // client sends them. null clears them back to a single-question task.
  // Same guard as the create path: parts only belong on a take-home maths task.
  if (parts !== undefined) {
    if (parts === null) {
      patch.parts = null;
    } else {
      if (effectiveSubject !== 'maths' || effectiveMode !== 'feedback_task') {
        return res.status(400).json({ error: 'Multi-part questions are only available on a take-home maths task.' });
      }
      const v = validateMathsParts(parts);
      if ('error' in v) return res.status(400).json({ error: v.error });
      patch.parts = v.parts;
      if (v.totalMarks != null) patch.total_marks = v.totalMarks;
    }
  }

  // Re-run AI parse whenever criteria_text is part of the patch — a teacher
  // might have rewritten the rubric, so the cached structure is stale.
  if (Object.prototype.hasOwnProperty.call(patch, 'criteria_text')) {
    patch.criteria_structured = patch.criteria_text
      ? await parseRubricWithAI(String(patch.criteria_text))
      : null;
  }

  // Allow the client to change task_mode directly. If it does, validate
  // that the post-update state is consistent (assessment requires criteria).
  const modeInBody = typeof incomingTaskMode === 'string';
  const criteriaInPatch = Object.prototype.hasOwnProperty.call(patch, 'criteria_text');
  const newMode = modeInBody ? resolveTaskMode(req.body) : (existing.task_mode as TaskMode);
  const effectiveCriteria = criteriaInPatch ? patch.criteria_text : (existing as any).criteria_text;
  const hasCriteriaNow = !!(effectiveCriteria && String(effectiveCriteria).trim());
  // Will the post-update task be multi-question? Multi-question take-home
  // assessments carry criteria per question, so the task-level criteria
  // requirement doesn't apply to them.
  const settingMultiQuestions = questions !== undefined
    ? questions !== null
    : (Array.isArray((existing as any).questions) && (existing as any).questions.length > 0);
  if (modeInBody && newMode === 'feedback_task' && !hasCriteriaNow && !settingMultiQuestions) {
    return res.status(400).json({ error: 'Assessment tasks need marking criteria. Either add criteria or switch to a quick task.' });
  }
  if (modeInBody) patch.task_mode = newMode;

  // Lesson Builder stays a quick-task-only capability (assessments standardised).
  // Coerce off whenever the effective mode isn't quick_task — the API enforces
  // what the UI restricts, with no DB safety net.
  if (Object.prototype.hasOwnProperty.call(patch, 'lesson_builder') && newMode !== 'quick_task') {
    patch.lesson_builder = false;
  }

  // Multi-question assessments share the tasks.questions column. `questions`
  // present (non-null) → validate by mode (exam vs take-home feedback), store
  // the array, drop the scalar question, recompute total_marks. Multi-question
  // is essay only.
  //
  // The question set is locked once a student has started (see `started` above),
  // because their answers anchor to question ids. Before that it's editable.
  if (questions !== undefined) {
    const effSubject = (subject_type === 'essay' || subject_type === 'maths')
      ? subject_type : ((existing as any).subject_type || 'essay');

    if (questions === null) {
      if (started) {
        return res.status(400).json({ error: 'A student has started this task, so the questions can\'t be changed.' });
      }
      patch.questions = null;
    } else {
      if (effSubject !== 'essay') {
        return res.status(400).json({ error: 'Multiple questions are only available on written tasks.' });
      }
      let validated: { error: string } | { questions: any[]; totalMarks: number };
      if (newMode === 'marked_task') {
        validated = validateExamQuestions(questions);
      } else if (newMode === 'feedback_task') {
        validated = validateFeedbackQuestions(questions);
      } else {
        return res.status(400).json({ error: 'Multiple questions are only available on an assessment or in-class exam.' });
      }
      if ('error' in validated) return res.status(400).json({ error: validated.error });
      const changed = JSON.stringify((existing as any).questions ?? null) !== JSON.stringify(validated.questions);
      if (changed && started) {
        return res.status(400).json({ error: 'A student has started this task, so the questions can\'t be changed.' });
      }
      patch.questions = validated.questions;
      patch.question = null;
      patch.total_marks = validated.totalMarks;
    }
  }

  // completion_only: derive defensively from the new mode + criteria. Only
  // quick_task without criteria gets completion-only by default; everything
  // else gets it off so stale flags don't surface in the marking UI.
  if (modeInBody || criteriaInPatch || typeof completion_only === 'boolean') {
    if (newMode !== 'quick_task') {
      patch.completion_only = false;
    } else {
      patch.completion_only = typeof completion_only === 'boolean'
        ? completion_only
        : !hasCriteriaNow;
    }
  }

  if (typeof publish === 'boolean') {
    patch.published_at = publish ? (existing.published_at || new Date().toISOString()) : null;
  }

  // Enforce the lock uniformly: once a student has started, drop any change to a
  // field they answer against — only title / due date / notes survive. The edit
  // UI already shows those fields read-only, so this is the server-side backstop.
  // published_at stays editable: publish state isn't content students answer
  // against, and a teacher must be able to pull a task even after a student
  // has an autosaved draft.
  if (started) {
    const ALLOWED_AFTER_START = new Set(['title', 'due_date', 'notes', 'published_at']);
    Object.keys(patch).forEach((k) => { if (!ALLOWED_AFTER_START.has(k)) delete patch[k]; });
  }

  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to update.' });

  const { data: updated, error } = await supabase.from('tasks').update(patch).eq('id', id)
    .select('id, published_at, lti_line_item_url').single();
  if (error) return res.status(500).json({ error: error.message });
  let canvasSync = null;
  // Once a teacher has explicitly created the Canvas assignment, keep its
  // title, marks and due date current. Unsynced tasks remain ProofReady-only.
  if (updated?.published_at && updated.lti_line_item_url) {
    try {
      canvasSync = await syncTaskToCanvas(id);
    } catch (err) {
      captureError(err, { stage: 'canvas-task-update', task_id: id });
      canvasSync = { synced: false, reason: 'Canvas assignment sync failed' };
    }
  }
  return res.status(200).json({ ok: true, canvas_sync: canvasSync });
}

async function handleDelete(req: VercelRequest, res: VercelResponse) {
  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const id = String(req.body?.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Task id is required.' });

  const supabase = getSupabase();
  const { data: existing } = await supabase
    .from('tasks').select('id, classes(teacher_id)').eq('id', id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'Task not found.' });
  const teacherId = (existing.classes as any)?.teacher_id;
  if (teacherId !== user.id) return res.status(403).json({ error: 'You can only delete your own tasks.' });

  // Collect the students whose work is about to be cascade-deleted BEFORE the
  // delete — their cached longitudinal profile describes submissions that will
  // no longer exist, so it must be flagged stale afterwards.
  const { data: subRows, error: subReadErr } = await supabase
    .from('submissions').select('student_id').eq('task_id', id);
  if (subReadErr) {
    captureError(subReadErr, { stage: 'task-delete-submitters-read', task_id: id });
  }
  const affectedStudents = [...new Set((subRows || []).map((s) => s.student_id).filter(Boolean))] as string[];

  // Delete the task only — submissions (and autosaves) go via FK cascade, so
  // either the whole delete succeeds or nothing is touched. (The old explicit
  // submissions-delete could destroy student work and then leave the task
  // behind if the task delete failed.)
  const { error } = await supabase.from('tasks').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });

  // Mark affected students' profile syntheses stale (kept, not deleted) so the
  // read path regenerates them without the deleted work. Best-effort.
  if (affectedStudents.length > 0) {
    const { error: staleErr } = await supabase
      .from('student_profile_synthesis')
      .update({ stale: true })
      .in('student_id', affectedStudents);
    if (staleErr) captureError(staleErr, { stage: 'task-delete-profile-stale', task_id: id });
  }

  return res.status(200).json({ ok: true });
}
