# Agent prompt and LangGraph prototype (Steps 11–12)

> **Status:** one bounded scenario is implemented for review. This is not the
> full MVP Agent and is not production-approved.

## Step 11 — system prompt and safety boundary

The versioned prompt is exported from `src/agent/system-prompt.ts`. It requires:

- friendly Egyptian Arabic by default, with supported Arabic/English output;
- verified Egyptian recipes only;
- no invented numbers, sources, recipes, guidance, or missing-to-zero coercion;
- nutrition numbers only from `calculate_nutrition`;
- emergency and medical-safety overrides before normal content;
- no diagnosis, treatment, prescription, personalised disease diets, allergen
  guarantees, or religious-compliance guarantees;
- an explicit, honest no-result response instead of guessing.

`src/agent/safety.ts` is an application-side safety classifier. It runs before
the planner and tools, so prompt compliance is not the only safety control.
Emergency, medical/personalised, vulnerable-population, and allergen-guarantee
requests stop the content workflow. Religious guarantees are refused as an
unsupported request and never produce a medical referral.

This pattern matcher is intentionally a Step 12 prototype. Expanding its test
corpus and classification coverage belongs to Steps 13–15 and human Safety/QA
approval remains mandatory.

## Step 12 — selected framework and scenario

The prototype uses pinned `@langchain/langgraph` and `@langchain/core` runtime
packages. LangGraph was selected because explicit nodes and conditional edges
make the safety-before-tools ordering inspectable and testable. This follows
the official [LangGraph graph model](https://docs.langchain.com/oss/javascript/langgraph/graph-api).

The only supported workflow is:

```text
validate input
  -> deterministic safety routing
  -> bounded sodium plan
  -> search_recipes
  -> require exactly one verified recipe ID
  -> calculate_nutrition
  -> read sodium from the requested available basis
  -> validate and return the structured response
```

The default planner is deterministic and supports Egyptian Arabic/English
sodium wording. A future model-backed planner may implement the same narrow
interface, but its output must pass the strict plan schema and cannot select an
arbitrary tool or SQL. The application—not the planner—executes tools.

Ambiguous recipe search asks for clarification. Zero results, tool failures,
unavailable calculations, unavailable bases, and `sodium.amount = null` all
return the no-result response. `knownSubtotal` is never presented as the total.

The public output contains the selected basis, deterministic sodium value,
calculation status, source/version provenance, privacy-safe tool trace, safety
flags, and prompt version. It never logs the raw query.

## Expansion

Step 13 now extends this prototype with recipe comparison, approved healthier
alternatives, and food-pyramid guidance. Steps 14–15 add the evaluation
contract and synthetic baseline. See [`STEPS_13_15.md`](./STEPS_13_15.md).

## Deliberately not implemented

- free-form LLM tool loops;
- conversation memory or persistence;
- HTTP API or UI;
- real-user/human production evaluation and release approvals;
- roadmap Steps 16–20.

## Tests

`tests/agent-prototype.test.ts` uses only explicitly synthetic data. It covers
the prompt contract, safety precedence, the successful sodium flow, ambiguity,
missing/null data, religious and medical refusal behavior, malicious planner
output, strict public input, and no tool execution before safety routing.
