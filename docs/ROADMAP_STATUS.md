# Original 20-step roadmap status

> Reviewed against the original user roadmap on 2026-08-09. “Implemented” means
> code/tests exist; it does not imply production data approval or release
> sign-off.

| Step | Original outcome | Current status | Evidence / remaining blocker |
| ---: | --- | --- | --- |
| 1 | Inventory all sources | Implemented | Deterministic audit and reports exist. Source licensing remains pending where recorded. |
| 2 | Normalize ingredient identities | Implemented; production approval blocked | Stable dictionary, aliases, food states, resolver, review registry. Production mappings still require human approval. |
| 3 | Clean/standardize nutrient data | Implemented framework; production data blocked | Missing-vs-zero, units, constraints, provenance, and calculator registries exist. No approved production nutrient snapshot. |
| 4 | Standard structured recipes | Implemented; production review blocked | Stable recipe staging schema and human-review lifecycle exist. Current production eligibility remains zero. |
| 5 | Chunk WHO/pyramid guidance | Implemented schema/pipeline; production corpus blocked | Guideline documents/chunks/rules and approved-only ingestion exist. No approved production guidance corpus is ingested. |
| 6 | PostgreSQL structured layer | Implemented | Migrations/schema/rollback/validation/tests exist; live integration test needs a configured test PostgreSQL. |
| 7 | Select vector database | Implemented decision | Qdrant adapter selected and tested; production instance is not configured. |
| 8 | Benchmark 2–3 multilingual models on real Arabic questions | Benchmark implemented; real benchmark blocked | True Recall@K/MRR harness exists. No approved real-question set, credentials, or selected production model. |
| 9 | Recipe/guideline vector ingestion + SQL ingredients | Implemented pipeline; production run blocked | Explicit approved-only Qdrant ingestion exists; raw/staging auto-import is forbidden. No approved production corpus run. |
| 10 | Four tools | Implemented | Recipe/guideline search, deterministic nutrition, structured guideline comparison. |
| 11 | Egyptian-Arabic system prompt/safety/no-result | Implemented for review | Versioned prompt plus application-side safety routing and tests. Human Safety/QA approval pending. |
| 12 | One Agent prototype scenario | Implemented | LangGraph verified-recipe sodium scenario. |
| 13 | Compare recipes, healthier alternative, pyramid question | Implemented for review | Same-basis comparison, approved-rule alternative, sourced guidance; synthetic tests only. |
| 14 | 50–100 real Egyptian-Arabic questions | **Not complete** | 60-question synthetic engineering set exists. Real-user collection, consent, and provenance are missing and enforced as a blocker. |
| 15 | Separate retrieval/numeric/wording evaluation | Implemented evaluator; production evaluation incomplete | Synthetic results are green. Real corpus/model/SQL reference evaluation and human wording/comprehension review are pending. |
| 16 | Adversarial edge cases | Engineering implementation complete | The real Agent passes 18 deterministic synthetic adversarial cases across nine categories. Real-user adversarial evidence remains part of the release gate. |
| 17 | Iterate prompts/retrieval from findings | Synthetic iteration complete | Prompt 1.2.0 adds pre-retrieval integrity controls with finding-to-regression evidence. Real retrieval iteration still requires the real corpus/model. |
| 18 | Chat/API or simple web interface | Implemented for review | Secure dependency-injected HTTP API and responsive RTL chat pass API and real-browser desktop/mobile checks. Local runnable data is visibly synthetic. |
| 19 | Limited staging pilot and real feedback | Engineering readiness complete; pilot not run | Append-only consented feedback, staging evidence gate, and pilot protocol exist. Real participants, consent, deployment, and signed feedback report are still required. |
| 20 | Final production refinement/deployment | Engineering readiness complete; deployment not performed | Production gate, container, security/privacy and runbook exist. A completed pilot, approved production data/infrastructure, human approvals, and owner-authorized deployment remain required. |
| 17b | Narrowly-scoped LLM classifier/formatter layer (added after the original roadmap) | Implemented and verified against a live provider | Advisory classification + grounded phrasing only, with a hard medical_safety exclusion, a grounding validator, closed-set conversational reference resolution, and an internal debug panel. Verified 2026-08-19 with `openai/gpt-4o-mini` via OpenRouter: 69.7% classifier agreement over 66 comparable cases, grounding passed on live formatted responses, zero LLM calls on medical_safety. See [`STEP_17B_CLAUDE_LAYER.md`](./STEP_17B_CLAUDE_LAYER.md). |
| 21 | Multi-option meal-plan selection with dashboard meal logging (added after the original roadmap; the requesting task calls itself "Step 16", which collides with roadmap Step 16 above) | AI side implemented against a deterministic local mock; **real integration blocked** | Category candidate search, explicit selection, confirmation summary with a frozen server-side snapshot, uuid `pending_operation_id` as the idempotency key, and applied-aware idempotent replay. No real dashboard client exists: blocked on cross-team auth linkage. Privacy/consent/retention, server-side snapshot validation, batch atomicity, balance policy, timestamp semantics, and correction/reversal remain open for the backend and privacy owners. See [`MEAL_PLAN_SELECTION_DASHBOARD_MOCK.md`](./MEAL_PLAN_SELECTION_DASHBOARD_MOCK.md). |

## System description

NutriGuard is a **Deterministic Nutrition Agent with Hybrid RAG, external
embeddings, and a narrowly-scoped Claude classifier/formatter layer (advisory
classification + grounded response phrasing only — never calculation, never data
invention, never write-action authority).** It is not a generic "LLM chat agent":
every nutritional number originates from the deterministic Step 4–9 pipeline, and
any model-authored wording that cannot be traced back to that pipeline is
discarded in favour of the deterministic template.

## Honest completion statement

- The engineering implementation and release-readiness package through Step 20 are ready for review.
- Step 17b adds a narrowly-scoped LLM layer that has now been exercised against a
  live provider (`openai/gpt-4o-mini` via OpenRouter): measured 69.7% classifier
  agreement, grounded formatting on real responses, and zero LLM calls on
  medical_safety. The rule-based classifier remains the better router and keeps
  deciding routing. No Anthropic model was available on the configured key, so
  the deployment should be described by the model actually in use.
- Steps 14–15 have schemas, gates, evaluators, and a passing synthetic baseline,
  but their required real-user/human/production evidence is not complete.
- The roadmap's software and operational scaffolding is implemented, but the
  roadmap is **not historically or operationally complete** until real-user
  Steps 14–15 and 19, human approvals, approved production data, and an actual
  owner-authorized Step 20 deployment occur.
