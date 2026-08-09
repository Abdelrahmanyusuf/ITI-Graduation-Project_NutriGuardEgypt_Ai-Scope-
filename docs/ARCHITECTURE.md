# NutriGuard — Architecture & Current State

## Project scope

NutriGuard is a nutrition assistant restricted to **verified Egyptian food**.
It must never invent nutritional numbers: all arithmetic is deterministic
application code, and data carries provenance and versioning.

## Repository layout (after Step 0)

```
src/            TypeScript application source (foundation only)
  config/       environment validation (implemented)
  domain/       future domain models (reserved)
  data/         future data access / schema (reserved)
  services/     future business services (reserved)
  tools/        future agent tools (reserved)
  workflows/    future orchestration (reserved)
  api/          future HTTP/API surface (reserved)
  safety/       future safety guards (reserved)
  observability future telemetry/logging (reserved)
  index.ts      entry point (foundation)
tests/          automated tests (node:test + tsx)
scripts/        reserved for CLI / data-processing scripts
data/
  raw/          immutable source inputs (intended for version control)
  staging/      intermediate generated data (gitignored)
  processed/    generated outputs (gitignored)
docs/           documentation
migrations/     reserved for future DB migrations
legacy/         archived JavaScript prototype (reference only)
```

## What is implemented (verified, Step 0)

- TypeScript + Node ESM foundation (`target ES2022`, `module NodeNext`).
- Environment validation module (`src/config/env.ts`) with strict rules for
  `NODE_ENV` and `PORT`. The foundation reads no API keys.
- Root runtime dependencies are pinned to LangGraph, LangChain Core, and Zod for
  the Step 12 graph and strict schemas. TypeScript, ESLint, tsx, Node types, and
  PostgreSQL integration support remain development tooling. The archived
  prototype's other runtime libraries are not reactivated.
- Scripts: `dev`, `dev:smoke`, `build`, `start`, `type-check`, `lint`, `test`.
- Tests proving the toolchain, config validation, dev-entry boot, and Arabic
  UTF-8 integrity.
- `.gitignore` handling for secrets (`.env`) and generated data
  (`data/processed`, `data/staging`).
- Raw input data separated under `data/raw`; generated outputs under
  `data/processed` / `data/staging`.

## What is implemented (verified, Step 2 — data audit)

- Deterministic, read-only source audit (`npm run audit`) producing
  `data/reports/data-audit.{json,md}` and review queues under `data/review/`.
  Raw files under `data/raw/` are never modified (verified byte-identical).

## What is implemented (verified, Step 3 — recipe staging)

- Egyptian recipe staging + review pipeline (`npm run stage`), domain model in
  `src/domain/recipes.ts` + `src/domain/manifest.ts`. Stable IDs, preserved
  original rows, provenance/license derived from the manifest, append-only
  review timeline, and a verified-MVP gate (`isEligibleForVerifiedDataset`)
  that automation can never self-satisfy. Reports the current verified count
  truthfully (currently 0).

## What is implemented (verified, Step 4 — PostgreSQL schema + provenance)

- Migration SQL under `migrations/` (`0001_init.up.sql` / `0001_init.down.sql`).
  The migration files never issue their own `BEGIN`/`COMMIT` (the runner is the
  single transaction owner) and the ledger is bootstrapped before any query so a
  completely empty PostgreSQL is a valid starting point.
- Migration runner + connection in `src/data/database.ts` (`npm run
  db:migrate` / `db:rollback` / `db:status` / `db:validate`). Down migrations
  are resolved from the actual `*.down.sql` filenames on disk.
- Canonical schema contract in `src/data/schema.ts` and real-catalog
  verification in `src/data/schemaVerify.ts` (querying the live PostgreSQL
  catalog — there is deliberately no SQL-substring validator).
- Schema invariants: `source_id`/`data_version_id` pinned to the record's own
  source (composite FK), constrained food states everywhere incl. yield-factor
  `from`/`to`, `original_*` columns preserving source values, enforceable typed
  review-record foreign keys, and `COALESCE(food_state,'')` uniques over nullable
  state.
