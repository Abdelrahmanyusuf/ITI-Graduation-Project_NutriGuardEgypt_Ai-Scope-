# NutriGuard Backend Requirements for Complete AI Integration (Revised)

**Status:** Backend-team action required
**Audience:** NutriGuard Backend, AI, Frontend, QA, and DevOps teams
**Current API:** [NutriGuard Swagger](http://nutriguard.runasp.net/swagger/index.html)
**Purpose:** Make the NutriGuard AI Agent capable of calculating a user's remaining nutrition needs and safely logging meals from its own verified recipe corpus, without inventing numbers and without duplicating logic the AI already owns.

**Revision note:** This revision supersedes the earlier draft's Section 6
(`POST /api/Nutrition/recommendations`). Candidate search, ranking, and
recipe selection for Step 16 are owned entirely by the AI, operating over
its own 215-recipe owner-approved verified corpus
(`search_recipes_by_meal_category`). The Backend is not asked to build a
second recommendation/ranking engine. This revision also adds the atomic
batch logging endpoint, external-ID registry sync, recipe versioning, and
durable idempotency that the AI side already implements and has
live-tested against a mock — real integration requires the Backend side
of the same contract.

---

## 1. Executive summary

The current Backend already provides a strong foundation:

- Authentication and refresh tokens.
- Health profile creation and update.
- Nutrition targets.
- Approximately 410 foods with macro- and micronutrient fields.
- A separate Backend recipe catalog with ingredients and quantities.
- Food preferences.
- Meal, water, and weight tracking.
- Daily tracking summaries.
- Meal validation and eligible-food/recipe operations.

**Architecture decision (explicit, replaces the earlier "~120 recipes"
framing):** The Backend currently exposes a separate recipe catalog. The
AI's Step 16 candidate corpus consists of 215 owner-approved,
nutrition-complete recipes. **The two catalogs must not be implicitly
merged**; synchronization requires explicit external IDs, versions, and
reviewed mappings (Section 5A).

**Responsibility split (explicit):**

| Responsibility | Owner |
|---|---|
| Recipe search, ranking, candidate selection for Step 16 | **AI** (already built and live-tested) |
| Authentication and identifying the user from JWT | Backend |
| Nutrition targets, daily summary, user rules | Backend |
| Eligibility decisions + reason codes | Backend |
| Authoritative recipe ID/version/nutrition at logging time | Backend |
| Atomic batch logging of a full meal-plan confirmation (breakfast+lunch+dinner in one write) | Backend |
| Durable idempotency across restarts | Backend |
| Updated daily balance + logged IDs returned after logging | Backend |
| Recommendation/ranking engine | **Not requested from Backend** — see Appendix A |

The AI must not claim a user is missing a specific amount of protein,
carbohydrate, fat, or calories, and must not claim a meal was logged,
until the Backend confirms it through the contracts below.

### Arabic summary

القرار المعماري الصريح: البحث والترشيح والترتيب داخل الـ215 وصفة verified
مسؤولية الـAI بالكامل عن طريق `search_recipes_by_meal_category` — ده مبني
ومختبر لايف بالفعل. الـBackend **غير مطلوب منه** بناء محرك توصيات/ترتيب
موازٍ (راجع الملحق أ). مسؤولية الـBackend محصورة في: التوثيق وربط
المستخدم من JWT، الأهداف والملخص اليومي وuser rules، قرارات الأهلية مع
أسباب واضحة، التحقق الرسمي من هوية/نسخة/أرقام الوصفة وقت التسجيل، تسجيل
دفعة (فطار+غداء+عشاء) ذريًا بمفتاح idempotency واحد يبقى بعد أي restart،
وإرجاع الرصيد المحدث ومعرّفات السجلات. الـ215 وصفة تبقى corpus مستقل عن
كتالوج الـBackend الحالي — بدون أي دمج أو تطابق بالاسم؛ الربط فقط عبر
`externalRecipeId` موثق (قسم 5A).

---

## 2. Target user experience

> **User:** What do I still need today?
> **Agent:** You have approximately 32 g protein, 58 g carbohydrate, and 620 kcal remaining against today's targets. *(from Backend targets + summary)*

> **User:** Suggest an Egyptian dinner.
> **Agent:** Here are three options from the verified recipe set. *(AI searches its own 215-recipe corpus)* Let me check they're eligible for you. *(AI calls Backend eligibility)* Option A covers 78% of your remaining protein and fits your remaining calories, and has no dietary conflicts.

> **User:** Add option A to dinner, and Option B for lunch, and Option C for breakfast.
> **Agent:** Here's the full summary — three meals, these totals. Confirm?
> **User:** Yes.
> **Agent:** All three were logged in one batch. Here's your updated remaining balance.

The Agent must never invent a target, consumed total, nutrient value,
unit conversion, eligibility result, or successful tracking action. It
also must never invent a *candidate recipe* outside its own verified
corpus, and must never claim a Backend-side recommendation when none was
requested of the Backend.

---

## 3. Required end-to-end flow

```text
Authenticated user
      |
      v
GET health profile + nutrition targets + user rules   (Backend)
      |
      v
GET today's consumed totals                             (Backend)
      |
      v
Deterministic remaining-needs calculation                (Backend)
      |
      v
AI searches its own 215-recipe verified corpus            (AI)
      |
      v
Backend eligibility check on the selected externalRecipeIds (Backend)
      |
      v
AI explains 2–3 eligible options with numbers and sources   (AI)
      |
      v
User selects one option per requested meal category         (AI)
      |
      v
Frozen confirmation summary + pending_operation_id            (AI)
      |
      v
User explicitly confirms
      |
      v
POST /api/Tracking/meal-selections (batch, atomic, idempotent) (Backend)
      |
      v
Backend returns applied / already_logged / structured error + updated balance
```

Ownership of numbers is split precisely, not generically "Backend does
all calculation":

```text
Search/display numbers (candidate ranking, calorie-ceiling filtering,
confirmation-summary totals) → the AI's owner-approved, nutrition-complete
215-recipe corpus.

Personal user numbers (targets, consumed totals, remaining-needs,
eligibility decisions) → Backend.

Persisted logging numbers (what actually gets saved and counted toward
the user's daily balance) → Backend's own synced copy, verified at
confirmation time (Section 6).
```

The AI uses its own corpus to search, rank, and build the confirmation
summary the user approves. The Backend independently verifies eligibility
and, at logging time, persists nutrition from its own synced copy of that
exact recipe version — never from a value the AI sends. The language
model only selects tools, asks clarifying questions, and explains tool
results — it never constructs the write payload freely (see Section 6,
`pending_operation_id`).

---

## 4. Priority 0 — platform and contract blockers

### 4.1 Use HTTPS for every authenticated endpoint

Unchanged from the prior draft — still a hard blocker.

Required:

- Provide an HTTPS API origin.
- Redirect HTTP to HTTPS.
- Enable HSTS in staging and production.
- Do not place tokens in query strings.
- Do not log Authorization headers or refresh tokens.

**Acceptance criteria**

- All authenticated API calls succeed over HTTPS.
- Plain HTTP requests are redirected or rejected.
- No JWT appears in application logs, URLs, Swagger examples, or error responses.

### 4.2 Publish response DTO schemas in OpenAPI

Add explicit response DTOs and examples for:

- `GET /api/Auth/me`
- `GET /api/HealthProfile`
- `GET /api/HealthProfile/completion-status`
- `GET /api/Nutrition/targets`
- `POST /api/Nutrition/validate-meal`
- `GET /api/Nutrition/check-food/{foodId}`
- `POST /api/Nutrition/eligible-foods`
- `POST /api/Nutrition/eligible-recipes`
- `GET /api/Tracking/summary/{date}`
- `GET /api/Tracking/history`
- `POST /api/Tracking/meal-selections` (new, Section 6)
- `POST /api/Recipes/registry/import` or equivalent (new, Section 5A)
- All Foods and existing Recipes endpoints.

Document all success and failure responses: `200`, `201`, `400`, `401`,
`403`, `404`, `409`, `422`, `429`, and `500` where applicable.

### 4.3 Provide a secure AI token flow

Unchanged from the prior draft.

#### Recommended: Backend-for-Frontend token forwarding

1. Frontend authenticates with the Backend.
2. Frontend sends the short-lived access token to the AI API in the `Authorization` header.
3. AI forwards the token only to the configured NutriGuard Backend origin.
4. AI never stores or logs the token.
5. Refresh tokens stay between Frontend and Auth Backend; the AI never receives them.

Required decisions:

- Access-token lifetime.
- Refresh-token rotation policy.
- JWT issuer, audience, and signing algorithm.
- Clock-skew allowance.
- Revocation/logout behavior.
- Which scopes/roles authorize targets, tracking, and preferences.

**Never send real credentials or JWTs through chat or commit them to Git.**
Use the development secret manager or local environment variables.

### 4.4 Return complete nutrition targets

Unchanged from the prior draft.

```json
{
  "isSuccess": true,
  "data": {
    "userId": "stable-user-id",
    "effectiveDate": "2026-08-10",
    "calculationVersion": "targets-v1.0",
    "basis": "daily",
    "energyKcal": 2200,
    "proteinG": 120,
    "carbohydrateG": 260,
    "fatG": 70,
    "fiberG": 30,
    "sodiumMg": 2000,
    "waterMl": 2500,
    "source": {
      "profileVersion": "profile-version-id",
      "calculatedAt": "2026-08-10T08:00:00Z"
    }
  },
  "traceId": "request-trace-id"
}
```

Rules:

- Missing targets must be `null`, not zero.
- Include the formula/version used to calculate targets.
- Return whether the health profile is complete enough for target calculation.
- Do not return targets if required profile fields are invalid or missing.

### 4.5 Return complete daily consumed totals

Unchanged from the prior draft.

```json
{
  "isSuccess": true,
  "data": {
    "date": "2026-08-10",
    "energyKcal": 1580,
    "proteinG": 88,
    "carbohydrateG": 202,
    "fatG": 51,
    "fiberG": 18,
    "sodiumMg": 1430,
    "waterMl": 1700,
    "mealCount": 3,
    "calculationStatus": "complete",
    "missingNutrients": [],
    "updatedAt": "2026-08-10T15:20:00Z"
  },
  "traceId": "request-trace-id"
}
```

Rules:

- Use `null` for unknown values.
- Include `calculationStatus`: `complete`, `partial`, or `unavailable`.
- Explain partial totals through machine-readable blockers.
- A day with no logged food is a known zero; a failed calculation is `null`, not zero.

### 4.6 Define the authoritative remaining-needs calculation

Unchanged from the prior draft.

```text
difference = target - consumed
remaining  = max(0, difference)
exceededBy = max(0, -difference)
```

Recommended endpoint:

```http
GET /api/Nutrition/remaining?date=2026-08-10
```

```json
{
  "energyKcal": { "target": 2200, "consumed": 1580, "remaining": 620, "exceededBy": 0 },
  "proteinG": { "target": 120, "consumed": 88, "remaining": 32, "exceededBy": 0 },
  "carbohydrateG": { "target": 260, "consumed": 202, "remaining": 58, "exceededBy": 0 }
}
```

---

## 5. Priority 0 — Backend's own recipe/food nutrition contract

Applies to the Backend's own catalog (Foods, and any Backend-side
recipes outside the AI's 215-recipe corpus). This is unchanged in
substance from the prior draft, kept for completeness since the AI still
uses Backend Foods search generally.

### 5.1 Return calculated nutrition for every Backend recipe

```http
GET /api/Recipes/{id}/nutrition
```

```json
{
  "recipeId": 101,
  "servings": 4,
  "finalWeightG": 992,
  "calculationStatus": "complete",
  "fullRecipe": { "energyKcal": 2175, "proteinG": 63.2, "carbohydrateG": 352.8, "fatG": 58.1, "fiberG": 31.4, "sodiumMg": 1640 },
  "perServing": { "servingWeightG": 248, "energyKcal": 543.8, "proteinG": 15.8, "carbohydrateG": 88.2, "fatG": 14.5, "fiberG": 7.9, "sodiumMg": 410 },
  "per100g": { "energyKcal": 219.3, "proteinG": 6.4, "carbohydrateG": 35.6, "fatG": 5.9, "fiberG": 3.2, "sodiumMg": 165.3 },
  "missingNutrients": [],
  "assumptions": [],
  "calculationVersion": "recipe-nutrition-v1.0"
}
```

The numbers above illustrate the response shape only.

### 5.2 Provide grams for every recipe ingredient

```json
{
  "foodId": 395,
  "foodName": "Vegetable Oil",
  "quantity": 3,
  "unit": "Tablespoon",
  "grams": 40.8,
  "foodState": "raw",
  "conversionId": "oil-tablespoon-v1",
  "conversionStatus": "approved"
}
```

Rules:

- Never use a universal cup/piece/spoon-to-gram conversion for all foods.
- Conversions must be food-specific where density or piece size matters.
- Include raw/cooked/drained/fried food state.
- Unknown conversion means `grams: null` and a partial recipe calculation.
- Do not silently replace missing grams with zero.

### 5.3 Confirm the Foods nutrition basis

```json
{
  "nutritionBasis": "per_100g_edible_portion",
  "foodState": "raw",
  "dataVersion": "foods-2026-08",
  "sourceId": "food-source-id"
}
```

---

## 5A. Priority 0 — Verified-corpus registry sync (new)

The AI's 215-recipe corpus (`EGY-RCP-001` … `EGY-RCP-215`) is
owner-approved, nutrition-complete, and independently maintained. It is
**not** the Backend's recipe catalog and must never be merged into it by
name, alias, or fuzzy matching.

### 5A.1 `recipeVersion` — precise definition (binding for both sides)

`recipeVersion` is a **lowercase SHA-256 hex digest** of the canonicalized
complete registry-entry content. The digest excludes only `recipeVersion`
itself, Backend-generated identifiers, transport metadata, and
synchronization timestamps.

The hashed content includes `externalRecipeId`, every user-visible recipe
field (including names and instructions), servings, ingredients,
`mealCategories`, every nutrition basis (`fullRecipe`, `perServing`, and
`per100g`), `calculationVersion`, `reviewStatus`, `reviewEvidence`, and
provenance fields. A change to any of those fields must produce a different
`recipeVersion`.

Both sides must use the same published canonicalization algorithm. Prefer
RFC 8785 (JSON Canonicalization Scheme) over a bespoke property-ordering
rule. Any additional numeric-domain rule needed by the recipe schema must
be defined before canonicalization and covered by shared cross-language
test vectors. If the two sides can compute different hashes for the same
logical content, every `409 recipe_version_changed` check becomes
meaningless. This is a shared algorithm, not an AI-only or Backend-only
detail.

### 5A.2 Import request shape (AI/owner → Backend)

The import request never includes `backendRecipeId` — it does not exist
yet on first import, and the Backend is the sole assigner/owner of that
ID (5A.3). The request carries the full recipe content, not just
metadata, or the Backend has nothing to recompute or verify against:

```json
{
  "externalRecipeId": "EGY-RCP-001",
  "recipeVersion": "<canonical-sha256>",
  "reviewStatus": "verified",
  "mealCategories": ["lunch", "dinner"],
  "recipe": {
    "nameAr": "كشري",
    "nameEn": "Koshary",
    "servings": 4,
    "ingredients": []
  },
  "nutrition": {
    "calculationStatus": "complete",
    "fullRecipe": {},
    "perServing": {},
    "per100g": {},
    "calculationVersion": "..."
  },
  "reviewEvidence": {
    "reviewerId": "graduation-project-owner",
    "reviewDate": "2026-08-13",
    "evidenceIds": ["EVID-EGY-RCP-001"],
    "rationale": "Owner-reviewed for the graduation-project verified corpus."
  }
}
```

A `verified` import must contain a non-empty `reviewerId`, a valid review
date, at least one non-empty `evidenceId`, and a non-empty `rationale`.
Missing or empty review evidence is a validation failure; it must never be
silently accepted as a verified/loggable registry entry.

### 5A.3 Import mechanism and Backend response shape

```http
POST /api/Recipes/registry/import
Authorization: Bearer <service-to-service token>
Content-Type: application/json
```

- Idempotent upsert keyed **only** on `externalRecipeId` — the importer
  never supplies or chooses a `backendRecipeId`.
- On first import of a given `externalRecipeId`, the Backend creates and
  assigns a new `backendRecipeId`. On every later re-import of the same
  `externalRecipeId` (e.g. a content correction), the Backend keeps that
  same `backendRecipeId` — it is immutable once assigned and the importer
  cannot change it.
- Never deduplicates or merges by `name_en`/`name_ar`/aliases — matching
  is by `externalRecipeId` only.
- Rejects an entry whose `nutrition.calculationStatus` is not `complete`
  if it would otherwise become loggable — a `partial` recipe must not be
  a valid logging target until its Backend-side authoritative nutrition
  is also complete.

Response:

```json
{
  "externalRecipeId": "EGY-RCP-001",
  "backendRecipeId": 501,
  "recipeVersion": "<canonical-sha256>",
  "syncStatus": "created",
  "syncedAt": "2026-08-13T00:00:00Z"
}
```

`syncStatus` is `created` on first import, `updated` on a later re-import
with a changed `recipeVersion`, or `unchanged` if resubmitted identically.

### 5A.4 Authoritative numbers at logging time

At logging time (Section 6), the Backend uses **its own synced copy** of
the recipe's content and nutrition (looked up via the `backendRecipeId`
it assigned, validated against the submitted `recipeVersion`) — never a
value the AI sends in the write request itself.

