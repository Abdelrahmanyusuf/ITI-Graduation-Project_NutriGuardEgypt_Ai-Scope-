# Multi-option meal-plan selection with mock and HTTP dashboard integrations

> **Status: the deterministic local mock remains the default for tests. An
> opt-in HTTP client now sends confirmed meals to
> `POST /api/Tracking/custom-meals`.**
>
> **Numbering note.** The task that produced this document calls itself "Step 16".
> That collides with the original roadmap's Step 16 (adversarial evaluation, see
> [`STEPS_16_20.md`](./STEPS_16_20.md)). They are different pieces of work. This
> document only describes the meal-plan selection and dashboard-logging feature.

## What is real and what is not

| Thing | State |
| --- | --- |
| Candidate search, selection, confirmation, and logging flow | Implemented and tested |
| `DashboardClient` port | Implemented |
| `MockDashboardClient` (deterministic, local, no network) | Implemented and tested |
| Real HTTP dashboard client | Implemented; opt-in through `NUTRIGUARD_DASHBOARD_BASE_URL` |
| Production readiness of this feature | Requires a valid backend bearer-token flow and backend policy decisions |

Every mock call emits `[MOCK DASHBOARD CALL]` on the injected logger. When the
HTTP client is configured, confirmation sends one backend-compatible custom-meal
DTO per confirmed recipe instead of emitting the mock marker.

## Files

| File | Role |
| --- | --- |
| `src/services/dashboard/dashboard-client.ts` | The wire contract and the `DashboardClient` port. No I/O. |
| `src/services/dashboard/mock-dashboard-client.ts` | Deterministic local mock. Scenario-driven, no randomness. |
| `src/services/dashboard/http-dashboard-client.ts` | Opt-in HTTP client for `POST /api/Tracking/custom-meals`. |
| `src/services/dashboard/pending-meal-operations.ts` | Server-side in-memory frozen-snapshot table plus the TTL constant. |
| `src/tools/meal-selection-tools.ts` | `search_recipes_by_meal_category` and `confirm_and_log_meal_selection`. |
| `src/runtime/meal-plan-selection.ts` | The conversational flow: request, selection, summary, confirmation. |
| `src/runtime/graduation-demo-agent.ts` | Composition, session-memory field, router placement. |
| `src/server/http-app.ts` | API-boundary validation for the new context variant. |
| `tests/dashboard-mock-client.test.ts` | Mock, pending store, and tool behaviour. |
| `tests/meal-plan-selection.test.ts` | End-to-end conversational behaviour. |

## Flow

1. **Request.** The user asks for one or more of `breakfast`, `lunch`, `dinner`,
   `snacks`, optionally with a calorie ceiling and optionally with exclusions.
2. **Candidates.** `search_recipes_by_meal_category` is called once per category
   and returns up to three options, each with the full four-macro snapshot
   (sodium is added only when the user asked about it). It reports the real number
   of verified matches and never pads the list.
3. **Selection.** The user picks with natural language referring to the shown
   list. Resolution reuses the existing short-term session memory from the BUG-09
   fix (`NutritionConversationMemory.mealSelection`), not a second mechanism.
4. **Summary.** All picks are shown with their nutrition and the resulting total.
   A `pending_operation_id` (uuid) is generated **at this moment** and stored
   server-side together with a frozen snapshot of exactly what was displayed.
5. **Confirmation.** Only an unambiguous positive confirmation in a later turn
   reaches `confirm_and_log_meal_selection(pending_operation_id)`, which rebuilds
   the payload from the frozen snapshot and uses the id as the idempotency key.

### Deliberate design decisions

- **`confirm_and_log_meal_selection` takes only `pending_operation_id`.** The
  older `selections[]` signature made it structurally possible to submit values
  other than the ones the user confirmed. Nothing supplied at confirmation time
  is used to build the payload.
- **Nutrition is recalculated, never transported.** The conversation context
  carries recipe ids and option indexes only. Every number shown at every stage is
  recomputed from the dataset, so the candidate list, the summary, and the
  post-log confirmation cannot disagree, and a tampered client payload cannot
  inject a value.
