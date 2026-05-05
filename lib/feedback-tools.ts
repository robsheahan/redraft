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
