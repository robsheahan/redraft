/**
 * Core feedback prompt — the heart of the tool.
 *
 * Central question: "How can we get the most accurate possible feedback
 * to mimic that of a professional, experienced teacher?"
 *
 * Design decisions:
 * - Personable: uses "you/your" throughout — talks TO the student
 * - Exhaustive: lists every flaw found, never truncates for brevity
 * - Actionable: every improvement point tells the student exactly what to do
 * - Affirming: dedicated section for what's working and shouldn't change
 * - Natural voice: reads like a teacher's written feedback, not a rubric matrix
 * - NESA-grounded: band descriptors, glossary, and marking principles anchor feedback to real standards
 * - Research-backed: incorporates Hattie's feedback levels, SOLO Taxonomy, and feedforward framing
 */

import {
  GLOSSARY,
  PERFORMANCE_BANDS,
  MARKING_PRINCIPLES,
  SOLO_LEVELS,
  VERB_DEPTH_MAP,
  COMMON_PITFALLS,
  FEEDBACK_PRINCIPLES,
} from "../data/nesa-reference.js";
import { buildMarkerVoiceReference } from "../data/marker-voice-loader.js";

export const DISCIPLINE_PERSONAS: Record<string, string> = {
  English: "English teacher with extensive experience in textual analysis, essay writing, and HSC marking",
  Mathematics: "Mathematics teacher with deep knowledge of problem-solving strategies, proof techniques, and mathematical communication",
  Science: "Science teacher with expertise in scientific investigation, data analysis, and evidence-based reasoning",
  HSIE: "HSIE teacher with deep knowledge of source analysis, historical and geographical inquiry, and evidence-based argument",
  "Creative Arts": "Creative Arts teacher with expertise in artistic practice, critical analysis, and creative expression",
  PDHPE: "PDHPE teacher with deep knowledge of health promotion frameworks, movement science, and wellbeing",
  TAS: "Technology teacher with expertise in design processes, engineering principles, and technical communication",
  Languages: "Languages teacher with expertise in linguistic analysis, cultural understanding, and communication skills",
  VET: "VET teacher with industry experience and expertise in competency-based assessment and workplace skills",
};

const DISCIPLINE_PITFALLS: Record<string, string[]> = {
  English: [
    "Retelling the text rather than analysing how meaning is constructed through techniques.",
    "Identifying techniques without explaining their effect on the reader or how they shape meaning.",
    "Not integrating quotations into sentences — dropping quotes without context or analysis.",
    "Writing a generic thesis that could apply to any text rather than engaging with the specific text's concerns.",
  ],
  Mathematics: [
    "Showing the answer without showing working or logical steps — marks are awarded for the process.",
    "Not defining variables or stating assumptions before using them in calculations.",
    "Skipping proof steps or assuming what needs to be proved.",
    "Confusing similar concepts: e.g. permutations vs combinations, correlation vs causation, convergence vs divergence.",
  ],
  Science: [
    "Describing what happened in an experiment without explaining why (missing the scientific reasoning).",
    "Not linking observations to underlying scientific principles or models.",
    "Confusing correlation with causation when interpreting data.",
    "Not controlling variables or acknowledging limitations in experimental design.",
  ],
  HSIE: [
    "Narrating events chronologically instead of building an analytical argument.",
    "Not using source evidence to support claims — making assertions without proof.",
    "Presenting only one perspective when the question requires multiple viewpoints.",
    "Confusing description of a geographical/historical process with analysis of its significance or impact.",
  ],
  "Creative Arts": [
    "Describing artwork without analysing how artistic choices create meaning or impact.",
    "Not connecting practice to conceptual framework (artist, artwork, world, audience).",
    "Listing techniques without discussing their relationship to the artist's intention.",
    "Failing to reference specific works, performances, or practitioners to support arguments.",
  ],
  PDHPE: [
    "Listing Ottawa Charter action areas or health frameworks without connecting them to specific real-world examples.",
    "Confusing related concepts: e.g. determinants vs risk factors, morbidity vs mortality, prevalence vs incidence.",
    "Not using specific, current Australian health data or statistics to support arguments.",
    "Confusing types of training (aerobic vs anaerobic) or principles of training with methods of training.",
  ],
  TAS: [
    "Describing a design solution without justifying design decisions against the brief or constraints.",
    "Not evaluating the effectiveness of a solution against the original design criteria.",
    "Listing materials or processes without explaining why they were chosen for this context.",
    "Failing to consider safety, sustainability, or ethical implications in design evaluation.",
  ],
  Languages: [
    "Direct translation from English that produces grammatically incorrect or unnatural phrasing.",
    "Not varying vocabulary — relying on basic words when more sophisticated alternatives are expected.",
    "Ignoring register (formal vs informal) appropriate to the text type and audience.",
    "Not demonstrating cultural understanding when the task requires it.",
  ],
  VET: [
    "Describing workplace procedures without connecting them to industry standards or regulations.",
    "Not demonstrating understanding of WHS requirements relevant to the task.",
    "Listing competencies without providing evidence of practical application.",
    "Using informal language when workplace documentation requires formal, industry-standard terminology.",
  ],
};

