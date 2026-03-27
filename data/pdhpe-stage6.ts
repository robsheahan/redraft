/**
 * NESA PDHPE Stage 6 Reference Data
 * Source: PDHPE Stage 6 Syllabus (2012)
 * https://www.nsw.gov.au/education-and-training/nesa/curriculum/pdhpe/pdhpe-stage-6-2012
 *
 * NOTE: PDHPE Stage 6 is being replaced by Health and Movement Science 11-12
 * from the 2026 HSC onwards. This data covers the 2012 syllabus (last HSC exam 2025).
 */

export const COURSE = {
  code: "15320",
  name: "Personal Development, Health and Physical Education",
  shortName: "PDHPE",
  stage: "Stage 6",
  units: 2,
  hasHscExam: true,
} as const;

// HSC Course Outcomes
export const OUTCOMES = [
  { code: "H1", description: "describes the nature and justifies the choice of Australia's health priorities" },
  { code: "H2", description: "analyses and explains the health status of Australians in terms of current trends and groups most at risk" },
  { code: "H3", description: "analyses the determinants of health and health inequities" },
  { code: "H4", description: "argues the case for health promotion based on the Ottawa Charter" },
  { code: "H5", description: "explains the different roles and responsibilities of individuals, communities and governments in addressing Australia's health priorities" },
  { code: "H6", description: "demonstrates a range of personal health skills that enables them to promote and maintain health" },
  { code: "H7", description: "explains the relationship between physiology and movement potential" },
  { code: "H8", description: "explains how a variety of training approaches and other interventions enhance performance and safety in physical activity" },
  { code: "H9", description: "explains how movement skill is acquired and appraised" },
  { code: "H10", description: "designs and implements training plans to improve performance" },
  { code: "H11", description: "designs psychological strategies and nutritional plans in response to individual performance needs" },
  { code: "H12", description: "analyses the influence of sociocultural factors on the way people participate in and value physical activity and sport" },
  { code: "H13", description: "selects and applies strategies for the management of injuries and the promotion of safety in sport and physical activity" },
  { code: "H14", description: "argues the benefits of health-promoting actions and choices that promote social justice" },
  { code: "H15", description: "critically analyses key issues affecting the health of Australians and proposes ways of working towards better health for all" },
  { code: "H16", description: "devises methods of gathering, interpreting and communicating information about health and physical activity concepts" },
  { code: "H17", description: "selects appropriate options and formulates strategies based on a critical analysis of the factors that affect performance and safe participation" },
] as const;

// Module-to-outcome mapping
export const MODULES = {
  core: [
    {
      name: "Core 1: Health Priorities in Australia",
      weight: 30,
      outcomes: ["H1", "H2", "H3", "H4", "H5", "H14", "H15", "H16"],
      focusQuestions: [
        "How are priority issues for Australia's health identified?",
        "What are the priority issues for improving Australia's health?",
        "What role do health care facilities and services play in achieving better health for all Australians?",
        "What actions are needed to address Australia's health priorities?",
      ],
    },
    {
      name: "Core 2: Factors Affecting Performance",
      weight: 30,
      outcomes: ["H7", "H8", "H9", "H10", "H11", "H16", "H17"],
      focusQuestions: [
        "How does training affect performance?",
        "How can psychology affect performance?",
        "How can nutrition and recovery strategies affect performance?",
        "How does the acquisition of skill affect performance?",
      ],
    },
  ],
  options: [
    { name: "Option 1: The Health of Young People", weight: 20, outcomes: ["H2", "H5", "H6", "H15", "H16"] },
    { name: "Option 2: Sport and Physical Activity in Australian Society", weight: 20, outcomes: ["H12", "H16"] },
    { name: "Option 3: Sports Medicine", weight: 20, outcomes: ["H8", "H13", "H16", "H17"] },
    { name: "Option 4: Improving Performance", weight: 20, outcomes: ["H8", "H10", "H16", "H17"] },
    { name: "Option 5: Equity and Health", weight: 20, outcomes: ["H3", "H5", "H14", "H15", "H16"] },
  ],
} as const;

