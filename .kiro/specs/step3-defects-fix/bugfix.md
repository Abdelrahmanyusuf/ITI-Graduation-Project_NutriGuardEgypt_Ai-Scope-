# Bugfix Requirements Document

## Introduction

The NutriGuardEgypt Step 3 staging pipeline has several remaining defects that
cause `npm run stage` to exit non-zero for the wrong reason (registry is invalid)
instead of the correct honest reason (0 eligible recipes). The real
`data/staging/recipes.json` is schema-v1.0 and fails validation against the
current v2.0 schema because it is missing `sourceFingerprint`, the timeline entry
lacks `evidenceIds`, and several other required fields. Additionally, TypeScript
type errors in `stage-recipes.ts` prevent the project from type-checking cleanly.
The source-drift lifecycle needs completing so that drift detection, human
re-review, and subsequent stable runs all work end-to-end. Snapshot validation
(SHA-256 format enforcement, `original` object presence, fingerprint matching)
must be strengthened. Machine-owned provenance/license fields must be
reconciled from the manifest on every import so reviewers never hand-edit them.
Regression tests and updated documentation are required.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN `npm run stage` runs against the real registry (`data/staging/recipes.json`)
    that was created with schema v1.0 THEN the system reports the registry as
    invalid due to missing `sourceFingerprint` and missing `evidenceIds` in
    timeline entries, causing a non-zero exit for the wrong reason.

1.2 WHEN `npm run type-check` runs THEN the system reports 14 TypeScript errors in
    `stage-recipes.ts` because: `migrated.timeline` does not exist on
    `StagedRecipe`, `isNonBlankString` is not imported/exported, and
    `migrateLegacyRegistry`/`validateStagedRecipe` are declared but never used.

1.3 WHEN a legacy registry record (v1.0 shape) lacking `sourceFingerprint`,
    `timeline[*].evidenceIds`, `review.snapshotFingerprint`, `review.staleReason`,
    and `source.sourceRowCount` is loaded THEN the system fails validation on every
    missing field instead of migrating those fields deterministically from the
    freshly imported raw CSV row.

1.4 WHEN the manifest transitions from `review_status: pending` to
    `review_status: approved` (or a license is approved) THEN the system does not
    refresh the staged record's `source.sourceId`, `source.sourceVersion`,
    `source.accessDate`, `source.url`, and `license.*` fields, leaving stale
    machine-owned provenance/license data in the registry.

1.5 WHEN source drift is detected after a human review THEN the system routes
    the record back to `needs_review` but does not update the record's `original`
    row, `sourceFingerprint`, source metadata, and other machine-derived fields to
    the new imported snapshot, so a subsequent human re-review still binds to the
    old snapshot fingerprint.

1.6 WHEN a recipe record has a `sourceFingerprint` value that is not a valid
    SHA-256 (not exactly 64 lowercase hex characters) THEN the system accepts it
    without error.

1.7 WHEN a recipe record has `original` set to a non-object value (e.g. missing
    or a string) THEN the system accepts it without error.

1.8 WHEN a recipe's stored `sourceFingerprint` does not match the SHA-256 recomputed
    from the current raw CSV row that backs it THEN the system accepts the mismatch
    without error (no fingerprint-match validation against the live raw row).

### Expected Behavior (Correct)

2.1 WHEN `npm run stage` runs against the real registry THEN the system SHALL
    migrate legacy records deterministically before validation, producing a
    structurally valid registry that exits non-zero only because 0 recipes are
    eligible (not because the registry is invalid).

2.2 WHEN `npm run type-check` runs THEN the system SHALL exit zero with no
    TypeScript errors by removing dead code (`migrateLegacyRegistry`,
    `validateStagedRecipe` in `stage-recipes.ts`), removing the non-existent
    `migrated.timeline` reference, and ensuring `isNonBlankString` is available
    where used.

2.3 WHEN a legacy registry record lacking required v2.0 fields is encountered on
    import THEN the system SHALL migrate it deterministically: populate
    `sourceFingerprint` from the matching freshly imported raw row fingerprint (or
    an empty string as a sentinel if the row cannot be found), populate
    `timeline[*].evidenceIds` as `[]` for every pipeline event that lacks it,
    populate `review.snapshotFingerprint` as `null` if absent, populate
    `review.staleReason` as `null` if absent, and populate `source.sourceRowCount`
    if absent. The migration MUST preserve all existing human-curated values and
    all historical review events.

