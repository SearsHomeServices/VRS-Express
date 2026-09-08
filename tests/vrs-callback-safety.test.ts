import { testReceipts } from "./helpers/direct-result-receipts";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { registerVrsAiCallResultApi } from "../server/vrs-ai-call-result";
const event = { version:1, eventId:"fixture-event", callId:"fixture-call", soNo:"99090801", occurredAt:"2026-09-08T14:01:45.289Z", state:"approved", authNumber:"TEST-AUTH", authorizedAmount:380.6, partId:"TEST-PART", techId:"TESTTECH", partDescription:"Test part" };
const ticket = { submissionId:1, serviceOrder:"0001-99090801", ticketStatus:"pending", authCode:null, technicianLdapId:"TESTTECH", createdAt:new Date("2026-09-08T13:00:00Z"), requestType:"authorization", submissionApproved:true, stage1Status:"approved", warrantyProvider:"AHS", partNumbers:'["TEST-PART"]' };
function appFor(candidates: any[]) {
 const app=express(); app.use(express.json());
 const close=vi.fn(async()=>({kind:"closed" as const,ticketStatus:"completed",authCode:"TEST-AUTH"}));
 registerVrsAiCallResultApi(app,{receipts:testReceipts(),apiKey:"fixture-key",loadTicketCandidates:async(input:any)=>input.boundSubmissionId ? candidates.filter(row=>row.submissionId===input.boundSubmissionId) : candidates,closeTicket:close} as any);
 return {app,close};
}
describe("automated callback release guards",()=>{
 it("keeps manual/PWA ticket selection available through an explicit submissionId",async()=>{
  const {app,close}=appFor([ticket,{...ticket,submissionId:2}]);
  const res=await request(app).post("/api/integrations/vrs-ai/v1/call-result").set("X-API-Key","fixture-key").send({...event,submissionId:2});
  expect(res.status).toBe(200);expect(close).toHaveBeenCalledWith(expect.objectContaining({ticket:expect.objectContaining({submissionId:2})}));
 });
 it.each([
  ["call/order mismatch",[{...ticket,linkedByCallId:true,serviceOrder:"0001-99090802"}]],
  ["technician mismatch",[{...ticket,technicianLdapId:"OTHERTECH"}]],
  ["ambiguous tickets",[ticket,{...ticket,submissionId:2}]],
  ["human review pending",[{...ticket,submissionApproved:false,stage1Status:"pending"}]],
  ["NLA workflow",[{...ticket,requestType:"parts_nla"}]],
 ])("rejects %s without applying anything",async(_label,candidates)=>{
  const {app,close}=appFor(candidates as any[]);
  const res=await request(app).post("/api/integrations/vrs-ai/v1/call-result").set("X-API-Key","fixture-key").send(event);
  expect(res.status).toBe(409); expect(close).not.toHaveBeenCalled();
 });
});
