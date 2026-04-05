/**
 * Cross-subject NESA Reference Data for Stage 6 Feedback
 *
 * These standards apply across ALL NESA subjects:
 * - Glossary of Key Words
 * - Marking Principles
 * - SOLO Taxonomy
 * - Bloom's Verb Depth Mapping
 * - Common Student Pitfalls (cross-subject)
 * - Performance Band Descriptors (generic 6-band scale)
 * - Feedback Framework Principles
 */

// ── HSC Performance Band Descriptions (generic) ─────────────────────────

export const PERFORMANCE_BANDS = [
  {
    band: 6,
    markRange: "90-100",
    description:
      "Demonstrates extensive knowledge and understanding of course concepts. Applies knowledge, understanding and skills effectively to familiar and unfamiliar contexts. Analyses and evaluates with depth and sophistication. Generates and evaluates ideas and solutions for complex issues. Critically analyses information from a range of relevant sources to make well-supported judgements. Communicates logically and effectively using appropriate subject-specific terminology.",
  },
  {
    band: 5,
    markRange: "80-89",
    description:
      "Demonstrates thorough knowledge and understanding of course concepts. Applies knowledge, understanding and skills to familiar and unfamiliar contexts. Analyses and explains with clarity and depth. Generates and explains ideas and solutions for complex issues. Explains information from relevant sources to make judgements. Communicates logically and clearly using appropriate subject-specific terminology.",
  },
  {
    band: 4,
    markRange: "70-79",
    description:
      "Demonstrates sound knowledge and understanding of course concepts. Applies knowledge, understanding and skills to familiar contexts. Explains key principles and concepts with reasonable depth. Generates and describes ideas and solutions for issues. Uses information from relevant sources to describe concepts. Communicates clearly using relevant subject-specific terminology.",
  },
  {
    band: 3,
    markRange: "60-69",
    description:
      "Demonstrates basic knowledge and understanding of course concepts. Applies basic knowledge and skills to familiar contexts. Describes principles and concepts at a surface level. Describes ideas about issues. Uses information from sources to outline concepts. Communicates using basic subject-specific terminology.",
  },
  {
    band: 2,
    markRange: "50-59",
    description:
      "Demonstrates limited knowledge and understanding of course concepts. Applies limited knowledge and skills to familiar contexts. Outlines some principles or concepts. Identifies basic ideas. Uses information from sources to identify concepts. Communicates with limited use of subject-specific terminology.",
  },
  {
    band: 1,
    markRange: "0-49",
    description: "The minimum standard expected was not demonstrated.",
  },
] as const;

// ── Full NESA Glossary of Key Words ────────────────────────────────────
// Source: https://www.nsw.gov.au/education-and-training/nesa/hsc/student-guide/glossary

export const GLOSSARY: Record<string, string> = {
  "account for": "State reasons for, report on.",
  analyse: "Identify components and the relationship between them; draw out and relate implications.",
  apply: "Use, utilise, employ in a particular situation.",
  appreciate: "Make a judgement about the value of.",
  assess: "Make a judgement of value, quality, outcomes, results or size.",
  calculate: "Ascertain/determine from given facts, figures or information.",
  clarify: "Make clear or plain.",
  classify: "Arrange or include in classes/categories.",
  compare: "Show how things are similar or different.",
  construct: "Make; build; put together items or arguments.",
  contrast: "Show how things are different or opposite.",
  "critically analyse": "Use interpretation and reasoning to assess a range of evidence and make judgements based on detailed analysis.",
  "critically evaluate": "Add a degree or level of accuracy, knowledge and understanding, logic, questioning, reflection and quality to evaluate.",
  deduce: "Draw conclusions.",
  define: "State meaning and identify essential qualities.",
  demonstrate: "Show by example.",
  describe: "Provide characteristics and features.",
  discuss: "Identify issues and provide points for and/or against.",
  distinguish: "Recognise or note/point out as being distinct or different from; to note differences between.",
  evaluate: "Make a judgement based on criteria; determine the value of.",
  examine: "Inquire into.",
  explain: "Relate cause and effect; make the relationships between things evident; provide why and/or how.",
  extract: "Choose relevant and/or appropriate details.",
  extrapolate: "Infer from what is known.",
  identify: "Recognise and name.",
  interpret: "Draw meaning from.",
  investigate: "Plan, inquire into and draw conclusions about.",
  justify: "Support an argument or conclusion.",
  outline: "Sketch in general terms; indicate the main features of.",
  predict: "Suggest what may happen based on available information.",
  propose: "Put forward (a point of view, idea, argument, suggestion) for consideration or action.",
  recall: "Present remembered ideas, facts or experiences.",
  recommend: "Provide reasons in favour.",
  recount: "Retell a series of events.",
  summarise: "Express, concisely, the relevant details.",
  synthesise: "Putting together various elements to make a whole.",
};

