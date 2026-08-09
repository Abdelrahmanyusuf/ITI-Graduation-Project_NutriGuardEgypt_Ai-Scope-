# NutriGuard — Definition of Done & MVP Release Gates

> **Status:** the DoD and release gates are defined. Steps 0–20 have engineering
> implementation or release-readiness controls for review. Synthetic verification,
> a runnable demo, and deployment scaffolding do not constitute the required
> real-user pilot, production approval, or release-gate sign-off.

DoD is split into four distinct sections so that documentation/tooling,
data‑processing, and user‑facing nutrition work are not blocked by one another,
and so a read‑only audit of pending sources is not confused with using licensed
data.

## 1. Documentation / tooling DoD

A documentation or tooling change is Done when:

- [ ] All documentation links resolve: **`npm run docs:check` passes**.
- [ ] The six requirement documents agree with one another (terms, intents,
      nutrients, languages, safety, sources) — see the consistency rule below.
- [ ] No capability is described as implemented unless it exists.
- [ ] `npm run type-check`, `npm run lint`, and `npm test` pass.

### `nutrition_calculation_status` (canonical definitions)

Identical in `MVP_REQUIREMENTS.md`, `SUPPORTED_INTENTS.md`, and
`DECISION_LOG.md`:

**Per-basis status.** Each result basis carries
**`basis_status = available | unavailable`**. An `unavailable` basis must
include a **machine-readable `reason`** (for example `missing_serving_count`,
`missing_yield_weight`, `missing_ingredient_amount`).

**Overall `nutrition_calculation_status`**:

- **`unavailable`** — **no valid basis can be calculated**.
- **`partial`** — **at least one basis can be calculated**, but a requested or
  applicable basis, required nutrient, ingredient, quantity, or conversion is
  missing.
- **`complete`** — **all applicable/requested bases and release-required
  nutrients are available from approved data**.

Optional/display-only nutrients (saturated fat, sugar) may remain `unknown`
**without** downgrading `complete`; their missing status must still be shown.

## 2. Data‑processing feature DoD

A data‑processing feature is Done when:

- [ ] It reads only sources whose provenance + license status is appropriate to
      the operation.
- [ ] **Read‑only audit of pending sources is allowed without licensed data**;
      pending data must **not** be written into user‑facing results.
- [ ] Values are normalized while preserving original source values; records are
      versioned.
- [ ] Missing values are `null`/`unknown`, never invented or coerced to `0`.
- [ ] Ingredient mapping and quantity completeness feed
      `nutrition_calculation_status` only — never
      `egyptian_verification_status`.
- [ ] Recipes enter as `candidate`; only human review yields `verified`.
- [ ] No **LLM‑generated SQL**; deterministic application code only.
- [ ] Tests cover the introduced behavior; `npm run docs:check`,
      `npm run type-check`, `npm run lint`, `npm run build`, `npm test` pass.

## 3. User‑facing nutrition feature DoD

- [ ] Only `egyptian_verification_status = verified` recipes are surfaced.
- [ ] 100% of displayed nutrition numbers are produced by the deterministic
      calculator (no model‑invented values).
- [ ] All displayed guidance is linked to **approved active provenance**.
- [ ] `medical_safety_request` and routing override rules behave as specified
      and are tested.
- [ ] Metadata (halal/kosher/vegetarian/allergen) shown only as source‑declared,
      never guaranteed.
- [ ] Strict input/output validation; Arabic is valid UTF‑8; accepted languages
      per `MVP_REQUIREMENTS.md`.
- [ ] Logging is privacy-safe: minimal, structured, redacted operational logs
      only; no raw queries, PII, or health data by default.
- [ ] Tests green: `docs:check`, `type‑check`, `lint`, `test`, `build`.

## 4. Status of deliverables

- **Step 0** — approved.
- **Step 1** — **reviewer-approved**. Scope decisions are Adopted; numerical
  release thresholds remain **Proposed** until their owners approve them
  (see §5 note).
- **Steps 2–15** — implemented for review. Steps 14–15 have synthetic evidence
  only; real-user and human-review evidence remains pending. Production readiness remains blocked
  by the human approvals, approved datasets, and release gates below.

## 5. MVP release gates (go/no‑go)

Each gate is mandatory. Targets labelled **Proposed** are not final; they become
binding only after the responsible owner approves the number.

