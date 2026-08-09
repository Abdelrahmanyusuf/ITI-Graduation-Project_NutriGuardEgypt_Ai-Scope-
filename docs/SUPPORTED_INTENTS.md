# NutriGuard — Supported Intents

> **Status:** Steps 12–13 implement `recipe_nutrition`, `compare_recipes`,
> approved-rule `lighter_recipe`, and `general_guidance` prototypes with
> blocking safety overrides. Remaining intents and a user-facing API are not
> implemented.

Intents are identified by the canonical identifiers in
[`MVP_REQUIREMENTS.md`](./MVP_REQUIREMENTS.md). This document defines routing,
and — for each intent — required inputs, outputs, and conditions.

## Routing model

- A request arrives in a supported language (`ar-EG`, `ar`, `en`).
- Classification produces **one** `primary_intent` plus **zero or more**
  `safety_flags`.
- **Safety flags** come in two classes (identical in `SAFETY_POLICY.md` and
  `MVP_REQUIREMENTS.md`):
  - **Blocking/override:** `emergency`, `medical_advice_request`,
    `vulnerable_population_personalization`, `allergen_safety_guarantee`;
  - **Non‑blocking caution/metadata:** `allergen_metadata_filter`,
    `religious_metadata_filter`, `vegetarian_metadata_filter`.
- **Override rules:**
  1. Blocking/override flags take precedence over any content intent:
     `emergency` → emergency handling; any medical‑safety flag
     (`medical_advice_request`, `vulnerable_population_personalization`,
     `allergen_safety_guarantee`) → `medical_safety_request` handling.
  2. A **religious‑compliance guarantee** is refused as
     `unsupported_request` and **never** produces a medical referral.
  3. Caution/metadata flags do **not** block routing: a source‑declared
     metadata filter may continue through `find_recipe` with an explicit
     warning that the metadata is not verified or guaranteed.
  4. Otherwise the primary intent is classified among the six content intents
     or `unsupported_request`.
