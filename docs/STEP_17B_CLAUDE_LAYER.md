# Step 17b — narrowly-scoped Claude classifier/formatter layer

> **Naming note.** This work is recorded as **Step 17b** because
> [`ROADMAP_STATUS.md`](./ROADMAP_STATUS.md) already assigns Step 17 to
> "measured iteration / prompt 1.2.0". The original request called it "Step 17";
> renaming avoids overwriting recorded roadmap history.

## What the system is

> NutriGuard is a **Deterministic Nutrition Agent with Hybrid RAG, external
> embeddings, and a narrowly-scoped Claude classifier/formatter layer (advisory
> classification + grounded response phrasing only — never calculation, never
> data invention, never write-action authority).**

That qualification is not decorative. Every nutritional number a user sees still
comes from the deterministic pipeline built in Steps 4–9. Claude cannot compute,
cannot supply a fact, and cannot approve an action.

## The two permitted roles

| Role | Module | What it may do | What it may never do |
| --- | --- | --- | --- |
| Advisory classifier (Part A) | `src/llm/claude-classifier.ts` | Return one intent label, a confidence, and entity strings copied from the user's message | Decide routing, compute a value, invent an entity |
| Response formatter (Part B) | `src/llm/claude-formatter.ts` | Rephrase an already-computed answer | Introduce any number or name absent from its structured input |

### Part A — classification is advisory only

Both rule-based classifiers keep running on every eligible request:

- `classifyGraduationIntent` (`src/runtime/graduation-demo-agent.ts`) — the
  authoritative 8-intent classifier;
- `RuleBasedExpandedAgentPlanner` (`src/agent/expanded-agent.ts`) — a coarser
  5-outcome planner, recorded separately for observability. Its label is not
  one-to-one comparable with the eight intents and is never scored for
  agreement.

The decision policy in `src/llm/nlu-arbitration.ts`
is exhaustive and always logged:

| Situation | Route label | What the user gets |
| --- | --- | --- |
| Labels match | `rule_based_and_claude_agreement` | Unchanged behaviour |
| Labels differ | `rule_based_and_claude_disagreement` | **The rule-based answer.** Both full outputs are logged for offline analysis |
| Call fails, times out, or returns invalid JSON | `claude_classifier_failed` | The rule-based answer, with no visible degradation |
| Claude not configured | `rule_based_only` | Unchanged behaviour |

`arbitrateNlu` returns the rule-based label as `effectiveIntent` on **every**
path, and the agent re-runs its deterministic routing independently. Claude
structurally cannot alter which answer is produced in this step.

Entity strings are inert until validated (Part A5,
`src/llm/entity-validation.ts`). Each candidate
is resolved twice:

1. the agent's own live path — the same resolution a user-typed name receives,
   and the only verdict that could ever gate downstream use;
2. the Step 2 dictionary resolver `resolveIngredient`
   (`src/domain/ingredients.ts`) as an additional cross-check.

The two dictionaries differ, so a value can pass one and fail the other. Both
verdicts are reported; the dictionary verdict never overrides the agent path.

### Part B — formatting is grounded or discarded

The formatter receives a self-contained fact payload and nothing else: no
database handle, no retrieval tool, no ability to request more data. Before any
output can reach a user it must clear the grounding validator
(`src/llm/grounding-validator.ts`):

1. **Numbers.** Every numeric token is extracted (Arabic-Indic digits and
   thousands separators normalized) and must match a number present in the
   structured input, within the documented display-rounding tolerance of
   **±0.05** — exactly the error of rounding to one decimal place. A materially
   different figure fails.
2. **Entities.** Any dataset entity name appearing in the output while absent
   from the structured input fails. Normalization mirrors the agent's own lookup
   normalization, including definite-article stripping, so `الملوخية` cannot
   evade detection of `ملوخية`.
3. **Shape.** Empty or over-long output fails.

On **any** failure the deterministic template is emitted verbatim. This is not a
degraded error message — it is the exact response the user would have received
before this step. Both payloads are preserved through the
`onGroundingFailure` sink, which is separate from the structured logger because
that logger truncates long strings.