interface TaskCriterion {
  name: string;
  description: string;
  maxMarks: number;
}

interface FeedbackPromptInput {
  taskDescription: string;
  taskVerb?: string;
  taskVerbs?: string[];
  outcomes: string[];
  criteria: TaskCriterion[];
  criteriaText?: string;
  studentText: string;
  teacherNotes?: string;
  taskType?: string;
  priorDrafts?: Array<{ draft_text: string; feedback: any; draft_version: number }>;
  draftVersion?: number;
}

export function buildSystemPrompt(courseName?: string, discipline?: string): string {
  const bandDescriptions = PERFORMANCE_BANDS.map(
    (b) => `Band ${b.band} (${b.markRange}): ${b.description}`
  ).join("\n\n");

  const glossaryEntries = Object.entries(GLOSSARY)
    .map(([term, def]) => `- ${term}: ${def}`)
    .join("\n");

  const markingPrinciples = MARKING_PRINCIPLES.map(
    (p, i) => `${i + 1}. ${p}`
  ).join("\n");

  const soloLevels = SOLO_LEVELS.map(
    (s) => `- ${s.level}: ${s.description} → Guidance: "${s.studentAction}"`
  ).join("\n");

  const verbDepthEntries = Object.entries(VERB_DEPTH_MAP)
    .sort((a, b) => a[1].depth - b[1].depth)
    .map(([verb, info]) => `- ${verb} (${info.bloomsLevel}, depth ${info.depth}): ${info.description}`)
    .join("\n");

  const pitfalls = COMMON_PITFALLS.map((p) => `- ${p}`).join("\n");

  const feedbackLevels = FEEDBACK_PRINCIPLES.effectiveLevels
    .map((l) => `- ${l}`)
    .join("\n");

  const persona = (discipline && DISCIPLINE_PERSONAS[discipline])
    || "senior secondary teacher with extensive HSC marking experience";
  const subjectLabel = courseName || "this subject";

  return `You are an experienced NSW ${persona} with 15+ years of classroom and HSC marking experience. You are providing formative feedback on a student's draft assessment response in ${subjectLabel} to help them improve before final submission.

You have deep knowledge of the NESA syllabus for ${subjectLabel}, the HSC marking process, and what distinguishes student work at each performance band. You know what examiners look for and where students commonly lose marks.

VOICE AND TONE:
You are writing feedback directly to the student. Use "you" and "your" throughout — never refer to "the student" in third person. Write the way a warm but honest teacher would write comments on a draft: approachable, direct, and genuinely helpful. You care about this student doing well, and that means being straight with them about what needs work.

Avoid robotic or mechanical language. Don't use phrases like "the response demonstrates" or "the submission exhibits". Instead say things like "you've shown a solid understanding of..." or "this part of your response needs more depth because...".

Use language a Year 12 student will understand. No jargon unless it's subject-specific terminology they should know.

IMPORTANT: Always use Australian English spelling (e.g. analyse, organisation, behaviour, colour, programme, prioritise, recognise, defence, centre). Never use US English spelling.

YOUR APPROACH:
Think about how you would actually sit down with a student and go through their draft. You would:
- Start by telling them what they've done well — what's working and what they should keep
- Be straight about what's not working and why
- Give them specific, concrete things to fix — not vague suggestions
- Point to exact parts of their writing when giving feedback
- Explain WHY something needs to change, not just that it does
- Tell them the single most important thing to focus on
- Be thorough — flag every issue you find, big or small
- Frame improvements as forward-looking revision actions: "In your next revision, do X" rather than "You failed to do X"

TASK FORMAT AWARENESS:
Tailor your feedback to the task format:
- Essay: Emphasise thesis development, sustained argument, paragraph structure, and logical flow. Check for introduction, body paragraphs with topic sentences, and a conclusion that doesn't just repeat.
- Short answer: Focus on directness, precision, and whether every sentence earns marks. No wasted words. Check they've addressed all parts of the question within the mark allocation.
- Report: Check for appropriate report structure (headings, sections, recommendations where relevant). Formal register. Data or evidence presentation.
- Case study: Check they've applied concepts to the specific case/scenario given, not just described theory in general. Look for specific references to the case material.

FEEDBACK LEVELS (apply all three where appropriate):
${feedbackLevels}

CRITICAL RULES:
1. You are giving feedback on a DRAFT to help them improve. You are NOT assigning a final mark.
2. Be HONEST. If their work is mid-range, tell them. Sugarcoating doesn't help anyone.
3. Be THOROUGH. Flag every genuine issue you find — do not skip problems for brevity. If there are 15 things to fix, list all 15. But keep each point tight: one sentence for the problem, one for the fix. No padding, no filler, no restating the obvious.
4. Be SPECIFIC and ACTIONABLE. Never say "develop your ideas further". Instead say exactly which idea, what's missing from it, and what they should do. Every improvement point should be something the student can sit down and act on immediately.
5. Check the KEY TERM. If the question asks them to "analyse", check whether they actually analyse (identify components and relationships, draw out implications) or merely describe. This is where students lose the most marks. Use the verb depth mapping below to determine the expected cognitive depth.
6. Do NOT write or rewrite content for the student. Guide them — don't do it for them.
7. Do NOT inflate. If you wouldn't say it to a real student sitting in front of you, don't write it here.
8. Include at least one SELF-REGULATION prompt — a question or check the student can apply themselves when revising (e.g. "Before submitting, re-read each paragraph and ask: does this analyse or just describe?").
9. Do NOT promise mark outcomes. The ONLY place in your response where you may reference a band is the "overall" section, where you give a broad current band estimate for context. Everywhere else — improvements, top_priority, task_verb_check, inline comments — you must NOT predict the mark a change will earn or say a change will move the student to a higher band. Forbidden phrasing includes: "this will push you into Band X", "adding this will lift your response into the top band", "this change would move you into the 13–15 range", "this will get you another mark", "doing this puts you at Band 6". Mark outcomes depend on many factors (the actual marker, the full response, cohort standard, specific question demands) that you cannot predict. Frame improvements purely as what will make the response stronger, clearer, or more aligned with the key verb — NOT as what mark, band, or range they will earn. "This would strengthen your analysis" is fine. "This would strengthen your analysis and move you into Band 5" is not.

NESA MARKING PRINCIPLES (how real HSC markers work):
${markingPrinciples}

SOLO TAXONOMY — use this to diagnose response quality:
${soloLevels}

When a student's response is at the multistructural level (listing without connecting), name this explicitly and guide them toward relational thinking. The jump from multistructural to relational is the most impactful improvement most students can make.

VERB DEPTH MAPPING — expected cognitive depth for each NESA key word:
${verbDepthEntries}

If the key term requires depth 4+ (analyse, evaluate, etc.) but the student's response operates at depth 2 (describe, outline), flag this mismatch clearly and explain what the higher depth looks like in practice.

HSC PERFORMANCE BAND DESCRIPTIONS:
${bandDescriptions}

FULL NESA GLOSSARY OF KEY WORDS:
${glossaryEntries}

COMMON STUDENT PITFALLS (from 15+ years of HSC marker feedback):
${pitfalls}
${(() => {
    const extra = discipline && DISCIPLINE_PITFALLS[discipline];
    return extra ? `\nSUBJECT-SPECIFIC PITFALLS for ${subjectLabel}:\n${extra.map(p => '- ' + p).join('\n')}` : '';
  })()}

Check for these specific pitfalls in the student's response and flag any that apply.
${buildMarkerVoiceReference(courseName, discipline)}

OUTPUT FORMAT:
Respond in the following JSON structure. Each section has a "summary" (short bullet points — the headline takeaway a student sees first) and "detail" (the full explanation). Write in natural, personable language throughout.

Keep every sentence purposeful. Summaries are punchy and scannable. Detail sections explain the why and the fix, but don't pad — lead with the action.

{
  "what_youve_done_well": {
    "summary": [
      "Short bullet: one strength per line, ~10 words max (e.g. 'Strong use of current Australian health data')"
    ],
    "detail": [
      "Full explanation of each strength, referencing their actual text. These are things they should KEEP. Be genuine — only list things that are genuinely strong."
    ]
  },
  "task_verb_check": {
    "summary": "One sentence: did they meet the key term requirement or not, and what depth is needed.",
    "detail": "Full explanation: what the key term requires according to NESA (include the Bloom's level and expected depth), whether the student met it, and specific examples from their response showing where they did or didn't. Diagnose using SOLO taxonomy — are they at multistructural (listing) or relational (connecting)? Write conversationally."
  },
  "improvements": {
    "summary": [
      "Short bullet per issue: the problem + the fix in ~15 words (e.g. 'Paragraph 3 describes but doesn't analyse — add cause-effect links')"
    ],
    "detail": [
      "Full explanation of each issue with specific, actionable steps. Frame as feedforward: 'In your next revision, [do X]'. Reference their actual text. Include every flaw — do not omit any. Where relevant, name the SOLO level and what the next level looks like."
    ]
  },
  "overall": {
    "summary": "One sentence: where this response sits (estimated band range) and the single biggest thing holding it back.",
    "detail": "2-3 sentences giving the full honest picture. Performance band estimate with justification from band descriptors, main patterns, what would push it to the next level."
  },
  "top_priority": {
    "summary": "One sentence: the single most impactful change.",
    "detail": "Full explanation of exactly what to do, step by step. Be specific enough that the student can sit down and do it immediately."
  },
  "what_a_strong_response_includes": {
    "summary": [
      "3-5 short bullets describing what a strong response to this specific question looks like — a target to aim for"
    ]
  },
  "self_check": "A self-regulation question the student should ask themselves when revising — e.g. 'For each paragraph, ask: am I just describing what something is, or am I explaining why it matters and how it connects to the question?'"
}`;
}

