# NutriGuard — Decision Log

> **Status: Log. Each entry records a decision, its rationale, alternatives,
> consequences, and status. Step 1 is **reviewer-approved**; scope decisions are
> Adopted and numerical release thresholds remain **Proposed** pending their
> responsible human owners. Nothing here self-approves Step 2.**

Format: **DEC‑NNN · date · title** — decision / rationale / alternatives /
consequences / status.

---

## DEC‑001 · 2026-08-06 · TypeScript + Node ESM foundation (Step 0)
- **Decision:** Foundation is TypeScript, `type: module`, `module NodeNext`,
  compiled to `dist/`; toolchain only (`typescript`, `eslint`, `tsx`,
  `@types/node`, `@eslint/js`, `typescript-eslint`).
- **Rationale:** modern Node (≥22), deterministic typing, reproducible lockfile.
- **Alternatives considered:** plain JS ESM; CommonJS; no linting.
- **Consequences:** `.js` import extensions; tests via `node --test` + `tsx`.
- **Status:** Adopted (Step 0 approved).

## DEC‑002 · 2026-08-06 · Root carries no runtime dependencies; legacy archived (Step 0)
- **Decision:** root `package.json` has **empty `dependencies`**; the original
  prototype is archived under `legacy/` as a **non‑runnable reference**.
- **Rationale:** clean install (`npm ci`); prototype libs unused by the
  foundation.
- **Alternatives considered:** a separate `legacy/package.json`; runnable legacy.
- **Consequences:** legacy = reference only.
- **Status:** Adopted for the Step 0 foundation; the empty-runtime-dependency
  portion is superseded by DEC-043 for the Step 12 LangGraph prototype. The
  archived legacy application remains non-runnable.

## DEC‑003 · 2026-08-06 · Strict environment validation, no API keys (Step 0)
- **Decision:** `src/config/env.ts` validates `NODE_ENV` and `PORT` strictly;
  the foundation reads **no API keys**.
- **Rationale:** the foundation does not call OpenRouter; secrets must not be
  required or stored.
- **Alternatives considered:** keeping the key gated to production.
- **Consequences:** `.env` is not auto‑loaded; defaults apply.
- **Status:** Adopted (Step 0 approved).

## DEC‑004 · 2026-08-06 · MVP nutrient set (Step 1)
- **Decision:** MVP set is exactly: calories, protein, carbohydrate, total fat,
  saturated fat, fiber, sugar (when sourced), sodium.
- **Rationale:** common, explainable set for recipes/ingredients and
  comparisons.
- **Alternatives considered:** adding potassium/calcium/iron; fewer nutrients.
- **Consequences:** saturated fat and sugar remain **display‑only when sourced**
  until a compliant source is added (**amended by DEC‑012**).
- **Status:** Adopted (Step 1 approved).

## DEC‑005 · 2026-08-06 · Three supported languages (Step 1)
- **Decision:** Egyptian Arabic (`ar-EG`), Modern Standard Arabic (`ar`),
  English (`en`). Other languages → `unsupported_request`.
- **Rationale:** serves Egyptians (colloquial + MSA) with English fallback.
- **Alternatives considered:** colloquial‑only; a fourth language.
- **Consequences:** intent classification is language‑agnostic.
- **Status:** Adopted (Step 1 approved).

## DEC‑006 · 2026-08-06 · Eight canonical intents (Step 1)
- **Decision:** exactly eight intents: `find_recipe`, `recipe_nutrition`,
  `ingredient_nutrition`, `compare_recipes`, `general_guidance`,
  `lighter_recipe`, `unsupported_request`, `medical_safety_request`.
- **Rationale:** bounded MVP scope; unsupported and medical intents are
  first‑class.
- **Alternatives considered:** fewer intents; free‑form “ask anything”.
- **Consequences:** classification yields one `primary_intent` plus zero or
  more `safety_flags` (**amended by DEC‑016**).
- **Status:** Adopted (Step 1 approved).

## DEC‑007 · 2026-08-06 · Deterministic‑only nutrition (Step 1)
- **Decision:** all nutritional arithmetic is deterministic application code
  with provenance + versioning; the model only formats verified data.
- **Rationale:** core trust/safety rule.
- **Alternatives considered:** labeled model estimates.
- **Consequences:** missing data → `null`/`unknown`; unsupported refused.
- **Status:** Adopted (Step 1 approved).

## DEC‑008 · 2026-08-06 · Medical‑safety exclusion + metadata (Step 1)
- **Decision:** diagnosis, treatment, prescription, dosing, allergen guarantees,
  and emergency medicine are excluded; `medical_safety_request` refuses and
  refers to licensed professionals. Vegetarian/halal/kosher/allergen metadata is
  surfaced **only as source‑declared** and never guaranteed (**amended by
  DEC‑018**).
- **Rationale:** safety and liability boundaries.
- **Alternatives considered:** triage‑style assistance.
- **Consequences:** no personalised medical/compliance‑guarantee claims in MVP.
- **Status:** Adopted (Step 1 approved).

## DEC‑009 · 2026-08-06 · Every data source requires provenance + license (Step 1)
- **Decision:** no source is user‑facing without an approved provenance + license
  record; read‑only audit of pending sources is allowed. `food_pyramid.json` is
  an unapproved **Harvard Healthy Eating Pyramid candidate** (not Egyptian, not
  WHO). All current `data/raw` files remain `pending`.
- **Rationale:** licensing and traceability are mandatory rules.
- **Alternatives considered:** unlicensed data with attribution only.
- **Consequences:** saturated fat/sugar and any registry stay absent until real
  sources exist; unresolved records → manual‑review queue.
- **Status:** Adopted (Step 1 approved).

## DEC‑010 · 2026-08-06 · Architecture doc reflects non‑Git workspace (Step 0/1 fix)
- **Decision:** `docs/ARCHITECTURE.md` describes `data/raw/` as **intended for
  version control**, not committed.
- **Rationale:** this workspace is not a Git repository.
- **Alternatives considered:** initializing Git.
- **Consequences:** “clean checkout” verification limited to `npm ci`.
- **Status:** Adopted.

---

## Correction entries (Step 1, **adopted**)

## DEC‑011 · 2026-08-06 · Split cultural verification from calculation readiness
- **Decision:** track `egyptian_verification_status`
  (`pending`/`candidate`/`verified`/`rejected`) and `nutrition_calculation_status`
  (`unavailable`/`partial`/`complete`) independently. A verified‑Egyptian recipe
  may have partial nutrition.
