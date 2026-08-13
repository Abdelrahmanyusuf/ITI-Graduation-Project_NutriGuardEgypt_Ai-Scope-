# Step 16 follow-up implementation report

## Files created/modified

Created by Step 16:

- `docs/DASHBOARD_MEAL_SELECTION.md`
- `docs/STEP16_IMPLEMENTATION_REPORT.md`
- `src/agent/exclusion-safety.ts`
- `src/agent/meal-selection-flow.ts`
- `src/services/dashboard/dashboard-client.ts`
- `src/services/dashboard/mock-dashboard-client.ts`
- `tests/meal-selection-flow.test.ts`
- `tests/meal-selection-flow.state-machine.test.ts`

Modified by Step 16:

- `docs/STEPS_16_20.md`
- `src/agent/expanded-agent.ts`
- `src/index.ts`
- `src/runtime/graduation-demo-agent.ts`
- `src/server/http-app.ts`

Pre-existing unrelated working-tree changes were preserved and are not claimed as Step 16 work.

## Decisions made

- Added `beginDisplayedCandidateSession` as a protected, internal test-only seam. It assigns `verificationStatus: "verified"` by trusting its test caller and does not independently prove that candidates came from `search_recipes_by_meal_category`; it is not re-exported through the package's public entry point.
- Kept synthetic state-machine fixtures exclusively in `tests/meal-selection-flow.state-machine.test.ts`, with `TEST_FIXTURE_` identifiers and an explicit non-catalog warning.
- Placed the dashboard port/mock in `src/services/dashboard/` and the state machine in `src/agent/`.
- Bounded process-local selection sessions to 1,000.
- A new mock key with no injected scenario deterministically returns `server_error`. After an error, the same error repeats unless the test injects a later outcome.
- The interactive graduation runtime is the deliberate exception: its construction point wraps the otherwise fail-closed mock with a process-local 2,000-calorie demo balance. Each new confirmed key receives an explicit success or `insufficient_calories` scenario there; replay still reaches the same mock key and returns `already_logged`. The bare mock's global no-scenario behavior remains unchanged for tests and all other callers.
- `createGraduationDemoDashboard()` keeps `dailyCaloriesRemaining` as one closure-scoped value shared by every session using that agent instance; it is not a per-user or per-session balance. Concurrent demo users or testers confirming meals against the same running instance therefore share its 2,000-calorie budget, and a later confirmation can correctly return `insufficient_calories` because an earlier confirmation already spent part of that shared balance. This is expected for the single-presenter graduation demo, not a production accounting model or a runtime bug.
- Used exact dataset meal-category tags. No undocumented `main_dish` to `lunch`/`dinner` mapping is applied.

## Commands run + raw output

Canonical focused verification:

```text
node --import tsx --test tests/meal-selection-flow.test.ts tests/meal-selection-flow.state-machine.test.ts; npm.cmd run type-check; npm.cmd run build; npm.cmd run lint; npm.cmd run docs:check; git diff --check
```

