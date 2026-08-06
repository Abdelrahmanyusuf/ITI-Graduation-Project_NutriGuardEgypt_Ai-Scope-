# Data Audit Report

- Tool: nutriguard-egypt-data-audit
- Schema version: 1.0
- Raw root: data/raw
- Structurally invalid inputs: **no**

## Curated audit source manifest

- File: data/manifest/sources.json (outside data/raw; raw inputs untouched)
- sha256: bd8b54beb96e345f190ca8eb465ed3d0a417eff0162a42686a422086855d1ab3
- `data/raw/WHO Guidelines.pdf`: source_id=who-healthy-diet-factsheet-2026 name="WHO — World Health Organization" title=Healthy diet review_status=pending

- The manifest records identity/title/date as an explicit provenance
  record ONLY; license/approval review status remains pending (DATA_SOURCE_POLICY.md).

## data/raw/Egyptian_Food_Categorized.csv

- Kind: ingredients
- Format: CSV (comma-delimited, quoted fields)
- Encoding: utf-8
- Bytes: 70146
- Document count: 470
- Column count: 25

### Columns

- `FOOD`: present=470 missing=0 distinct=468 invalid_numeric=0 zero=0
- `REFUSE (%)`: present=470 missing=0 distinct=50 invalid_numeric=0 zero=340
- `WATER (g)`: present=469 missing=1 distinct=310 invalid_numeric=0 zero=0
- `ENERGY (Kcal)`: present=468 missing=2 distinct=292 invalid_numeric=0 zero=0
- `PROTEIN (g)`: present=461 missing=9 distinct=193 invalid_numeric=0 zero=6 — mixes empty cells and explicit zeros (possible missing->0 conflation; needs manual check)
- `FAT (g)`: present=457 missing=13 distinct=172 invalid_numeric=0 zero=14 — mixes empty cells and explicit zeros (possible missing->0 conflation; needs manual check)
- `ASH (g)`: present=466 missing=4 distinct=69 invalid_numeric=0 zero=4 — mixes empty cells and explicit zeros (possible missing->0 conflation; needs manual check)
- `FIBER (g)`: present=452 missing=18 distinct=61 invalid_numeric=0 zero=130 — mixes empty cells and explicit zeros (possible missing->0 conflation; needs manual check)
- `CARBOHYDRATE  (g)`: present=466 missing=4 distinct=298 invalid_numeric=0 zero=27 — mixes empty cells and explicit zeros (possible missing->0 conflation; needs manual check)
- `SODIUM (mg)`: present=443 missing=27 distinct=250 invalid_numeric=0 zero=1 — mixes empty cells and explicit zeros (possible missing->0 conflation; needs manual check)
- `POTASSIUM (mg)`: present=421 missing=49 distinct=248 invalid_numeric=0 zero=1 — mixes empty cells and explicit zeros (possible missing->0 conflation; needs manual check)
- `CALCIUM (mg)`: present=431 missing=39 distinct=155 invalid_numeric=0 zero=2 — mixes empty cells and explicit zeros (possible missing->0 conflation; needs manual check)
- `PHOSPHORUS (mg)`: present=348 missing=122 distinct=205 invalid_numeric=0 zero=1 — mixes empty cells and explicit zeros (possible missing->0 conflation; needs manual check)
- `MAGNESIUM (mg)`: present=290 missing=180 distinct=90 invalid_numeric=0 zero=2 — mixes empty cells and explicit zeros (possible missing->0 conflation; needs manual check)
- `IRON (mg)`: present=435 missing=35 distinct=171 invalid_numeric=1 zero=2 — mixes empty cells and explicit zeros (possible missing->0 conflation; needs manual check)
- `ZINC (mg)`: present=414 missing=56 distinct=167 invalid_numeric=0 zero=3 — mixes empty cells and explicit zeros (possible missing->0 conflation; needs manual check)
- `COPPER (mg)`: present=293 missing=177 distinct=66 invalid_numeric=0 zero=3 — mixes empty cells and explicit zeros (possible missing->0 conflation; needs manual check)
- `VITAMIN A (ugre)`: present=299 missing=171 distinct=104 invalid_numeric=0 zero=0
- `VITAMIN C (mg)`: present=330 missing=140 distinct=52 invalid_numeric=0 zero=178 — mixes empty cells and explicit zeros (possible missing->0 conflation; needs manual check)
- `THIAMIN (mg)`: present=284 missing=186 distinct=61 invalid_numeric=0 zero=8 — mixes empty cells and explicit zeros (possible missing->0 conflation; needs manual check)
- `REBOFLAVIN (mg)`: present=283 missing=187 distinct=60 invalid_numeric=0 zero=8 — mixes empty cells and explicit zeros (possible missing->0 conflation; needs manual check)
- `Unnamed: 21`: present=0 missing=470 distinct=0 invalid_numeric=0 zero=0
- `main_category`: present=470 missing=0 distinct=19 invalid_numeric=0 zero=0
- `subcategory`: present=470 missing=0 distinct=48 invalid_numeric=0 zero=0
- `prep_state`: present=470 missing=0 distinct=3 invalid_numeric=0 zero=0

### Duplicates

- Key: normalized FOOD name
- Duplicate groups: 3
- Redundant rows: 3
  - `coriander` x2: rows 167, 451
  - `cowpeas` x2: rows 122, 168
  - `peas` x2: rows 133, 206

### Invalid numbers

- Count: 1

### Suspicious zeros

- Count: 47
  - row 170 `FAT (g)`: "0" (zero is implausible for this column (possible missing->0 coercion))
  - row 227 `FAT (g)`: "0" (zero is implausible for this column (possible missing->0 coercion))
  - row 268 `PROTEIN (g)`: "0" (zero is implausible for this column (possible missing->0 coercion))
  - row 268 `FAT (g)`: "0" (zero is implausible for this column (possible missing->0 coercion))
  - row 288 `PROTEIN (g)`: "0" (zero is implausible for this column (possible missing->0 coercion))
  - row 288 `FAT (g)`: "0" (zero is implausible for this column (possible missing->0 coercion))
  - row 302 `PROTEIN (g)`: "0" (zero is implausible for this column (possible missing->0 coercion))
  - row 302 `FAT (g)`: "0" (zero is implausible for this column (possible missing->0 coercion))
  - row 304 `PROTEIN (g)`: "0" (zero is implausible for this column (possible missing->0 coercion))
  - row 311 `CARBOHYDRATE  (g)`: "0.0" (zero is implausible for this column (possible missing->0 coercion))
  - row 317 `CARBOHYDRATE  (g)`: "0.0" (zero is implausible for this column (possible missing->0 coercion))
  - row 320 `CARBOHYDRATE  (g)`: "0.0" (zero is implausible for this column (possible missing->0 coercion))
  - row 321 `CARBOHYDRATE  (g)`: "0.0" (zero is implausible for this column (possible missing->0 coercion))
  - row 322 `CARBOHYDRATE  (g)`: "0.0" (zero is implausible for this column (possible missing->0 coercion))
  - row 334 `CARBOHYDRATE  (g)`: "0.0" (zero is implausible for this column (possible missing->0 coercion))
  - row 336 `CARBOHYDRATE  (g)`: "0.0" (zero is implausible for this column (possible missing->0 coercion))
  - row 344 `CARBOHYDRATE  (g)`: "0.0" (zero is implausible for this column (possible missing->0 coercion))
  - row 345 `CARBOHYDRATE  (g)`: "0.0" (zero is implausible for this column (possible missing->0 coercion))
  - row 346 `CARBOHYDRATE  (g)`: "0.0" (zero is implausible for this column (possible missing->0 coercion))
  - row 347 `CARBOHYDRATE  (g)`: "0.0" (zero is implausible for this column (possible missing->0 coercion))
  - row 348 `CARBOHYDRATE  (g)`: "0.0" (zero is implausible for this column (possible missing->0 coercion))
  - row 349 `CARBOHYDRATE  (g)`: "0.0" (zero is implausible for this column (possible missing->0 coercion))
  - row 350 `CARBOHYDRATE  (g)`: "0.0" (zero is implausible for this column (possible missing->0 coercion))
  - row 352 `CARBOHYDRATE  (g)`: "0.0" (zero is implausible for this column (possible missing->0 coercion))
  - row 354 `CARBOHYDRATE  (g)`: "0.0" (zero is implausible for this column (possible missing->0 coercion))

