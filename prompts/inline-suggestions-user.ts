interface InlineSuggestionsUserInput {
  taskDescription: string;
  taskVerbs?: string[];
  studentText: string;
  holisticImprovements: string[];
}

export function buildInlineSuggestionsUserPrompt(input: InlineSuggestionsUserInput): string {
  const verbLine = input.taskVerbs && input.taskVerbs.length > 0
    ? `KEY TERM${input.taskVerbs.length > 1 ? 'S' : ''}: ${input.taskVerbs.join(', ')}\n\n`
    : '';

  const improvementsBlock = input.holisticImprovements.length > 0
    ? input.holisticImprovements.map((s, i) => `[${i}] ${s}`).join('\n')
    : '(none — the holistic pass did not list specific improvements)';

  return `ASSESSMENT TASK:
${input.taskDescription}

${verbLine}HOLISTIC FEEDBACK YOU JUST WROTE — improvements identified (use these 0-based indices for linked_improvement_index):
${improvementsBlock}

---

STUDENT'S DRAFT (annotate this):
${input.studentText}

---

Produce inline annotations. Exact quotes only, 4-25 words each. Up to 20 annotations, prioritised by impact. Include strengths as well as issues. Tie each annotation to a holistic improvement index where applicable (null otherwise). Return JSON only — no prose outside the JSON object.`;
}
