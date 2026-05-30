/**
 * Tool schemas for forced structured output.
 *
 * Each Anthropic call below is invoked with `tool_choice: { type: 'tool',
 * name }`, so the model is required to return its answer as the tool's
 * input — guaranteed valid JSON conforming to the schema. This replaces the
 * previous "ask for JSON in the prompt + regex/brace-walk + JSON.parse"
 * pipeline, which occasionally produced unparseable output (see
 * generate-feedback.ts before tool-use refactor).
 */

import type Anthropic from '@anthropic-ai/sdk';

type Tool = Anthropic.Messages.Tool;

export const HOLISTIC_FEEDBACK_TOOL: Tool = {
  name: 'provide_feedback',
  description:
    'Return structured formative feedback on the student draft. The shape mirrors what the student-facing UI renders — every field must be present.',
  input_schema: {
    type: 'object',
    properties: {
      what_youve_done_well: {
        type: 'object',
        properties: {
          summary: { type: 'array', items: { type: 'string' } },
          detail: { type: 'array', items: { type: 'string' } },
        },
        required: ['summary', 'detail'],
      },
      task_verb_check: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['summary', 'detail'],
      },
      improvements: {
        type: 'object',
        properties: {
          summary: { type: 'array', items: { type: 'string' } },
          detail: { type: 'array', items: { type: 'string' } },
        },
        required: ['summary', 'detail'],
      },
      overall: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['summary', 'detail'],
      },
      top_priority: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['summary', 'detail'],
      },
      what_a_strong_response_includes: {
        type: 'object',
        properties: {
          summary: { type: 'array', items: { type: 'string' } },
        },
        required: ['summary'],
      },
      self_check: { type: 'string' },
    },
    required: [
      'what_youve_done_well',
      'task_verb_check',
      'improvements',
      'overall',
      'top_priority',
      'what_a_strong_response_includes',
      'self_check',
    ],
  },
};

export const CRITERIA_CHECK_TOOL: Tool = {
  name: 'provide_criteria_feedback',
  description: 'Return per-criterion strengths and improvements for every marking criterion supplied.',
  input_schema: {
    type: 'object',
    properties: {
      criteria_feedback: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            criterion: { type: 'string' },
            strengths: { type: 'string' },
            improvements: { type: 'string' },
          },
          required: ['criterion', 'strengths', 'improvements'],
        },
      },
    },
    required: ['criteria_feedback'],
  },
};

export const INLINE_SUGGESTIONS_TOOL: Tool = {
  name: 'provide_inline_suggestions',
  description:
    'Return inline annotations anchored to exact verbatim quotes from the draft. Each quote MUST appear in the draft character-for-character — quotes that do not match are dropped.',
  input_schema: {
    type: 'object',
    properties: {
      inline_suggestions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            quote: {
              type: 'string',
              description: 'Exact verbatim substring of the draft that this annotation anchors to.',
            },
            occurrence: {
              type: 'integer',
              minimum: 1,
              description: 'Which occurrence of the quote in the draft this annotation refers to (1-indexed).',
            },
            category: {
              type: 'string',
              enum: ['strength', 'clarity', 'evidence', 'depth', 'structure', 'task_alignment', 'mechanics'],
            },
            comment: { type: 'string' },
            linked_improvement_index: {
              type: 'integer',
              minimum: 0,
              description: 'Optional 0-based index into the holistic improvements list, when this annotation directly supports one of them.',
            },
          },
          required: ['quote', 'occurrence', 'category', 'comment'],
        },
      },
    },
    required: ['inline_suggestions'],
  },
};

// Maths feedback tools — used by /api/generate-maths-feedback.
//
// MATHS_PER_LINE_DIAGNOSTIC_TOOL is Pass B: walks each line of the
// student's structured working ({ math, reason }) and returns a typed
// chip per line PLUS a list of "step_missing" chips that surface
// between lines where the marking guideline expects a step the
// student skipped.
//
// MATHS_HOLISTIC_TOOL is Pass C: marker-voice comment in three fields
// (what_youve_done_well, top_priority, improvements). No verb_check
// section — verb misreads surface as per-line `verb_mismatch`
// annotations in Pass B.

