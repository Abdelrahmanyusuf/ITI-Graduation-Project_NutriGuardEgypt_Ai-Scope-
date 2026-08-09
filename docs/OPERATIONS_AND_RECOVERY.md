# Operations, Backup, Recovery, Smoke, and Rollback

All mutation-oriented commands are deliberately restricted to `DEPLOYMENT_TARGET=staging`.
Production execution requires the hosting owner to copy the reviewed procedure into the
platform change process and provide an approved maintenance window.

## PostgreSQL

- Backup: `npm run ops -- postgres-backup <absolute-or-controlled-path>.dump`.
- The command uses the custom dump format, excludes ownership/privileges, and writes a
  SHA-256 sidecar using create-only semantics.
- Restore: create an empty disposable database named `nutriguard_restore_*`, then run
  `npm run ops -- postgres-restore <dump> <target-url>`.
- Validate migrations, foreign keys, representative null-versus-zero values, row counts,
  release evidence, and application smoke tests. Destroy the disposable target only after
  evidence is signed according to the hosting process.

## Qdrant

- Create: `npm run ops -- qdrant-snapshot`.
- Recover: `npm run ops -- qdrant-recover <https-snapshot-url> <exact-collection-name>`.
- Recovery is staging-only, requires HTTPS and an exact collection confirmation. Validate
  vector count, embedding dimension, corpus namespace, approved-only filters, and benchmark.

## Deployment and rollback

Run `npm run ops -- smoke <base-url> <release-id>` after deployment. Both `/health` and
`/ready` must return 200 and the exact release ID. A rollback plan must identify the
previous immutable image digest, prove database backward compatibility, and carry rollback
owner approval. Never roll back database migrations merely because an application image was
rolled back; use the reviewed migration runbook and a verified backup.
