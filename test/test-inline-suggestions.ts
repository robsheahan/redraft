/**
 * Test Pass 3 (inline annotations) in isolation against a sample draft.
 *
 * Reuses the sample response from evaluate-sample.ts so you can eyeball the
 * margin notes Claude produces without running the full API stack.
 *
 * Run: npx tsx test/test-inline-suggestions.ts
 * Requires: ANTHROPIC_API_KEY in .env file
 */

import Anthropic from "@anthropic-ai/sdk";
import { generateInlineSuggestions } from "../lib/generate-inline-suggestions.js";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

try {
  const envFile = readFileSync(resolve(__dirname, "../.env"), "utf-8");
  for (const line of envFile.split("\n")) {
    const [key, ...rest] = line.split("=");
    if (key && rest.length > 0) process.env[key.trim()] = rest.join("=").trim();
  }
} catch { /* .env optional */ }

const sampleTaskDescription = `HSC PDHPE Core 1: Health Priorities in Australia

Question (8 marks):
Analyse how the Ottawa Charter can be used to address cardiovascular disease (CVD) as a health priority in Australia.`;

const sampleDraft = `Cardiovascular disease is one of the biggest health problems in Australia. It includes things like heart attacks and strokes. Many Australians die from CVD every year and it is a major cause of death. The government has identified it as a health priority because so many people are affected by it.

The Ottawa Charter for Health Promotion has five action areas that can be used to address CVD. These are developing personal skills, creating supportive environments, strengthening community action, reorienting health services and building healthy public policy.

Developing personal skills means educating people about how to live healthier. For CVD this could include teaching people about healthy eating and exercise. If people know more about the risk factors for CVD they can make better choices about their health.

Creating supportive environments means making the places where people live and work healthier. For example, workplaces could have healthy food options in the canteen and encourage employees to be active. Parks and bike paths also help people exercise more.

Strengthening community action means getting communities involved in health promotion. Community groups could run programs like fun runs or health checks. This helps people in the community to support each other in being healthy.

Reorienting health services means changing the focus of health services from treatment to prevention. Doctors could focus more on giving patients advice about preventing CVD rather than just treating it after they get sick. Health checks and screening programs can help identify people at risk early.

Building healthy public policy means governments making laws and policies that promote health. For CVD this could include things like taxes on cigarettes and junk food, and laws about food labelling so people know what they are eating.

In conclusion, the Ottawa Charter provides a good framework for addressing CVD in Australia through all five action areas working together.`;

// Pass 1 improvements that Pass 3 would see in the real pipeline.
// Paraphrased from typical Pass 1 output on this draft so Pass 3 can link
// annotations back to them.
const sampleHolisticImprovements = [
  "Response describes the Ottawa Charter action areas but doesn't analyse — add cause-effect links showing HOW each strategy reduces CVD.",
  "Missing specific Australian statistics (prevalence, mortality, at-risk groups) — anchor claims in real data.",
  "Examples are generic (fun runs, healthy canteens). Use specific Australian programs or campaigns.",
  "Introduction doesn't establish why CVD is a priority in measurable terms — add data on burden of disease.",
  "Conclusion restates rather than evaluates — draw out implications of applying the Charter.",
];

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Error: ANTHROPIC_API_KEY not found. Create a .env file with your key.");
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });

  console.log("=== Pass 3 (Inline Annotations) Test ===\n");
  console.log(`Draft: ${sampleDraft.split(/\s+/).length} words`);
  console.log(`Holistic improvements given: ${sampleHolisticImprovements.length}\n`);
  console.log("Calling Claude...\n");

  const start = Date.now();
  const result = await generateInlineSuggestions(client, {
    taskDescription: sampleTaskDescription,
    taskVerbs: ["analyse"],
    studentText: sampleDraft,
    holisticImprovements: sampleHolisticImprovements,
    courseName: "PDHPE",
    discipline: "PDHPE",
  });
  const ms = Date.now() - start;

  console.log(`Latency: ${ms}ms`);
  if (!result.ok) {
    console.error(`Claude call failed: ${result.error}`);
    process.exit(1);
  }
  const annotations = result.annotations;
  console.log(`Annotations returned: ${annotations.length}\n`);

  if (annotations.length === 0) {
    console.log("No annotations came through. Check the logs above for validation failures.");
    return;
  }

  // Sanity check: every quote appears exactly where the server says it does.
  let verifyOk = true;
  for (const a of annotations) {
    const slice = sampleDraft.slice(a.start, a.end);
    if (slice !== a.quote) {
      console.error(`  FAIL: annotation quote does not match draft at offset ${a.start}`);
      console.error(`    expected: ${JSON.stringify(a.quote)}`);
      console.error(`    found:    ${JSON.stringify(slice)}`);
      verifyOk = false;
    }
  }
  console.log(verifyOk ? "Position verification: ok\n" : "Position verification: FAIL\n");

  // Print each annotation for eyeballing
  annotations.forEach((a, i) => {
    const linkStr = a.linked_improvement_index !== null
      ? ` [→ improvement ${a.linked_improvement_index + 1}]`
      : "";
    console.log(`${i + 1}. [${a.category}]${linkStr}`);
    console.log(`   "${a.quote}"`);
    console.log(`   ${a.comment}\n`);
  });

  // Category distribution
  const byCategory: Record<string, number> = {};
  annotations.forEach(a => { byCategory[a.category] = (byCategory[a.category] || 0) + 1; });
  console.log("Category distribution:");
  Object.entries(byCategory).forEach(([cat, n]) => console.log(`  ${cat}: ${n}`));
}

main().catch(console.error);