- **Rationale:** original spec conflated culture and readiness.
- **Alternatives considered:** one combined status.
- **Consequences:** reflected in `MVP_REQUIREMENTS.md` §2 and
  `SUPPORTED_INTENTS.md`.
- **Status:** Adopted (Step 1 approved).

## DEC‑012 · 2026-08-06 · Saturated fat / sugar release behavior
- **Decision:** saturated fat and sugar are `display‑only when sourced`;
  absence → `unknown`, not a release blocker; sourcing them is a tracked follow‑up.
- **Rationale:** nutrient table previously contradicted a “required” value that
  is permanently unavailable.
- **Alternatives considered:** making them release‑blocking with a sourcing task.
- **Consequences:** release behavior is explicit (amends DEC‑004).
- **Status:** Adopted (Step 1 approved).

## DEC‑013 · 2026-08-06 · Rename to Approved Ingredient Registry
- **Decision:** “Verified Egyptian Ingredient Registry” becomes **Approved
  Ingredient Registry** — an ingredient need not be uniquely Egyptian; it must
  be normalized, approved, sourced, and state‑aware. Mapping affects
  `nutrition_calculation_status` only.
- **Rationale:** ingredient identity ≠ Egyptian identity.
- **Alternatives considered:** keeping the old name.
- **Consequences:** terminology updated across all docs.
- **Status:** Adopted (Step 1 approved).

## DEC‑014 · 2026-08-06 · Verified‑recipe flow (candidate → human review)
- **Decision:** automated rules create a **candidate** only; human review is
  mandatory for `verified`. Requires documented cultural evidence + provenance.
  Evidence paths: authoritative Egyptian source attribution; approved‑dish
  registry match; documented cultural reference; domain‑reviewer approval.
  The source needn’t carry an Egyptian cuisine tag. Rejection reasons + reviewer
  identity are preserved. Ingredient mapping/quantity are **not** cultural
  criteria.
- **Rationale:** verification is an evidence‑based human decision.
- **Alternatives considered:** fully‑automated verification.
- **Consequences:** `verified` always has a recorded human review.
- **Status:** Adopted (Step 1 approved).

## DEC‑015 · 2026-08-06 · `lighter_recipe` → `derived_recipe_variant`
- **Decision:** the lighter result is a **derived modification**, not a verified
  source recipe; it requires an approved deterministic rule, original recipe ID,
  changed ingredients/methods, recalculated nutrition, provenance, version,
  assumptions, and `nutrition_calculation_status`. No new factual cooking
  instructions/ingredient quantities without an approved rule.
- **Status:** Adopted (Step 1 approved).

## DEC‑016 · 2026-08-06 · Intent routing (one primary intent + safety flags)
- **Decision:** classification returns one `primary_intent` and zero or more
  `safety_flags`; emergency/medical routing takes precedence; compound requests
  are decomposed or clarified.
- **Status:** Adopted (Step 1 approved).

## DEC‑017 · 2026-08-06 · Nutrition result bases
- **Decision:** `recipe_nutrition` reports `full_recipe`, `per_serving`, and
  `per_100g`, with serving count/weight shown when available and explicit
  partial/unknown behavior. `compare_recipes` compares **equivalent bases** and
  explicitly warns on unlike serving sizes.
- **Status:** Adopted (Step 1 approved).

## DEC‑018 · 2026-08-06 · Metadata is declared, not guaranteed
- **Decision:** vegetarian/halal/kosher/allergen metadata is surfaced only as
  source‑declared; NutriGuard never verifies or guarantees compliance or
  allergen safety; missing stays `unknown`.
- **Status:** Adopted (Step 1 approved).

## DEC‑019 · 2026-08-06 · DoD split and correct status line
- **Decision:** DoD is split into documentation/tooling, data‑processing, and
  user‑facing‑nutrition sections plus MVP gates. The false “No deliverable is
  Done” line is fixed: **Step 0 approved; Step 1 pending; Step 2+ not started**.
- **Status:** Adopted (Step 1 approved).

## DEC‑020 · 2026-08-06 · Measurable provisional gates + roles
- **Decision:** add measurable MVP release gates (Egyptian‑review coverage,
  zero leakage, deterministic‑only, guidance provenance, critical‑safety zero,
  ingredient‑mapping/known‑weight coverage, calculation tolerance, Recall@K) with
  thresholds labeled **proposed**; add Nutrition Domain Reviewer, Egyptian
  Recipe/Cultural Reviewer, Security/Privacy Owner, Legal/license reviewer.
- **Status:** Adopted (Step 1 approved). **Numerical gate thresholds remain
  Proposed** pending the responsible owners’ approval.

## DEC‑021 · 2026-08-06 · Documentation link checker + docs:check
- **Decision:** add `scripts/docs-link-check.mjs` (Node built‑ins only) and
  `npm run docs:check`, verifying that referenced local files exist, that
  referenced headings exist, and that malformed double‑hash anchors fail. Fixed
  broken `##`/`#-...` links throughout. Coverage includes **all Markdown files
  under `docs/` and the repository `README.md`** (amended by DEC‑029).
- **Status:** Adopted (Step 1 approved; tooling implemented and tested).

## Correction round 2 (Step 1, **adopted**)

## DEC‑022 · 2026-08-06 · Precise `nutrition_calculation_status` definitions
- **Decision:** `nutrition_calculation_status` is defined identically in
  `MVP_REQUIREMENTS.md`, `SUPPORTED_INTENTS.md`, `DEFINITION_OF_DONE.md`, and
  this log:
  - **`unavailable`** — no valid deterministic nutrition result can be produced
    for the requested basis.
  - **`partial`** — at least one result can be calculated, but an ingredient,
    quantity, conversion, release‑required nutrient, or requested calculation
    basis is missing.
  - **`complete`** — all nutritionally significant ingredients and quantities
    required for calculation are resolved, all release‑required nutrients are
    available, and every applicable result basis is calculated from approved
    data.
  Optional/display‑only nutrients (saturated fat, sugar) may remain `unknown`
  without changing `complete` to `partial`; their missing status must still be
  shown.
- **Status:** Adopted (Step 1 approved). **Amended by DEC‑030** (per‑basis vs
  overall status).

