# NutriGuard — MVP Requirements (Scope)

> **Status:** canonical MVP requirements. Steps 0–20 now have engineering or
> release-readiness implementations for review. The full production MVP remains
> blocked by real-user evaluation/pilot evidence, approved production data and
> infrastructure, and the required human owner approvals.
>
> **Step 1 scope is reviewer-approved.** Scope decisions are Adopted; numerical
> release thresholds remain **Proposed** until their responsible human owners
> approve them (see `DEFINITION_OF_DONE.md` §5 and `DECISION_LOG.md`).

## 1. Product objective

NutriGuard is a **nutrition assistant restricted to verified Egyptian food**.
Its objective is to answer everyday nutrition questions — finding Egyptian
recipes and reporting their nutrient content — in Egyptian Arabic, Modern
Standard Arabic, or English, using only:

- data from sources that have passed the provenance and licensing review
  ([`DATA_SOURCE_POLICY.md`](./DATA_SOURCE_POLICY.md)), and
- deterministic application code for all nutritional arithmetic.

The assistant must never invent nutritional numbers, medical guidance, recipes,
or sources. Where data is missing it must say the value is unknown rather than
guess.

## 2. Verified Egyptian recipe and nutrition readiness (two independent statuses)

Cultural identity and nutrition readiness are **separate** concerns and must be
tracked independently. A recipe may be a verified Egyptian recipe while its
nutrition calculation remains partial or unavailable.

| Status | Meaning |
| --- | --- |
| `egyptian_verification_status` | whether the recipe is (culturally) a verified Egyptian recipe |
| `nutrition_calculation_status` | whether deterministic nutrition can be computed for it |

`egyptian_verification_status` takes values: **`pending` · `candidate` ·
`verified` · `rejected`**.

`nutrition_calculation_status` takes values: **`unavailable` · `partial` ·
`complete`**.

### 2.1 Definition of a verified Egyptian recipe

A recipe is a **verified Egyptian recipe** only when a **human reviewer**
approves it based on **documented cultural evidence and provenance**. The
automated rules below can only create a **candidate**; they cannot verify.

**Automated eligibility (may create a `candidate` only).** All of:

- **C‑1 Provenance.** The recipe has a provenance record (`source_id`,
  `source_version`, `access_date`) per `DATA_SOURCE_POLICY.md`.
- **C‑2 Structural completeness.** Non‑empty title, non‑empty instructions,
  valid UTF‑8.
- **C‑3 Evidence claim.** At least one of the documented cultural‑evidence
  paths below is claimed and linkable to evidence.

Failure of any of C‑1..C‑3 routes the recipe to a manual‑review queue or marks
it non‑eligible with a recorded reason — it is not auto‑verified.

**Cultural‑evidence paths (at least one, documented).** Any of:

- **E‑1 Authoritative Egyptian source attribution.** Attribution to a
  recognised Egyptian culinary/recipe source with documented origin.
- **E‑2 Approved Egyptian dish registry match.** The title/aliases match an
  entry in the approved registry of Egyptian dishes.
- **E‑3 Documented cultural reference.** A published/recognised reference
  describing the dish as Egyptian.
- **E‑4 Domain‑reviewer approval.** Approval by the Egyptian Recipe/Cultural
  Reviewer based on documented evidence.

The source does **not** have to carry an “Egyptian” cuisine‑metadata tag for
E‑1..E‑3 to apply.

**Mandatory human review.** A `candidate` becomes `verified` only after review
by the **Egyptian Recipe/Cultural Reviewer**. The review must:

- confirm at least one evidence path and its provenance;
- assign `verified` or `rejected`;
- preserve the **reviewer identity**, **review date**, and — for `rejected` —
  the **explicit rejection reasons**.

**Explicitly not part of cultural verification.** Ingredient‑mapping coverage
and quantity/weight completeness are **not** cultural‑verification criteria.
They affect `nutrition_calculation_status` only (see 2.2).

### 2.2. Nutrition calculation readiness

`nutrition_calculation_status` uses **identical definitions** in
`SUPPORTED_INTENTS.md`, `DEFINITION_OF_DONE.md`, and `DECISION_LOG.md`:

**Per-basis status.** Each result basis carries
**`basis_status = available | unavailable`**. An `unavailable` basis must
include a **machine-readable `reason`** (for example `missing_serving_count`,
`missing_yield_weight`, `missing_ingredient_amount`).

**Overall `nutrition_calculation_status`** (for a recipe and a request):

- **`unavailable`** — **no valid basis can be calculated**.
- **`partial`** — **at least one basis can be calculated**, but a requested or
  applicable basis, required nutrient, ingredient, quantity, or conversion is
  missing.
