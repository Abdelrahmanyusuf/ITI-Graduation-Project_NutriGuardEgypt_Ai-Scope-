# Reviewer Queues and Sign-off Packets

`npm run production:packets` deterministically creates pending work queues for ingredient
mappings, unit conversions, cooking factors, source licenses, Egyptian cultural evidence,
nutrient-retention factors, nutrient profiles, recipe serving/yield, and Safety/QA. It cannot approve anything.

For every item, the reviewer must record:

1. stable subject type and key;
2. SHA-256 of the exact reviewed canonical content;
3. decision and rationale;
4. named reviewer ID and authorized role;
5. offset-aware review timestamp;
6. durable evidence reference; and
7. superseded approval ID when applicable.

An approval is accepted only when it references a separate, active reviewer authorization
covering the exact subject type, subject-key prefix, qualification, and review date. Reviewer
authorizations and revocations are append-only; a revoked authorization cannot sign later
records.

## Runtime subject-key contract

Production queries use the latest decision for each exact key; a later rejection overrides
an older approval.

- Recipe: the stable `recipe_key`.
- Ingredient mapping: the stable `ingredient_key`.
- Recipe serving/yield: `recipe_serving_yield:<recipe_key>`.
- Nutrient profile: `nutrient_profile:<ingredient_key>:<food_state>`, using
  `unspecified` only for a genuine null state.
- Unit conversion: `unit_conversion:<ingredient_unit_conversions.id>`.
- Source license: the stable `source_key`.
- Cultural evidence: the stable `evidence_key`.
- Guideline: the stable `document_key`.

The approval hash must cover the complete canonical subject reviewed under that key. Status
columns alone never make a record eligible for the production PostgreSQL adapter.

Safety/QA additionally reviews medical wording, emergency routing, numerical provenance,
Egyptian-Arabic comprehension, prompt injection, and refusal when data is missing. Safety,
privacy/security, data-owner, and release-owner decisions must be made by separate authorized
people where organization policy requires separation of duties.
