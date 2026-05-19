/**
 * Subject-specific glossaries for NSW HSC courses.
 *
 * For each course this file lists the terms most commonly misused or
 * conflated by HSC students, with a short syllabus-aligned definition
 * and a "watch for" note describing the typical error.
 *
 * The right glossary is injected into the Pass 1 system prompt so the
 * model can call out misuse where it actually occurs in the draft. This
 * is NOT a complete subject glossary — it's a curated set focused on
 * high-frequency confusions that real HSC markers see.
 *
 * Sources: NSW Stage 6 syllabuses; NESA Notes from the Marking Centre
 * (2021–2024) where common misuse patterns are explicitly flagged.
 *
 * To extend: add a new entry to SUBJECT_GLOSSARIES keyed by the course
 * name (matching values in nesa-courses.ts) or any of its aliases.
 */

export interface GlossaryEntry {
  term: string;
  definition: string;
  watchFor?: string;
}

export const SUBJECT_GLOSSARIES: Record<string, GlossaryEntry[]> = {
  // ──────────────────────────────────────────────────────────────────
  'English Advanced': [
    { term: 'thesis', definition: 'The central interpretive argument of a response — what the writer is claiming about the text.', watchFor: 'Stating a topic ("This essay will discuss…") rather than an arguable interpretive claim.' },
    { term: 'theme', definition: 'A central idea or concern explored in a text.', watchFor: 'Confusing theme (idea) with motif (recurring image/symbol) or topic (subject matter).' },
    { term: 'motif', definition: 'A recurring image, symbol, idea or pattern that contributes to a text\'s meaning.', watchFor: 'Listing motifs without explaining how their recurrence develops a theme.' },
    { term: 'voice', definition: 'The distinctive way a speaker, narrator or persona expresses ideas — established through diction, syntax, tone and perspective.', watchFor: 'Treating voice as identical to the author; voice is a textual construct.' },
    { term: 'persona', definition: 'The constructed speaker or "I" of a poem or text, distinct from the author.', watchFor: 'Conflating the persona with the author (especially in poetry).' },
    { term: 'characterisation', definition: 'The techniques used by a composer to construct character — direct description, dialogue, action, reaction of others.', watchFor: 'Describing a character\'s traits instead of analysing how those traits are constructed.' },
    { term: 'tone', definition: 'The composer\'s attitude toward the subject or audience, conveyed through word choice and stylistic features.', watchFor: 'Naming a tone ("sad") without showing the lexical/syntactic choices that create it.' },
    { term: 'perspective', definition: 'A particular point of view shaped by context, values and experience — held by composer, character, or responder.', watchFor: 'Using "perspective" interchangeably with "opinion".' },
    { term: 'context', definition: 'The historical, cultural, biographical, ideological or compositional circumstances that shape and are reflected in a text.', watchFor: 'Reciting biographical/historical facts without showing how they shape the text.' },
    { term: 'textual integrity', definition: 'The unity of a text — the way its form, language, ideas and structure work together to create meaning.', watchFor: 'Treating textual integrity as a checklist rather than a sustained argument about cohesion.' },
    { term: 'intertextuality', definition: 'The relationship between texts — how meaning is shaped by reference to, transformation of, or dialogue with other texts.', watchFor: 'Naming a borrowed reference without analysing how the relationship reshapes meaning.' },
    { term: 'allusion', definition: 'An indirect reference to another text, event, person or idea.', watchFor: 'Identifying an allusion without explaining the meaning it imports.' },
    { term: 'irony', definition: 'A gap between what is said/expected and what is meant/occurs (verbal, situational, dramatic).', watchFor: 'Calling something ironic when it is merely contrasting or unexpected.' },
    { term: 'didactic', definition: 'A text that explicitly aims to instruct or convey a moral message.', watchFor: 'Using "didactic" for any text with a clear point of view.' },
    { term: 'representation', definition: 'The way ideas, people, events or values are constructed through textual choices.', watchFor: 'Discussing what is represented rather than how it is represented.' },
  ],

  // ──────────────────────────────────────────────────────────────────
  'English Standard': [
    { term: 'thesis', definition: 'The central interpretive argument of a response.', watchFor: 'Stating the question topic instead of taking a position on it.' },
    { term: 'theme', definition: 'A central idea or concern of a text.', watchFor: 'Confusing theme (idea) with topic (subject) or motif (recurring image).' },
    { term: 'composer', definition: 'The writer, director, artist or producer of a text.', watchFor: 'Switching between "composer" and "author"/"director" inconsistently.' },
    { term: 'responder', definition: 'The reader, viewer or listener of a text.', watchFor: 'Saying "we" or "people"; "the responder" is the precise term.' },
    { term: 'context', definition: 'Historical, cultural or personal circumstances that shape a text or its reception.', watchFor: 'Listing contextual facts without linking them to choices in the text.' },
    { term: 'characterisation', definition: 'How a character is constructed through language and structural choices.', watchFor: 'Describing personality instead of analysing technique.' },
    { term: 'perspective', definition: 'A point of view shaped by experience, values and context.', watchFor: 'Using "perspective" as a synonym for "opinion".' },
    { term: 'tone', definition: 'The composer\'s attitude toward the subject or audience.', watchFor: 'Naming a tone without quoting the language that produces it.' },
    { term: 'symbol', definition: 'An object or image that represents an idea or quality beyond its literal meaning.', watchFor: 'Calling something symbolic without explaining what it represents and why.' },
    { term: 'imagery', definition: 'Descriptive language that creates a sensory picture (visual, auditory, tactile, etc.).', watchFor: 'Using "imagery" loosely to mean any vivid description.' },
    { term: 'analysis', definition: 'Identifying components and relationships, then drawing out implications for meaning.', watchFor: 'Re-telling the plot or describing techniques without analysing effect.' },
    { term: 'evaluation', definition: 'Making a judgement based on criteria.', watchFor: 'Asserting a judgement without justifying it against criteria.' },
  ],

  // ──────────────────────────────────────────────────────────────────
  'Biology': [
    { term: 'hypothesis', definition: 'A testable, falsifiable prediction — "If [independent variable], then [dependent variable], because [reasoning]".', watchFor: 'Stating an aim or research question; an hypothesis must be a predicted relationship.' },
    { term: 'theory', definition: 'A well-substantiated explanation of an aspect of the natural world, supported by repeated experimental evidence.', watchFor: 'Using "theory" colloquially to mean "guess" or "hunch".' },
    { term: 'reliability', definition: 'The consistency of results when an experiment is repeated under the same conditions.', watchFor: 'Confusing reliability with validity or accuracy. Repeating measurements increases reliability, not validity.' },
    { term: 'validity', definition: 'The extent to which an experiment measures what it claims to measure — depends on appropriate methodology and controlled variables.', watchFor: 'Using "valid" to mean "true" or "reliable".' },
    { term: 'accuracy', definition: 'How close a measurement is to the true or accepted value.', watchFor: 'Confusing with precision (closeness of repeated measurements to each other).' },
    { term: 'natural selection', definition: 'The differential survival and reproduction of individuals due to differences in heritable traits — the mechanism of evolution.', watchFor: 'Describing organisms as "wanting to" or "trying to" adapt; selection is non-purposive.' },
    { term: 'evolution', definition: 'Change in the heritable characteristics of biological populations over successive generations.', watchFor: 'Describing evolution as occurring within an individual organism rather than across populations.' },
    { term: 'adaptation', definition: 'A heritable trait that increases an organism\'s fitness in its environment.', watchFor: 'Describing learned behaviours or short-term physiological responses as "adaptations".' },
    { term: 'homeostasis', definition: 'The maintenance of a stable internal environment despite changes in the external environment.', watchFor: 'Describing homeostasis as keeping things "constant"; it is dynamic regulation around a set point.' },
    { term: 'negative feedback', definition: 'A control mechanism in which the response opposes the original change to restore the set point.', watchFor: 'Confusing with positive feedback (which amplifies the change).' },
    { term: 'genotype', definition: 'The genetic constitution of an organism (alleles inherited).', watchFor: 'Using genotype interchangeably with phenotype.' },
    { term: 'phenotype', definition: 'The observable characteristics of an organism, resulting from genotype + environment.', watchFor: 'Describing phenotype as caused by genes alone; environment matters.' },
    { term: 'mutation', definition: 'A change in the DNA sequence of an organism\'s genome.', watchFor: 'Treating all mutations as harmful; many are neutral or beneficial.' },
    { term: 'control variable', definition: 'A factor kept constant across experimental groups to isolate the effect of the independent variable.', watchFor: 'Confusing with the control group (a comparison group with no treatment).' },
    { term: 'correlation vs causation', definition: 'Correlation = a statistical relationship between variables; causation = one variable produces a change in another.', watchFor: 'Inferring causation from a correlation in observational data.' },
  ],

  // ──────────────────────────────────────────────────────────────────
  'Chemistry': [
    { term: 'equilibrium', definition: 'The state of a reversible reaction where forward and reverse rates are equal and concentrations of reactants and products remain constant.', watchFor: 'Describing equilibrium as "no reaction occurring" — both reactions continue at equal rates.' },
    { term: 'Le Chatelier\'s principle', definition: 'When a system at equilibrium is disturbed, the system shifts to partially counteract the disturbance.', watchFor: 'Saying the system "fully cancels" or "removes" the disturbance.' },
    { term: 'enthalpy', definition: 'The total heat content of a system at constant pressure (ΔH, in kJ/mol).', watchFor: 'Confusing enthalpy with activation energy.' },
    { term: 'exothermic / endothermic', definition: 'Exothermic releases energy to surroundings (ΔH < 0); endothermic absorbs energy from surroundings (ΔH > 0).', watchFor: 'Determining direction from a temperature change without considering whether energy is absorbed or released by the system.' },
    { term: 'activation energy', definition: 'The minimum energy required for reactant particles to collide successfully and form products.', watchFor: 'Saying a catalyst lowers the energy of the reactants; it lowers the activation energy by providing an alternative pathway.' },
    { term: 'catalyst', definition: 'A substance that increases reaction rate by lowering activation energy without being consumed.', watchFor: 'Saying a catalyst shifts equilibrium position; it speeds both directions equally.' },
    { term: 'oxidation / reduction', definition: 'Oxidation = loss of electrons (or increase in oxidation number); reduction = gain of electrons (or decrease in oxidation number). Mnemonic: OIL RIG.', watchFor: 'Identifying which species is oxidised vs reduced incorrectly when half-equations are reversed.' },
    { term: 'conjugate acid / base', definition: 'A conjugate acid is formed when a base accepts a proton; a conjugate base is formed when an acid donates a proton.', watchFor: 'Identifying conjugate pairs that differ by more than one proton.' },
    { term: 'pH', definition: 'pH = −log₁₀[H⁺]. A measure of hydrogen ion concentration.', watchFor: 'Treating pH as a linear scale; each unit change is a 10-fold change in [H⁺].' },
    { term: 'rate of reaction', definition: 'The change in concentration of reactant or product per unit time.', watchFor: 'Confusing rate with extent of reaction (how far it proceeds).' },
    { term: 'spectator ion', definition: 'An ion present in solution but unchanged during a reaction; appears on both sides of an ionic equation.', watchFor: 'Including spectator ions in net ionic equations.' },
    { term: 'titration', definition: 'A volumetric analytical technique to determine concentration of an unknown by reaction with a standard solution.', watchFor: 'Confusing equivalence point (stoichiometric) with end point (when indicator changes colour).' },
    { term: 'mole', definition: 'The amount of substance containing 6.022 × 10²³ entities (Avogadro\'s number).', watchFor: 'Confusing mole, molar mass and number of particles in calculations.' },
  ],

  // ──────────────────────────────────────────────────────────────────
  'Physics': [
    { term: 'scalar vs vector', definition: 'A scalar has magnitude only (e.g. speed, mass, energy). A vector has magnitude and direction (e.g. velocity, force, displacement).', watchFor: 'Using speed and velocity interchangeably, or omitting direction from vector answers.' },
    { term: 'displacement vs distance', definition: 'Distance is the total path length (scalar). Displacement is the straight-line change in position (vector).', watchFor: 'Calculating distance and labelling it displacement.' },
    { term: 'velocity vs speed', definition: 'Velocity is the rate of change of displacement (vector). Speed is the rate of change of distance (scalar).', watchFor: 'Reporting velocity without direction.' },
    { term: 'acceleration', definition: 'The rate of change of velocity (vector). A change in direction is acceleration even at constant speed.', watchFor: 'Saying an object moving at constant speed in a circle has zero acceleration.' },
    { term: 'force', definition: 'A vector quantity that produces or tends to produce a change in motion (F = ma).', watchFor: 'Confusing force with momentum or energy.' },
    { term: 'weight vs mass', definition: 'Mass is the amount of matter (scalar, kg). Weight is the gravitational force on a mass (vector, N).', watchFor: 'Using "weight" colloquially when "mass" is meant.' },
    { term: 'work', definition: 'Energy transferred to or from a body by a force acting through a displacement (W = Fd cos θ).', watchFor: 'Calculating work done when force and displacement are perpendicular (no work is done).' },
    { term: 'momentum', definition: 'The product of mass and velocity (p = mv). A vector quantity, conserved in isolated systems.', watchFor: 'Confusing momentum (mv) with kinetic energy (½mv²).' },
    { term: 'impulse', definition: 'The change in momentum of an object, equal to the force applied times the time it acts (J = FΔt).', watchFor: 'Confusing impulse with momentum itself.' },
    { term: 'electromagnetic induction', definition: 'The production of an EMF in a conductor when the magnetic flux through it changes (Faraday\'s Law).', watchFor: 'Confusing the cause (changing flux) with the effect (induced EMF).' },
    { term: 'inertial frame of reference', definition: 'A frame in which Newton\'s first law holds — i.e. not accelerating.', watchFor: 'Treating accelerating frames as inertial.' },
    { term: 'centripetal force', definition: 'The net force directed toward the centre of a circular path that keeps an object in circular motion.', watchFor: 'Treating centripetal force as a separate "outward" force; centrifugal force is a fictitious force in a non-inertial frame.' },
  ],

  // ──────────────────────────────────────────────────────────────────
  'Modern History': [
    { term: 'causation', definition: 'The set of factors that brought about a historical event or development.', watchFor: 'Listing causes without weighing their relative significance or showing connection to the outcome.' },
    { term: 'continuity and change', definition: 'The way some aspects of a society persist over time while others transform.', watchFor: 'Describing only change; continuity (what stays the same) is equally important.' },
    { term: 'significance', definition: 'The historical importance of an event, person or development — judged by criteria such as scale, duration, depth and impact.', watchFor: 'Asserting significance without applying explicit criteria.' },
    { term: 'perspective', definition: 'The position from which a person experiences and interprets events — shaped by their context.', watchFor: 'Equating perspective with bias; all sources have perspective, not all are biased.' },
    { term: 'contestability', definition: 'The fact that historical interpretations are disputed by different historians, often based on the same evidence.', watchFor: 'Treating one interpretation as the "true" version.' },
    { term: 'historiography', definition: 'The study of how history has been written — schools of thought, debates, methodologies.', watchFor: 'Listing historians without explaining their interpretive approach or how they differ.' },
    { term: 'source vs evidence', definition: 'A source is any artefact from the past. Evidence is what a source can support a claim about.', watchFor: 'Using "source" and "evidence" interchangeably; not all sources are evidence for every claim.' },
    { term: 'primary vs secondary source', definition: 'Primary = produced during the period under study. Secondary = produced after, interpreting primary material.', watchFor: 'Misclassifying based on subject matter rather than time of production.' },
    { term: 'reliability', definition: 'The trustworthiness of a source as evidence for a particular claim — depends on origin, motive, proximity to events.', watchFor: 'Calling a source "unreliable" without specifying for what claim and why.' },
    { term: 'usefulness', definition: 'How well a source serves the historian\'s specific purpose of inquiry.', watchFor: 'Conflating useful with reliable; a biased source can be useful for studying that bias.' },
    { term: 'propaganda', definition: 'Communication designed to shape opinion or behaviour, usually in support of a political agenda.', watchFor: 'Labelling any persuasive material as propaganda without addressing intent and audience.' },
    { term: 'revisionism', definition: 'The reinterpretation of established historical accounts in light of new evidence or perspectives.', watchFor: 'Using "revisionist" pejoratively; revision is part of historical method.' },
  ],

  // ──────────────────────────────────────────────────────────────────
  'Ancient History': [
    { term: 'continuity and change', definition: 'The way some aspects of an ancient society persist while others transform over time.', watchFor: 'Describing change without addressing what continued.' },
    { term: 'causation', definition: 'The factors that brought about an event or development in the ancient world.', watchFor: 'Listing causes without weighing their relative importance.' },
    { term: 'perspective', definition: 'The position of an ancient writer or modern historian, shaped by their context and purpose.', watchFor: 'Treating ancient sources as objective records without acknowledging perspective.' },
    { term: 'reliability', definition: 'The trustworthiness of an ancient source for a particular historical claim.', watchFor: 'Dismissing a whole source as unreliable; reliability depends on the specific claim.' },
    { term: 'archaeological vs literary evidence', definition: 'Material remains (artefacts, structures, inscriptions) vs written texts.', watchFor: 'Privileging literary evidence over archaeological without justification.' },
    { term: 'historiography', definition: 'The study of how history has been written about a period or topic.', watchFor: 'Naming historians without engaging with their interpretations.' },
    { term: 'significance', definition: 'The historical importance of a person, event or development.', watchFor: 'Asserting significance without applying criteria.' },
    { term: 'context', definition: 'The political, social, religious or cultural circumstances of an ancient society.', watchFor: 'Reciting contextual detail without linking it to the question.' },
    { term: 'attestation', definition: 'The extent to which a claim is supported by surviving evidence.', watchFor: 'Treating poorly-attested events as though they were well-documented.' },
    { term: 'source corpus', definition: 'The body of surviving evidence (literary, archaeological, epigraphic) for a topic.', watchFor: 'Generalising from a single source rather than the corpus.' },
  ],

  // ──────────────────────────────────────────────────────────────────
  'Mathematics Advanced': [
    { term: 'function', definition: 'A relation in which each input maps to exactly one output. f: A → B.', watchFor: 'Treating relations as functions without checking the vertical line test.' },
    { term: 'domain and range', definition: 'Domain = the set of permissible inputs. Range = the set of resulting outputs.', watchFor: 'Stating the domain as ℝ without checking for restrictions (square roots, logs, denominators).' },
    { term: 'derivative', definition: 'The instantaneous rate of change of a function with respect to its variable.', watchFor: 'Stopping at finding f\'(x) without interpreting it in context.' },
    { term: 'integral', definition: 'The accumulated change of a function (definite integral) or its antiderivative (indefinite integral).', watchFor: 'Forgetting the constant of integration; missing the absolute-value sign in ∫1/x dx.' },
    { term: 'continuous vs differentiable', definition: 'A function is continuous at a point if its limit equals its value there. Differentiable functions are continuous, but not vice versa.', watchFor: 'Assuming continuous implies differentiable.' },
    { term: 'definite integral', definition: '∫ₐᵇ f(x) dx — the signed area between f and the x-axis from a to b.', watchFor: 'Forgetting to subtract: F(b) − F(a).' },
    { term: 'logarithm', definition: 'The inverse of exponentiation: log_b(x) = y means b^y = x.', watchFor: 'Misapplying log laws (log(a + b) ≠ log a + log b).' },
    { term: 'probability', definition: 'A measure between 0 and 1 of the likelihood of an event occurring.', watchFor: 'Adding probabilities of dependent events without conditioning.' },
    { term: 'arithmetic vs geometric sequence', definition: 'Arithmetic = constant common difference (d). Geometric = constant common ratio (r).', watchFor: 'Applying arithmetic formulas to a geometric sequence and vice versa.' },
    { term: 'normal distribution', definition: 'A continuous symmetric probability distribution defined by mean and standard deviation.', watchFor: 'Using normal-distribution methods for non-normal data.' },
  ],

  // ──────────────────────────────────────────────────────────────────
  'Economics': [
    { term: 'opportunity cost', definition: 'The value of the next best alternative forgone when a choice is made.', watchFor: 'Identifying multiple alternatives instead of just the next best one.' },
    { term: 'marginal vs total', definition: 'Marginal = the change in a variable from one additional unit. Total = the cumulative amount.', watchFor: 'Treating marginal analysis the same as total analysis (e.g. confusing marginal cost with average cost).' },
    { term: 'elasticity', definition: 'The responsiveness of one variable to a change in another (e.g. price elasticity of demand).', watchFor: 'Describing direction (positive/negative) without magnitude (elastic, inelastic, unitary).' },
    { term: 'inflation', definition: 'A sustained increase in the general price level of goods and services in an economy.', watchFor: 'Calling a single price rise "inflation"; inflation is sustained and general.' },
    { term: 'fiscal vs monetary policy', definition: 'Fiscal = government decisions about taxation and spending. Monetary = central bank decisions about money supply and interest rates.', watchFor: 'Attributing interest-rate changes to the federal government rather than the RBA.' },
    { term: 'GDP', definition: 'The total market value of final goods and services produced within an economy in a period.', watchFor: 'Treating GDP as a measure of welfare; it omits inequality, environment, unpaid work.' },
    { term: 'unemployment vs underemployment', definition: 'Unemployed = without work, available, actively seeking. Underemployed = employed but wanting more hours.', watchFor: 'Using one rate to describe both phenomena.' },
    { term: 'comparative advantage', definition: 'The ability of a country to produce a good at a lower opportunity cost than another country.', watchFor: 'Confusing with absolute advantage (producing more of a good with the same inputs).' },
    { term: 'externality', definition: 'A cost or benefit of an economic activity borne by parties not directly involved in the transaction.', watchFor: 'Mixing positive and negative externalities, or attributing all market failure to externalities.' },
    { term: 'demand vs quantity demanded', definition: 'Demand = the entire schedule (a curve). Quantity demanded = a single point on the curve at a given price.', watchFor: 'Saying "demand increased" when only quantity demanded changed in response to a price fall.' },
    { term: 'recession', definition: 'Two consecutive quarters of negative real GDP growth (technical definition).', watchFor: 'Calling any economic slowdown a recession.' },
  ],

  // ──────────────────────────────────────────────────────────────────
  'Business Studies': [
    { term: 'stakeholder', definition: 'Any individual or group with an interest in or affected by a business\'s activities.', watchFor: 'Treating "stakeholder" as synonymous with "shareholder".' },
    { term: 'marketing mix', definition: 'The combination of product, price, promotion and place (and people, processes, physical evidence for services).', watchFor: 'Listing the 4 Ps without applying them to the case.' },
    { term: 'liquidity vs solvency', definition: 'Liquidity = ability to meet short-term obligations. Solvency = ability to meet long-term obligations.', watchFor: 'Using the two terms interchangeably.' },
    { term: 'gross vs net profit', definition: 'Gross profit = revenue − cost of goods sold. Net profit = gross profit − all other expenses (incl. tax).', watchFor: 'Using gross profit as a measure of overall profitability.' },
    { term: 'leadership vs management', definition: 'Leadership = setting direction and inspiring people. Management = planning, organising, leading and controlling.', watchFor: 'Equating "manager" and "leader"; not all managers lead and not all leaders manage.' },
    { term: 'centralised vs decentralised', definition: 'Where decision-making authority sits — at head office (centralised) or distributed across the business (decentralised).', watchFor: 'Describing structure without analysing trade-offs (consistency vs responsiveness).' },
    { term: 'corporate social responsibility', definition: 'A business\'s commitment to operate ethically and contribute to economic, social and environmental wellbeing.', watchFor: 'Reducing CSR to philanthropy; it includes operations, supply chain, governance.' },
    { term: 'global vs international', definition: 'International = operating across borders. Global = operating with an integrated worldwide strategy.', watchFor: 'Using the terms interchangeably.' },
    { term: 'ratio analysis', definition: 'The interpretation of financial relationships using ratios (liquidity, gearing, profitability, efficiency).', watchFor: 'Calculating ratios without comparing to benchmarks or trends.' },
    { term: 'organisational structure vs culture', definition: 'Structure = formal reporting relationships. Culture = shared values, attitudes and behaviours.', watchFor: 'Conflating the two when analysing a business problem.' },
  ],

  // ──────────────────────────────────────────────────────────────────
  'Legal Studies': [
    { term: 'rule of law', definition: 'The principle that all individuals and institutions are subject to and accountable to the same laws.', watchFor: 'Using the term as a slogan without explaining its components (equality, accessibility, accountability).' },
    { term: 'statute vs common law', definition: 'Statute = law made by parliament. Common law = law developed by judges through cases.', watchFor: 'Confusing statute and common law, or attributing all law to parliament.' },
    { term: 'jurisdiction', definition: 'The legal authority of a court or government to hear a matter or make laws.', watchFor: 'Conflating jurisdiction (authority) with venue (location).' },
    { term: 'mens rea vs actus reus', definition: 'Mens rea = the guilty mind. Actus reus = the guilty act. Both are required for most criminal offences.', watchFor: 'Discussing only the act and ignoring the required mental element.' },
    { term: 'beyond reasonable doubt', definition: 'The standard of proof in criminal cases.', watchFor: 'Confusing with the civil standard ("on the balance of probabilities").' },
    { term: 'precedent', definition: 'A previous court decision that establishes a principle or rule to be followed in similar cases.', watchFor: 'Treating all precedents as binding; only those from higher courts in the same hierarchy bind.' },
    { term: 'plaintiff vs defendant', definition: 'Plaintiff = party initiating a civil suit. Defendant = party being sued or accused.', watchFor: 'Using these terms in criminal contexts (where it is prosecution vs accused).' },
    { term: 'separation of powers', definition: 'The division of government power between legislature, executive and judiciary to prevent abuses.', watchFor: 'Describing all three branches as fully independent in Australia (executive overlaps significantly with legislature).' },
    { term: 'mediation vs arbitration', definition: 'Mediation = facilitated negotiation toward a non-binding agreement. Arbitration = a third party makes a binding decision.', watchFor: 'Treating both as binding or both as non-binding.' },
    { term: 'access to justice', definition: 'The ability of individuals to use the legal system, considering cost, complexity and equity.', watchFor: 'Listing barriers without evaluating effectiveness of mechanisms designed to address them.' },
    { term: 'enforceability', definition: 'The capacity of the law to be applied and complied with in practice.', watchFor: 'Conflating enforceability with the existence of a law.' },
  ],

  // ──────────────────────────────────────────────────────────────────
  'Geography': [
    { term: 'ecosystem', definition: 'A community of living organisms interacting with their non-living environment as a system.', watchFor: 'Treating "ecosystem" and "biome" as synonyms.' },
    { term: 'biome', definition: 'A large-scale community of plants and animals adapted to a particular climate.', watchFor: 'Confusing biome with ecosystem (smaller scale) or biosphere (whole Earth).' },
    { term: 'urbanisation', definition: 'The process by which an increasing proportion of a population lives in urban areas.', watchFor: 'Conflating urbanisation with urban growth (absolute increase) or urban sprawl (spatial expansion).' },
    { term: 'sustainability', definition: 'The capacity to meet current needs without compromising future generations\' ability to meet theirs.', watchFor: 'Using "sustainable" loosely without engaging the three pillars (environmental, social, economic).' },
    { term: 'globalisation', definition: 'The increasing interconnection of economies, cultures and populations worldwide.', watchFor: 'Treating globalisation as a purely economic phenomenon.' },
    { term: 'demographic transition', definition: 'A model describing the change from high birth and death rates to low birth and death rates as a society develops.', watchFor: 'Applying the model rigidly; real-world trajectories vary.' },
    { term: 'spatial dimension', definition: 'The geographic distribution and patterns of phenomena across space.', watchFor: 'Describing what exists without analysing why it occurs where it does.' },
    { term: 'environmental change', definition: 'Alterations to natural systems caused by physical processes or human activity.', watchFor: 'Attributing all environmental change to human activity.' },
    { term: 'megacity', definition: 'An urban area with more than 10 million inhabitants.', watchFor: 'Using "megacity" interchangeably with "world city" (which refers to global influence, not size).' },
    { term: 'natural increase vs net migration', definition: 'Natural increase = births − deaths. Net migration = inward − outward migration.', watchFor: 'Attributing population change to one factor without considering the other.' },
  ],

  // ──────────────────────────────────────────────────────────────────
  'Health and Movement Science': [
    { term: 'health', definition: 'A state of complete physical, mental and social wellbeing, not merely the absence of disease (WHO).', watchFor: 'Defining health only as the absence of illness.' },
    { term: 'morbidity vs mortality', definition: 'Morbidity = the prevalence/incidence of disease in a population. Mortality = the rate of deaths.', watchFor: 'Using the two terms interchangeably.' },
    { term: 'prevalence vs incidence', definition: 'Prevalence = total cases at a point in time. Incidence = new cases over a period.', watchFor: 'Using "prevalence" when "incidence" is needed and vice versa.' },
    { term: 'determinants of health', definition: 'The biological, behavioural, sociocultural, socioeconomic and environmental factors that influence health.', watchFor: 'Listing determinants without explaining how they shape outcomes for a specific group.' },
    { term: 'risk factor vs protective factor', definition: 'Risk factors increase likelihood of poor health outcomes; protective factors decrease it.', watchFor: 'Discussing risk factors only; protective factors are equally part of the determinants picture.' },
    { term: 'Sustainable Development Goals', definition: 'The UN\'s 17 goals for global development by 2030, several directly health-related (SDG 3, SDG 5, SDG 10).', watchFor: 'Naming SDGs without applying them to a specific health issue or population.' },
    { term: 'social justice principles', definition: 'Equity, diversity, supportive environments and participation — the values that underpin health promotion.', watchFor: 'Applying social justice as a tick-box rather than analysing trade-offs.' },
    { term: 'health priority', definition: 'A health issue identified for action because of its prevalence, severity, cost or potential for prevention.', watchFor: 'Naming a priority without applying NESA criteria for why it qualifies.' },
    { term: 'aerobic vs anaerobic training', definition: 'Aerobic = sustained activity using oxygen for energy. Anaerobic = short, intense activity using stored energy without oxygen.', watchFor: 'Confusing types of training (aerobic/anaerobic/flexibility) with methods (continuous/interval/circuit).' },
    { term: 'principles of training', definition: 'FITT, progressive overload, specificity, reversibility, variety, training thresholds, warm-up/cool-down.', watchFor: 'Confusing principles with types or methods of training.' },
    { term: 'biomechanics', definition: 'The mechanics of movement — forces, motion and equilibrium applied to the body.', watchFor: 'Describing technique without analysing the underlying mechanical principles.' },
  ],

  // ──────────────────────────────────────────────────────────────────
  'PDHPE': [
    { term: 'health', definition: 'A state of complete physical, mental and social wellbeing, not merely the absence of disease (WHO).', watchFor: 'Defining health only as the absence of illness.' },
    { term: 'Ottawa Charter', definition: 'A 1986 WHO framework for health promotion with five action areas: build healthy public policy; create supportive environments; strengthen community action; develop personal skills; reorient health services.', watchFor: 'Listing the five action areas without applying them to a specific health issue.' },
    { term: 'morbidity vs mortality', definition: 'Morbidity = sickness/disease in a population. Mortality = death.', watchFor: 'Using the two terms interchangeably.' },
    { term: 'prevalence vs incidence', definition: 'Prevalence = total cases at a point in time. Incidence = new cases over a period.', watchFor: 'Using "prevalence" when "incidence" is needed.' },
    { term: 'determinants of health', definition: 'Individual, sociocultural, socioeconomic and environmental factors that shape health.', watchFor: 'Confusing determinants (underlying factors) with risk factors (specific behaviours/exposures).' },
    { term: 'social justice principles', definition: 'Equity, diversity, supportive environments — values underpinning health promotion.', watchFor: 'Naming the principles without applying them to a case.' },
    { term: 'health priority', definition: 'A health issue prioritised in Australia based on prevalence, severity, cost, preventability and ATSI/SES disparity.', watchFor: 'Listing priorities without justifying why they qualify.' },
    { term: 'aerobic vs anaerobic', definition: 'Aerobic = sustained, oxygen-using. Anaerobic = short, intense, without oxygen.', watchFor: 'Confusing aerobic vs anaerobic training with methods (continuous, interval, circuit).' },
    { term: 'FITT principle', definition: 'Frequency, Intensity, Time, Type — variables in designing a training program.', watchFor: 'Listing FITT without applying it to the athlete or context in question.' },
    { term: 'principles vs methods of training', definition: 'Principles = guiding rules (overload, specificity). Methods = how training is delivered (continuous, interval, plyometric).', watchFor: 'Treating methods as principles or vice versa.' },
  ],

  // ─────────────── Stage 4 (Years 7-8) ───────────────────────────────────
  'English Stage 4': [
    { term: 'theme', definition: 'A central idea or message explored in a text.', watchFor: 'Stating the topic ("the theme is friendship") instead of the idea explored about it ("the text suggests friendship is conditional").' },
    { term: 'character', definition: 'A person, animal or being in a text — constructed by the composer through language and action.', watchFor: 'Describing what a character does rather than how they are constructed.' },
    { term: 'setting', definition: 'The time and place in which a text is set; can be physical, social or imagined.', watchFor: 'Listing where the story happens without considering how setting shapes mood or meaning.' },
    { term: 'composer', definition: 'The writer, director or maker of a text.', watchFor: 'Using "author" inconsistently — "composer" works for any text type (novels, films, poems).' },
    { term: 'imagery', definition: 'Language that creates a sensory picture in the reader\'s mind.', watchFor: 'Using "imagery" as a catch-all for any descriptive language without identifying the specific sense engaged.' },
    { term: 'simile', definition: 'A comparison using "like" or "as" (e.g. "as cold as ice").', watchFor: 'Identifying similes without explaining what the comparison reveals.' },
    { term: 'metaphor', definition: 'A direct comparison saying one thing IS another (e.g. "time is a thief").', watchFor: 'Confusing metaphor with simile — metaphors don\'t use "like" or "as".' },
    { term: 'personification', definition: 'Giving human qualities to a non-human thing.', watchFor: 'Identifying personification without saying what effect it creates.' },
    { term: 'narrative voice', definition: 'Who is telling the story — first person (I) or third person (he/she/they).', watchFor: 'Mixing up narrator with author.' },
  ],

  'Mathematics Stage 4': [
    { term: 'pronumeral', definition: 'A letter that represents an unknown or variable number (e.g. x, y).', watchFor: 'Treating pronumerals as fixed numbers rather than placeholders.' },
    { term: 'equation', definition: 'A statement that two expressions are equal (uses an = sign).', watchFor: 'Confusing equations (have =) with expressions (don\'t).' },
    { term: 'integer', definition: 'A whole number — positive, negative or zero — with no fraction or decimal.', watchFor: 'Including fractions or decimals as integers.' },
    { term: 'factor / multiple', definition: 'A factor divides into a number exactly. A multiple is what you get by multiplying.', watchFor: 'Confusing the two — 3 is a factor of 12; 12 is a multiple of 3.' },
    { term: 'perimeter / area / volume', definition: 'Perimeter = distance around (units of length). Area = surface (units²). Volume = space inside (units³).', watchFor: 'Using the wrong unit (e.g. cm for area, where cm² is required).' },
    { term: 'angle types', definition: 'Acute (<90°), right (=90°), obtuse (>90° and <180°), straight (=180°), reflex (>180°).', watchFor: 'Confusing acute and obtuse.' },
    { term: 'mean / median / mode', definition: 'Mean = average. Median = middle value. Mode = most frequent.', watchFor: 'Using them interchangeably or computing the wrong one for the question asked.' },
  ],

  'Science Stage 4': [
    { term: 'hypothesis', definition: 'A testable prediction about what will happen, usually in an "if/then" form.', watchFor: 'Writing a vague guess instead of a clear, testable statement.' },
    { term: 'variable', definition: 'Something that can change in an investigation. Independent = what you change. Dependent = what you measure. Controlled = what you keep the same.', watchFor: 'Mixing up independent and dependent variables.' },
    { term: 'observation vs inference', definition: 'Observation = what you see/measure. Inference = a conclusion drawn from observations.', watchFor: 'Calling an inference an observation.' },
    { term: 'fair test', definition: 'An investigation where only the independent variable changes; all other variables are controlled.', watchFor: 'Using the phrase without identifying which variables were controlled.' },
    { term: 'classification', definition: 'Sorting living things or substances into groups based on shared features.', watchFor: 'Naming features without using them to classify, or vice versa.' },
    { term: 'physical vs chemical change', definition: 'Physical = reversible, same substance (e.g. melting). Chemical = new substance formed (e.g. burning).', watchFor: 'Calling a chemical change physical because the substance "looks different".' },
    { term: 'force', definition: 'A push or pull, measured in newtons (N). Has direction and magnitude.', watchFor: 'Treating force as energy or motion.' },
  ],

  'HSIE Stage 4': [
    { term: 'source', definition: 'Any material used to find out about the past or a place — primary (from the time/place) or secondary (interpretation of it).', watchFor: 'Listing sources without explaining how they help answer the question.' },
    { term: 'primary vs secondary source', definition: 'Primary = from the time/place under study. Secondary = produced later, interpreting primary sources.', watchFor: 'Calling a textbook a primary source.' },
    { term: 'cause and effect', definition: 'A cause makes something happen; an effect is what happens as a result.', watchFor: 'Confusing the two — a cause comes BEFORE; an effect comes AFTER.' },
    { term: 'continuity and change', definition: 'Continuity = things that stay the same over time. Change = things that are different.', watchFor: 'Discussing only change and ignoring what stayed the same.' },
    { term: 'perspective', definition: 'A point of view shaped by who someone is, when they lived, and what they experienced.', watchFor: 'Treating "perspective" as identical to "opinion".' },
    { term: 'environment', definition: 'In Geography: the surroundings (natural and built) that affect and are affected by people.', watchFor: 'Using "environment" only to mean "nature".' },
    { term: 'sustainability', definition: 'Meeting present needs without harming the ability of future generations to meet theirs.', watchFor: 'Using "sustainable" loosely to mean "good for the environment".' },
  ],

  'PDHPE Stage 4': [
    { term: 'dimensions of health', definition: 'Physical, social, emotional, mental and spiritual — health is more than just physical.', watchFor: 'Only discussing physical health when the question implies multiple dimensions.' },
    { term: 'identity', definition: 'Who someone is — shaped by family, culture, experiences and choices.', watchFor: 'Confusing identity with self-esteem (how someone feels about themselves).' },
    { term: 'wellbeing', definition: 'A state of feeling well across all dimensions of health.', watchFor: 'Treating wellbeing as synonymous with happiness.' },
    { term: 'resilience', definition: 'The ability to recover from setbacks, adapt to change, and keep going.', watchFor: 'Using "resilience" as a fix-all without describing what builds it.' },
    { term: 'movement skill', definition: 'A specific physical action — locomotor (running), object (catching), or balance.', watchFor: 'Confusing skills with sports — "soccer" is not a skill; "kicking" is.' },
    { term: 'fundamental movement skills (FMS)', definition: 'Core skills like running, jumping, throwing, catching that underpin all sport and physical activity.', watchFor: 'Listing FMS without applying them to the activity being discussed.' },
    { term: 'risk vs safety', definition: 'Risk = chance of harm. Safety = strategies to reduce that chance.', watchFor: 'Treating any new activity as "risky" without considering specific risks and how they\'re managed.' },
  ],

  // ─────────────── Stage 5 (Years 9-10) ──────────────────────────────────
  'English Stage 5': [
    { term: 'analysis', definition: 'Identifying components of a text (techniques, structure, choices) and explaining how they work together to create meaning.', watchFor: 'Naming techniques without explaining effect (which is identification, not analysis).' },
    { term: 'composer / responder', definition: 'Composer = who made the text. Responder = who reads, views or listens.', watchFor: 'Using "author" or "viewer" instead of the precise terms.' },
    { term: 'theme', definition: 'A central idea or concern explored in a text.', watchFor: 'Naming a topic ("love") rather than the idea ("the text presents love as conditional on sacrifice").' },
    { term: 'context', definition: 'The historical, cultural, social or personal circumstances that shape a text or its reception.', watchFor: 'Listing biographical facts disconnected from the text\'s meaning.' },
    { term: 'representation', definition: 'How ideas, people, events or values are constructed through textual choices.', watchFor: 'Discussing WHAT is represented rather than HOW.' },
    { term: 'voice', definition: 'The distinctive way a speaker, narrator or persona expresses ideas — through diction, syntax, tone.', watchFor: 'Confusing voice with the composer\'s personal opinion.' },
    { term: 'tone', definition: 'The composer\'s attitude toward the subject or audience.', watchFor: 'Naming a tone without quoting the language that creates it.' },
    { term: 'irony', definition: 'A gap between what is said/expected and what is meant/occurs (verbal, situational, dramatic).', watchFor: 'Calling something ironic when it is merely contrasting.' },
    { term: 'symbol / motif', definition: 'Symbol = something representing an idea beyond literal meaning. Motif = a recurring image, idea or pattern.', watchFor: 'Identifying a symbol without explaining what it represents and why that matters.' },
    { term: 'thesis', definition: 'The central interpretive argument of a response — a position you can defend.', watchFor: 'Mechanical statements like "This essay will discuss..." instead of taking a position.' },
  ],

  'Mathematics Stage 5': [
    { term: 'equation vs expression', definition: 'Equation contains "=". Expression is a value or relationship without an equals sign.', watchFor: 'Treating an expression as something to "solve" — you can only solve an equation.' },
    { term: 'function', definition: 'A relationship that assigns each input one output — written as f(x) or y = ...', watchFor: 'Calling something a function when one input produces multiple outputs.' },
    { term: 'rate vs ratio', definition: 'Ratio compares like quantities (3 boys : 2 girls). Rate compares unlike quantities (60 km : 1 hour).', watchFor: 'Using them interchangeably; rate always involves units.' },
    { term: 'percentage change', definition: '(new − old) / old × 100. Increase if positive, decrease if negative.', watchFor: 'Using the new value as the denominator instead of the original.' },
    { term: 'similarity vs congruence', definition: 'Similar = same shape, different size (proportional). Congruent = same shape and size.', watchFor: 'Calling congruent figures similar or vice versa.' },
    { term: 'Pythagoras vs trig', definition: 'Pythagoras gives side lengths from two known sides (right-angled). Trig (sin, cos, tan) relates sides to angles.', watchFor: 'Reaching for trig when Pythagoras would work, or vice versa.' },
    { term: 'mean / median / range', definition: 'Mean = average. Median = middle value when ordered. Range = max minus min. Each gives different information.', watchFor: 'Using "average" without specifying which measure of centre is being calculated.' },
    { term: 'probability', definition: 'A number between 0 and 1 representing the likelihood of an event.', watchFor: 'Expressing probability as a number greater than 1 or as a percentage that doesn\'t match the fraction.' },
  ],

  'Science Stage 5': [
    { term: 'valid vs reliable', definition: 'Valid = measures what you intended. Reliable = consistent results when repeated.', watchFor: 'Treating them as the same thing.' },
    { term: 'accuracy vs precision', definition: 'Accuracy = closeness to the true value. Precision = consistency of repeated measurements.', watchFor: 'Confusing the two — you can be precise but inaccurate.' },
    { term: 'hypothesis', definition: 'A testable, falsifiable prediction.', watchFor: 'Writing untestable opinions as hypotheses.' },
    { term: 'controlled variable', definition: 'A variable kept the same so it doesn\'t affect the experiment.', watchFor: 'Naming controlled variables without explaining why they matter.' },
    { term: 'inference vs conclusion', definition: 'Inference = explanation based on evidence. Conclusion = what the data tells you about the hypothesis.', watchFor: 'Drawing a conclusion that ignores or contradicts the data.' },
    { term: 'correlation vs causation', definition: 'Correlation = two things change together. Causation = one causes the other.', watchFor: 'Claiming causation from correlation without controlling for other variables.' },
    { term: 'qualitative vs quantitative data', definition: 'Quantitative = numbers, measurements. Qualitative = descriptions, observations.', watchFor: 'Treating qualitative data as less rigorous; both have a place.' },
    { term: 'systematic error', definition: 'A consistent error in the same direction (e.g. an instrument always reads 0.5 too high).', watchFor: 'Confusing systematic with random error.' },
    { term: 'theory vs hypothesis', definition: 'Hypothesis = testable prediction for one investigation. Theory = well-supported explanation, refined over many investigations.', watchFor: 'Using "theory" loosely to mean "guess".' },
  ],

  'HSIE Stage 5': [
    { term: 'source analysis', definition: 'Examining origin, perspective, reliability and usefulness of a source for a specific question.', watchFor: 'Describing a source without analysing its perspective or limitations.' },
    { term: 'reliability vs usefulness', definition: 'Reliability = how trustworthy the source is. Usefulness = how well it helps answer the question (may be useful even if biased).', watchFor: 'Dismissing a source as biased without considering what it usefully reveals.' },
    { term: 'significance', definition: 'How important an event/person/process is in terms of lasting impact, scale of change, or relevance today.', watchFor: 'Equating significance with size or recency.' },
    { term: 'continuity and change', definition: 'What stays the same and what shifts over time.', watchFor: 'Discussing only change and ignoring continuity (or vice versa).' },
    { term: 'cause and effect', definition: 'A causal explanation — why something happened and what followed.', watchFor: 'Listing events chronologically without explaining the causal links.' },
    { term: 'perspective', definition: 'A point of view shaped by historical, cultural, or social context. Different groups see the same event differently.', watchFor: 'Treating perspective as opinion; perspectives are evidenced and contextual.' },
    { term: 'environment / sustainability', definition: 'In Geography: the surroundings shaped by and shaping human activity. Sustainability = meeting needs now without compromising future generations.', watchFor: 'Using "sustainability" as a buzzword without explaining what trade-off is being managed.' },
    { term: 'spatial pattern / process', definition: 'Pattern = the way features are distributed. Process = the forces that produce or change patterns.', watchFor: 'Describing a pattern without explaining the process behind it.' },
    { term: 'globalisation', definition: 'The increasing interconnection of countries through trade, technology, culture and migration.', watchFor: 'Using "globalisation" as a single force; it has different impacts on different groups.' },
  ],

  'PDHPE Stage 5': [
    { term: 'health-promotion frameworks', definition: 'Tools like the Ottawa Charter that guide action on health — applied to a context, not just listed.', watchFor: 'Naming the Ottawa Charter\'s five action areas without applying them to the specific issue.' },
    { term: 'determinants of health', definition: 'Factors that influence health outcomes — individual, social, economic, environmental.', watchFor: 'Listing determinants without connecting them to specific health outcomes.' },
    { term: 'modifiable vs non-modifiable factors', definition: 'Modifiable = can be changed (e.g. diet, activity). Non-modifiable = cannot (e.g. age, genetics).', watchFor: 'Proposing strategies that target non-modifiable factors.' },
    { term: 'equity vs equality', definition: 'Equality = everyone gets the same. Equity = everyone gets what they need to reach the same outcome.', watchFor: 'Proposing health strategies that are "equal" but not "equitable" — same support for very different needs.' },
    { term: 'health inequities', definition: 'Differences in health outcomes between groups that are avoidable and unfair.', watchFor: 'Treating health differences as natural without considering the social structures that produce them.' },
    { term: 'wellbeing', definition: 'A holistic state — physical, social, emotional, mental, spiritual.', watchFor: 'Discussing wellbeing only in physical terms.' },
    { term: 'agency', definition: 'The capacity to make decisions and act on them — shaped by individual resources and context.', watchFor: 'Treating agency as purely individual responsibility, ignoring structural constraints.' },
    { term: 'skill-related vs health-related fitness', definition: 'Health-related = aerobic capacity, strength, flexibility, body composition, muscular endurance. Skill-related = balance, agility, coordination, power, speed, reaction time.', watchFor: 'Mixing the two when designing a program for a specific goal.' },
  ],
};