### 5A.5 No implicit overlap resolution

If a Backend catalog recipe appears to be the "same dish" as one in the
215-recipe corpus (e.g. Backend's own `Koshari`, id `101`, versus
`EGY-RCP-001`), they remain **distinct records** unless a human
explicitly creates a registry mapping between them. No code path may
infer this relationship from name similarity.

---

## 6. Priority 0 — Atomic batch meal-selection logging (new, replaces old Section 10)

This replaces `POST /api/Tracking/meals` as the endpoint the AI uses for
Step 16 confirmations. The single-meal endpoint may remain for other,
non-AI-mediated manual entry use cases, but Step 16 requires atomic
multi-category batching with durable idempotency, which the existing
endpoint does not support.

### 6.1 Endpoint

```http
POST /api/Tracking/meal-selections
Authorization: Bearer <access-token>
Idempotency-Key: <pending-operation-id>
Content-Type: application/json
```

`Idempotency-Key` is the same `pending_operation_id` the AI generates
once when it shows the user's confirmation summary (per the AI-side
contract already implemented) — never regenerated per retry.

### 6.2 Request

```json
{
  "date": "2026-08-13",
  "timeZone": "Africa/Cairo",
  "selections": [
    {
      "externalRecipeId": "EGY-RCP-001",
      "recipeVersion": "<canonical-sha256>",
      "mealType": "Breakfast",
      "servings": 1,
      "occurredAt": "2026-08-13T08:30:00+03:00"
    }
  ]
}
```

