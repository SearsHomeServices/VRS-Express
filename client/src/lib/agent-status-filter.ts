export type AgentStatusFilter = "all" | "online" | "working" | "offline";

type FilterableAgent = {
  name: string;
  racId: string | null;
  agentStatus: string;
};

/** Filter an already-sorted list without changing its order or records. */
export function filterAgents<T extends FilterableAgent>(
  agents: readonly T[],
  search: string,
  status: AgentStatusFilter,
): T[] {
  const query = search.trim().toLowerCase();
  return agents.filter((agent) =>
    (status === "all" || agent.agentStatus === status) &&
    (!query ||
      agent.name.toLowerCase().includes(query) ||
      (agent.racId ?? "").toLowerCase().includes(query)),
  );
}
