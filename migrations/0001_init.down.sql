-- ============================================================================
-- NutriGuard Step 4 — PostgreSQL schema and provenance
--
-- Migration: 0001_init
-- Direction: down
--
-- IMPORTANT transaction-ownership rule: this file does NOT wrap itself in
-- BEGIN/COMMIT. The migration runner (src/data/database.ts) is the single
-- owner of the surrounding transaction, so a partial rollback can never be
-- left behind.
--
-- Tables are dropped in reverse dependency order so that every FOREIGN KEY
-- reference is removed before its referenced table. schema_migrations is
-- intentionally left for the runner to manage (the runner deletes the ledger
-- row for the rolled-back version and owns the surrounding transaction).
-- ============================================================================

DROP TABLE IF EXISTS review_records;
DROP TABLE IF EXISTS guideline_rules;
DROP TABLE IF EXISTS guideline_chunks;
DROP TABLE IF EXISTS guideline_documents;
DROP TABLE IF EXISTS nutrient_retention_factors;
DROP TABLE IF EXISTS cooking_yield_factors;
DROP TABLE IF EXISTS ingredient_unit_conversions;
DROP TABLE IF EXISTS nutrient_values;
DROP TABLE IF EXISTS recipe_ingredients;
DROP TABLE IF EXISTS recipe_aliases;
DROP TABLE IF EXISTS recipes;
DROP TABLE IF EXISTS ingredient_aliases;
DROP TABLE IF EXISTS ingredients;
DROP TABLE IF EXISTS unit_aliases;
DROP TABLE IF EXISTS units;
DROP TABLE IF EXISTS data_versions;
DROP TABLE IF EXISTS sources;