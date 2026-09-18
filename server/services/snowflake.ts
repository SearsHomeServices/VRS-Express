import { createPrivateKey } from "node:crypto";
import { createRequire } from "node:module";
import type { Connection } from "snowflake-sdk";

// tsx runs this file as ESM; the production bundle runs as CJS. Resolve from
// the current module in either runtime, not the process working directory.
// Creating the loader does not load the SDK until the first probe/lookup.
const requireSnowflake = createRequire(
  typeof __filename !== "undefined" ? __filename : import.meta.url,
);

type SnowflakeSDK = typeof import("snowflake-sdk") & {
  VERSION?: string;
  Version?: string;
};

let snowflake: SnowflakeSDK | null = null;

// Tyler 2026-05-01 — production-environment Snowflake load failures were
// surfacing as the generic literal "snowflake-sdk is not available in this
// environment", which made it impossible to tell from the deployment logs
// whether the package was missing, the native binding mismatched the runtime
// libc, or some other lower-level failure. Preserve the underlying require()
// error verbatim (message + stack via `cause`) so the swallowing catch in
// fetchProcIdForServiceOrder logs the real diagnostic.
function getSnowflakeSDK(): SnowflakeSDK {
  if (!snowflake) {
    try {
      const sdk: SnowflakeSDK = requireSnowflake("snowflake-sdk");
      snowflake = sdk;
    } catch (e: any) {
      const wrapped = new Error(
        `snowflake-sdk is not available in this environment: ${e?.code || ""} ${e?.message || String(e)}`.trim(),
      );
      (wrapped as any).cause = e;
      throw wrapped;
    }
  }
  return snowflake;
}

// Tyler 2026-05-01 — startup-probe helper so the bootstrap can log a single
// definitive line per process about whether the Snowflake SDK is loadable in
// the current runtime image. Pure diagnostic — never throws.
export function probeSnowflakeSDK(): {
  ok: boolean;
  version?: string;
  error?: string;
  errorCode?: string;
  errorStack?: string;
} {
  try {
    const sdk = getSnowflakeSDK();
    let version: string | undefined;
    try {
      // best-effort version read — the SDK exposes it under a couple of
      // historical paths depending on packaging; either is fine for the log.
      version =
        sdk?.VERSION ||
        sdk?.Version ||
        requireSnowflake("snowflake-sdk/package.json")?.version;
    } catch {
      version = undefined;
    }
    return { ok: true, version };
  } catch (e: any) {
    return {
      ok: false,
      error: e?.message || String(e),
      errorCode: e?.cause?.code || e?.code,
      errorStack: (e?.cause?.stack || e?.stack || "")
        .split("\n")
        .slice(0, 5)
        .join(" | "),
    };
  }
}

interface SnowflakeTechRow {
  TECH_ID: string;
  TECH_NAME: string;
  PHONE_NUMBER: string;
  MGR_NM: string;
  TECH_UN_NO: string;
  DISTRICT_ID: string;
}

export interface SyncedTechnician {
  ldapId: string;
  name: string;
  phone: string;
  district: string;
  state: string;
  managerName: string;
  techUnNo: string;
}

const TECH_SYNC_QUERY = `
WITH filtered_techs AS (
  SELECT 
    TECH_UN_NO, 
    TECH_AIM_ID, 
    LDAP_ID, 
    FIRST_NM, 
    LAST_NM, 
    MBL_PH_NO,
    DIST_UN_NO, 
    TECH_STS_CD, 
    ACTIVE_IND, 
    MGR_NM
  FROM PRD_TPMS.HSTECH.COMTTU_TECH_UN
  WHERE MBL_PH_NO IS NOT NULL
    AND MBL_PH_NO <> ' '
    AND TECH_STS_CD = 'A'
    AND ACTIVE_IND = 'Y'
),
primary_tech_assignment AS (
  SELECT 
    t.*,
    ROW_NUMBER() OVER (PARTITION BY LDAP_ID ORDER BY TECH_UN_NO) AS primary_rank
  FROM filtered_techs t
)
SELECT 
  p.LDAP_ID AS TECH_ID,
  p.FIRST_NM || ' ' || p.LAST_NM AS TECH_NAME,
  p.MBL_PH_NO AS PHONE_NUMBER,
  p.MGR_NM,
  p.TECH_UN_NO,
  p.DIST_UN_NO AS DISTRICT_ID
FROM primary_tech_assignment p
WHERE p.primary_rank = 1
ORDER BY p.LDAP_ID
`;