## DEC‑023 · 2026-08-06 · Calculation bases and comparison rules (amends DEC‑017)
- **Decision:** `full_recipe` requires **resolved ingredient amounts**;
  `per_serving` requires a **serving count greater than zero** (serving weight
  is not required for the division); `per_100g` requires a **valid final
  cooked/yield weight greater than zero**. Serving weight is derived **only**
  when final cooked weight and serving count are both known. Return **every
  basis that can be calculated**; every unavailable basis is returned as
  **unavailable with an explicit reason**. Removes the “at least one basis”
  contradiction. Comparison defaults to **`per_100g`** when available;
  `per_serving` comparison shows each serving weight when known and warns when
  serving sizes differ (stating portions may not be equivalent when unknown);
  `full_recipe` comparison is allowed only for an explicit whole‑batch request
  and must show total yield and serving count; full‑recipe totals are never
  described as equivalent when yields differ.
- **Status:** Adopted (Step 1 approved).

## DEC‑024 · 2026-08-06 · Safety‑flag classes (amends DEC‑008, DEC‑016, DEC‑018)
- **Decision:** safety flags are split into **blocking/override**
  (`emergency`, `medical_advice_request`,
  `vulnerable_population_personalization`, `allergen_safety_guarantee`) and
  **non‑blocking caution/metadata** (`allergen_metadata_filter`,
  `religious_metadata_filter`, `vegetarian_metadata_filter`). Metadata filters
  may continue through `find_recipe` with an explicit not‑verified/not‑guaranteed
  warning. A personal allergen‑safety guarantee or medical recommendation takes
  the medical‑safety route. A religious‑compliance guarantee is refused as
  `unsupported_request` and never produces a medical referral.
- **Status:** Adopted (Step 1 approved).

## DEC‑025 · 2026-08-06 · Ingredient registry scope (amends DEC‑013)
- **Decision:** `ingredient_nutrition` may return an Approved Ingredient
  Registry record **only** when the ingredient is used by at least one verified
  Egyptian recipe in the supported corpus, or has been explicitly approved as
  part of the Egyptian‑food ingredient scope. Arbitrary global ingredients are
  not exposed merely because they exist in the registry.
- **Status:** Adopted (Step 1 approved).

## DEC‑026 · 2026-08-06 · Canonical coverage metrics (amends DEC‑020)
- **Decision:** define, before any Step 2 data work, five metrics in
  `DEFINITION_OF_DONE.md` §6 — ingredient‑line mapping coverage, quantity
  parsing coverage, gram‑conversion coverage, recipe complete‑coverage, and
  mass‑weighted coverage — each with explicit numerator, denominator,
  exclusions, unknown‑denominator behavior, and count‑based plus mass‑weighted
  reporting. Release gates reference these definitions.
- **Status:** Adopted (Step 1 approved). **Numerical coverage thresholds remain
  Proposed** pending owner approval.

## DEC‑027 · 2026-08-06 · ±2% gate clarification (amends DEC‑020)
- **Decision:** the G8 ±2% gate measures **deterministic calculator
  correctness** against a **reviewed golden set**, including defined rounding
  behavior. It does **not** claim real food composition is accurate within ±2%;
  data‑source uncertainty is reported separately.
- **Status:** Adopted (Step 1 approved). The **±2% figure remains a Proposed
  threshold** pending owner approval.

## DEC‑028 · 2026-08-06 · Privacy‑safe logging
- **Decision:** logging is structured, minimal, and operational only. Raw user
  queries, health information, and personal data are not required to be logged
  and are not logged by default; logs are redacted and contain no
  secrets/PII/health data by default.
- **Status:** Adopted (Step 1 approved).

## DEC‑029 · 2026-08-06 · Docs tooling coverage + text fixes (amends DEC‑021)
- **Decision:** `docs:check` also covers `README.md`; tests prove a broken
  README local link fails. Replaced the nonexistent `check` command in
  `DEFINITION_OF_DONE.md` with real commands; fixed “it is the not” → “it is
  not”; corrected “Harvard Health Eating‑Pyramid” → “Harvard Healthy Eating
  Pyramid”.
- **Status:** Adopted (Step 1 approved).

## Step 1 approval record

## DEC‑030 · 2026-08-06 · Per‑basis vs overall calculation status (amends DEC‑022, DEC‑017)
- **Decision:** each result basis carries **`basis_status = available |
  unavailable`**; an unavailable basis must include a **machine-readable
  `reason`**. Overall `nutrition_calculation_status`:
  - **`unavailable`** — **no valid basis can be calculated**;
  - **`partial`** — **at least one basis can be calculated**, but a requested or
    applicable basis, required nutrient, ingredient, quantity, or conversion is
    missing;
  - **`complete`** — **all applicable/requested bases and release-required
    nutrients are available from approved data**.
  Optional/display-only nutrients (saturated fat, sugar) may remain `unknown`
  without downgrading `complete`; their missing status must still be shown.
- **Status:** Adopted (Step 1 approved).

## DEC‑031 · 2026-08-06 · Step 1 reviewer approval recorded
- **Decision:** the Step 1 documentation has passed **final reviewer approval**.
  Step 1 scope decisions are **Adopted**; **numerical release thresholds** (all
  italics in `DEFINITION_OF_DONE.md` §5, and the ±2% figure) **remain
  Proposed** until the responsible human owners approve them. Statuses of
  DEC‑004..DEC‑029 are updated accordingly.
- **Status:** Adopted.

## DEC‑032 · 2026-08-06 · Step 2 read-only data audit pipeline (evidence-based)
- **Decision:** implement a **deterministic, read-only source audit** exposed as
  `npm run audit` producing `data/reports/data-audit.{json,md}` and review
  queues under `data/review/`. No source under `data/raw/` is ever written.
- **Rationale:** an evidence-based audit is required before any nutrition
  calculation; it must be reproducible (deterministic) and must not mutate
  approved raw inputs.
