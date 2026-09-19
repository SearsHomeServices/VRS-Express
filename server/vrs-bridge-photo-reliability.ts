import type { Pool } from "pg";
import { VRS_BRIDGE_PHOTO_RETENTION_MS, type VrsBridgePhotoStorage } from "./vrs-bridge-photo-storage";
import { fetchAllowedImage, isAllowedPhotoUrl } from "./vrs-bridge-photo-proxy";

export const SOURCE_WINDOW_MS = 2 * 60 * 60 * 1000;
export const WARNING_AFTER_MS = 60 * 60 * 1000;
export function photoCaptureState(captured: number, expected: number, intakeAt: number, now: number) {
  if (captured === expected) return "captured";
  return now >= intakeAt + SOURCE_WINDOW_MS ? "failed" : "retry";
}
type Alert = (check: string, id: number, finding: Record<string, unknown>) => Promise<void>;

/** No schema creation here: deployment requires the explicit DEV migration. */
export class BridgePhotoReliability {
  private running = false;
  private active = new Set<number>();
  constructor(private pool: Pool, private photos: VrsBridgePhotoStorage, private alert: Alert) {}

  async capture(id: number, urls: readonly string[], expiresAt: number) {
    if (!urls.length || this.active.has(id)) return { captured: 0, failures: 0 };
    this.active.add(id);
    try {
      const intakeAt = expiresAt - VRS_BRIDGE_PHOTO_RETENTION_MS;
      await this.pool.query(`INSERT INTO vrs_bridge_photo_captures
        (submission_id,intake_at,retention_expires_at,expected_count)
        VALUES ($1,$2,$3,$4) ON CONFLICT (submission_id) DO NOTHING`,
      [id, new Date(intakeAt), new Date(expiresAt), urls.length]);
      // Persisted intake deadlines are authoritative, never refreshed on retry.
      const row = (await this.pool.query(`SELECT * FROM vrs_bridge_photo_captures WHERE submission_id=$1`, [id])).rows[0];
      if (!row) return { captured: 0, failures: urls.length };
      const deadline = new Date(row.retention_expires_at).getTime();
      const origin = new Date(row.intake_at).getTime();
      // Past source expiry, verify already captured copies without contacting source.
      const result = await this.photos.capture(id, urls, async (url) => {
        if (Date.now() >= origin + SOURCE_WINDOW_MS) throw new Error("PHOTO_SOURCE_WINDOW_EXPIRED");
        return fetchAllowedImage(url, fetch);
      }, isAllowedPhotoUrl, deadline);
      const state = photoCaptureState(result.captured, urls.length, origin, Date.now());
      if (state === "failed" || (state === "retry" && Date.now() >= origin + WARNING_AFTER_MS)) {
        await this.alert(state === "failed" ? "bridge_photo_capture_failed" : "bridge_photo_capture_at_risk", id, {
          message: state === "failed"
            ? "Private photo capture failed before source expiry. Request fresh photos from the technician; expired source links cannot be refreshed."
            : "Private photo capture is incomplete; automatic retries continue. Check private-storage access now and request fresh photos before the two-hour source deadline.",
          captured: result.captured, expected: urls.length, state,
          sourceDeadline: new Date(origin + SOURCE_WINDOW_MS).toISOString(),
          retentionDeadline: new Date(deadline).toISOString(),
        });
      }
      if (state === "captured") await this.alert("bridge_photo_capture_recovered", id, {});
      // Persist terminal state only after the admin incident is durable.
      await this.pool.query(`UPDATE vrs_bridge_photo_captures SET state=$2,captured_count=$3,
        attempts=attempts+1,next_attempt_at=now()+interval '1 minute',updated_at=now()
        WHERE submission_id=$1`, [id, state, result.captured]);
      return result;
    } finally { this.active.delete(id); }
  }

  async recover() {
    if (this.running) return;
    this.running = true;
    try {
      // Backfill missing receipts within retention, including missed terminal failures.
      await this.pool.query(`INSERT INTO vrs_bridge_photo_captures
        (submission_id,intake_at,retention_expires_at,expected_count)
        SELECT c.submission_id,c.created_at,c.created_at+interval '30 days',
          jsonb_array_length(c.request_payload->'appliance_photos')
        FROM vrs_ai_calls c JOIN submissions s ON s.id=c.submission_id
        WHERE c.created_at>now()-interval '30 days'
          AND jsonb_typeof(c.request_payload->'appliance_photos')='array'
          AND c.request_payload->'appliance_photos' <> '[]'::jsonb
        ON CONFLICT (submission_id) DO NOTHING`);
      const { rows } = await this.pool.query(`SELECT p.*,c.request_payload->'appliance_photos' AS photos
        FROM vrs_bridge_photo_captures p JOIN vrs_ai_calls c ON c.submission_id=p.submission_id
        WHERE p.state IN ('pending','retry') AND p.next_attempt_at<=now()
        ORDER BY p.next_attempt_at,p.intake_at LIMIT 100`);
      // Alert the entire selected batch before any slow source/storage reads.
      // Expired receipts still need read verification: do not claim bytes lost
      // merely because the previous attempt never persisted its result.
      for (const row of rows) {
        const origin = new Date(row.intake_at).getTime();
        if (Date.now() < origin + WARNING_AFTER_MS) continue;
        const expired = Date.now() >= origin + SOURCE_WINDOW_MS;
        try {
          await this.alert(expired ? "bridge_photo_capture_failed" : "bridge_photo_capture_at_risk", row.submission_id, {
            message: expired
              ? "Source deadline passed before capture was confirmed. Private copies are being verified; request fresh technician photos if copies are unavailable."
              : "Private photo capture is not yet confirmed. Check storage access now; automatic retries continue, but source photos expire after two hours.",
            captured: row.captured_count, expected: row.expected_count,
            state: "awaiting_verification",
            sourceDeadline: new Date(origin + SOURCE_WINDOW_MS).toISOString(),
            retentionDeadline: new Date(row.retention_expires_at).toISOString(),
          });
        } catch {
          // One ticket's incident failure must not suppress other warnings.
          console.error("[retention] bridge photo pending alert failed");
        }
      }
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(3, rows.length) }, async () => {
        while (next < rows.length) {
          const row = rows[next++];
          try {
            await this.capture(row.submission_id, row.photos, new Date(row.retention_expires_at).getTime());
          } catch {
            console.error("[retention] bridge photo ticket recovery failed");
            // Yield the due slot even on DB/alert errors; preserve the receipt
            // as retryable, and never abort the rest of the batch.
            try {
              await this.pool.query(`UPDATE vrs_bridge_photo_captures
                SET next_attempt_at=now()+interval '1 minute',updated_at=now()
                WHERE submission_id=$1`, [row.submission_id]);
            } catch {
              console.error("[retention] bridge photo retry scheduling failed");
            }
          }
        }
      }));
    } finally { this.running = false; }
  }
}