// Tyler 2026-06-25 — generalized to handle ANY "-----BEGIN <LABEL>PRIVATE KEY-----"
// header (plain PKCS#8, "RSA PRIVATE KEY", and "ENCRYPTED PRIVATE KEY"). The prior
// version only matched (RSA )?PRIVATE KEY, so an ENCRYPTED key fell through to the
// "no header" branch and got re-wrapped with a plain header — corrupting it. We now
// preserve the real header/footer label and rebuild the base64 body into 64-char
// lines (Replit secrets often arrive with spaces instead of newlines).
function normalizePrivateKey(key: string): string {
  const normalized = key.trim().replace(/\\n/g, "\n");
  const headerRe = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
  const footerRe = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;
  const headerMatch = normalized.match(headerRe);
  const footerMatch = normalized.match(footerRe);

  if (headerMatch && footerMatch) {
    const header = headerMatch[0];
    const footer = footerMatch[0];
    const bodyStart = headerMatch.index! + header.length;
    const body = normalized
      .slice(bodyStart, footerMatch.index)
      .replace(/[\s\r\n]+/g, "");
    const lines = body.match(/.{1,64}/g) || [];
    return header + "\n" + lines.join("\n") + "\n" + footer + "\n";
  }

  // No PEM header at all — assume a bare base64 unencrypted PKCS#8 body.
  const body = normalized.replace(/[\s\r\n]+/g, "");
  const lines = body.match(/.{1,64}/g) || [];
  return (
    "-----BEGIN PRIVATE KEY-----\n" +
    lines.join("\n") +
    "\n-----END PRIVATE KEY-----\n"
  );
}

function getConnection(): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const rawKey = process.env.SNOWFLAKE_PRIVATE_KEY;
    if (!rawKey) {
      reject(new Error("SNOWFLAKE_PRIVATE_KEY not configured"));
      return;
    }

    const sdk = getSnowflakeSDK();
    let privateKey = normalizePrivateKey(rawKey);

    // Tyler 2026-06-25 — support an encrypted private key. If the PEM is an
    // "ENCRYPTED PRIVATE KEY", decrypt it locally with the passphrase into an
    // unencrypted PKCS#8 PEM (what the SDK's JWT path expects). The passphrase
    // lives in its own secret (SNOWFLAKE_PRIVATE_KEY_PASSPHRASE) so the key can
    // stay encrypted at rest.
    if (privateKey.includes("ENCRYPTED PRIVATE KEY")) {
      const passphrase = process.env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE;
      if (!passphrase) {
        reject(
          new Error(
            "SNOWFLAKE_PRIVATE_KEY is encrypted but SNOWFLAKE_PRIVATE_KEY_PASSPHRASE is not configured",
          ),
        );
        return;
      }
      try {
        privateKey = createPrivateKey({ key: privateKey, format: "pem", passphrase })
          .export({ type: "pkcs8", format: "pem" })
          .toString();
      } catch (e: any) {
        reject(new Error(`Failed to decrypt SNOWFLAKE_PRIVATE_KEY: ${e?.message || e}`));
        return;
      }
    }

    const connection = sdk.createConnection({
      account: process.env.SNOWFLAKE_ACCOUNT!,
      username: process.env.SNOWFLAKE_USERNAME!,
      authenticator: "SNOWFLAKE_JWT",
      privateKey,
      warehouse: process.env.SNOWFLAKE_WAREHOUSE!,
      database: "PRD_TPMS",
      schema: "HSTECH",
    });

    connection.connect((err, conn) => {
      if (err) {
        console.error("Snowflake connection error:", err.message);
        reject(err);
      } else {
        resolve(conn);
      }
    });
  });
}