export const MATHS_PER_LINE_DIAGNOSTIC_TOOL: Tool = {
  name: 'provide_maths_diagnostic',
  description:
    "Walk the student's structured working line by line. For each line, return a typed status + comment. Additionally, surface step_missing chips for any mark-bearing step the student skipped — these sit BETWEEN lines in the rendered output.",
  input_schema: {
    type: 'object',
    properties: {
      line_annotations: {
        type: 'array',
        description: "One entry per line of the student's working, in order.",
        items: {
          type: 'object',
          properties: {
            line_index: {
              type: 'integer',
              minimum: 0,
              description: '0-based index of the student line this annotation refers to.',
            },
            math_status: {
              type: 'string',
              enum: ['ok', 'ok_following_through', 'slip', 'error'],
              description:
                "'ok' = line follows correctly from prior lines and notation is sound. 'ok_following_through' = line is internally consistent with a wrong earlier line (apply follow-through credit). 'slip' = small notation/arithmetic issue. 'error' = substantive math error originating on this line.",
            },
            reason_status: {
              type: 'string',
              enum: ['ok', 'reason_missing', 'reason_imprecise', 'reason_mismatch'],
              description:
                "'ok' = reason matches the move. 'reason_missing' = student left it blank. 'reason_imprecise' = vague ('simplify', 'work it out'). 'reason_mismatch' = the stated reason doesn't match what the math actually does.",
            },
            category: {
              type: 'string',
              enum: [
                'ok',
                'notation_equals_abuse',
                'notation_other',
                'missing_constant',
                'algebra_sign',
                'algebra_distribution',
                'algebra_index_law',
                'arithmetic',
                'method_choice',
                'justification_missing',
                'verb_mismatch',
                'precision_wrong',
                'premature_rounding',
                'unit_missing',
                'context_missing',
                'variable_confusion',
                'domain_restriction_missing',
                'reason_only_issue',
                'other',
              ],
              description: 'Primary error category. Use "ok" only when both math_status and reason_status are ok. Stage 4/5 vs Stage 6 calibration is in the system prompt — pick from the categories the prompt tells you are in-scope for the student\'s stage.',
            },
            comment: {
              type: 'string',
              description: 'One or two sentences explaining the diagnosis. Address the student directly ("you", "your"). NEVER reveal the correct answer or the next step.',
            },
          },
          required: ['line_index', 'math_status', 'reason_status', 'category', 'comment'],
        },
      },
      step_gaps: {
        type: 'array',
        description: "Mark-bearing steps from the marking guideline that the student SKIPPED, expressed as chips inserted BETWEEN lines. Empty array if no step was skipped. Do NOT name the marking guideline or the mark allocation — describe what's missing in plain language.",
        items: {
          type: 'object',
          properties: {
            after_line_index: {
              type: 'integer',
              minimum: -1,
              description: '0-based line index after which this missing step should have appeared. Use -1 if the step is missing at the very start (before line 0).',
            },
            comment: {
              type: 'string',
              description: 'One sentence describing the missing step. Do NOT cite the marking guideline by name. Do NOT mention marks lost. Do NOT give the answer.',
            },
          },
          required: ['after_line_index', 'comment'],
        },
      },
    },
    required: ['line_annotations', 'step_gaps'],
  },
};

export const MATHS_STRUCTURE_WORKING_TOOL: Tool = {
  name: 'structure_maths_working',
  description: "Convert a free-form student input (raw LaTeX-y working or prose-with-inline-math) into the canonical { math, reason } per-line shape used by the maths feedback pipeline. Split on logical step boundaries. Do NOT correct or improve the student's work — capture exactly what they wrote.",
  input_schema: {
    type: 'object',
    properties: {
      lines: {
        type: 'array',
        description: "Ordered list of working steps. Each entry is one logical line. Do not skip steps; do not merge unrelated steps.",
        items: {
          type: 'object',
          properties: {
            math: {
              type: 'string',
              description: 'The mathematical content of this line as LaTeX. If the student wrote prose around the math, extract just the math here. Empty string if this line has no math.',
            },
            reason: {
              type: 'string',
              description: 'The student\'s reasoning for this step, extracted from their input. Prefer their own words when available. Empty string if the student gave no reason.',
            },
          },
          required: ['math', 'reason'],
        },
      },
    },
    required: ['lines'],
  },
};