| # | Gate | Requirement (proposed target in italics = pending owner approval) | Evidence |
| --- | --- | --- | --- |
| G1 | Egyptian‑review coverage | **100%** of released recipes human‑reviewed as Egyptian | reviewer log per `verified` recipe |
| G2 | No unverified leakage | **0** unverified / non‑Egyptian recipe leakage in the approved release test set | release test‑set report |
| G3 | Deterministic nutrition | **100%** of displayed nutrition numbers from the deterministic calculator | deterministic‑only test |
| G4 | Guidance provenance | **100%** of displayed guidance claims linked to approved provenance | per‑claim provenance link |
| G5 | Safety tests | **0 critical safety‑test failures** | safety test suite |
| G6 | Ingredient‑line mapping coverage | *proposed: ≥ 95%* (`ingredient‑line mapping coverage`, §6) | §6 coverage report |
| G7 | Quantity‑parsing + gram‑conversion coverage | *proposed: ≥ 80%* each (`quantity parsing coverage`, `gram‑conversion coverage`, §6) | §6 coverage reports |
| G8 | Deterministic calculator accuracy | *proposed: within ±2%* of a **reviewed golden set**, measured against the deterministic calculator including defined rounding behavior (see §6 note); this is calculator correctness, **not** a claim about real‑food composition accuracy | golden‑set comparison |
| G9 | Retrieval quality | *proposed: Recall@5 ≥ 0.9* on the approved corpus | retrieval evaluation |
| G10 | Build & test | `npm ci`, `npm run type-check`, `npm run lint`, `npm run build`, `npm test`, `npm run docs:check` all green | CI report |
| G11 | Security & privacy | Security/Privacy Owner approval; no secrets; no PII leak; privacy‑safe logging | security/privacy sign‑off |
| G12 | Human sign‑off | Safety, Data Steward, Product, Engineering, Nutrition, Egyptian Review, Security/Privacy approvals recorded | approvals log |
| G13 | Recipe complete‑coverage | *proposed: ≥ 90%* (`recipe complete‑coverage`, §6) | §6 coverage report |
| G14 | Mass‑weighted coverage | *proposed: ≥ 85%* where a valid denominator exists (`mass‑weighted coverage`, §6) | §6 coverage report |

**Proposed‑threshold note:** thresholds in italics above (e.g. ≥ 90%, ≥ 80%,
±2%, Recall@5 ≥ 0.9) are **proposed** until the responsible owners approve them.
Coverage thresholds reference the canonical metric definitions in §6.

Each gate is owned by the role listed in `MVP_REQUIREMENTS.md` §9. A single
**No** blocks release.

## 6. Coverage metrics (canonical definitions)

These definitions apply **before any Step 2 data work** begins. Every
percentage metric below states its **numerator**, **denominator**, and
**exclusions**, defines its **unknown‑denominator behavior**, and reports
**count‑based** numbers (and, where a mass denominator exists, **mass‑weighted**
numbers).

- **ingredient‑line mapping coverage** =
  `mapped required ingredient lines / total required ingredient lines`.
  - Numerator: required ingredient lines mapped to an Approved Ingredient
    Registry record.
  - Denominator: all required ingredient lines in the corpus.
  - Exclusions: non‑ingredient text lines, headings, and lines explicitly flagged
    optional/not required (e.g. "to taste" when the rule set marks it optional).
  - Unknown denominator behavior: if the required‑line inventory is not complete,
    the metric is reported `unknown`, never `0%`.
- **quantity parsing coverage** =
  `successfully parsed quantity lines / lines requiring quantities`.
  - Numerator: quantity lines whose quantity text parsed successfully.
  - Denominator: ingredient lines that require a quantity.
  - Exclusions: lines the approved rule set marks as not requiring a quantity
    (e.g. optional "to taste").
  - Unknown denominator behavior: reported `unknown` if the required‑quantity
    rule set is not yet approved.
- **gram‑conversion coverage** =
  `ingredient lines converted to grams / ingredient lines requiring gram conversion`.
  - Numerator: required lines converted to grams via an approved factor.
  - Denominator: lines needing gram conversion (volume/piece/unit quantities);
    lines already expressed in grams are excluded.
  - Unknown denominator behavior: reported `unknown` if the conversion‑rule set
    is incomplete.
- **recipe complete‑coverage** =
  `recipes with all release‑required calculation inputs / released recipes`.
  - Numerator: released recipes whose ingredient mapping, quantities, and
    conversions satisfy all release‑required calculation inputs.
  - Denominator: all released (user‑facing) recipes.
  - Exclusions: recipes withheld from release; display‑only nutrients
    (saturated fat, sugar) never count as missing inputs here.
  - Unknown denominator behavior: reported `unknown` if the released set is
    undefined.
- **mass‑weighted coverage** =
  `resolved known ingredient mass / total known ingredient mass`, calculated
  **only where a valid denominator exists**.
  - Numerator: mass of required lines with resolved quantities and gram
    conversions.
  - Denominator: total known ingredient mass over the measured scope, after
    excluding lines whose mass is legitimately unknown/unmeasurable.
  - Unknown denominator behavior: if no valid denominator exists, the metric is
    **not‑applicable**, never `0%`.

**Note on G8 (±2%).** The gate measures **deterministic calculator correctness**
against a **reviewed golden set**, including defined rounding behavior. It does
**not** claim that real food composition is accurate within ±2%. Data‑source
composition uncertainty is reported separately and is not part of the ±2% gate.

---

*Owner: Requirement/Acceptance + Engineering Lead; safety items require the
Safety/QA Reviewer; release approval requires Security/Privacy Owner and listed
owners.*
