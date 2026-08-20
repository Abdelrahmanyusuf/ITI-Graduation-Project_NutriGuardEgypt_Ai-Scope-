# NutriGuard Backend Requirements for Complete AI Integration

**Status:** Backend-team action required  
**Audience:** NutriGuard Backend, AI, Frontend, QA, and DevOps teams  
**Current API:** [NutriGuard Swagger](http://nutriguard.runasp.net/swagger/index.html)  
**Purpose:** Make the NutriGuard AI Agent capable of calculating a user's remaining nutrition needs and recommending safe, traceable Egyptian foods and recipes without inventing numbers.

---

## 1. Executive summary

The current Backend already provides a strong foundation:

- Authentication and refresh tokens.
- Health profile creation and update.
- Nutrition targets.
- Approximately 410 foods with macro- and micronutrient fields.
- Approximately 120 Egyptian recipes with ingredients and quantities.
- Food preferences.
- Meal, water, and weight tracking.
- Daily tracking summaries.
- Meal validation and eligible-food/recipe operations.

The AI currently uses the public Foods and Recipes endpoints as an additional source. It can search Backend foods, calculate calories for a supplied food weight, and retrieve Backend recipe ingredients and instructions. It fails back to its local dataset when the Backend is unavailable.

The remaining work is mainly about **authenticated personalization**, **recipe nutrition totals**, **unit conversions**, and **stable response contracts**. Until these items are completed, the AI must not claim that a user is missing a specific amount of protein, carbohydrate, fat, or calories.

### Arabic summary

المطلوب من فريق الـBackend هو توفير عقود استجابة واضحة وثابتة للأهداف اليومية وملخص الاستهلاك، وإرجاع القيم الغذائية المحسوبة لكل وصفة ولكل حصة، وتوثيق الوحدات والـEnums، وتوفير HTTPS وطريقة آمنة لتمرير JWT. بعد ذلك يستطيع الـAI حساب الفرق بين هدف المستخدم وما تناوله، ثم اقتراح أطعمة ووصفات مصرية مناسبة بالأرقام، بدون تخمين أو اختراع قيم.

---

## 2. Target user experience

The completed system should support conversations such as:

> **User:** What do I still need today?  
> **Agent:** You have approximately 32 g protein, 58 g carbohydrate, and 620 kcal remaining against today's targets.

> **User:** Suggest an Egyptian dinner.  
> **Agent:** Here are three eligible options. Option A covers 78% of the remaining protein and 64% of the remaining carbohydrate without exceeding the remaining calories.

> **User:** Add option A to dinner.  
> **Agent:** This will add the following calculated values. Do you want me to log it?  
> **User:** Yes.  
> **Agent:** The meal was logged successfully.

The Agent must never invent a target, consumed total, nutrient value, unit conversion, eligibility result, or successful tracking action.

---

## 3. Required end-to-end flow

```text
Authenticated user
      |
      v
GET health profile + nutrition targets
      |
      v
GET today's consumed totals
      |
      v
Deterministic remaining-needs calculation
      |
      v
Retrieve candidate foods and recipes
      |
      v
Apply preferences + eligibility + diet constraints
      |
      v
Deterministic portion and candidate ranking
      |
      v
AI explains 2–3 options with numbers and sources
      |
      v
User explicitly confirms
      |
      v
POST meal to Tracking
```

The numerical calculations and eligibility decisions belong to Backend/domain tools. The language model only selects tools, asks clarifying questions, and explains tool results.

---

## 4. Priority 0 — blockers for personalized AI recommendations

### 4.1 Use HTTPS for every authenticated endpoint

The current public address is HTTP. JWTs, health-profile data, nutrition targets, and tracking data must not be transmitted over plain HTTP.

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

Swagger currently describes request bodies, but most endpoints only document `200 OK` without a response schema. The AI team cannot safely generate a typed client from this.

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
- `POST /api/Tracking/custom-meals`
- All Foods and Recipes endpoints.

Document all success and failure responses: `200`, `201`, `400`, `401`, `403`, `404`, `409`, `422`, `429`, and `500` where applicable.

### 4.3 Provide a secure AI token flow

Choose and document one design:

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

**Never send real credentials or JWTs through chat or commit them to Git.** Use the development secret manager or local environment variables.

### 4.4 Return complete nutrition targets

`GET /api/Nutrition/targets` must return a versioned and dated target set.

Recommended response:

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

`GET /api/Tracking/summary/{date}` must return totals on the same units and nutrient definitions as `/api/Nutrition/targets`.

Recommended response:

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

The Backend or a shared domain package must define:

```text
remaining = max(0, target - consumed)
```

Also return raw signed difference so the Agent can say whether a nutrient target was exceeded:

```text
difference = target - consumed
remaining  = max(0, difference)
exceededBy = max(0, -difference)
```

Recommended endpoint:

```http
GET /api/Nutrition/remaining?date=2026-08-10
```

Recommended response fields:

```json
{
  "energyKcal": { "target": 2200, "consumed": 1580, "remaining": 620, "exceededBy": 0 },
  "proteinG": { "target": 120, "consumed": 88, "remaining": 32, "exceededBy": 0 },
  "carbohydrateG": { "target": 260, "consumed": 202, "remaining": 58, "exceededBy": 0 }
}
```

---

## 5. Priority 0 — recipe nutrition contract

### 5.1 Return calculated nutrition for every recipe

The current recipe response contains ingredients and servings but no calculated nutrition. Add one of:

```http
GET /api/Recipes/{id}/nutrition
```

or include the same object in `GET /api/Recipes/{id}`.

Recommended model:

```json
{
  "recipeId": 101,
  "servings": 4,
  "finalWeightG": 992,
  "calculationStatus": "complete",
  "fullRecipe": {
    "energyKcal": 2175,
    "proteinG": 63.2,
    "carbohydrateG": 352.8,
    "fatG": 58.1,
    "fiberG": 31.4,
    "sodiumMg": 1640
  },
  "perServing": {
    "servingWeightG": 248,
    "energyKcal": 543.8,
    "proteinG": 15.8,
    "carbohydrateG": 88.2,
    "fatG": 14.5,
    "fiberG": 7.9,
    "sodiumMg": 410
  },
  "per100g": {
    "energyKcal": 219.3,
    "proteinG": 6.4,
    "carbohydrateG": 35.6,
    "fatG": 5.9,
    "fiberG": 3.2,
    "sodiumMg": 165.3
  },
  "missingNutrients": [],
  "assumptions": [],
  "calculationVersion": "recipe-nutrition-v1.0"
}
```

The numbers above illustrate the response shape only; the Backend must calculate authoritative values.

### 5.2 Provide grams for every recipe ingredient

Current recipes contain `Gram`, `Piece`, `Teaspoon`, `Tablespoon`, and possibly other units. Nutrition cannot be calculated safely without mass conversion.

Each recipe ingredient should contain:

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

Document whether the values in `/api/Foods` represent:

- per 100 g edible portion;
- per serving;
- raw or cooked food;
- drained or undrained food.

Recommended additions to every Food response:

```json
{
  "nutritionBasis": "per_100g_edible_portion",
  "foodState": "raw",
  "dataVersion": "foods-2026-08",
  "sourceId": "food-source-id"
}
```

---

## 6. Priority 1 — recommendation endpoint

The simplest and safest integration is for the Backend to return eligible, calculated candidates. The AI then explains them.

Recommended endpoint:

```http
POST /api/Nutrition/recommendations
Authorization: Bearer <access-token>
Content-Type: application/json
```

Request:

```json
{
  "date": "2026-08-10",
  "mealType": "Dinner",
  "candidateLimit": 5,
  "includeFoods": true,
  "includeRecipes": true,
  "maximumServingMultiplier": 2,
  "excludedFoodIds": [],
  "requestId": "client-generated-id"
}
```

Response:

```json
{
  "isSuccess": true,
  "data": {
    "remainingBeforeRecommendation": {
      "energyKcal": 620,
      "proteinG": 32,
      "carbohydrateG": 58,
      "fatG": 19
    },
    "candidates": [
      {
        "candidateType": "recipe",
        "recipeId": 101,
        "name": "Koshari",
        "servingMultiplier": 1,
        "nutrition": {
          "energyKcal": 544,
          "proteinG": 15.8,
          "carbohydrateG": 88.2,
          "fatG": 14.5
        },
        "coverage": {
          "proteinPercent": 49.4,
          "carbohydratePercent": 152.1,
          "energyPercent": 87.7
        },
        "overshoot": {
          "proteinG": 0,
          "carbohydrateG": 30.2,
          "energyKcal": 0
        },
        "eligible": true,
        "eligibilityReasonCodes": [],
        "score": 0.71
      }
    ],
    "rankingVersion": "recommendation-v1.0"
  },
  "traceId": "request-trace-id"
}
```

### Ranking rules

The recommendation engine should be deterministic and versioned. Suggested factors:

- percentage of remaining protein covered;
- percentage of remaining carbohydrate covered;
- remaining-calorie fit;
- overshoot penalty;
- sodium/fat limits when explicitly defined by the target contract;
- user likes/dislikes;
- diet type;
- eligibility result;
- meal type;
- realistic serving multiplier.

The LLM must not invent or override the candidate score.

### Do not call low calorie automatically “healthier”

“Healthier” requires an explicit comparison criterion. Return machine-readable reasons, for example:

- `better_protein_fit`
- `lower_sodium_on_same_basis`
- `higher_fiber_on_same_basis`
- `fits_remaining_energy`

---

## 7. Priority 1 — eligibility and preferences

### 7.1 Document eligibility request and response semantics

Current operations accept arrays of IDs:

```http
POST /api/Nutrition/eligible-foods
POST /api/Nutrition/eligible-recipes
```

Return a decision for every supplied ID:

```json
{
  "results": [
    {
      "id": 101,
      "eligible": true,
      "reasonCodes": []
    },
    {
      "id": 87,
      "eligible": false,
      "reasonCodes": ["diet_type_conflict", "user_dislike"]
    }
  ],
  "policyVersion": "eligibility-v1.0"
}
```

Do not return only a filtered list; the AI needs to explain why a candidate was excluded without inventing a reason.

### 7.2 Clarify food-preference meanings

Document `FoodPreferenceType` values and whether they represent:

- liked;
- disliked;
- allergy/intolerance;
- religious restriction;
- avoid by choice.

Allergy and medical restriction data must not be silently treated as a normal dislike. If allergy support does not exist, the Agent must say it cannot guarantee allergen safety.

---

## 8. Priority 1 — enums and units

Swagger currently exposes numeric enum values without names. Publish stable name/value mappings for:

- `ActivityLevel`
- `DietType`
- `FoodPreferenceType`
- `Gender`
- `Goal`
- `MealType`
- `Unit`

Preferred OpenAPI output:

```json
{
  "type": "string",
  "enum": ["Sedentary", "Light", "Moderate", "Active", "VeryActive"]
}
```

If integer enums must remain, publish `x-enumNames` and never reorder or reuse values.

Document:

- canonical unit name;
- enum value;
- symbol;
- measurement type: mass, volume, count;
- whether decimal quantities are accepted;
- minimum and maximum quantities.

---

## 9. Priority 1 — consistent API envelopes

Current public endpoints return different shapes:

- Foods list: `{ "isSuccess": true, "data": [...] }`
- Foods search: `{ "items": [...], "totalCount": ... }`
- Recipes list: direct array
- Recipes search: `{ "isSuccess": true, "data": [...], "totalCount": ... }`
- Recipe detail: `{ "isSuccess": true, "data": {...} }`

Standardize all endpoints:

```json
{
  "isSuccess": true,
  "data": {},
  "errors": [],
  "traceId": "request-trace-id"
}
```

Paged data:

```json
{
  "isSuccess": true,
  "data": {
    "items": [],
    "pageNumber": 1,
    "pageSize": 20,
    "totalCount": 410,
    "totalPages": 21,
    "hasNextPage": true,
    "hasPreviousPage": false
  },
  "errors": [],
  "traceId": "request-trace-id"
}
```

Standard error:

```json
{
  "isSuccess": false,
  "data": null,
  "errors": [
    {
      "code": "HEALTH_PROFILE_INCOMPLETE",
      "message": "Complete the required health profile fields.",
      "field": null
    }
  ],
  "traceId": "request-trace-id"
}
```

---

## 10. Priority 1 — tracking safety and idempotency

### 10.1 Require explicit user confirmation

The AI should calculate and display the proposed meal first. It may call `POST /api/Tracking/custom-meals` only after a clear confirmation such as “yes, add it.”

### 10.2 Add idempotency

Accept:

```http
Idempotency-Key: stable-client-generated-key
```

Repeated submissions with the same key must not create duplicate meals.

### 10.3 Return the calculated saved record

`POST /api/Tracking/custom-meals` should return:

- stable meal-log ID;
- saved items and quantities;
- calculated meal nutrition;
- updated daily totals;
- calculation status;
- created timestamp;
- idempotency key.

### 10.4 Concurrency control

If targets or tracking totals can change during a conversation, return an ETag/version and reject stale writes where appropriate.

---

## 11. Priority 2 — data provenance and versioning

Add to food and recipe numerical records:

- `sourceId`
- `sourceTitle`
- `sourceUrl`
- `sourceVersion`
- `accessedAt`
- `dataVersion`
- `calculationVersion`
- `reviewStatus`
- `updatedAt`

Requirements:

- Missing nutrient values remain `null`.
- Explicit zero remains `0`.
- Negative nutrition, quantity, serving, and weight values are rejected.
- Food/recipe IDs are stable and never reused.
- Deleted records should be retired/archived, not silently reassigned.

---

## 12. Priority 2 — synchronization for RAG

The AI needs a reliable way to update its retrieval index when Backend recipes change.

Provide one option:

### Incremental feed

```http
GET /api/Recipes/changes?after=2026-08-10T00:00:00Z
```

### Versioned export

```http
GET /api/Recipes/export?version=recipes-2026-08
```

Each item should include:

- stable recipe ID;
- name and aliases in Arabic/English;
- description;
- instructions;
- ingredients;
- nutrition per serving/per 100 g;
- version/hash;
- review status;
- updated timestamp.

The AI will index text for retrieval but will continue to obtain current numerical values from the structured API, not from embedded text.

---

## 13. Priority 2 — operational requirements

- Publish staging and production base URLs.
- Provide a non-production test account through a secret manager.
- Provide rate limits and `Retry-After` behavior.
- Set request timeouts and cancellation support.
- Add correlation/trace IDs.
- Add health and readiness endpoints.
- Add structured logs without JWTs or sensitive health data.
- Monitor latency/error rate for Auth, Foods, Recipes, Nutrition, and Tracking.
- Publish backup/restore and rollback procedures.
- Define API and data retention policies.

Recommended service-level targets for the graduation/staging environment:

- Public Foods/Recipes read p95 below 500 ms.
- Authenticated targets/summary p95 below 800 ms.
- Recommendations p95 below 1500 ms.
- Documented graceful behavior for timeouts and `429` responses.

---

## 14. Required test fixtures

Provide explicitly synthetic staging fixtures for:

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
13. Duplicate meal POST with the same idempotency key.
14. Expired/invalid JWT.
15. Rate-limited response.

Do not use real personal or health data in automated tests.

---

## 15. Backend delivery checklist

### Required before personalized AI integration

- [ ] HTTPS staging API is available.
- [ ] Response DTOs appear in Swagger/OpenAPI.
- [ ] Enum name/value table is published.
- [ ] Foods nutrition basis is confirmed.
- [ ] Recipe nutrition per serving/per 100 g is returned.
- [ ] Every non-mass recipe unit has an approved gram conversion or returns `null`.
- [ ] Targets response is versioned and complete.
- [ ] Daily summary uses the same units as targets.
- [ ] Remaining-needs response/calculation is defined.
- [ ] Eligible Foods/Recipes return per-ID decisions and reason codes.
- [ ] Food preference meanings are documented.
- [ ] Secure short-lived JWT forwarding is agreed.
- [ ] Tracking POST is idempotent and returns calculated saved nutrition.
- [ ] Standard response/error envelope is implemented.
- [ ] Synthetic staging fixtures and test account are available securely.

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

The Backend work is ready for the AI team when all scenarios pass through the documented API:

### Scenario A — remaining needs

Given a complete target and daily summary, the Backend returns exact remaining and exceeded values with no LLM calculation.

### Scenario B — meal recommendation

Given a remaining protein/carbohydrate target, the Backend returns 2–5 eligible foods/recipes with calculated portions, nutrition, coverage, overshoot, reason codes, and ranking version.

### Scenario C — missing data

When a recipe ingredient cannot convert to grams, recipe nutrition is `partial`; the missing value is `null`, and the response explains the blocker. It never becomes zero.

### Scenario D — preference/eligibility

A disliked or ineligible item is excluded with a machine-readable reason. The AI does not invent the reason.

### Scenario E — safe logging

The Backend validates a proposed meal, returns calculated nutrition, waits for explicit user confirmation, then creates exactly one meal log even if the request is retried.

### Scenario F — Backend unavailable

The AI receives a timeout or structured failure and falls back to local general functionality. It does not claim that personalized targets or tracking data are available.

---

## 17. Information to return to the AI team

When the checklist is ready, send the AI team:

1. HTTPS staging base URL.
2. Updated OpenAPI JSON.
3. Enum name/value document.
4. Foods nutrition-basis confirmation.
5. Recipe nutrition and conversion contract.
6. Response examples for targets, summary, remaining needs, validation, eligibility, recommendations, and tracking.
7. Staging test-user identifier and instructions for obtaining credentials securely.
8. JWT issuer/audience/scopes and access-token lifetime.
9. Rate limits and timeout recommendations.
10. Backend/API version and expected change policy.

Credentials must be placed in the agreed secret manager or local environment. They must not be pasted into chat, documentation, Git commits, screenshots, or issue comments.