- **`complete`** — **all applicable/requested bases and release-required
  nutrients are available from approved data**.

Optional/display-only nutrients (saturated fat, sugar) may remain `unknown`
**without** downgrading `complete`; their missing status must still be shown.

A recipe with `verified` Egyptian status may legitimately be `partial` or
`unavailable` for nutrition. The registry used for ingredient mapping is the
**Approved Ingredient Registry** (it is **not** a cultural‑Egyptian list; an
ingredient need not be uniquely Egyptian — it must be normalised, approved,
sourced, and state‑aware).

## 3. Supported languages

| Code | Language | Use |
| ---- | -------- | --- |
| `ar-EG` | Egyptian Arabic | Primary colloquial input/output |
| `ar` | Modern Standard Arabic (MSA) | Supported input/output |
| `en` | English | Supported input/output |

- Input may arrive in any supported language; output follows the user’s
  language (or a requested language) when it is one of the three.
- Arabic text must be preserved as valid UTF‑8 (no mojibake) end to end.
- A request in a fourth language receives the `unsupported_request` response.

## 4. Supported MVP nutrients

Per nutrient, three properties are distinguished: **schema field** (required or
optional), **value nullability** (may be null), and **MVP release** (must be
present for release, or displayed only when sourced).

| Nutrient | Unit | Schema field | Value | MVP release |
| --- | --- | --- | --- | --- |
| calories | kcal | required | nullable | required (non‑null in released nutrition) |
| protein | g | required | nullable | required |
| carbohydrate | g | required | nullable | required |
| total fat | g | required | nullable | required |
| saturated fat | g | optional | nullable | **display‑only when sourced** |
| fiber | g | required | nullable | required |
| sugar | g | optional | nullable | **display‑only when sourced** |
| sodium | mg | required | nullable | required |

**Release behavior for saturated fat and sugar.** Saturated fat and sugar are
MVP nutrients, but no reviewed source currently supplies them
(`DATA_SOURCE_POLICY.md`). They are therefore defined as **display‑only when
sourced**:

- If an approved source provides the value, it is displayed with provenance.
- If not sourced, it is reported **unknown** and does **not** block MVP release.

This removes the earlier contradiction (a “required” value being permanently
unavailable). Sourcing saturated fat and sugar is a **tracked follow‑up**, not a
pre‑release blocker.

**Missing‑value rule.** A nutrient with no approved value is `null` with an
explicit missing status — never invented and never coerced to `0`.

## 5. Supported intents and routing

MVP recognises the following intents (canonical identifiers are identical in
all documents):

`find_recipe` · `recipe_nutrition` · `ingredient_nutrition` ·
`compare_recipes` · `general_guidance` · `lighter_recipe` ·
`unsupported_request` · `medical_safety_request`

### Routing model

Classification yields **one** `primary_intent` plus **zero or more**
`safety_flags`, divided into two classes (identical in `SUPPORTED_INTENTS.md`
and `SAFETY_POLICY.md`):

- **Blocking/override flags:** `emergency`, `medical_advice_request`,
  `vulnerable_population_personalization`, `allergen_safety_guarantee`.
- **Non‑blocking caution/metadata flags:** `allergen_metadata_filter`,
  `religious_metadata_filter`, `vegetarian_metadata_filter`.

Routing rules:

1. **Safety override.** Blocking/override flags are evaluated first. They take
   **precedence** over content intents and route to the
   `medical_safety_request` handling — except a **religious‑compliance
   guarantee**, which is refused as `unsupported_request` and never produces a
   medical referral (see `SAFETY_POLICY.md`).
2. **Metadata filters.** Caution/metadata flags do **not** block routing: a
   request to filter by source‑declared metadata may continue through
   `find_recipe` with an explicit warning that the metadata is not verified or
   guaranteed.
3. **Compound requests.** A request expressing more than one intent is either
   **decomposed** into sequential supported turns or a **clarification** is
   asked — it is never guessed.
4. **Fallback.** Anything else becomes `primary_intent = unsupported_request`.

Detailed inputs/outputs, bases, and filters:
[`SUPPORTED_INTENTS.md`](./SUPPORTED_INTENTS.md).

## 6. Explicitly unsupported behavior

- **Medical diagnosis, prescription, or treatment** of any condition.
- Personalized medical advice, dosing, or nutrition therapy for a diagnosed
  disease (see `SAFETY_POLICY.md`).
- Guarantees of safety, allergen-freedom, or religious compliance
  (halal/kosher) for any person.
