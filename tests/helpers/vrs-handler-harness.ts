import {registerVrsAiWebhookApi} from "../../server/vrs-sasha-api";
import {buildVrsAiWebhookAgentNotes,mapVrsAiWebhookToSubmissionDecision} from "../../server/vrs-sasha-queue";
import {browserBridgeStatus} from "../../server/vrs-bridge-photo-proxy";
import {isVrsBridgePhotoProxyEnabled} from "../../server/featureFlags";
import fs from "node:fs";
import ts from "typescript";
import express from "express";
import { z } from "zod";
import { registerVrsAiCallResultApi,buildVrsAiCallResultAgentNotes } from "../../server/vrs-ai-call-result";
import { automatedCallbackContexts,validateAutomatedApproval,VrsCallbackError } from "../../server/vrs-callback-safety";
import { makeCapturedResponse } from "../../server/external-api";
import { testReceipts } from "./direct-result-receipts";
const source=fs.readFileSync("server/routes.ts","utf8");
const a=source.indexOf("  const processActionSchema =");
const b=source.indexOf('  app.patch("/api/submissions/:id/process",',a);
const c=source.indexOf("  registerVrsAiCallResultApi(app, {");
const d=source.indexOf('  app.get("/api/admin/vrs-ai/notifications/',c);
if([a,b,c,d].some(n=>n<0))throw Error("Handler harness source boundaries changed");
const signedStart=source.indexOf("  registerVrsAiWebhookApi(app, {");
const signedEnd=source.indexOf("  const directResultReceipts =",signedStart);
const code=ts.transpileModule(source.slice(a,b)+source.slice(signedStart,signedEnd)+source.slice(c,d),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
export const approvalFixture={version:1,eventId:"handler-event",callId:"handler-call",soNo:"99090801",occurredAt:"2026-09-08T14:00:00Z",state:"approved",authNumber:"TEST-AUTH",authorizedAmount:380.6,partId:"TEST-PART",techId:"TESTTECH",partDescription:"Test part"};
export function createHandlerHarness(overrides:Record<string,any>={},options:{smsFailure?:boolean;noRgc?:boolean;linkId?:number;storage?:any;receipts?:any;bridge?:any;actor?:any;releaseAgent?:any;stageOneGate?:()=>Promise<"continue"|"responded">}={}){
 const row:any={id:1,serviceOrder:"0001-99090801",ticketStatus:"pending",authCode:null,technicianId:10,technicianLdapId:"TESTTECH",createdAt:new Date("2026-09-08T13:00:00Z"),updatedAt:new Date("2026-09-08T13:30:00Z"),assignedTo:8,stage1ReviewedBy:7,stage1ReviewedAt:new Date("2026-09-08T13:15:00Z"),reviewedBy:7,stage1Status:"approved",submissionApproved:true,requestType:"authorization",warrantyProvider:"AHS",phone:"+15555550100",partNumbers:'["TEST-PART"]',agentNotes:"Original human notes",...overrides};
 const app=express();app.use(express.json({verify:(req:any,_res,buf)=>{req.rawBody=buf}}));const updates:any[]=[];const sms:any[]=[];const userUpdates:any[]=[];
 const storage={getSubmission:async()=>({...row}),getUser:async()=>({id:8,name:"Fixture Reviewer",racId:"TESTTECH"}),getDailyRgcCode:async()=>options.noRgc?undefined:{code:"TEST-RGC"},getSubmissionCandidatesByServiceOrderSuffix:async()=>[{...row,submissionId:row.id}],updateSubmissionIfStatus:async(_id:number,statuses:string[],data:any,_assignee:any,snapshot:any)=>{if(!statuses.includes(row.ticketStatus))return undefined;updates.push({data,snapshot});Object.assign(row,data);return {...row}},updateUser:async(...args:any[])=>{userUpdates.push(args)}};
 const signedApplications:any[]=[];
 const noop=()=>{};
   const deps={app,z,registerVrsAiWebhookApi,mapVrsAiWebhookToSubmissionDecision,buildVrsAiWebhookAgentNotes,browserBridgeStatus,isVrsBridgePhotoProxyEnabled,runVrsStageOneRouteGate:options.stageOneGate ?? (async()=>"continue" as const),dispatchVrsAiForSubmission:async()=>{},buildSubmissionApprovedMessage:async()=>"fixture stage one approval",
  processVrsAiWebhookEvent:async(options:any)=>{await options.applyResult(1,options.event);signedApplications.push(options.event);return "processed"},decryptVrsCallbackSecret:()=>"test-secret",deliverVrsWebhook:async()=>({delivered:true,attempts:1,status:200}),storage:options.storage ?? storage,automatedCallbackContexts,validateAutomatedApproval,VrsCallbackError,directResultReceipts:options.receipts ?? testReceipts(),vrsBridgeStore:options.bridge ?? {getByProviderCallId:async()=>({submissionId:1}),getByAnyCallId:async()=>options.linkId?{submissionId:options.linkId}:undefined,getStatusBySubmissionId:async()=>null},registerVrsAiCallResultApi,buildVrsAiCallResultAgentNotes,makeCapturedResponse,getEtDateString:()=>"2026-09-08",buildAuthCodeMessage:async()=>"fixture auth",buildNlaApprovalMessage:async()=>"fixture nla",sendSms:async(...args:any[])=>{sms.push(args);return {success:!options.smsFailure,error:options.smsFailure?"fixture SMS outage":undefined}},broadcastToAgent:noop,broadcastToAdmins:noop,broadcastVrsAvailability:async()=>{},updateClientStatus:noop,safeLogActivity:async()=>{}};
 const availabilityDeps = { ...deps, pool: {}, releaseProcessedTicketAgent: options.releaseAgent ?? (async (_pool:any, id:number) => { userUpdates.push([id,{agentStatus:"online"}]); return {id,name:"Fixture Reviewer"}; }) };
 const handler=new Function(...Object.keys(availabilityDeps),code+"\nreturn processSubmissionHandler;")(...Object.values(availabilityDeps));
 app.post("/manual",(req:any,res)=>{req.params={id:"1"};req.user=options.actor ?? {id:8,name:"Fixture Reviewer",role:"vrs_agent"};return handler(req,res)});
 return {app,row,updates,sms,userUpdates,signedApplications};
}
