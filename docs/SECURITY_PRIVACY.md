# Security and privacy controls

- Strict JSON schemas, 16 KiB request limit, 2,000-character message limit,
  request timeout, per-address rate limiting, exact origin allow-list, and
  content-type/method enforcement.
- CSP, frame denial, MIME sniffing denial, restricted browser permissions,
  referrer suppression, no-store API caching, and HSTS in production.
- No generated SQL, no data writes from the Agent, approved-only retrieval,
  deterministic numeric tools, pre-retrieval safety/integrity routing, and
  redacted server errors.
- Feedback stores randomized session/request IDs, rating, comprehension,
  optional short comment, server-owned consent/privacy versions, release,
  prompt version, and timestamp. It excludes names, emails, questions, answers,
  and medical fields. Update and ordinary deletion are blocked. A narrowly
  authorized transaction-local privacy-erasure route supports withdrawal and
  retention duties; the application database identity must not receive DELETE.
- Secrets stay in the deployment secret manager. Logs must contain request ID,
  route, status, duration, release, and coarse safety/integrity outcome only.
- Production requires reviewed retention/deletion, access-control, backup,
  incident, dependency-vulnerability, and legal/privacy processes.