`mealType` semantics (binding):

```text
`mealType` is the user-selected tracking bucket for this confirmed
selection. The Backend must validate that it is a supported MealType
enum value, but must not reject the selection merely because that value
is absent from the recipe's registry `mealCategories`.

`mealCategories` (5A) governs candidate-category filtering during AI
search only. The AI is responsible for freezing the selected `mealType`
inside the confirmed pending operation once the summary is shown —
neither the LLM nor the client may change it after that point without
invalidating the pending operation (per the existing AI-side
ACTIVE/APPLIED/INVALID state machine).
```

No separate comparison-nutrition field is sent in the write request —
`recipeVersion` already pins the exact recipe content and nutrition
being logged (5A.1), and the Backend's own synced copy is authoritative
(5A.4). The Backend returns the actual saved nutrition in the response
(6.6) for the AI to compare against the summary it displayed, rather
than the AI submitting a value for the Backend to reconcile.

### 6.3 Recipe-version conflict

If `recipeVersion` in the request does not match the Backend's currently
synced version for that `externalRecipeId` (i.e. the recipe changed
between when the AI showed the summary and when the user confirmed):

```json
{
  "isSuccess": false,
  "errors": [{ "code": "recipe_version_changed", "message": "..." }]
}
```

HTTP `409`. The Backend never silently logs against a newer or older
version than what the user actually saw and approved.

