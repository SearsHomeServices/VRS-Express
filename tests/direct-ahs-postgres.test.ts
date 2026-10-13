import { Pool } from "pg";
import { getTableConfig } from "drizzle-orm/pg-core";
import { users, submissions } from "../shared/schema";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";
import { createHmac } from "crypto";
import { ensureDirectAhsSchema } from "../server/direct-ahs/schema";
import { DirectAhsStore } from "../server/direct-ahs/store";
import { registerDirectAhsRoutes } from "../server/direct-ahs/routes";
const socket=process.env.DIRECT_AHS_TEST_SOCKET;
let pool:Pool,store:DirectAhsStore,app:express.Express;
const actor={id:1,role:"vrs_agent"},media=async()=>({photoUrls:[],videoUrl:null,voiceNoteUrl:null});
const config={origin:"https://ai.test",apiKey:"test",webhookSecret:"test",callbackUrl:"https://express.test/api/integrations/direct-ahs/v1/result"};
let failSend=false;
describe.skipIf(!socket)("direct AHS HTTP + real disposable PostgreSQL",()=>{
  beforeAll(async()=>{
    if(!socket?.startsWith("/tmp/direct-ahs-test-"))throw Error("Disposable socket required");
    pool=new Pool({host:socket,port:55440,user:"direct_ahs_test",database:"direct_ahs_test"});
    for(const table of [users,submissions]){
      const conf=getTableConfig(table);
      await pool.query(`CREATE TABLE "${conf.name}" (${conf.columns.map(c=>`"${c.name}" ${c.getSQLType()}${c.primary?" PRIMARY KEY":""}`).join(",")})`);
    }
    await pool.query("CREATE TABLE vrs_ai_calls (submission_id integer)");
    await ensureDirectAhsSchema(pool);
    store=new DirectAhsStore(pool);
    app=express();
    app.use(express.json({verify(req:any,_res,buf){req.rawBody=buf;}}));
    registerDirectAhsRoutes(app,{store,authenticate:(req:any,_res,next)=>{req.user=actor;next();},config:()=>config,webhookSecret:()=>"test",media,
      send:async()=>{if(failSend)throw Error("timeout");return "call";}});
  });
  afterAll(async()=>{await pool?.end();});
  beforeEach(async()=>{
    failSend=false;
    await pool.query("TRUNCATE direct_ahs_events,direct_ahs_workflows,submissions,users,vrs_ai_calls CASCADE");
    await pool.query("INSERT INTO users(id,name,rac_id) VALUES(1,'Reviewer','AGENT'),(2,'IH Tech','IH')");
    await pool.query(`INSERT INTO submissions(id,technician_id,service_order,phone,warranty_type,request_type,ticket_status,assigned_to,issue_description,appliance_type,submission_approved)
      VALUES(1,2,'12345678','5555550123','american_home_shield','authorization','pending',1,'Diagnosis','laundry',false)`);
  });
  const enroll=async()=>{const response=await request(app).post("/api/submissions/1/direct-ahs").send({reviewNotes:"Evidence checked"});expect(response.status).toBe(202);return response.body.workflow.id as string;};
  const event=(id:string,state="approved",sms="sent",sequence=1)=>({
    version:1,source:"vrs_express_direct_ahs",requestId:id,submissionId:1,eventId:`event-${sequence}`,sequence,callId:"call",serviceOrder:"12345678",
    technicianId:"IH",occurredAt:new Date().toISOString(),outcome:"decision",decision:{state,code:"CODE1",notes:"AHS decision"},
    sms:{status:sms,recipient:"+15555550123",...(["sent","delivered"].includes(sms)?{providerMessageId:"sms-one",body:"AHS decision CODE1"}:{})},
  });
  const callback=(body:any)=>{
    const raw=JSON.stringify(body),time=String(Math.floor(Date.now()/1000));
    const signature="sha256="+createHmac("sha256","test").update(`${time}.${raw}`).digest("hex");
    return request(app).post("/api/integrations/direct-ahs/v1/result").set("Content-Type","application/json").set("x-direct-ahs-timestamp",time).set("x-direct-ahs-signature",signature).send(raw);
  };
  for(const state of ["approved","denied"])it(`closes ${state} end-to-end, saves WOM notes, deduplicates`,async()=>{
    const id=await enroll(),body=event(id,state);
    expect((await callback(body)).status).toBe(200);
    expect((await callback(body)).body.duplicate).toBe(true);
    const ticket=(await pool.query("SELECT * FROM submissions WHERE id=1")).rows[0];
    expect(ticket.ticket_status).toBe(state==="approved"?"completed":"rejected_closed");
    expect(ticket.stage1_status).toBe(state==="approved"?"approved":"rejected");
    expect(ticket.agent_notes).toContain("CODE1");
    const saved=await store.get(1,actor);
    expect((saved.workflow?.womNotes as any).womWriteStatus).toBe("not_requested");
    expect((await pool.query("SELECT count(*) FROM vrs_ai_calls")).rows[0].count).toBe("0");
  });
  it("keeps failed SMS open; a later successful SMS closes; old events cannot reopen",async()=>{
    const id=await enroll(),first=event(id,"denied","failed");
    expect((await callback(first)).body.workflow.state).toBe("awaiting_sms");
    expect((await pool.query("SELECT ticket_status FROM submissions")).rows[0].ticket_status).toBe("pending");
    expect((await callback(event(id,"denied","sent",2))).body.workflow.state).toBe("completed");
    expect((await callback(first)).body.duplicate).toBe(true);
  });
  it("rejects wrong binding, signature, reused event IDs and changed decision",async()=>{
    const id=await enroll(),body=event(id,"approved","pending");
    expect((await callback({...body,technicianId:"OTHER"})).status).toBe(409);
    expect((await request(app).post("/api/integrations/direct-ahs/v1/result").send(body)).status).toBe(401);
    expect((await callback(body)).status).toBe(200);
    expect((await callback({...body,decision:{...body.decision,code:"WRONG"}})).status).toBe(409);
    expect((await callback(event(id,"denied","sent",2))).status).toBe(409);
  });
  it("blocks manual overwrites and double dispatch; preserves same ID on timeout retry",async()=>{
    failSend=true;
    const id=await enroll();
    expect((await store.get(1,actor)).workflow?.state).toBe("dispatch_unknown");
    await expect(pool.query("UPDATE submissions SET ticket_status='completed' WHERE id=1")).rejects.toThrow("Direct AHS");
    expect((await request(app).post("/api/submissions/1/direct-ahs").send({reviewNotes:"again"})).status).toBe(409);
    failSend=false;
    const retry=await request(app).post("/api/submissions/1/direct-ahs/retry").send({});
    expect(retry.status).toBe(202);
    expect(retry.body.workflow.id).toBe(id);
    expect(retry.body.workflow.state).toBe("awaiting_result");
  });
  it("does not block unenrolled Sasha/legacy updates and refuses Sasha enrollment",async()=>{
    await pool.query("INSERT INTO vrs_ai_calls VALUES(1)");
    expect((await request(app).post("/api/submissions/1/direct-ahs").send({reviewNotes:"review"})).status).toBe(409);
    await expect(pool.query("UPDATE submissions SET ticket_status='completed' WHERE id=1")).resolves.toBeDefined();
  });
  it("serializes concurrent approval clicks",async()=>{
    const responses=await Promise.all([1,2].map(()=>request(app).post("/api/submissions/1/direct-ahs").send({reviewNotes:"checked"})));
    expect(responses.map(r=>r.status).sort()).toEqual([202,409]);
  });
});