2.4 WHEN the manifest's `review_status` or license metadata changes between runs
    THEN the system SHALL reconcile the staged record's machine-owned provenance
    fields (`source.sourceId`, `source.sourceVersion`, `source.accessDate`,
    `source.url`, `license.status`, `license.id`, `license.url`, `license.note`)
    from the current manifest on every import, without requiring a reviewer to
    hand-edit those fields. Reviewer-owned fields (decision, reviewerId,
    reviewDate, evidenceIds, rationale, snapshotFingerprint, staleReason,
    timeline) SHALL be preserved separately.

2.5 WHEN source drift is detected after a human review THEN the system SHALL
    preserve the old human decision and its fingerprint in the timeline/history,
    route the record to `needs_review`, AND update the record's `original` row,
    `sourceFingerprint`, and source metadata to the newly imported snapshot so
    that a subsequent human re-review binds to the new fingerprint. After a
    human re-reviews with the new fingerprint, the following unchanged staging run
    SHALL keep the record `verified` and not route it back to review again.

2.6 WHEN a recipe record has a `sourceFingerprint` that is present but is not a
    valid SHA-256 (not exactly 64 lowercase hex characters) THEN the system SHALL
    report a validation issue and the record SHALL NOT be eligible.

2.7 WHEN a recipe record's `original` is absent or is not a plain object THEN the
    system SHALL report a validation issue and the record SHALL NOT be eligible.

2.8 WHEN a recipe record is backed by the currently imported raw CSV row and its
    stored `sourceFingerprint` does not match the recomputed fingerprint of that
    row THEN the system SHALL report a validation issue and the record SHALL NOT be
    eligible. This check SHALL NOT apply to curated records whose `source.sourceFile`
    does not point to the current raw CSV.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN the registry contains records with a valid human review (reviewer +
    strict ISO date + evidence + rationale + snapshotFingerprint) that are backed
    by a currently-matching raw row fingerprint THEN the system SHALL CONTINUE TO
    keep those records `verified` and eligible on every subsequent run.

3.2 WHEN `npm run stage` runs and the raw CSV source does not change THEN the
    system SHALL CONTINUE TO produce byte-identical output files across repeated
    runs (deterministic output).

3.3 WHEN a curated record (sourceFile not pointing to the current raw CSV) is
    present in the registry THEN the system SHALL CONTINUE TO carry it over
    without applying current-raw-row fingerprint matching, preserving its
    source-drift behaviour for records that do have a `snapshotFingerprint`.

3.4 WHEN `npm run stage` runs and records have `review.autoRejected = true` THEN
    the system SHALL CONTINUE TO treat those as pipeline-rejected records without
    human reviewer fields.

3.5 WHEN a record has a `review.staleReason` already set (already routed to review)
    THEN the system SHALL CONTINUE TO skip further source-drift routing for that
    record, avoiding duplicate drift events.

3.6 WHEN `npm test` runs THEN the system SHALL CONTINUE TO pass all existing tests
    that currently pass, with no regressions.

3.7 WHEN `npm run lint` runs THEN the system SHALL CONTINUE TO exit zero with no
    linting errors.

3.8 WHEN `npm run build` runs THEN the system SHALL CONTINUE TO exit zero and
    produce a valid dist output.

3.9 WHEN `npm run docs:check` runs THEN the system SHALL CONTINUE TO exit zero
    with all documentation links valid.

---

## Bug Condition Pseudocode

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type StagedRegistryRecord
  OUTPUT: boolean

  // Bug triggers when a record is in the registry but its schema v1.0 shape
  // fails the v2.0 validation — caused by missing sourceFingerprint,
  // missing timeline evidenceIds, or TypeScript errors that prevent type-check
  RETURN (
    (X.sourceFingerprint is null OR X.sourceFingerprint = "") OR
    (EXISTS i: X.review.timeline[i].evidenceIds is NOT an array) OR
    (TypeScript type errors exist in stage-recipes.ts) OR
    (machine-owned provenance fields are stale after manifest update) OR
    (sourceFingerprint is present but NOT /^[0-9a-f]{64}$/) OR
    (X.original is absent OR is NOT a plain object) OR
    (X is backed by live raw row AND recomputed_fp(X) != X.sourceFingerprint)
  )
END FUNCTION

// Property: Fix Checking — after the fix, migrated registry passes validation
FOR ALL X WHERE isBugCondition(X) DO
  result ← stageRecipes'(X)
  ASSERT result.valid = true
  ASSERT result.exitCode ≠ 0 ONLY BECAUSE eligible = 0
END FOR

// Property: Preservation Checking — non-buggy inputs behave identically
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT stageRecipes(X) = stageRecipes'(X)
END FOR
```
