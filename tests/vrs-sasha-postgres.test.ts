import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { validV8AuthorizePayload } from "./fixtures/vrs-authorize-payloads";

const testDatabaseUrl = process.env.VRS_TASK6_TEST_DATABASE_URL;
const postgresIt = testDatabaseUrl ? it : it.skip;

describe("VRS V8 rearm PostgreSQL concurrency", () => {
  postgresIt(
    "uses production call-before-event locking and persists exact superseded lookup",
    async () => {
      const originalDatabaseUrl = process.env.DATABASE_URL;
      const schema = `vrs_task6_${randomUUID().replaceAll("-", "")}`;
      const bootstrap = new Pool({ connectionString: testDatabaseUrl });
      let applicationPool: Pool | undefined;

      try {
        await bootstrap.query(`CREATE SCHEMA ${schema}`);
        await bootstrap.query(`
          CREATE TABLE ${schema}.submissions (
            id integer PRIMARY KEY,
            phone varchar(20) NOT NULL,
            appliance_type text NOT NULL,
            issue_description text NOT NULL,
            estimate_amount text,
            part_numbers text,
            ticket_status text NOT NULL,
            stage1_status text NOT NULL,
            stage1_reviewed_by integer,
            stage1_reviewed_at timestamp,
            stage1_rejection_reason text,
            invalid_reason varchar(255),
            invalid_instructions text,
            stage2_status text NOT NULL,
            stage2_reviewed_by integer,
            stage2_reviewed_at timestamp,
            stage2_outcome text,
            decline_reason varchar(255),
            decline_instructions text,
            submission_approved boolean NOT NULL,
            submission_approved_at timestamp,
            auth_code varchar(50),
            rgc_code varchar(50),
            assigned_to integer,
            claimed_at timestamp,
            reviewed_by integer,
            reviewed_at timestamp,
            agent_notes text,
            technician_message text,
            rejection_reasons text,
            rejected_media text,
            reassignment_notes text,
            status_changed_at timestamp,
            created_at timestamp,
            updated_at timestamp
          );

          CREATE TABLE ${schema}.vrs_ai_calls (
            id serial PRIMARY KEY,
            submission_id integer,
            call_id varchar(100) NOT NULL,
            provider_call_id varchar(100),
            service_order varchar(20) NOT NULL,
            tech_id varchar(50) NOT NULL,
            tech_phone varchar(20) NOT NULL,
            tech_name varchar(255) NOT NULL,
            state text NOT NULL,
            dispatch_error text,
            dispatch_attempted_at timestamp,
            dispatched_at timestamp,
            request_payload jsonb NOT NULL,
            callback_url text NOT NULL,
            callback_secret_cipher text NOT NULL,
            callback_secret_iv text NOT NULL,
            callback_secret_auth_tag text NOT NULL,
            callback_secret_salt text NOT NULL,
            cta_no varchar(100),
            auth_number varchar(100),
            authorized_amount varchar(30),
            requested_amount varchar(30),
            deny_reason text,
            failure_reason varchar(100),
            retryable boolean,
            duration_sec integer,
            recording_url text,
            webhook_event_id varchar(100),
            webhook_attempt_count integer NOT NULL DEFAULT 0,
            webhook_last_status integer,
            webhook_last_attempt_at timestamp,
            webhook_delivered_at timestamp,
            created_at timestamp NOT NULL DEFAULT now(),
            updated_at timestamp NOT NULL DEFAULT now(),
            completed_at timestamp
          );

          CREATE TABLE ${schema}.vrs_ai_call_events (
            id serial PRIMARY KEY,
            vrs_ai_call_id integer NOT NULL,
            event_id varchar(100) NOT NULL UNIQUE,
            state text NOT NULL,
            payload jsonb NOT NULL,
            processing_state text NOT NULL,
            applied_at timestamp,
            forwarded_at timestamp,
            delivery_attempts integer NOT NULL DEFAULT 0,
            delivery_status integer,
            last_error text,
            created_at timestamp NOT NULL DEFAULT now(),
            updated_at timestamp NOT NULL DEFAULT now()
          );

          CREATE FUNCTION ${schema}.delay_forward_event() RETURNS trigger AS $$
          BEGIN
            IF NEW.processing_state IN ('completed', 'forward_failed')
              AND OLD.processing_state IS DISTINCT FROM NEW.processing_state THEN
              PERFORM pg_sleep(0.5);
            END IF;
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql;

          CREATE TRIGGER delay_forward_event
          BEFORE UPDATE ON ${schema}.vrs_ai_call_events
          FOR EACH ROW EXECUTE FUNCTION ${schema}.delay_forward_event();
        `);

        const { callback_secret: _secret, ...storedPayload } =
          validV8AuthorizePayload;
        const terminalPayload = {
          version: 1,
          eventId: "evt_pg_failed",
          callId: "vrs_ai_pg_old",
          soNo: "13538277",
          occurredAt: "2026-08-11T20:00:00.000Z",
          state: "failed",
          reason: "retryable provider failure",
          retryable: true,
        };

        await bootstrap.query(
          `INSERT INTO ${schema}.submissions (
             id, phone, appliance_type, issue_description, estimate_amount,
             part_numbers, ticket_status, stage1_status, stage1_reviewed_by,
             stage1_reviewed_at, stage2_status, submission_approved,
             assigned_to, reassignment_notes, created_at, updated_at
           ) VALUES (
             42, '+19845550111', 'laundry', 'old issue', '400.00', '[]',
             'pending', 'approved', 77, now(), 'pending', true, 77,
             'prior specialist assignment', now(), now()
           )`,
        );
        await bootstrap.query(
          `INSERT INTO ${schema}.vrs_ai_calls (
             id, submission_id, call_id, provider_call_id, service_order,
             tech_id, tech_phone, tech_name, state, request_payload,
             callback_url, callback_secret_cipher, callback_secret_iv,
             callback_secret_auth_tag, callback_secret_salt, failure_reason,
             retryable, webhook_event_id, webhook_attempt_count,
             webhook_last_status, webhook_last_attempt_at,
             webhook_delivered_at, completed_at
           ) VALUES (
             91, 42, 'vrs_call_pg_old', 'vrs_ai_pg_old', '13538277',
             '0123456', '+19845550111', 'Carlos Rivera', 'failed', $1::jsonb,
             'https://callback.example.test/vrs', 'old-cipher', 'old-iv',
             'old-tag', 'old-salt', 'retryable provider failure', true,
             'evt_pg_failed', 2, 200, now(), now(), now()
           )`,
          [JSON.stringify(storedPayload)],
        );
        await bootstrap.query(
          `INSERT INTO ${schema}.vrs_ai_call_events (
             vrs_ai_call_id, event_id, state, payload, processing_state,
             applied_at, forwarded_at, delivery_attempts, delivery_status
           ) VALUES (
             91, 'evt_pg_failed', 'failed', $1::jsonb, 'applied', now(),
             NULL, 1, NULL
           )`,
          [JSON.stringify(terminalPayload)],
        );

        const scopedUrl = new URL(testDatabaseUrl!);
        scopedUrl.searchParams.set(
          "options",
          `-csearch_path=${schema} -clock_timeout=4000 -cstatement_timeout=8000`,
        );
        process.env.DATABASE_URL = scopedUrl.toString();

        const [{ DrizzleVrsBridgeStore }, storageModule] = await Promise.all([
          import("../server/vrs-sasha-store"),
          import("../server/storage"),
        ]);
        applicationPool = storageModule.pool;
        await applicationPool.query("SELECT 1");
        const store = new DrizzleVrsBridgeStore();

        const forwarding = store.markWebhookForwarded(91, "evt_pg_failed", {
          delivered: true,
          attempts: 2,
          status: 200,
        });
        await new Promise((resolve) => setTimeout(resolve, 75));
        const decision = store.decideExistingOrRearm({
          callId: "vrs_call_pg_new",
          serviceOrder: "13538277",
          techId: "0123456",
          techPhone: "+19845550111",
          techName: "Carlos Rivera",
          requestPayload: storedPayload,
          callbackUrl: "https://callback.example.test/vrs/new",
          callbackSecretCipher: "new-cipher",
          callbackSecretIv: "new-iv",
          callbackSecretAuthTag: "new-tag",
          callbackSecretSalt: "new-salt",
          submissionProjection: {
            applianceType: "laundry",
            issueDescription: "new issue",
            estimateAmount: "512.34",
            partNumbers: '["NEW-PART"]',
            phone: "+19845550111",
          },
        });

        await expect(Promise.all([forwarding, decision])).resolves.toEqual([
          undefined,
          expect.objectContaining({ kind: "rearmed" }),
        ]);
        await expect(
          store.hasSupersededProviderCall("vrs_ai_pg_old", "13538277"),
        ).resolves.toBe(true);
        await expect(
          store.hasSupersededProviderCall("vrs_ai_pg_old", "99999999"),
        ).resolves.toBe(false);
      } finally {
        if (applicationPool) await applicationPool.end();
        process.env.DATABASE_URL = originalDatabaseUrl;
        await bootstrap.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await bootstrap.end();
      }
    },
    15_000,
  );
});