export const MATHS_HOLISTIC_TOOL: Tool = {
  name: 'provide_maths_holistic_feedback',
  description: 'Return holistic marker-voice feedback in three sections: what the student has done well, the single top priority, and a short list of improvements. No verb-check section — verb misreads are caught at the per-line level by the diagnostic tool.',
  input_schema: {
    type: 'object',
    properties: {
      what_youve_done_well: {
        type: 'array',
        description: '2–4 specific, genuine strengths in the student\'s working. Each one a single sentence. Reference specific lines where relevant. NEVER mention marks or grades.',
        items: { type: 'string' },
      },
      top_priority: {
        type: 'string',
        description: 'The single most important thing the student should fix first. One paragraph (2–4 sentences). Reference specific line numbers where helpful. NEVER give the answer; NEVER predict marks.',
      },
      improvements: {
        type: 'array',
        description: '2–4 specific improvements the student should make on this draft. Numbered, actionable. Reference specific line numbers where helpful. Each one a single sentence.',
        items: { type: 'string' },
      },
    },
    required: ['what_youve_done_well', 'top_priority', 'improvements'],
  },
};

export const RUBRIC_PARSE_TOOL: Tool = {
  name: 'parse_rubric',
  description:
    "Parse a teacher's marking rubric into structured form. Output the renderer-compatible shape used by the ProofReady UI. Choose 'band' format when the rubric organises descriptors by overall quality level / mark range (Band 5, Grade A, 17-20, etc.). Choose 'criterion' format when the rubric lists separable assessment dimensions (Knowledge, Analysis, Communication, etc.). PRESERVE the teacher's wording verbatim — do not paraphrase, summarise, or merge. Drop pure table-header rows (Marks | Criteria, Range | Descriptor, Marking Criteria) — those are formatting noise, not content. For band format, list highest range first.",
  input_schema: {
    type: 'object',
    properties: {
      format: {
        type: 'string',
        enum: ['band', 'criterion'],
        description: "'band' = quality levels of overall response (highest first); 'criterion' = separable assessment dimensions",
      },
      bands: {
        type: 'array',
        description: "Populated only when format='band'. One entry per band, highest range first.",
        items: {
          type: 'object',
          properties: {
            range: { type: 'string', description: 'Mark range as written, e.g. "17–20" or "21-25 marks"' },
            criteria: {
              type: 'array',
              items: { type: 'string' },
              description: 'Descriptor points for this band — ONE point per array entry. If the band descriptor contains multiple distinct sentences/clauses (e.g. one about analysis, one about evidence, one about communication), split them into separate entries. The renderer shows each entry as its own bullet, so multiple distinct points must be separate entries even if the teacher wrote them as a continuous paragraph. Only return a single entry if the descriptor is genuinely one indivisible point. Preserve the teacher\'s wording verbatim.',
            },
          },
          required: ['range', 'criteria'],
        },
      },
      criteria: {
        type: 'array',
        description: "Populated only when format='criterion'. Preserve the teacher's order.",
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Criterion name as written (e.g. "Knowledge and understanding")' },
            range: { type: 'string', description: 'Marks allocation, e.g. "3" or "3-5". Empty string if not specified.' },
            details: {
              type: 'array',
              items: { type: 'string' },
              description: 'Bullet points or detail sentences for this criterion (empty array if none).',
            },
          },
          required: ['name', 'range', 'details'],
        },
      },
    },
    required: ['format'],
  },
};

