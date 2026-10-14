import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createHandlerHarness } from "./helpers/vrs-handler-harness";
import { releaseProcessedTicketAgent } from "../server/agent-availability";

describe("availability after processing", () => {
  it.each(["admin", "super_admin"])("releases the assigned agent, not the %s reviewer", async role => {
    const release = vi.fn().mockResolvedValue({id:44,name:"Assigned Agent"});
    const f = createHandlerHarness({assignedTo:44}, {
      actor:{id:12,name:"Admin",role}, releaseAgent:release,
    });
    const res = await request(f.app).post("/manual").send({action:"approve",authCode:"TEST"});
    expect(res.status).toBe(200);
    expect(release).toHaveBeenCalledExactlyOnceWith({},44,1);
    expect(f.row.ticketStatus).toBe("completed");
  });
  it("checks a normal agent only once when actor and assignee match", async () => {
    const release = vi.fn().mockResolvedValue({id:8,name:"Agent"});
    const f = createHandlerHarness({}, {releaseAgent:release});
    expect((await request(f.app).post("/manual").send({action:"approve",authCode:"TEST"})).status).toBe(200);
    expect(release).toHaveBeenCalledExactlyOnceWith({},8,1);
  });
  it("keeps ticket success when availability update fails", async () => {
    const f = createHandlerHarness({}, {releaseAgent:vi.fn().mockRejectedValue(new Error("DB unavailable"))});
    expect((await request(f.app).post("/manual").send({action:"approve",authCode:"TEST"})).status).toBe(200);
    expect(f.row.ticketStatus).toBe("completed");
    expect(f.sms).toHaveLength(1);
  });
  it("uses a conditional database update and does not report release when blocked", async () => {
    const query = vi.fn().mockResolvedValue({rows:[]});
    expect(await releaseProcessedTicketAgent({query} as any,44,123)).toBeNull();
    expect(query.mock.calls[0][1]).toEqual([44,123]);
    const sql = query.mock.calls[0][0];
    expect(sql).toContain("s.assigned_to = u.id AND s.id <> $2");
    expect(sql).toContain("s.ticket_status = 'pending'");
    expect(sql).toContain("u.agent_status = 'working'");
    expect(sql).toContain("u.is_active = true");
    expect(sql).toContain("u.role = 'vrs_agent'");
  });
});
