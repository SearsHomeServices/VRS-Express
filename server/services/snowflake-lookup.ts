export type ProcIdResult =
  | { status: "FOUND" | "NOT_FOUND"; procId: string; clientNm: string }
  | { status: "LOOKUP_UNAVAILABLE"; retryable: true };

export function normalizeServiceOrder(raw: string): string {
  const value = raw.trim();
  return (value.includes("-") ? value.split("-")[1] : value).trim();
}

/** Do not persist an outage as missing data, including partially-known records. */
export async function applyProcIdRepair(
  result: ProcIdResult,
  update: (fields: { procId: string; clientNm: string }) => Promise<unknown>,
): Promise<ProcIdResult["status"]> {
  if (result.status !== "LOOKUP_UNAVAILABLE") {
    await update({ procId: result.procId, clientNm: result.clientNm });
  }
  return result.status;
}

/** Process-local bounded admission, including time spent waiting for a slot. */
export function createProcLookup(
  query: (key: string, signal: AbortSignal) => Promise<any[]>,
  options: { concurrency?: number; queueLimit?: number; deadlineMs?: number;
    positiveMs?: number; negativeMs?: number; unavailableMs?: number; cacheSize?: number } = {},
) {
  const { concurrency = 4, queueLimit = 32, deadlineMs = 15000,
    positiveMs = 21600000, negativeMs = 120000, unavailableMs = 5000, cacheSize = 5000 } = options;
  const cache = new Map<string, { result: ProcIdResult; expires: number }>();
  const pending = new Map<string, Promise<ProcIdResult>>();
  const queue: Array<() => void> = [];
  let active = 0;
  const unavailable = (): ProcIdResult => ({ status: "LOOKUP_UNAVAILABLE", retryable: true });
  return (raw: string): Promise<ProcIdResult> => {
    const key = normalizeServiceOrder(raw);
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return Promise.resolve(hit.result);
    cache.delete(key);
    const existing = pending.get(key);
    if (existing) return existing;
    // Overload is transient, not a negative lookup, and does not grow the cache.
    if (active >= concurrency && queue.length >= queueLimit) return Promise.resolve(unavailable());
    const controller = new AbortController();
    let start: () => void;
    const work = new Promise<ProcIdResult>((resolve) => {
      let finished = false;
      let started = false;
      const finish = (result: ProcIdResult) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        controller.abort(); // release underlying statement and socket on every exit
        if (started) active--;
        else {
          const index = queue.indexOf(start);
          if (index >= 0) queue.splice(index, 1);
        }
        const ttl = result.status === "FOUND" ? positiveMs
          : result.status === "NOT_FOUND" ? negativeMs : unavailableMs;
        cache.set(key, { result, expires: Date.now() + ttl });
        while (cache.size > cacheSize) cache.delete(cache.keys().next().value!);
        resolve(result);
        if (active < concurrency) queue.shift()?.();
      };
      const timer = setTimeout(() => finish(unavailable()), deadlineMs);
      start = () => {
        started = true;
        active++;
        // Attach both handlers immediately; late completions cannot mutate cache.
        Promise.resolve().then(() => query(key, controller.signal)).then(rows => {
          finish(rows.length ? {
            status: "FOUND",
            procId: String(rows[0].CMB_THD_PTY_ID ?? "").trim() || "Not Found",
            clientNm: String(rows[0].CLIENT_NM ?? "").trim() || "Not Found",
          } : { status: "NOT_FOUND", procId: "Not Found", clientNm: "Not Found" });
        }, () => finish(unavailable()));
      };
      if (active < concurrency) start();
      else queue.push(start);
    });
    pending.set(key, work);
    void work.then(() => pending.delete(key));
    return work;
  };
}