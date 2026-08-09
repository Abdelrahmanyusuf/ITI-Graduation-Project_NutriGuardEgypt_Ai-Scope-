# Platform-neutral deployment package

The environment examples define the contract for any container platform. Secrets are
placeholders and must come from its secret manager. `compose.staging.yml` demonstrates a
non-root, read-only, capability-free staging deployment but does not include default database,
Qdrant, or provider credentials. Apply migrations explicitly before rollout, ingest only the
approved corpus, mount the signed release-evidence manifest read-only, then require readiness
and smoke checks. Use `docs/RELEASE_CHECKLISTS.md` and `docs/OPERATIONS_AND_RECOVERY.md`.
