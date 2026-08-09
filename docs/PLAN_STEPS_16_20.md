# NutriGuard Steps 16–20 closure plan

## Objective

Finish the remaining engineering work without weakening the project's
provenance, deterministic-calculation, safety, or no-fabrication guarantees.
External evidence (real users, approvals, credentials, and an actual hosting
account) must remain an explicit release gate rather than being simulated.

## Step 16 — adversarial evaluation

- Add a versioned synthetic adversarial corpus covering missing data,
  unsupported requests, ambiguous recipes, conflicting user assertions,
  prompt injection, unsafe medical requests, emergencies, allergen/religious
  guarantees, malformed input, and no-result behavior.
- Run the real expanded agent over the corpus and report pass/fail by category.
- Keep synthetic evidence ineligible for production evaluation.

Critical files: `src/evaluation/adversarial.ts`,
`tests/fixtures/evaluation/adversarial.synthetic.json`, and
`tests/adversarial-evaluation.test.ts`.

## Step 17 — measured iteration

- Version the prompt and request-integrity guardrails.
- Convert every discovered failure into a regression expectation.
- Generate a machine-readable iteration report that records the evaluated
  dataset version, prompt version, metrics, and unresolved blockers.
- Do not claim a production-model or retrieval improvement without real data.

Critical files: `src/agent/request-integrity.ts`,
`src/agent/system-prompt.ts`, `src/evaluation/iteration.ts`, and
`src/scripts/run-adversarial-evaluation.ts`.

## Step 18 — API and chat interface

- Add a dependency-injected HTTP application with `/health`, `/ready`,
  `/api/v1/chat`, and `/api/v1/feedback`.
- Enforce body-size, content-type, method, timeout, rate-limit, origin, request
  ID, security-header, error-redaction, and strict response-schema controls.
- Serve an accessible RTL Egyptian-Arabic chat experience with provenance,
  uncertainty, safety state, keyboard, loading, and responsive behavior.
- Keep the runnable local demo explicitly synthetic and impossible to enable in
  production.

Critical files: `src/server/*`, `src/web/*`, `src/runtime/*`, and
`tests/http-app.test.ts`.

## Step 19 — staging pilot readiness

- Add consent-gated, data-minimized feedback models and a durable PostgreSQL
  feedback store.
- Add a staging readiness command that fails closed unless database, approved
  data, safety/QA approval, consent material, retention policy, and release
  identifiers are present.
- Document the real recruitment, consent, feedback, incident, and exit process.
- Completion still requires an actual limited pilot and human feedback.

Critical files: `migrations/0002_pilot_feedback.*.sql`,
`src/pilot/*`, `src/release/readiness.ts`, and `docs/STAGING_PILOT.md`.

## Step 20 — production release readiness

- Add a stricter production gate that consumes signed/recorded approval and
  evaluation artifacts, checks that Steps 14–19 have real evidence, and blocks
  synthetic/demo modes.
- Add container health checks, graceful shutdown, deployment configuration,
  operational runbook, rollback, observability, backup/restore, security,
  privacy, and incident checklists.
- Completion still requires the owner to provide the approved production
  infrastructure and authorize deployment after a real staging pilot.

Critical files: `src/release/*`, `Dockerfile`, `.dockerignore`,
`docs/PRODUCTION_RUNBOOK.md`, and `docs/ROADMAP_STATUS.md`.

## Verification

- Type-check, lint, build, documentation links, and all Node tests.
- Run the adversarial evaluation twice and compare byte-identical reports.
- Exercise the API end to end, including malicious and malformed requests.
- Render and inspect desktop/mobile UI states.
- Create a clean temporary PostgreSQL 16 database, apply all migrations twice,
  test constraints and feedback persistence, roll back, and re-apply.
- Confirm `data/raw` SHA-256 hashes remain unchanged and run secret scanning.
- Prove staging/production gates fail without real evidence and pass only in
  tests with explicit non-production fixtures.