export const CLASS_FEEDBACK_TOOL: Tool = {
  name: 'provide_class_feedback',
  description: 'Return aggregated class-level feedback synthesised from individual student feedbacks.',
  input_schema: {
    type: 'object',
    properties: {
      class_strengths: { type: 'array', items: { type: 'string' } },
      class_weaknesses: { type: 'array', items: { type: 'string' } },
      task_verb_adherence: { type: 'string' },
      top_priorities: { type: 'array', items: { type: 'string' } },
      overall_snapshot: { type: 'string' },
    },
    required: ['class_strengths', 'class_weaknesses', 'task_verb_adherence', 'top_priorities', 'overall_snapshot'],
  },
};

export const BOTTOM_DECILE_TOOL: Tool = {
  name: 'provide_bottom_decile_patterns',
  description:
    'Identify the dominant patterns of mistakes appearing in the AI improvement feedback for the bottom decile of students by mark percentage. Output 3 actionable, specific patterns that a head of teaching & learning could put on a faculty meeting agenda.',
  input_schema: {
    type: 'object',
    properties: {
      patterns: {
        type: 'array',
        description: 'Exactly 3 dominant patterns, ordered by how widespread they are. Most prevalent first.',
        items: {
          type: 'object',
          properties: {
            rank: { type: 'integer', minimum: 1, maximum: 3 },
            headline: { type: 'string', description: 'One short, specific sentence naming the mistake (e.g. "Treating analyse as describe — listing features without explaining significance").' },
            detail: { type: 'string', description: '1-2 sentences expanding what the pattern looks like and why it matters for these students.' },
            prevalence_note: { type: 'string', description: "Plain-language indicator of how widespread (e.g. 'shows in most of the bottom-decile submissions reviewed', 'half of the cohort'). No numeric claims beyond the scope_note." },
          },
          required: ['rank', 'headline', 'detail', 'prevalence_note'],
        },
      },
      scope_note: { type: 'string', description: '1 sentence indicating the sample (how many submissions were analysed). No band predictions.' },
    },
    required: ['patterns', 'scope_note'],
  },
};

export const TOP_DECILE_TOOL: Tool = {
  name: 'provide_top_decile_next_steps',
  description:
    'For the top decile of students by mark percentage, identify the 3 most useful next-step recommendations to lift their work further. Stretch-focused — these students already perform well.',
  input_schema: {
    type: 'object',
    properties: {
      next_steps: {
        type: 'array',
        description: 'Exactly 3 next steps, ordered by impact.',
        items: {
          type: 'object',
          properties: {
            rank: { type: 'integer', minimum: 1, maximum: 3 },
            headline: { type: 'string', description: 'One sentence naming the stretch step (e.g. "Sustain critical evaluation across all body paragraphs, not just paragraph 2").' },
            detail: { type: 'string', description: '1-2 sentences explaining what the upgrade looks like in their writing.' },
          },
          required: ['rank', 'headline', 'detail'],
        },
      },
      scope_note: { type: 'string', description: '1 sentence on the sample.' },
    },
    required: ['next_steps', 'scope_note'],
  },
};

export const VERB_DEPTH_TOOL: Tool = {
  name: 'provide_verb_depth_patterns',
  description:
    'Examine how students across the school are handling NESA directive verbs. For each verb that appears with enough signal, surface the pattern in how it is being executed. This is the single most actionable diagnostic for HSC writing — it tells leadership which verbs need whole-faculty PD.',
  input_schema: {
    type: 'object',
    properties: {
      verbs: {
        type: 'array',
        description: 'Up to 6 verbs with the strongest cross-school pattern. Skip verbs with insufficient signal.',
        items: {
          type: 'object',
          properties: {
            verb: { type: 'string', description: 'The NESA directive verb (e.g. "analyse", "evaluate", "justify").' },
            handling_note: { type: 'string', description: 'One sentence describing how students are handling this verb (e.g. "Treated as describe — students list features without explaining significance" or "Well executed — most students sustain critical judgement with evidence").' },
            faculties_involved: { type: 'array', items: { type: 'string' }, description: 'Faculties (KLAs) where this pattern is visible.' },
            severity: { type: 'string', enum: ['strength', 'mixed', 'concern'], description: "'strength' if the verb is being handled well, 'concern' if students consistently fall short, 'mixed' if patterns vary." },
          },
          required: ['verb', 'handling_note', 'faculties_involved', 'severity'],
        },
      },
      overall_pattern: { type: 'string', description: '1-2 sentences summarising the dominant cross-verb pattern leadership should action.' },
    },
    required: ['verbs', 'overall_pattern'],
  },
};

