import type { Pool } from "pg";

// Additive, independent of vrs_ai_calls and every Sasha table.
export const DIRECT_AHS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS direct_ahs_workflows (
 id uuid PRIMARY KEY,
 submission_id integer NOT NULL UNIQUE REFERENCES submissions(id),
 reviewer_id integer NOT NULL REFERENCES users(id),
 state text NOT NULL,
 payload jsonb NOT NULL,
 call_id text,
 decision jsonb,
 sms jsonb,
 wom_notes jsonb,
 error text,
 last_sequence integer NOT NULL DEFAULT 0,
 created_at timestamp NOT NULL DEFAULT now(),
 updated_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS direct_ahs_events (
 request_id uuid NOT NULL REFERENCES direct_ahs_workflows(id),
 event_id text NOT NULL,
 sequence integer NOT NULL,
 fingerprint text NOT NULL,
 payload jsonb NOT NULL,
 created_at timestamp NOT NULL DEFAULT now(),
 PRIMARY KEY (request_id, event_id),
 UNIQUE(request_id, sequence)
);

-- Protect against an already-running legacy/manual writer that passed its
-- route checks before dispatch began. The lock serializes against enrollment.
-- No enrollment => absolutely no restriction on an existing ticket workflow.
CREATE OR REPLACE FUNCTION protect_direct_ahs_submission() RETURNS trigger AS $$
BEGIN
 IF current_setting('app.direct_ahs_write', true) = 'on' THEN RETURN NEW; END IF;
 IF EXISTS (SELECT 1 FROM direct_ahs_workflows WHERE submission_id=OLD.id)
 AND (NEW.ticket_status, NEW.assigned_to, NEW.stage1_status, NEW.stage2_status,
      NEW.auth_code, NEW.submission_approved, NEW.service_order,
      NEW.technician_id, NEW.warranty_type, NEW.warranty_provider,
      NEW.phone, NEW.phone_override, NEW.issue_description, NEW.part_numbers, NEW.estimate_amount,
      NEW.technician_ldap_id, NEW.appliance_type, NEW.request_type, NEW.photos, NEW.video_url, NEW.voice_note_url)
 IS DISTINCT FROM
     (OLD.ticket_status, OLD.assigned_to, OLD.stage1_status, OLD.stage2_status,
      OLD.auth_code, OLD.submission_approved, OLD.service_order,
      OLD.technician_id, OLD.warranty_type, OLD.warranty_provider,
      OLD.phone, OLD.phone_override, OLD.issue_description, OLD.part_numbers, OLD.estimate_amount,
      OLD.technician_ldap_id, OLD.appliance_type, OLD.request_type, OLD.photos, OLD.video_url, OLD.voice_note_url)
 THEN
   RAISE EXCEPTION 'Direct AHS AI owns this ticket; use its result workflow' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS protect_direct_ahs_submission ON submissions;
CREATE TRIGGER protect_direct_ahs_submission BEFORE UPDATE ON submissions
FOR EACH ROW EXECUTE FUNCTION protect_direct_ahs_submission();
`;
export async function ensureDirectAhsSchema(pool: Pool) {
  await pool.query(DIRECT_AHS_SCHEMA_SQL);
}