- **A recipe whose four-macro snapshot cannot be fully calculated is not a
  candidate.** It is excluded rather than zero-filled, so `verifiedMatchCount`
  means "verified, matching, and fully calculable".
- **The exclusion disclaimer is the existing implementation**
  (`exclusionSafetyNote`), injected into the flow. There is no second copy.
- **Formatter rewording is disabled for this intent.** The wording carries the
  confirmation contract (the operation id, "nothing is logged yet", the mock
  notice), so no model may rephrase it.

### Confirmation semantics

| Message while a summary is pending | Result |
| --- | --- |
| `تأكيد`, `أيوه أكد`, `موافق`, `confirm` | Confirmed. The tool is called. |
| `تمام بس غير الغدا` | **Modification.** The pending operation is invalidated. Nothing is written. |
| `تمام` alone | **Ambiguous.** The user is asked to confirm explicitly. Nothing is written. |
| An unrelated nutrition question | Neither confirmation nor rejection. The pending operation stays active until its TTL. |
| `الغي` | Cancelled. The pending operation is invalidated. |
| A confirmation after a change, after expiry, after resolution, or with no operation | `confirmation_expired`, stated explicitly. |

`PENDING_MEAL_CONFIRMATION_TTL_SECONDS = 600` (10 minutes) is a specified
default, not an implementer's choice, and is asserted in the tests.

### Calorie ceiling distribution

| Wording | Mode | Behaviour |
| --- | --- | --- |
| One ceiling, two or more categories (`تحت سقف 1800 سعرة`) | `total` | The ceiling is **not** passed to the per-category search. It is enforced once, on the summed selection, at summary time. Over budget means no `pending_operation_id` is created and the user is told by how much. |
| Per-meal wording (`كل وجبة متتخطاش 600 سعرة`) | `per_meal` | The ceiling is passed to every category search. |
| One ceiling, exactly one category (`عايز غدا 600 سعرة`) | `per_meal` | With a single meal the two modes coincide; passing it to the search is the useful behaviour. |
| No ceiling | `none` | — |

The summary always states which mode was applied
(`سقف لكل الخطة` / `سقف لكل وجبة على حدة`). Total mode deliberately avoids
inventing a per-category split such as 25/40/35 percent.

### Category mapping

| Meal category | Dataset categories |
| --- | --- |
| `breakfast` | `breakfast`, `bread` |
| `lunch` | `main_dish` |
| `dinner` | `main_dish`, `soup`, `salad` |
| `snacks` | `appetizer`, `pickle`, `beverage`, `dessert` |

`breakfast`/`lunch`/`dinner` reuse the mapping the existing day planner already
applies. `snacks` is new; `salad` is left out of it because it already belongs to
`dinner`. Ordering is deterministic: closest-below-the-ceiling for the three main
meals, lightest-first for snacks, `recipe_id` as the final tie-break.

**Snack sets.** For `snacks` only, and only when a ceiling is known, the last of
the three option slots may bundle the two lightest verified snacks as one
explicitly labelled set ("الاتنين مع بعض"). Both items are real verified recipes
already shown as single options, so nothing is fabricated, the number of distinct
recipes shown stays within three, and the set goes through exactly the same
explicit selection and confirmation as any other option. A snack is never
auto-added.

### Router placement

The flow is entered from two points in `invokeCore`:

- **Before** generic conversational handling, for turns that answer an
  already-displayed list or summary, so a confirmation cannot be swallowed as a
  bare acknowledgement.
- **After** the medical-safety gate, for a fresh request, so a safety-routed
  message can never be answered with a meal plan.

The entry gate is deliberately narrow. A meal category must be named **and** one
of: two or more categories, the snacks category, explicit options wording, or a
calorie ceiling on a bare category with no "وجبة"/"meal" noun. That last clause is
what keeps `عاوز وجبة إفطار 500 سعر` on its existing single-meal route.
`tests/meal-plan-selection.test.ts` asserts this boundary for six previously
supported phrasings.