- **Scope decisions:**
  - Audit only **Step 2** sources (recipe CSV, ingredient CSV, guideline PDF,
    food-pyramid JSON + 18 JPEGs). No Step 3+ work in this change.
  - Exact ingredient matching is normalized-term **exact equality** against the
    reference FOOD vocabulary; the independent recalculation confirms the
    claimed **0.63%** baseline (29/4,633). This measures **unique-normalized-term
    exact-vocabulary match** only, **not** mapping coverage. `leadingQuantityHeuristic`
    (13,362/13,628) and `recognizedUnitHeuristic` (11,577/13,628) are reported
    as diagnostic heuristics; `canonicalQuantityParsingCoverage` and
    `canonicalIngredientLineMappingCoverage` remain **`unknown`** until approved
    rule sets exist. Heuristics are never displayed under an unqualified
    "coverage" label.
  - Recipe classification uses only the automated classes `candidate`,
    `needs_review`, `not_egyptian`, `rejected`. Automated logic **never** emits
    a `verified_egyptian` status; that status can only be set by a human
    reviewer with documented cultural evidence, reviewer identity, and review
    date. `candidate` additionally requires **C-1** (source_id, source_version,
    access_date/provenance record), **C-2** (non-empty title, non-empty
    instructions, parseable ingredients, valid UTF-8), and **C-3** (linkable
    documented cultural-evidence claim). Broad Middle Eastern / Mediterranean /
    Levantine / Arab / North African tags are **never** positive evidence and
    never count toward the signal total (dish alias + broad tag stays
    `needs_review`). The current recipe CSV carries no provenance or evidence
    columns, so **candidate count is zero**. Dish aliases match at token
    boundaries only (no substring hits, e.g. "ful" cannot match inside
    "truthful"/"spoonful").
  - Missing values are reported as null/unknown evidence; never coerced to 0.
  - The guideline PDF is parsed for page count, visible source/date, and
    extraction availability. WHO identity / title / visible date / OCR samples
    are **never hardcoded**: WHO is detected only from actual extracted content
    (e.g. "World Health Organization", "WHO") or an explicit provenance record.
    `provenanceStatus = identified` only when such evidence exists, otherwise
    `unknown`. The extracted OCR layer of the WHO file corrupts the identity
    string, so with no clean content match and no explicit provenance record
    the file is reported as **not identified** (`unknown`); notes contain only
    findings actually detected, and the extraction note agrees with
    `extractionAvailable`.
  - Nutrition cells use **one canonical classifier** for all nutrition
    summaries: missing | valid numeric | explicit zero | recognized trace
    marker | invalid. Trace markers (T/tr/trace) are never invalid. Source-level
    `invalidNumerics` equals the sum of `nutrition.columns[].invalid`. `Unnamed:
    21` and metadata headers are excluded; the current ingredient source audits
    **20 nutrition columns** (missing=1,420, valid=7,124, explicit zero=792,
    recognized trace=63, invalid=1).
  - Food-pyramid JSON schema violations (scalar root, non-array `layers`,
    non-object entries, missing required fields, invalid field types, duplicate
    category keys) are **structural errors** -> `structurallyInvalid=true` and a
    non-zero CLI exit; only non-structural quality/provenance issues remain
    warnings. JPEGs are validated by walking the marker segment structure, so a
    fake six-byte `FF D8 FF E0 FF D9` is flagged.
  - Runner-level failures (wrong image count, duplicate image hashes) and all
    source structural errors are surfaced at the top level of the JSON/Markdown
    report (`structuralErrors`).
  - No LLM-generated SQL and no secrets.
- **Alternatives considered:** a heavier full-OCR/PDF-text pipeline beyond the
  in-repo minimal parser (deferred); permissive multi-token fuzzy matching for
  the ingredient baseline (rejected to keep the 0.63% baseline directly
  reproducible).
- **Consequences:** reports and queues are generated deterministically; raw
  files verified byte-identical (SHA-256) before/after `npm run audit`;
  non-zero exit on structurally invalid inputs. Step 2 outputs are for
  reviewer decision and are **not self-approved**.
- **Status:** Proposed — awaiting Step 2 reviewer approval.

## DEC‑033 · 2026-08-06 · C-1/C-3 strict gates, list-parsed directions, WHO manifest + content-derived title (Step 2)
- **Decision:** tighten the Step 2 audit gates and the guideline report:
  - **C-1** `access_date` must be a **strict ISO date** (`YYYY-MM-DD` pattern plus a real calendar date — `2026-02-30`, `2026-13-01` and free text like `not-a-date` all fail).
  - **C-3** `culture_evidence_link` must be a **valid http(s) URL** or the ID of a **manifest cultural-evidence record** whose applicability scope matches the dish being classified. Manifest evidence IDs are **purpose-typed**: `guideline_provenance` IDs (e.g. the WHO healthy-diet factsheet `EG-REF-WHO-001`) verify the guideline source and are **never** eligible for recipe C-3 — a WHO fact sheet is general nutrition guidance, not dish cultural evidence; only `egyptian_recipe_cultural_evidence` records scoped to the dish (e.g. `EG-KOSHARI-CULTURAL-001`, `applicableTo: [koshari, kushari, …]`) may resolve a C-3 claim. Free text such as `not-linkable` fails.
  - **C-2** `directions` are parsed with the source's list-field format (`parseListField`, JSON-array style, like `ingredients`); `[]`, empty/whitespace strings, and arrays containing only whitespace fail C-2. At least one meaningful non-empty instruction is required.
  - The audit source manifest supplies the **explicit provenance record** for the WHO guideline PDF (identity/title/date) and registers the purpose-typed evidence references above, **without** changing license/approval status (all sources stay `pending`). A manifest is optional; when absent the WHO PDF stays `unknown`.
  - `visibleTitle` for the guideline PDF is **derived from the extracted content** (the clean Title-case phrase immediately preceding the visible date), not from claiming WHO identity merely because the file has text; provenance/Info titles are only fallbacks.
  - OCR-corruption detection flags the actual garbled WHO-name region (`Donate rid Health wey viyanization`) as `ocr_corrupted_organization_name` with **bounded samples**, only when a WHO identity is claimed (content or manifest) but the clean name is absent verbatim.
- **Rationale:** the reviewers required real (not presence-only) C-1/C-3 validation and a manifest-resolvable evidence identity, list-parsed directions, and a content-derived WHO report that detects the OCR corruption instead of reporting the PDF as unidentified. The final blocker was that the WHO healthy-diet factsheet provenance must never satisfy the recipe C-3 Egyptian cultural-evidence gate, so evidence purposes are separated and cultural evidence is scoped per dish.
- **Alternatives considered:** hardcoding WHO/title in the scanner (rejected — no hardcoded identity); requiring the manifest always (rejected — optional, absent roots keep the existing `unknown` behavior); registering every manifest ID as eligible for C-3 (rejected — WHO general-nutrition provenance must not satisfy a recipe cultural-evidence gate).
- **Consequences:** candidate requires genuine resolution of every gate; the real WHO PDF now reports `provenanceStatus=identified`, `visibleTitle="Healthy diet"`, `ocrNoiseDetected=true` while license review stays `pending`; the WHO `EG-REF-WHO-001` provenance ID can never resolve recipe C-3, and only dish-scoped cultural evidence (e.g. `EG-KOSHARI-CULTURAL-001`) can. Raw files under `data/raw/` remain untouched.
- **Status:** Proposed — awaiting Step 2 reviewer approval.