- Zero/missing conflation detected: yes in [PROTEIN (g), FAT (g), ASH (g), FIBER (g), CARBOHYDRATE  (g), SODIUM (mg), POTASSIUM (mg), CALCIUM (mg), PHOSPHORUS (mg), MAGNESIUM (mg), IRON (mg), ZINC (mg), COPPER (mg), VITAMIN C (mg), THIAMIN (mg), REBOFLAVIN (mg)]

### Coverage metrics

These are DIAGNOSTIC HEURISTICS, not canonical coverage. Canonical
quantity parsing and ingredient-line mapping coverage remain unknown
until approved rule sets exist.

- leadingQuantityHeuristic: n/a
- recognizedUnitHeuristic: n/a
- canonicalQuantityParsingCoverage: n/a
- canonicalIngredientLineMappingCoverage: n/a
- Serving/yield coverage: n/a
- Raw/cooked food-state coverage: 470/470 (100.00%)
  - note: rows with a prep_state value; distinct values: Raw / Unprepared, Prepared / Cooked Dish, Processed / Preserved

### Ingredients

- Unique ingredient terms: 467
- Top terms: almonds, apples, apricots, apricots dried, artichokes, artichokes salad, avocado, backing powder, bananas, barlcy grains, beans broad, beans broad bisara, beans broad decorticated, beans broad foul canned, beans broad foulmedames, beans broad green, beans broad menabet, beans broad nabet cooked, beans broad taamia fride, beans green

### Egyptian-scope evidence

- Fields: FOOD, prep_state
- Note: reference ingredient list; Egyptian scope, if any, is not encoded in this file

### Nutrition cell audit

- Columns: 20 (missing | valid_numeric | explicit_zero | trace_marker | invalid)
  - `REFUSE (%)`: missing=0 valid=130 zero=340 trace=0 invalid=0
      - row 2 [explicit_zero]: "0" (explicit zero value)
      - row 3 [explicit_zero]: "0" (explicit zero value)
      - row 4 [explicit_zero]: "0" (explicit zero value)
      - row 5 [explicit_zero]: "0" (explicit zero value)
      - row 6 [explicit_zero]: "0" (explicit zero value)
      - row 7 [explicit_zero]: "0" (explicit zero value)
  - `WATER (g)`: missing=1 valid=469 zero=0 trace=0 invalid=0
      - row 2 [valid_numeric]: "8.8"
      - row 3 [valid_numeric]: "10.7"
      - row 4 [valid_numeric]: "10.1"
      - row 5 [valid_numeric]: "5.0"
      - row 6 [valid_numeric]: "11.1"
      - row 7 [valid_numeric]: "74.5"
  - `ENERGY (Kcal)`: missing=2 valid=468 zero=0 trace=0 invalid=0
      - row 2 [valid_numeric]: "335.0"
      - row 3 [valid_numeric]: "364.0"
      - row 4 [valid_numeric]: "368.0"
      - row 5 [valid_numeric]: "373.0"
      - row 6 [valid_numeric]: "359.0"
      - row 7 [valid_numeric]: "100.0"
  - `PROTEIN (g)`: missing=9 valid=454 zero=6 trace=1 invalid=0
      - row 2 [valid_numeric]: "10.7"
      - row 3 [valid_numeric]: "10.2"
      - row 4 [valid_numeric]: "12.7"
      - row 5 [valid_numeric]: "6.2"
      - row 6 [valid_numeric]: "8.9"
      - row 7 [valid_numeric]: "2.8"
  - `FAT (g)`: missing=13 valid=441 zero=14 trace=2 invalid=0
      - row 2 [valid_numeric]: "1.5"
      - row 3 [valid_numeric]: "4"
      - row 4 [valid_numeric]: "5.5"
      - row 5 [valid_numeric]: "2.1"
      - row 6 [valid_numeric]: "2.5"
      - row 7 [valid_numeric]: "0.9"
  - `ASH (g)`: missing=4 valid=462 zero=4 trace=0 invalid=0
      - row 2 [valid_numeric]: "2.9"
      - row 3 [valid_numeric]: "1.3"
      - row 4 [valid_numeric]: "1.8"
      - row 5 [valid_numeric]: "2.4"
      - row 6 [valid_numeric]: "1.3"
      - row 7 [valid_numeric]: "0.9"
  - `FIBER (g)`: missing=18 valid=322 zero=130 trace=0 invalid=0
      - row 2 [valid_numeric]: "6.9"
      - row 3 [valid_numeric]: "1.9"
      - row 4 [valid_numeric]: "2.9"
      - row 5 [valid_numeric]: "2.9"
      - row 6 [valid_numeric]: "1.0"
      - row 7 [valid_numeric]: "0.5"
  - `CARBOHYDRATE  (g)`: missing=4 valid=439 zero=27 trace=0 invalid=0
      - row 2 [valid_numeric]: "69.6"
      - row 3 [valid_numeric]: "71.9"
      - row 4 [valid_numeric]: "67.0"
      - row 5 [valid_numeric]: "82.3"
      - row 6 [valid_numeric]: "75.2"
      - row 7 [valid_numeric]: "20.1"
  - `SODIUM (mg)`: missing=27 valid=442 zero=1 trace=0 invalid=0
      - row 2 [valid_numeric]: "55.0"
      - row 3 [valid_numeric]: "8.0"
      - row 4 [valid_numeric]: "10.0"
      - row 5 [valid_numeric]: "464.0"
      - row 6 [valid_numeric]: "6.0"
      - row 7 [valid_numeric]: "301.0"
  - `POTASSIUM (mg)`: missing=49 valid=420 zero=1 trace=0 invalid=0
      - row 2 [valid_numeric]: "299.0"
      - row 3 [valid_numeric]: "125.0"
      - row 4 [valid_numeric]: "161.0"
      - row 5 [valid_numeric]: "139.0"
      - row 6 [valid_numeric]: "95.0"
      - row 7 [valid_numeric]: "82.0"
  - `CALCIUM (mg)`: missing=39 valid=429 zero=2 trace=0 invalid=0
      - row 2 [valid_numeric]: "104.0"
      - row 3 [valid_numeric]: "27.0"
      - row 4 [valid_numeric]: "26.0"
      - row 5 [valid_numeric]: "15.0"
      - row 6 [valid_numeric]: "22.0"
      - row 7 [valid_numeric]: "5.0"
  - `PHOSPHORUS (mg)`: missing=122 valid=347 zero=1 trace=0 invalid=0
      - row 2 [valid_numeric]: "184.0"
      - row 3 [valid_numeric]: "254.0"
      - row 4 [valid_numeric]: "239.0"
      - row 5 [valid_numeric]: "44.0"
      - row 6 [valid_numeric]: "183.0"
      - row 7 [valid_numeric]: "65.0"
  - `MAGNESIUM (mg)`: missing=180 valid=288 zero=2 trace=0 invalid=0
      - row 2 [valid_numeric]: "26.0"
      - row 3 [valid_numeric]: "25.0"
      - row 4 [valid_numeric]: "30.0"
      - row 5 [valid_numeric]: "11.0"
      - row 6 [valid_numeric]: "20.0"
      - row 11 [explicit_zero]: "0.0" (explicit zero value)
  - `IRON (mg)`: missing=35 valid=432 zero=2 trace=0 invalid=1
      - row 2 [valid_numeric]: "4.63"
      - row 3 [valid_numeric]: "2.42"
      - row 4 [valid_numeric]: "2.6"
      - row 5 [valid_numeric]: "1.4"
      - row 6 [valid_numeric]: "2.3"
      - row 7 [valid_numeric]: "0.65"
  - `ZINC (mg)`: missing=56 valid=410 zero=3 trace=1 invalid=0
      - row 2 [valid_numeric]: "2.25"
      - row 3 [valid_numeric]: "1.7"
      - row 4 [valid_numeric]: "1.5"
      - row 5 [valid_numeric]: "1"
      - row 6 [valid_numeric]: "1.05"
      - row 7 [valid_numeric]: "0.5"
  - `COPPER (mg)`: missing=177 valid=290 zero=3 trace=0 invalid=0
      - row 2 [valid_numeric]: "0.41"
      - row 3 [valid_numeric]: "0.21"
      - row 4 [valid_numeric]: "0.19"
      - row 5 [valid_numeric]: "0.23"
      - row 6 [valid_numeric]: "0.19"
      - row 7 [valid_numeric]: "0.05"
  - `VITAMIN A (ugre)`: missing=171 valid=184 zero=62 trace=53 invalid=0
      - row 2 [recognized_trace_marker]: "T" (recognized trace-marker token (e.g. T/tr/trace); not coerced to numeric 0 or ignored)
      - row 3 [recognized_trace_marker]: "T" (recognized trace-marker token (e.g. T/tr/trace); not coerced to numeric 0 or ignored)
      - row 4 [valid_numeric]: "120"
      - row 5 [explicit_zero]: "0" (explicit zero value)
      - row 6 [explicit_zero]: "0" (explicit zero value)
      - row 7 [valid_numeric]: "25"
  - `VITAMIN C (mg)`: missing=140 valid=146 zero=178 trace=6 invalid=0
      - row 2 [explicit_zero]: "0" (explicit zero value)
      - row 3 [explicit_zero]: "0" (explicit zero value)
      - row 4 [explicit_zero]: "0" (explicit zero value)
      - row 5 [explicit_zero]: "0" (explicit zero value)
      - row 6 [explicit_zero]: "0" (explicit zero value)
      - row 7 [valid_numeric]: "7"
  - `THIAMIN (mg)`: missing=186 valid=276 zero=8 trace=0 invalid=0
      - row 2 [valid_numeric]: "0.3"
      - row 3 [valid_numeric]: "0.37"
      - row 4 [valid_numeric]: "0.39"
      - row 5 [valid_numeric]: "0.5"
      - row 6 [explicit_zero]: "0.0" (explicit zero value)
      - row 7 [valid_numeric]: "0.03"
  - `REBOFLAVIN (mg)`: missing=187 valid=275 zero=8 trace=0 invalid=0
      - row 2 [valid_numeric]: "0.11"
      - row 3 [valid_numeric]: "0.12"
      - row 4 [valid_numeric]: "0.11"
      - row 5 [valid_numeric]: "0.09"
      - row 6 [explicit_zero]: "0.0" (explicit zero value)
      - row 7 [valid_numeric]: "0.04"