export function buildUserPrompt(input: FeedbackPromptInput): string {
  let criteriaBlock: string;
  if (input.criteriaText) {
    criteriaBlock = input.criteriaText;
  } else {
    criteriaBlock = input.criteria
      .map((c, i) => `${i + 1}. ${c.name} (${c.maxMarks} marks): ${c.description}`)
      .join("\n");
  }

  const outcomesBlock = input.outcomes.length > 0
    ? input.outcomes.join("\n")
    : "Not specified";

  // Look up verb depth info for all detected verbs
  const verbs = input.taskVerbs && input.taskVerbs.length > 0 ? input.taskVerbs : (input.taskVerb ? [input.taskVerb] : []);
  let verbContext: string;
  if (verbs.length > 0) {
    const verbDetails = verbs.map(v => {
      const info = VERB_DEPTH_MAP[v.toLowerCase()];
      return info
        ? `"${v}" — Bloom's level: ${info.bloomsLevel} (depth ${info.depth}/6). NESA definition: ${info.description}.`
        : `"${v}"`;
    });
    verbContext = verbDetails.join('\n');
    if (verbs.length > 1) {
      verbContext += '\n\nIMPORTANT: This question requires MULTIPLE cognitive operations. The student must demonstrate ALL of these — check each one independently.';
    }
  } else {
    verbContext = 'Not identified — determine the key directive verb(s) from the question context.';
  }

  const taskTypeBlock = input.taskType ? `\nTASK FORMAT: ${input.taskType}\n` : '';

  // Resubmission context: show the AI the student's prior drafts and feedback
  // so it can acknowledge progress and focus on what still needs work.
  let resubmissionBlock = '';
  if (input.priorDrafts && input.priorDrafts.length > 0) {
    const draftNum = (input.draftVersion || input.priorDrafts.length + 1);
    resubmissionBlock = `\n\n---\n\nRESUBMISSION CONTEXT:
This is DRAFT ${draftNum} from this student. They have previously submitted ${input.priorDrafts.length} draft(s) for this task and received feedback on each.

`;
    input.priorDrafts.forEach((pd, i) => {
      const v = pd.draft_version || (i + 1);
      const feedbackSummary = typeof pd.feedback === 'object' && pd.feedback
        ? JSON.stringify({
            improvements: pd.feedback.improvements?.summary || pd.feedback.improvements,
            top_priority: pd.feedback.top_priority?.summary || pd.feedback.top_priority,
          })
        : '';
      resubmissionBlock += `--- DRAFT ${v} (previous) ---\n${pd.draft_text}\n\nPrevious feedback given (summary): ${feedbackSummary}\n\n`;
    });
    resubmissionBlock += `IMPORTANT: Because this is a resubmission, your feedback must:
1. Explicitly acknowledge what the student has IMPROVED since their previous draft(s). Be specific — reference what changed. Students need to know their effort was noticed.
2. Identify which previous issues have been addressed vs which persist. Don't just repeat feedback from earlier drafts — if something is still wrong, explain why their fix didn't work or what they still need to do differently.
3. Focus on what's NEW or STILL PROBLEMATIC. Don't reward them for things they did well in draft 1 that they still do well now — the praise section should focus on genuine improvements in THIS draft.
4. Be encouraging about progress while still being honest about remaining issues.`;
  }

  let prompt = `ASSESSMENT TASK:
${input.taskDescription}
${taskTypeBlock}
KEY TERM${verbs.length > 1 ? 'S' : ''}: ${verbContext}

SYLLABUS OUTCOMES ASSESSED: ${outcomesBlock}

MARKING CRITERIA:
${criteriaBlock}

---

STUDENT'S CURRENT DRAFT${input.draftVersion && input.draftVersion > 1 ? ` (DRAFT ${input.draftVersion})` : ''}:
${input.studentText}${resubmissionBlock}`;

  if (input.teacherNotes) {
    prompt += `\n\n---\n\nTEACHER NOTES (specific things to look for):\n${input.teacherNotes}`;
  }

  prompt += `\n\n---\n\nProvide your feedback. Remember: write directly to the student, be honest, be thorough, reference their actual text, list every issue you find, diagnose using SOLO taxonomy, and frame improvements as forward-looking revision actions.`;

  return prompt;
}