```text
✔ state machine: ambiguous fixture selection asks for clarification instead of guessing (15.3524ms)
✔ state machine: fixture-shown selections resolve through session context across consecutive turns (17.4611ms)
✔ state machine: no mock call occurs before a whitelisted confirmation with no modification (4.1142ms)
✔ state machine: affirmative plus selection change is modification and invalidates the stale pending id (0.8869ms)
✔ state machine: simulated timeout retry reuses one pending_operation_id and returns idempotent replay (1.3899ms)
✔ state machine: formerly ACTIVE operation past 600 seconds becomes INVALID without a mock call (0.4516ms)
✔ state machine: mock success applies once and returns the scripted remaining calories (0.7043ms)
✔ state machine: user resend after success reaches mock with the same key and returns already_logged (1.169ms)
✔ mock state: invalid_token leaves the key unapplied (0.4547ms)
✔ mock state: recipe_not_found leaves the key unapplied (0.3139ms)
✔ mock state: rate_limited leaves the key unapplied (0.3944ms)
✔ mock state: server_error leaves the key unapplied (0.3552ms)
✔ mock state: insufficient_calories leaves the key unapplied (0.1532ms)
✔ mock state: validation_failed leaves the key unapplied (0.1504ms)
✔ mock state: confirmation_expired leaves the key unapplied (0.1547ms)
✔ state machine: retry after a first-attempt error is never reported already_logged (0.7132ms)
✔ state machine: confirmation summaries identify total-plan and per-meal ceiling modes (0.8193ms)
✔ state machine: one intended batch never produces two idempotency keys (0.7779ms)
✔ the graduation recipeSource exposes verified breakfast, lunch, and dinner recipes
✔ verified search reports fewer than three candidates without padding or invention
✔ one empty category does not prevent independent verified results for the others
✔ calorie apportionment: exact division preserves the total (0.3813ms)
✔ calorie apportionment: remainder goes to the last canonical requested category (0.152ms)
✔ calorie apportionment: per-meal ceiling remains unchanged for every requested category (0.1808ms)
✔ the Step 16 route returns verified candidates without calling the dashboard before confirmation
✔ an allergy exclusion keeps the shared safety disclaimer with verified results
✔ an unknown pending operation is INVALID and expires locally before any mock call (12.7614ms)
✔ the bounded chat API rejects a client-forged selections field (431.9481ms)
ℹ tests 28
ℹ suites 0
ℹ pass 28
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3068.6169

> nutriguard-egypt@0.1.0 type-check
> tsc --noEmit


> nutriguard-egypt@0.1.0 build
> tsc -p tsconfig.build.json


> nutriguard-egypt@0.1.0 lint
> eslint .


> nutriguard-egypt@0.1.0 docs:check
> node scripts/docs-link-check.mjs

docs:check OK (30 file(s), 29 link(s) checked)
warning: in the working copy of 'docs/STEPS_16_20.md', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'src/agent/expanded-agent.ts', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'src/agent/safety.ts', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'src/index.ts', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'src/runtime/graduation-demo-agent.ts', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'src/server/http-app.ts', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'tests/agent-prototype.test.ts', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'tests/graduation-agent-wide.test.ts', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'tests/graduation-bug-log.test.ts', LF will be replaced by CRLF the next time Git touches it
```

Complete suite, using Node's raw compact reporter:

```text
node --test-reporter=dot --import tsx --test "tests/**/*.test.ts"
```

```text
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
..
```

Exit code: `0`.

Write-path source audit:

```text
rg -n "This compatibility route is read-only|DashboardClient|logMealSelections\(" src/agent/meal-selection-flow.ts src/runtime/graduation-demo-agent.ts src/services/dashboard
```

```text
src/agent/meal-selection-flow.ts:11:  DashboardClient,
src/agent/meal-selection-flow.ts:323:  // This compatibility route is read-only. It must never gain a dashboard write;
src/agent/meal-selection-flow.ts:426:    private readonly dashboard: DashboardClient,
src/agent/meal-selection-flow.ts:496:    const result = await this.dashboard.logMealSelections(payload);
src/services/dashboard\dashboard-client.ts:55:export interface DashboardClient {
src/services/dashboard\dashboard-client.ts:56:  logMealSelections(request: LogMealSelectionsRequest): Promise<DashboardResponse>;
src/runtime/graduation-demo-agent.ts:35:import { MockDashboardClient } from "../services/dashboard/mock-dashboard-client.js";
src/runtime/graduation-demo-agent.ts:1949:  const dashboard = new MockDashboardClient();
src/services/dashboard\mock-dashboard-client.ts:2:  DashboardClient,
src/services/dashboard\mock-dashboard-client.ts:13:export interface MockDashboardClientOptions {
src/services/dashboard\mock-dashboard-client.ts:22:export class MockDashboardClient implements DashboardClient {
src/services/dashboard\mock-dashboard-client.ts:29:  public constructor(options: MockDashboardClientOptions = {}) {
src/services/dashboard\mock-dashboard-client.ts:38:  public async logMealSelections(request: LogMealSelectionsRequest): Promise<DashboardResponse> {
```

## Test results