## DEC‑034 · 2026-08-06 · Step 3 Egyptian recipe curation + manual-review pipeline
- **Decision:** implement the Step 3 recipe **staging registry** and **review pipeline** (`npm run stage`):
  - A curated registry `data/staging/recipes.json` with a stable schema (`src/domain/recipes.ts`): Arabic/English/Egyptian names + aliases, category/subcategory, Egyptian region, servings, final cooked weight, source reference, license status, verification status, reviewer + review date, version, preserved original row.
  - **Deterministic stable IDs** (`EGR-` + 16 hex of SHA-256 over source file|row|normalized title); never random, stable across runs.
  - **Import from the raw recipe CSV** (read-only on `data/raw/`): rows with explicit Egyptian-scope evidence are staged `needs_review`; clearly non-Egyptian rows (all declared cuisines non-Egyptian, no signal) are staged `rejected` with recorded evidence (`review.autoRejected`, timeline entry); rows with no Egyptian evidence and no decidable classification are **excluded** — the general-purpose global recipe dump `data/processed/cleaned_recipes.json` is explicitly ignored and reported, never treated as Egyptian.
  - **No fabrication:** missing fields stay `null` / `not_assessed` (Arabic names, region, servings, cooked weight, license); no invented zeros; no invented recipes.
  - **Automation never verifies:** a record becomes `verified` only through a human review decision recorded with reviewer identity, a strict ISO review date, and documented cultural-evidence references; decisions are **append-only** in `review.timeline` (violations of attribution/evidence/ISO date are validation failures).
  - **Verified‑MVP gate** (`isEligibleForVerifiedDataset`): a record enters the verified MVP dataset only when `verified`, reviewer-attributed, evidence-documented, license `approved`, and with a source reference.
  - **Current availability report:** `data/reports/recipe-verification-report.{json,md}` reports verified counts truthfully (currently **0 verified**) and lists the blockers.
  - **Manual-review workflow documented:** `docs/MANUAL_REVIEW_WORKFLOW.md`.
- **Rationale:** Step 3 must not invent or auto-verify recipes; it must provide the schema, import pipeline, validation, and review queue for a human reviewer, and report the missing/blocked data accurately.
- **Alternatives considered:** adding the `cleaned_recipes.json` dump to the registry (rejected — general-purpose, not Egyptian, no provenance); letting the pipeline set `verified` for strong signals (rejected — automation never self-verifies); random/UUID recipe IDs (rejected — need stable, reviewable IDs).
- **Consequences:** the registry is reviewable and traceable; validation exits non-zero on duplicate IDs / missing sources / invalid statuses / unverifiable records; no unverified record can enter the verified MVP dataset.
- **Status:** Proposed — awaiting Step 3 reviewer approval.

## DEC‑035 · 2026-08-07 · PostgreSQL schema, migrations and provenance (Step 4)
- **Decision:** implement the normalized PostgreSQL data model + provenance via
  `migrations/` SQL and a migration runner (`src/data/database.ts`, `npm run
  db:*`). Permanent constraints enforced at the DB layer:
  - **Missing = NULL, never an invented zero**: optional numerics are NULLable
    and a CHECK rejects only an impossible range — a real measured zero is
    stored as `0` (distinct from NULL). `source_id` / `data_version_id` sit on
    every numeric record table and are **pinned together** by a composite FK
    against `data_versions(source_id, id)`, so a record's version always
    belongs to the record's own source.
  - **No impossible values:** `CHECK` blocks negative nutrient amounts,
    weights, conversion/yield/retention factors and rule values; a legitimate
    measured zero is allowed (e.g. a nutrient fully lost → retention 0).
  - **Food states everywhere:** constrained `food_state`
    (`raw/cooked/boiled/fried/baked/drained`) on ingredients, recipes,
    recipe_ingredients, nutrient_values and ingredient_unit_conversions, plus
    `food_state_from`/`food_state_to` on cooking_yield_factors. Uniqueness over
    a nullable `food_state` uses `COALESCE(food_state,'')` expression indexes so
    NULL behaves like one distinct value rather than Postgres's default.
  - **Original values preserved:** conversions, yields, retentions, guideline
    rules carry `original_value`/`original_unit`/`original_context` columns
    verbatim next to normalized machine values.
  - **Enforceable review records:** `review_records` reference stable, typed
    foreign keys (source/ingredient/recipe/guideline_document/guideline_rule)
    with an exactly-one-target CHECK and per-target FK — no orphanable
    polymorphic `(reviewable_type, reviewable_key)` pair.
  - **Quantitative guidance split from text:** guideline recommendations live
    in `guideline_rules` (metric/operator/value/unit); explanatory text lives in
    `guideline_chunks`.
  - **No automatic import of unverified production data:** the schema is created
    entirely from migrations; the only seed is an explicitly **synthetic,
    rejected-source** fixture loaded only with `NUTRIGUARD_ALLOW_SYNTHETIC_SEED=1`
    (test-only), never as production data.
- **Scope decision:** the `pg` driver is a **dev dependency** (migration runner
  + integration tests). Schema verification is **real**: `npm run db:validate`
  and the DB integration test query the actual PostgreSQL catalog
  (`src/data/schemaVerify.ts`) — there is no substring-based validator. The
  DB-less file (`tests/database-schema.test.ts`) covers file enumeration,
  filename-resolved down migrations, no embedded `BEGIN`/`COMMIT`, and the
  test-only seed marker. The live integration test (`tests/database.integration.test.ts`)
  requires `NUTRIGUARD_RUN_DB_INTEGRATION=1` + `NUTRIGUARD_ALLOW_SYNTHETIC_SEED=1`,
  refuses non-`test` database names, creates its own disposable `ng_it_*`
  schema, and is skipped — honestly, not faked — when `DATABASE_URL` is absent.
- **Runner invariants:** the runner bootstraps `schema_migrations` before any
  query (a completely empty PostgreSQL is a valid start), is the SINGLE
  transaction owner (migration `.sql` files never `BEGIN`/`COMMIT`
  themselves), and resolves down migrations from the actual `*.down.sql`
  filenames instead of a hard-coded `<NNNN>_init` convention.