### OCR / extraction noise

- Detected: yes
  - overlong_tokens
  - nonbreaking_spaces
  - 3 token(s) longer than 120 chars (possible concatenation)
  - 4 U+00A0 non-breaking space(s)

### Licensing

- License fields present: no
- Note: no license/provenance columns present in the ingredient source

### Encoding / mojibake

- Mojibake detected: no

- Structural errors: none

## data/raw/Recipes For Eqyption Food.csv

- Kind: recipes
- Format: CSV (tab-delimited, quoted fields)
- Encoding: utf-8
- Bytes: 2940806
- Document count: 1468
- Column count: 33

### Columns

- `recipe_title`: present=1468 missing=0 distinct=1151 invalid_numeric=0 zero=0
- `category`: present=1468 missing=0 distinct=24 invalid_numeric=0 zero=0
- `subcategory`: present=1468 missing=0 distinct=107 invalid_numeric=0 zero=0
- `description`: present=1468 missing=0 distinct=1153 invalid_numeric=0 zero=0
- `ingredients`: present=1468 missing=0 distinct=1153 invalid_numeric=0 zero=0
- `directions`: present=1468 missing=0 distinct=1153 invalid_numeric=0 zero=0
- `num_ingredients`: present=1468 missing=0 distinct=24 invalid_numeric=0 zero=0
- `num_steps`: present=1468 missing=0 distinct=16 invalid_numeric=0 zero=0
- `ingredients_canonical`: present=1468 missing=0 distinct=1153 invalid_numeric=0 zero=0
- `cuisine_list`: present=1468 missing=0 distinct=459 invalid_numeric=0 zero=0
- `course_list`: present=1468 missing=0 distinct=273 invalid_numeric=0 zero=0
- `meal_type`: present=1468 missing=0 distinct=15 invalid_numeric=0 zero=0
- `tastes`: present=1468 missing=0 distinct=34 invalid_numeric=0 zero=0
- `primary_taste`: present=1468 missing=0 distinct=4 invalid_numeric=0 zero=0
- `secondary_taste`: present=1468 missing=0 distinct=6 invalid_numeric=0 zero=0
- `fast_hits`: present=1468 missing=0 distinct=25 invalid_numeric=0 zero=11
- `slow_hits`: present=1468 missing=0 distinct=14 invalid_numeric=0 zero=217
- `medium_hits`: present=1468 missing=0 distinct=19 invalid_numeric=0 zero=146
- `cook_speed`: present=1468 missing=0 distinct=3 invalid_numeric=0 zero=0
- `est_prep_time_min`: present=1468 missing=0 distinct=49 invalid_numeric=0 zero=0
- `est_cook_time_min`: present=1468 missing=0 distinct=150 invalid_numeric=0 zero=0
- `difficulty`: present=1468 missing=0 distinct=3 invalid_numeric=0 zero=0
- `is_vegan`: present=1468 missing=0 distinct=2 invalid_numeric=0 zero=0
- `is_vegetarian`: present=1468 missing=0 distinct=2 invalid_numeric=0 zero=0
- `is_halal`: present=1468 missing=0 distinct=1 invalid_numeric=0 zero=0
- `is_kosher`: present=1468 missing=0 distinct=2 invalid_numeric=0 zero=0
- `is_nut_free`: present=1468 missing=0 distinct=2 invalid_numeric=0 zero=0
- `is_dairy_free`: present=1468 missing=0 distinct=2 invalid_numeric=0 zero=0
- `is_gluten_free`: present=1468 missing=0 distinct=2 invalid_numeric=0 zero=0
- `dietary_profile`: present=1468 missing=0 distinct=12 invalid_numeric=0 zero=0
- `healthiness_score`: present=1468 missing=0 distinct=25 invalid_numeric=0 zero=0
- `main_ingredient`: present=1468 missing=0 distinct=6 invalid_numeric=0 zero=0
- `egy_ingredient_coverage`: present=1468 missing=0 distinct=1 invalid_numeric=0 zero=0

