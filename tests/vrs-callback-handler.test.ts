import {testReceipts} from "./helpers/direct-result-receipts";
import {createVrsWebhookSignature} from "../server/vrs-sasha-contract";
import {buildVrsAiWebhookAgentNotes} from "../server/vrs-sasha-queue";
import request from "supertest";
import {beforeEach,afterEach,describe,it,expect} from "vitest";
import {createHandlerHarness,approvalFixture} from "./helpers/vrs-handler-harness";
let oldKey:string|undefined;let oldEnabled:string|undefined;let oldWebhook:string|undefined;
beforeEach(()=>{oldWebhook=process.env.VRS_AI_WEBHOOK_SECRET;process.env.VRS_AI_WEBHOOK_SECRET="signed-handler-key";oldKey=process.env.VRS_SASHA_API_KEY;oldEnabled=process.env.VRS_AI_CALL_RESULT_ENABLED;process.env.VRS_SASHA_API_KEY="handler-test-key";delete process.env.VRS_AI_CALL_RESULT_ENABLED});
afterEach(()=>{if(oldWebhook===undefined)delete process.env.VRS_AI_WEBHOOK_SECRET;else process.env.VRS_AI_WEBHOOK_SECRET=oldWebhook;if(oldKey===undefined)delete process.env.VRS_SASHA_API_KEY;else process.env.VRS_SASHA_API_KEY=oldKey;if(oldEnabled===undefined)delete process.env.VRS_AI_CALL_RESULT_ENABLED;else process.env.VRS_AI_CALL_RESULT_ENABLED=oldEnabled});
const post=(app:any)=>request(app).post("/api/integrations/vrs-ai/v1/call-result").set("X-API-Key","handler-test-key").send(approvalFixture);
describe("real handler callback and manual workflow regression",()=>{
 it("does not mistake a competing manual completion for this callback's application",async()=>{
  const f=createHandlerHarness({ticketStatus:"completed",authCode:"TEST-AUTH",agentNotes:"Manual approval"},{receipts:testReceipts(1)});
  const result=await post(f.app);expect(result.status).toBe(409);expect(f.sms).toHaveLength(0);expect(f.updates).toHaveLength(0);
 });

 it.each([{techId:"OTHERTECH"},{partId:"OTHER-PART"}])("checks completed signed recovery metadata before claiming success: %j",async change=>{
  const f=createHandlerHarness({ticketStatus:"completed",authCode:"TEST-AUTH"});const event={...approvalFixture,...change};const body=JSON.stringify(event);
  const res=await request(f.app).post("/api/integrations/vrs-ai/v1/webhook").set("Content-Type","application/json").set("X-VRS-Signature",createVrsWebhookSignature(body,"signed-handler-key")).set("X-VRS-Event-Id",event.eventId).set("X-VRS-Timestamp",String(Date.now())).send(body);
  expect(res.status).toBe(409);expect(f.signedApplications).toHaveLength(0);expect(f.sms).toHaveLength(0);
 });
 it("retains matching completed signed recovery without duplicate effects",async()=>{
   const f=createHandlerHarness({ticketStatus:"completed",authCode:"TEST-AUTH",agentNotes:`Original human notes\n\n${buildVrsAiWebhookAgentNotes(approvalFixture)}`});const body=JSON.stringify(approvalFixture);
  const res=await request(f.app).post("/api/integrations/vrs-ai/v1/webhook").set("Content-Type","application/json").set("X-VRS-Signature",createVrsWebhookSignature(body,"signed-handler-key")).set("X-VRS-Event-Id",approvalFixture.eventId).set("X-VRS-Timestamp",String(Date.now())).send(body);
  expect(res.status).toBe(200);expect(f.signedApplications).toHaveLength(1);expect(f.sms).toHaveLength(0);
 });

 it("closes a reviewed authorization, preserves human audit, and reports notification acceptance",async()=>{
  const f=createHandlerHarness();const original=f.row.stage1ReviewedAt;const res=await post(f.app);
  expect(res.status).toBe(200);expect(res.body.notification.status).toBe("accepted");expect(f.updates).toHaveLength(1);expect(f.sms).toHaveLength(1);
   expect(f.row.stage1ReviewedBy).toBe(7);expect(f.row.stage1ReviewedAt).toEqual(original);expect(f.row.agentNotes).toContain("Original human notes");expect(f.row.agentNotes).toContain("$380.60");expect(f.row.agentNotes).toContain("auth TEST-AUTH");expect(f.row.agentNotes).toContain("handler-event");expect(f.row.agentNotes).toContain("handler-call");expect(f.row.agentNotes).toContain("Part TEST-PART: Test part.");expect(f.row.agentNotes).toContain("Tech TESTTECH.");expect(f.updates[0].snapshot).toBeDefined();
 });
  it("persists the signed Bridge summary with closure and never duplicates it on retry",async()=>{
   const f=createHandlerHarness();const body=JSON.stringify({...approvalFixture,durationSec:187,recordingUrl:"https://recordings.example.test/handler.wav"});
   const signed=()=>request(f.app).post("/api/integrations/vrs-ai/v1/webhook").set("Content-Type","application/json").set("X-VRS-Signature",createVrsWebhookSignature(body,"signed-handler-key")).set("X-VRS-Event-Id",approvalFixture.eventId).set("X-VRS-Timestamp",String(Date.now())).send(body);
   expect((await signed()).status).toBe(200);expect(f.row.ticketStatus).toBe("completed");expect(f.row.agentNotes).toContain("Call duration 187s.");expect(f.row.agentNotes).toContain("Recording: https://recordings.example.test/handler.wav");
   expect((await signed()).status).toBe(200);expect(f.updates).toHaveLength(1);expect(f.sms).toHaveLength(1);expect(f.row.agentNotes.split("handler-event")).toHaveLength(2);
  });
 it.each([{submissionApproved:false,stage1Status:"pending"},{requestType:"parts_nla"},{serviceOrder:"0001-99090802"},{technicianLdapId:"OTHERTECH"}])("blocks an ineligible automation: %j",async change=>{
  const f=createHandlerHarness(change,{linkId:1});expect((await post(f.app)).status).toBe(409);expect(f.updates).toHaveLength(0);expect(f.sms).toHaveLength(0);
 });
 it("preserves the manual agent approval path and its online-status restoration",async()=>{
  const f=createHandlerHarness({submissionApproved:false,stage1Status:"pending"});const res=await request(f.app).post("/manual").send({action:"approve",authCode:"MANUAL-AUTH",agentNotes:"Manual notes"});
  expect(res.status).toBe(200);expect(f.row.authCode).toBe("MANUAL-AUTH");expect(f.row.agentNotes).toBe("Manual notes");expect(f.userUpdates).toHaveLength(1);expect(f.updates[0].snapshot).toBeUndefined();
 });
 it("keeps a direct missing-RGC failure unapplied and retryable after operator correction",async()=>{
   const f=createHandlerHarness({},{noRgc:true});expect((await post(f.app)).status).toBe(422);expect(f.updates).toHaveLength(0);expect(f.row.agentNotes).toBe("Original human notes");expect(f.row.ticketStatus).toBe("pending");
 });
  it("keeps a signed Bridge missing-RGC failure from saving success notes",async()=>{
   const f=createHandlerHarness({},{noRgc:true});const body=JSON.stringify(approvalFixture);
   const res=await request(f.app).post("/api/integrations/vrs-ai/v1/webhook").set("Content-Type","application/json").set("X-VRS-Signature",createVrsWebhookSignature(body,"signed-handler-key")).set("X-VRS-Event-Id",approvalFixture.eventId).set("X-VRS-Timestamp",String(Date.now())).send(body);
   expect(res.status).toBe(500);expect(f.updates).toHaveLength(0);expect(f.sms).toHaveLength(0);expect(f.row.agentNotes).toBe("Original human notes");expect(f.row.ticketStatus).toBe("pending");
  });
 it("reports SMS failure separately from completed authorization",async()=>{
  const f=createHandlerHarness({},{smsFailure:true});const res=await post(f.app);expect(res.status).toBe(200);expect(res.body.closed).toBe(true);expect(res.body.notification).toMatchObject({status:"failed"});expect(f.updates).toHaveLength(1);
 });
 it("supports pausing direct callbacks without altering manual processing",async()=>{
  process.env.VRS_AI_CALL_RESULT_ENABLED="false";const f=createHandlerHarness();expect((await post(f.app)).status).toBe(503);
  expect((await request(f.app).post("/manual").send({action:"approve",authCode:"MANUAL-AUTH"})).status).toBe(200);
 });
});
