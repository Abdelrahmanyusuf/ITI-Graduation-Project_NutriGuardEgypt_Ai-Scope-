-- Step 19: consented, data-minimized and append-only pilot feedback.
CREATE TABLE pilot_feedback (
  id text PRIMARY KEY CHECK (id ~ '^[0-9a-f-]{36}$'),
  session_id text NOT NULL CHECK (session_id ~ '^[0-9a-f-]{36}$'),
  response_request_id text NOT NULL UNIQUE CHECK (response_request_id ~ '^[0-9a-f-]{36}$'),
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  understood boolean NOT NULL,
  comment text CHECK (comment IS NULL OR char_length(comment) <= 500),
  consent_reference text NOT NULL CHECK (btrim(consent_reference) <> ''),
  privacy_notice_version text NOT NULL CHECK (btrim(privacy_notice_version) <> ''),
  release_id text NOT NULL CHECK (btrim(release_id) <> ''),
  prompt_version text NOT NULL CHECK (btrim(prompt_version) <> ''),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pilot_feedback_release_created_idx ON pilot_feedback (release_id, created_at);

CREATE FUNCTION prevent_pilot_feedback_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('nutriguard.privacy_erasure', true) = 'approved' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'pilot_feedback is append-only';
END;
$$;

CREATE TRIGGER pilot_feedback_append_only
BEFORE UPDATE OR DELETE ON pilot_feedback
FOR EACH ROW EXECUTE FUNCTION prevent_pilot_feedback_mutation();
