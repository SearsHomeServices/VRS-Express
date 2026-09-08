import type { Pool } from "pg";
import { VrsCallbackError } from "./vrs-callback-safety";
type Send = (submissionId:number,phone:string,type:string,body:string)=>Promise<{success:boolean;twilioSid?:string;error?:string;notificationId?:number}>;

export const NOTIFICATION_RETRY_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS vrs_ai_notification_retries (
  id serial PRIMARY KEY,
  notification_id integer NOT NULL UNIQUE,
  actor_id integer NOT NULL,
  state text NOT NULL DEFAULT 'processing',
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
)`;

// Explicit human recovery only. A separate durable claim preserves the original
// failure record and blocks a second send even if the first worker crashes.
export async function retryVrsApprovalNotification(pool:Pool, notificationId:number, actorId:number, confirmedUndelivered:boolean, send:Send) {
  if (!confirmedUndelivered) throw new VrsCallbackError("DELIVERY_REVIEW_REQUIRED", "Confirm the original message was not delivered before resending.");
  const claim=(await pool.query(`INSERT INTO vrs_ai_notification_retries(notification_id,actor_id)
    SELECT n.id,$2 FROM sms_notifications n JOIN submissions s ON s.id=n.submission_id
    WHERE n.id=$1 AND s.ticket_status='completed' AND n.message_type='ticket_approved' AND n.twilio_sid LIKE 'ERROR:%'
    ON CONFLICT(notification_id) DO NOTHING RETURNING id`,[notificationId,actorId])).rows[0];
  if (!claim) throw new VrsCallbackError("NOTIFICATION_NOT_RETRYABLE", "This is not an unclaimed failed approval message. Refresh its history before retrying.");
  try {
    const original=(await pool.query("SELECT submission_id,recipient_phone,message_type,message_body FROM sms_notifications WHERE id=$1",[notificationId])).rows[0];
    if (!original) throw Error("Original notification no longer exists");
    const outcome=await send(original.submission_id,original.recipient_phone,original.message_type,original.message_body);
    const response={ok:outcome.success,notification_id:outcome.notificationId??null,original_notification_id:notificationId,status:outcome.success?"accepted":"failed",...(outcome.error?{message:outcome.error}:{})};
    await pool.query("UPDATE vrs_ai_notification_retries SET state=$2,result=$3,updated_at=now() WHERE id=$1",[claim.id,response.status,JSON.stringify(response)]);
    return response;
  } catch (error) {
    await pool.query("UPDATE vrs_ai_notification_retries SET state='unknown',updated_at=now() WHERE id=$1",[claim.id]).catch(()=>{});
    throw new VrsCallbackError("NOTIFICATION_OUTCOME_UNKNOWN", "The retry outcome is uncertain. Check provider delivery history before any further resend.",503);
  }
}