/**
 * Course-name aliases. When the front-end course label doesn't exactly
 * match a glossary key, look here first.
 */
const COURSE_ALIASES: Record<string, string> = {
  'Mathematics Standard 2': 'Mathematics Advanced',
  'Mathematics Standard 1': 'Mathematics Advanced',
  'Mathematics Extension 1': 'Mathematics Advanced',
  'Mathematics Extension 2': 'Mathematics Advanced',
  'English Extension 1': 'English Advanced',
  'English Extension 2': 'English Advanced',
  'English EAL/D': 'English Standard',
  'English Studies': 'English Standard',
  'Investigating Science': 'Biology',
  'Earth and Environmental Science': 'Biology',
  'Science Extension': 'Biology',
  'History Extension': 'Modern History',
  'Community and Family Studies': 'PDHPE',
};

// Map "Year N Subject" to its Stage 4 or Stage 5 glossary key.
// Year 7-8 = Stage 4; Year 9-10 = Stage 5.
// Subjects in HSIE (History, Geography, Commerce, etc.) all map to "HSIE Stage N".
function mapYearCourseToStageKey(courseName: string): string | null {
  const m = courseName.match(/^Year\s+(\d{1,2})\s+(.+)$/i);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const subject = m[2].trim();
  const stage = (year >= 7 && year <= 8) ? 4 : (year >= 9 && year <= 10) ? 5 : null;
  if (!stage) return null;

  // Discipline-based bucketing for HSIE subjects
  const hsieSubjects = new Set([
    'History', 'Geography', 'Commerce', 'Aboriginal Studies',
  ]);
  // Creative Arts subjects bucket
  const caSubjects = new Set([
    'Music', 'Visual Arts', 'Drama', 'Photography and Digital Media',
  ]);
  // TAS subjects bucket
  const tasSubjects = new Set([
    'Technology Mandatory', 'Design and Technology', 'Food Technology',
    'Industrial Technology', 'Information and Software Technology',
    'Marine and Aquaculture Technology', 'Textiles Technology',
  ]);

  if (hsieSubjects.has(subject)) return `HSIE Stage ${stage}`;
  if (caSubjects.has(subject))   return `Creative Arts Stage ${stage}`;
  if (tasSubjects.has(subject))  return `TAS Stage ${stage}`;
  return `${subject} Stage ${stage}`;
}

export function getSubjectGlossary(courseName: string | null | undefined): GlossaryEntry[] | null {
  if (!courseName) return null;
  if (SUBJECT_GLOSSARIES[courseName]) return SUBJECT_GLOSSARIES[courseName];
  const aliased = COURSE_ALIASES[courseName];
  if (aliased && SUBJECT_GLOSSARIES[aliased]) return SUBJECT_GLOSSARIES[aliased];
  const stageKey = mapYearCourseToStageKey(courseName);
  if (stageKey && SUBJECT_GLOSSARIES[stageKey]) return SUBJECT_GLOSSARIES[stageKey];
  return null;
}