Known and accepted limitation: text normalization folds `غدًا` (tomorrow) onto
`غدا` (lunch). Because the gate also requires a multi-option cue, a message such
as `ما حالة الطقس غدًا؟` cannot enter the flow; a test pins this.

## Idempotency

The mock tracks, per `idempotency_key`, not just "have I seen this key" but "did
the previous call for this key actually apply the write":

- previous call **applied** → every later call returns
  `applied: false, reason: "already_logged"` with the same
  `daily_calories_remaining`. This holds even when the test scenario scripted
  nothing for the second call. This is the **only** correct use of
  `already_logged`.
- previous call **did not apply** (an error, or a structural-guard rejection) →
  the next call re-attempts. It never claims `already_logged`, because nothing was
  logged.

`confirm_and_log_meal_selection` retries at most once
(`MEAL_SELECTION_MAX_SEND_ATTEMPTS = 2`) on a thrown transport error or a
retryable status (`server_error`, `rate_limited`), always with the same key. A
dashboard error leaves the pending operation active so the user's own retry also
reuses that key. One confirmed batch therefore never produces two distinct
idempotency keys.

### Not simulated

A call that fails **after** the write was already committed — a timeout arriving
once the backend had applied it — leaves a client unable to tell whether the
effect happened. This mock is deterministic and local, so that state cannot arise
here, and it is not simulated. It is a **real unresolved question for the eventual
backend**, already recorded as item 7 of
`NutriGuard_Open_Questions_Backend_Privacy.md`. No resolution is invented here.

### In-memory limitation (not crash-safe)

The pending-operation table and the mock's per-key idempotency table live in
process memory. The guarantees above hold **only within one running process**. A
crash or restart between showing the summary and a later confirmation or retry
loses that state; a confirmation arriving afterwards is answered with
`confirmation_expired`. **This is not crash-safe across restarts.** Persisting the
state durably is deliberately out of scope for this step and would expand it.

## Blockers and out-of-scope items

### HTTP integration requirements

Set `NUTRIGUARD_DASHBOARD_BASE_URL` and a valid
`NUTRIGUARD_DASHBOARD_TOKEN`. The client sends the backend DTO fields documented
by Swagger (`name`, `mealType`, `date`, `servings`, `energyKcal`, `proteinG`,
`carbohydrateG`, `fatG`, `source`, and `externalReferenceId`). Without the URL,
the deterministic mock remains active.

### Explicitly out of scope, not assumed away

Every item in `NutriGuard_Open_Questions_Backend_Privacy.md` remains open and
needs a decision from the backend team and from whoever owns privacy/legal. None
of them is answered by anything in this feature:

1. **Privacy, consent, retention.** This feature stores a durable per-user
   consumption record, which contradicts the project's "do not store health data
   by default" rule. Opt-in, stated purpose, retention period, who else can read
   it, and user edit/delete/stop-tracking rights are all undecided.
2. **Server-side `nutrition_snapshot` validation.** Whether the backend trusts,
   re-validates, or re-derives the numbers the AI sends is undecided. The mock
   accepts them; that is a mock convenience, not a recommendation.
3. **Batch atomicity for the real backend.** All-or-nothing versus partial
   success, how a partial success is represented, and how a half-applied batch is
   replayed are undecided.
4. **Balance policy.** Whether a user may exceed the daily budget, what a negative
   balance means, and how two concurrent writes to the same day are reconciled are
   undecided.
5. **Timestamp and timezone semantics.** Who owns the clock, whether the value
   means eating time or logging time, how the user's timezone is determined, and
   whether back-dating is allowed are undecided. The mock sends submission time
   because the contract says so, not because the question is settled.
6. **Correction, reversal, audit trail.** Deleting a wrong entry, editing a logged
   meal, undoing a deduction, and auditing any of it do not exist.
7. **Additional real-API responses**, including the ambiguous
   applied-then-timed-out case above and `duplicate_recipe` when the same recipe
   appears twice in one batch. This feature neither blocks nor resolves the
   duplicate case: a user may legitimately pick the same dish for two categories.

## Verification

```
npm run type-check
npm run lint
npm test
npm run build
npm run docs:check
```
