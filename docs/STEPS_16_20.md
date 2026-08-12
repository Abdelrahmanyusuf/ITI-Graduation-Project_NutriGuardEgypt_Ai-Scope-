# Steps 16–20 implementation and release status

## Step 16 — adversarial evaluation

The real expanded Agent is evaluated against 18 explicitly synthetic cases in
nine categories: missing/ambiguous data, out-of-scope questions, conflicting
requests, prompt injection, numeric overrides, unapproved data, medical safety,
emergencies, and guarantee requests. The report is deterministic and can never
be production evidence.

Run `npm run eval:adversarial`. It writes:

- `data/reports/step16-adversarial.synthetic.json`;
- `data/reports/step17-iteration.synthetic.json`.

The later dashboard-integration contract also labels its meal-selection feature
as "Step 16". That separate, mocked-only extension is documented in
[Dashboard meal selection](./DASHBOARD_MEAL_SELECTION.md). It does not replace
the adversarial-evaluation work above and does not implement a real dashboard
write.

## Step 17 — measured iteration

Prompt version 1.2.0 adds a pre-planner request-integrity gate. It blocks
prompt injection, user-supplied nutrition-number overrides, and attempts to use
pending/rejected data before retrieval or calculation. Every change maps to a
named finding and regression cases in the Step 17 report.

The iteration is verified synthetically. A production retrieval/model claim
still requires the real Step 14 corpus and approved provider configuration.

## Step 18 — API and chat interface

`createNutriGuardHttpServer` provides:

- `GET /health`, `GET /ready`, and the RTL chat page at `GET /`;
- `POST /api/v1/chat` with strict JSON/schema/body-size/time/rate/origin gates;
- `POST /api/v1/feedback` with server-owned consent provenance;
- request IDs, redacted errors, no-store API responses, security headers,
  graceful shutdown, and dependency injection.

Run `npm run dev:web` for the visibly labelled synthetic local demo. Synthetic
mode throws in production. The desktop and 390×844 mobile states were inspected
in a real browser, including an end-to-end Agent response.

## Step 19 — staging pilot readiness

Migration `0002` adds consented, data-minimized feedback that blocks updates and
ordinary deletion while retaining an explicit privacy-erasure route. The
API never accepts a consent-document identifier from the browser; deployment
configuration supplies it. No names, email addresses, questions, or nutrition
answers are stored in `pilot_feedback`.

The staging release gate requires real-user evaluation, approved datasets,
four human approvals, consent/privacy/retention/incident documents, commit and
artifact SHA-256 evidence. See [the pilot protocol](./STAGING_PILOT.md).

Engineering readiness is implemented. The step is not historically complete
until the team recruits real participants, records consent, runs the limited
pilot, and reviews the resulting feedback.

## Step 20 — production readiness

The production gate additionally requires a completed pilot, zero open critical
incidents, a rollback drill, backup/restore drill, monitoring, and deployment
evidence. Container and operations files are present. See the
[production runbook](./PRODUCTION_RUNBOOK.md).

No production deployment has been performed from this repository. It remains
correctly blocked until real Step 14, 15, 19, data, safety, privacy/security,
and owner evidence is supplied.