### Duplicates

- Key: normalized recipe_title
- Duplicate groups: 227
- Redundant rows: 317
  - `15-minute creamy garlic basil pasta` x2: rows 127, 172
  - `20 layer air fryer nachos` x2: rows 36, 266
  - `4-ingredient hamburger casserole` x2: rows 1076, 1108
  - `5-hour beef stew` x5: rows 942, 958, 1271, 1295, 1315
  - `air fryer beef tenderloin` x3: rows 940, 957, 1314
  - `air fryer crispy pickle chips with creole dipping sauce` x5: rows 8, 27, 338, 482, 704
  - `air fryer everything bagel chicken cutlets` x3: rows 2, 10, 131
  - `air fryer green bean fries` x3: rows 9, 28, 339
  - `air fryer grilled pimento cheese` x2: rows 5, 13
  - `air fryer hearts of palm sticks` x2: rows 7, 37
  - `air fryer honey sriracha salmon bites` x3: rows 3, 65, 247
  - `air fryer lemon garlic parmesan chicken` x2: rows 4, 12
  - `air fryer parmesan chicken skewers` x2: rows 26, 305
  - `air fryer pasta chips` x2: rows 35, 485
  - `air fryer po boy` x2: rows 6, 14
  - `air fryer reuben-inspired mozzarella sticks` x2: rows 38, 269
  - `air fryer rib-eye steak` x2: rows 16, 1011
  - `air fryer turkey stuffed peppers` x2: rows 43, 115
  - `alita s tomato beef stew` x2: rows 1275, 1299
  - `andie s stuffed mushrooms` x2: rows 650, 665

### Invalid numbers

- Count: 0

### Suspicious zeros

- Count: 0

- Zero/missing conflation detected: no

### Coverage metrics

These are DIAGNOSTIC HEURISTICS, not canonical coverage. Canonical
quantity parsing and ingredient-line mapping coverage remain unknown
until approved rule sets exist.

- leadingQuantityHeuristic: 13362/13628 (98.05%)
  - note: HEURISTIC: ingredient lines with a leading quantity token (number or fraction) over total non-optional ingredient lines; NOT canonical quantity parsing
- recognizedUnitHeuristic: 11577/13628 (84.95%)
  - note: HEURISTIC: ingredient lines containing a recognized unit token over total non-optional ingredient lines; NOT canonical unit recognition
- canonicalQuantityParsingCoverage: unknown
  - note: unknown — no approved canonical quantity-parsing rule set exists yet
- canonicalIngredientLineMappingCoverage: unknown
  - note: unknown — no approved canonical ingredient-line mapping rule set exists yet
- Serving/yield coverage: 0/1468 (n/a)
  - note: no serving or yield column present in the recipe source; per-basis serving/yield unavailable (unknown, not a measured 0)
- Raw/cooked food-state coverage: 0/1468 (n/a)
  - note: no raw/cooked food-state column present in the recipe source (unavailable)

### Ingredients

- Unique ingredient terms: 4633
- Top terms: olive oil, salt, all-purpose flour, water, cloves garlic minced, white sugar, ½ salt, lemon juice, garlic powder, ground black pepper, butter, kosher salt, vegetable oil, pound ground beef, salt freshly ground black pepper taste, salt ground black pepper taste, large egg, unsalted butter, dried oregano, grated parmesan cheese
- Exact ingredient match: 29/4633 (0.63%)
- Ambiguous matches (samples):
  - `- ounces jar reduced-sodium dill pickle chips drained` -> [dill]
  - `-inch sprigs fresh thyme` -> [thyme]
  - `-inch thick cucumber slices` -> [cucumber]
  - `-ounce can crushed tomatoes` -> [tomatoes]
  - `-ounce can diced tomatoes green chiles such as rotel drained` -> [tomatoes]
  - `-ounce can diced tomatoes undrained` -> [tomatoes]
  - `-ounce can pineapple rings in pineapple juice` -> [pineapple]
  - `-ounce can roasted tomatoes` -> [tomatoes]
  - `-ounce cans diced tomatoes with green chilies` -> [tomatoes]
  - `-ounce package mashed potatoes` -> [potatoes]

### Egyptian-scope evidence

- Fields: cuisine_list, main_ingredient, egy_ingredient_coverage, category, subcategory, description
- Note: only explicit Egyptian signals count; broad regional tags (Middle Eastern/Mediterranean) are NOT Egyptian evidence

### Field distributions (discriminative-scope analysis)

- `cuisine_list`: distinct=459 present=1468 missing=0
  - 459 distinct value(s) across 1468/1468 present rows
- `egy_ingredient_coverage`: distinct=1 present=1468 missing=0
  - CONSTANT (non-discriminative): constant (single distinct value); non-discriminative for Egyptian scope

### OCR / extraction noise

- Detected: yes
  - repeated_punctuation
  - e.g. ....., ...., .....

### Licensing

- License fields present: no
- Note: no license/provenance columns present in the recipe source

### Encoding / mojibake

- Mojibake detected: no

- Structural errors: none

## data/raw/WHO Guidelines.pdf

- Kind: guidelines_pdf
- Format: PDF (binary)
- Encoding: binary
- Bytes: 5100286
- Document count: 1
- Column count: 0

- Duplicates: none found

### Invalid numbers

- Count: 0

### Suspicious zeros

- Count: 0

- Zero/missing conflation detected: no

### Coverage metrics

These are DIAGNOSTIC HEURISTICS, not canonical coverage. Canonical
quantity parsing and ingredient-line mapping coverage remain unknown
until approved rule sets exist.

- leadingQuantityHeuristic: n/a
- recognizedUnitHeuristic: n/a
- canonicalQuantityParsingCoverage: n/a
- canonicalIngredientLineMappingCoverage: n/a
- Serving/yield coverage: n/a
- Raw/cooked food-state coverage: n/a

### Ingredients

- Unique ingredient terms: 0

### Egyptian-scope evidence

- Fields: none
- Note: guideline content is general nutrition guidance; Egyptian-scope not applicable to this source

### Guideline source/date/provenance coverage

- Page count: 8
- Visible source: WHO — World Health Organization
- Visible title: Healthy diet
- Visible date: 26 January 2026
- Extraction available: yes
- Provenance status: identified
- OCR noise detected: yes
  - page count derived from the PDF page tree (incl. compressed object streams)
  - text extraction available for the OCR layer
  - provenance identified: WHO — World Health Organization
  - OCR-corrupted organization name detected in extracted content: "Donate rid Health wey viyanization" (near-match of "World Health Organization")

### OCR / extraction noise

