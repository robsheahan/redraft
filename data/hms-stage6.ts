/**
 * NESA Health and Movement Science Stage 6 Reference Data
 * Source: Health and Movement Science 11-12 Syllabus (2023)
 * https://curriculum.nsw.edu.au/learning-areas/pdhpe/health-and-movement-science-11-12-2023
 *
 * First HSC examination: 2026
 * Replaces PDHPE Stage 6 (2012 syllabus, last HSC exam 2025)
 */

export const COURSE = {
  code: "15400",
  name: "Health and Movement Science",
  shortName: "HMS",
  stage: "Stage 6",
  units: 2,
  hasHscExam: true,
  examDuration: "3 hours + 10 minutes reading time",
  examMarks: 100,
} as const;

// ── HSC Course Outcomes (Year 12) ──────────────────────────────────────

export const OUTCOMES = {
  knowledge: [
    { code: "HM-12-01", description: "analyses the health status of Australians at a national and international level" },
    { code: "HM-12-02", description: "examines how technology and data can achieve better health for all Australians" },
    { code: "HM-12-03", description: "evaluates how the Sustainable Development Goals can be used to improve the health of a community" },
    { code: "HM-12-04", description: "investigates factors that impact movement and performance" },
    { code: "HM-12-05", description: "analyses individual and group training programs to improve performance" },
  ],
  skills: [
    { code: "HM-12-06", skill: "Analysis", description: "critically analyses the relationships and implications of health and movement concepts" },
    { code: "HM-12-07", skill: "Communication", description: "communicates health and movement concepts using modes appropriate to a range of audiences and contexts" },
    { code: "HM-12-08", skill: "Creative thinking", description: "generates and assesses new ideas that are meaningful and relevant to health and movement contexts" },
    { code: "HM-12-09", skill: "Problem-solving", description: "proposes and evaluates solutions to complex health and movement issues" },
    { code: "HM-12-10", skill: "Research", description: "analyses a range of sources to make conclusions and judgements about health and movement concepts" },
  ],
} as const;

// ── Year 12 Focus Areas and Topics ─────────────────────────────────────

export const FOCUS_AREAS = [
  {
    name: "Health in an Australian and Global Context",
    hours: 45,
    outcomes: ["HM-12-01", "HM-12-02", "HM-12-03"],
    topics: [
      "How healthy are Australians?",
      "How does Australia's healthcare system work towards achieving better health?",
      "How is technology impacting Australia's healthcare?",
      "What actions promote Australian health?",
    ],
  },
  {
    name: "Training for Improved Performance",
    hours: 45,
    outcomes: ["HM-12-04", "HM-12-05"],
    topics: [
      "Exercise assessment and prescription personalisation",
      "Training influence on movement and performance",
      "Individual vs group sports training",
      "Sleep, nutrition and supplementation",
      "Sustained movement and performance training",
    ],
  },
] as const;

// ── HSC Examination Structure ──────────────────────────────────────────

export const EXAM_STRUCTURE = [
  { section: "Section I", marks: 20, format: "Objective response (multiple choice)" },
  { section: "Section II", marks: 56, format: "Short-answer questions; may contain parts; 9-12 items; at least 3 items worth 6-8 marks" },
  { section: "Section III", marks: 24, format: "2 extended-response questions (12 marks each) — one per focus area" },
] as const;

// ── HSC Performance Band Descriptions ──────────────────────────────────

export const PERFORMANCE_BANDS = [
  {
    band: 6,
    markRange: "90-100",
    description:
      "Demonstrates extensive knowledge and understanding of health and movement science concepts. Applies extensive knowledge, understanding and skills effectively to familiar and unfamiliar issues and scenarios. Analyses and evaluates theoretical principles to improve health, movement participation and performance. Generates and evaluates ideas about, and solutions for, complex health and movement issues and scenarios. Critically analyses information from a range of relevant sources to make judgements about health and movement science concepts. Communicates logically and effectively using appropriate health and movement science concepts and terms for a range of audiences and contexts.",
  },
  {
    band: 5,
    markRange: "80-89",
    description:
      "Demonstrates thorough knowledge and understanding of health and movement science concepts. Applies thorough knowledge, understanding and skills to familiar and unfamiliar issues and scenarios. Analyses theoretical principles to improve health, movement participation and performance. Generates and explains ideas about, and solutions for, complex health and movement issues and scenarios. Explains information from a range of relevant sources to make judgements about health and movement science concepts. Communicates logically and clearly using appropriate health and movement science concepts and terms for a range of audiences and contexts.",
  },
  {
    band: 4,
    markRange: "70-79",
    description:
      "Demonstrates sound knowledge and understanding of health and movement science concepts. Applies sound knowledge, understanding and skills to familiar issues and scenarios. Explains theoretical principles to improve health, movement participation and performance. Generates and describes ideas about, and solutions for, health and movement issues and/or scenarios. Uses information from relevant sources to describe health and movement science concepts. Communicates clearly using relevant health and movement science concepts and terms.",
  },
  {
    band: 3,
    markRange: "60-69",
    description:
      "Demonstrates basic knowledge and understanding of health and movement science concepts. Applies basic knowledge, understanding and/or skills to familiar issues and scenarios. Describes principles to improve health, movement participation and performance. Describes ideas about health and movement issues and/or scenarios. Uses information from sources to outline health and movement science concepts. Communicates using basic health and movement science concepts and/or terms.",
  },
  {
    band: 2,
    markRange: "50-59",
    description:
      "Demonstrates limited knowledge and understanding of health and/or movement science concepts. Applies limited knowledge, understanding and/or skills to issues and/or scenarios. Outlines principles for health and/or movement participation and/or performance. Identifies ideas about health and/or movement issues and/or scenarios. Uses information from sources to identify health and/or movement science concepts. Communicates with limited use of health and/or movement science terms.",
  },
  {
    band: 1,
    markRange: "0-49",
    description: "The minimum standard expected was not demonstrated.",
  },
] as const;