### 6.4 Atomicity

All selections in one request succeed together, or none are persisted
(all-or-nothing transaction). This matches the single confirmation
summary the user approved and keeps replay semantics simple.

### 6.5 Idempotency — durable, survives restart

- Unique constraint on `(user_id, idempotency_key)`, backed by durable
  storage (not in-memory) — must survive a Backend process restart.
- Store a hash of the schema-validated, canonical request body alongside
  the key. Canonicalize with the same published JSON canonicalization
  standard used for stable cross-service hashing; array order remains
  significant. HTTP headers, bearer tokens, whitespace, and JSON property
  order are not part of this hash.
- Same key + same body, after a prior successful commit:

```json
{
  "isSuccess": true,
  "data": {
    "applied": false,
    "reason": "already_logged",
    "loggedSelections": [
      {
        "logId": "log-uuid-1",
        "externalRecipeId": "EGY-RCP-001",
        "recipeVersion": "<canonical-sha256>",
        "mealType": "Breakfast",
        "servings": 1,
        "occurredAt": "2026-08-13T08:30:00+03:00",
        "savedNutrition": { "energyKcal": 544, "proteinG": 15.8, "carbohydrateG": 88.2, "fatG": 14.5 }
      }
    ],
    "dailyCaloriesRemaining": 990,
    "updatedSummary": { "energyKcal": 1580, "proteinG": 88, "carbohydrateG": 202, "fatG": 51 }
  },
  "traceId": "request-trace-id"
}
```