- Test-only synthetic seed in `src/data/seed.ts` +
  `tests/fixtures/db/seed-synthetic.sql` (opt-in via
  `NUTRIGUARD_ALLOW_SYNTHETIC_SEED=1`; never production data). The live
  integration test additionally requires `NUTRIGUARD_RUN_DB_INTEGRATION=1`,
  refuses non-`test` database names, and runs in its own disposable schema.
- The `pg` driver is a dev dependency (integration tooling only).

## What is implemented (verified, Step 5 — ingredient dictionary + entity resolution)

- Deterministic, AR/EN/EG ingredient dictionary in `data/dictionary/ingredients.json`
  (51 canonical records, all `unapproved` — no human review record exists yet) with
  reviewed manual mappings in `data/dictionary/reviewed-mappings.json` and a
  content-hash-verified review registry in
  `data/dictionary/review-registry.json` (currently empty). Entity resolution
  lives in `src/domain/ingredients.ts` (`npm run resolve:ingredients`):
  - **No LLM, no vector embeddings, no fuzzy auto-accept.** Every match is one
    of three reproducible stages: `normalized_exact` (both scripts normalized),
    `alias_exact` (Arabic/English/Egyptian aliases), `reviewed_mapping` (a
    content-hash-approved review record). Fuzzy similarity (`diceCoefficient`,
    threshold 0.55) only *suggests*; it never resolves.
  - **Ambiguity is never collapsed.** Duplicate terms (coriander leaf vs seed,
    dry vs fresh peas) resolve to `ambiguous` and go to the human review queue
    rather than being force-merged.
  - **Food states are data.** `raw/cooked/boiled/fried/baked/drained` are
    stored on dictionary entries; `cooked rice` → `rice-cooked`, `fried eggs`
    → `egg-fried` via a two-pass (stateful full-text first, stripped as
    fallback). Arabic natural forms (e.g. "البيضة المقلية" / "بيضة مقلية")
    resolve via definite-article folding without merging food states.
  - **Approval is content-bound.** A reviewed mapping is approved only when a
    registry record with its id exists and the SHA-256 hash of its *current* content
    matches the stored hash — editing any field after approval invalidates it.
    The registry self-verifies its stored hashes on load, rejects every record
    sharing a duplicate ID, and is mandatory (fail-closed). No ID-only approval.
  - **Original text preserved.** Resolution reports carry `original` +
    `normalizedQuery`; nothing is rewritten in the raw source.
  - Coverage + review artifacts are written to
    `data/reports/ingredient-dictionary-coverage.{json,md}` and
    `data/review/ingredient-dictionary-review-queue.{json,md}` (occurrence-based
    coverage, honest nulls, never invented 0s). Quantity/unit variants share one
    unique ingredient identity while retaining every source occurrence. Weighted entries are validated
    against the resolution inventory (existence + original-text match + source
    identity; foreign/mismatched/duplicate rejected). The CLI exits non-zero
    when zero occurrences map to an approved record or any registry/count/weight
    validation fails, but always writes the honest report + queue.

## What is implemented (verified, Step 6 — quantities, units, household measures)

- `src/domain/quantities.ts` deterministically separates quantity, unit, and
  ingredient text while preserving the original line and original quantity/unit.
- Western, Arabic-Indic, and Eastern-Arabic digits; decimals; simple/mixed/vulgar
  fractions; and English/Arabic ranges are supported and validated.
- The sourced registry `data/dictionary/unit-conversions.json` defines `g`,
  `kg`, `ml`, `l`, teaspoon, tablespoon, cup, piece, and clove aliases plus
  ingredient/state/size-specific gram factors. Every factor references a source
  and retains its locator, original value, context, and uncertainty.
- Volume is normalized to millilitres, but is never converted to grams without
  an exact ingredient factor. Count measures work only with a sourced size when
  required. Raw/cooked states cannot borrow each other's factors.
