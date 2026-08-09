# NutriGuard Egypt

A nutrition assistant restricted to **verified Egyptian food**. Nutritional
values and guidelines are deterministic application data — the assistant never
invents numbers, and every value carries provenance and versioning.

> **Status: Steps 0–20 engineering and release-readiness implementation completed for review.** Steps 0–3 (foundation, scope
> docs, data audit, recipe staging), Step 4 (PostgreSQL schema + migrations +
> provenance), and Step 5 (ingredient dictionary + deterministic entity
> resolution), Step 6 (deterministic quantities and units), Step 7
> (deterministic nutrition calculation), Step 8 (embedding evaluation), Step 9
> (approved-only vector ingestion), and Step 10 (deterministic application
> tools), Step 11 (versioned Egyptian-Arabic prompt and safety boundary), and
> Step 12 (one bounded LangGraph sodium scenario), Step 13 (three expanded
> scenarios), Steps 14–15 (60-question synthetic evaluation and separated
> metrics), Steps 16–17 (adversarial evaluation and measured prompt iteration),
> Step 18 (secure API and responsive chat), and the Step 19–20 staging/production
> evidence gates and operational package are complete enough to review. The
> required real-user question set, human wording review, actual staging pilot,
> owner approvals, and official deployment remain external blockers. The
> production ingredient records remain `unapproved`, and no approved production
> nutrient snapshot exists, so the public calculator currently fails closed
> rather than returning fabricated nutrition. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
> for what exists and what is explicitly future work.

## Requirements

- Node.js **>= 22.6** (developed on v24)
- npm **>= 10**

## Installation

```powershell
npm ci
```

`npm ci` performs a clean, reproducible install from the lockfile. LangGraph,
LangChain Core, and Zod are pinned runtime dependencies for the Step 12 graph
and strict boundaries; TypeScript, ESLint, tsx, Node types, and PostgreSQL test
support remain development tooling. No secrets are required for install,
build, type-check, lint, or tests.

## Environment configuration

The Step 0 foundation validates `NODE_ENV` and `PORT` from the process
environment (see `src/config/env.ts`). It does **not** read any API key and
does **not** load a `.env` file automatically — defaults apply if neither
variable is set. `.env.example` documents the optional variables only; copying
it to `.env` has no effect on the foundation unless your runtime loads it.

## Scripts

| Command             | Action                                        |
| ------------------- | --------------------------------------------- |
| `npm run dev`       | Run `src/index.ts` via `tsx watch`            |
| `npm run dev:web`   | Run the explicit synthetic local chat demo     |
| `npm run dev:smoke` | One-shot run of the dev entry (no watch)      |
| `npm run build`     | TypeScript build → `dist/`                    |
| `npm start`         | Run the built output (`node dist/index.js`)   |
| `npm run type-check`| Type-check without emitting                    |
| `npm run lint`      | ESLint across `src/`, `tests/`, roots          |
| `npm test`          | Run the `node:test` suite via `tsx`           |
| `npm run audit`    | Run the read-only Step 2 data audit (`data/reports/*`) |
| `npm run stage`    | Run the Step 3 recipe staging pipeline           |
| `npm run resolve:ingredients` | Run the Step 5 ingredient-dictionary resolver (writes coverage + review queue) |
| `npm run normalize:units` | Run Step 6 quantity/unit normalization (writes coverage + review queue) |
| `npm run benchmark:embeddings` | Benchmark 2–3 models on an explicit Arabic evaluation dataset |
| `npm run ingest:retrieval` | Ingest one explicit approved corpus into Qdrant |
| `npm run eval:validate` | Validate the Step 14 evaluation dataset (synthetic is blocked for production) |
| `npm run eval:adversarial` | Run deterministic Steps 16–17 synthetic adversarial evaluation |
| `npm run release:check:staging` | Fail-closed Step 19 evidence gate |
| `npm run release:check:production` | Fail-closed Step 20 evidence gate |
| `npm run db:validate`| Verify the live schema against the canonical contract (needs a live DB) |
| `npm run db:migrate`| Apply pending migrations (needs a live DB)      |
| `npm run db:rollback`| Roll back applied migrations (needs a live DB) |
| `npm run db:status` | Show applied migrations (needs a live DB)      |
| `npm run db:seed:synthetic`| Load test-only synthetic seed (opt-in, needs a live DB) |
| `npm run db:test`   | Run the opt-in live PostgreSQL integration suite |
| `npm run docs:check`| Verify links/anchors in `docs/` and `README.md`    |