- **Rationale:** Step 4 must establish a repeatable, provenance-aware database
  without inventing thresholds. The disposable PostgreSQL (Docker
  `postgres:16-alpine`) used for the live acceptance checks was confirmed
  reachable by `pg`, and the whole DB-backed suite ran green against it.
- **Alternatives considered:** embedding the schema into app code only (rejected
  — migrations must be reviewable SQL); committing a real .env
  connection (rejected — secrets never in source control); auto-seeding on
  migrate (rejected — unverified data must not be imported automatically).
- **Consequences:** `migrations/` is no longer "reserved"; `src/data/` now holds
  DB access; a clean DB can be created from `npm run db:migrate`; rollback via
  `npm run db:rollback`; `docs/ARCHITECTURE.md` and `README.md` updated; the
  test database lives in a disposable Docker container (no real data).
- **Status:** Proposed — awaiting the Step 4 (post-correction) reviewer decision.
- **Corrections (2026-08-08, second reviewer round, now implemented and
  verified):** (1) nullable provenance closure — the source/version composite FK
  is `MATCH FULL` **and** each provenance-bearing table has an explicit
  pair-nullability CHECK (both NULL **or** both non-NULL; a source without a
  version and a version without a source are both rejected);
  (2) `guideline_rules` chunk/document consistency — composite FK
  `(document_id, chunk_id) → guideline_chunks (document_id, id)` plus
  `UNIQUE (document_id, id)`, so a rule's chunk must belong to its own document;
  (3) strict positivity — `ingredient_unit_conversions.factor > 0` and
  `cooking_yield_factors.yield_factor > 0` (zero would silently zero conversions);
  `>= 0` remains only where a real measured zero is valid (nutrients, retention,
  quantitative rule values); (4) `db:status` bootstraps `schema_migrations`
  before reading it, so an empty DB is safe; (5) `schemaVerify.ts` now verifies
  the **exact** constraints (MATCH FULL + pair-nullability CHECK per table,
  same-document chunk FK, strict positivity) against the live catalog, not just
  the presence of a composite FK; (6) the live integration test exercises all
  adversarial cases (both-NULL accepted; source-only / version-only /
  non-existent-pair / mismatched-pair rejected; factor and yield factor of
  0 or −1 rejected; cross-document chunk rejected).

---

## DEC-036 · 2026-08-08 · Ingredient dictionary + deterministic entity resolution (Step 5)
- **Decision:** a curated AR/EN/EG ingredient dictionary plus a deterministic,
  review-gated resolver (module `src/domain/ingredients.ts`, CLI `npm run
  resolve:ingredients`) replaces any agent-time guessing about what a raw
  ingredient term means.
  - **No LLM, no embeddings, no fuzzy auto-accept:** every accepted mapping is
    reproducible and carries exactly one stage — `normalized_exact`,
    `alias_exact`, or `reviewed_mapping` (human review record in
    `data/dictionary/reviewed-mappings.json`). `diceCoefficient` suggestions
    (threshold 0.55) are surfaced in the review queue but never applied.
  - **Ambiguity is honest, never merged:** duplicate terms (coriander leaf vs
    seed, dry vs fresh peas) resolve to `ambiguous` with their candidate keys
    and go to the review queue; the resolver never guesses on collision.
  - **Food states are first-class data:** constrained
    `raw/cooked/boiled/fried/baked/drained`, matching the Step 4 schema's
    `food_state`. A two-pass matching (stateful full-text first, stripped as
    fallback) maps `cooked rice` → `rice-cooked` and `fried eggs` →
    `egg-fried`. Arabic natural forms such as "البيضة المقلية" / "بيضة مقلية"
    resolve via definite-article ("ال") folding without merging food states.
  - **Canonical records are repository-backed but unapproved:** the master
    dictionary entries in `data/dictionary/ingredients.json` are present in the
    repo for review, but they do not claim a human approval record. Their
    provenance status is `unapproved`; a record resolves only when its
    provenance status is `approved`.
  - **Approval is content-bound, not ID-only:** the review registry
    (`data/dictionary/review-registry.json`) stores immutable review records,
    each carrying a deterministic SHA-256 `contentHash` over the exact mapping content
    (id, normalized term, toKey, reviewer, date, evidence, source). A reviewed
    mapping is approved only when a registry record with its id exists AND the
    hash of the mapping's *current* content matches the stored hash — changing
    any field after approval invalidates it. The registry verifies its own
    stored hashes on load (registry-tamper detection). The resolver fails closed
    when no registry is supplied, and every record sharing a duplicate registry
    ID is rejected. There is no path that approves a record by copying its ID
    into another file.
  - **Original text preserved verbatim** next to `normalizedQuery` in every
    resolution record and review-queue record; raw source files are never
    rewritten.
  - **Count/weight coverage is honest:** reports compute occurrence-based
    by-count coverage and, when `--weighted` is supplied, by-weight coverage;
    unique-term coverage is reported separately after removing quantity/unit from
    identity while preserving every occurrence context. Weighted entries are validated
    against the resolution inventory — every weighted occurrence must exist in
    the inventory, its original text must match, and source identity
    (recipeId/row/index) is required; foreign, mismatched and duplicate
    weighted entries are rejected and reported. Unresolved counts and weights
    are real nulls/0s, never invented numbers.
  - **CLI exit contract:** the honest report + review queue are always written;
    the CLI exits non-zero when zero occurrences are mapped to an approved
    canonical record, or when dictionary, mapping, registry, occurrence-count,
    or weighted-coverage validation fails.
- **Scope controls:** dictionary is small (51 canonical records) and **explicitly
  source-gated** to Egyptian food; fuzzy suggestions stay below-threshold by
  design so humans own every new mapping.
- **Alternatives considered:** agent-time LLM resolution (rejected — not
  reproducible/provable); vector store during ingestion (rejected — future work,
  Step remainder); auto-accepting fuzzy matches (rejected — violates
  determinism); ID-only approval (rejected — approval must bind to content).
- **Consequences:** golden artifacts
  `data/reports/ingredient-dictionary-coverage.{json,md}` and the review queue
  `data/review/ingredient-dictionary-review-queue.{json,md}` are regenerated by
  the CLI; `data/dictionary/*` is committed and human-reviewable;
  `package.json` gained `resolve:ingredients`; `README.md` /
  `docs/ARCHITECTURE.md` updated; `tests/ingredients.test.ts` (52 cases) green.