- Same key + a **different** body than what was previously committed:

```json
{
  "isSuccess": false,
  "errors": [{ "code": "idempotency_conflict", "message": "..." }]
}
```

HTTP `409`.

- A key only becomes `already_logged` after its transaction actually
  committed — never for a key whose only prior attempt errored.
- This must correctly handle the timeout-after-commit case: if the
  client times out waiting for a response but the Backend had already
  committed, a retry with the same key must return `already_logged`, not
  a duplicate write and not a fresh error.

**Validation precedence (binding):** idempotency lookup for a committed
operation happens before validation against current mutable Backend state.

- Same committed key + same canonical body returns the stored idempotent
  replay even if the recipe, registry, eligibility policy, daily balance,
  or other Backend state changed after the original commit.
- Same committed key + a different canonical body returns
  `409 idempotency_conflict`.
- Recipe-version, eligibility, balance, and recipe-completeness validation
  run only for a new/uncommitted key. A committed operation is never
  revalidated against newer state and therefore cannot turn into
  `recipe_version_changed` on replay.

The Backend also persists the original post-commit result with the
idempotency record: `loggedSelections`, authoritative `savedNutrition`,
the post-commit `updatedSummary`, and `dailyCaloriesRemaining`. A replay
returns that stored historical result with `applied: false` and
`reason: "already_logged"`; it must not recompute the response from the
user's later balance or from a newer recipe version.

