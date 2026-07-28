import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { vrsAiCalls } from "@shared/schema";
import { db } from "./storage";
import {
  DurableVrsAiCallQueue,
  type NewVrsAiCallRecord,
  type VrsAiCallDatabase,
  type VrsAiCallTransaction,
} from "./vrs-sasha-queue";

export const ACTIVE_VRS_AI_CALL_STATES = [
  "queued",
  "dialing",
  "connected",
  "awaiting_decision",
  "requires_info",
  "in_progress",
] as const;

class DrizzleVrsAiCallTransaction implements VrsAiCallTransaction {
  constructor(private readonly transaction: any) {}

  async lockServiceOrder(serviceOrder: string): Promise<void> {
    // The global admission lock makes duplicate, per-tech, and global-cap
    // checks atomic even when concurrent requests target different SOs.
    // Every enqueue acquires locks in this fixed order to avoid deadlocks.
    await this.transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('vrs-ai-admission'))`,
    );
    await this.transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`vrs-ai:${serviceOrder}`}))`,
    );
  }

  async findActiveByServiceOrder(
    serviceOrder: string,
  ): Promise<{ callId: string; state: string } | undefined> {
    const [row] = await this.transaction
      .select({ callId: vrsAiCalls.callId, state: vrsAiCalls.state })
      .from(vrsAiCalls)
      .where(
        and(
          eq(vrsAiCalls.serviceOrder, serviceOrder),
          inArray(vrsAiCalls.state, [...ACTIVE_VRS_AI_CALL_STATES]),
        ),
      )
      .limit(1);
    return row;
  }

  async getTechCallTimesSince(
    techId: string,
    since: Date,
  ): Promise<Date[]> {
    const rows = await this.transaction
      .select({ createdAt: vrsAiCalls.createdAt })
      .from(vrsAiCalls)
      .where(
        and(
          eq(vrsAiCalls.techId, techId),
          gte(vrsAiCalls.createdAt, since),
        ),
      )
      .orderBy(asc(vrsAiCalls.createdAt))
      .limit(10);
    return rows.map((row: { createdAt: Date }) => row.createdAt);
  }

  async countActiveCalls(): Promise<number> {
    const [row] = await this.transaction
      .select({ count: sql<number>`count(*)::int` })
      .from(vrsAiCalls)
      .where(inArray(vrsAiCalls.state, [...ACTIVE_VRS_AI_CALL_STATES]));
    return Number(row?.count ?? 0);
  }

  async insert(record: NewVrsAiCallRecord): Promise<void> {
    await this.transaction.insert(vrsAiCalls).values(record);
  }
}

export const vrsAiCallDatabase: VrsAiCallDatabase = {
  async transaction<T>(
    work: (transaction: VrsAiCallTransaction) => Promise<T>,
  ): Promise<T> {
    return db.transaction(async (transaction) =>
      work(new DrizzleVrsAiCallTransaction(transaction)),
    );
  },
};

export const vrsAiCallQueue = new DurableVrsAiCallQueue(vrsAiCallDatabase);