- Detected: yes
  - ocr_corrupted_organization_name
  - garbled org-name region: "Donate rid Health wey viyanization" (near-match of "World Health Organization")

### Licensing

- License fields present: no
- Note: license metadata not discoverable; license not assessed

### Encoding / mojibake

- Mojibake detected: no

- Structural errors: none

## data/raw/food_pyramid.json

- Kind: food_pyramid
- Format: JSON
- Encoding: UTF-8
- Bytes: 5580
- Document count: 9
- Column count: 0

- Duplicates: none found

### Invalid numbers

- Count: 0

### Suspicious zeros

- Count: 0

- Zero/missing conflation detected: no

### Coverage metrics

These are DIAGNOSTIC HEURISTICS, not canonical coverage. Canonical
quantity parsing and ingredient-line mapping coverage remain unknown
until approved rule sets exist.

- leadingQuantityHeuristic: n/a
- recognizedUnitHeuristic: n/a
- canonicalQuantityParsingCoverage: n/a
- canonicalIngredientLineMappingCoverage: n/a
- Serving/yield coverage: n/a
- Raw/cooked food-state coverage: n/a

### Ingredients

- Unique ingredient terms: 0

### Egyptian-scope evidence

- Fields: layer, category
- Note: the pyramid has a generic/unknown provenance; Egyptian/WHO endorsement not established

### OCR / extraction noise

- Detected: no

### Licensing

- License fields present: no
- Candidate fields: layer, category, description, recommended_servings
- Note: no license field; pyramid provenance is unverified and not approved

### Encoding / mojibake

- Mojibake detected: no

- Structural errors: none

## data/raw/Food Pyramid/Food Pyramid_0001.jpg

- Kind: food_pyramid_images
- Format: JPEG (binary)
- Encoding: binary
- Bytes: 8860756
- Document count: 1
- Column count: 0

- Duplicates: none found

### Invalid numbers

- Count: 0

### Suspicious zeros

- Count: 0

- Zero/missing conflation detected: no

### Coverage metrics

These are DIAGNOSTIC HEURISTICS, not canonical coverage. Canonical
quantity parsing and ingredient-line mapping coverage remain unknown
until approved rule sets exist.

- leadingQuantityHeuristic: n/a
- recognizedUnitHeuristic: n/a
- canonicalQuantityParsingCoverage: n/a
- canonicalIngredientLineMappingCoverage: n/a
- Serving/yield coverage: n/a
- Raw/cooked food-state coverage: n/a

### Ingredients

- Unique ingredient terms: 0

### Egyptian-scope evidence

- Fields: none
- Note: image content not OCR'd in this audit pass

### OCR / extraction noise

- Detected: no

### Licensing

- License fields present: no
- Note: no license metadata discoverable without EXIF/OCR

### Encoding / mojibake

- Mojibake detected: no
- file is binary; not evaluated as text

- Structural errors: none

## data/raw/Food Pyramid/Food Pyramid_0002.jpg

- Kind: food_pyramid_images
- Format: JPEG (binary)
- Encoding: binary
- Bytes: 7564884
- Document count: 1
- Column count: 0

- Duplicates: none found

### Invalid numbers

- Count: 0

### Suspicious zeros

- Count: 0

- Zero/missing conflation detected: no

### Coverage metrics

These are DIAGNOSTIC HEURISTICS, not canonical coverage. Canonical
quantity parsing and ingredient-line mapping coverage remain unknown
until approved rule sets exist.

- leadingQuantityHeuristic: n/a
- recognizedUnitHeuristic: n/a
- canonicalQuantityParsingCoverage: n/a
- canonicalIngredientLineMappingCoverage: n/a
- Serving/yield coverage: n/a
- Raw/cooked food-state coverage: n/a

### Ingredients

- Unique ingredient terms: 0

### Egyptian-scope evidence

- Fields: none
- Note: image content not OCR'd in this audit pass

### OCR / extraction noise

- Detected: no

### Licensing

- License fields present: no
- Note: no license metadata discoverable without EXIF/OCR

### Encoding / mojibake

- Mojibake detected: no
- file is binary; not evaluated as text

- Structural errors: none

## data/raw/Food Pyramid/Food Pyramid_0003.jpg

- Kind: food_pyramid_images
- Format: JPEG (binary)
- Encoding: binary
- Bytes: 2306779
- Document count: 1
- Column count: 0

- Duplicates: none found

### Invalid numbers

- Count: 0

### Suspicious zeros

- Count: 0

- Zero/missing conflation detected: no

### Coverage metrics

These are DIAGNOSTIC HEURISTICS, not canonical coverage. Canonical
quantity parsing and ingredient-line mapping coverage remain unknown
until approved rule sets exist.

- leadingQuantityHeuristic: n/a
- recognizedUnitHeuristic: n/a
- canonicalQuantityParsingCoverage: n/a
- canonicalIngredientLineMappingCoverage: n/a
- Serving/yield coverage: n/a
- Raw/cooked food-state coverage: n/a

### Ingredients

- Unique ingredient terms: 0

### Egyptian-scope evidence

- Fields: none
- Note: image content not OCR'd in this audit pass

### OCR / extraction noise

- Detected: no

### Licensing

- License fields present: no
- Note: no license metadata discoverable without EXIF/OCR

### Encoding / mojibake

- Mojibake detected: no
- file is binary; not evaluated as text

- Structural errors: none

## data/raw/Food Pyramid/Food Pyramid_0004.jpg

- Kind: food_pyramid_images
- Format: JPEG (binary)
- Encoding: binary
- Bytes: 1853447
- Document count: 1
- Column count: 0

- Duplicates: none found

### Invalid numbers

- Count: 0

### Suspicious zeros

- Count: 0

- Zero/missing conflation detected: no

### Coverage metrics

These are DIAGNOSTIC HEURISTICS, not canonical coverage. Canonical
quantity parsing and ingredient-line mapping coverage remain unknown
until approved rule sets exist.

- leadingQuantityHeuristic: n/a
- recognizedUnitHeuristic: n/a
- canonicalQuantityParsingCoverage: n/a
- canonicalIngredientLineMappingCoverage: n/a
- Serving/yield coverage: n/a
- Raw/cooked food-state coverage: n/a

### Ingredients

- Unique ingredient terms: 0

### Egyptian-scope evidence

- Fields: none
- Note: image content not OCR'd in this audit pass

### OCR / extraction noise

- Detected: no

### Licensing

- License fields present: no
- Note: no license metadata discoverable without EXIF/OCR

### Encoding / mojibake

- Mojibake detected: no
- file is binary; not evaluated as text

- Structural errors: none

## data/raw/Food Pyramid/Food Pyramid_0005.jpg

- Kind: food_pyramid_images
- Format: JPEG (binary)
- Encoding: binary
- Bytes: 2265362
- Document count: 1
- Column count: 0

- Duplicates: none found

### Invalid numbers

- Count: 0

### Suspicious zeros

- Count: 0

- Zero/missing conflation detected: no

### Coverage metrics

These are DIAGNOSTIC HEURISTICS, not canonical coverage. Canonical
quantity parsing and ingredient-line mapping coverage remain unknown
until approved rule sets exist.

- leadingQuantityHeuristic: n/a
- recognizedUnitHeuristic: n/a
- canonicalQuantityParsingCoverage: n/a
- canonicalIngredientLineMappingCoverage: n/a
- Serving/yield coverage: n/a
- Raw/cooked food-state coverage: n/a