### 6.6 Response on success

```json
{
  "isSuccess": true,
  "data": {
    "applied": true,
    "loggedSelections": [
      {
        "logId": "log-uuid-1",
        "externalRecipeId": "EGY-RCP-001",
        "recipeVersion": "<canonical-sha256>",
        "mealType": "Breakfast",
        "servings": 1,
        "occurredAt": "2026-08-13T08:30:00+03:00",
        "savedNutrition": { "energyKcal": 544, "proteinG": 15.8, "carbohydrateG": 88.2, "fatG": 14.5 }
      }
    ],
    "dailyCaloriesRemaining": 990,
    "updatedSummary": { "energyKcal": 1580, "proteinG": 88, "carbohydrateG": 202, "fatG": 51 }
  },
  "traceId": "request-trace-id"
}
```

`savedNutrition` per selection is the Backend's authoritative persisted
value (from its synced copy, 5A.4) — this is what the AI compares against
the confirmation summary it showed the user, replacing the removed
request-side comparison field. On an idempotent replay, the Backend returns
these same stored selection records and nutrition values, with
`applied: false` and `reason: "already_logged"`.

### 6.7 Confirmation requirement (unchanged principle)

The AI calculates and displays the proposed meal plan first, generates
`pending_operation_id` at that moment, and only calls this endpoint after
explicit user confirmation referencing that specific pending operation —
never speculatively.

---

## 7. Priority 1 — eligibility and preferences

### 7.1 Document eligibility request and response semantics

```http
POST /api/Nutrition/eligible-foods
POST /api/Nutrition/eligible-recipes
```

The AI is not required to pre-translate `externalRecipeId` to
`backendRecipeId` before calling this — the Backend resolves it via the
registry (5A). To avoid an ambiguous union field, each recipe reference
is a **discriminated object** carrying exactly one identifier:

```json
{
  "recipes": [
    { "externalRecipeId": "EGY-RCP-001" },
    { "backendRecipeId": 101 }
  ]
}
```

Schema rule (binding): each recipe reference must contain exactly one of
`externalRecipeId` or `backendRecipeId`. Supplying both or neither is
`422 invalid_recipe_reference` — the Backend must never guess which
identifier was intended.

Response — `resolutionStatus` is reported separately from `eligible`,
since "no registry mapping found" is not a diet/allergy decision:

```json
{
  "results": [
    {
      "requestReference": { "externalRecipeId": "EGY-RCP-001" },
      "externalRecipeId": "EGY-RCP-001",
      "backendRecipeId": 501,
      "resolutionStatus": "resolved",
      "eligible": true,
      "reasonCodes": []
    },
    {
      "requestReference": { "externalRecipeId": "EGY-RCP-087" },
      "externalRecipeId": "EGY-RCP-087",
      "backendRecipeId": null,
      "resolutionStatus": "mapping_not_found",
      "eligible": null,
      "reasonCodes": []
    }
  ],
  "policyVersion": "eligibility-v1.0"
}
```

For Step 16, the AI always sends `externalRecipeId`. `backendRecipeId`
support remains for the Backend's other catalog use cases. Do not return
only a filtered list; the AI needs to explain why a candidate was
excluded without inventing a reason, and must distinguish an unresolved
mapping from a genuine ineligibility decision.

### 7.2 Clarify food-preference meanings

Document `FoodPreferenceType` values and whether they represent:
liked, disliked, allergy/intolerance, religious restriction, avoid by
choice. Allergy and medical restriction data must not be silently
treated as a normal dislike. If allergy support does not exist, the
Agent must say it cannot guarantee allergen safety.