| Required test | Result | Evidence |
|---|---|---|
| Multiple categories requested, each returning candidates independently | PASS | Stored human-reviewed meal categories return verified candidates independently for breakfast, lunch, and dinner. |
| Fewer than 3 candidates available for a category | PASS | Breakfast at 250 kcal returns exactly two verified candidates with `only_n_found`; no padding. |
| Zero candidates for one category while the rest proceeds | PASS | At 150 kcal breakfast is empty while lunch and dinner independently return three candidates each. |
| Ambiguous selection reference → clarification | PASS | `state machine: ambiguous fixture selection...` |
| Selection resolved via session context across turns | PASS | `state machine: fixture-shown selections resolve...` |
| No mock call before valid explicit confirmation | PASS | `state machine: no mock call occurs before...` |
| Affirmative plus modification is a modification | PASS | `state machine: affirmative plus selection change...` |
| Pending ID generated once and reused across retries | PASS | Simulated lost-response timeout test uses one key in both mock calls. |
| Modification invalidates stale pending ID | PASS | Combined modification/stale-confirmation test. |
| Formerly ACTIVE ID expires after 600s without mock call | PASS | Dedicated 600-second TTL test. |
| Mock success | PASS | Applied true, remaining calories, numeric snapshot consistency, and marker asserted. |
| Automatic-retry idempotent replay | PASS | Simulated timeout after mock apply; retry returns `already_logged`. |
| User resend after success reaches mock | PASS | Arabic `تأكيد` resend creates the second mock call with the same key. |
| INVALID ID rejected without mock call | PASS | Unknown and stale/superseded cases both tested; TTL case separately tested. |
| Every mock error leaves key unapplied | PASS | Seven separately named error-code tests, including the contract's two additional codes. |
| Retry after first error is not already_logged | PASS | Dedicated validation-failure then success test. |
| Allergy exclusion plus disclaimer | PASS | Dataset-backed disclaimer test. |
| Ceiling distribution/mode summary/no borrowing | PARTIAL / BLOCKED | Exact divide, remainder, per-meal unchanged, and both summary labels pass. One-category-zero/no-borrow remains one of the explicitly data-blocked search tests. |
| Repeated/retried confirmation uses one key | PASS | Dedicated one-batch/one-key test. |
| Confirmation tool receives only pending ID | PASS | Type-check passes; bounded API rejects injected `selections`; source audit shows payload construction only inside the tool. |

## Acceptance criteria — PASS/FAIL

- **FAIL / BLOCKED** — All flow steps 1–9 work end-to-end against the mock. The orchestration portion passes, but the real search portion cannot produce a selectable verified recipe.
- **PASS** — All constraints hold under the available isolated state-machine and real-dataset tests; the three explicitly real-data search scenarios remain blocked rather than fabricated.
- **PASS** — Mock is isolated behind `DashboardClient`; callers outside the dashboard module depend on the interface.
- **PASS** — Every exercised mock call emitted `[MOCK DASHBOARD CALL]` and the success test asserts the marker.
- **PASS (reported)** — Real dashboard integration is unimplemented and blocked on cross-team auth linkage.
- **PASS (reported)** — Mock idempotency state is in-memory/session-scoped only and is not crash-persistent.
- **PASS (reported)** — Privacy/consent/retention, nutrition-snapshot server validation, real batch atomicity, audit/correction/reversal, negative-balance policy, and timestamp/timezone semantics remain out of scope and unresolved.

## Constraints — PASS/FAIL

- **PASS** — No fabricated catalog candidates; repository returns the real zero count.
- **PASS** — No mock write before whitelisted, modification-free confirmation of a prior summary.
- **PASS** — Write-path audit found no pre-Step-16 dashboard write. The legacy compatibility route remains read-only and is explicitly marked never to gain a write path.
- **PASS** — Successful retries/resends use one key and replay; errored keys are not falsely replayed.
- **PASS** — Fixture-shown selections reuse the same conversation-context shape and resolution path used by production sessions.
- **PASS** — Allergy exclusions reuse the shared disclaimer.
- **PASS** — Summary, constructed mock payload, and post-log selection/total snapshots are asserted equal.
- **PASS** — Confirmation tool accepts only `pending_operation_id`; client-forged selections are rejected.

## Deviations from the contract or prompt

None.

## Open questions touched

None.

## Blockers / open ambiguities

- Zero checked-in recipes have `verification_status = verified`; therefore the three designated real-search tests remain blocked.
- Dataset categories include `main_dish`, while Step 16 requires `lunch`/`dinner`; no documented mapping exists, so none is assumed.

## Remaining risks

- Candidate, pending-operation, and mock idempotency state is process-local and lost on restart, as allowed for this mock stage.
- The 1,000-session bound evicts the oldest candidate session when full.
- Real auth, consent/privacy, durable idempotency, atomicity, balance policy, timestamps, corrections/reversals, and audit behavior remain unimplemented.
- Full real-data steps 1–9 cannot be accepted until approved verified recipes with documented meal-category tags exist.
