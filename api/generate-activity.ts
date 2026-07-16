/**
 * Lesson Builder — generate (or fetch) one student's differentiated activity.
 *
 * Lazy-on-open: the student's submit page calls this when they open a
 * lesson_builder task. If a variant is already locked, return it. Otherwise read
 * their skill profile and either:
 *   - no skill data → store is_differentiated:false (NO model call) → they get
 *     the main activity unchanged; or
 *   - some data → one Sonnet call producing a support layer, stored + locked so
 *     it's stable across their drafts.
 *
 * Failures degrade silently to the main activity — students never see an error.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getSupabase } from '../lib/auth.js';
import { withHandler } from '../lib/with-handler.js';
import { checkAndLogRateLimit } from '../lib/rate-limit.js';
import { captureError } from '../lib/sentry.js';
import { callTool } from '../lib/anthropic-tool-call.js';
import { readSkillProfile } from '../lib/skill-profile.js';
import { DIFFERENTIATED_ACTIVITY_TOOL, DIFFERENTIATED_MATHS_ACTIVITY_TOOL, MATHS_RESKIN_VERIFY_TOOL } from '../lib/feedback-tools.js';
import { skillDiscipline } from '../data/nesa-courses.js';
import { currentYearLevelFromGraduationYear } from '../data/nesa-reference.js';
import { familyForSubjectType, dimensionsForFamily, TAXONOMY_VERSION } from '../data/skill-taxonomy.js';
import { buildActivitySystemPrompt, buildMathsActivitySystemPrompt, buildActivityUserPrompt, buildMathsReskinVerifySystemPrompt, buildMathsReskinVerifyUserPrompt } from '../prompts/lesson-builder-system.js';

const MODEL = 'claude-sonnet-5';

// Shape returned to the student (teacher-facing fields intentionally absent).
const MAIN_ACTIVITY = { is_differentiated: false, activity: null };

// student_focus is shown RAW to the student and must be an invitation, never a
// deficit diagnosis. The prompt says so, but there's no verifier on the writing
// path — so this is the backstop: if a focus line reads as a diagnosis (level/
// band words, "because you…", "weakness", "you struggle/lack"), drop it rather
// than show it. Blanking is safe — the student still gets the scaffolding and the
// main activity. False positives just lose one line; a false negative would put a
// deficit label in front of a student.
const DEFICIT_FRAMING_RE = /\bbecause you\b|\bweakness(es)?\b|\byou struggle\b|\byou'?re?\s+(weak|struggling)\b|\byou lack\b|\bdeficit\b|\bband\s*\d|\b(emerging|developing|consolidating|secure|extending)\s+level\b/i;

function safeStudentFocus(text: string): string {
  if (text && DEFICIT_FRAMING_RE.test(text)) {
    console.warn('[lesson-builder] student_focus dropped — deficit-framed:', text.slice(0, 120));
    return '';
  }
  return text;
}

export default withHandler({ methods: ['POST'], label: 'generate-activity' }, async (req, res, ctx) => {
  const user = ctx.user!;

  const { task_id } = (req.body || {}) as { task_id?: string };
  if (!task_id) return res.status(400).json({ error: 'task_id is required' });

  const supabase = getSupabase();

  // Load task + gate on lesson_builder + class membership.
  const { data: task } = await supabase.from('tasks').select('*').eq('id', task_id).maybeSingle();
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (!task.lesson_builder) return res.status(200).json(MAIN_ACTIVITY);
  // Belt-and-braces: in-class exams must stay standardised — never differentiate
  // a marked_task even if a legacy row somehow carries lesson_builder = true.
  if (task.task_mode === 'marked_task') return res.status(200).json(MAIN_ACTIVITY);
  // Draft tasks are invisible to students everywhere else; without this gate a
  // class member holding the UUID could trigger generation early and read a
  // re-skinned variant of the unpublished question.
  if (!task.published_at) return res.status(400).json({ error: 'This task is a draft and not yet open.' });

  const { data: membership } = await supabase
    .from('class_members').select('student_id')
    .eq('class_id', task.class_id).eq('student_id', user.id).maybeSingle();
  if (!membership) return res.status(403).json({ error: "You are not a member of this task's class." });

  // Already locked? Return it as-is (stable across the student's drafts).
  const { data: existing } = await supabase
    .from('task_activities').select('activity, is_differentiated')
    .eq('task_id', task_id).eq('student_id', user.id).maybeSingle();
  if (existing) {
    return res.status(200).json({
      is_differentiated: !!existing.is_differentiated,
      activity: existing.is_differentiated ? existing.activity : null,
    });
  }

  // Read the student's skill profile for this task's discipline + family.
  // skillDiscipline is the SAME key the write side uses (fallback 'Other'), so a
  // task with an unrecognised course still finds its skill data (previously the
  // read used 'General'/write used 'Mathematics' → silent no-data → no differentiation).
  const discipline = skillDiscipline(task.course);
  const family = familyForSubjectType(task.subject_type);
  const familyKeys = new Set(dimensionsForFamily(family).map((d) => d.key));
  const allRows = await readSkillProfile(supabase, user.id, discipline);
  // Confidence floor (2.2): differentiate off a dimension only once it has ≥2
  // observations. A single read — especially an outlier (a hard question, an OCR
  // glitch, a bad day) — shouldn't peg and LOCK a student's differentiation; below
  // the floor they get the main activity (not locked as differentiated, so it
  // re-evaluates once more data lands). The rule 4 "keep support gentle on thin
  // data" prompt line stays as a second guard for the 2-observation case.
  const MIN_OBS_TO_DIFFERENTIATE = 2;
  const rows = allRows.filter((r) => r.observation_count >= MIN_OBS_TO_DIFFERENTIATE && familyKeys.has(r.dimension));

  // No usable skill data → main activity, locked, no model call.
  if (rows.length === 0) {
    await supabase.from('task_activities').upsert({
      task_id, student_id: user.id,
      activity: { student_focus: '', scaffolding: [], extension: '' },
      is_differentiated: false,
      source_submission_count: 0,
      taxonomy_version: TAXONOMY_VERSION,
    });
    return res.status(200).json(MAIN_ACTIVITY);
  }

  // Rate-limit (generous — normally one generation per student per task).
  const rl = await checkAndLogRateLimit(supabase, user.id, {
    endpoint: 'generate-activity',
    perUserPerHour: 30,
    globalPerDay: 5000,
  });
  if (!rl.ok) {
    // Don't block the student — fall back to the main activity.
    return res.status(200).json(MAIN_ACTIVITY);
  }

  const gradYear = (user.user_metadata && (user.user_metadata as any).graduation_year) || null;
  const yearLevel = currentYearLevelFromGraduationYear(gradYear);

  const hasGuideline = !!(task.marking_guideline && String(task.marking_guideline).trim());
  // Maths with NO marking guideline → re-skin the question to the student's level
  // (same outcome + method). With a guideline (written for the base question) or
  // for writing → support-layer only, question unchanged.
  const isMathsReskin = family === 'maths' && !hasGuideline;

  let value: any;
  try {
    const client = process.env.ANTHROPIC_API_KEY
      ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 })
      : undefined;
    const result = await callTool<any>({
      client,
      model: MODEL,
      max_tokens: 1024,
      system: isMathsReskin
        ? buildMathsActivitySystemPrompt({ question: task.question, course: task.course || null, yearLevel })
        : buildActivitySystemPrompt({
            question: task.question,
            criteriaText: task.criteria_text || null,
            course: task.course || null,
            family,
            yearLevel,
          }),
      user: buildActivityUserPrompt(rows),
      tool: isMathsReskin ? DIFFERENTIATED_MATHS_ACTIVITY_TOOL : DIFFERENTIATED_ACTIVITY_TOOL,
      cacheSystem: true,
      label: isMathsReskin ? 'lesson-builder:maths-activity' : 'lesson-builder:activity',
    });
    value = result.value;
  } catch (err: any) {
    captureError(err, { stage: 'generate-activity', task_id, user_id: user.id });
    return res.status(200).json(MAIN_ACTIVITY); // silent fallback
  }

  const scaffolding = Array.isArray(value?.scaffolding) ? value.scaffolding.filter((s: any) => typeof s === 'string' && s.trim()) : [];
  const studentFocus = safeStudentFocus(typeof value?.student_focus === 'string' ? value.student_focus : '');

  let activity: any;
  if (isMathsReskin) {
    const reskinned = typeof value?.question === 'string' ? value.question.trim() : '';
    const claimedDifficulty = ['easier', 'same', 'harder'].includes(value?.difficulty) ? value.difficulty : 'same';

    // Lock the main activity unchanged. Used whenever we can't produce a
    // trustworthy re-skin (empty generation OR a failed/errored verification) —
    // we NEVER lock a re-skin we haven't independently confirmed.
    const fallBackToMain = async () => {
      await supabase.from('task_activities').upsert({
        task_id, student_id: user.id,
        activity: { student_focus: '', scaffolding: [], extension: '' },
        is_differentiated: false, source_submission_count: 0, taxonomy_version: TAXONOMY_VERSION,
      });
      return res.status(200).json(MAIN_ACTIVITY);
    };

    // No usable re-skin → fall back to the main activity (never lock a broken one).
    if (!reskinned) return fallBackToMain();

    // INDEPENDENT VERIFY PASS — the gate that makes the highest-risk Lesson
    // Builder surface rock solid. A fresh model works the re-skinned question
    // from scratch and must confirm all three: solvable, same method as the
    // original, and an appropriate difficulty. The re-skin ships only if all
    // three pass; any rejection or error degrades silently to the original
    // question. Overall pass is derived here, never trusted to a single field.
    try {
      const verifyClient = process.env.ANTHROPIC_API_KEY
        ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 })
        : undefined;
      const verdict = await callTool<any>({
        client: verifyClient,
        model: MODEL,
        max_tokens: 1024,
        system: buildMathsReskinVerifySystemPrompt({ course: task.course || null, yearLevel }),
        user: buildMathsReskinVerifyUserPrompt({
          originalQuestion: task.question,
          reskinnedQuestion: reskinned,
          claimedDifficulty,
          // The base question's worked solution (when the teacher provided one) is
          // the intended METHOD — give it to the verifier so "same method" is
          // judged against the real approach, not just "an answer exists".
          workedSolution: typeof task.worked_solution === 'string' ? task.worked_solution : null,
        }),
        tool: MATHS_RESKIN_VERIFY_TOOL,
        label: 'lesson-builder:maths-verify',
      });
      const v = verdict.value || {};
      const passed = v.solvable === true && v.method_matches === true && v.difficulty_appropriate === true;
      if (!passed) {
        console.warn(`[lesson-builder] maths re-skin rejected by verifier (task ${task_id}, student ${user.id}): ${typeof v.reason === 'string' ? v.reason : 'no reason given'}`);
        return fallBackToMain();
      }
    } catch (err: any) {
      captureError(err, { stage: 'generate-activity:maths-verify', task_id, user_id: user.id });
      return fallBackToMain();
    }

    activity = {
      question: reskinned,
      difficulty: claimedDifficulty,
      student_focus: studentFocus,
      scaffolding,
    };
  } else {
    const extension = typeof value?.extension === 'string' ? value.extension : '';
    // Empty-activity guard: if nothing differentiating survived (no focus after
    // the tone strip, no scaffolding, no extension), deliver the MAIN activity
    // rather than a "Your focus for this task" banner with nothing under it.
    if (!studentFocus.trim() && scaffolding.length === 0 && !extension.trim()) {
      await supabase.from('task_activities').upsert({
        task_id, student_id: user.id,
        activity: { student_focus: '', scaffolding: [], extension: '' },
        is_differentiated: false, source_submission_count: 0, taxonomy_version: TAXONOMY_VERSION,
      });
      return res.status(200).json(MAIN_ACTIVITY);
    }
    activity = { student_focus: studentFocus, scaffolding, extension };
  }

  const sourceCount = rows.reduce((m, r) => Math.max(m, r.observation_count), 0);
  await supabase.from('task_activities').upsert({
    task_id, student_id: user.id,
    activity,
    is_differentiated: true,
    source_submission_count: sourceCount,
    taxonomy_version: TAXONOMY_VERSION,
  });

  return res.status(200).json({ is_differentiated: true, activity });
});
