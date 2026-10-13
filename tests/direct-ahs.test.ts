import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";
import { directAhsConfig, verifyDirectAhsSignature, sendDirectAhs } from "../server/direct-ahs/contract";
import { directAhsResultSchema, normalizeIhPhone } from "../shared/direct-ahs";
import { directAhsEligibility } from "../server/direct-ahs/store";
import { directAhsMedia } from "../server/direct-ahs/routes";

describe("isolated direct AHS contract", () => {
  it("is disabled by default and never falls back to Sasha configuration", () => {
    expect(directAhsConfig({ VRS_AI_BASE_URL: "https://example.com", VRS_SASHA_API_KEY: "test" })).toBeNull();
  });
  it("authenticates exact bytes and rejects stale signatures", () => {
    const raw = Buffer.from('{"test":1}'), timestamp = String(Math.floor(Date.now()/1000));
    const sig = "sha256="+createHmac("sha256","test").update(`${timestamp}.`).update(raw).digest("hex");
    expect(verifyDirectAhsSignature(raw,timestamp,sig,"test")).toBe(true);
    expect(verifyDirectAhsSignature(Buffer.from("{}"),timestamp,sig,"test")).toBe(false);
    expect(verifyDirectAhsSignature(raw,timestamp,sig,"test",Date.now()+400000)).toBe(false);
  });
  it("requires a decision code and proof of code-bearing SMS before sent", () => {
    const event = {version:1,source:"vrs_express_direct_ahs",requestId:"00000000-0000-4000-8000-000000000001",
      submissionId:1,eventId:"one",sequence:1,callId:"call",serviceOrder:"12345678",technicianId:"IH",
      occurredAt:new Date().toISOString(),outcome:"decision",decision:{state:"denied",code:"D123",notes:"Not covered"},
      sms:{status:"sent",recipient:"+15555550123",providerMessageId:"sms",body:"AHS denied: D123"}};
    expect(directAhsResultSchema.safeParse(event).success).toBe(true);
    expect(directAhsResultSchema.safeParse({...event,sms:{...event.sms,body:"No code"}}).success).toBe(false);
    expect(directAhsResultSchema.safeParse({...event,decision:{...event.decision,code:""}}).success).toBe(false);
  });
  it("rejects Sasha, non-AHS, wrong agent and non-authorization tickets", () => {
    const ticket = {warranty_type:"american_home_shield",request_type:"authorization",ticket_status:"pending",assigned_to:1};
    const actor={id:1,role:"vrs_agent"};
    expect(directAhsEligibility(ticket,actor)).toBeNull();
    for(const change of [{bridge_linked:true},{warranty_type:"first_american"},{assigned_to:2},{request_type:"parts_nla"},{submission_approved:true}]) {
      expect(directAhsEligibility({...ticket,...change},actor)).not.toBeNull();
    }
  });
  it("normalizes phone numbers and signs only uploaded media", async () => {
    expect(normalizeIhPhone("(555) 555-0123")).toBe("+15555550123");
    expect(normalizeIhPhone("123")).toBeNull();
    expect(await directAhsMedia({photos:'["/objects/a"]'}, async p=>`https://storage.test${p}`)).toEqual({photoUrls:["https://storage.test/objects/a"],videoUrl:null,voiceNoteUrl:null});
    await expect(directAhsMedia({photos:'["http://localhost/private"]'},async p=>p)).rejects.toThrow();
  });
  it("sends the stable idempotency key to the independent endpoint only", async () => {
    const payload:any={requestId:"request",callbackUrl:"https://express.test/api/integrations/direct-ahs/v1/result"};
    const fetcher:any=async(url:string,options:any)=>{
      expect(url).toBe("https://ai.test/api/direct-ahs/v1/authorize");
      expect(options.headers["Idempotency-Key"]).toBe("request");
      expect(options.redirect).toBe("error");
      return {status:202,json:async()=>({requestId:"request",callId:"call",status:"accepted"})};
    };
    expect(await sendDirectAhs(payload,{origin:"https://ai.test",apiKey:"test",callbackUrl:payload.callbackUrl,webhookSecret:"test"},fetcher)).toBe("call");
  });
});
