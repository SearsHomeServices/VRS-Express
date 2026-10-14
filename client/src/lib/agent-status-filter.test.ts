import { describe, expect, it } from "vitest";
import { filterAgents } from "./agent-status-filter";

const agents = [
  { id: 7, name: "Amara Chen", racId: "ENT-204", agentStatus: "online" },
  { id: 3, name: "Riley Chen", racId: "ENT-731", agentStatus: "working" },
  { id: 9, name: "Sofia Patel", racId: null, agentStatus: "offline" },
  { id: 5, name: "Devon Ross", racId: "", agentStatus: "unknown" },
];

describe("filterAgents", () => {
  it("returns every agent in existing order for empty or whitespace search", () => {
    expect(filterAgents(agents, "", "all")).toEqual(agents);
    expect(filterAgents(agents, "   ", "all")).toEqual(agents);
  });

  it("matches a trimmed case-insensitive partial name", () => {
    expect(filterAgents(agents, "  cHeN  ", "all")).toEqual(agents.slice(0, 2));
  });

  it("matches a trimmed case-insensitive partial enterprise ID", () => {
    expect(filterAgents(agents, "  eNt-7 ", "all")).toEqual([agents[1]]);
  });

  it.each(["online", "working", "offline"] as const)("filters exactly by %s", (status) => {
    expect(filterAgents(agents, "", status)).toEqual(
      agents.filter((agent) => agent.agentStatus === status),
    );
  });

  it("combines search and status rather than matching either predicate", () => {
    expect(filterAgents(agents, "chen", "working")).toEqual([agents[1]]);
    expect(filterAgents(agents, "ENT-204", "offline")).toEqual([]);
  });

  it("handles missing enterprise IDs and no matches", () => {
    expect(filterAgents(agents, "PATEL", "all")).toEqual([agents[2]]);
    expect(filterAgents(agents, "missing", "all")).toEqual([]);
    expect(filterAgents([], "chen", "online")).toEqual([]);
  });

  it("does not mutate the source list and retains record identity", () => {
    const source = Object.freeze([...agents]);
    const result = filterAgents(source, "chen", "all");
    expect(source).toEqual(agents);
    expect(result).not.toBe(source);
    expect(result[0]).toBe(agents[0]);
    expect(result[1]).toBe(agents[1]);
  });

  it("restores the full list when both filters are cleared", () => {
    expect(filterAgents(agents, "chen", "offline")).toEqual([]);
    expect(filterAgents(agents, "", "all")).toEqual(agents);
  });
});
