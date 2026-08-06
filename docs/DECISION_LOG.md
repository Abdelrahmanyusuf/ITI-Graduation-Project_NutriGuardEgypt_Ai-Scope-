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
- **Status:** Adopted (Step 0 approved).

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

---

*New decisions are appended and dated. Supersessions are recorded inline with
“supersedes / superseded by”.*