-- Explicit DEV-only migration. Never execute from application startup.
CREATE TABLE IF NOT EXISTS vrs_bridge_photo_captures (
  submission_id integer PRIMARY KEY REFERENCES submissions(id) ON DELETE CASCADE,
  intake_at timestamptz NOT NULL,
  retention_expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  expected_count integer NOT NULL,
  captured_count integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vrs_bridge_photo_captures_due_idx
ON vrs_bridge_photo_captures(next_attempt_at) WHERE state IN ('pending','retry');