---

## 8. Priority 1 — enums and units

Unchanged from the prior draft. Publish stable name/value mappings for
`ActivityLevel`, `DietType`, `FoodPreferenceType`, `Gender`, `Goal`,
`MealType`, `Unit`. Prefer string enums; if integers must remain,
publish `x-enumNames` and never reorder/reuse values. Document canonical
unit name, symbol, measurement type, decimal support, and bounds.

---

## 9. Priority 1 — consistent API envelopes

Unchanged from the prior draft. Standardize every endpoint (including
the two new ones in this revision) on:

```json
{ "isSuccess": true, "data": {}, "errors": [], "traceId": "request-trace-id" }
```

with the paged and error shapes as previously specified.

---

## 10. (Removed)

The old Section 10 ("tracking safety and idempotency" for
`POST /api/Tracking/meals`) is superseded by Section 6. The existing
single-meal endpoint may remain for manual, non-batch entry, but Step 16
does not use it.

---

## 11. Priority 2 — data provenance and versioning

Unchanged from the prior draft, extended to registry entries (5A):
`sourceId`, `sourceTitle`, `sourceUrl`, `sourceVersion`, `accessedAt`,
`dataVersion`, `calculationVersion`, `reviewStatus`, `updatedAt`.
Missing nutrient values remain `null`; explicit zero remains `0`;
negative values are rejected; IDs are stable and never reused; deleted
records are retired/archived, not silently reassigned — this applies to
`backendRecipeId` mappings in the registry too.

---

## 12. Priority 2 — synchronization for the Backend's own catalog

This section applies only to the Backend's own recipe/food catalog (not
the AI's 215-recipe corpus, which is covered by 5A instead).

```http
GET /api/Recipes/changes?after=2026-08-10T00:00:00Z
```

or a versioned export. Each item: stable recipe ID, name/aliases,
description, instructions, ingredients, nutrition per serving/per 100 g,
version/hash, review status, updated timestamp. The AI indexes text for
retrieval but obtains current numerical values from the structured API,
not from embedded text.

---

## 13. Priority 2 — operational requirements

Unchanged from the prior draft, with one addition:

- `POST /api/Tracking/meal-selections` p95 below 800 ms (same tier as
  authenticated targets/summary), given it's on the critical
  confirmation path a user is actively waiting on.

Rest unchanged: staging/production URLs, secret-managed test account,
rate limits + `Retry-After`, timeouts/cancellation, correlation/trace
IDs, health/readiness endpoints, structured logs without sensitive data,
monitoring, backup/restore, retention policy.

---

## 14. Required test fixtures

Original 15 fixtures, unchanged, plus eight new ones for this revision:

1. Complete health profile with targets.
2. Incomplete profile.
3. Day with no meals: known zero totals.
4. Day with partial nutrition due to a missing conversion.
5. Protein/carbohydrate deficit.
6. Target exceeded.
7. Liked and disliked foods.
8. Ineligible food/recipe with reason codes.
9. Recipe containing grams only.
10. Recipe containing piece/spoon conversions.
11. Missing nutrient value (`null`).
12. Explicit nutrient zero (`0`).
13. Duplicate atomic meal-selection batch submitted with the same idempotency key and identical canonical request body.
14. Expired/invalid JWT.
15. Rate-limited response.
16. **New** — batch of 3 selections (breakfast+lunch+dinner), all succeed atomically.
17. **New** — one selection in a batch fails validation; the entire batch rolls back, none are persisted.
18. **New** — same idempotency key resent with a different body → `409 idempotency_conflict`.
19. **New** — `recipeVersion` in the request no longer matches the registry's current version for that `externalRecipeId` → `409 recipe_version_changed`.
20. **New** — simulated timeout after the Backend already committed; retry with the same key returns `already_logged`, not a duplicate, and this holds after a Backend process restart.
21. **New** — after a successful commit, the registry recipe is updated to a newer version; replaying the original key with the original canonical body still returns the stored `already_logged` result and original saved nutrition, never `recipe_version_changed`.
22. **New** — a registry import marked `verified` with a missing/empty reviewer, review date, evidence list, or rationale is rejected and never becomes loggable.
23. **New** — shared canonicalization test vectors produce the same `recipeVersion` and idempotency request hash in the AI and Backend implementations; JSON property order and whitespace do not change the digest, while a semantic field change does.

Do not use real personal or health data in automated tests.

---

## 15. Backend delivery checklist

### Required before personalized AI integration