- **Compound requests** (more than one intent, e.g. "find a recipe and compare
  it to another"): the system either **decomposes** the request into sequential
  supported turns, or asks a **clarification**. It never guesses an answer to
  both at once.
- All outputs honor the project rules: **no fabricated numbers/sources** and
  **missing = null/unknown**.

## Canonical intents

### 1. `find_recipe`
- **Purpose:** Find verified Egyptian recipes.
- **Required inputs:** dish description and/or ingredient hints; optional
  dietary filters.
- **Filters are declared metadata only.** Vegetarian, halal, kosher, and
  allergen filters may be applied **only** from source‑declared metadata. They
  are reported as declared, never verified or guaranteed. Missing metadata
  stays `unknown` (see `SAFETY_POLICY.md`).
- **Outputs:** verified recipe titles with `source_id`/`source_version`. Only
  recipes with `egyptian_verification_status = verified` are returned.
- **Exclusions:** non‑Egyptian dishes → refusal/alternatives; `candidate` or
  `pending` recipes are never surfaced as matches.

### 2. `recipe_nutrition`
- **Purpose:** Report nutrition for a verified Egyptian recipe.
- **Required inputs:** a recipe with `egyptian_verification_status = verified`
  (identifier or unambiguous name).
- **Outputs:** supported nutrients (**calories, protein, carbohydrate, total
  fat, saturated fat, fiber, sugar, sodium**), each with unit, basis, and
  provenance.
- **Result bases.** Return **every basis that can be calculated**; every basis
  that cannot be calculated is returned as **unavailable with an explicit
  reason**:
  - `full_recipe` — whole recipe; **requires resolved ingredient amounts**.
  - `per_serving` — per serving; **requires a valid serving count greater than
    zero**. Serving weight is **not required** for the division.
  - `per_100g` — per 100 g; **requires a valid final cooked/yield weight
    greater than zero**.
- **Serving weight derivation.** Serving weight may be derived **only** when
  both final cooked weight and serving count are known
  (`serving_weight = final_cooked_weight / serving_count`).
- **Serving metadata.** Serving count and serving weight are shown **when
  known**; an unavailable basis is reported `unavailable` with a reason (never
  estimated).
- **Per-basis status.** Each result basis carries
  **`basis_status = available | unavailable`** (identical in
  `MVP_REQUIREMENTS.md`, `DEFINITION_OF_DONE.md`, and `DECISION_LOG.md`). An
  `unavailable` basis must include a **machine-readable `reason`** (for example
  `missing_serving_count`, `missing_yield_weight`, `missing_ingredient_amount`).
- **Overall `nutrition_calculation_status`**:
  - **`unavailable`** — **no valid basis can be calculated**.
  - **`partial`** — **at least one basis can be calculated**, but a requested or
    applicable basis, required nutrient, ingredient, quantity, or conversion is
    missing.
  - **`complete`** — **all applicable/requested bases and release-required
    nutrients are available from approved data**.
  Optional/display-only nutrients (saturated fat, sugar) may remain `unknown`
  without downgrading `complete`; their missing status must still be shown.
- **Partial/unknown behavior.** If `nutrition_calculation_status` is `partial`,
  each missing nutrient is explicitly `unknown`; the status is shown. The
  recipe is never presented with invented values.
- **Constraint:** nutrition comes from the deterministic calculator over
  approved data — never from the model.

### 3. `ingredient_nutrition`
- **Purpose:** Report nutrition of a single ingredient.
- **Required inputs:** an ingredient name that maps to the **Approved
  Ingredient Registry** (normalised, approved, sourced, state‑aware — not a
  cultural‑Egyptian list).
- **Outputs:** supported nutrients for that ingredient with unit, basis,
  provenance, and `null` for unsourced values.
- **Registry scope.** An ingredient may be returned **only** when it (a) is used
  by at least one verified Egyptian recipe in the supported corpus, **or**
  (b) has been explicitly approved as part of the Egyptian‑food ingredient
  scope. Arbitrary global ingredients are **not** exposed merely because they
  exist in the registry.
- **Constraint:** unmapped or unapproved ingredients return **unknown**, not a
  guess.

### 4. `compare_recipes`
- **Purpose:** Compare two verified Egyptian recipes.
- **Required inputs:** two recipes, both with
  `egyptian_verification_status = verified`.
- **Outputs:** a structured comparison limited to the supported nutrients.
- **Default basis.** The normalized comparison basis is **`per_100g`** when it
  is available for both recipes.
- **`per_serving` comparison.** Each recipe’s serving weight is displayed when
  known; if serving sizes differ, an **explicit warning** is shown. If serving
  weights are unknown, the response states that the portions **may not be
  equivalent**.
- **`full_recipe` comparison.** Allowed **only for an explicit whole‑batch
  request** and must show total yield and serving count for both recipes.
  Full‑recipe totals are **never** described as an equivalent comparison when
  yields differ.
- **Normalisation.** `full_recipe` vs `per_100g` is never compared directly
  without normalising first.
- **Constraint:** If either recipe is un‑verified or lacks a shared basis, the
  intent refuses and offers verified alternatives.

### 5. `general_guidance`
- **Purpose:** Retrieve general, non‑personalised nutrition guidance.
- **Inputs:** a topic such as portion guidance or the food pyramid.
- **Outputs:** factual guidance drawn **only from approved active guidance
  sources**, each with a citation. **No source is user‑facing until its
  provenance + license status is approved** (`DATA_SOURCE_POLICY.md`).
- **Constraint:** does **not** apply guidance to any specific user/condition.
  Guidance with `pending`/`candidate` status is **not** shown.

### 6. `lighter_recipe` (derived modification)
- **Purpose:** Produce a **derived** lighter variant of a verified Egyptian
  recipe.
- **The result is a `derived_recipe_variant`** — it is **not** a verified source
  recipe and must be labelled as a derived modification.
- **Required to create a variant:** an **approved deterministic modification
  rule** (from an approved rule set), the **original recipe ID**, the
  **changed ingredients/methods**, and **recalculated nutrition**.
- **Output record fields:** original recipe ID, applied rule ID/version,
  changed ingredients/methods, recalculated nutrition (deterministic), derived
  provenance + version, assumptions, `nutrition_calculation_status`, and an
  explicit **"derived modification"** label.
- **Constraint:** **no new factual cooking instructions or ingredient
  quantities are generated** without an approved rule. No medical claims and no
  invented macros.

### 7. `unsupported_request`
- **Purpose:** Decline anything outside MVP, clearly.
- **Applies to:** out‑of‑language, non‑Egyptian recipes, rough estimates, any
  unimplemented capability, or requests that cannot be safely decomposed.
- **Output:** an honest "not supported / unknown" message; steer toward a
  supported intent when possible; never invent.

### 8. `medical_safety_request`
- **Purpose:** Handle explicit medical/safety requests by **declining medical
  advice** (see `SAFETY_POLICY.md`).
- **Output:** refusal to give diagnosis/treatment/allergen guarantees; referral
  to a licensed healthcare professional; emergency redirection where
  applicable. Takes precedence over content intents.
- **Not applicable to religious-compliance guarantees.** A request for a
  religious-compliance guarantee is refused as `unsupported_request` and does
  **not** route here — it never produces a medical referral.

## Conventions (all intents)

- Exactly one `primary_intent`; `safety_flags` may be non‑empty.
- All inputs strictly validated. Logging is **privacy‑safe**: structured,
  minimal, redacted operational logs only — raw user queries, health
  information, and personal data are **not** logged, and no secrets/PII/health
  data appear by default.
- All outputs strictly validated before presentation; a model can only format
  verified data.
- Arabic output is valid UTF‑8.
- No **LLM‑generated SQL** and no data mutation from a model.

Full policy: [`SAFETY_POLICY.md`](./SAFETY_POLICY.md). Provenance/licensing:
[`DATA_SOURCE_POLICY.md`](./DATA_SOURCE_POLICY.md).