// HSC Performance Band Descriptions
export const PERFORMANCE_BANDS = [
  {
    band: 6,
    markRange: "90-100",
    description:
      "Demonstrates extensive knowledge and understanding of the range of concepts related to health and physical performance. Comprehensively applies theoretical principles to design and evaluate specific strategies for improving health, participation and performance. Demonstrates a superior understanding of the interrelated roles and responsibilities of individuals, groups and governments in the management and promotion of health. Critically analyses movement and the range of factors that affect physical performance and participation. Provides relevant and accurate examples to justify complex arguments about health, participation and performance.",
  },
  {
    band: 5,
    markRange: "80-89",
    description:
      "Clearly expresses ideas that demonstrate a thorough understanding of health and physical performance concepts. Identifies strategies for improving health, participation and performance and discusses the links between individual health behaviour, social issues and community health status. Demonstrates detailed understanding of the roles of individuals, groups and governments in health promotion. Supports particular arguments thoroughly by using relevant examples and current information.",
  },
  {
    band: 4,
    markRange: "70-79",
    description:
      "Demonstrates a clear understanding of the broad concepts that relate to personal health and physical performance. Relates strategies for managing the major causes of sickness and death to the contributing risk factors. Understands the roles of various stakeholders in health promotion. Describes factors that affect the quality of physical performance. Communicates information in a clear and logical way providing some examples about health, participation and performance.",
  },
  {
    band: 3,
    markRange: "60-69",
    description:
      "Uses basic definitions and facts when explaining health and physical performance concepts. Identifies the major causes of sickness and death and understands that a healthy lifestyle is a desirable goal. Recognises the need for government action in health promotion. Identifies some factors that influence performance. Provides basic support for the arguments presented on health, participation and performance.",
  },
  {
    band: 2,
    markRange: "50-59",
    description:
      "Recalls some simple facts and writes brief descriptions. Demonstrates an understanding of elementary terms and recognises simple cause and effect relationships. Outlines some factors that affect health. Identifies some measures for preventing injuries. Understands general principles of movement. Provides limited support for the arguments presented.",
  },
  {
    band: 1,
    markRange: "0-49",
    description: "The minimum standard expected was not demonstrated.",
  },
] as const;

// NESA Glossary — key words most relevant to PDHPE assessment
export const GLOSSARY = {
  analyse: "Identify components and the relationship between them; draw out and relate implications.",
  assess: "Make a judgement of value, quality, outcomes, results or size.",
  compare: "Show how things are similar or different.",
  contrast: "Show how things are different or opposite.",
  critically_analyse: "Use interpretation and reasoning to assess a range of evidence and make judgements based on detailed analysis.",
  critically_evaluate: "Add a degree or level of accuracy, knowledge and understanding, logic, questioning, reflection and quality to evaluate.",
  describe: "Provide characteristics and features.",
  discuss: "Identify issues and provide points for and/or against.",
  distinguish: "Recognise or note/point out as being distinct or different from; to note differences between.",
  evaluate: "Make a judgement based on criteria; determine the value of.",
  examine: "Inquire into.",
  explain: "Relate cause and effect; make the relationships between things evident; provide why and/or how.",
  identify: "Recognise and name.",
  justify: "Support an argument or conclusion.",
  outline: "Sketch in general terms; indicate the main features of.",
  propose: "Put forward (a point of view, idea, argument, suggestion) for consideration or action.",
} as const;

// Assessment component weightings (mandatory from Term 4, 2018)
export const ASSESSMENT_COMPONENTS = [
  { component: "Knowledge and understanding of course content", weight: 40 },
  { component: "Skills in critical thinking, research, analysis and communicating", weight: 60 },
] as const;
