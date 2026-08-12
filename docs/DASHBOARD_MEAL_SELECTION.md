# Dashboard meal selection (contract v4)

This repository implements the AI-side Step 16 meal-option and confirmation
flow against an isolated, deterministic dashboard mock. It does **not** contain
a real dashboard HTTP client and performs no dashboard/backend network call.

## Implemented boundary

- `search_recipes_by_meal_category` returns at most three recipes whose source
  status is exactly `verified`; `needs_review` and rejected records never pass.
- A total multi-category ceiling is split equally in canonical order
  breakfast → lunch → dinner. Whole-kcal remainders go to the last requested
  category in that order. A per-meal ceiling is applied unchanged to each
  requested category.
- Displayed candidates and resolved selections stay in bounded, process-local
  server state (at most 1,000 selection sessions by default). The client
  receives opaque UUID references, not a writable nutrition snapshot.
- The confirmation summary creates and freezes one `pending_operation_id`.
  `confirm_and_log_meal_selection` accepts only that ID and reconstructs the
  dashboard payload from the frozen server-side snapshot.
- Pending IDs move through `ACTIVE`, `APPLIED`, and `INVALID`. Only `ACTIVE`
  and `APPLIED` reach the mock. An `APPLIED` resend reaches the mock with the
  same idempotency key and returns `already_logged`; an `INVALID` ID is rejected
  before a mock call.
- `ACTIVE` operations expire after 600 seconds. State is in memory and does not
  survive a process restart.
- Every mock invocation emits `[MOCK DASHBOARD CALL]`. Outcomes are injected
  deterministically; no randomness or real network fallback exists.

## Graduation recipeSource

The checked-in unified dataset is the project-approved `recipeSource` for the
graduation runtime. It contains 215 `verified` recipes and is backed by the
approved manifest record `graduation-unified-egyptian-recipes-v2`. The RAG
documents and Step 16 repository therefore expose these recipes as verified
within the graduation-project scope.

Source category `breakfast` maps to Step 16 breakfast. `main_dish`, `soup`,
`salad`, and `appetizer` map to lunch and dinner. Search remains bounded to
three results per category, preserves calorie and ingredient exclusions, and
never pads a short or empty result set.

## Production blockers

Real integration remains unimplemented and must stay blocked until the backend,
product, and privacy/legal owners provide documented decisions for:

- user and service-to-service authentication linkage;
- consent, purpose, access, retention, deletion, and opt-out;
- server-side validation of `nutrition_snapshot`;
- real batch atomicity and concurrency behavior;
- negative/insufficient calorie policy;
- timestamp and timezone semantics;
- correction, reversal, and audit trails;
- final API schema, versioning, and error semantics.

The mock makes no silent assumptions about those production decisions.

## Write-path audit

The pre-Step-16 suggestion route is read-only: it has no dashboard client and
cannot log a meal. The only dashboard-call site is
`confirm_and_log_meal_selection`. A source comment records that the legacy
route must never gain a write path; any future logging intent must use the Step
16 confirmation and idempotency machinery.
