import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({record:vi.fn(async()=>({id:1})),send:vi.fn()}));
vi.mock("../server/storage",()=>({storage:{createSmsNotification:mocks.record}}));
vi.mock("twilio",()=>({default:()=>({messages:{create:mocks.send}})}));
import {sendSms,sendSmsMessage} from "../server/sms";
const names=["NODE_ENV","TWILIO_ACCOUNT_SID","TWILIO_AUTH_TOKEN","TWILIO_PHONE_NUMBER"];
let previous:Record<string,string|undefined>;
beforeEach(()=>{previous=Object.fromEntries(names.map(name=>[name,process.env[name]]));names.forEach(name=>delete process.env[name]);vi.clearAllMocks()});
afterEach(()=>names.forEach(name=>{if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name]}));
describe("production callback notification truth",()=>{
 it("never reports a production mock as a sent notification",async()=>{
  process.env.NODE_ENV="production";
  expect((await sendSms(1,"+15555550100","ticket_approved","fixture")).success).toBe(false);
  expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({twilioSid:expect.stringContaining("ERROR:")}));
  expect((await sendSmsMessage("+15555550100","fixture")).success).toBe(false);
 });
 it("preserves explicit development mock behavior",async()=>{
  process.env.NODE_ENV="development";expect((await sendSms(1,"+15555550100","ticket_approved","fixture")).twilioSid).toMatch(/^MOCK_/);
 });
 it("preserves configured real-send behavior with a fake provider",async()=>{
  process.env.NODE_ENV="production";process.env.TWILIO_ACCOUNT_SID="fixture";process.env.TWILIO_AUTH_TOKEN="fixture";process.env.TWILIO_PHONE_NUMBER="+15555550101";mocks.send.mockResolvedValue({sid:"SM_fixture"});
  expect(await sendSms(1,"+15555550100","ticket_approved","fixture")).toMatchObject({success:true,twilioSid:"SM_fixture"});
 });
});
