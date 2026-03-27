/**
 * Test the feedback engine against a sample PDHPE student response.
 *
 * This uses a fabricated mid-range (Band 3-4) response to a Core 1 question.
 * The response is deliberately flawed in realistic ways:
 * - Describes instead of analysing (wrong verb depth)
 * - Lacks specific Australian statistics
 * - Mentions the Ottawa Charter but doesn't apply it properly
 * - Has some relevant content but poor structure
 *
 * Run: npm run test-feedback
 * Requires: ANTHROPIC_API_KEY in .env file
 */

import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt, buildUserPrompt } from "../prompts/feedback-system.js";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env manually (no extra dependency)
try {
  const envPath = resolve(__dirname, "../.env");
  const envFile = readFileSync(envPath, "utf-8");
  for (const line of envFile.split("\n")) {
    const [key, ...rest] = line.split("=");
    if (key && rest.length > 0) {
      process.env[key.trim()] = rest.join("=").trim();
    }
  }
} catch {
  // .env file might not exist if key is set via environment
}

// --- SAMPLE ASSESSMENT TASK ---

const sampleTask = {
  taskDescription: `HSC PDHPE Core 1: Health Priorities in Australia

Question (8 marks):
Analyse how the Ottawa Charter can be used to address cardiovascular disease (CVD) as a health priority in Australia.`,

  taskVerb: "analyse",

  outcomes: ["H1", "H4", "H5", "H16"],

  criteria: [
    {
      name: "Knowledge and understanding of CVD as a health priority",
      description:
        "Demonstrates understanding of why CVD is a health priority in Australia, including relevant epidemiological data, trends, and groups most at risk.",
      maxMarks: 2,
    },
    {
      name: "Application of the Ottawa Charter",
      description:
        "Applies the five action areas of the Ottawa Charter specifically to CVD, demonstrating understanding of how each area can address CVD.",
      maxMarks: 3,
    },
    {
      name: "Analysis and critical thinking",
      description:
        "Identifies components and relationships between Ottawa Charter strategies and CVD outcomes. Draws out implications rather than merely describing.",
      maxMarks: 2,
    },
    {
      name: "Communication and use of examples",
      description:
        "Communicates ideas clearly with logical structure. Uses specific, relevant Australian examples and data to support arguments.",
      maxMarks: 1,
    },
  ],
};

// --- SAMPLE STUDENT RESPONSE ---
// Deliberately mid-range (Band 3-4 quality):
// - Some relevant knowledge but superficial
// - Mentions Ottawa Charter areas but describes rather than analyses
// - Lacks specific statistics
// - Generic examples
// - Structure is okay but not strong

const sampleStudentResponse = `Cardiovascular disease is one of the biggest health problems in Australia. It includes things like heart attacks and strokes. Many Australians die from CVD every year and it is a major cause of death. The government has identified it as a health priority because so many people are affected by it.

The Ottawa Charter for Health Promotion has five action areas that can be used to address CVD. These are developing personal skills, creating supportive environments, strengthening community action, reorienting health services and building healthy public policy.

Developing personal skills means educating people about how to live healthier. For CVD this could include teaching people about healthy eating and exercise. If people know more about the risk factors for CVD they can make better choices about their health.

Creating supportive environments means making the places where people live and work healthier. For example, workplaces could have healthy food options in the canteen and encourage employees to be active. Parks and bike paths also help people exercise more.

Strengthening community action means getting communities involved in health promotion. Community groups could run programs like fun runs or health checks. This helps people in the community to support each other in being healthy.

Reorienting health services means changing the focus of health services from treatment to prevention. Doctors could focus more on giving patients advice about preventing CVD rather than just treating it after they get sick. Health checks and screening programs can help identify people at risk early.

Building healthy public policy means governments making laws and policies that promote health. For CVD this could include things like taxes on cigarettes and junk food, and laws about food labelling so people know what they are eating.

In conclusion, the Ottawa Charter provides a good framework for addressing CVD in Australia through all five action areas working together.`;

// --- RUN THE EVALUATION ---

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Error: ANTHROPIC_API_KEY not found. Create a .env file with your key.");
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt({
    ...sampleTask,
    studentText: sampleStudentResponse,
  });

  console.log("=== NESA Feedback Engine Test ===\n");
  console.log(`Task: ${sampleTask.taskDescription.split("\n")[0]}`);
  console.log(`Task verb: "${sampleTask.taskVerb}"`);
  console.log(`Student response: ${sampleStudentResponse.split(" ").length} words\n`);
  console.log("Generating feedback...\n");

  const startTime = Date.now();

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    temperature: 0.2, // Low temp for consistency
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const latencyMs = Date.now() - startTime;
  const outputText =
    response.content[0].type === "text" ? response.content[0].text : "";

  console.log("=== RAW FEEDBACK OUTPUT ===\n");
  console.log(outputText);
  console.log("\n=== METADATA ===");
  console.log(`Model: ${response.model}`);
  console.log(`Latency: ${latencyMs}ms`);
  console.log(
    `Tokens — input: ${response.usage.input_tokens}, output: ${response.usage.output_tokens}`
  );
  console.log(
    `Estimated cost: $${(
      (response.usage.input_tokens * 3) / 1_000_000 +
      (response.usage.output_tokens * 15) / 1_000_000
    ).toFixed(4)}`
  );

  // Try to parse the JSON and pretty-print a summary
  try {
    const jsonMatch = outputText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const feedback = JSON.parse(jsonMatch[0]);

      console.log("\n=== SUMMARY ===");

      console.log("\n--- What you've done well ---");
      for (const point of feedback.what_youve_done_well ?? []) {
        console.log(`  ✓ ${point}`);
      }

      console.log("\n--- Task verb check ---");
      console.log(`  ${feedback.task_verb_check}`);

      console.log("\n--- Improvements needed ---");
      for (const [i, point] of (feedback.improvements ?? []).entries()) {
        console.log(`  ${i + 1}. ${point}`);
      }

      console.log("\n--- Overall ---");
      console.log(`  ${feedback.overall}`);

      console.log("\n--- Top priority ---");
      console.log(`  ${feedback.top_priority}`);

      console.log("\n--- What a strong response includes ---");
      for (const point of feedback.what_a_strong_response_includes ?? []) {
        console.log(`  • ${point}`);
      }
    }
  } catch {
    console.log("\n(Could not parse JSON from response — check raw output above)");
  }
}

main().catch(console.error);