function executeQuery(connection: Connection, query: string): Promise<SnowflakeTechRow[]> {
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText: query,
      complete: (err, stmt, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve((rows || []) as SnowflakeTechRow[]);
        }
      },
    });
  });
}

// Tyler 2026-06-26 — Snowflake hardening. Every call now runs under an overall
// deadline (connect + execute) and ALWAYS releases its connection, so a stalled
// warehouse fails fast instead of hanging the request (and, on the synchronous
// submit path, piling up concurrent submits). Hot service-order lookups are
// additionally cache-served.
const SNOWFLAKE_OP_TIMEOUT_MS = Number(process.env.SNOWFLAKE_OP_TIMEOUT_MS) || 15000;
const SNOWFLAKE_SYNC_TIMEOUT_MS = Number(process.env.SNOWFLAKE_SYNC_TIMEOUT_MS) || 120000;

class SnowflakeTimeoutError extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new SnowflakeTimeoutError(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

// Destroys a connection that may resolve LATER than our deadline. Passing the
// (possibly still-pending) connection promise guarantees we release the socket
// even when withTimeout already rejected and we stopped awaiting it.
function releaseConnection(connPromise: Promise<Connection> | null) {
  if (!connPromise) return;
  Promise.resolve(connPromise)
    .then((conn) => {
      if (!conn) return;
      try {
        conn.destroy((err) => {
          if (err) console.error("Snowflake disconnect error:", err.message);
        });
      } catch {}
    })
    .catch(() => {});
}

// Generic size-capped TTL cache (insertion-order / LRU-ish eviction).
class TtlCache<T> {
  private store = new Map<string, { value: T; expiresAt: number }>();
  constructor(private maxEntries: number) {}
  get(key: string): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    this.store.delete(key);
    this.store.set(key, hit);
    return hit.value;
  }
  set(key: string, value: T, ttlMs: number) {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }
}

export interface ProcIdResult {
  procId: string;
  clientNm: string;
}

// 6h for a resolved lookup; 2min for "Not Found" / a transient failure (so a
// Snowflake stall can't make every concurrent submit wait out the full timeout).
const PROC_ID_POS_TTL_MS = 6 * 60 * 60 * 1000;
const PROC_ID_NEG_TTL_MS = 2 * 60 * 1000;
const procIdCache = new TtlCache<ProcIdResult>(5000);

export async function fetchProcIdForServiceOrder(rawServiceOrder: string): Promise<ProcIdResult> {
  const soNumber = rawServiceOrder.includes("-")
    ? rawServiceOrder.split("-")[1]
    : rawServiceOrder;

  const cached = procIdCache.get(soNumber);
  if (cached) return cached;

  let connPromise: Promise<Connection> | null = null;
  try {
    const result = await withTimeout(
      (async () => {
        connPromise = getConnection();
        const connection = await connPromise;
        const rows: any[] = await new Promise((resolve, reject) => {
          connection.execute({
            sqlText: `SELECT CMB_THD_PTY_ID, CLIENT_NM FROM PRD_DB2.HS_PERM_TBLS.IH_SERVICEORDER_FULLDETAIL_TBL WHERE SO_NO = ? LIMIT 1`,
            binds: [soNumber],
            complete: (err: any, _stmt: any, rows: any) => {
              if (err) reject(err);
              else resolve(rows || []);
            },
          });
        });
        if (rows.length > 0) {
          return {
            procId: String(rows[0].CMB_THD_PTY_ID ?? "").trim() || "Not Found",
            clientNm: String(rows[0].CLIENT_NM ?? "").trim() || "Not Found",
          };
        }
        return { procId: "Not Found", clientNm: "Not Found" };
      })(),
      SNOWFLAKE_OP_TIMEOUT_MS,
      "fetchProcIdForServiceOrder",
    );

    const isFound = result.procId !== "Not Found" || result.clientNm !== "Not Found";
    procIdCache.set(soNumber, result, isFound ? PROC_ID_POS_TTL_MS : PROC_ID_NEG_TTL_MS);
    return result;
  } catch (err) {
    console.error("fetchProcIdForServiceOrder error:", err);
    const fallback = { procId: "Not Found", clientNm: "Not Found" };
    // Cache the failure briefly so a Snowflake stall doesn't make every
    // concurrent submit wait out the full timeout (pile-up protection).
    procIdCache.set(soNumber, fallback, PROC_ID_NEG_TTL_MS);
    return fallback;
  } finally {
    releaseConnection(connPromise);
  }
}

