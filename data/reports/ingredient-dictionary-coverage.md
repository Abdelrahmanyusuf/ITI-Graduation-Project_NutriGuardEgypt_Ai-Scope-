# Ingredient Dictionary Coverage Report

- Tool: nutriguard-ingredient-dictionary
- Schema version: 1.0
- Dictionary: data/dictionary/ingredients.json (51 canonical records)
- Reviewed mappings: data/dictionary/reviewed-mappings.json (0)
- Review registry: data/dictionary/review-registry.json (0 content-hash-verified records)
- Source: data/raw/Recipes For Eqyption Food.csv
- Ingredient occurrences read: 14584

## Resolution

- Required ingredient occurrences: 14584
- Resolved occurrences: 0 (0.00%)
- Ambiguous (review queue): 1
- Unresolved (review queue): 14583
- Unique normalized ingredient terms: 3327
- Unique-term resolution rate: 0.00%
- By stage: normalized_exact=0 alias_exact=0 reviewed_mapping=0

## Coverage

- By ingredient occurrence count: 0.00%
- By nutritionally-significant recipe weight: n/a (no per-ingredient weight supplied in this run)
- Distinct canonical records resolved: 0

## Accepted mappings (traceable, deterministic)

**None.** Nothing is fabricated to reach a coverage target.

## Blockers

- 0 ingredient occurrences are mapped to an approved canonical record — acceptance target is not met and is not being fabricated.
- 14584 counted occurrences are routed to 3327 unique review records; approved mappings require a content-hash-verified record in data/dictionary/review-registry.json.

> Deterministic, read-only resolution. Fuzzy/vector matches are
> NEVER auto-accepted as canonical mappings; ambiguous terms stay
> separate and are routed to the manual review queue.