export const COMMON_GAPS_TOOL: Tool = {
  name: 'provide_common_gaps',
  description: 'Top 5 gaps appearing in AI improvement feedback across the whole cohort (not just the bottom decile). These drive whole-staff PD priorities.',
  input_schema: {
    type: 'object',
    properties: {
      gaps: {
        type: 'array',
        description: 'Exactly 5 cohort-wide gaps, ranked by prevalence.',
        items: {
          type: 'object',
          properties: {
            rank: { type: 'integer', minimum: 1, maximum: 5 },
            headline: { type: 'string' },
            detail: { type: 'string' },
            faculties_involved: { type: 'array', items: { type: 'string' } },
          },
          required: ['rank', 'headline', 'detail', 'faculties_involved'],
        },
      },
      scope_note: { type: 'string' },
    },
    required: ['gaps', 'scope_note'],
  },
};

export const THINGS_DONE_WELL_TOOL: Tool = {
  name: 'provide_things_done_well',
  description: 'Top 3 things students across the school are consistently doing well, drawn from AI strength feedback. Useful for sharing best practice between faculties and for celebrating wins in faculty meetings.',
  input_schema: {
    type: 'object',
    properties: {
      strengths: {
        type: 'array',
        description: 'Exactly 3 strengths, most prevalent first.',
        items: {
          type: 'object',
          properties: {
            rank: { type: 'integer', minimum: 1, maximum: 3 },
            headline: { type: 'string' },
            detail: { type: 'string' },
            faculties_involved: { type: 'array', items: { type: 'string' } },
          },
          required: ['rank', 'headline', 'detail', 'faculties_involved'],
        },
      },
      scope_note: { type: 'string' },
    },
    required: ['strengths', 'scope_note'],
  },
};

export const SCHOOL_INSIGHTS_TOOL: Tool = {
  name: 'provide_school_insights',
  description:
    'Return a cross-faculty synthesis of student writing performance for an entire school, rolled up from per-task class-level feedback. Written for school leadership (Head of Teaching & Learning, Deputy Principal). Aggregates strengths, gaps, and cross-faculty patterns into a leadership-actionable overview.',
  input_schema: {
    type: 'object',
    properties: {
      school_snapshot: {
        type: 'string',
        description:
          '2 to 3 sentences giving an honest overall picture of student writing performance across the school. Where is the cohort strongest? Where are the most consistent gaps? Frame for leadership (not parents, not students).',
      },
      school_strengths: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Up to 5 strengths that appear across multiple tasks / faculties. Each entry one specific point — name the skill, concept, or approach. Avoid generic praise.',
      },
      school_weaknesses: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Up to 5 gaps or misconceptions that appear across multiple tasks / faculties. Be specific about what is going wrong and how widespread it is.',
      },
      verb_depth_patterns: {
        type: 'string',
        description:
          'A short paragraph on how students are handling NESA task verbs across the school. Common patterns (e.g. "analyse" being treated as "describe"). Reference faculties where this is most visible.',
      },
      by_faculty: {
        type: 'array',
        description:
          'Per-faculty breakdown. Include only faculties that have at least one task with class-level feedback. Faculty = the NSW KLA grouping (HSIE, English, PDHPE, etc.) inferred from the task course.',
        items: {
          type: 'object',
          properties: {
            faculty: { type: 'string', description: 'Faculty / KLA name (e.g. PDHPE, English, HSIE).' },
            task_count: { type: 'integer', description: 'Number of tasks contributing to this faculty rollup.' },
            strengths: {
              type: 'array',
              items: { type: 'string' },
              description: 'Up to 3 faculty-level strengths.',
            },
            weaknesses: {
              type: 'array',
              items: { type: 'string' },
              description: 'Up to 3 faculty-level gaps.',
            },
            notable_pattern: {
              type: 'string',
              description: 'One sentence on the standout pattern for this faculty.',
            },
          },
          required: ['faculty', 'task_count', 'strengths', 'weaknesses', 'notable_pattern'],
        },
      },
      teachable_moments: {
        type: 'array',
        items: { type: 'string' },
        description:
          '3 to 5 high-leverage, cross-faculty teaching opportunities leadership could action. Each entry should be a concrete, addressable point (e.g. "Schedule a whole-staff PD on NESA verb depth", "Cross-KLA moderation on use of evidence"). Avoid platitudes.',
      },
    },
    required: [
      'school_snapshot',
      'school_strengths',
      'school_weaknesses',
      'verb_depth_patterns',
      'by_faculty',
      'teachable_moments',
    ],
  },
};

