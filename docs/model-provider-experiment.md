# Model provider experiment

ProofReady can route its structured AI workloads to Anthropic or OpenAI without
changing endpoint code. Anthropic remains the default until the provider
variables are deliberately changed.

## Configuration

Required keys for an A/B comparison:

```text
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
```

Routing is split by workload tier:

```text
AI_PRIMARY_PROVIDER=anthropic   # anthropic | openai
AI_FAST_PROVIDER=anthropic      # anthropic | openai
OPENAI_PRIMARY_MODEL=gpt-5.6-terra
OPENAI_FAST_MODEL=gpt-5.4-nano
```

- **Primary** is the existing Sonnet-class path: student-facing feedback,
  criteria feedback, insights, profiles, differentiation and authoring.
- **Fast** is the existing Haiku-class path: silent insights signals and maths
  working structuring.

The two tiers can be switched independently. For example, start by routing
only fast/background calls to OpenAI while leaving student-facing feedback on
Anthropic.

The OpenAI path uses the Responses API with `store: false`. Existing Anthropic
tool schemas are sent as function schemas. They currently use non-strict
function calling because some ProofReady schemas intentionally have optional
fields; the same required-field validation used by the Anthropic path runs
before a result can be persisted.

## Blind comparison

Run the existing calibration corpus through both providers:

```bash
npm run compare-providers
```

For a cheaper smoke comparison:

```bash
npm run compare-providers -- --limit=2
```

The command writes a randomised `outputs.json` and a separate
`answer-key.json` under `/tmp`. Score the outputs before opening the key. The
scorecard covers correctness, rubric grounding, marker voice, actionability,
and fidelity to evidence in the student's draft.

## Suggested rollout

1. Run 2 fixtures to verify credentials and schema compatibility.
2. Run the complete calibration set and score it blind.
3. Add de-identified examples covering English, humanities and Mathematics.
4. Switch `AI_FAST_PROVIDER` first if its results are acceptable.
5. Switch `AI_PRIMARY_PROVIDER` only after student-facing feedback clears the
   agreed quality threshold.
6. Pin explicit model versions before broader school use, after the chosen
   models and prompts are stable.

## Current boundary

The deterministic maths equivalence-check loop in
`api/generate-maths-feedback.ts` remains Anthropic-specific. It is an agentic
multi-turn tool loop rather than a single structured generation. All other
production model calls in `api/` and `lib/` route through the provider layer.
During an OpenAI-primary experiment, maths holistic feedback can use OpenAI
while this verifier pass continues to use Anthropic. Keep both API keys
configured until that loop has its own cross-provider evaluation.

## Deployment safety

- Do not remove `ANTHROPIC_API_KEY` during the experiment.
- Change one provider tier per deployment.
- Check Vercel `[usage]` lines; they include provider, model, input/output
  tokens and cache usage.
- Rollback is an environment-variable change: set the relevant provider back
  to `anthropic` and redeploy.
