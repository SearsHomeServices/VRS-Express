// READ-ONLY diagnostic (run by hand, never by the app):
//   npx tsx scripts/diagnostics/list-product-codes.mts
// Lists the product codes (HS_SP_CD) on service orders created in the last 12
// months, with counts, and what VRS Express maps each one to
// (shared/appliance-division.ts, shared/appliance-types.ts). Uses the app's
// Snowflake env vars; prints no secrets and no customer data.
import { createRequire } from "node:module";
import { createPrivateKey } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const require = createRequire(path.join(root, "server/services/snowflake.ts"));
const sdk = require("snowflake-sdk");
sdk.configure({ logLevel: "ERROR" });
const { divisionFromServiceOrderProduct } = await import(pathToFileURL(path.join(root, "shared/appliance-division.ts")).href);
const { applianceKindFromServiceOrderProduct } = await import(pathToFileURL(path.join(root, "shared/appliance-types.ts")).href);

function normalizePrivateKey(key: string): string {
  const normalized = key.trim().replace(/\\n/g, "\n");
  const header = normalized.match(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/);
  const footer = normalized.match(/-----END [A-Z0-9 ]*PRIVATE KEY-----/);
  const wrap = (h: string, body: string, f: string) => `${h}\n${(body.match(/.{1,64}/g) || []).join("\n")}\n${f}\n`;
  if (header && footer) {
    const body = normalized.slice(header.index! + header[0].length, footer.index).replace(/\s+/g, "");
    return wrap(header[0], body, footer[0]);
  }
  return wrap("-----BEGIN PRIVATE KEY-----", normalized.replace(/\s+/g, ""), "-----END PRIVATE KEY-----");
}

let privateKey = normalizePrivateKey(process.env.SNOWFLAKE_PRIVATE_KEY || "");
if (privateKey.includes("ENCRYPTED PRIVATE KEY")) {
  privateKey = createPrivateKey({ key: privateKey, format: "pem", passphrase: process.env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE })
    .export({ type: "pkcs8", format: "pem" }).toString();
}
const connection = sdk.createConnection({
  account: process.env.SNOWFLAKE_ACCOUNT,
  username: process.env.SNOWFLAKE_USERNAME,
  authenticator: "SNOWFLAKE_JWT",
  privateKey,
  warehouse: process.env.SNOWFLAKE_WAREHOUSE,
  database: "PRD_TPMS",
  schema: "HSTECH",
});
const conn: any = await new Promise((resolve, reject) => connection.connect((err: any, c: any) => (err ? reject(err) : resolve(c))));
const run = (sqlText: string): Promise<any[]> =>
  new Promise((resolve, reject) =>
    conn.execute({ sqlText, complete: (err: any, _s: any, rows: any[]) => (err ? reject(err) : resolve(rows || [])) }),
  );

try {
  await run("ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = 90");
  const rows = await run(
    "SELECT HS_SP_CD AS CODE, COUNT(*) AS N FROM PRD_DB2.HS_PERM_TBLS.IH_SERVICEORDER_FULLDETAIL_TBL " +
      "WHERE SO_CRT_DT >= DATEADD(month, -12, CURRENT_DATE()) GROUP BY 1 ORDER BY 2 DESC LIMIT 300",
  );
  console.log("CODE | ORDERS | DIVISION | SPECIFIC APPLIANCE");
  for (const row of rows) {
    const code = row.CODE == null ? "(null)" : String(row.CODE);
    console.log(`${code} | ${row.N} | ${divisionFromServiceOrderProduct(code) ?? "-"} | ${applianceKindFromServiceOrderProduct(code) ?? "-"}`);
  }
  console.log(`${rows.length} codes`);
} catch (e: any) {
  console.log("QUERY ERROR:", String(e?.message || e).split("\n")[0].slice(0, 300));
} finally {
  connection.destroy(() => process.exit(0));
}
