# Staging and Production Release Checklists

## Staging

- [ ] Approved recipes, nutrient profiles, guideline corpus, licenses, and cultural evidence
- [ ] Real embedding benchmark selects the configured provider/model
- [ ] PostgreSQL migration 0003 applied; Qdrant approved namespace ingested explicitly
- [ ] Secrets supplied by a secret manager and rotation owner named
- [ ] Safety/QA, privacy/security, and data-owner approvals hash-match reviewed content
- [ ] Nutrition, Egyptian-cultural and legal/license reviewer authorizations and approvals hash-match reviewed content
- [ ] Consent, privacy notice, retention owner, incident contacts, monitoring, backup and restore drill
- [ ] Smoke test passes against exact release ID; rollback plan uses an immutable image digest

## Production

- [ ] All staging items plus 50–100 consented real-user questions and reviewed results
- [ ] Real pilot has signed feedback, no open critical incident, and successful rollback drill
- [ ] Release owner approves exact commit, image digest, evidence manifest, and environment
- [ ] Hosting backup/restore, Qdrant recovery, alerts, on-call, rollback, and incident exercises pass
- [ ] DNS/TLS, production accounts, least privilege, MFA, audit export, retention and provider contracts verified

Unchecked items are blockers. Templates and local tests are not evidence that a real drill or
human review occurred.

Every evidence object in the release manifest must contain a unique ID, a safe path relative
to the manifest directory, and the SHA-256 of the actual evidence file. Startup and both
release-check commands resolve the real file, reject directory escape/symlink escape, and
compare its bytes. A declared hash without its matching file cannot open the release gate.
