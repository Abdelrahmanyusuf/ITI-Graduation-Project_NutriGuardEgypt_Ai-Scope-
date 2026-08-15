# Health-first recommendations and gram portions

Status: implemented on `codex/health-first-local-recipes` for the graduation-project runtime.

## What changed

### Verified gram portions

- Calorie-target recommendations now calculate cooked portion grams from each verified recipe's `per100g.kcal` value.
- The displayed gram amount is rounded first; calories and macros are then recalculated from that same rounded amount so the values reconcile.
- Responses expose `portionGrams`, `servingFraction`, `portionNutrition`, and `portionBasis: "verified_per_100g"`.
- Daily meal plans expose the same fields for every meal and calculate totals from the scaled portions.
- General category, nutrient-ranked, pantry, Step 16 option, confirmation, and recipe-detail responses now show the verified cooked serving weight.

No Backend schema change is required for this graduation flow. The existing custom-meal batch request receives the scaled nutrition snapshot and the equivalent fractional `servings` value. The Backend does not store grams as a dedicated field; grams remain deterministic AI response data derived from the same verified snapshot.

### Health-first, deterministic ranking

Policy version: `health-first-local-v1`.

The ranking uses a documented comparison heuristic that:

- rewards protein and fiber density per 100 kcal;
- penalizes high sodium density;
- penalizes a high share of energy from fat;
- penalizes recipes with recorded frying/oil absorption;
- avoids recently recommended recipe IDs when alternatives exist;
- diversifies the first three category results by recorded cooking method before filling remaining slots.

This is deliberately described as a nutrition-balance comparison heuristic, not a medical certification that a recipe is universally “healthy.” A requested nutrient such as high protein remains the primary sort key; the health-first score is its deterministic tie-breaker.

### Cuisine and local relevance

Every trusted result carries its recorded `cuisineOrigin`. The currently verified user-facing corpus contains 215 Egyptian recipes, so the runtime does not pretend that unreviewed rows are verified Middle Eastern recipes.

The separate 1,468-row file remains available for future expansion, but is blocked by an executable readiness audit:

```text
rowsTotal: 1468
hasRequiredNutritionColumns: false
hasPerRecordProvenanceColumn: false
contradictoryMultiCuisineRows: 1421
middleEasternTaggedRows: 1463
middleEasternAndContradictoryRows: 1421
eligibleForTrustedRecommendations: 0
decision: blocked_pending_nutrition_provenance_and_human_review
```

Run the evidence again with:

```bash
npm run audit:regional-recipes
```

The `cuisine_list` field cannot currently be used as a reliable Middle Eastern filter: 1,421 rows carry four or more simultaneous cuisine labels, and those same rows include the Middle Eastern label. The file also lacks the calculated nutrition/yield and per-record provenance fields required for safe gram calculation. Local ingredient coverage is useful future intake metadata, but is not proof of cuisine origin, nutrition completeness, or human review.

## Regression coverage

New tests cover:

- 300 kcal of verified Koshary resolves to 137 g and reconciles to within 1 kcal;
- named calorie-target Agent output exposes grams and the verified basis;
- every meal in a daily plan has grams, fractional servings, scaled macros, and a balance score;
- the ranking is deterministic and cooking-method diversification is applied;
- the regional source fails closed at the quality gate;
- Step 16 candidate output exposes grams;
- the Backend adapter sends the displayed portion as a fractional serving.

Existing brittle tests that assumed the old recipe-ID ordering were updated to assert the new business behavior: verified grams, health-first policy, valid category/exclusion constraints, and deterministic totals.

## Deliberate boundary

Adding non-Egyptian/Middle Eastern recipes to the trusted RAG corpus is not marked complete. It requires records with trustworthy provenance, completed nutrition snapshots including cooked yield, honest cuisine metadata, and human review. No row from the noisy 1,468-row file was silently approved, imported, or presented to users.