## Testing

Tests live in `tests/` and use the Node built-in test runner:

```powershell
npm test
```

They verify the toolchain compiles, environment validation behaves correctly
(including strict `PORT` rules), the development entry boots via `tsx watch`,
Arabic UTF-8 is preserved in the project's executable sources, the
documentation link checker catches broken files, anchors, and slugs, and the
Step 5 resolver behaves deterministically (Arabic normalization, staged
resolution, occurrence-based coverage, ambiguity never merged, food states,
review-queue contents). Step 6 tests cover English/Arabic quantities, fractions,
ranges, aliases, state-specific household factors, provenance, uncertainty,
edible portions, cooking yields, unsupported values, and an end-to-end report.
Step 7 golden tests cover exact and mixed-unit recipes, omissions, unknown
quantities, food-state mismatches, edible/yield/retention factors, serving and
per-100-g bases, zero versus null, repeatability, validation, and output-only
rounding.
Steps 8–10 tests cover true Recall@K/MRR model evaluation, synthetic-data
selection blocking, approved-only deterministic ingestion, server- and
client-side recipe verification filters, complete retrieval provenance, and
all four deterministic application tools.
Steps 11–12 tests cover the prompt contract, emergency/medical/religious safety
precedence, the one-recipe sodium graph, ambiguity, null/unavailable results,
malicious planner output, and strict validated responses.

**Database tests:** the DB-less test file `tests/database-schema.test.ts`
(enumerates migration files, resolves down migration names from disk, checks the
migration writes no `BEGIN`/`COMMIT` of its own, and confirms the synthetic seed
is test-only) runs with no PostgreSQL. The live DB integration test
(`tests/database.integration.test.ts`) is **skipped** unless a live database,
the synthetic-seed opt-in, AND the explicit destructive-run flag are all set.
It runs inside its own disposable schema (`ng_it_*`) and refuses non-`test`
database names. Run it with:

```powershell
$env:DATABASE_URL="postgres://user:pass@host:5432/nutriguard_test"
$env:NUTRIGUARD_ALLOW_SYNTHETIC_SEED="1"
$env:NUTRIGUARD_RUN_DB_INTEGRATION="1"
npm test
```

## Database (Step 4)

The PostgreSQL schema lives in `migrations/` (`0001_init.up.sql` /
`0001_init.down.sql`). It is applied only through the runner in
`src/data/database.ts`, tracked in the `schema_migrations` ledger. The runner is
the single transaction owner: the migration `.sql` files never issue their own
`BEGIN`/`COMMIT`, the ledger is bootstrapped before any query so an entirely
empty PostgreSQL is a valid starting point, and down names are resolved from the
actual files on disk. Missing values are `NULL`, never an invented zero; a real
measured zero is stored as `0` (distinct from `NULL`); impossible negative
nutrient/weight/conversion values are blocked by `CHECK` constraints; numeric
records carry provenance (`source_id`) and version (`data_version_id`), and a
record's version is pinned to its own source by a composite foreign key against
`data_versions(source_id, id)`. The pair is `MATCH FULL` with an explicit
pair-nullability `CHECK`: a record's source and version are either **both
present** or **both absent** — a source without a version (or vice versa) is
rejected; food states
(raw/cooked/boiled/fried/baked/drained) are kept separate everywhere including
`cooking_yield_factors`; original source values/units/context are preserved in
`original_*` columns; review records use enforceable typed foreign keys (never an
orphanable polymorphic pair); quantitative guideline recommendations live in
`guideline_rules` while prose lives in `guideline_chunks`, and a rule's chunk is
forced to belong to the rule's own document by a composite foreign key
`(document_id, chunk_id)`; conversion and yield factors are strictly positive
(`factor > 0`, `yield_factor > 0`).