### Ingredients

- Unique ingredient terms: 0

### Egyptian-scope evidence

- Fields: none
- Note: image content not OCR'd in this audit pass

### OCR / extraction noise

- Detected: no

### Licensing

- License fields present: no
- Note: no license metadata discoverable without EXIF/OCR

### Encoding / mojibake

- Mojibake detected: no
- file is binary; not evaluated as text

- Structural errors: none

## data/raw/Food Pyramid/Food Pyramid_0006.jpg

- Kind: food_pyramid_images
- Format: JPEG (binary)
- Encoding: binary
- Bytes: 1221905
- Document count: 1
- Column count: 0

- Duplicates: none found

### Invalid numbers

- Count: 0

### Suspicious zeros

- Count: 0

- Zero/missing conflation detected: no

### Coverage metrics

These are DIAGNOSTIC HEURISTICS, not canonical coverage. Canonical
quantity parsing and ingredient-line mapping coverage remain unknown
until approved rule sets exist.

- leadingQuantityHeuristic: n/a
- recognizedUnitHeuristic: n/a
- canonicalQuantityParsingCoverage: n/a
- canonicalIngredientLineMappingCoverage: n/a
- Serving/yield coverage: n/a
- Raw/cooked food-state coverage: n/a

### Ingredients

- Unique ingredient terms: 0

### Egyptian-scope evidence

- Fields: none
- Note: image content not OCR'd in this audit pass

### OCR / extraction noise

- Detected: no

### Licensing

- License fields present: no
- Note: no license metadata discoverable without EXIF/OCR

### Encoding / mojibake

- Mojibake detected: no
- file is binary; not evaluated as text

- Structural errors: none

## data/raw/Food Pyramid/Food Pyramid_0007.jpg

- Kind: food_pyramid_images
- Format: JPEG (binary)
- Encoding: binary
- Bytes: 2385218
- Document count: 1
- Column count: 0

- Duplicates: none found

### Invalid numbers

- Count: 0

### Suspicious zeros

- Count: 0

- Zero/missing conflation detected: no

### Coverage metrics

These are DIAGNOSTIC HEURISTICS, not canonical coverage. Canonical
quantity parsing and ingredient-line mapping coverage remain unknown
until approved rule sets exist.

- leadingQuantityHeuristic: n/a
- recognizedUnitHeuristic: n/a
- canonicalQuantityParsingCoverage: n/a
- canonicalIngredientLineMappingCoverage: n/a
- Serving/yield coverage: n/a
- Raw/cooked food-state coverage: n/a

### Ingredients

- Unique ingredient terms: 0

### Egyptian-scope evidence

- Fields: none
- Note: image content not OCR'd in this audit pass

### OCR / extraction noise

- Detected: no

### Licensing

- License fields present: no
- Note: no license metadata discoverable without EXIF/OCR

### Encoding / mojibake

- Mojibake detected: no
- file is binary; not evaluated as text

- Structural errors: none

## data/raw/Food Pyramid/Food Pyramid_0008.jpg

- Kind: food_pyramid_images
- Format: JPEG (binary)
- Encoding: binary
- Bytes: 1415339
- Document count: 1
- Column count: 0

- Duplicates: none found

### Invalid numbers

- Count: 0

### Suspicious zeros

- Count: 0

- Zero/missing conflation detected: no

### Coverage metrics

These are DIAGNOSTIC HEURISTICS, not canonical coverage. Canonical
quantity parsing and ingredient-line mapping coverage remain unknown
until approved rule sets exist.

- leadingQuantityHeuristic: n/a
- recognizedUnitHeuristic: n/a
- canonicalQuantityParsingCoverage: n/a
- canonicalIngredientLineMappingCoverage: n/a
- Serving/yield coverage: n/a
- Raw/cooked food-state coverage: n/a

### Ingredients

- Unique ingredient terms: 0

### Egyptian-scope evidence

- Fields: none
- Note: image content not OCR'd in this audit pass

### OCR / extraction noise

- Detected: no

### Licensing

- License fields present: no
- Note: no license metadata discoverable without EXIF/OCR

### Encoding / mojibake

- Mojibake detected: no
- file is binary; not evaluated as text

- Structural errors: none

## data/raw/Food Pyramid/Food Pyramid_0009.jpg

- Kind: food_pyramid_images
- Format: JPEG (binary)
- Encoding: binary
- Bytes: 2316674
- Document count: 1
- Column count: 0

- Duplicates: none found

### Invalid numbers

- Count: 0

### Suspicious zeros

- Count: 0

- Zero/missing conflation detected: no

### Coverage metrics

These are DIAGNOSTIC HEURISTICS, not canonical coverage. Canonical
quantity parsing and ingredient-line mapping coverage remain unknown
until approved rule sets exist.

- leadingQuantityHeuristic: n/a
- recognizedUnitHeuristic: n/a
- canonicalQuantityParsingCoverage: n/a
- canonicalIngredientLineMappingCoverage: n/a
- Serving/yield coverage: n/a
- Raw/cooked food-state coverage: n/a

### Ingredients

- Unique ingredient terms: 0

### Egyptian-scope evidence

- Fields: none
- Note: image content not OCR'd in this audit pass

### OCR / extraction noise

- Detected: no

### Licensing

- License fields present: no
- Note: no license metadata discoverable without EXIF/OCR

### Encoding / mojibake

- Mojibake detected: no
- file is binary; not evaluated as text

- Structural errors: none

## data/raw/Food Pyramid/Food Pyramid_0010.jpg

- Kind: food_pyramid_images
- Format: JPEG (binary)
- Encoding: binary
- Bytes: 1172066
- Document count: 1
- Column count: 0

- Duplicates: none found

### Invalid numbers

- Count: 0

### Suspicious zeros

- Count: 0

- Zero/missing conflation detected: no

### Coverage metrics

These are DIAGNOSTIC HEURISTICS, not canonical coverage. Canonical
quantity parsing and ingredient-line mapping coverage remain unknown
until approved rule sets exist.

- leadingQuantityHeuristic: n/a
- recognizedUnitHeuristic: n/a
- canonicalQuantityParsingCoverage: n/a
- canonicalIngredientLineMappingCoverage: n/a
- Serving/yield coverage: n/a
- Raw/cooked food-state coverage: n/a

### Ingredients

- Unique ingredient terms: 0

### Egyptian-scope evidence

- Fields: none
- Note: image content not OCR'd in this audit pass

### OCR / extraction noise

- Detected: no

### Licensing

- License fields present: no
- Note: no license metadata discoverable without EXIF/OCR

### Encoding / mojibake

- Mojibake detected: no
- file is binary; not evaluated as text

- Structural errors: none

## data/raw/Food Pyramid/Food Pyramid_0011.jpg

- Kind: food_pyramid_images
- Format: JPEG (binary)
- Encoding: binary
- Bytes: 2244690
- Document count: 1
- Column count: 0

- Duplicates: none found

### Invalid numbers

- Count: 0

### Suspicious zeros

- Count: 0

- Zero/missing conflation detected: no

### Coverage metrics

These are DIAGNOSTIC HEURISTICS, not canonical coverage. Canonical
quantity parsing and ingredient-line mapping coverage remain unknown
until approved rule sets exist.