- **Status:** Proposed — awaiting the Step 5 reviewer decision; current coverage
  is reported truthfully (**0/14584 occurrences resolved, 0.00%**; 3327 unique
  terms; 0 approved mappings; 0 content-hash-verified registry records). No
  human review record exists yet, so nothing is approved and nothing is
  fabricated to reach a coverage target.

---

## DEC-037 · 2026-08-09 · Deterministic quantities, units and food-state conversions (Step 6)

- **Decision:** quantity/unit parsing and conversion live in
  `src/domain/quantities.ts`; the reviewable factor registry is
  `data/dictionary/unit-conversions.json`; production coverage is generated by
  `npm run normalize:units`.
- **Parsing contract:** preserve the complete original text plus the exact
  original quantity and unit substrings; separate ingredient text; accept
  Western/Arabic digits, decimals, fractions, mixed/vulgar fractions and ranges;
  reject invalid or descending ranges.
- **Conversion contract:** `g`/`kg` normalize to grams and volume units normalize
  to millilitres. A volume or count becomes grams only through an exact
  ingredient + food-state + size factor. There is no universal cup weight and
  raw/cooked records never substitute for each other.
- **Provenance contract:** unit definitions and ingredient factors name their
  source. Applied factors return source title/URL/access date, locator, original
  value, original context, and uncertainty. NIST supplies standard US household
  volumes; USDA Bulletin 72 supplies the committed ingredient/count examples.
- **Missing-data contract:** `to taste`, `as needed`, frying-oil absorption,
  unknown measures, and missing ingredient factors produce explicit
  `unsupported` or `partial` results with `null` grams. Edible-portion and
  cooking-yield structures are supported, but their production arrays stay empty
  until a source is reviewed; test-only fixtures exercise both paths.
- **Integration gate:** the CLI uses only Step 5 accepted mappings, always writes
  the coverage and manual-review queue, and exits non-zero if validation fails,
  no approved mapping exists, or no production occurrence converts to grams.
- **Current production status:** blocked by the truthful Step 5 state: zero
  human-approved ingredient mappings. The current report therefore records 0
  gram conversions without inventing approvals or values.
- **Status:** Implemented for review; production readiness remains blocked on
  human approval of the Step 5 dictionary/mappings and reviewed expansion of
  conversion factors.
