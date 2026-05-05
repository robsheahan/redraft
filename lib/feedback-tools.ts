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
              description: 'Descriptor sentences for this band (one entry per bullet, or a single entry if the descriptor is one paragraph)',
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