// ===========================================================================
// TechHub parts photos (read-only)
// ===========================================================================
//
// Source: IH_DATASCIENCE.PUBLIC.PARTS_USED.PHOTO_PATHS (ARRAY), a Snowflake
// replica of the TechHub app DB. Keyed to the 8-digit half of the VRS service
// order via PARTS_USED -> JOB_ASSIGNMENTS -> JOBS.SO_NUMBER. PHOTO_PATHS holds
// object-store REFERENCES (not bytes); the bytes live in the external store
// below. See docs/discovery/techhub-photo-snowflake-discovery.md for the full
// discovery. Only PART photos are cataloged in Snowflake.

const TECHHUB_CDN_ORIGIN = "https://d1kq8vno1fudyz.cloudfront.net";

// Hosts the VRS proxy is permitted to fetch from. Defense-in-depth: even though
// proxy URLs are signed by us, the proxy re-validates the host against this list
// before making any outbound request.
export const TECHHUB_ALLOWED_HOSTS = new Set([
  "d1kq8vno1fudyz.cloudfront.net",
  "parts-images-pr-us-east-2.s3.us-east-2.amazonaws.com",
]);

export interface TechHubPartPhoto {
  url: string;
  partNumber: string | null;
  brand: string | null;
  partType: string | null;
  createdAt: string | null;
}

// 5min — part photos are viewed repeatedly during a single ticket review.
const TECHHUB_PHOTOS_TTL_MS = 5 * 60 * 1000;
const techHubPhotosCache = new TtlCache<TechHubPartPhoto[]>(1000);

