# Production deployment and rollback runbook

## Mandatory preflight

1. Pin the exact commit and build the container from the clean repository.
2. Run all tests plus a real PostgreSQL migration/rollback rehearsal.
3. Run `npm run release:check:production` against the reviewed evidence
   manifest. A non-zero exit blocks deployment.
4. Confirm synthetic/demo flags and test fixtures are absent from production.
5. Verify secret-manager references, least-privilege database/vector accounts,
   TLS, allowed origins, retention job, backups, alerts, and on-call ownership.

## Deployment

- Apply migrations once using a dedicated migration identity.
- Deploy by immutable image digest and release ID; never by a mutable tag alone.
- Keep the previous image and schema-compatible rollback path available.
- Require `/health` to answer and `/ready` to stay green before traffic.
- Start with a small traffic slice, monitor errors/latency/safety events, then
  increase gradually under release-owner approval.

## Monitoring

Monitor request volume, rate limiting, latency, 4xx/5xx, readiness, retrieval
no-result/ambiguity, calculator unavailable/partial results, safety and
integrity routes, feedback volume, and database/vector health. Never log raw
questions, medical details, credentials, full response bodies, or consent data.

## Rollback

1. Stop traffic growth and declare the incident/release owner.
2. Roll back the application image first when migrations remain compatible.
3. Run down migrations only after impact review and backup verification; pilot
   feedback is append-only and must not be silently erased.
4. Re-run health/readiness and deterministic smoke scenarios.
5. Record root cause, affected release/data/prompt versions, remediation, and a
   regression test before redeployment.

## Backup and incident response

Exercise encrypted database backup/restore before release. Rotate compromised
credentials, preserve minimal audit evidence, notify the privacy/security owner,
and follow legal notification duties. See [security and privacy](./SECURITY_PRIVACY.md).

This runbook is deployment readiness, not proof that a production deployment
has occurred. Actual deployment requires the evidence gate and owner action.