- Measure aliases carry a `standard` or `egyptian_household` variant. Egyptian
  cups/spoons are parsed and preserved but cannot use NIST/USDA US-household
  factors; without a reviewed Egyptian factor they return `partial` and `null`
  grams. Ingredient-specific Egyptian count labels remain supported where a
  sourced item/size weight exists.
- Raw-only source records are explicitly tagged `raw`; a `null`/unspecified food
  state cannot borrow a raw factor. Registry loading is fail-closed, enforces
  unit code/dimension/base invariants and globally unique factor IDs.
- Qualitative quantities (`to taste`, `as needed`) and frying-oil absorption are
  explicitly unsupported. Missing factors return `partial`/`unsupported` with
  `null` gram values; nothing is fabricated.
- Edible-portion and cooking-yield fields, validation, provenance, and conversion
  paths are implemented. Their production registries are empty until reviewed
  factors are supplied.
- `npm run normalize:units` writes coverage and review artifacts under
  `data/reports/` and `data/review/`. Its current production run correctly fails
  the readiness gate because Step 5 contains zero human-approved mappings, so
  ingredient-specific production conversions cannot be applied yet.

## What is implemented (verified, Step 7 — nutrition calculator)

- `src/domain/nutrition.ts` exposes the required async operation
  `calculateRecipeNutrition(recipeId, servingRequest)` and repository adapters
  for the default JSON runtime snapshot and deterministic in-memory tests.
- One immutable calculation input contains the structured recipe and the exact
  ingredient, mapping-review, unit, nutrient-profile, and retention registries.
  Recipes, mappings, conversion factors, profiles, and retention factors carry
  source and version IDs in the result provenance. Duplicate recipe IDs make
  the complete snapshot unavailable; neither repository silently selects the
  first duplicate.
- Each ingredient follows a fixed pipeline: exact Step 5 resolution, Step 6
  gram conversion, exact state profile selection, then sourced edible-portion,
  cooking-yield, and nutrient-retention arithmetic. A missing or ambiguous
  record never falls through to another state or an unsourced estimate.
- Results contain full recipe, per serving, and per 100 g bases; an
  ingredient-level calculation trace; omissions and assumptions; and objective
  coverage by ingredient count, final-food weight, and required nutrient.
  Weight coverage counts an ingredient only when its complete core nutrient
  panel is calculable. Its denominator is complete only when every recipe
  ingredient has a known final weight; otherwise the weight rate is `null`.
- The engine preserves zero versus missing: measured `0` participates in
  arithmetic, while unknown values remain `null`. A nutrient total is published
  only when all required ingredient contributions are known; otherwise only its
  explicitly labelled known subtotal is exposed.
- Required missing mass produces `unavailable`; an available basis with an
  important omission is `partial`; `complete` requires every core contribution.
  Each basis also has its own available/unavailable status and reason.
- Internal aggregation uses unrounded numbers. Calories and sodium are rounded
  to whole output units and gram nutrients to one decimal only at the output
  boundary. The returned rounding policy makes this explicit.
- The default loader expects
  `data/processed/nutrition-calculator-snapshot.json` schema `1.0`. That artifact
  is ignored runtime data and is not present until approved production data is
  assembled. The golden registry under `tests/fixtures/nutrition/` is explicitly
  synthetic/test-only and cannot be used by the default production loader.

## What is implemented (Steps 8–10 — retrieval and tools)

- `src/retrieval/benchmark.ts` benchmarks exactly two or three configured
  multilingual models with Recall@K and MRR. Ties and missed thresholds require
  review; synthetic fixtures cannot select a production model.
- `src/retrieval/ingestion.ts` accepts only an explicit approved corpus with
  complete source/version provenance. Recipe documents must also be human
  verified. `src/retrieval/qdrant.ts` provides the production vector-store
  adapter and enforces approval filters at query time.
- Ingredients and numeric nutrient values remain normalized structured data;
  neither uses vector search as authority. Raw/staging data is never imported
  automatically.
