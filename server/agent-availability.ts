import type { Pool } from "pg";

// A processed ticket no longer occupies its reviewer's work slot, even when
// stage-one approval leaves it pending for an external authorization.
export async function releaseProcessedTicketAgent(
  pool: Pick<Pool, "query">,
  agentId: number,
  processedSubmissionId: number,
): Promise<{ id: number; name: string } | null> {
  const result = await pool.query(
    `UPDATE users AS u SET agent_status = 'online', updated_at = now()
     WHERE u.id = $1 AND u.role = 'vrs_agent'
       AND u.is_active = true AND u.agent_status = 'working'
       AND NOT EXISTS (
         SELECT 1 FROM submissions s
         WHERE s.assigned_to = u.id AND s.id <> $2
           AND s.ticket_status = 'pending'
       )
     RETURNING u.id, u.name`,
    [agentId, processedSubmissionId],
  );
  return result.rows[0] ?? null;
}