// ── NESA Marking Principles ────────────────────────────────────────────
// Source: https://www.nsw.gov.au/education-and-training/nesa/hsc/exams-and-marking/marking-guideline-principles

export const MARKING_PRINCIPLES = [
  "Marks are awarded for demonstrating achievement of syllabus outcomes addressed by the question.",
  "Guidelines indicate the quality of response required for a mark or sub-range of marks.",
  "High achievement is not defined solely in terms of the quantity of information provided.",
  "For higher-order outcome questions, more marks are awarded for demonstrating higher-order outcomes.",
  "Marking guidelines accommodate varied student achievement and allow for unusual approaches, originality, and creative thinking.",
  "Language in guidelines must be clear, unambiguous and accessible to ensure consistency.",
] as const;

// ── SOLO Taxonomy Levels ───────────────────────────────────────────────

export const SOLO_LEVELS = [
  {
    level: "Prestructural",
    description: "The student misses the point or provides irrelevant information. The task is not meaningfully engaged with.",
    studentAction: "Re-read the question and identify what it is actually asking.",
  },
  {
    level: "Unistructural",
    description: "The response focuses on one relevant aspect only. Surface-level understanding.",
    verbs: ["identify", "name", "define", "recall"],
    studentAction: "You've identified one relevant point — now broaden your response to address the full scope of the question.",
  },
  {
    level: "Multistructural",
    description: "The response addresses several relevant aspects but treats them as an unconnected list. Quantitative increase, not qualitative.",
    verbs: ["describe", "list", "outline", "classify"],
    studentAction: "You've covered multiple relevant points, but they're sitting side by side without connections. Show how these ideas relate to each other and to the question.",
  },
  {
    level: "Relational",
    description: "The aspects are integrated into a coherent whole. The student shows how ideas connect, explains cause-effect, and demonstrates genuine understanding.",
    verbs: ["explain", "compare", "contrast", "analyse", "apply", "justify"],
    studentAction: "You're connecting ideas and building a coherent argument. To push further, consider broader implications or evaluate the relative importance of different factors.",
  },
  {
    level: "Extended Abstract",
    description: "The student generalises beyond the immediate context, applies knowledge to novel situations, theorises, or reflects critically.",
    verbs: ["evaluate", "critically analyse", "critically evaluate", "synthesise", "propose"],
    studentAction: "You're working at the highest level — transferring understanding to new contexts and making evaluative judgements.",
  },
] as const;

// ── Bloom's Taxonomy / NESA Verb Depth Mapping ────────────────────────

