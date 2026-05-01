let snowflake: any = null;

// Tyler 2026-05-01 — production-environment Snowflake load failures were
// surfacing as the generic literal "snowflake-sdk is not available in this
// environment", which made it impossible to tell from the deployment logs
// whether the package was missing, the native binding mismatched the runtime
// libc, or some other lower-level failure. Preserve the underlying require()
// error verbatim (message + stack via `cause`) so the swallowing catch in
// fetchProcIdForServiceOrder logs the real diagnostic.
function getSnowflakeSDK() {
  if (!snowflake) {
    try {
      snowflake = require("snowflake-sdk");
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
        require("snowflake-sdk/package.json")?.version;
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

function normalizePrivateKey(key: string): string {
  let normalized = key.trim();
  normalized = normalized.replace(/\\n/g, "\n");

  const headerRe = /-----BEGIN (RSA )?PRIVATE KEY-----/;
  const footerRe = /-----END (RSA )?PRIVATE KEY-----/;
  const headerMatch = normalized.match(headerRe);
  const footerMatch = normalized.match(footerRe);

  if (headerMatch && footerMatch) {
    const header = headerMatch[0];
    const footer = footerMatch[0];
    let body = normalized
      .replace(header, "")
      .replace(footer, "")
      .replace(/[\s\r\n]+/g, "");
    const lines = body.match(/.{1,64}/g) || [];
    normalized = header + "\n" + lines.join("\n") + "\n" + footer + "\n";
  } else if (!headerMatch) {
    const body = normalized.replace(/[\s\r\n]+/g, "");
    const lines = body.match(/.{1,64}/g) || [];
    normalized =
      "-----BEGIN PRIVATE KEY-----\n" +
      lines.join("\n") +
      "\n-----END PRIVATE KEY-----\n";
  }

  return normalized;
}

function getConnection(): Promise<any> {
  return new Promise((resolve, reject) => {
    const rawKey = process.env.SNOWFLAKE_PRIVATE_KEY;
    if (!rawKey) {
      reject(new Error("SNOWFLAKE_PRIVATE_KEY not configured"));
      return;
    }

    const sdk = getSnowflakeSDK();
    const privateKey = normalizePrivateKey(rawKey);

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

function executeQuery(connection: any, query: string): Promise<SnowflakeTechRow[]> {
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

export interface ProcIdResult {
  procId: string;
  clientNm: string;
}

export async function fetchProcIdForServiceOrder(rawServiceOrder: string): Promise<ProcIdResult> {
  const soNumber = rawServiceOrder.includes("-")
    ? rawServiceOrder.split("-")[1]
    : rawServiceOrder;

  try {
    const connection = await getConnection();
    try {
      const rows: any[] = await new Promise((resolve, reject) => {
        connection.execute({
          sqlText: `SELECT CMB_THD_PTY_ID, CLIENT_NM FROM PRD_DB2.HS_PERM_TBLS.IH_SERVICEORDER_FULLDETAIL_TBL WHERE SO_NO = ? LIMIT 1`,
          binds: [soNumber],
          complete: (err: any, stmt: any, rows: any) => {
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
    } finally {
      connection.destroy((err: any) => {
        if (err) console.error("Snowflake disconnect error:", err.message);
      });
    }
  } catch (err) {
    console.error("fetchProcIdForServiceOrder error:", err);
    return { procId: "Not Found", clientNm: "Not Found" };
  }
}

export async function fetchTechniciansFromSnowflake(): Promise<SyncedTechnician[]> {
  const connection = await getConnection();

  try {
    const rows = await executeQuery(connection, TECH_SYNC_QUERY);

    return rows.map((row) => ({
      ldapId: (row.TECH_ID || "").trim().toLowerCase(),
      name: (row.TECH_NAME || "").trim(),
      phone: (row.PHONE_NUMBER || "").trim(),
      district: (row.DISTRICT_ID || "").trim(),
      state: "",
      managerName: (row.MGR_NM || "").trim(),
      techUnNo: (row.TECH_UN_NO || "").trim(),
    })).filter((t) => t.ldapId.length > 0);
  } finally {
    connection.destroy((err) => {
      if (err) console.error("Snowflake disconnect error:", err.message);
    });
  }
}