- leadingQuantityHeuristic: n/a
- recognizedUnitHeuristic: n/a
- canonicalQuantityParsingCoverage: n/a
- canonicalIngredientLineMappingCoverage: n/a
- Serving/yield coverage: n/a
- Raw/cooked food-state coverage: n/a

### Ingredients

- Unique ingredient terms: 0

### Egyptian-scope evidence

- Fields: none
- Note: image content not OCR'd in this audit pass

### OCR / extraction noise

- Detected: no

### Licensing

- License fields present: no
- Note: no license metadata discoverable without EXIF/OCR

### Encoding / mojibake

- Mojibake detected: no
- file is binary; not evaluated as text

- Structural errors: none

## data/raw/Food Pyramid/Food Pyramid_0012.jpg

- Kind: food_pyramid_images
- Format: JPEG (binary)
- Encoding: binary
- Bytes: 1175566
- Document count: 1
- Column count: 0

- Duplicates: none found

### Invalid numbers

- Count: 0

### Suspicious zeros

- Count: 0

- Zero/missing conflation detected: no

### Coverage metrics

These are DIAGNOSTIC HEURISTICS, not canonical coverage. Canonical
quantity parsing and ingredient-line mapping coverage remain unknown
until approved rule sets exist.

- leadingQuantityHeuristic: n/a
- recognizedUnitHeuristic: n/a
- canonicalQuantityParsingCoverage: n/a
- canonicalIngredientLineMappingCoverage: n/a
- Serving/yield coverage: n/a
- Raw/cooked food-state coverage: n/a

### Ingredients

- Unique ingredient terms: 0

### Egyptian-scope evidence

- Fields: none
- Note: image content not OCR'd in this audit pass

### OCR / extraction noise

- Detected: no

### Licensing

- License fields present: no
- Note: no license metadata discoverable without EXIF/OCR

### Encoding / mojibake

- Mojibake detected: no
- file is binary; not evaluated as text

- Structural errors: none

## data/raw/Food Pyramid/Food Pyramid_0013.jpg

- Kind: food_pyramid_images
- Format: JPEG (binary)
- Encoding: binary
- Bytes: 2382648
- Document count: 1
- Column count: 0

- Duplicates: none found

### Invalid numbers

- Count: 0

### Suspicious zeros

- Count: 0

- Zero/missing conflation detected: no

### Coverage metrics

These are DIAGNOSTIC HEURISTICS, not canonical coverage. Canonical
quantity parsing and ingredient-line mapping coverage remain unknown
until approved rule sets exist.

- leadingQuantityHeuristic: n/a
- recognizedUnitHeuristic: n/a
- canonicalQuantityParsingCoverage: n/a
- canonicalIngredientLineMappingCoverage: n/a
- Serving/yield coverage: n/a
- Raw/cooked food-state coverage: n/a

### Ingredients

- Unique ingredient terms: 0

### Egyptian-scope evidence

- Fields: none
- Note: image content not OCR'd in this audit pass

### OCR / extraction noise

- Detected: no

### Licensing

- License fields present: no
- Note: no license metadata discoverable without EXIF/OCR

### Encoding / mojibake

- Mojibake detected: no
- file is binary; not evaluated as text

- Structural errors: none

## data/raw/Food Pyramid/Food Pyramid_0014.jpg

- Kind: food_pyramid_images
- Format: JPEG (binary)
- Encoding: binary
- Bytes: 1662750
- Document count: 1
- Column count: 0

- Duplicates: none found

### Invalid numbers

- Count: 0

### Suspicious zeros

- Count: 0

- Zero/missing conflation detected: no

### Coverage metrics

These are DIAGNOSTIC HEURISTICS, not canonical coverage. Canonical
quantity parsing and ingredient-line mapping coverage remain unknown
until approved rule sets exist.

- leadingQuantityHeuristic: n/a
- recognizedUnitHeuristic: n/a
- canonicalQuantityParsingCoverage: n/a
- canonicalIngredientLineMappingCoverage: n/a
- Serving/yield coverage: n/a
- Raw/cooked food-state coverage: n/a

### Ingredients

- Unique ingredient terms: 0

### Egyptian-scope evidence

- Fields: none
- Note: image content not OCR'd in this audit pass

### OCR / extraction noise

- Detected: no

### Licensing

- License fields present: no
- Note: no license metadata discoverable without EXIF/OCR

### Encoding / mojibake

- Mojibake detected: no
- file is binary; not evaluated as text

- Structural errors: none

## data/raw/Food Pyramid/Food Pyramid_0015.jpg

- Kind: food_pyramid_images
- Format: JPEG (binary)
- Encoding: binary
- Bytes: 2231246
- Document count: 1
- Column count: 0

- Duplicates: none found

### Invalid numbers

- Count: 0

### Suspicious zeros

- Count: 0

- Zero/missing conflation detected: no

### Coverage metrics

These are DIAGNOSTIC HEURISTICS, not canonical coverage. Canonical
quantity parsing and ingredient-line mapping coverage remain unknown
until approved rule sets exist.

- leadingQuantityHeuristic: n/a
- recognizedUnitHeuristic: n/a
- canonicalQuantityParsingCoverage: n/a
- canonicalIngredientLineMappingCoverage: n/a
- Serving/yield coverage: n/a
- Raw/cooked food-state coverage: n/a

### Ingredients

- Unique ingredient terms: 0

### Egyptian-scope evidence

- Fields: none
- Note: image content not OCR'd in this audit pass

### OCR / extraction noise

- Detected: no

### Licensing

- License fields present: no
- Note: no license metadata discoverable without EXIF/OCR

### Encoding / mojibake

- Mojibake detected: no
- file is binary; not evaluated as text

- Structural errors: none

## data/raw/Food Pyramid/Food Pyramid_0016.jpg

- Kind: food_pyramid_images
- Format: JPEG (binary)
- Encoding: binary
- Bytes: 1776431
- Document count: 1
- Column count: 0

- Duplicates: none found

### Invalid numbers

- Count: 0

### Suspicious zeros

- Count: 0

- Zero/missing conflation detected: no

### Coverage metrics

These are DIAGNOSTIC HEURISTICS, not canonical coverage. Canonical
quantity parsing and ingredient-line mapping coverage remain unknown
until approved rule sets exist.

- leadingQuantityHeuristic: n/a
- recognizedUnitHeuristic: n/a
- canonicalQuantityParsingCoverage: n/a
- canonicalIngredientLineMappingCoverage: n/a
- Serving/yield coverage: n/a
- Raw/cooked food-state coverage: n/a

### Ingredients

- Unique ingredient terms: 0

### Egyptian-scope evidence

- Fields: none
- Note: image content not OCR'd in this audit pass

### OCR / extraction noise

- Detected: no

### Licensing

- License fields present: no
- Note: no license metadata discoverable without EXIF/OCR

### Encoding / mojibake

- Mojibake detected: no
- file is binary; not evaluated as text

- Structural errors: none

## data/raw/Food Pyramid/Food Pyramid_0017.jpg

- Kind: food_pyramid_images
- Format: JPEG (binary)
- Encoding: binary
- Bytes: 2109378
- Document count: 1
- Column count: 0

- Duplicates: none found

### Invalid numbers

- Count: 0

### Suspicious zeros

- Count: 0

- Zero/missing conflation detected: no

### Coverage metrics

These are DIAGNOSTIC HEURISTICS, not canonical coverage. Canonical
quantity parsing and ingredient-line mapping coverage remain unknown
until approved rule sets exist.