## Safety precedence (invariant I4)

The rule-based safety screen runs **before** any Claude call:

```
message → rule-based intent → safetyPreScreen → medical/emergency/integrity?
                                              ├── yes → fixed rule-based copy, ZERO Claude calls
                                              └── no  → advisory classifier, then deterministic routing
```

`safetyPreScreen` (`src/llm/claude-layer.ts`) trips on a `medical_safety`
intent, any `classifySafetyFlags` result, or any `classifyRequestIntegrity`
result.

> **Documented precedence decision.** Part A2 asked for both classifiers to run
> on *every* message, but invariant I4 and acceptance criterion 6 require
> medical_safety to be entirely Claude-free. Where those conflict, I4 wins:
> safety-routed requests never reach Claude in any role. This is verified by
> test, not asserted.

`medical_safety` is additionally hard-disabled in the formatter by
`formatterIntentDecision`, which rejects it *before* consulting configuration —
so no environment variable, config file, or future default can enable it.

## Operational requirements and known pitfalls

Three failures were observed on a real run and are now guarded by tests. All
three are worth reading before enabling the layer.

### 1. The classifier's model must support tool use

Structured output uses forced tool-calling. A model without tool support fails
immediately with `HTTP 404 — No endpoints found that support tool use`, so Part A
and reference resolution simply never work.

Probed against one real OpenRouter key on 2026-08-19 (availability is per
account, so re-check for yours):

| Model | Tool use | Latency |
| --- | --- | --- |
| `openai/gpt-4o-mini` | works | ~1.4 s — recommended |
| `deepseek/deepseek-chat` | works | ~2.0 s |
| `deepseek/deepseek-r1-distill-llama-70b` | **no (404)** | ~30 s for plain text |
| `anthropic/claude-3.5-haiku` | not available on that key (404) | — |
| `google/gemini-2.0-flash-001` | not available on that key (404) | — |

Avoid reasoning models. They spend tens of seconds emitting chain-of-thought,
which is wasted effort for rephrasing text that is already final.

> **Naming accuracy.** Transport is OpenRouter, and the configured model need not
> be a Claude model. The `CLAUDE_*` variable names and the "Claude layer" label
> are historical. Describe the system by what is actually configured — calling it
> a "Claude layer" while running `gpt-4o-mini` would be inaccurate.

### 2. Stage timeouts must fit inside the request budget

A 30 s stage timeout against the server's 15 s request timeout made the **HTTP
request** time out first. `http-app.ts` maps any status ≥ 500 onto one generic
message, so the user saw *"The service could not complete the request."* instead
of a correct, fully-computed meal plan.

`clampStageTimeouts` now scales both stage timeouts proportionally so that
`classifier + formatter + 5 s deterministic reserve ≤ REQUEST_TIMEOUT_SECONDS`,
and logs `nutriguard_claude_stage_timeouts_clamped` at `warn` rather than
degrading silently. Measured on the originally failing request: **31.4 s → 6.1 s**,
with the deterministic meal plan returned correctly.

### 3. Grounding must compare against the deterministic text, not only the payload

The structured payload stores ingredient **keys** (`rice_white_raw`) while the
template renders Arabic **display names** (`أرز أبيض`). The validator therefore
rejected a recipe's own ingredients as "fabricated" — a false positive that made
the formatter useless for `find_recipe`.

The validator now also treats the deterministic template text as a grounding
source. That text is the pipeline's own output, so anything it already states is
traceable by construction, and a genuinely fabricated dish or number is absent
from it too. Verified with a live model: `find_recipe`, `recipe_nutrition` and
`compare_recipes` all pass, while the fabricated-number and fabricated-entity
tests still fail as they must.

## Conversational memory

Bare definite references — "اعرضلي مكونات الوصفه", "خفف الوصفه",
"show me the recipe ingredients" — previously lost context: the router saw
"مكونات" with no named dish and asked for ingredient weights in grams.

Resolution is now **deterministic first**:

1. `IMPLICIT_RECIPE_REFERENCE_PATTERN` is a single shared pattern (the two
   near-duplicate copies that had drifted are gone) covering pronouns plus bare
   definite forms `الوصفه`/`الوصفة`/`الاكله`/`الأكلة`/`الطبق` and
   `the recipe`/`the dish`. This needs no model and works with the layer off.
2. Only when that finds nothing does the model get consulted, and only over a
   **closed candidate set** built entirely from deterministic session memory
   (`activeRecipeId`, `recentRecipeIds`, plan recipe ids).

Every proposed id passes two independent gates before use: it must be a member of
that candidate set, and it must resolve to a real dataset recipe. Outcomes are
recorded in the trace as `resolved_deterministically`, `accepted`,
`rejected_outside_candidate_set` or `rejected_unknown_recipe`.

> **Disclosed deviation from "advisory only".** This is the one place where the
> model can influence routing. It is deliberately bounded: the model chooses from
> a closed list the deterministic system already recorded, so it can surface a
> recipe the user was already discussing but can never introduce a new dish,
> change a number, or affect safety routing. It is disabled on safety-routed
> requests and can be switched off with
> `CLAUDE_REFERENCE_RESOLUTION_ENABLED=0`. Functionally it generalizes the
> pronoun mechanism the agent already had.

## Configuration

All variables are optional. With none set, the Claude layer is completely inert
and the agent behaves exactly as it did before Step 17b.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | *(unset)* | OpenRouter credential. Without it both stages are disabled. |
| `CLAUDE_CLASSIFIER_MODEL` | *(unset)* | Model for Part A. **Required** to enable the classifier. |
| `CLAUDE_FORMATTER_MODEL` | *(unset)* | Model for Part B. **Required** to enable the formatter. |
| `CLAUDE_CLASSIFIER_ENABLED` | on when a classifier model is set | Master switch for Part A. |
| `CLAUDE_FORMATTER_ENABLED` | on when a formatter model is set | Master switch for Part B. |
| `CLAUDE_CLASSIFIER_TIMEOUT_SECONDS` | `3` | Clamped to 0.25–30 s. |
| `CLAUDE_FORMATTER_TIMEOUT_SECONDS` | `6` | Clamped to 0.25–30 s. |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | Override for a compatible proxy. |
| `OPENROUTER_SITE_URL` | *(unset)* | Optional `HTTP-Referer` attribution header sent to OpenRouter. |
| `OPENROUTER_APP_NAME` | *(unset)* | Optional `X-Title` attribution header sent to OpenRouter. |
| `CLAUDE_DEBUG_PANEL_ENABLED` | `false` | Enables trace capture and the internal route. |
| `CLAUDE_DEBUG_PANEL_TOKEN` | *(unset)* | Bearer token. The route 404s without it. |
| `CLAUDE_DEBUG_RAW_MESSAGES` | `false` | Separate opt-in for raw-message capture. Never set by the panel. |
| `CLAUDE_DEBUG_TRACE_BUFFER` | `50` | Bounded ring-buffer size, 1–500. |

No model identifier is hard-coded as a default. Enabling a stage requires
naming the model explicitly, so the repository never implies that a particular
Claude version was verified when it was not.

### Per-intent formatter flags (Part B4)

| Variable | Default |
| --- | --- |
| `CLAUDE_FORMATTER_RECIPE_NUTRITION` | on |
| `CLAUDE_FORMATTER_INGREDIENT_NUTRITION` | on |
| `CLAUDE_FORMATTER_COMPARE_RECIPES` | on |
| `CLAUDE_FORMATTER_LIGHTER_MODIFICATION` | on |
| `CLAUDE_FORMATTER_FIND_RECIPE` | on |
| `CLAUDE_FORMATTER_GENERAL_GUIDELINE` | on |
| `CLAUDE_FORMATTER_MEAL_PLAN` | on |
| **`medical_safety`** | **hard-disabled — no variable exists** |

Every "on" default still carries the mandatory grounding fallback. An intent
outside this list is never formatted, so greetings and clarification prompts
keep their fixed copy.

