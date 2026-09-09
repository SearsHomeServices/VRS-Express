import express from "express";
import request from "supertest";
import {describe,it,expect,vi} from "vitest";
import {registerVrsSashaApi} from "../server/vrs-sasha-api";
import {resolveVrsAiBridgeActivation} from "../server/vrs-stage-one-bridge";
import {validV5AuthorizePayload,validV8AuthorizePayload,validV9AuthorizePayload} from "./fixtures/vrs-authorize-payloads";
describe("intake and outbound activation are independent",()=>{
 it.each([validV5AuthorizePayload,validV8AuthorizePayload,validV9AuthorizePayload])("accepts an authenticated contract while outbound production calls are disabled",async payload=>{
  const activation=resolveVrsAiBridgeActivation({NODE_ENV:"production",VRS_AI_PRODUCTION_ENABLED:"false"});expect(activation.kind).toBe("disabled");
  const receive=vi.fn(async()=>({kind:"accepted" as const,callId:"availability-test",serviceOrder:payload.service_order,createdAt:new Date()}));
  const app=express();app.use(express.json());
  registerVrsSashaApi(app,{apiKey:"availability-key",intake:{receive},resolveBridgeActivation:()=>activation} as any);
  const response=await request(app).post("/vrs/authorize").set("X-API-Key","availability-key").send(payload);
  expect(response.status).toBe(202);expect(receive).toHaveBeenCalledWith(payload);
 });
});
