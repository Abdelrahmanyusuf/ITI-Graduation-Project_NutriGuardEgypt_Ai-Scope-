# NutriGuard Threat Model

## Assets and trust boundaries

Protected assets are approved nutrition data, provenance, release evidence, reviewer
identity, consented feedback, credentials, and the integrity of numerical results. Trust
boundaries exist at the public HTTP edge, Agent/tool boundary, embedding provider,
Qdrant, PostgreSQL, CI, secret store, and human approval process.

## Principal threats and controls

| Threat | Control | Failure behavior |
|---|---|---|
| Prompt injection or requests to invent values | deterministic tools, integrity classifier, approved-only retrieval | refuse or return unavailable |
| Unapproved/poisoned retrieval content | Qdrant metadata filters plus validated payload provenance | discard result |
| Forged approval | canonical SHA-256, named role, evidence reference, append-only records | approval invalid |
| SQL injection | parameterized PostgreSQL queries; no user-selected SQL identifiers | request fails |
| SSRF/configuration substitution | strict HTTP(S), HTTPS and non-loopback production validation | startup fails |
| Credential or question leakage | secret-bound configuration; allowlisted structured logs; no raw body/message | redact/drop field |
| Cross-origin abuse and flooding | origin allowlist, body limit, timeout and rate limit | 403/413/429/504 |
| Dependency outage | live readiness checks and alerts | readiness 503 |
| Rollback to incompatible state | immutable image digest and backward-compatibility evidence | rollback blocked |
| Unauthorized retention deletion | dry-run default; explicit authorization/evidence; staging/DB controls | transaction fails |

## Residual risks

Human collusion, compromised reviewer accounts, provider compromise, and host-level
compromise require organization controls: MFA, separation of duties, audit-log export,
network isolation, key rotation, and incident response. These must be verified in the
selected hosting environment before production approval.
