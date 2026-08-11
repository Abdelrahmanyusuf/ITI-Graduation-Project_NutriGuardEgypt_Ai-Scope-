# Graduation Agent Bug-Fix Report

Status: implemented and regression-tested for the graduation demo runtime.

This report records the remediation of the ten behavior gaps reported during Arabic exploratory testing. It does not convert candidate data into medically or production-approved data.

The conversational boundary was also strengthened in prompt/runtime version `1.3.0`. Every valid message now receives one of four deliberate outcomes: a grounded answer inside NutriGuard's responsibilities, one focused clarification, a safety refusal, or a friendly redirect to Egyptian-food nutrition. Greetings, acknowledgements, capability questions, and vague hunger requests receive natural Arabic/English responses. Unrelated questions are not answered from general model knowledge.

| Bug | Resolution | Fail-closed boundary |
| --- | --- | --- |
| BUG-01 calorie-target meals | One-meal targets return the closest measured serving; daily targets return a deterministic three-meal example with the exact total and difference from target. | The Agent reports `no_result` when recorded meals cannot satisfy the rules. |
| BUG-02 food state | Ingredient calculations disclose `raw`, `cooked`, or unknown state in both structured output and user-facing wording. | Unknown state is never assumed. |
| BUG-03 ingredient exclusion | Common Arabic/English forms (`بدون`, `خالية من`, `من دون`, `شيل`, `احذف`, `بلاش`, `ما تحطش`, `without`, and `-free`) remove every matched recorded ingredient from a cloned recipe and recalculate nutrition. “Less oil” remains a reduction rather than a zero-oil claim. | An unresolved ingredient produces an explicit failure; the original recipe is never presented as modified. Recipe titles that already contain “بدون” cannot override a later user instruction. |
| BUG-04 health wording | Recipe health questions receive a numeric per-serving context rather than an absolute healthy/unhealthy claim. | Missing saturated fat remains `null`, not zero. |
| BUG-05 guideline contradiction | WHO sodium guidance is kept general and cannot classify a recipe without reading that recipe's numeric value on a shared basis. | Guideline retrieval cannot invent a claim about Ful or another recipe. |
| BUG-06 Arabic spelling | Repeated Arabic long-vowel typing such as `فووول` is normalized without corrupting meaningful prefixes such as `للكشري`. | Unresolved dishes still return no result. |
| BUG-07 failure reasons | Out-of-scope requests and recipes missing from the candidate dataset have distinct machine-readable reason codes. | No unrelated recipe is substituted. |
| BUG-08 personal calorie need | Requests to calculate a person's daily requirement receive a specific unsupported response. | The Agent does not infer TDEE/BMR or ask for ingredient weights. |
| BUG-09 short-term memory | The browser sends bounded structured context: active recipe, calorie target, or meal-plan rules. Pronoun follow-ups can compare, assess, or lighten the active recipe. | Raw chat history is not stored; a new chat reload clears context; IDs and array sizes are validated at the API boundary. |
| BUG-10 user-rule meal planning | General meal examples apply calorie targets and recorded ingredient exclusions, including a dairy group. Follow-up changes retain the same rules. | The Agent explicitly states that ingredient filtering is not an allergy or cross-contamination guarantee. Personalized/medical plans remain refused. |

## Verification coverage

`tests/graduation-bug-log.test.ts` covers all ten bugs, including exclusion-language variants, multi-ingredient removal, every recipe containing a recorded added-fat ingredient, multi-turn context, and a clean-session isolation case. `tests/graduation-conversation-scope.test.ts` covers greetings, thanks, capability questions, vague food requests, Arabic/English out-of-scope redirects, punctuation, emoji, HTML-like input, prompt injection, emergencies, and preservation of the core deterministic routes. The existing wide suite additionally covers every Arabic and English name in all 215 candidate recipes, structured nutrition for all recipes, lighter-modification fail-closed behavior across the full corpus, 50 comparisons, 80 RAG questions, safety routing, and deterministic repeated responses.

Final local verification: 474 tests discovered, 473 passed, 0 failed, and 1 live-PostgreSQL integration test skipped because no live `DATABASE_URL` was supplied. Type-check, lint, production build, documentation links, diff whitespace, and the tracked-file secret scan all pass.

`tests/http-app.test.ts` validates accepted recipe-reference and meal-plan contexts plus rejection of forged recipe IDs and oversized exclusion lists. Live HTTP smoke testing verifies a 500-kcal dairy-excluded breakfast followed by “هل هي صحية؟” resolves to the same recipe.

## Safety wording

- All nutrition values remain graduation-demo estimates sourced from the candidate dataset.
- Missing values remain unknown (`null`), never zero.
- A user-supplied calorie target can be used for a general example; the Agent does not calculate a person's requirement.
- Ingredient exclusion is deterministic filtering over recorded ingredients, not an allergen guarantee.
- Diagnosis, treatment, medication, emergencies, pregnancy personalization, and personal weight-loss prescriptions remain on the medical-safety route.