// ── Assessment Component Weightings ────────────────────────────────────

export const ASSESSMENT_COMPONENTS = [
  { component: "Knowledge and understanding of course content", weight: 40 },
  { component: "Skills in analysis, communication, creative thinking, problem-solving and research", weight: 60 },
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
// Used for diagnosing response quality and guiding students to the next level

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
  explain: { bloomsLevel: "Understand/Analyse", depth: 3, description: "Relate cause and effect; provide why and/or how" },
  compare: { bloomsLevel: "Analyse", depth: 4, description: "Show how things are similar or different" },
  contrast: { bloomsLevel: "Analyse", depth: 4, description: "Show how things are different or opposite" },
  analyse: { bloomsLevel: "Analyse", depth: 4, description: "Identify components and relationships; draw out implications" },
  discuss: { bloomsLevel: "Analyse/Evaluate", depth: 4, description: "Identify issues and provide points for and/or against" },
  distinguish: { bloomsLevel: "Analyse", depth: 4, description: "Recognise or note distinct differences" },
  assess: { bloomsLevel: "Evaluate", depth: 5, description: "Make a judgement of value, quality, outcomes or results" },
  evaluate: { bloomsLevel: "Evaluate", depth: 5, description: "Make a judgement based on criteria; determine value" },
  justify: { bloomsLevel: "Evaluate", depth: 5, description: "Support an argument or conclusion" },
  "critically analyse": { bloomsLevel: "Evaluate", depth: 5, description: "Assess evidence and make judgements based on detailed analysis" },
  "critically evaluate": { bloomsLevel: "Evaluate", depth: 5, description: "Adds accuracy, logic, questioning and reflection to evaluation" },
  propose: { bloomsLevel: "Create", depth: 6, description: "Put forward ideas or suggestions for consideration" },
  synthesise: { bloomsLevel: "Create", depth: 6, description: "Put together various elements to make a whole" },
};

// ── Common Student Pitfalls ────────────────────────────────────────────
// Compiled from HSC marker feedback (Notes from the Marking Centre 2009-2025)

export const COMMON_PITFALLS = [
  // Response depth errors
  "Describing when asked to analyse — listing information without exploring relationships, causes, or implications.",
  "Outlining when asked to evaluate — failing to make a judgement based on criteria.",
  "Making a judgement only in the conclusion instead of sustaining it throughout the response.",
  "Writing generic statements that could apply to any health or movement topic — not specific to the question.",

  // Content errors
  "Confusing related concepts: e.g. anxiety vs arousal, determinants vs risk factors, morbidity vs mortality, prevalence vs incidence.",
  "Listing the Ottawa Charter action areas or SDGs abstractly without connecting them to specific, concrete examples.",
  "Not using specific, current Australian data, statistics, or examples to support arguments.",
  "Providing one-sided responses when the question requires balanced discussion (e.g. advantages AND disadvantages).",
  "Confusing types of training (aerobic vs anaerobic) or principles of training with methods of training.",

  // Structure and communication
  "Not addressing all parts of a multi-part question — missing sub-questions or only partially answering.",
  "Poor paragraph structure that makes the argument hard to follow — no logical sequencing.",
  "Listing dot points instead of writing in sustained prose for extended-response questions.",
  "Not linking back to the syllabus focus area or relevant theoretical framework.",

  // Exam technique
  "Spending too long on low-mark questions and not enough on high-mark extended responses.",
  "Not reading the question carefully — answering a different question than what was asked.",
  "Using colloquial language instead of health and movement science terminology.",
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