export const VERB_DEPTH_MAP: Record<string, { bloomsLevel: string; depth: number; description: string }> = {
  recall: { bloomsLevel: "Remember", depth: 1, description: "Present remembered ideas, facts or experiences" },
  identify: { bloomsLevel: "Remember", depth: 1, description: "Recognise and name" },
  define: { bloomsLevel: "Remember/Understand", depth: 1, description: "State meaning and identify essential qualities" },
  outline: { bloomsLevel: "Understand", depth: 2, description: "Sketch in general terms; indicate main features" },
  describe: { bloomsLevel: "Understand", depth: 2, description: "Provide characteristics and features" },
  summarise: { bloomsLevel: "Understand", depth: 2, description: "Express concisely the relevant details" },
  clarify: { bloomsLevel: "Understand", depth: 2, description: "Make clear or plain" },
  extract: { bloomsLevel: "Understand", depth: 2, description: "Choose relevant and/or appropriate details" },
  recount: { bloomsLevel: "Understand", depth: 2, description: "Retell a series of events" },
  calculate: { bloomsLevel: "Apply", depth: 2, description: "Ascertain/determine from given facts, figures or information" },
  explain: { bloomsLevel: "Understand/Analyse", depth: 3, description: "Relate cause and effect; provide why and/or how" },
  apply: { bloomsLevel: "Apply", depth: 3, description: "Use, utilise, employ in a particular situation" },
  demonstrate: { bloomsLevel: "Apply", depth: 3, description: "Show by example" },
  "account for": { bloomsLevel: "Understand", depth: 3, description: "State reasons for, report on" },
  classify: { bloomsLevel: "Analyse", depth: 3, description: "Arrange or include in classes/categories" },
  compare: { bloomsLevel: "Analyse", depth: 4, description: "Show how things are similar or different" },
  contrast: { bloomsLevel: "Analyse", depth: 4, description: "Show how things are different or opposite" },
  analyse: { bloomsLevel: "Analyse", depth: 4, description: "Identify components and relationships; draw out implications" },
  discuss: { bloomsLevel: "Analyse/Evaluate", depth: 4, description: "Identify issues and provide points for and/or against" },
  distinguish: { bloomsLevel: "Analyse", depth: 4, description: "Recognise or note distinct differences" },
  deduce: { bloomsLevel: "Analyse", depth: 4, description: "Draw conclusions" },
  examine: { bloomsLevel: "Analyse", depth: 4, description: "Inquire into" },
  extrapolate: { bloomsLevel: "Analyse", depth: 4, description: "Infer from what is known" },
  interpret: { bloomsLevel: "Analyse", depth: 4, description: "Draw meaning from" },
  assess: { bloomsLevel: "Evaluate", depth: 5, description: "Make a judgement of value, quality, outcomes or results" },
  evaluate: { bloomsLevel: "Evaluate", depth: 5, description: "Make a judgement based on criteria; determine value" },
  justify: { bloomsLevel: "Evaluate", depth: 5, description: "Support an argument or conclusion" },
  "critically analyse": { bloomsLevel: "Evaluate", depth: 5, description: "Assess evidence and make judgements based on detailed analysis" },
  "critically evaluate": { bloomsLevel: "Evaluate", depth: 5, description: "Adds accuracy, logic, questioning and reflection to evaluation" },
  appreciate: { bloomsLevel: "Evaluate", depth: 5, description: "Make a judgement about the value of" },
  predict: { bloomsLevel: "Evaluate", depth: 5, description: "Suggest what may happen based on available information" },
  recommend: { bloomsLevel: "Evaluate", depth: 5, description: "Provide reasons in favour" },
  investigate: { bloomsLevel: "Analyse/Create", depth: 5, description: "Plan, inquire into and draw conclusions about" },
  propose: { bloomsLevel: "Create", depth: 6, description: "Put forward ideas or suggestions for consideration" },
  synthesise: { bloomsLevel: "Create", depth: 6, description: "Put together various elements to make a whole" },
  construct: { bloomsLevel: "Create", depth: 6, description: "Make; build; put together items or arguments" },
};

// ── Common Student Pitfalls (cross-subject) ──────────────────────────────
// Compiled from HSC marker feedback across subjects (Notes from the Marking Centre)

export const COMMON_PITFALLS = [
  // Response depth errors
  "Describing when asked to analyse — listing information without exploring relationships, causes, or implications.",
  "Outlining when asked to evaluate — failing to make a judgement based on criteria.",
  "Making a judgement only in the conclusion instead of sustaining it throughout the response.",
  "Writing generic statements that could apply to any topic — not specific to the question asked.",

  // Content and evidence
  "Not using specific examples, data, or evidence to support arguments — relying on vague generalisations.",
  "Providing one-sided responses when the question requires balanced discussion (e.g. advantages AND disadvantages).",
  "Restating information from the stimulus or source material without adding analysis or interpretation.",

  // Structure and communication
  "Not addressing all parts of a multi-part question — missing sub-questions or only partially answering.",
  "Poor paragraph structure that makes the argument hard to follow — no logical sequencing.",
  "Listing dot points instead of writing in sustained prose for extended-response questions.",
  "Not linking back to the question or relevant syllabus concepts throughout the response.",

  // Exam technique
  "Not reading the question carefully — answering a different question than what was asked.",
  "Using colloquial language instead of appropriate subject-specific terminology.",
  "Repeating the same point in different words instead of introducing new evidence or arguments.",
] as const;

// ── Feedback Framework Principles ──────────────────────────────────────
// Based on Hattie & Timperley (2007), Wiliam (2011), SOLO Taxonomy

export const FEEDBACK_PRINCIPLES = {
  threeQuestions: [
    "Where am I going? (Feed Up) — clarity about the learning goal and success criteria",
    "How am I going? (Feed Back) — how current performance relates to the goal",
    "Where to next? (Feed Forward) — concrete actions to close the gap",
  ],
  effectiveLevels: [
    "Task level: correctness, surface features, specific errors (most useful for novice responses)",
    "Process level: strategies and reasoning used, argument structure, depth of analysis (most useful for developing responses)",
    "Self-regulation level: metacognitive prompts that build independent assessment skills (most useful for strong responses)",
  ],
  keyPrinciples: [
    "Good feedback causes thinking — if it doesn't make the student think, it hasn't worked.",
    "Feedback on the person (praise, grades, comparisons) is counterproductive. Focus on the work.",
    "Feedback that disconfirms (challenges misconceptions) drives more learning than feedback that merely confirms.",
    "The goal is to build independent self-assessment, not create dependency on external correction.",
    "Frame improvements as forward-looking revision actions, not backward-looking diagnoses.",
  ],
} as const;
