-- ============================================================================
-- NutriGuard Step 4 — SYNTHETIC seed data (TEST-ONLY; NEVER production data)
--
-- These rows are explicitly synthetic: fabricated example values used ONLY to
-- exercise the schema, foreign keys, constraints, the composite
-- (source_id, data_version_id) provenance pinning, and the integration test.
-- They are NOT real food-composition data and must be overwritten by the real
-- verified import pipeline before any user-facing nutrition value exists.
--
-- The synthetic source is registered with source_key = 'SYNTHETIC-FIXTURE' and
-- review_status = 'rejected' so that it can never be mistaken for, or promoted
-- to, an approved provenance source. It is not imported automatically.
--
-- IMPORTANT transaction-ownership rule: this file does NOT wrap itself in
-- BEGIN/COMMIT. The seed loader (src/data/seed.ts) is the single owner of the
-- surrounding transaction.
-- ============================================================================

INSERT INTO sources (source_key, title, publisher, review_status, notes)
VALUES (
  'SYNTHETIC-FIXTURE',
  'Synthetic test fixture (NOT real Egyptian food data)',
  'NutriGuard tests',
  'rejected',
  'Explicit synthetic fixture for integration tests. Not approved, never user-facing.'
);

INSERT INTO data_versions (source_id, version_label, scope, notes)
SELECT id, 'v-synthetic-1', 'integration-test', 'synthetic only'
FROM sources WHERE source_key = 'SYNTHETIC-FIXTURE';

INSERT INTO units (unit_code, name_en, dimension, source_id, data_version_id)
SELECT 'g', 'gram', 'mass', s.id, dv.id
FROM sources s, data_versions dv
WHERE s.source_key = 'SYNTHETIC-FIXTURE' AND dv.version_label = 'v-synthetic-1';

INSERT INTO units (unit_code, name_en, dimension, source_id, data_version_id)
SELECT 'ml', 'millilitre', 'volume', s.id, dv.id
FROM sources s, data_versions dv
WHERE s.source_key = 'SYNTHETIC-FIXTURE' AND dv.version_label = 'v-synthetic-1';

INSERT INTO ingredients (ingredient_key, name_en, name_ar, food_state, verification_status, source_id, data_version_id)
SELECT 'ING-FIX-001', 'lentils', 'عدس', 'raw', 'approved', s.id, dv.id
FROM sources s, data_versions dv
WHERE s.source_key = 'SYNTHETIC-FIXTURE' AND dv.version_label = 'v-synthetic-1';

INSERT INTO recipes (recipe_key, name_en, name_ar, food_state, verification_status, original_row, source_id, data_version_id)
SELECT 'EGR-FIX-001', 'fixture koshari', 'كشري', 'cooked', 'verified', '{"synthetic":true,"note":"fixture only"}'::jsonb, s.id, dv.id
FROM sources s, data_versions dv
WHERE s.source_key = 'SYNTHETIC-FIXTURE' AND dv.version_label = 'v-synthetic-1';