- leadingQuantityHeuristic: n/a
- recognizedUnitHeuristic: n/a
- canonicalQuantityParsingCoverage: n/a
- canonicalIngredientLineMappingCoverage: n/a
- Serving/yield coverage: n/a
- Raw/cooked food-state coverage: n/a

### Ingredients

- Unique ingredient terms: 0

### Egyptian-scope evidence

- Fields: none
- Note: image content not OCR'd in this audit pass

### OCR / extraction noise

- Detected: no

### Licensing

- License fields present: no
- Note: no license metadata discoverable without EXIF/OCR

### Encoding / mojibake

- Mojibake detected: no
- file is binary; not evaluated as text

- Structural errors: none

## data/raw/Food Pyramid/Food Pyramid_0018.jpg

- Kind: food_pyramid_images
- Format: JPEG (binary)
- Encoding: binary
- Bytes: 1790700
- Document count: 1
- Column count: 0

- Duplicates: none found

### Invalid numbers

- Count: 0

### Suspicious zeros

- Count: 0

- Zero/missing conflation detected: no

### Coverage metrics

These are DIAGNOSTIC HEURISTICS, not canonical coverage. Canonical
quantity parsing and ingredient-line mapping coverage remain unknown
until approved rule sets exist.

- leadingQuantityHeuristic: n/a
- recognizedUnitHeuristic: n/a
- canonicalQuantityParsingCoverage: n/a
- canonicalIngredientLineMappingCoverage: n/a
- Serving/yield coverage: n/a
- Raw/cooked food-state coverage: n/a

### Ingredients

- Unique ingredient terms: 0

### Egyptian-scope evidence

- Fields: none
- Note: image content not OCR'd in this audit pass

### OCR / extraction noise

- Detected: no

### Licensing

- License fields present: no
- Note: no license metadata discoverable without EXIF/OCR

### Encoding / mojibake

- Mojibake detected: no
- file is binary; not evaluated as text

- Structural errors: none

## Recipe classification (automated candidate/review only; never self-verified)

- candidate=0 needs_review=1468 not_egyptian=0 rejected=0
- Automated logic NEVER emits a verified status. Only a human reviewer may mark a recipe verified_egyptian (documented cultural evidence + reviewer identity/date required).

## Ingredient unique-normalized-term exact-vocabulary match

- Claimed baseline (Step 2 spec): 0.63% (claimed in Step 2 spec; verified against 29/4,633 unique normalized terms)
- Unique-normalized-term exact-vocabulary match: 29/4633 (0.63%)
- This measures exact equality of unique normalized terms against the reference FOOD vocabulary. It is NOT canonical ingredient-line mapping coverage and NOT quantity-parsing coverage (both remain unknown until approved rule sets exist).
- Unique normalized terms: 4633

## Structural errors

- None across all sources (all required inputs present and structurally valid).

## Raw input provenance (SHA-256)

- data/raw/Egyptian_Food_Categorized.csv: sha256=d6487c76c7643c1d87abd1efa3f1f208a533268030ca81ca21875354c82d1c74 bytes=70146
- data/raw/Food Pyramid/Food Pyramid_0001.jpg: sha256=d0ee0c64e9deb73bcce256bca6d637060146eebf62f38047110b0d58c86a69a0 bytes=8860756
- data/raw/Food Pyramid/Food Pyramid_0002.jpg: sha256=888286fced29f78a45163174db2ed1943e57b283c6f1850dfd016d3c2b60d58a bytes=7564884
- data/raw/Food Pyramid/Food Pyramid_0003.jpg: sha256=14188c69b7a68b388325844cbffde267f686bffe59bf4efb8ed3f2205c24a85d bytes=2306779
- data/raw/Food Pyramid/Food Pyramid_0004.jpg: sha256=db6b34f086cc3522ebe03ef2d7415b4dfb5b9877ca538c2f443925a462bbad7f bytes=1853447
- data/raw/Food Pyramid/Food Pyramid_0005.jpg: sha256=c94760d27b51fb2251428b84aa44e903a09195bc4f53401f8574a31ee6e25a4c bytes=2265362
- data/raw/Food Pyramid/Food Pyramid_0006.jpg: sha256=2189a61f58537b560829923048c3193c72c88608b634107d65192579729333ea bytes=1221905
- data/raw/Food Pyramid/Food Pyramid_0007.jpg: sha256=d2c7e490efe508f2c9c6f049a37bf0a6f44c5550123d99b409efe6d4326d5f54 bytes=2385218
- data/raw/Food Pyramid/Food Pyramid_0008.jpg: sha256=58efde10a478d7f218d19e432df97613726c824faecbbe4a9737cb870fde65cd bytes=1415339
- data/raw/Food Pyramid/Food Pyramid_0009.jpg: sha256=49b738a2af0b89575ea86a5d3e5785f14f81a56f9c1424c9b7047e3cc45621c5 bytes=2316674
- data/raw/Food Pyramid/Food Pyramid_0010.jpg: sha256=14ca4d6da74b496992044a97fb215bb387f361b39111ff38ebacb09f0ab51c69 bytes=1172066
- data/raw/Food Pyramid/Food Pyramid_0011.jpg: sha256=a51ec8001875997dac9497025d9d8383961234fae94c5460e998f7753192e5bf bytes=2244690
- data/raw/Food Pyramid/Food Pyramid_0012.jpg: sha256=47ebfe4abf2812fea04156d2ea0fee3388d4e143d48e667ae58f8f2e07e1a08c bytes=1175566
- data/raw/Food Pyramid/Food Pyramid_0013.jpg: sha256=fa40dd87724c05d43308a95d3b4e27b4e5eae4265723311376f6fdd46160bb01 bytes=2382648
- data/raw/Food Pyramid/Food Pyramid_0014.jpg: sha256=de6a4cc0b1b826c0934c520624eaf70292ac7819a7da6ede20b3308945d900a5 bytes=1662750
- data/raw/Food Pyramid/Food Pyramid_0015.jpg: sha256=ceed337adcf509b1b02d4e785332a6538f3a971d9ed5a27445e214898364f5da bytes=2231246
- data/raw/Food Pyramid/Food Pyramid_0016.jpg: sha256=ae5e4686c641904a264a360b177b1180830e5dd41983274122e22488996935e5 bytes=1776431
- data/raw/Food Pyramid/Food Pyramid_0017.jpg: sha256=40bc2704330559ef3afc636dc39ca954267cedc6341b057d868d57bc6584ff78 bytes=2109378
- data/raw/Food Pyramid/Food Pyramid_0018.jpg: sha256=97385a6e1bce595da391592ef5ddde8f1032382a2b5c3b6fd538e089eb03e6c6 bytes=1790700
- data/raw/food_pyramid.json: sha256=6ac257c8bee3dde47bb60b7d317730196cf372d6bf2e3573033628dc7afcd190 bytes=5580
- data/raw/Recipes For Eqyption Food.csv: sha256=e0f8252df4fcbed5f28100d61871a13f0f8cfb55f37b59412a95b006265c7ec3 bytes=2940806
- data/raw/WHO Guidelines.pdf: sha256=10fc2c386dbe1b208b9dc056d52c65c7902f78e38a3fdaa38ab13b3134f2d991 bytes=5100286

> This is a deterministic, read-only audit. Raw files under data/raw were not modified.