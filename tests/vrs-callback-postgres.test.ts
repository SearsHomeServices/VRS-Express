import request from "supertest";
import {createHandlerHarness,approvalFixture} from "./helpers/vrs-handler-harness";
import fs from "node:fs";
import ts from "typescript";
import { getTableConfig } from "drizzle-orm/pg-core";
import {eq,and,or,inArray,sql} from "drizzle-orm";
import {submissions,smsNotifications} from "../shared/schema";
import { retryVrsApprovalNotification } from "../server/vrs-notification-retry";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresDirectResultReceipts } from "../server/vrs-direct-result-store";
const socket=process.env.VRS_CALLBACK_TEST_SOCKET;
const event={version:1 as const,eventId:"test-event",callId:"test-call",soNo:"99090801",occurredAt:"2026-09-08T14:01:45Z",state:"approved" as const,authNumber:"TEST-AUTH",authorizedAmount:380.6,partId:"TEST-PART",techId:"TESTTECH",partDescription:"Test part"};
const response={status:200,body:{ok:true,closed:true,deduped:false,submission_id:1,event_id:event.eventId}};
let updater:any;let pool:Pool;let receipts:PostgresDirectResultReceipts;let bridge:any;
describe.skipIf(!socket)("isolated PostgreSQL callback receipts and ordering",()=>{
 beforeAll(async()=>{
  if(!socket?.startsWith("/tmp/vrs-callback-tests-"))throw Error("Only the disposable callback test socket is allowed");
  pool=new Pool({host:socket,port:55439,database:"vrs_callback_tests",user:"vrs_test",max:8});
  const identity=(await pool.query("select current_database() as db,current_user as usr")).rows[0];
  expect(identity).toEqual({db:"vrs_callback_tests",usr:"vrs_test"});
  receipts=new PostgresDirectResultReceipts(pool);await receipts.ensureSchema();
  for (const table of [submissions,smsNotifications]) {
    const config=getTableConfig(table);
    await pool.query(`CREATE TABLE IF NOT EXISTS "${config.name}" (${config.columns.map(column=>`"${column.name}" ${column.getSQLType()}${column.primary?" PRIMARY KEY":""}`).join(",")})`);
  }
  const text=fs.readFileSync("server/storage.ts","utf8");
  const ast=ts.createSourceFile("storage.ts",text,ts.ScriptTarget.Latest,true);
  const declaration=ast.statements.find((node:any)=>ts.isClassDeclaration(node)&&node.name?.text==="DatabaseStorage") as any;
  const method=declaration.members.find((node:any)=>node.name?.getText(ast)==="updateSubmissionIfStatus");
  const compiled=ts.transpileModule(`class TestStorage {${method.getText(ast)}}`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  const dependencies={db:drizzle(pool),submissions,eq,and,or,inArray,sql,bumpSubmissionsDataVersion:()=>{}};
  updater=new Function(...Object.keys(dependencies),compiled+";return new TestStorage();")(...Object.values(dependencies));

  await pool.query(`CREATE TABLE IF NOT EXISTS vrs_ai_calls(id serial primary key,state text NOT NULL,webhook_event_id text,auth_number text,authorized_amount text,requested_amount text,deny_reason text,failure_reason text,retryable boolean,duration_sec integer,recording_url text,completed_at timestamp,updated_at timestamp NOT NULL default now(),webhook_attempt_count integer,webhook_last_status integer,webhook_last_attempt_at timestamp,webhook_delivered_at timestamp);
  CREATE TABLE IF NOT EXISTS vrs_ai_call_events(id serial primary key,vrs_ai_call_id integer NOT NULL,event_id text UNIQUE NOT NULL,state text NOT NULL,payload jsonb NOT NULL,processing_state text NOT NULL default 'processing',applied_at timestamp,forwarded_at timestamp,delivery_attempts integer NOT NULL default 0,delivery_status integer,last_error text,created_at timestamp NOT NULL default now(),updated_at timestamp NOT NULL default now());`);
  vi.doMock("../server/storage",()=>({db:drizzle(pool),pool}));
  const module=await import("../server/vrs-sasha-store");bridge=new module.DrizzleVrsBridgeStore();
 });
 beforeEach(async()=>{await pool.query("TRUNCATE vrs_ai_notification_retries,vrs_ai_direct_results,vrs_ai_call_events,vrs_ai_calls,submissions,sms_notifications RESTART IDENTITY");await pool.query("INSERT INTO vrs_ai_calls(state) VALUES ('connected'),('connected')")});
 afterAll(async()=>{await pool?.end();vi.doUnmock("../server/storage")});
 it("does not reserve an invalid unbound result, so the requested submissionId correction can succeed",async()=>{
  await expect(receipts.execute(event,async()=>{throw Error("AMBIGUOUS_TICKET")})).rejects.toThrow("AMBIGUOUS_TICKET");
  expect(await receipts.getStatus(event.eventId)).toBeUndefined();
  expect((await receipts.execute({...event,submissionId:1},async binding=>{await binding.bind(1);return response})).status).toBe(200);
 });
 it("serializes signed forwarding and never lets a late failure erase success",async()=>{
  await bridge.beginWebhookEvent(1,event);await bridge.markWebhookApplied(1,event.eventId,event);
  expect(await bridge.claimWebhookForwarding(1,event.eventId)).toMatchObject({kind:"claimed"});
  expect(await bridge.claimWebhookForwarding(1,event.eventId)).toMatchObject({kind:"in_progress"});
  await bridge.markWebhookForwarded(1,event.eventId,{delivered:true,attempts:1,status:200});
  await bridge.markWebhookForwarded(1,event.eventId,{delivered:false,attempts:5,status:503});
  await bridge.markWebhookFailed(1,event.eventId,"late failure");
  const stored=(await pool.query("SELECT processing_state,forwarded_at FROM vrs_ai_call_events WHERE event_id=$1",[event.eventId])).rows[0];
  expect(stored.processing_state).toBe("completed");expect(stored.forwarded_at).not.toBeNull();
 });
 it("uses the same call lock for forwarding admission",async()=>{
  await bridge.beginWebhookEvent(1,event);await bridge.markWebhookApplied(1,event.eventId,event);
  const gate=await pool.connect();await gate.query("BEGIN");await gate.query("SELECT pg_advisory_xact_lock(hashtext('vrs-ai-call:1'))");let finished=false;
  const claim=bridge.claimWebhookForwarding(1,event.eventId).then((value:any)=>{finished=true;return value});
  try {await new Promise(r=>setTimeout(r,50));expect(finished).toBe(false)}finally{await gate.query("COMMIT");gate.release()}
  expect(await claim).toMatchObject({kind:"claimed"});
 });
 it("fences expired forwarding workers so they cannot clear a replacement claim",async()=>{
  await bridge.beginWebhookEvent(1,event);await bridge.markWebhookApplied(1,event.eventId,event);const first=await bridge.claimWebhookForwarding(1,event.eventId);
  await pool.query("UPDATE vrs_ai_call_events SET updated_at=now()-interval '3 minutes' WHERE event_id=$1",[event.eventId]);await new Promise(r=>setTimeout(r,5));
  const second=await bridge.claimWebhookForwarding(1,event.eventId);expect(second.kind).toBe("claimed");
  await bridge.markWebhookFailed(1,event.eventId,"old worker failure",first.claimedAt);
  await bridge.markWebhookForwarded(1,event.eventId,{delivered:false,attempts:5,status:503},first.claimedAt);
  expect((await pool.query("SELECT processing_state FROM vrs_ai_call_events WHERE event_id=$1",[event.eventId])).rows[0].processing_state).toBe("forwarding");
  await bridge.markWebhookForwarded(1,event.eventId,{delivered:true,attempts:1,status:200},second.claimedAt);
  expect((await pool.query("SELECT processing_state FROM vrs_ai_call_events WHERE event_id=$1",[event.eventId])).rows[0].processing_state).toBe("completed");
 });
 it("handles a lost application-lock connection without crashing the service",async()=>{
  let release!:()=>void;let enter!:()=>void;const gate=new Promise<void>(r=>release=r);const started=new Promise<void>(r=>enter=r);
  const work=bridge.withWebhookApplicationLock(1,async()=>{enter();await gate});await started;
  const active=(await pool.query("SELECT pid FROM pg_stat_activity WHERE datname='vrs_callback_tests' AND usename='vrs_test' AND query LIKE 'SELECT pg_try_advisory_lock%' AND state='idle' LIMIT 1")).rows[0];expect(active).toBeTruthy();
  await pool.query("SELECT pg_terminate_backend($1)",[active.pid]);await new Promise(r=>setTimeout(r,10));release();
  await expect(work).rejects.toMatchObject({code:"CALLBACK_LOCK_LOST"});expect((await pool.query("SELECT 1 AS healthy")).rows[0].healthy).toBe(1);
 });
 it("persists original ticket and cached result across a new store instance",async()=>{
  let calls=0;await receipts.execute(event,async binding=>{await binding.bind(1);calls++;return response});
  const retry=await new PostgresDirectResultReceipts(pool).execute(event,async()=>{calls++;throw Error("must not execute")});
  expect(calls).toBe(1);expect(retry.body).toMatchObject({submission_id:1,closed:false,deduped:true});
 });
 it("exposes receipt status without exposing the stored request payload",async()=>{
  await receipts.execute(event,async binding=>{await binding.bind(1);return response});
  const status=await receipts.getStatus(event.eventId);expect(status).toMatchObject({processing_state:"completed",submission_id:1});expect(status).not.toHaveProperty("payload");expect(status).not.toHaveProperty("payload_hash");
 });
 it("rejects changed payload and a reused call with a new event",async()=>{
  await receipts.execute(event,async binding=>{await binding.bind(1);return response});
  await expect(receipts.execute({...event,authorizedAmount:381},async()=>response)).rejects.toMatchObject({code:"EVENT_CONFLICT"});
  await expect(receipts.execute({...event,eventId:"other-event"},async()=>response)).rejects.toMatchObject({code:"EVENT_CONFLICT"});
 });
 it("retains the binding after an interruption so retry cannot choose a second ticket",async()=>{
  await expect(receipts.execute(event,async binding=>{await binding.bind(1);throw Error("interrupted after ticket write")})).rejects.toThrow("interrupted");
  await receipts.execute(event,async binding=>{expect(binding.submissionId).toBe(1);await expect(binding.bind(2)).rejects.toMatchObject({code:"TICKET_BINDING_CONFLICT"});return response});
 });
 it("serializes concurrent direct event attempts",async()=>{
  let release!:()=>void;let entered!:()=>void;const started=new Promise<void>(r=>entered=r);const gate=new Promise<void>(r=>release=r);
  const first=receipts.execute(event,async binding=>{await binding.bind(1);entered();await gate;return response});await started;
  await expect(receipts.execute(event,async()=>response)).rejects.toMatchObject({code:"EVENT_IN_PROGRESS"});release();await first;
 });
 it("retries blocked prerequisites against the same ticket",async()=>{
  await receipts.execute(event,async binding=>{await binding.bind(1);return {status:422,body:{error:"RGC_MISSING"}}});
  await receipts.execute(event,async binding=>{expect(binding.submissionId).toBe(1);return response});
 });
 it.each([false,true])("runs a full direct callback and a durable retry after another ticket appears (interrupted=%s)",async(interrupt)=>{
  const prior=process.env.VRS_SASHA_API_KEY;process.env.VRS_SASHA_API_KEY="pg-handler-key";
  try {
   await pool.query(`INSERT INTO submissions(id,service_order,technician_id,technician_ldap_id,ticket_status,request_type,submission_approved,stage1_status,stage1_reviewed_by,assigned_to,warranty_provider,warranty_type,part_numbers,created_at,updated_at) VALUES(1,'0001-99090801',10,'TESTTECH','pending','authorization',true,'approved',7,8,'AHS','american_home_shield','["TEST-PART"]','2026-09-08T13:00:00Z',now())`);
   const database=drizzle(pool);
   const store={getSubmission:async(id:number)=>(await database.select().from(submissions).where(eq(submissions.id,id)))[0],getUser:async()=>({id:8,name:"Fixture Reviewer",racId:"TESTTECH"}),getDailyRgcCode:async()=>({code:"TEST-RGC"}),getSubmissionCandidatesByServiceOrderSuffix:async()=>((await database.select().from(submissions)).map(row=>({...row,submissionId:row.id}))),updateSubmissionIfStatus:updater.updateSubmissionIfStatus.bind(updater)};
   let interruptOnce=interrupt;
   const recoverableReceipts={execute:(input:any,work:any)=>receipts.execute(input,async binding=>{const result=await work(binding);if(interruptOnce){interruptOnce=false;throw Error("simulated interruption after ticket commit")}return result})};
   const f=createHandlerHarness({}, {storage:store,receipts:recoverableReceipts});
   const post=()=>request(f.app).post("/api/integrations/vrs-ai/v1/call-result").set("X-API-Key","pg-handler-key").send(approvalFixture);
   const first=await post();expect(first.status).toBe(interrupt?500:200);if(!interrupt)expect(first.body.closed).toBe(true);
   await pool.query(`INSERT INTO submissions(id,service_order,ticket_status) VALUES(2,'0001-99090801','pending')`);
   const retry=await post();expect(retry.status).toBe(200);expect(retry.body).toMatchObject({submission_id:1,deduped:true,closed:false});expect(f.sms).toHaveLength(1);
   expect((await pool.query("SELECT ticket_status FROM submissions WHERE id=2")).rows[0].ticket_status).toBe("pending");
  } finally {if(prior===undefined)delete process.env.VRS_SASHA_API_KEY;else process.env.VRS_SASHA_API_KEY=prior}
 });
 it("limits callback lock reservations so the database pool retains capacity",async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);let entered=0;let allStarted!:()=>void;const started=new Promise<void>(r=>allStarted=r);
  const work=Array.from({length:4},(_,i)=>bridge.withWebhookApplicationLock(i+1,async()=>{if(++entered===4)allStarted();await gate}));await started;
  try {await expect(bridge.withWebhookApplicationLock(99,async()=>{})).rejects.toMatchObject({code:"CALLBACK_CAPACITY",status:429});expect((await pool.query("SELECT 1 AS available")).rows[0].available).toBe(1)}finally{release();await Promise.all(work)}
 });
 it("holds the signed application lock even when an event lease expires",async()=>{
  let release!:()=>void;let enter!:()=>void;const gate=new Promise<void>(r=>release=r);const started=new Promise<void>(r=>enter=r);
  const first=bridge.withWebhookApplicationLock(1,async()=>{enter();await gate;return "done"});await started;
  await expect(bridge.withWebhookApplicationLock(1,async()=>"must not execute")).rejects.toMatchObject({code:"EVENT_IN_PROGRESS"});release();expect(await first).toBe("done");
 });
 it("enforces the automated snapshot at the real ticket UPDATE while retaining manual behavior",async()=>{
  await pool.query(`INSERT INTO submissions(id,service_order,technician_id,ticket_status,request_type,submission_approved,stage1_status,warranty_provider,warranty_type,part_numbers,updated_at) VALUES(1,'0001-99090801',10,'pending','authorization',true,'approved','AHS','american_home_shield','["TEST-PART"]',now())`);
  const database=drizzle(pool);const [snapshot]=await database.select().from(submissions).where(eq(submissions.id,1));
  await pool.query("UPDATE submissions SET part_numbers='[\"OTHER-PART\"]' WHERE id=1");
  expect(await updater.updateSubmissionIfStatus(1,["pending"],{ticketStatus:"completed"},undefined,snapshot)).toBeUndefined();
  expect((await pool.query("SELECT ticket_status FROM submissions WHERE id=1")).rows[0].ticket_status).toBe("pending");
  const manual=await updater.updateSubmissionIfStatus(1,["pending"],{ticketStatus:"completed"});expect(manual.ticketStatus).toBe("completed");
 });
 it("allows a fresh reviewed callback snapshot with database timestamp precision",async()=>{
  await pool.query(`INSERT INTO submissions(id,service_order,technician_id,ticket_status,request_type,submission_approved,stage1_status,warranty_provider,warranty_type,updated_at) VALUES(1,'0001-99090801',10,'pending','authorization',true,'approved','AHS','american_home_shield',now())`);
  const [snapshot]=await drizzle(pool).select().from(submissions).where(eq(submissions.id,1));
  expect((await updater.updateSubmissionIfStatus(1,["pending"],{ticketStatus:"completed"},undefined,snapshot)).ticketStatus).toBe("completed");
 });
 it("requires an explicit undelivered confirmation before SMS recovery",async()=>{
  const send=vi.fn();await expect(retryVrsApprovalNotification(pool,1,7,false,send)).rejects.toMatchObject({code:"DELIVERY_REVIEW_REQUIRED"});expect(send).not.toHaveBeenCalled();
 });
 it("claims a failed SMS durably and never retries that record twice",async()=>{
  await pool.query("INSERT INTO submissions(id,ticket_status) VALUES(1,'completed')");
  await pool.query("INSERT INTO sms_notifications(id,submission_id,recipient_phone,message_type,message_body,twilio_sid) VALUES(1,1,'+15555550100','ticket_approved','fixture','ERROR: fixture')");
  const send=vi.fn(async()=>({success:true,twilioSid:"SM_fixture",notificationId:2}));
  expect((await retryVrsApprovalNotification(pool,1,7,true,send)).ok).toBe(true);
  await expect(retryVrsApprovalNotification(pool,1,7,true,send)).rejects.toMatchObject({code:"NOTIFICATION_NOT_RETRYABLE"});expect(send).toHaveBeenCalledTimes(1);
 });
 it("leaves an uncertain SMS retry claimed instead of risking another send",async()=>{
  await pool.query("INSERT INTO submissions(id,ticket_status) VALUES(1,'completed')");await pool.query("INSERT INTO sms_notifications(id,submission_id,message_type,twilio_sid) VALUES(1,1,'ticket_approved','ERROR: fixture')");
  await expect(retryVrsApprovalNotification(pool,1,7,true,async()=>{throw Error("lost provider response")})).rejects.toMatchObject({code:"NOTIFICATION_OUTCOME_UNKNOWN"});
  expect((await pool.query("SELECT state FROM vrs_ai_notification_retries WHERE notification_id=1")).rows[0].state).toBe("unknown");
  expect((await pool.query("SELECT twilio_sid FROM sms_notifications WHERE id=1")).rows[0].twilio_sid).toBe("ERROR: fixture");
 });
 it("rejects a signed event ID belonging to another call",async()=>{
  await bridge.beginWebhookEvent(1,event);await bridge.markWebhookApplied(1,event.eventId,event);await bridge.markWebhookForwarded(1,event.eventId,{delivered:true,attempts:1,status:200});
  await expect(bridge.beginWebhookEvent(2,{...event,callId:"other-call"})).rejects.toMatchObject({code:"EVENT_CONFLICT"});
 });
 it("admits only one distinct event per call at a time",async()=>{
  const outcomes=await Promise.all([bridge.beginWebhookEvent(1,event),bridge.beginWebhookEvent(1,{...event,eventId:"second-event"})]);
  expect(outcomes.map(x=>x.kind).sort()).toEqual(["claimed","in_progress"]);
 });
 it("does not allow an admitted older question to overwrite terminal approval",async()=>{
  const info={version:1,eventId:"old-question",callId:event.callId,soNo:event.soNo,occurredAt:"2026-09-08T13:00:00Z",state:"requires_info",question:"Old question",field:"part",urgency:"soft"};
  await bridge.beginWebhookEvent(1,info);await pool.query("UPDATE vrs_ai_call_events SET updated_at=now()-interval '3 minutes'");
  await bridge.beginWebhookEvent(1,event);await bridge.markWebhookApplied(1,event.eventId,event);
  await expect(bridge.markWebhookApplied(1,info.eventId,info)).rejects.toMatchObject({code:"STALE_EVENT"});
  expect((await pool.query("SELECT state,auth_number FROM vrs_ai_calls WHERE id=1")).rows[0]).toEqual({state:"approved",auth_number:"TEST-AUTH"});
 });
 it("rejects changed content under a signed event ID",async()=>{
  await bridge.beginWebhookEvent(1,event);
  await expect(bridge.beginWebhookEvent(1,{...event,authNumber:"DIFFERENT"})).rejects.toMatchObject({code:"EVENT_CONFLICT"});
 });
 it("allows applied-event forwarding retry without applying the ticket again",async()=>{
  await bridge.beginWebhookEvent(1,event);await bridge.markWebhookApplied(1,event.eventId,event);await bridge.markWebhookFailed(1,event.eventId,"upstream down");
  expect(await bridge.beginWebhookEvent(1,event)).toMatchObject({kind:"claimed",alreadyApplied:true});
 });
});
