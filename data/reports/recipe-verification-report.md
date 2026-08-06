# Recipe Verification Report

- Tool: nutriguard-egypt-recipe-staging
- Schema version: 2.0
- Recipe source: data/raw/Recipes For Eqyption Food.csv

## Import statistics

- Rows in source: 1468
- Imported as `needs_review` (Egyptian-scope evidence): 1
- Imported as `rejected` (clear non-Egyptian evidence): 0
- Excluded â€” malformed/invalid rows: 0
- Excluded â€” no Egyptian evidence & not classifiable non-Egyptian: 1467
- Preserved from existing registry (reviews kept): 0
- Routed back to review (source drift): 0

## Registry status

- needs_review: 1
- verified: 0
- rejected: 0
- Eligible for the verified MVP dataset: **0**

## Verified recipes available for the MVP

**None.** No recipe is available for the verified MVP dataset.
Nothing is fabricated to reach a target.

## Blockers

- 0 verified recipes available â€” the MVP verified-recipe target is not met and is not being fabricated.
- Recipe source "data/raw/Recipes For Eqyption Food.csv" has no source record in data/manifest/sources.json â€” provenance/license coverage is incomplete (records stay pending/not_assessed).
- Every imported recipe is unreviewed (needs_review). Verification requires a human review decision: reviewerId + strict ISO reviewDate + evidence that resolves against data/manifest/sources.json (docs/MANUAL_REVIEW_WORKFLOW.md).
- Columns absent from the raw source and stored as null (never fabricated; must be curated by reviewers): Arabic names, region, servings, final-cooked-weight.

## Per-record eligibility blockers

- `EGR-389070B0550F4D25` (Air Fryer Falafel, needs_review):
  - verificationStatus is not verified (automation never verifies)

## Ignored global recipe files

- `data/processed/cleaned_recipes.json` (exists â€” ignored) â€” general-purpose dump, never treated as Egyptian