// ─────────────── Single-student LLM card tools ───────────────

export const STUDENT_TOP_MISTAKES_TOOL: Tool = {
  name: 'provide_student_top_mistakes',
  description:
    'Identify the 3 most recurring mistakes appearing across one student\'s AI improvement feedback. The audience is the student\'s teacher — be specific, name the student, and tie each mistake to something teachable.',
  input_schema: {
    type: 'object',
    properties: {
      mistakes: {
        type: 'array',
        description: 'Exactly 3 mistakes, ranked by how often they appear across this student\'s submissions.',
        items: {
          type: 'object',
          properties: {
            rank: { type: 'integer', minimum: 1, maximum: 3 },
            headline: { type: 'string', description: 'One short sentence naming the recurring mistake.' },
            detail: { type: 'string', description: '1-2 sentences expanding what the pattern looks like in this student\'s writing and what specifically would address it.' },
          },
          required: ['rank', 'headline', 'detail'],
        },
      },
      scope_note: { type: 'string', description: '1 sentence on the sample (how many of this student\'s submissions were analysed).' },
    },
    required: ['mistakes', 'scope_note'],
  },
};

export const STUDENT_STRETCH_GOALS_TOOL: Tool = {
  name: 'provide_student_stretch_goals',
  description:
    'For one student, identify the 3 highest-impact next-step recommendations to lift their work. Personalised to their writing patterns, not generic advice.',
  input_schema: {
    type: 'object',
    properties: {
      next_steps: {
        type: 'array',
        description: 'Exactly 3 next steps, ordered by impact.',
        items: {
          type: 'object',
          properties: {
            rank: { type: 'integer', minimum: 1, maximum: 3 },
            headline: { type: 'string', description: 'One sentence naming the stretch step for this student.' },
            detail: { type: 'string', description: '1-2 sentences explaining what the upgrade looks like for this student specifically.' },
          },
          required: ['rank', 'headline', 'detail'],
        },
      },
      scope_note: { type: 'string', description: '1 sentence on the sample.' },
    },
    required: ['next_steps', 'scope_note'],
  },
};

export const STUDENT_STRENGTHS_TOOL: Tool = {
  name: 'provide_student_strengths',
  description: 'Top 3 strengths this student is demonstrating consistently across their AI feedback. Drawn from the strengths and what_youve_done_well sections.',
  input_schema: {
    type: 'object',
    properties: {
      strengths: {
        type: 'array',
        description: 'Exactly 3 strengths, ranked by how consistent they are across this student\'s submissions.',
        items: {
          type: 'object',
          properties: {
            rank: { type: 'integer', minimum: 1, maximum: 3 },
            headline: { type: 'string' },
            detail: { type: 'string' },
          },
          required: ['rank', 'headline', 'detail'],
        },
      },
      scope_note: { type: 'string' },
    },
    required: ['strengths', 'scope_note'],
  },
};