`npm run db:validate` verifies the **live** schema against the canonical contract
(tables, columns, composite provenance FKs, food-state constraints, unique
indexes over nullable `food_state`, typed review FKs and numeric CHECKs) by
querying the real PostgreSQL catalog — there is no SQL substring validator.

The synthetic seed (`tests/fixtures/db/seed-synthetic.sql`, loaded by
`src/data/seed.ts`) is **test-only data**, explicitly rejected as a source, and
requires `NUTRIGUARD_ALLOW_SYNTHETIC_SEED=1`. It is never part of the
migrations and is never imported automatically. A clean database created
entirely from migrations contains no synthetic rows.

## Project scope (completed vs future)

**Implemented (Step 0):**
- TypeScript + Node ESM foundation; root `package.json` holds only foundation
  tooling (no runtime deps).
- Environment validation with strict rules for `NODE_ENV` and `PORT`.
- `dev` / `build` / `start` / `type-check` / `lint` / `test` scripts, plus a
  one-shot `dev:smoke`.
- Source directory skeleton under `src/` (no future features).
- Raw vs generated data split under `data/`.
- `.gitignore` for secrets and generated data.
- Original prototype archived under `legacy/` as **non-runnable reference**
  (its runtime dependencies were removed from the root project).
- Tests for toolchain, config validation, dev-entry boot, and Arabic UTF-8.

**Implemented (Step 2):** read-only deterministic data audit
(`npm run audit` → `data/reports/data-audit.{json,md}`, review queues under
`data/review/`).

**Implemented (Step 3):** Egyptian recipe staging + review pipeline
(`npm run stage` → `data/staging/recipes.json`,
`data/reports/recipe-verification-report.{json,md}`). Automation never
self-verifies; verified status requires a human review decision.

**Implemented (Step 4):** PostgreSQL schema + migrations + provenance
(`migrations/`, `src/data/`), a migration runner, DB-less structural
validation, test-only synthetic seed, and DB integration tests. The `pg` driver
is a dev dependency (integration tooling only; no runtime dependency).

**Implemented (Step 5):** ingredient dictionary + deterministic entity
resolution (`data/dictionary/ingredients.json`, `data/dictionary/reviewed-mappings.json`,
`src/domain/ingredients.ts`, `npm run resolve:ingredients`). Resolution is
strictly staged (`normalized_exact` / `alias_exact` / `reviewed_mapping`); no
LLM, no vector embeddings, and fuzzy `diceCoefficient` suggestions are never
auto-accepted — ambiguous or unresolved terms (e.g. coriander leaf vs seed, dry
vs fresh peas) are routed to the human review queue. Food states are kept
separate, so `cooked rice` → `rice-cooked` and `fried eggs` → `egg-fried`.
Outputs: coverage + review queues under `data/reports/` and `data/review/`.

**Implemented (Step 6):** deterministic quantity and unit normalization in
`src/domain/quantities.ts`, backed by the sourced registry
`data/dictionary/unit-conversions.json` and the `npm run normalize:units` CLI.
It preserves original quantity/unit text, parses fractions and ranges, supports
Arabic/Egyptian aliases, normalizes mass and volume, and applies a household
measure only when the exact ingredient/state/size factor exists. Cups never
share a universal gram weight. Unsupported or partial cases retain `null` grams
and are sent to `data/review/unit-normalization-review-queue.{json,md}`.
Egyptian volume aliases are tagged `egyptian_household` and never inherit US
cup/spoon factors; they remain `partial` until an ingredient-specific Egyptian
factor with provenance is reviewed. Egyptian count terms such as `حبة` and
`فص` can convert only through their sourced ingredient/size records.
Production edible-portion and cooking-yield arrays remain empty until reviewed
source records are supplied; the engine and validation support both fields.
The current production report is intentionally blocked at 0 gram conversions
because Step 5 has no human-approved ingredient mapping yet.

