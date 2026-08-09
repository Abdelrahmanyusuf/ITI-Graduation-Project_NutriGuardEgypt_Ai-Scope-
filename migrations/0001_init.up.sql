-- ============================================================================
-- NutriGuard Step 4 — PostgreSQL schema and provenance
--
-- Migration: 0001_init
-- Direction: up
--
-- IMPORTANT transaction-ownership rule: this file does NOT wrap itself in
-- BEGIN/COMMIT. The migration runner (src/data/database.ts) is the single
-- owner of the surrounding transaction, so a partial apply can never be left
-- behind. Running the file directly through psql still works (each statement
-- is autocommitted) and a completely empty database is bootstrapped because
-- the runner creates schema_migrations before it queries the ledger.
--
-- Design invariants:
--  1. Missing values are NULL, never an invented zero. A real measured zero is
--     stored as 0 (distinct from NULL). Numeric CHECKs reject only impossible
--     negatives; they never coerce NULL into 0.
--  2. Every numerical record carries provenance (source_id) and a version
--     (data_version_id). The two are enforced TOGETHER: a record's version must
--     belong to the SAME source as the record (composite FK against
--     data_versions(source_id, id)), so a version can never be attached to a
--     record of a different source.
--  3. Original source values/units/context are preserved verbatim in
--     original_* columns next to normalized machine values.
--  4. Food state is a constrained text domain (raw/cooked/boiled/fried/baked/
--     drained). Uniqueness that includes a nullable food_state uses an
--     expression index (COALESCE to '') so NULL is treated as one distinct
--     value instead of Postgres's "NULLs are all distinct" semantics.
--  5. Quantitative guideline recommendations live in guideline_rules
--     (metric/operator/value/unit); explanatory text lives in guideline_chunks.
--  6. Review records use stable, enforceable foreign keys (typed target
--     columns, exactly one target per row) instead of an orphanable
--     polymorphic (reviewable_type, reviewable_key) pair.
--  7. Verification/approval status is a constrained status column; nothing here
--     imports unverified production data automatically — seeding is explicit.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Migration bookkeeping (used by the migration runner; not a domain table).
-- The runner also ensures this exists before querying the ledger, so running
-- on a completely empty database is safe.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    text PRIMARY KEY,
  name       text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Provenance
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sources (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_key           text NOT NULL UNIQUE,
  title                text,
  publisher            text,
  url                  text,
  file_path            text,
  visible_date         date,
  version_label        text,
  access_date          date,
  license              text,
  license_url          text,
  review_status        text NOT NULL DEFAULT 'pending'
                       CHECK (review_status IN ('pending', 'approved', 'rejected')),
  reviewed_by          text,
  review_date          date,
  license_review_status text
                       CHECK (license_review_status IN ('pending', 'approved', 'rejected')),
  license_reviewed_by  text,
  license_review_date  date,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sources_review_status_idx ON sources (review_status);

-- data_versions exposes (source_id, id) as a UNIQUE key so that record tables
-- can use a composite FK that pins a record's version to its own source.
CREATE TABLE IF NOT EXISTS data_versions (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id      bigint NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  version_label  text NOT NULL,
  scope          text NOT NULL,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, version_label),
  UNIQUE (source_id, id)
);