// Normalizes one raw PHOTO_PATHS element into an absolute, fetchable URL, or
// null if it can't be resolved. Handles the documented data wrinkles:
//   • the ingested Postgres array literal leaves a leading `{` on the first
//     element and a trailing `}` on the last
//   • surrounding quotes/whitespace
//   • a mix of absolute URLs and relative object keys
function normalizeTechHubPhotoRef(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  // strip the array-literal braces and any wrapping quotes left by ingestion
  s = s.replace(/^\{+/, "").replace(/\}+$/, "").trim();
  s = s.replace(/^["']+/, "").replace(/["']+$/, "").trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  // relative object key -> CDN origin
  const key = s.replace(/^\/+/, "");
  if (!key) return null;
  return `${TECHHUB_CDN_ORIGIN}/${key}`;
}

const TECHHUB_PHOTOS_QUERY = `
SELECT
  PU.PART_NUMBER AS PART_NUMBER,
  PU.BRAND       AS BRAND,
  PU.PART_TYPE   AS PART_TYPE,
  PU.CREATED_AT  AS CREATED_AT,
  PU.PHOTO_PATHS AS PHOTO_PATHS
FROM IH_DATASCIENCE.PUBLIC.PARTS_USED      PU
JOIN IH_DATASCIENCE.PUBLIC.JOB_ASSIGNMENTS JA ON PU.JOB_ASSIGNMENT_ID = JA.ID
JOIN IH_DATASCIENCE.PUBLIC.JOBS            J  ON JA.JOB_ID = J.ID
WHERE J.SO_NUMBER = ?
  AND ARRAY_SIZE(PU.PHOTO_PATHS) > 0
ORDER BY PU.CREATED_AT DESC
`;

// Returns the normalized TechHub PART photos for a VRS service order. Never
// throws — Snowflake/CDN being unavailable degrades to an empty list so the
// caller can render a graceful empty state.
export async function fetchTechHubPartsPhotosForServiceOrder(
  rawServiceOrder: string,
): Promise<TechHubPartPhoto[]> {
  const so8 = rawServiceOrder.includes("-")
    ? rawServiceOrder.split("-")[1]
    : rawServiceOrder;
  if (!so8 || !/^\d{6,9}$/.test(so8.trim())) return [];
  const key = so8.trim();

  const cached = techHubPhotosCache.get(key);
  if (cached) return cached;

  let connPromise: Promise<Connection> | null = null;
  try {
    const photos = await withTimeout(
      (async () => {
        connPromise = getConnection();
        const connection = await connPromise;
        const rows: any[] = await new Promise((resolve, reject) => {
          connection.execute({
            sqlText: TECHHUB_PHOTOS_QUERY,
            binds: [key],
            complete: (err: any, _stmt: any, rows: any) => {
              if (err) reject(err);
              else resolve(rows || []);
            },
          });
        });

        const out: TechHubPartPhoto[] = [];
        for (const row of rows) {
          // PHOTO_PATHS comes back as a JS array (snowflake-sdk parses ARRAY) but
          // tolerate a stringified form too.
          let paths: unknown[] = [];
          const pp = row.PHOTO_PATHS;
          if (Array.isArray(pp)) {
            paths = pp;
          } else if (typeof pp === "string") {
            try {
              const j = JSON.parse(pp);
              paths = Array.isArray(j) ? j : [pp];
            } catch {
              paths = pp.split(",");
            }
          }
          for (const ref of paths) {
            const url = normalizeTechHubPhotoRef(ref);
            if (!url) continue;
            out.push({
              url,
              partNumber: row.PART_NUMBER != null ? String(row.PART_NUMBER) : null,
              brand: row.BRAND != null ? String(row.BRAND) : null,
              partType: row.PART_TYPE != null ? String(row.PART_TYPE) : null,
              createdAt: row.CREATED_AT != null ? String(row.CREATED_AT) : null,
            });
          }
        }
        return out;
      })(),
      SNOWFLAKE_OP_TIMEOUT_MS,
      "fetchTechHubPartsPhotosForServiceOrder",
    );

    techHubPhotosCache.set(key, photos, TECHHUB_PHOTOS_TTL_MS);
    return photos;
  } catch (err) {
    console.error("fetchTechHubPartsPhotosForServiceOrder error:", err);
    return [];
  } finally {
    releaseConnection(connPromise);
  }
}

export async function fetchTechniciansFromSnowflake(): Promise<SyncedTechnician[]> {
  let connPromise: Promise<Connection> | null = null;
  try {
    return await withTimeout(
      (async () => {
        connPromise = getConnection();
        const connection = await connPromise;
        const rows = await executeQuery(connection, TECH_SYNC_QUERY);
        return rows
          .map((row) => ({
            ldapId: (row.TECH_ID || "").trim().toLowerCase(),
            name: (row.TECH_NAME || "").trim(),
            phone: (row.PHONE_NUMBER || "").trim(),
            district: (row.DISTRICT_ID || "").trim(),
            state: "",
            managerName: (row.MGR_NM || "").trim(),
            techUnNo: (row.TECH_UN_NO || "").trim(),
          }))
          .filter((t) => t.ldapId.length > 0);
      })(),
      SNOWFLAKE_SYNC_TIMEOUT_MS,
      "fetchTechniciansFromSnowflake",
    );
  } finally {
    releaseConnection(connPromise);
  }
}
