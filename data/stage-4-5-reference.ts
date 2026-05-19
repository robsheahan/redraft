/**
 * Stage 4 and Stage 5 reference data per discipline.
 *
 * Sources: NSW NESA Stage 4 and Stage 5 syllabuses, ACARA Australian Curriculum
 * achievement standards (Y7-Y10), and NESA's published A-E common grade scale
 * applied to the major Key Learning Areas. Descriptors are curated against
 * NESA's standards-referenced reporting framework — they are reference
 * material for the feedback engine, not material for students to read.
 *
 * For each (discipline, stage) we provide:
 *   - a_b_c_d_e_descriptors: subject-specific descriptors of what an A vs B vs
 *     C vs D vs E response looks like at the end of that stage.
 *   - common_pitfalls: high-frequency stage-specific student errors.
 *
 * This file does NOT contain annotated work samples — those come from
 * NESA's per-subject scrape (see scripts/scrape-stage-4-5-feedback.ts).
 */

export interface SubjectStageDescriptor {
  grade: 'A' | 'B' | 'C' | 'D' | 'E';
  description: string;
}

export interface SubjectStageReference {
  discipline: string;  // "English" | "Mathematics" | "Science" | "HSIE" | "PDHPE" | ...
  stage: 4 | 5;
  descriptors: SubjectStageDescriptor[];
  commonPitfalls: string[];
}