- **Corrections after Step 6 review:** raw-only USDA factors now require the
  explicit `raw` state (an unspecified state cannot borrow them); aliases are
  tagged as `standard` or `egyptian_household`, and Egyptian cups/spoons never
  inherit US factors; registry validation enforces required unit semantics,
  fails conversion closed on any registry issue, and requires globally unique
  factor IDs; qualitative/frying lines retain any supplied original quantity
  and unit while still returning no fabricated grams. The open Egyptian
  [FAO Egyptian household-survey methodology](https://www.fao.org/4/a0442e/a0442e00.pdf)
  confirms that NNI developed a household-measure weight list, but the values
  are not present in the accessible report, so no Egyptian volume factor is
  invented.

---

## DEC-038 · 2026-08-09 · Deterministic, version-pinned nutrition calculation (Step 7)

- **Decision:** `calculateRecipeNutrition(recipeId, servingRequest)` is pure
  deterministic application arithmetic over a repository-loaded versioned
  snapshot. No LLM, fuzzy match, vector match, or generated numeric fallback is
  part of the calculation path.
- **Input gate:** only a `verified` structured recipe and registries that pass
  fail-closed validation may calculate. Production sources must be approved,
  licensed, and version-matched. Synthetic profiles require an explicit
  test opt-in that the default repository never enables. Duplicate recipe IDs
  invalidate both JSON and in-memory snapshots instead of being resolved by
  array order.
- **State/factor rule:** nutrient profiles match the resolved food state exactly.
  A raw profile can cross to a cooked target only with the exact cooking-yield
  and per-nutrient retention factors. Edible portions and count/volume weights
  likewise require a unique sourced factor. Missing or ambiguous factors remain
  omissions.
- **Totals rule:** ingredient contributions aggregate at full JS numeric
  precision; rounding happens once at the output boundary. A required unknown
  contribution makes that nutrient's published amount `null`, while the known
  subtotal remains visibly labelled. A true measured zero remains zero.
- **Basis/status rule:** the operation returns full-recipe, per-serving, and
  per-100-g bases. Per-serving requires a positive sourced/request serving
  count; per-100-g requires a positive final-food weight. DEC-030 governs the
  overall `unavailable`/`partial`/`complete` result.
- **Audit rule:** every response includes ingredient arithmetic, exact mapping/
  conversion/profile/factor IDs, source/version provenance, missing ingredients,
  assumptions, blockers, and objective count/weight/per-nutrient coverage.
  Weight coverage has a usable denominator only when every ingredient weight is
  known; an incomplete denominator produces a `null` rate.
- **Production status:** implemented and golden-tested, but intentionally
  unavailable for production recipes until Step 5 mappings and production
  nutrient profiles/factors receive human approval and an immutable runtime
  snapshot is assembled. Test fixture values are never production data.
- **Status:** Implemented for review; production data readiness remains blocked.

---

## DEC-039 · 2026-08-09 · Provider-neutral Arabic embedding evaluation (Step 8)

- **Decision:** benchmark exactly two or three configured multilingual embedding
  models through an OpenAI-compatible embeddings adapter. Rank models by
  Recall@K and MRR over a versioned Arabic retrieval dataset.
- **Selection gate:** a production model requires a unique threshold-meeting
  winner. A tie, failure, or missed threshold requires human review. A dataset
  marked synthetic may test the machinery but cannot select production.
- **Status:** Implemented for review; production model selection remains blocked
  until a reviewed, non-synthetic evaluation dataset is supplied.

---

## DEC-040 · 2026-08-09 · Approved-only Qdrant ingestion (Step 9)

- **Decision:** use a Qdrant REST adapter for production vector storage and an
  in-memory adapter only for deterministic tests. Ingestion requires an explicit
  corpus manifest; raw and staging directories are never automatically imported.
- **Data boundary:** recipes and guideline text may be embedded only with
  approved license/review state and complete source/version provenance. Recipe
  documents additionally require human verification. Ingredients and numeric
  nutrition remain structured SQL/application data.
- **Operational rule:** point IDs are deterministic and content-bound. A new
  namespace is upserted before stale points are removed, and an empty corpus is
  rejected. Query filters independently enforce the approval boundary.
- **Status:** Implemented for review; no production corpus has been approved or
  ingested.

---

## DEC-041 · 2026-08-09 · Deterministic application tools (Step 10)

- **Decision:** expose four application services: `search_recipes`,
  `search_guidelines`, `calculate_nutrition`, and `compare_with_guideline`.
- **Numeric authority:** nutrition always delegates to the Step 7 deterministic
  engine. Guideline comparison requires exactly one approved structured rule
  matching nutrient, unit, and basis; prose retrieval cannot become a number.
- **Failure and safety rule:** invalid inputs, missing trusted data, ambiguity,
  pending rules, and unavailable calculations return explicit structured errors.
  Guideline output is general information and not medical advice.
- **Status:** Implemented for review. Agent routing/orchestration, safety intent
  handling, HTTP API, and UI are later work and are not claimed complete.

---

## DEC-042 · 2026-08-09 · Versioned Agent prompt and application-side safety (Step 11)

- **Decision:** keep the Egyptian-Arabic system prompt in executable, versioned
  source. It defines the verified-Egyptian scope, tool boundaries, deterministic
  numeric authority, no-fabrication rule, medical exclusions, and honest
  no-result behavior.
- **Enforcement:** blocking safety classification runs before planner/retrieval/
  calculation. Prompt instructions are therefore not the sole control. A
  religious-compliance guarantee follows the canonical unsupported route and
  never causes a medical referral.
- **Status:** Implemented and tested for the single Step 12 scenario; complete
  safety-corpus evaluation and Safety/QA approval remain pending.

---

## DEC-043 · 2026-08-09 · LangGraph single-scenario prototype (Step 12)

- **Decision:** select pinned LangGraph for explicit, inspectable nodes and
  conditional edges. The first graph supports only sodium calculation for one
  verified Egyptian recipe: safety → bounded plan → recipe search → unique-ID
  gate → deterministic calculation → validated response.
- **Trust boundary:** a planner can emit only the strict sodium plan schema and
  never executes tools or SQL. The application invokes Step 10 tools; all
  nutrition comes from Step 7. Ambiguity asks for clarification and missing/null
  data fails closed without publishing a subtotal as the total.
- **Privacy/provenance:** tool traces contain names/status codes, not raw user
  text. Successful output carries recipe and nutrition source/version evidence
  and the system-prompt version.
- **Status:** Prototype implemented for review. Step 13 scenario expansion,
  production data/model evaluation, API/UI, and release approvals remain future.

---

## DEC-044 · 2026-08-09 · Bounded multi-scenario Agent expansion (Step 13)

- **Decision:** add three graph scenarios while keeping application-controlled
  tools: same-basis comparison of two verified recipes, an approved-rule-bound
  verified healthier alternative, and approved food-pyramid passage retrieval.
- **Trust rules:** comparisons never mix bases; missing values produce `null`
  differences. An alternative must match an approved rule and be proven lower
  by deterministic calculations. Guidance preserves source text and citations.
- **Resolution:** a deterministic top-score confidence band accepts a clear
  recipe match; tied/near-tied IDs require clarification.
- **Status:** Implemented with synthetic tests; production data/rules remain
  approval-gated.

---

## DEC-045 · 2026-08-09 · Evaluation-set provenance gate (Step 14)

- **Decision:** require a versioned 50–100-case Egyptian-Arabic dataset with
  unique IDs and retrieval, numeric, and wording categories. Real-user origin
  requires a recorded collection method and consent/provenance reference.
- **Synthetic boundary:** commit 60 explicit synthetic questions for engineering
  tests, but reject them in the production evaluation gate. Synthetic realism
  cannot be relabelled as real-user evidence.
- **Status:** Schema, validator, and synthetic set implemented. The roadmap's
  real-user collection requirement remains externally blocked.

---

## DEC-046 · 2026-08-09 · Separated Agent evaluation metrics (Step 15)

- **Decision:** report retrieval recall/intent accuracy, exact numeric-fact
  accuracy, and wording/comprehension quality separately. One metric cannot
  compensate for another.
- **Human gate:** automated Egyptian-Arabic encoding/dialect/safety checks are
  supportive only. Clarity and comprehension remain `null`/pending until every
  wording case has a valid human review record.
- **Synthetic baseline:** all 60 cases pass: retrieval recall 1.00, 37/37 numeric
  facts exact, and automated wording pass rate 1.00. Human wording review is
  pending and `productionEligible=false`.
- **Status:** Evaluator and synthetic baseline implemented; no production
  quality or release approval is claimed.

---

## DEC-047 · 2026-08-09 · Pre-planner request-integrity boundary (Steps 16–17)

- **Decision:** classify prompt injection, user-supplied numeric overrides, and
  requests for unapproved data before the planner, retrieval, or calculator.
- **Evidence:** 18 deterministic synthetic adversarial cases cover nine edge
  categories and map each accepted improvement to regression IDs.
- **Status:** Proposed for human Safety/QA approval; implemented and tested.

---

## DEC-048 · 2026-08-09 · Dependency-injected secure HTTP boundary (Step 18)

- **Decision:** expose health/readiness, chat, and feedback through a strict
  Node HTTP boundary with schema, size, timeout, rate, origin, security-header,
  request-ID, and error-redaction controls. Keep local synthetic data visibly
  labelled and technically forbidden in production.
- **Status:** Proposed for Security/Privacy approval; implemented, API-tested,
  and browser-reviewed at desktop and mobile sizes.

---

## DEC-049 · 2026-08-09 · Server-owned consent provenance and append-only feedback (Step 19)

- **Decision:** the browser may assert active consent but cannot choose the
  consent-document identifier. The server attaches the reviewed consent/privacy
  versions. Feedback excludes direct identifiers, questions, and answers and is
  append-only in PostgreSQL.
- **Status:** Proposed for Privacy/Security approval; engineering implemented.
  A real pilot has not occurred.

---

## DEC-050 · 2026-08-09 · Evidence-gated production release (Step 20)

- **Decision:** staging and production use machine-readable fail-closed evidence
  gates. Production additionally requires a completed real pilot, zero critical
  incidents, rollback and backup/restore drills, monitoring, and deployment
  evidence. Synthetic reports cannot satisfy the real-user schema.
- **Status:** Proposed for Release Owner approval; readiness tooling exists, but
  no official deployment is claimed.

---

*New decisions are appended and dated. Supersessions are recorded inline with
“supersedes / superseded by”.*
