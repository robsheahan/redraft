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
