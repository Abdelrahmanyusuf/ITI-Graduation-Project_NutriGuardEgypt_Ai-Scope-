DROP TRIGGER IF EXISTS pilot_feedback_append_only ON pilot_feedback;
DROP FUNCTION IF EXISTS prevent_pilot_feedback_mutation();
DROP TABLE IF EXISTS pilot_feedback;
