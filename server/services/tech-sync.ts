// Technician sync from Snowflake — shared by the admin "Sync Now" button and
// the daily 6:00 AM ET scheduled sync. Upserts every active technician from
// Snowflake and deactivates any local technician no longer on the list.
import { storage } from "../storage";
import { fetchTechniciansFromSnowflake } from "./snowflake";

export interface TechSyncResult {
  synced: number;
  added: number;
  updated: number;
  deactivated: number;
}

export async function runTechnicianSync(): Promise<TechSyncResult> {
  const snowflakeData = await fetchTechniciansFromSnowflake();

  let added = 0;
  let updated = 0;
  const syncedLdapIds: string[] = [];

  for (const tech of snowflakeData) {
    const existing = await storage.getTechnicianByLdapId(tech.ldapId);
    await storage.upsertTechnician({
      ldapId: tech.ldapId,
      name: tech.name,
      phone: tech.phone,
      district: tech.district,
      state: tech.state,
      managerName: tech.managerName,
      techUnNo: tech.techUnNo,
      isActive: true,
      lastSyncedAt: new Date(),
    });
    syncedLdapIds.push(tech.ldapId);
    if (existing) {
      updated++;
    } else {
      added++;
    }
  }

  const deactivated = await storage.deactivateTechniciansNotIn(syncedLdapIds);

  return { synced: snowflakeData.length, added, updated, deactivated };
}

// ---------------------------------------------------------------------------
// Daily scheduler: runs runTechnicianSync() at 6:00 AM America/New_York every
// day, DST-safe (computes the next 6 AM ET occurrence from wall-clock time in
// that zone rather than a fixed UTC offset). Best-effort: a failed sync logs
// and waits for the next day — it never crashes the server.
// ---------------------------------------------------------------------------

const SYNC_HOUR_ET = 6;
const TZ = "America/New_York";

function msUntilNext6amET(now: Date = new Date()): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(now).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const etNow = {
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10),
    day: parseInt(parts.day, 10),
    hour: parseInt(parts.hour, 10) % 24,
    minute: parseInt(parts.minute, 10),
    second: parseInt(parts.second, 10),
  };

  // Seconds elapsed since ET midnight, and target seconds (6:00:00).
  const nowSecs = etNow.hour * 3600 + etNow.minute * 60 + etNow.second;
  const targetSecs = SYNC_HOUR_ET * 3600;
  let deltaSecs = targetSecs - nowSecs;
  if (deltaSecs <= 0) deltaSecs += 24 * 3600; // next day

  // deltaSecs is exact except across a DST transition (off by ±1h at most).
  // Correct by re-checking the ET hour at the candidate time and nudging.
  let candidate = now.getTime() + deltaSecs * 1000;
  for (let i = 0; i < 3; i++) {
    const h = parseInt(
      new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour12: false, hour: "2-digit" })
        .format(new Date(candidate)),
      10,
    ) % 24;
    if (h === SYNC_HOUR_ET) break;
    candidate += (SYNC_HOUR_ET - h + (SYNC_HOUR_ET - h < -12 ? 24 : SYNC_HOUR_ET - h > 12 ? -24 : 0)) * 3600 * 1000;
  }
  return Math.max(candidate - now.getTime(), 60_000);
}

export function scheduleDailyTechnicianSync(log: (msg: string) => void): void {
  const scheduleNext = () => {
    const delay = msUntilNext6amET();
    log(
      `[tech-sync] next scheduled sync in ${(delay / 3600000).toFixed(2)}h (6:00 AM ET daily)`,
    );
    setTimeout(async () => {
      try {
        const r = await runTechnicianSync();
        log(
          `[tech-sync] daily sync complete: ${r.synced} synced, ${r.added} added, ${r.updated} updated, ${r.deactivated} deactivated`,
        );
      } catch (err: any) {
        log(`[tech-sync] daily sync failed: ${err?.message || String(err)}`);
      } finally {
        scheduleNext();
      }
    }, delay);
  };
  scheduleNext();
}