## Part C — observability

`GET /internal/v1/claude-trace` requires **both**
`CLAUDE_DEBUG_PANEL_ENABLED=1` and a `CLAUDE_DEBUG_PANEL_TOKEN` bearer token.
Absent or disabled, it returns 404 so an ordinary deployment cannot discover it.

Each trace reports the NLU route, the formatter route, the model used at each
stage, the grounding verdict with failure codes, the retrieval path, and a
per-stage latency breakdown (embedding call, vector search, local fallback,
classifier, deterministic calculation, formatter, grounding validation).

Retrieval attribution closes a gap flagged in the prior review. Thin decorators
(`InstrumentedEmbeddingProvider`, `InstrumentedVectorStore`) time the embedding
and vector-search stages separately, and `AsyncLocalStorage` scopes events to
the originating request so concurrent requests cannot be misattributed. Because
this reporting is independent of Claude, enabling the debug panel alone is
enough to capture it.

**Privacy (C2).** Traces carry structural data only — route labels, booleans,
model names, timings. `redactTraceForDebugPanel` strips the raw message and the
rejected formatter payloads on the way out, so even an accidentally-enabled
raw-message opt-in cannot leak through the panel.

One deliberate exception, required by Part A3: a **disagreement** log line
includes Claude's full JSON, which contains entity strings copied from the
user's message. This is needed for offline analysis. It appears only on
disagreement, only in structured logs, and never in the debug panel.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run verify:claude-layer` | Exercise the real request path and print debug traces |
| `npm run report:claude-classifier` | Generate the Part A4 regression comparison report |
| `npm run measure:claude-layer` | Measure the layer's in-process latency overhead per intent |

## Current verification status

Measured on 2026-08-19 with `openai/gpt-4o-mini` configured for both stages via
OpenRouter. That is **not** a Claude model — no Anthropic model was available on
the configured key, so describe the deployment by the model actually in use.

The whole suite is green at **553 tests (552 pass, 1 pre-existing skip, 0 fail)**,
including 62 tests for this layer.

**Live request path (`npm run verify:claude-layer`) — real provider calls:**

| Probe | NLU route | Grounding | Retrieval | Total |
| --- | --- | --- | --- | --- |
| `recipe_nutrition` | agreement | passed, 23 numbers checked | not invoked | 6.70 s |
| `general_guideline` | agreement | passed, 7 numbers checked | **real Gemini + Qdrant** | 6.74 s |
| `medical_safety` | rule-based only | n/a | not invoked | **0.04 s, zero LLM calls** |

**Classifier agreement (`npm run report:claude-classifier`) — 74 cases, 66
comparable after excluding 8 safety-routed:**

| Group | Agreement | Rule-based correct | LLM correct |
| --- | --- | --- | --- |
| Overall | **69.7%** | 81.8% | 80.3% |
| fixture: retrieval | 60.0% | 90.0% | 75.0% |
| fixture: numeric | 75.0% | 85.0% | 90.0% |
| fixture: wording | 58.3% | 50.0% | 58.3% |
| health-question phrasing | 75.0% | 87.5% | 87.5% |
| Arabic elongation | **100%** | 100% | 100% |

Of the 20 disagreements the LLM was right and the rules wrong in **8**, the rules
were right and the LLM wrong in **9**, and both were wrong in **1**. The
rule-based classifier is therefore still the better router, which is exactly why
it keeps deciding routing. The LLM's characteristic failure is labelling
food-pyramid questions `unsupported`; its characteristic win is recognising
comparison and lighter-modification requests that the rules read as plain
nutrition lookups.

**Latency.** In-process overhead is +12–20 ms per intent (`compare_recipes` and
`general_guideline` are dominated by retrieval, not by this layer). Real provider
cost from the live run: classifier 1.5–2.3 s, formatter 2.7–4.3 s, about 6.7 s
total for a formatted request. Set `CLAUDE_FORMATTER_ENABLED=0` if that is too
slow for a demo; the classifier alone is far cheaper.