export const STAGE_4_5_REFERENCES: SubjectStageReference[] = [
  // ── English Stage 4 ──────────────────────────────────────────────────
  {
    discipline: 'English',
    stage: 4,
    descriptors: [
      { grade: 'A', description: 'Identifies and explains how composers use language and structure to create meaning. Sustains a clear, well-paragraphed response with a topic sentence and supporting evidence in each paragraph. Uses literary terminology accurately (theme, character, setting, imagery, simile, metaphor) and integrates short quotations purposefully.' },
      { grade: 'B', description: 'Describes how composers use language to create meaning and explains the effect of specific techniques. Writes in clear paragraphs with topic sentences and supporting evidence. Uses literary terminology with mostly accurate application. Quotations are present and relevant if not always tightly woven.' },
      { grade: 'C', description: 'Identifies techniques used by composers and describes their effect at a general level. Constructs paragraphs with a clear focus, though development may be uneven. Uses some literary terminology, occasionally inaccurately. Includes evidence but may rely on retell.' },
      { grade: 'D', description: 'Identifies basic features of a text but struggles to explain effect. Paragraph structure is inconsistent. Limited or inaccurate use of literary terminology. Retells rather than analyses.' },
      { grade: 'E', description: 'Demonstrates elementary engagement with the text. Responses lack paragraph structure and offer little more than surface description.' },
    ],
    commonPitfalls: [
      'Retelling the plot or character actions instead of explaining how the composer constructs meaning.',
      'Naming a technique ("simile", "metaphor") without explaining the effect on the reader.',
      'Quotations dropped in without integration or commentary.',
      'Using "the author" inconsistently when "composer" / "the text" is more precise.',
      'Confusing theme (idea) with topic (subject matter) — e.g. "the theme is friendship" rather than "friendship is presented as conditional".',
      'Writing in paragraphs that lack a clear topic sentence linking the paragraph to the question.',
    ],
  },

  // ── English Stage 5 ──────────────────────────────────────────────────
  {
    discipline: 'English',
    stage: 5,
    descriptors: [
      { grade: 'A', description: 'Analyses how composers shape meaning through language, form and structure, beginning to evaluate the impact on responders. Sustains a clear interpretive argument across paragraphs with sophisticated topic sentences. Integrates well-chosen quotations and weaves textual evidence into argument. Uses literary terminology with precision; begins to consider context, audience and purpose.' },
      { grade: 'B', description: 'Explains and begins to analyse how language and structural choices construct meaning. Maintains a clear thesis with topic sentences that connect each paragraph to the argument. Uses textual evidence purposefully. Literary terminology used accurately; some engagement with context.' },
      { grade: 'C', description: 'Describes how composers create meaning, with some explanation of effect. Constructs paragraphs around a central idea, though argument may not be sustained throughout. Uses evidence to support points but explanation of effect may be thin. Some accurate use of literary terminology.' },
      { grade: 'D', description: 'Identifies features of texts and describes them at a surface level. Paragraph structure present but argument is not consistently sustained. Limited explanation of effect. Quotations used as illustration without analysis.' },
      { grade: 'E', description: 'Basic engagement with texts. Limited paragraph structure, retell-dominated, minimal use of techniques or terminology.' },
    ],
    commonPitfalls: [
      'Describing techniques and effect separately, without showing the link ("the simile compares X to Y" + "this is interesting", with no analysis of what the comparison achieves).',
      'Confusing analysis (how meaning is constructed) with response (what I think about the text).',
      'Treating context as a list of biographical or historical facts disconnected from how those shape the text\'s meaning.',
      'Quoting at length without integrating or commenting; quotations should be short and serve the argument.',
      'Listing multiple techniques in one sentence without unpacking any of them ("the author uses imagery, metaphor and personification to convey theme").',
      'Conflating composer with persona/narrator/character; especially in poetry, the "I" is constructed.',
      'Mechanical thesis statements ("This essay will discuss...") instead of staking an interpretive position.',
    ],
  },

  // ── Mathematics Stage 4 ──────────────────────────────────────────────
  {
    discipline: 'Mathematics',
    stage: 4,
    descriptors: [
      { grade: 'A', description: 'Applies mathematical procedures accurately and explains reasoning clearly. Sets out solutions logically with appropriate working at each step. Uses mathematical language and notation correctly. Selects appropriate strategies for unfamiliar problems and checks reasonableness of answers.' },
      { grade: 'B', description: 'Applies procedures correctly with minor errors. Shows clear working most of the time. Uses notation accurately. Generally selects appropriate strategies; checking is inconsistent.' },
      { grade: 'C', description: 'Applies routine procedures in familiar contexts. Working is present but sometimes incomplete. Notation is mostly correct. Strategies for unfamiliar problems are limited.' },
      { grade: 'D', description: 'Demonstrates basic procedural fluency with frequent errors. Working is sparse or unclear. Notation inconsistent. Struggles to choose strategies for non-routine problems.' },
      { grade: 'E', description: 'Limited grasp of routine procedures. Working largely absent. Cannot apply mathematics to anything beyond a copied example.' },
    ],
    commonPitfalls: [
      'Writing only the final answer with no working — the working IS where the marks come from.',
      'Skipping steps or substituting numbers without stating what is being calculated.',
      'Forgetting units in worded problems.',
      'Misusing the equals sign as a "now do this" arrow ("3+4 = 7 × 2 = 14") instead of a statement of equality.',
      'Premature rounding within a calculation, causing accumulated error in the final answer.',
      'Not checking that an answer is reasonable in the context of the question.',
    ],
  },

  // ── Mathematics Stage 5 ──────────────────────────────────────────────
  {
    discipline: 'Mathematics',
    stage: 5,
    descriptors: [
      { grade: 'A', description: 'Selects and applies appropriate mathematical strategies to solve familiar and unfamiliar problems. Shows clear, complete and concise working with correct notation. Justifies steps where required. Verifies answers and communicates results in the context of the problem.' },
      { grade: 'B', description: 'Applies appropriate strategies to most problems. Working is complete with mostly correct notation. Provides justification when prompted. Answers contextualised.' },
      { grade: 'C', description: 'Applies procedures to familiar problems with most steps shown. Notation generally correct. Limited justification of reasoning. Answers given without consistent reference to context.' },
      { grade: 'D', description: 'Applies routine procedures with frequent errors. Working incomplete or hard to follow. Notation inconsistent.' },
      { grade: 'E', description: 'Limited procedural knowledge. Cannot follow worked examples to new contexts. Working sparse or absent.' },
    ],
    commonPitfalls: [
      'Showing only the final answer to a problem worth multiple marks — markers can only award what they can see in your working.',
      'Mixing up the variables in worded problems (e.g. confusing distance and time in motion questions).',
      'Forgetting to state assumptions for modelling problems.',
      'Not communicating the answer in the context of the question ("x = 12" instead of "the box can hold 12 books").',
      'Errors in algebraic manipulation through skipping intermediate steps.',
      'Failing to justify why a chosen strategy works (especially for proof or reasoning questions).',
      'Using a calculator without showing how the calculation was set up.',
    ],
  },

  // ── Science Stage 4 ──────────────────────────────────────────────────
  {
    discipline: 'Science',
    stage: 4,
    descriptors: [
      { grade: 'A', description: 'Identifies and explains scientific concepts using accurate terminology. Plans and conducts simple investigations safely, controlling variables and recording observations systematically. Interprets data and identifies patterns. Uses evidence to support conclusions.' },
      { grade: 'B', description: 'Describes scientific concepts with accurate terminology. Conducts investigations with some attention to variables and safety. Records observations clearly. Draws conclusions supported by evidence.' },
      { grade: 'C', description: 'Identifies scientific concepts and applies them in familiar contexts. Follows investigation procedures. Records observations though may miss patterns. Conclusions present but not always linked to evidence.' },
      { grade: 'D', description: 'Recognises basic scientific concepts. Follows simple procedures with support. Observations incomplete. Limited link between evidence and conclusion.' },
      { grade: 'E', description: 'Limited grasp of scientific concepts and procedures. Cannot independently conduct or interpret an investigation.' },
    ],
    commonPitfalls: [
      'Using everyday language instead of scientific terminology ("the stuff" instead of "the substance" or naming it specifically).',
      'Failing to identify the independent, dependent and controlled variables in an investigation.',
      'Confusing observations (what you see/measure) with inferences (what you conclude from them).',
      'Conclusion does not refer back to the original hypothesis or aim.',
      'Reporting results without analysing patterns or trends.',
      'Treating "fair test" as a magic phrase without explaining what made it fair.',
    ],
  },

  // ── Science Stage 5 ──────────────────────────────────────────────────
  {
    discipline: 'Science',
    stage: 5,
    descriptors: [
      { grade: 'A', description: 'Explains scientific concepts using accurate, discipline-specific terminology. Designs and conducts investigations with controlled variables, justifying methodology. Analyses data, identifying patterns and limitations. Evaluates the validity and reliability of evidence. Uses evidence to construct supported conclusions and explanations.' },
      { grade: 'B', description: 'Explains scientific concepts using appropriate terminology. Plans investigations with attention to validity. Analyses data and draws conclusions supported by evidence. Some evaluation of evidence quality.' },
      { grade: 'C', description: 'Describes scientific concepts with mostly accurate terminology. Conducts investigations with some independence. Identifies patterns in data. Draws conclusions but may not evaluate evidence.' },
      { grade: 'D', description: 'Identifies basic concepts but explanation is limited. Follows procedures with errors. Conclusion present but disconnected from evidence.' },
      { grade: 'E', description: 'Elementary grasp of scientific concepts. Cannot independently analyse data or evaluate evidence.' },
    ],
    commonPitfalls: [
      'Treating "valid" and "reliable" as synonyms — validity is about measuring what you intended, reliability is about consistent results.',
      'Stating a conclusion without referring to the data that supports it.',
      'Confusing accuracy (closeness to true value) with precision (consistency of repeated measurements).',
      'Using "prove" instead of "support" — science supports hypotheses, it does not prove them.',
      'Ignoring outliers or anomalous results rather than discussing them.',
      'Diagrams without labels, units or scale.',
      'Mixing up correlation and causation when discussing trends.',
    ],
  },

  // ── HSIE (History / Geography) Stage 4 ───────────────────────────────
  {
    discipline: 'HSIE',
    stage: 4,
    descriptors: [
      { grade: 'A', description: 'Identifies and describes key features, events and concepts in History or Geography using accurate terminology. Uses sources purposefully to support description. Sequences events or processes coherently. Begins to identify cause and effect, continuity and change.' },
      { grade: 'B', description: 'Describes key features and events with relevant detail. Uses sources to support description. Identifies basic cause and effect relationships.' },
      { grade: 'C', description: 'Identifies key features and events. Uses some sources, often as illustration rather than evidence. Some sequencing of events; limited engagement with cause and effect.' },
      { grade: 'D', description: 'Identifies basic features of historical or geographical content. Limited use of sources. Sequencing inconsistent.' },
      { grade: 'E', description: 'Elementary engagement with content. Limited use of terminology or sources.' },
    ],
    commonPitfalls: [
      'Treating sources as illustration ("here is a picture of...") rather than as evidence for a specific claim.',
      'Listing events in chronological order without explaining their connection or significance.',
      'Confusing cause and effect — what made an event happen versus what happened as a result.',
      'Using terminology imprecisely ("country" / "nation" / "state" used interchangeably; "society" / "civilisation").',
      'In Geography: confusing physical features (mountains, rivers) with human features (cities, infrastructure).',
      'Failing to reference where information came from — even basic source attribution helps.',
    ],
  },

  // ── HSIE Stage 5 ─────────────────────────────────────────────────────
  {
    discipline: 'HSIE',
    stage: 5,
    descriptors: [
      { grade: 'A', description: 'Analyses and explains historical events or geographical processes using accurate discipline-specific terminology. Uses sources critically, evaluating their reliability, perspective and usefulness. Sustains an argument supported by evidence. Demonstrates understanding of cause and effect, continuity and change, perspectives and significance.' },
      { grade: 'B', description: 'Explains events and processes with relevant detail and accurate terminology. Uses sources to support an argument; some critical engagement with source perspective. Identifies cause and effect with explanation.' },
      { grade: 'C', description: 'Describes events and processes using mostly accurate terminology. Uses sources to support points; engagement with source perspective is limited. Identifies cause and effect.' },
      { grade: 'D', description: 'Identifies key events; explanation is limited. Sources used as illustration. Cause and effect identified but not explained.' },
      { grade: 'E', description: 'Elementary content knowledge; argument lacks structure and evidence.' },
    ],
    commonPitfalls: [
      'Source analysis at a description level only — what the source shows — without asking who made it, when, why, and how reliable it is.',
      'Sustaining a chronological narrative when the question asks for analysis of cause/effect or significance.',
      'Confusing significance with importance — a significant event is one that had lasting impact, not just one with a big number.',
      'Using sources only to confirm a pre-existing view; failing to consider counter-evidence.',
      'In Geography: treating a case study as a fact dump rather than as evidence for a process or pattern.',
      'Failing to address perspectives — historical events are interpreted differently by different groups, and good responses acknowledge this.',
      'Vague references to "the source" without specifying which source or its provenance.',
    ],
  },

  // ── PDHPE Stage 4 ────────────────────────────────────────────────────
  {
    discipline: 'PDHPE',
    stage: 4,
    descriptors: [
      { grade: 'A', description: 'Identifies and describes factors that affect health, safety, wellbeing and movement. Uses subject-specific terminology accurately. Applies knowledge to familiar scenarios, including identifying simple strategies for healthy choices. Demonstrates understanding of how identity, relationships and environments shape health.' },
      { grade: 'B', description: 'Describes factors that affect health and movement with some accurate terminology. Applies knowledge to familiar contexts. Identifies strategies for healthy choices.' },
      { grade: 'C', description: 'Identifies factors that affect health and movement. Uses some terminology, occasionally imprecisely. Applies knowledge in familiar contexts with support.' },
      { grade: 'D', description: 'Recognises basic health and movement concepts. Limited use of terminology. Struggles to apply knowledge to scenarios.' },
      { grade: 'E', description: 'Elementary engagement with health and movement content.' },
    ],
    commonPitfalls: [
      'Using everyday words ("fit", "healthy", "exercise") without engaging with the specific PDHPE definition.',
      'Listing factors that affect health without explaining the connection (e.g. listing "sleep, diet, friends" without saying how each shapes wellbeing).',
      'Treating health as physical only, ignoring social, emotional, mental and spiritual dimensions.',
      'Confusing identity (who you are) with self-esteem (how you feel about yourself).',
      'Generic strategies ("eat well, exercise more") without specific context or detail.',
    ],
  },

  // ── PDHPE Stage 5 ────────────────────────────────────────────────────
  {
    discipline: 'PDHPE',
    stage: 5,
    descriptors: [
      { grade: 'A', description: 'Analyses factors that influence health, safety, wellbeing and physical activity. Uses PDHPE terminology accurately and integrates it into explanation. Applies health-promotion concepts to a range of scenarios. Evaluates strategies and proposes informed actions. Considers dimensions of health, determinants, and the influence of context on individual and community wellbeing.' },
      { grade: 'B', description: 'Explains factors that affect health and movement using accurate terminology. Applies health-promotion concepts. Identifies and explains strategies; some evaluation.' },
      { grade: 'C', description: 'Describes factors and applies them to familiar scenarios. Uses mostly correct terminology. Identifies strategies but evaluation is limited.' },
      { grade: 'D', description: 'Identifies factors with limited explanation. Application of concepts is surface-level.' },
      { grade: 'E', description: 'Elementary understanding of PDHPE concepts.' },
    ],
    commonPitfalls: [
      'Discussing one dimension of health (usually physical) when the question requires multiple dimensions.',
      'Listing health determinants without connecting them to specific health outcomes or behaviours.',
      'Treating the Ottawa Charter / health-promotion frameworks as a list to recall rather than a tool to apply.',
      'Generic strategies that could apply to any health issue, rather than tailored to the specific scenario.',
      'Confusing modifiable and non-modifiable factors when proposing interventions.',
      'Ignoring social, cultural and environmental influences on movement skills and physical activity.',
      'Failing to discuss equity — who benefits and who is left out of a health promotion strategy.',
    ],
  },
];

/**
 * Look up the (discipline, stage) reference if we have one. Returns null if
 * no curated reference exists for this combination — caller should fall back
 * to the generic A-E scale.
 */
export function getStage45Reference(
  discipline: string | null | undefined,
  stage: 4 | 5,
): SubjectStageReference | null {
  if (!discipline) return null;
  return STAGE_4_5_REFERENCES.find(
    (r) => r.discipline === discipline && r.stage === stage,
  ) || null;
}