-- ---------------------------------------------------------------------------
-- Units
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS units (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unit_code       text NOT NULL UNIQUE,
  name_en         text,
  name_ar         text,
  dimension       text NOT NULL CHECK (dimension IN ('mass', 'volume', 'count')),
  base_unit_id    bigint REFERENCES units (id),
  factor_to_base  numeric CHECK (factor_to_base IS NULL OR factor_to_base > 0),
  source_id       bigint REFERENCES sources (id),
  data_version_id bigint,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT units_version_source_fk
    FOREIGN KEY (source_id, data_version_id) REFERENCES data_versions (source_id, id) MATCH FULL,
  CHECK (base_unit_id IS NULL OR (base_unit_id <> id)),
  CONSTRAINT units_provenance_pair CHECK (
    (source_id IS NULL AND data_version_id IS NULL)
    OR (source_id IS NOT NULL AND data_version_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS unit_aliases (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unit_id         bigint NOT NULL REFERENCES units (id) ON DELETE CASCADE,
  alias           text NOT NULL,
  language        text NOT NULL DEFAULT 'en',
  normalized      text NOT NULL,
  UNIQUE (unit_id, language, normalized)
);

-- ---------------------------------------------------------------------------
-- Ingredients
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingredients (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ingredient_key     text NOT NULL UNIQUE,
  name_en            text NOT NULL,
  name_ar            text,
  name_eg            text,
  category           text,
  food_state         text
                     CHECK (food_state IN ('raw', 'cooked', 'boiled', 'fried', 'baked', 'drained')),
  original_text      text,
  verification_status text NOT NULL DEFAULT 'needs_review'
                     CHECK (verification_status IN ('needs_review', 'approved', 'rejected')),
  source_id          bigint REFERENCES sources (id),
  data_version_id    bigint,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ingredients_version_source_fk
    FOREIGN KEY (source_id, data_version_id) REFERENCES data_versions (source_id, id) MATCH FULL,
  CONSTRAINT ingredients_provenance_pair CHECK (
    (source_id IS NULL AND data_version_id IS NULL)
    OR (source_id IS NOT NULL AND data_version_id IS NOT NULL)
  )
);

-- Uniqueness over (name_en, food_state) where food_state may be NULL: COALESCE
-- turns NULL into '' so two rows with the same name_en and NULL food_state are
-- rejected, while a real NULL and a real state remain distinct.
CREATE UNIQUE INDEX IF NOT EXISTS ingredients_name_state_key
  ON ingredients (name_en, COALESCE(food_state, ''));
CREATE INDEX IF NOT EXISTS ingredients_food_state_idx ON ingredients (food_state);

CREATE TABLE IF NOT EXISTS ingredient_aliases (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ingredient_id   bigint NOT NULL REFERENCES ingredients (id) ON DELETE CASCADE,
  alias           text NOT NULL,
  language        text NOT NULL DEFAULT 'en',
  normalized      text NOT NULL,
  UNIQUE (ingredient_id, language, normalized)
);

-- ---------------------------------------------------------------------------
-- Recipes (Egyptian staging registry; provenance preserved)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recipes (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipe_key               text NOT NULL UNIQUE,
  name_ar                  text,
  name_en                  text,
  name_eg                  text,
  category                 text,
  subcategory              text,
  region                   text,
  servings                 numeric CHECK (servings IS NULL OR servings > 0),
  final_cooked_weight_g    numeric CHECK (final_cooked_weight_g IS NULL OR final_cooked_weight_g > 0),
  food_state               text
                           CHECK (food_state IN ('raw', 'cooked', 'boiled', 'fried', 'baked', 'drained')),
  source_row               integer CHECK (source_row IS NULL OR source_row >= 1),
  source_id                bigint REFERENCES sources (id),
  data_version_id          bigint,
  verification_status      text NOT NULL DEFAULT 'needs_review'
                           CHECK (verification_status IN ('needs_review', 'verified', 'rejected')),
  nutrition_calculation_status text
                           CHECK (nutrition_calculation_status IN ('unavailable', 'partial', 'complete')),
  original_title           text,
  original_row             jsonb NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recipes_version_source_fk
    FOREIGN KEY (source_id, data_version_id) REFERENCES data_versions (source_id, id) MATCH FULL,
  CONSTRAINT recipes_provenance_pair CHECK (
    (source_id IS NULL AND data_version_id IS NULL)
    OR (source_id IS NOT NULL AND data_version_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS recipes_verification_idx ON recipes (verification_status);
CREATE INDEX IF NOT EXISTS recipes_source_idx ON recipes (source_id);

CREATE TABLE IF NOT EXISTS recipe_aliases (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipe_id    bigint NOT NULL REFERENCES recipes (id) ON DELETE CASCADE,
  alias        text NOT NULL,
  language     text NOT NULL DEFAULT 'en',
  normalized   text NOT NULL,
  UNIQUE (recipe_id, language, normalized)
);

-- ---------------------------------------------------------------------------
-- Recipe <-> ingredient linking with preserved original text + quantities
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recipe_ingredients (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipe_id          bigint NOT NULL REFERENCES recipes (id) ON DELETE CASCADE,
  ingredient_id      bigint NOT NULL REFERENCES ingredients (id),
  sort_order         integer NOT NULL DEFAULT 0,
  original_text      text NOT NULL,
  raw_quantity       text,
  raw_unit           text,
  quantity           numeric CHECK (quantity IS NULL OR quantity >= 0),
  unit_id            bigint REFERENCES units (id),
  food_state         text
                     CHECK (food_state IN ('raw', 'cooked', 'boiled', 'fried', 'baked', 'drained')),
  source_id          bigint REFERENCES sources (id),
  data_version_id    bigint,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recipe_ingredients_version_source_fk
    FOREIGN KEY (source_id, data_version_id) REFERENCES data_versions (source_id, id) MATCH FULL,
  CONSTRAINT recipe_ingredients_provenance_pair CHECK (
    (source_id IS NULL AND data_version_id IS NULL)
    OR (source_id IS NOT NULL AND data_version_id IS NOT NULL)
  ),
  UNIQUE (recipe_id, ingredient_id, sort_order)
);

CREATE INDEX IF NOT EXISTS recipe_ingredients_ingredient_idx ON recipe_ingredients (ingredient_id);
CREATE INDEX IF NOT EXISTS recipe_ingredients_unit_idx ON recipe_ingredients (unit_id);

-- ---------------------------------------------------------------------------
-- Nutrition values (per-basis, provenance + version)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nutrient_values (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ingredient_id      bigint NOT NULL REFERENCES ingredients (id) ON DELETE CASCADE,
  nutrient           text NOT NULL,
  food_state         text
                     CHECK (food_state IN ('raw', 'cooked', 'boiled', 'fried', 'baked', 'drained')),
  amount             numeric CHECK (amount IS NULL OR amount >= 0),
  unit_id            bigint REFERENCES units (id),
  basis              text NOT NULL DEFAULT 'per_100g'
                     CHECK (basis IN ('per_100g', 'per_serving', 'per_unit', 'per_edible_100g')),
  original_value     text,
  source_id          bigint REFERENCES sources (id),
  data_version_id    bigint,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT nutrient_values_version_source_fk
    FOREIGN KEY (source_id, data_version_id) REFERENCES data_versions (source_id, id) MATCH FULL,
  CONSTRAINT nutrient_values_provenance_pair CHECK (
    (source_id IS NULL AND data_version_id IS NULL)
    OR (source_id IS NOT NULL AND data_version_id IS NOT NULL)
  )
);

-- Uniqueness with a nullable food_state (see ingredients_name_state_key).
CREATE UNIQUE INDEX IF NOT EXISTS nutrient_values_ing_nutrient_state_basis_key
  ON nutrient_values (ingredient_id, nutrient, COALESCE(food_state, ''), basis);
CREATE INDEX IF NOT EXISTS nutrient_values_nutrient_idx ON nutrient_values (nutrient);

-- ---------------------------------------------------------------------------
-- Conversions, yield and retention (deterministic, sourced factors).
-- Original source values/units/context are preserved in original_* columns.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingredient_unit_conversions (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ingredient_id      bigint NOT NULL REFERENCES ingredients (id) ON DELETE CASCADE,
  from_unit_id       bigint NOT NULL REFERENCES units (id),
  to_unit_id         bigint NOT NULL REFERENCES units (id),
  food_state         text
                     CHECK (food_state IN ('raw', 'cooked', 'boiled', 'fried', 'baked', 'drained')),
  factor             numeric NOT NULL CHECK (factor > 0),
  original_value     text,
  original_from_unit text,
  original_to_unit   text,
  original_context   text,
  source_id          bigint REFERENCES sources (id),
  data_version_id    bigint,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ingredient_unit_conversions_version_source_fk
    FOREIGN KEY (source_id, data_version_id) REFERENCES data_versions (source_id, id) MATCH FULL,
  CONSTRAINT ingredient_unit_conversions_provenance_pair CHECK (
    (source_id IS NULL AND data_version_id IS NULL)
    OR (source_id IS NOT NULL AND data_version_id IS NOT NULL)
  ),
  CHECK (from_unit_id <> to_unit_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ingredient_unit_conversions_units_state_key
  ON ingredient_unit_conversions (ingredient_id, from_unit_id, to_unit_id, COALESCE(food_state, ''));

CREATE TABLE IF NOT EXISTS cooking_yield_factors (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ingredient_id      bigint NOT NULL REFERENCES ingredients (id) ON DELETE CASCADE,
  food_state_from    text NOT NULL
                     CHECK (food_state_from IN ('raw', 'cooked', 'boiled', 'fried', 'baked', 'drained')),
  food_state_to      text NOT NULL
                     CHECK (food_state_to IN ('raw', 'cooked', 'boiled', 'fried', 'baked', 'drained')),
  yield_factor       numeric NOT NULL CHECK (yield_factor > 0),
  original_yield     text,
  original_context   text,
  source_id          bigint REFERENCES sources (id),
  data_version_id    bigint,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cooking_yield_factors_version_source_fk
    FOREIGN KEY (source_id, data_version_id) REFERENCES data_versions (source_id, id) MATCH FULL,
  CONSTRAINT cooking_yield_factors_provenance_pair CHECK (
    (source_id IS NULL AND data_version_id IS NULL)
    OR (source_id IS NOT NULL AND data_version_id IS NOT NULL)
  ),
  UNIQUE (ingredient_id, food_state_from, food_state_to),
  CHECK (food_state_from <> food_state_to)
);

CREATE TABLE IF NOT EXISTS nutrient_retention_factors (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nutrient           text NOT NULL,
  process            text NOT NULL,
  retention_factor   numeric NOT NULL CHECK (retention_factor >= 0 AND retention_factor <= 1),
  original_retention text,
  original_context   text,
  source_id          bigint REFERENCES sources (id),
  data_version_id    bigint,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT nutrient_retention_factors_version_source_fk
    FOREIGN KEY (source_id, data_version_id) REFERENCES data_versions (source_id, id) MATCH FULL,
  CONSTRAINT nutrient_retention_factors_provenance_pair CHECK (
    (source_id IS NULL AND data_version_id IS NULL)
    OR (source_id IS NOT NULL AND data_version_id IS NOT NULL)
  ),
  UNIQUE (nutrient, process)
);

-- ---------------------------------------------------------------------------
-- Guidelines: documents (provenance), chunks (text), rules (quantitative)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS guideline_documents (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_key       text NOT NULL UNIQUE,
  organization       text NOT NULL,
  title              text NOT NULL,
  url                text,
  published_date     date,
  version            text,
  source_status      text NOT NULL DEFAULT 'under_review'
                     CHECK (source_status IN ('active', 'superseded', 'under_review', 'rejected')),
  source_review_date date,
  expiration_date    date,
  license            text,
  source_id          bigint REFERENCES sources (id),
  data_version_id    bigint,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guideline_documents_version_source_fk
    FOREIGN KEY (source_id, data_version_id) REFERENCES data_versions (source_id, id) MATCH FULL,
  CONSTRAINT guideline_documents_provenance_pair CHECK (
    (source_id IS NULL AND data_version_id IS NULL)
    OR (source_id IS NOT NULL AND data_version_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS guideline_documents_org_idx ON guideline_documents (organization);
CREATE INDEX IF NOT EXISTS guideline_documents_status_idx ON guideline_documents (source_status);

CREATE TABLE IF NOT EXISTS guideline_chunks (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id         bigint NOT NULL REFERENCES guideline_documents (id) ON DELETE CASCADE,
  chunk_index         integer NOT NULL CHECK (chunk_index >= 0),
  section             text,
  page                integer CHECK (page IS NULL OR page >= 1),
  topic               text,
  content             text NOT NULL,
  raw_content         text,
  content_hash        text NOT NULL,
  ocr_noise_detected  boolean NOT NULL DEFAULT false,
  source_id           bigint REFERENCES sources (id),
  data_version_id     bigint,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guideline_chunks_version_source_fk
    FOREIGN KEY (source_id, data_version_id) REFERENCES data_versions (source_id, id) MATCH FULL,
  CONSTRAINT guideline_chunks_provenance_pair CHECK (
    (source_id IS NULL AND data_version_id IS NULL)
    OR (source_id IS NOT NULL AND data_version_id IS NOT NULL)
  ),
  UNIQUE (document_id, chunk_index),
  UNIQUE (document_id, id)
);

CREATE INDEX IF NOT EXISTS guideline_chunks_topic_idx ON guideline_chunks (topic);

CREATE TABLE IF NOT EXISTS guideline_rules (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id        bigint NOT NULL REFERENCES guideline_documents (id) ON DELETE CASCADE,
  chunk_id           bigint REFERENCES guideline_chunks (id),
  topic              text NOT NULL,
  population         text,
  metric             text NOT NULL,
  operator           text NOT NULL CHECK (operator IN ('<', '<=', '>', '>=', '=')),
  value              numeric NOT NULL CHECK (value >= 0),
  unit               text,
  original_value     text,
  original_unit      text,
  original_context   text,
  status             text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'superseded', 'under_review', 'rejected')),
  source_id          bigint REFERENCES sources (id),
  data_version_id    bigint,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guideline_rules_version_source_fk
    FOREIGN KEY (source_id, data_version_id) REFERENCES data_versions (source_id, id) MATCH FULL,
  CONSTRAINT guideline_rules_chunk_document_fk
    FOREIGN KEY (document_id, chunk_id) REFERENCES guideline_chunks (document_id, id),
  CONSTRAINT guideline_rules_provenance_pair CHECK (
    (source_id IS NULL AND data_version_id IS NULL)
    OR (source_id IS NOT NULL AND data_version_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS guideline_rules_topic_idx ON guideline_rules (topic);

-- ---------------------------------------------------------------------------
-- Review records (traceable human / pipeline decisions).
-- Replaces the orphanable polymorphic (reviewable_type, reviewable_key) pair
-- with stable, enforceable typed foreign keys. Exactly one target is set per
-- row, and each target has its own "once per day" uniqueness.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS review_records (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id             bigint REFERENCES sources (id) ON DELETE CASCADE,
  ingredient_id         bigint REFERENCES ingredients (id) ON DELETE CASCADE,
  recipe_id             bigint REFERENCES recipes (id) ON DELETE CASCADE,
  guideline_document_id bigint REFERENCES guideline_documents (id) ON DELETE CASCADE,
  guideline_rule_id     bigint REFERENCES guideline_rules (id) ON DELETE CASCADE,
  decision              text NOT NULL CHECK (decision IN ('unreviewed', 'verified', 'rejected')),
  reviewer_id           text,
  review_date           date,
  rationale             text,
  evidence_refs         jsonb,
  auto                  boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT review_records_exactly_one_target CHECK (
    (source_id IS NOT NULL)::int
    + (ingredient_id IS NOT NULL)::int
    + (recipe_id IS NOT NULL)::int
    + (guideline_document_id IS NOT NULL)::int
    + (guideline_rule_id IS NOT NULL)::int = 1
  )
);

CREATE INDEX IF NOT EXISTS review_records_source_idx ON review_records (source_id);
CREATE INDEX IF NOT EXISTS review_records_ingredient_idx ON review_records (ingredient_id);
CREATE INDEX IF NOT EXISTS review_records_recipe_idx ON review_records (recipe_id);
CREATE INDEX IF NOT EXISTS review_records_guideline_document_idx ON review_records (guideline_document_id);
CREATE INDEX IF NOT EXISTS review_records_guideline_rule_idx ON review_records (guideline_rule_id);
CREATE UNIQUE INDEX IF NOT EXISTS review_records_source_once_idx
  ON review_records (source_id, review_date) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS review_records_ingredient_once_idx
  ON review_records (ingredient_id, review_date) WHERE ingredient_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS review_records_recipe_once_idx
  ON review_records (recipe_id, review_date) WHERE recipe_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS review_records_guideline_document_once_idx
  ON review_records (guideline_document_id, review_date) WHERE guideline_document_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS review_records_guideline_rule_once_idx
  ON review_records (guideline_rule_id, review_date) WHERE guideline_rule_id IS NOT NULL;