export const STUDENT_SUMMARY_TOOL: Tool = {
  name: 'provide_student_summary',
  description:
    'Write a 4–6 sentence report-style narrative paragraph for one student that a classroom teacher could use as the starting point for a parent meeting, report comment, or feedback chat. Address the student in third person, name them, and ground every claim in their actual feedback corpus.',
  input_schema: {
    type: 'object',
    properties: {
      summary_paragraph: {
        type: 'string',
        description: '4–6 sentences. Open with where the student sits overall, then their key strength(s), then their key priority(ies), and close with a concrete next step. Address the student by name in third person. Do NOT predict marks or bands.',
      },
      headline_strength: { type: 'string', description: 'One short sentence — the single thing this student is doing best.' },
      headline_priority: { type: 'string', description: 'One short sentence — the single most impactful thing to address next.' },
      tone_note: { type: 'string', description: 'One sentence describing the overall tone of their writing development (e.g. "Showing steady gains across drafts", "Plateauing — same priorities recurring across tasks", "Improving in structure but content depth still uneven").' },
    },
    required: ['summary_paragraph', 'headline_strength', 'headline_priority', 'tone_note'],
  },
};

/**
 * Lightweight schema used by the silent insights pass on marked_task /
 * quick_task submissions. Output is never shown to students — it feeds the
 * cohort LLM cards and the student profile only. Same shape as the relevant
 * subset of HOLISTIC_FEEDBACK_TOOL so the existing consumers
 * (insights-card-generate, lib/student-profile) work without changes.
 */
export const INSIGHTS_SIGNALS_TOOL: Tool = {
  name: 'provide_insights_signals',
  description:
    'Extract structured signals from a student draft for school-level analytics. Never shown to the student — these feed cohort LLM cards and the student profile only.',
  input_schema: {
    type: 'object',
    properties: {
      what_youve_done_well: {
        type: 'object',
        properties: {
          summary: {
            type: 'array',
            items: { type: 'string' },
            description: '2–3 short strength tags, 5–10 words each. Aggregate-friendly phrasing.',
          },
        },
        required: ['summary'],
      },
      task_verb_check: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'One sentence on whether the draft operates at the depth the directive verb requires.',
          },
        },
        required: ['summary'],
      },
      improvements: {
        type: 'object',
        properties: {
          summary: {
            type: 'array',
            items: { type: 'string' },
            description: '2–4 short improvement tags, 5–10 words each. Aggregate-friendly phrasing.',
          },
          detail: {
            type: 'array',
            items: { type: 'string' },
            description: 'One short sentence per tag explaining what the student needs to do differently.',
          },
        },
        required: ['summary', 'detail'],
      },
      top_priority: {
        type: 'string',
        description: 'One sentence — the single most useful next step.',
      },
    },
    required: ['what_youve_done_well', 'task_verb_check', 'improvements', 'top_priority'],
  },
};

export const CLASS_PROFILE_SUMMARY_TOOL: Tool = {
  name: 'synthesise_class_profile_summary',
  description:
    'Aggregate the longitudinal profiles of a class\'s currently-enrolled students into a coherent picture of where the cohort stands as it enters this class. Use this when a teacher wants to know what the class looks like coming in, before they\'ve set tasks of their own.',
  input_schema: {
    type: 'object',
    properties: {
      aggregate_narrative: {
        type: 'string',
        description: '3–5 sentences describing the cohort\'s baseline as they enter this class. What is consistently strong, what is consistently a priority, what variation exists. Aggregate only — never name individual students.',
      },
      top_strengths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Top 3 strengths that recur across multiple students\' profiles. Each 5–12 words.',
      },
      top_priorities: {
        type: 'array',
        items: { type: 'string' },
        description: 'Top 3 priorities that recur across multiple students\' profiles. Each 5–12 words. These should be patterns the teacher can target in their first few weeks of lessons.',
      },
    },
    required: ['aggregate_narrative', 'top_strengths', 'top_priorities'],
  },
};
