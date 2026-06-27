/**
 * Calibration fixtures for take-home feedback — a small spread of answers per
 * question across demonstrated levels (emerging → borderline → strong), so we
 * can SEE whether a prompt change improves the weak-band feedback (plainer
 * register, fewer/blunter steps) without flattening the strong-band feedback.
 *
 * Run: npm run calibrate-feedback
 *
 * Real PDHPE Year 8 answers (the emerging/strong ones are the actual samples
 * from testing); the borderline + extended cases are hand-written to stress the
 * C/B boundary and the extended-response (holistic) path.
 */

export interface CalibrationFixture {
  label: string;                 // e.g. "Q1 · emerging"
  level: 'emerging' | 'borderline' | 'strong';
  course: string;
  yearLevel: number;
  question: {
    id: string;
    type: 'text';
    text: string;
    marks: number;
    criteria_text?: string;
  };
  answer: string;
}

const Q1 = {
  id: 'fix-q1',
  type: 'text' as const,
  text: "Identify two factors that can influence a young person's food choices, and explain how one of these factors might affect their diet.",
  marks: 3,
  criteria_text: '3 — Identifies two correct factors and clearly explains how one factor affects diet, with a relevant example.\n2 — Identifies two factors with a basic explanation, OR identifies one factor with a clear explanation.\n1 — Identifies at least one relevant factor.',
};

const Q2 = {
  id: 'fix-q2',
  type: 'text' as const,
  text: 'Describe one strategy a young person could use to stay safe online, and outline why it is effective.',
  marks: 4,
};

const Q3 = {
  id: 'fix-q3',
  type: 'text' as const,
  text: "Explain how regular physical activity benefits a young person's physical and mental wellbeing. Refer to at least one benefit for each.",
  marks: 5,
};

// An extended-response question to exercise the holistic (Sonnet three-pass) path.
const Q4 = {
  id: 'fix-q4',
  type: 'text' as const,
  text: 'Analyse how a young person\'s social environment can shape their health behaviours. Refer to specific influences in your response.',
  marks: 10,
  criteria_text: 'Analyses (not just describes) how social influences shape health behaviours, with specific, well-chosen examples and clear links to outcomes.',
};

export const FIXTURES: CalibrationFixture[] = [
  {
    label: 'Q1 · emerging', level: 'emerging', course: 'Year 8 PDHPE', yearLevel: 8, question: Q1,
    answer: 'Two things that affect food choices are family and money. Some families eat certain foods because of their culture or what their parents buy. Money affects diet because if a family does not have much money they might buy cheaper food like takeaway instead of fresh fruit and vegetables.',
  },
  {
    label: 'Q1 · borderline', level: 'borderline', course: 'Year 8 PDHPE', yearLevel: 8, question: Q1,
    answer: 'Two factors are family and advertising. Family affects diet because the food parents buy is what the young person eats, so if parents buy healthy food the young person eats healthier. Advertising is the other factor.',
  },
  {
    label: 'Q1 · strong', level: 'strong', course: 'Year 8 PDHPE', yearLevel: 8, question: Q1,
    answer: "Two factors that influence a young person's food choices are family habits and advertising. Family habits affect diet because the meals a young person grows up eating often become their normal choices. For example, if a family regularly cooks meals with vegetables and prepares food at home, the young person is more likely to choose balanced, home-cooked meals themselves. On the other hand, if a household relies heavily on takeaway, the young person may develop a diet high in salt, fat and sugar, which over time can affect their energy levels and long-term health.",
  },
  {
    label: 'Q2 · emerging', level: 'emerging', course: 'Year 8 PDHPE', yearLevel: 8, question: Q2,
    answer: 'One strategy is to make your accounts private. This is good because then strangers cannot see your profile or message you. It keeps you safe because only people you know can see your stuff.',
  },
  {
    label: 'Q2 · strong', level: 'strong', course: 'Year 8 PDHPE', yearLevel: 8, question: Q2,
    answer: 'One effective strategy for staying safe online is setting your social media accounts to private and only accepting requests from people you know in real life. This is effective because it controls who can see your personal information, photos and location. Strangers and potential predators are unable to view your profile or contact you directly, which reduces the risk of grooming, scams or your information being misused.',
  },
  {
    label: 'Q3 · emerging', level: 'emerging', course: 'Year 8 PDHPE', yearLevel: 8, question: Q3,
    answer: 'Physical activity is good for your body because it makes your muscles stronger and helps your heart. It also helps your mental health because exercise can make you feel happier and less stressed. So being active is good for you in lots of ways.',
  },
  {
    label: 'Q3 · strong', level: 'strong', course: 'Year 8 PDHPE', yearLevel: 8, question: Q3,
    answer: 'Regular physical activity benefits both physical and mental wellbeing. Physically, it strengthens the heart and improves fitness, because activities like running or playing sport make the heart pump faster and become more efficient over time. Mentally, physical activity improves mood and reduces stress, because exercise releases endorphins, which are chemicals that make a person feel happier and more relaxed. For example, going for a run after a stressful day at school can clear a person\'s mind and help them sleep better.',
  },
  {
    label: 'Q4 · extended/borderline', level: 'borderline', course: 'Year 8 PDHPE', yearLevel: 8, question: Q4,
    answer: 'A young person\'s social environment can shape their health behaviours in a few ways. Their friends are a big influence because if their friends play sport then they might play sport too, and if their friends vape they might try it. Family also matters because parents set rules and buy the food. Social media is another influence because young people see what others are doing and want to copy it. So the people around a young person affect the choices they make about their health.',
  },
];
