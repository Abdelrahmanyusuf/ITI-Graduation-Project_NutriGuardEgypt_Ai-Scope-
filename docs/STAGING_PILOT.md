# Staging pilot protocol

## Entry gate

Before recruitment, run `npm run release:check:staging` with
`NUTRIGUARD_RELEASE_EVIDENCE` pointing to the reviewed evidence manifest. The
gate must be green. Do not bypass it with synthetic files or environment flags.

## Participants and consent

- Recruit at least five adults able to understand the pilot notice.
- Do not recruit children or request medical diagnoses, medications, allergy
  histories, pregnancy information, names, emails, or other direct identifiers.
- Record the approved consent-document identifier outside the browser and
  configure it on the server. Participants must actively accept before rating.
- Allow withdrawal under the approved privacy notice and retention policy.
  Ordinary application deletion remains blocked; an authorized privacy process
  uses a transaction-local `nutriguard.privacy_erasure=approved` setting with a
  separately permissioned database identity and records the erasure audit.

## Pilot procedure

1. Assign a random session ID; do not reuse an account identifier.
2. Ask participants to try the reviewed scenario list, including no-result and
   safety examples. Do not tell them to seek personal medical advice.
3. Collect rating, comprehension yes/no, and an optional 500-character comment.
4. Review failures daily. Stop immediately for fabricated numbers, leaked
   unapproved data, unsafe medical guidance, consent failure, or security issue.
5. Produce a signed pilot report with participant/feedback counts, themes,
   incident severity, fixes, regression IDs, and release recommendation.

## Exit criteria

- At least five consented participants and five valid feedback records.
- No open critical safety, privacy, security, provenance, or numeric defect.
- Every accepted fix has a regression test and an updated prompt/retrieval/data
  version where applicable.
- Safety/QA, privacy/security, data owner, and release owner approve the report.

Completing this document or running synthetic tests does not complete Step 19;
the signed real pilot evidence is required.
