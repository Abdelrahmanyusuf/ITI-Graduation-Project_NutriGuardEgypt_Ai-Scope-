# NutriGuard — Data‑Source Policy

> **Status: Requirement — not yet satisfied for any source.**
> No raw data file has completed the provenance + license review below.
> Read‑only inspection/audit of pending sources is permitted; **no pending data
> may enter user‑facing results.**

## 1. Purpose

Guarantee that every value NutriGuard presents (recipe, ingredient, nutrition,
guidance) is verifiable back to an identified, licensed source and is versioned.
Unverified or unlicensed data never becomes user‑facing.

## 2. Provenance requirement (every source, every record)

Each source and each derived record must carry:

| Field | Meaning |
| --- | --- |
| `source_id` | stable identifier of the origin |
| `source_name` | human‑readable name of the origin |
| `source_url` | canonical URL (when available) |
| `access_date` | date the data was obtained/reviewed |
| `source_version` | version/revision of the data obtained |
| `license` | SPDX identifier or explicit terms |
| `license_url` | URL or pointer to the license text |
| `redistribution_ok` | whether redistribution/derivation is permitted |
| `attribution_required` | whether/citation text is required |
| `reviewed_by` + `review_date` | who approved it and when |
| `review_status` | `pending`, `approved`, or `rejected` |

A record with `review_status ≠ approved` **must not** be surfaced to users.

## 3. Licensing checklist

Before a source is used, the Data Steward must confirm and record each:

- [ ] is the license known (name + URL)?
- [ ] are we allowed to **store** the data?
- [ ] are we allowed to **derive/transform** it?
- [ ] are we allowed to **redistribute** results derived from it?
- [ ] is **commercial/inside a product** use permitted?
- [ ] is **attribution** required, and is the correct text recorded?
- [ ] are there restrictions (no derivatives, share‑alike, non‑commercial)?
- [ ] is the record versioned (`source_version`, `access_date`)?
- [ ] was the license reviewed by a legal/license reviewer where required?

A source fails the gate if any required line is “no/unknown.”

## 4. Current source inventory (status: NOT approved)

| File (in `data/raw/`) | Kind | Provenance / identity | License review | Status |
| --- | --- | --- | --- | --- |
| `Egyptian_Food_Categorized.csv` | ingredient nutrition | not yet documented | not yet done | `pending` |
| `Recipes For Eqyption Food.csv` | recipes + metadata | not yet documented | not yet done | `pending` |
| `WHO Guidelines.pdf` | general guidance | WHO healthy‑diet factsheet (see audit source manifest `data/manifest/sources.json`) | not yet done | `pending` |
| `food_pyramid.json` | servings guidance | **unapproved candidate; evidence points to the Harvard Healthy Eating Pyramid** — not WHO and not Egyptian | not yet done | `pending` |
| `Food Pyramid/*.jpg` | pyramid images | not yet documented | not yet done | `pending` |

None of the above may be surfaced to users until reviewed and approved. This
table is the current, honest state — not a claim of compliance.

### Wikipedia is NOT an approved source

`unified_egyptian_rag_database_v2_final.json` (the graduation-demo candidate
dataset) records `source_url` as an `en.wikipedia.org` page for **214 of its 215
recipes**, with `license_note: "Wikipedia CC BY-SA 4.0"` and
`metadata.review_status: "needs_review"`.

| Field | Value |
| --- | --- |
| Kind | recipe/dish descriptive text (culinary) |
| Provenance | English Wikipedia article per dish |
| Licence | CC BY-SA 4.0 (identified, not yet reviewed) |
| Review status | `needs_review` |
| Approved for user-facing citation | **No** |

It is **not** an approved active source, so per §2 and §5 it must not be cited to
users. Two rules follow:

1. **No clickable Wikipedia link in user-facing output.** The chat UI renders
   `provenance[].url` as a "دليل مرتبط" link, so `recipeProvenance()` now emits
   `url: null` for demo recipes. A URL may only reappear here after a Data
   Steward records an approved review.
2. **Never cite it as evidence for a number.** Wikipedia is the recorded
   *culinary* source for the dish text. Nutrition values come from
   `source_nutrition: "Recalculated from ingredient_nutrition_reference"`.
   Attaching the article to a calculated nutrition answer misattributes the
   arithmetic to a source that did not produce it.

Attribution text is still carried in the provenance `title`, because the dish
text is reused under CC BY-SA 4.0 and silently dropping attribution would trade
a policy problem for a licensing one. The title states plainly that the dish text
comes from an unapproved candidate source pending review and that the nutrition
was recalculated.

### Audit source manifest

`data/manifest/sources.json` is a **curated audit-time provenance manifest**,
placed **outside** `data/raw/` (so the read-only audit never mutates raw inputs).
It records identity/title/visible date as an **explicit provenance record** that
the guideline scanner may use to identify a source — for example the WHO
healthy‑diet factsheet, whose OCR layer corrupts the organization name in the
extracted text.

Evidence/reference IDs are **purpose-typed** and narrowly scoped:

- **`guideline_provenance`** — e.g. `EG-REF-WHO-001` (WHO healthy-diet
  factsheet). These IDs identify/verify the **guideline source only**; the WHO
  fact sheet is general nutrition guidance and is **never** eligible for the
  recipe **C‑3** Egyptian cultural-evidence gate.
- **`egyptian_recipe_cultural_evidence`** — e.g. `EG-KOSHARI-CULTURAL-001`
  (`applicableTo: [koshari, kushari, …]`). Only these dish-scoped records may
  resolve a recipe **C‑3** claim, and only when their scope matches the dish
  being classified.

The manifest is **audit metadata only**: it does **not** change license or
approval status. Every source it describes remains `pending` in the inventory
above until the Data Steward completes the §2/§3 provenance + license review. It
never authorizes a source to become user‑facing.

### `food_pyramid.json` identity note

`food_pyramid.json` is **not** described as an Egyptian pyramid and is **not**
attributed to WHO. Its provenance is `pending`; preliminary evidence suggests
the **Harvard Healthy Eating Pyramid**. It is therefore described as a
**Harvard candidate** pending confirmation and license review. It is not a
user‑facing source until approved.

## 5. User‑facing eligibility

Only sources with `review_status = approved` are `active`. `general_guidance`
and all user‑facing results use **only approved active sources**
(`SUPPORTED_INTENTS.md`). Pending/candidate sources may be **inspected and
audited** (read‑only) but must not appear in results.

## 6. Nutrient‑coverage gap for MVP

- **saturated fat** and **sugar** are MVP nutrients but are **not present** in
  the current raw nutrition file. They are `display‑only when sourced`
  (`MVP_REQUIREMENTS.md`): reported `unknown` until a compliant source is added.
- No conversion factor, serving size, or recipe‑level nutrient is claimed until
  deterministically derived from approved data.

## 7. Missing‑data handling

- A nutrient with no approved value is `null` with an explicit missing status —
  never invented, never coerced to `0`, never a guessed status.
- Records with unresolved provenance/license route to a **manual‑review queue**
  and are excluded until approved.

## 8. Conventions

- No **LLM‑generated SQL** and no schema/data mutation by a model.
- Arabic text is preserved as valid UTF‑8.
- Every approved value keeps its **original source value** alongside any
  normalized form, and is versioned.

---

*Enforcement: Data Steward gates this policy (`MVP_REQUIREMENTS.md`); a source
may not surface to users until approved.*