- `src/tools/nutriguard-tools.ts` implements `search_recipes`,
  `search_guidelines`, `calculate_nutrition`, and `compare_with_guideline`.
  Calculation delegates to Step 7, while comparisons require one exact approved
  structured rule. See [`RETRIEVAL_AND_TOOLS.md`](./RETRIEVAL_AND_TOOLS.md).

## What is implemented (Steps 11–12 — prompt and one Agent scenario)

- `src/agent/system-prompt.ts` contains a versioned Egyptian-Arabic prompt with
  explicit scope, no-fabrication, medical-safety, and no-result rules.
- `src/agent/safety.ts` applies deterministic blocking safety routes before any
  planner or tool call; religious guarantees follow the non-medical refusal
  rule.
- `src/agent/sodium-prototype.ts` uses a compiled LangGraph workflow for one
  scenario only: find exactly one verified Egyptian recipe, call the Step 7
  calculator through the Step 10 tool, and return sourced sodium for one
  available basis. Planner and response boundaries are strictly validated.
- Details and limitations: [`AGENT_PROTOTYPE.md`](./AGENT_PROTOTYPE.md).

## What is implemented (Steps 13–15 — scenarios and evaluation)

- `src/agent/expanded-agent.ts` adds same-basis recipe comparison,
  approved-rule-only healthier alternatives, and approved food-pyramid passage
  retrieval while preserving safety-before-tools routing.
- `src/evaluation/dataset.ts` validates a 50–100-question schema and rejects
  synthetic data as production evidence. The committed 60-question set is
  explicitly synthetic.
- `src/evaluation/evaluate.ts` scores retrieval, exact numeric facts, and
  wording/comprehension independently. Human wording scores stay pending until
  every wording case is reviewed.
- The real Agent passes all 60 synthetic cases, but real-user collection and
  human review are still missing. See [`STEPS_13_15.md`](./STEPS_13_15.md).

## What is still prototype (NOT completed)

The archived JavaScript prototype under `legacy/` is a **non-runnable
reference**. It is preserved, not migrated, not wired into the new foundation,
and its runtime dependencies were removed from the root project:

- OpenRouter agent (`NutriGuard_Agent.js`).
- RAG-style guideline retrieval prototype (`Guidelines_Rag.js`).
- Data-cleaning CSV/PDF scripts.

## Production work that remains externally blocked

- Production embedding-model approval and approved production-corpus ingestion
- Real-user Step 14–15 evaluation and human wording/comprehension review
- The actual Step 19 limited-user staging pilot and signed feedback analysis
- Owner-authorized Step 20 production infrastructure configuration and deployment
- Importing verified nutrition data into the PostgreSQL schema (the schema and
  migrations exist; no production data is loaded automatically; the synthetic
  seed is test-only)

## Steps 16–20 engineering layer

- `src/evaluation/adversarial.ts` and `src/evaluation/iteration.ts` provide
  deterministic, explicitly synthetic robustness and iteration evidence.
- `src/agent/request-integrity.ts` blocks prompt injection, user numeric
  overrides, and unapproved-data requests before planning or tools.
- `src/server/http-app.ts` exposes the secure API and RTL web client using
  injected Agent/feedback/readiness dependencies.
- migration `0002` and `src/pilot/feedback.ts` provide server-consent-bound,
  data-minimized, append-only pilot feedback.
- `src/release/readiness.ts` separates engineering readiness from evidence of a
  real staging pilot or production deployment and fails closed without it.
- Details: [`STEPS_16_20.md`](./STEPS_16_20.md).

## Data provenance note (Step 0)

Source values are preserved verbatim in `data/raw`. No nutritional value,
guideline, conversion factor, or recipe was altered during this step. Missing
values remain missing (null / absent); they are **never** silently coerced to 0
or invented. Existing cleaning scripts historically used `0` as a stand-in;
that behaviour is confined to the archived prototype and must be replaced by
explicit missing-state handling in a later step — not silently accepted here.
