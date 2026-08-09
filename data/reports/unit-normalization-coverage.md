# Unit Normalization Coverage Report

- Tool: nutriguard-unit-normalizer
- Source: data/raw/Recipes For Eqyption Food.csv
- Registry: data/dictionary/unit-conversions.json
- Units: 9
- Sourced ingredient conversions: 12
- Sourced edible-portion factors: 0
- Sourced cooking-yield factors: 0

## Coverage

- Ingredient occurrences: 14584
- Counted occurrences: 14584
- Quantity parsed: 13470 (92.36%)
- Unit normalized: 10278 (70.47%)
- Gram converted: 0 (0.00%)
- Accepted ingredient mappings available: 0
- Statuses: converted=0, partial=13470, unsupported=1110, invalid=4
- Measure variants: standard=10278, egyptian_household=0
- Review queue records: 6238

## Blockers

- No approved Step 5 ingredient mappings are available, so ingredient-specific factors cannot be applied to production rows.
- No occurrence could be converted to grams.

> Unsupported and partial records have no fabricated gram value. Fuzzy/LLM output is never used.
