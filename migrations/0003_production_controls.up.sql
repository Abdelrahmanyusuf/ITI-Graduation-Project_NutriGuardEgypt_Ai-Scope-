-- Production controls. No data is imported and no approval is created by this migration.
ALTER TABLE sources ADD COLUMN permitted_usage text;
ALTER TABLE sources ADD COLUMN redistribution_terms text;
ALTER TABLE sources ADD COLUMN attribution_text text;

CREATE TABLE reviewer_authorizations (
  id text PRIMARY KEY CHECK (id ~ '^AUT-[A-F0-9]{16}$'),
  reviewer_id text NOT NULL CHECK (btrim(reviewer_id) <> ''),
  reviewer_role text NOT NULL CHECK (btrim(reviewer_role) <> ''),
  qualification text NOT NULL CHECK (btrim(qualification) <> ''),
  subject_type text NOT NULL CHECK (subject_type IN ('ingredient_mapping','unit_conversion','cooking_factor','retention_factor','nutrient_profile','recipe_serving_yield','source_license','cultural_evidence','recipe','guideline','safety_qa','privacy_security','release')),
  subject_key_prefix text,
  valid_from date NOT NULL,
  valid_until date,
  authorization_evidence_reference text NOT NULL CHECK (btrim(authorization_evidence_reference) <> ''),
  authorized_by text NOT NULL CHECK (btrim(authorized_by) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_until IS NULL OR valid_until >= valid_from),
  UNIQUE(id, reviewer_id, reviewer_role, subject_type)
);
CREATE TABLE reviewer_authorization_revocations (
  id text PRIMARY KEY CHECK(id ~ '^REV-[A-F0-9]{16}$'),
  authorization_id text NOT NULL UNIQUE REFERENCES reviewer_authorizations(id),
  revoked_at timestamptz NOT NULL,
  revoked_by text NOT NULL CHECK(btrim(revoked_by)<>''),
  evidence_reference text NOT NULL CHECK(btrim(evidence_reference)<>''),
  reason text NOT NULL CHECK(btrim(reason)<>''),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE approval_records (
  id text PRIMARY KEY CHECK (id ~ '^APR-[A-F0-9]{16}$'),
  subject_type text NOT NULL CHECK (subject_type IN ('ingredient_mapping','unit_conversion','cooking_factor','retention_factor','nutrient_profile','recipe_serving_yield','source_license','cultural_evidence','recipe','guideline','safety_qa','privacy_security','release')),
  subject_key text NOT NULL CHECK (btrim(subject_key) <> ''),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  reviewer_id text NOT NULL CHECK (btrim(reviewer_id) <> ''),
  reviewer_role text NOT NULL CHECK (btrim(reviewer_role) <> ''),
  authorization_id text NOT NULL,
  reviewed_at timestamptz NOT NULL,
  evidence_reference text NOT NULL CHECK (btrim(evidence_reference) <> ''),
  rationale text NOT NULL CHECK (btrim(rationale) <> ''),
  supersedes_id text REFERENCES approval_records(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(subject_type, subject_key, content_sha256, reviewer_role),
  FOREIGN KEY(authorization_id, reviewer_id, reviewer_role, subject_type)
    REFERENCES reviewer_authorizations(id, reviewer_id, reviewer_role, subject_type)
);

CREATE FUNCTION validate_approval_authorization() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE auth reviewer_authorizations%ROWTYPE;
BEGIN
  SELECT * INTO auth FROM reviewer_authorizations WHERE id=NEW.authorization_id;
  IF NOT FOUND OR NEW.reviewed_at::date < auth.valid_from OR (auth.valid_until IS NOT NULL AND NEW.reviewed_at::date > auth.valid_until)
    OR EXISTS(SELECT 1 FROM reviewer_authorization_revocations rev WHERE rev.authorization_id=auth.id AND rev.revoked_at<=NEW.reviewed_at)
    OR (auth.subject_key_prefix IS NOT NULL AND NEW.subject_key NOT LIKE auth.subject_key_prefix || '%') THEN
    RAISE EXCEPTION 'approval is outside reviewer authorization scope or validity';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER approval_authorization_guard BEFORE INSERT ON approval_records FOR EACH ROW EXECUTE FUNCTION validate_approval_authorization();

CREATE TABLE review_queue_items (
  id text PRIMARY KEY CHECK (id ~ '^QUE-[A-F0-9]{16}$'),
  subject_type text NOT NULL CHECK (subject_type IN ('ingredient_mapping','unit_conversion','cooking_factor','retention_factor','nutrient_profile','recipe_serving_yield','source_license','cultural_evidence','recipe','guideline','safety_qa','privacy_security','release')),
  subject_key text NOT NULL CHECK (btrim(subject_key) <> ''),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  required_role text NOT NULL CHECK (btrim(required_role) <> ''),
  priority smallint NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_review','resolved','blocked')),
  assigned_reviewer_id text,
  blocker_codes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(blocker_codes)='array'),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(subject_type, subject_key, content_sha256, required_role)
);

CREATE TABLE recipe_alternative_rules (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rule_key text NOT NULL UNIQUE, from_recipe_id bigint NOT NULL REFERENCES recipes(id), candidate_recipe_id bigint NOT NULL REFERENCES recipes(id),
  candidate_query text NOT NULL CHECK (btrim(candidate_query)<>''), target_nutrient text NOT NULL CHECK(target_nutrient IN ('calories','total_fat','sodium')),
  basis text NOT NULL CHECK(basis IN ('per_serving','per_100g')), status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  source_id bigint NOT NULL, data_version_id bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(source_id,data_version_id) REFERENCES data_versions(source_id,id) MATCH FULL,
  CHECK(from_recipe_id<>candidate_recipe_id)
);

CREATE TABLE cultural_evidence_records (
  id text PRIMARY KEY CHECK(id ~ '^CUL-[A-F0-9]{16}$'),
  evidence_key text NOT NULL UNIQUE,
  source_id bigint NOT NULL,
  data_version_id bigint NOT NULL,
  covered_dish_names jsonb NOT NULL CHECK(jsonb_typeof(covered_dish_names)='array' AND jsonb_array_length(covered_dish_names)>0),
  rationale text NOT NULL CHECK(btrim(rationale)<>''),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(source_id,data_version_id) REFERENCES data_versions(source_id,id) MATCH FULL
);
CREATE TABLE recipe_cultural_evidence (
  recipe_id bigint NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  cultural_evidence_id text NOT NULL REFERENCES cultural_evidence_records(id),
  PRIMARY KEY(recipe_id,cultural_evidence_id)
);

CREATE TABLE retention_events (
  id text PRIMARY KEY CHECK(id ~ '^RET-[A-F0-9]{16}$'), policy_version text NOT NULL, target_table text NOT NULL CHECK(target_table IN ('pilot_feedback')),
  cutoff_at timestamptz NOT NULL, affected_rows integer NOT NULL CHECK(affected_rows>=0), execution_mode text NOT NULL CHECK(execution_mode IN ('dry_run','approved_execution')),
  authorized_by text, evidence_reference text, executed_at timestamptz NOT NULL DEFAULT now(),
  CHECK((execution_mode='dry_run' AND authorized_by IS NULL) OR (execution_mode='approved_execution' AND authorized_by IS NOT NULL AND evidence_reference IS NOT NULL))
);

CREATE FUNCTION prevent_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END; $$;
CREATE TRIGGER approval_records_append_only BEFORE UPDATE OR DELETE ON approval_records FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
CREATE TRIGGER reviewer_authorizations_append_only BEFORE UPDATE OR DELETE ON reviewer_authorizations FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
CREATE TRIGGER reviewer_authorization_revocations_append_only BEFORE UPDATE OR DELETE ON reviewer_authorization_revocations FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
CREATE TRIGGER retention_events_append_only BEFORE UPDATE OR DELETE ON retention_events FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
