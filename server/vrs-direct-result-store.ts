import { NOTIFICATION_RETRY_SCHEMA_SQL } from "./vrs-notification-retry";
import { randomUUID } from "crypto";
import type { Pool } from "pg";
import { callbackFingerprint, VrsCallbackError } from "./vrs-callback-safety";
import type { VrsAiCallResult } from "./vrs-ai-call-result";

export interface DirectResultResponse { status: number; body: Record<string, any> }
export interface DirectResultBinding { submissionId: number | null; bind(id: number): Promise<void> }
export interface DirectResultReceipts {
  getStatus?(eventId:string):Promise<Record<string,unknown>|undefined>;
  execute(result: VrsAiCallResult, work: (binding: DirectResultBinding) => Promise<DirectResultResponse>): Promise<DirectResultResponse>;
}

// Separate, additive table. Existing tickets, bridge rows and schemas are untouched.
export const DIRECT_RESULT_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS vrs_ai_direct_results (
  id serial PRIMARY KEY,
  event_id varchar(100) NOT NULL UNIQUE,
  call_id varchar(100) NOT NULL UNIQUE,
  payload_hash varchar(64) NOT NULL,
  payload jsonb NOT NULL,
  submission_id integer,
  processing_state text NOT NULL DEFAULT 'processing',
  lease_token uuid,
  lease_until timestamptz,
  response jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
)`;

export class PostgresDirectResultReceipts implements DirectResultReceipts {
  constructor(private readonly pool: Pool) {}

  async ensureSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query(DIRECT_RESULT_SCHEMA_SQL);
      await client.query(NOTIFICATION_RETRY_SCHEMA_SQL);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async getStatus(eventId:string):Promise<Record<string,unknown>|undefined> {
    return (await this.pool.query("SELECT event_id,call_id,submission_id,processing_state,response,last_error,updated_at FROM vrs_ai_direct_results WHERE event_id=$1",[eventId])).rows[0];
  }

  private async claim(result:VrsAiCallResult, token:string, submissionId?:number):Promise<any|undefined> {
    const hash=callbackFingerprint(result);
    const client=await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '3s'");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`vrs-direct-event:${result.eventId}`]);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`vrs-direct-call:${result.callId}`]);
      const rows=(await client.query("SELECT *, lease_until > now() AS leased FROM vrs_ai_direct_results WHERE event_id=$1 OR call_id=$2 FOR UPDATE",[result.eventId,result.callId])).rows;
      let row=rows[0];
      if(rows.length>1 || row && (row.event_id!==result.eventId || row.call_id!==result.callId || row.payload_hash!==hash))throw new VrsCallbackError("EVENT_CONFLICT","This event or call is already bound to a different result. Retry the original event unchanged.");
      if(row?.processing_state==="completed")throw new DirectResultReplay({status:200,body:{...row.response,closed:false,deduped:true}});
      if(row?.leased)throw new VrsCallbackError("EVENT_IN_PROGRESS","This result is already processing. Retry the same event shortly.");
      if(row){
        if(submissionId!==undefined && row.submission_id!==null && row.submission_id!==submissionId)throw new VrsCallbackError("TICKET_BINDING_CONFLICT","This event is bound to another ticket.");
        row=(await client.query("UPDATE vrs_ai_direct_results SET processing_state='processing',lease_token=$2,lease_until=now()+interval '2 minutes',updated_at=now(),submission_id=coalesce(submission_id,$3) WHERE id=$1 RETURNING *",[row.id,token,submissionId??null])).rows[0];
      } else if(submissionId!==undefined){
        row=(await client.query("INSERT INTO vrs_ai_direct_results (event_id,call_id,payload_hash,payload,submission_id,lease_token,lease_until) VALUES ($1,$2,$3,$4,$5,$6,now()+interval '2 minutes') RETURNING *",[result.eventId,result.callId,hash,JSON.stringify(result),submissionId,token])).rows[0];
      }
      await client.query("COMMIT");return row;
    } catch(error:any){
      await client.query("ROLLBACK");
      if(error?.code==="42P01")throw new VrsCallbackError("RECEIPTS_NOT_READY","Callback receipt storage is not ready. No ticket was changed; retry after setup.",503);
      throw error;
    } finally {client.release()}
  }

  async execute(result:VrsAiCallResult,work:(binding:DirectResultBinding)=>Promise<DirectResultResponse>):Promise<DirectResultResponse>{
    const token=randomUUID();let row:any;
    try {row=await this.claim(result,token)}catch(error){if(error instanceof DirectResultReplay)return error.response;throw error}
    const binding:DirectResultBinding={
      submissionId:row?.submission_id??null,
      bind:async(id)=>{
        if(binding.submissionId!==null && binding.submissionId!==id)throw new VrsCallbackError("TICKET_BINDING_CONFLICT","This event is already bound to another ticket.");
        // Only accepted, fully validated ticket identities reserve an event.
        // Validation failures remain correctable because they have no effects.
        if(!row)row=await this.claim(result,token,id);
        else {
          const updated=await this.pool.query("UPDATE vrs_ai_direct_results SET submission_id=$3,updated_at=now() WHERE id=$1 AND lease_token=$2 AND (submission_id IS NULL OR submission_id=$3) RETURNING id",[row.id,token,id]);
          if(updated.rowCount!==1)throw new VrsCallbackError("EVENT_IN_PROGRESS","Callback lease changed; retry the same event.");
        }
        binding.submissionId=id;
      },
    };
    try {
      const response=await work(binding);
      if(!row){
        if(response.status===200)throw Error("A successful callback must be durably bound before applying effects");
        return response;
      }
      const saved=await this.pool.query("UPDATE vrs_ai_direct_results SET processing_state=$3,response=$4,last_error=$5,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2 RETURNING id",[row.id,token,response.status===200?'completed':'blocked',JSON.stringify(response.body),response.status===200?null:String(response.body.message??response.body.error??'Callback blocked')]);
      if(saved.rowCount!==1)throw new VrsCallbackError("EVENT_IN_PROGRESS","Callback lease changed; retry the same event.");
      return response;
    } catch(error){
      if(error instanceof DirectResultReplay)return error.response;
      if(row)await this.pool.query("UPDATE vrs_ai_direct_results SET processing_state='failed',last_error=$3,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2",[row.id,token,error instanceof Error?error.message:String(error)]);
      throw error;
    }
  }
}

class DirectResultReplay extends Error {
  constructor(readonly response:DirectResultResponse){super("Callback already completed")}
}
