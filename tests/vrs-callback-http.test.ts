import fs from "node:fs";
import ts from "typescript";
import {upstreamVrsWebhookEvent} from "../server/vrs-sasha-queue";
import {normalizeVrsProviderState} from "../server/vrs-sasha-contract";
import express from "express";
import request from "supertest";
import {describe,it,expect} from "vitest";
import {apiNotFound} from "../server/api-not-found";
import {deliverVrsWebhook} from "../server/vrs-sasha-contract";
const event={version:1 as const,eventId:"http-event",callId:"http-call",soNo:"99090801",occurredAt:"2026-09-08T14:00:00Z",state:"approved" as const,authNumber:"TEST",authorizedAmount:1};
describe("callback acknowledgment and SPA boundaries",()=>{
 it("keeps the signed upstream envelope stable while retaining rich local metadata",()=>{
  const rich={...event,partId:"TEST-PART",techId:"TESTTECH",partDescription:"Test part"};
  expect(upstreamVrsWebhookEvent(rich)).toEqual(event);expect(rich.partId).toBe("TEST-PART");
 });
 it("keeps reviewing and unfamiliar provider admission states inside active-call handling",()=>{
  expect(normalizeVrsProviderState("reviewing")).toBe("reviewing");expect(normalizeVrsProviderState("new-provider-state")).toBe("queued");
 });
 it("executes the documented direct sender validator against real and false receipts",()=>{
  const doc=fs.readFileSync("docs/integration/vrs-ai-call-result-close.md","utf8");
  const snippet=doc.match(/```typescript\n([\s\S]*?)\n```/)?.[1];expect(snippet).toBeTruthy();
  const code=ts.transpileModule(snippet!,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const validate=new Function(code+";return validateCallResultAcknowledgment;")();
  const body={ok:true,closed:true,deduped:false,event_id:event.eventId,call_id:event.callId,service_order:"0001-99090801",auth_number:event.authNumber,ticket_status:"completed",submission_id:1};
  const json=new Response("",{status:200,headers:{"content-type":"application/json"}});
  expect(validate(json,body,event)).toBe(true);
  expect(validate(new Response("<html>app</html>",{status:200,headers:{"content-type":"text/html"}}),{},event)).toBeFalsy();
  expect(validate(json,{...body,event_id:"wrong"},event)).toBeFalsy();
  expect(validate(json,{...body,closed:false,deduped:false},event)).toBeFalsy();
 });

 it("unknown APIs return JSON 404 while known APIs and SPA pages work",async()=>{
  const app=express();app.get("/api/known",(_q,s)=>s.json({ok:true}));app.use(apiNotFound);app.use((_q,s)=>s.type("html").send("<html>app</html>"));
  expect((await request(app).post("/api/missing")).status).toBe(404);
  expect((await request(app).post("/vrs/missing")).body.error).toBe("NOT_FOUND");
  expect((await request(app).get("/api/known")).status).toBe(200);
  expect((await request(app).get("/agent/dashboard")).text).toBe("<html>app</html>");
 });
 it.each(["<html>app</html>",'{"ok":false}', '{"ok":true,"eventId":"wrong"}'])("rejects false upstream 200 acknowledgments: %s",async body=>{
  const result=await deliverVrsWebhook({callbackUrl:"https://sasha-dev.stage.nextgen.shs.com/sasha/api/vrs/webhook",callbackSecret:"fixture-secret",event,fetchImpl:async()=>new Response(body,{status:200}),sleep:async()=>{}});
  expect(result.delivered).toBe(false);
 });
 it("preserves the legacy empty-200 partner acknowledgment",async()=>{
  const result=await deliverVrsWebhook({callbackUrl:"https://sasha-dev.stage.nextgen.shs.com/sasha/api/vrs/webhook",callbackSecret:"fixture-secret",event,fetchImpl:async()=>new Response(null,{status:200})});
  expect(result.delivered).toBe(true);
 });
});