- Nutrition for **non‑verified / non‑Egyptian** recipes or ingredients — unless
  a clear refusal offering verified alternatives.
- **Any fabrication**: invented recipes, nutrition numbers, conversion factors,
  citations, sources, or completion claims.
- **LLM‑computed nutrition.** All nutritional arithmetic is deterministic
  application code; the model only presents verified data.
- **LLM‑generated SQL** or any data‑layer mutation by the model.
- Presenting `candidate`/`pending` data as verified, or pending guidance as
  available.

## 7. Data‑source requirements and licensing

Every planned data source (recipe, ingredient, nutrition, guidance, pyramid)
must carry a complete **provenance record** and an **approved license review**
before its data can be surfaced to users. **Read‑only auditing** of pending
sources is permitted; pending data must **not** enter user‑facing results.
Fields and checklist: [`DATA_SOURCE_POLICY.md`](./DATA_SOURCE_POLICY.md).

## 8. Medical and safety boundaries

- NutriGuard is an informational nutrition assistant, **not a medical device**.
- It does **not** diagnose, treat, prescribe, or give personalized
  nutrition‑therapy.
- Emergency and medical‑safety routing takes precedence over all other intents.
- It never guarantees safety, allergen‑freedom, or religious compliance.

Full text: [`SAFETY_POLICY.md`](./SAFETY_POLICY.md).

## 9. Roles and approval responsibilities

| Role | Responsibility |
| --- | --- |
| Product Owner | Owns scope, intent model, prioritisation, MVP go/no‑go |
| Data Steward | Owns provenance/license records; gates any source into scope |
| **Nutrition Domain Reviewer** | Reviews conversions, serving weights, and nutrient mapping rules |
| **Egyptian Recipe/Cultural Reviewer** | Reviews cultural evidence; assigns `verified`/`rejected` (may be same qualified person as Nutrition Domain Reviewer) |
| Requirement/Acceptance Responsible | Verifies acceptance criteria per release gate |
| Engineering Lead | Owns architecture; enforces deterministic rules, no‑fabrication, tests; approves release build |
| Safety/QA Reviewer | Verifies safety boundaries and test coverage; signs safety gate |
| **Security/Privacy Owner** | Owns data protection/privacy; approves release |
| **Legal/license reviewer** | Reviews license/legal compliance **when required** |

**Mandatory approvals:** recipes require the **Egyptian Recipe/Cultural
Reviewer**; conversion/factor and serving‑weight rules require the **Nutrition
Domain Reviewer**; guidance rules require **Nutrition Domain Reviewer + Data
Steward**; safety requires **Safety/QA Reviewer**; release requires
**Security/Privacy Owner + Engineering Lead + Product Owner** (legal/license
when required).

## 10. Definition of Done

DoD is split into documentation/tooling, data‑processing, and user‑facing
nutrition sections, each with its own criteria. See
[`DEFINITION_OF_DONE.md`](./DEFINITION_OF_DONE.md).

## 11. MVP release gates

Measurable release gates open/close are defined (with target thresholds put as
**proposed** until their owners approve them): [`DEFINITION_OF_DONE.md`](./DEFINITION_OF_DONE.md).

## 12. Cross‑cutting compliance (non‑negotiable)

- **Deterministic arithmetic** for all nutrition; the model never computes
  nutrition numbers.
- **Missing = null/unknown**; never invented `0` or status.
- **Provenance + versioning** for every value and recipe.
- **No LLM‑generated SQL.**
- **Strict input/output validation** at every boundary.
- **No secrets in source.**
- **Valid UTF‑8 Arabic** preserved.
- **Tests** for all behaviour introduced, incl. **docs link check**.
- **Privacy-safe logging.** Structured, minimal, operational logs only; raw
  user queries, health information, and personal data are **not** logged. Logs
  are redacted and, by default, contain **no secrets, PII, or health data**.

## 13. Known gaps (honest)

- **Saturated fat and sugar are not yet provided by any reviewed source**; they
  are display‑only‑when‑sourced per §4.
- The **recipe registry** and the **Approved Ingredient Registry** are planned
  artefacts, not current data.
- No existing raw file has a completed license review
  (`DATA_SOURCE_POLICY.md`); `food_pyramid.json` is treated as an unapproved
  **Harvard Healthy Eating Pyramid candidate** with pending provenance — not an
  Egyptian source and not WHO.
- Guidelines are not surfaced to users until their source is approved.

---

*Canonical, overriding scope document. Intent‑level detail:
`SUPPORTED_INTENTS.md`. Tracked decisions: `DECISION_LOG.md`.*