**Implemented (Step 7):** deterministic nutrition calculation in
`src/domain/nutrition.ts`, exported from `src/index.ts` as
`calculateRecipeNutrition(recipeId, servingRequest)`. The engine loads one
versioned structured-recipe snapshot, reuses the accepted Step 5 resolver and
Step 6 conversions, selects an exact food-state profile, and applies only
sourced edible-portion, cooking-yield, and nutrient-retention factors. It emits
ingredient arithmetic traces, full-recipe/per-serving/per-100-g bases,
source/version provenance, assumptions, missing ingredients, and count/weight/
per-nutrient coverage. Required missing mass makes the result `unavailable`;
other important omissions make an available result `partial`. Nutrient values
stay `null` unless all required ingredient contributions are known, while a
real zero stays `0`. Internal arithmetic is unrounded; display rounding occurs
once at the documented output boundary. Duplicate recipe IDs invalidate a
snapshot instead of selecting one silently. Weight coverage is reported only
when every ingredient weight is known; otherwise its denominator is explicitly
incomplete and the rate remains `null`.

The default repository reads the ignored runtime artifact
`data/processed/nutrition-calculator-snapshot.json` (schema `1.0`). It must
contain verified recipes plus the exact dictionary, review registry, unit
registry, nutrient profiles, and retention factors used by the calculation.
There is intentionally no committed production snapshot yet: Step 5 currently
has zero human-approved mappings and production nutrient profiles have not been
licensed/reviewed. The committed nutrition registry is synthetic and test-only;
the production loader cannot enable it.

**Implemented (Steps 8–10):** provider-neutral multilingual embedding
evaluation, approval-gated Qdrant ingestion, and the application tools
`search_recipes`, `search_guidelines`, `calculate_nutrition`, and
`compare_with_guideline`. Retrieval is never numeric authority: nutrition
delegates to Step 7, and guideline comparison requires one exact approved
structured rule. Synthetic evaluation data cannot choose a production model;
raw/staging directories cannot be ingested; and no corpus is loaded
automatically. See
[`docs/RETRIEVAL_AND_TOOLS.md`](docs/RETRIEVAL_AND_TOOLS.md).

**Implemented (Steps 11–12):** a versioned Egyptian-Arabic system prompt,
application-side safety routing, and one bounded LangGraph prototype that
searches for exactly one verified recipe and reports sodium only from the Step
7 deterministic calculator. It asks for clarification on ambiguity and fails
closed on missing/unavailable data. See
[`docs/AGENT_PROTOTYPE.md`](docs/AGENT_PROTOTYPE.md).

**Implemented (Steps 13–15):** deterministic same-basis recipe comparison,
approved-rule-only healthier alternatives, sourced food-pyramid guidance, a
60-question synthetic Egyptian-Arabic evaluation set, and separate retrieval,
numeric, and wording/comprehension metrics. The synthetic run is fully green,
but is explicitly not production evidence; human wording review remains
pending. See [`docs/STEPS_13_15.md`](docs/STEPS_13_15.md).

The complete original 20-step status—including every open production blocker—is
tracked in [`docs/ROADMAP_STATUS.md`](docs/ROADMAP_STATUS.md).

**Implemented engineering/readiness (Steps 16–20):** deterministic adversarial
evaluation, prompt-integrity iteration, a secure API and responsive RTL chat,
append-only consent-bound feedback, strict staging/production evidence gates,
container packaging, and operational/security documentation. See
[`docs/STEPS_16_20.md`](docs/STEPS_16_20.md).

**External production work still required:**
- Production-scale dictionary and reviewed conversion-factor expansion
- Production embedding-model approval and approved production-corpus ingestion
- Real-user evaluation, human wording review, the actual staging pilot, and its signed feedback report
- Approved infrastructure/credentials and owner-authorized official deployment
- Importing verified nutrition data into the DB (import pipeline is future
  work; the schema and migrations exist but no production data is loaded)

Do not treat engineering readiness as evidence that the external pilot or
production deployment has occurred.