- [ ] HTTPS staging API is available.
- [ ] Response DTOs appear in Swagger/OpenAPI, including the two new endpoints.
- [ ] Enum name/value table is published.
- [ ] Foods nutrition basis is confirmed.
- [ ] Targets response is versioned and complete.
- [ ] Daily summary uses the same units as targets.
- [ ] Remaining-needs response/calculation is defined.
- [ ] Eligible Foods/Recipes return per-ID decisions and reason codes, accepting `externalRecipeId`.
- [ ] Food preference meanings are documented.
- [ ] Secure short-lived JWT forwarding is agreed.
- [ ] **Verified-corpus registry import mechanism exists (5A), with no name-based merging, `backendRecipeId` assigned and owned solely by the Backend, and the canonical `recipeVersion` hashing algorithm (5A.1) jointly agreed and published so both sides compute identical hashes for identical content.**
- [ ] **`POST /api/Tracking/meal-selections` exists: atomic, batch, durably idempotent, version-conflict-aware (Section 6).**
- [ ] Standard response/error envelope is implemented.
- [ ] Synthetic staging fixtures and test account are available securely.

### Explicitly not required for this phase

- [ ] ~~Recommendation/ranking engine~~ — see Appendix A.

### Required before production

- [ ] HTTPS/HSTS and production secret management are verified.
- [ ] Security/privacy review is signed.
- [ ] Nutrition calculation and conversion data are reviewed.
- [ ] Monitoring and alerting are enabled.
- [ ] Backup/restore and rollback drills pass.
- [ ] API versioning and deprecation policy are documented.
- [ ] Load/rate-limit testing passes.
- [ ] Production data-owner and release-owner approvals are recorded.

---

## 16. Acceptance scenarios

### Scenario A — remaining needs

Given a complete target and daily summary, the Backend returns exact
remaining and exceeded values with no LLM calculation.

### Scenario B — atomic batch logging (replaces the old recommendation scenario)

Given a confirmed 3-category selection (breakfast, lunch, dinner), the
Backend logs all three atomically under one idempotency key, using its
own synced recipe versions/nutrition (not the AI's snapshot), and
returns updated balance + logged IDs.

### Scenario C — missing data

When a recipe ingredient cannot convert to grams, recipe nutrition is
`partial`; the missing value is `null`, and the response explains the
blocker. It never becomes zero. A `partial` recipe in the 215-corpus
registry is not loggable until complete (5A.3).

### Scenario D — preference/eligibility

A disliked or ineligible item is excluded with a machine-readable
reason. The AI does not invent the reason.

### Scenario E — idempotency and conflict handling

Same key + same body after success → `already_logged`. Same key +
different body → `409 idempotency_conflict`. Stale `recipeVersion` →
`409 recipe_version_changed`. All three hold after a Backend restart.

### Scenario F — Backend unavailable

The AI receives a timeout or structured failure and falls back to local
general functionality. It does not claim that personalized targets or
tracking data are available, and does not claim a meal was logged.

---

## 17. Information to return to the AI team

1. HTTPS staging base URL.
2. Updated OpenAPI JSON, including the two new endpoints.
3. Enum name/value document.
4. Foods nutrition-basis confirmation.
5. Registry-import mechanism details and confirmation of the first successful import of the 215-recipe registry (with counts and any conflicts found).
6. Response examples for targets, summary, remaining needs, validation, eligibility, and the new batch logging endpoint (success, already_logged, idempotency_conflict, recipe_version_changed).
7. Staging test-user identifier and instructions for obtaining credentials securely.
8. JWT issuer/audience/scopes and access-token lifetime.
9. Rate limits and timeout recommendations.
10. Backend/API version and expected change policy.

Credentials must be placed in the agreed secret manager or local
environment. They must not be pasted into chat, documentation, Git
commits, screenshots, or issue comments.

---

## Appendix A — Recommendation/ranking: deferred, not requested

The earlier draft asked the Backend to build
`POST /api/Nutrition/recommendations` (candidate search + scoring +
ranking). This is **removed from current requirements**:

- The AI already owns this responsibility for Step 16, implemented and
  live-tested against `search_recipes_by_meal_category` over the
  215-recipe verified corpus.
- Building an equivalent engine on the Backend would duplicate this
  logic and risks producing two systems that rank/explain candidates
  differently for the same user.
- If a future, non-AI-mediated client (e.g. a plain mobile app screen
  with no AI in the loop) needs Backend-native recommendations, that is
  a separate, later product decision — not a current AI-integration
  blocker, and should be scoped fresh at that time rather than folded
  into this contract.
