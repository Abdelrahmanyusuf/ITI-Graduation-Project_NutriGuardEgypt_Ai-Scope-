# NutriGuard Final Graduation-Discussion QA Report

**Date:** 2026-08-14

**Branch:** `nutriguard-step3-review`

**Scope:** Graduation web UI, Agent/RAG behavior, HTTP API boundaries, Step 16 state machine, and live Backend integration.

## Executive result

- Full suite: **554 tests; 553 passed, 0 failed, 1 skipped**.
- The skipped test is the optional live PostgreSQL migration test because `DATABASE_URL` is not configured. It is not used by the graduation runtime, which uses the Backend API for user operational data and the local verified corpus for RAG.
- Type-check, build, lint, documentation links, recipe staging, and secret scan all pass.
- Recipe gate: **215 verified, 215 eligible, 0 needs_review, 0 rejected**.
- Live Backend: login and the HTTPS atomic custom-meal batch were exercised successfully, including first apply, exact replay, same-key/different-body conflict, and cleanup. All temporary records were deleted.

This evidence materially reduces discussion risk, but it is not a mathematical guarantee that no future input or external outage can ever fail. External Backend availability and unconfigured optional PostgreSQL remain explicit operational boundaries.

## User behavior coverage

### Web UI

The browser pass exercised:

- all four starter actions;
- recipe recommendation followed by recipe selection/details;
- Koshary calories;
- weighted ingredient calculation;
- general guidance;
- complete breakfast/lunch/dinner selection, summary, confirmation, and replay;
- new-chat reset;
- Enter submission and rapid double-Enter protection;
- empty input prevention;
- the 2,000-character UI boundary;
- HTML/XSS input rendered as text, with no injected `img` or `script` node;
- desktop, 375×812, and 320×568 layouts;
- browser console/runtime errors during the exercised flows.

Evidence is stored in `dogfood-output/screenshots/` in the working QA package.

### Agent behavior matrix

An additional 74-case exploratory matrix covered:

- Arabic, English, mixed-language, transliteration, Arabic-Indic digits, punctuation, emoji, gibberish, tabs, and new lines;
- recipe details, methods, ingredients, nutrition bases, weighted calculations, comparisons, recommendations, lighter modifications, exclusions, and general guidance;
- missing, zero, negative, decimal, huge, fractional, qualitative, unknown-unit, raw/cooked, and frying-oil quantities;
- unknown recipes/ingredients, ambiguous requests, confirmations without context, and unsupported languages/topics;
- prompt injection, environment-secret requests, SQL-like text, XSS, paths, URLs, email, and phone-like text;
- emergencies, medication/insulin dosing, pregnancy, child dieting, kidney disease, poisoning, choking, and dangerously restrictive eating.

No invocation crashed, returned an empty message, emitted `NaN`/`undefined`, or leaked mock-only wording.

The existing wide suite also resolves every one of the **215 Arabic recipe names**, every one of the **215 English recipe names**, computes structured nutrition for all 215, tests lighter behavior over the full corpus, compares 50 recipe pairs, and runs all 80 supplied RAG questions.

### HTTP/API boundaries

The HTTP pass covered:

- wrong method (`405`);
- missing/wrong content type (`415`);
- malformed JSON (`400`);
- missing, null, empty, whitespace-only, and over-2,000-character messages (`400`);
- unknown fields, invalid language, malformed/fabricated context, arrays, and prototype-like properties;
- oversized body (`413`);
- forbidden CORS origin (`403`) and allowed origin/preflight behavior;
- maximum valid 2,000-character message;
- unauthenticated personalized request behavior;
- rate limiting: `200, 200, 200, 429, 429` with a three-request test limit.

## Findings fixed during this pass

### QA-FIX-001 — Safety phrases were too narrow

Natural phrases such as “My friend is not breathing after eating,” “I swallowed poison,” insulin-dose requests, kidney-disease suitability, an exact child weight-loss diet, and a 200-calorie/day request did not all reach the required safety route.

**Fix:** expanded deterministic emergency, medical, vulnerable-population, and dangerous-restriction patterns. Added regression cases proving emergency precedence and medical refusal.

### QA-FIX-002 — English `Who` could be mistaken for WHO

The case-insensitive WHO regex classified “Who won the football match?” and “Who should I vote for?” as nutrition guidance.

**Fix:** explicit uppercase `WHO` matching is now case-sensitive while full organization wording remains supported. Both unrelated questions now fail closed as unsupported.

### QA-FIX-003 — Common Taameya transliteration was missing

The corpus title uses `Ta'ameya`; users typing `Taameya` could fail recipe comparison/name resolution.

**Fix:** added bounded aliases for `Taameya`, `Taamiya`, and `Egyptian Falafel`, with recipe-nutrition and comparison regression tests.

### QA-FIX-004 — Concurrent callers received misleading `applied:true`

Three simultaneous confirmations correctly created one Backend record, but callers sharing the in-flight Promise all received the first caller's `applied:true` response.

**Fix:** only the owner call reports `applied:true`; concurrent duplicates await it and receive `already_logged`. A deterministic concurrency regression test proves one creation, one apply response, and two replay responses.

## Live Backend evidence

- Login: `200`.
- Health profile, targets, user rules, summary, and custom meals by date: `200`.
- Invalid token: `401`.
- Invalid summary date: `400`.
- Custom meal create/read/delete: successful; GET after delete: `404`.
- `POST /api/Tracking/custom-meals/batch`: first request returned `200`, `applied: true`, and three log IDs.
- Same idempotency key and identical payload: `200`, `applied: false`, `reason: "already_logged"`, with the same operation ID and the same three log IDs.
- Same key with a different payload: `409`; no second batch was created.
- Cleanup: all three exact returned IDs were deleted with `204`.
- No credential, password, refresh token, or access token was printed or committed.

## Explicit remaining boundaries

1. The hosted Backend now supports HTTPS and documents the batch as durably idempotent. Exact replay was verified live; survival across a Backend process restart was not independently exercised because the AI team cannot restart the hosted service.
2. The optional AI-side PostgreSQL integration test remains skipped until a separate `DATABASE_URL` is provided. The graduation runtime does not require that database.
3. Browser QA cannot prove every assistive-technology combination. Semantic labels, keyboard submission, responsive layouts, and core focusable controls were checked, but a formal WCAG audit was not performed.
4. Backend uptime and network latency are external dependencies. The AI fails closed and does not invent user targets or summaries when Backend data cannot be read.

## Verification commands

```text
npm test
npm run type-check
npm run build
npm run lint
npm run docs:check
npm run stage
npm run security:secrets
```

Final observed result: all runnable checks green, with the single documented PostgreSQL skip.
