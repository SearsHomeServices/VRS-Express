// READ-ONLY diagnostic (run by hand, never by the app):
//   npx tsx scripts/diagnostics/ahs-prefill-check.mts DDDD-SSSSSSSS
// Runs the AHS prefill's own Snowflake statements for one service order and
// says why a field was or was not filled: which rows and units the order
// has, the warranty each row derives to, whether brand and parts are there,
// and whether the dispatch / model / serial columns tried before
// (CTA_NO, PSV_ITM_MDL_NO, PSV_MDS_SRL_NO) exist and hold a value.
// Uses the app's Snowflake env vars. Prints no secrets and no values: only
// yes/no, counts, warranty types and masked shapes (digits -> 9, letters -> A).
import { createRequire } from "node:module";
import { createPrivateKey } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const require = createRequire(path.join(root, "server/services/snowflake.ts"));
const sdk = require("snowflake-sdk");
sdk.configure({ logLevel: "ERROR" });
const lookup = await import(pathToFileURL(path.join(root, "server/services/snowflake-lookup.ts")).href);
const { deriveWarrantyFromProcId } = await import(pathToFileURL(path.join(root, "shared/warranty.ts")).href);

const match = /^(\d{4})-(\d{8})$/.exec((process.argv[2] ?? "").trim());
if (!match) {
  console.log("Usage: npx tsx scripts/diagnostics/ahs-prefill-check.mts DDDD-SSSSSSSS");
  process.exit(1);
}
const [, district, so] = match;
const districtUnit = district.padStart(7, "0");
const TABLE = "PRD_DB2.HS_PERM_TBLS.IH_SERVICEORDER_FULLDETAIL_TBL";

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
const run = (sqlText: string, binds: string[]): Promise<any[]> =>
  new Promise((resolve, reject) =>
    conn.execute({ sqlText, binds, complete: (err: any, _s: any, rows: any[]) => (err ? reject(err) : resolve(rows || [])) }),
  );
const errorText = (e: any) => String(e?.message || e).split("\n")[0].slice(0, 200);
const present = (value: unknown) => value != null && String(value).trim() !== "";
const shape = (value: unknown) => (present(value) ? String(value).trim().replace(/\d/g, "9").replace(/[A-Za-z]/g, "A") : "(blank)");
const unitLabel = (unit: unknown) => (String(unit ?? "").trim() === districtUnit ? "district unit" : "OTHER unit");
const warranty = (row: any, partner = "CMB_THD_PTY_ID", client = "CLIENT_NM") =>
  deriveWarrantyFromProcId(row?.[partner], row?.[client])?.warrantyType ?? "none";

console.log(`AHS prefill check for SO ${district}-${so} (district unit ${districtUnit})\n`);
try {
  await run("ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = 60", []);

  // 1. Rows and units for this SO number.
  const units = await run(`SELECT SVC_UN_NO AS UNIT, COUNT(*) AS N FROM ${TABLE} WHERE SO_NO = ? GROUP BY 1`, [so]);
  console.log(`1. Service order rows: ${units.length} unit(s)`);
  for (const u of units) console.log(`   - ${unitLabel(u.UNIT)}: ${u.N} row(s)`);

  // 2. The ProcID lookup (warranty detection on the tech form and at submit).
  const proc = await run(lookup.PROC_ID_SQL, [so, districtUnit]);
  console.log(`2. ProcID lookup: ${proc.length ? `warranty = ${warranty(proc[0])}` : "no row"}`);

  // 3. The AHS prefill core statement (brand + the AHS decision).
  const core = await run(lookup.AHS_PREFILL_CORE_SQL, [so, district]);
  const row = core[0];
  if (!row) {
    console.log("3. Prefill core statement: no row (not_found)");
  } else {
    const resolved = lookup.resolveServiceUnit(row, district);
    console.log(
      `3. Prefill core statement: ${unitLabel(row.SERVICE_UNIT)}, units=${row.UNIT_COUNT}, ` +
        `resolved=${resolved ? unitLabel(resolved) : "NONE (not_found)"}, brand present=${present(row.BRAND)}, ` +
        `warranty = ${warranty(row, "PARTNER_ID", "CLIENT_NAME")}` +
        (warranty(row, "PARTNER_ID", "CLIENT_NAME") === "american_home_shield" ? "" : "  <-- not AHS: the prefill fills NOTHING"),
    );
  }

  // 4. Every row of the order under the district (or only) unit.
  const unit = row ? lookup.resolveServiceUnit(row, district) ?? districtUnit : districtUnit;
  const rows = await run(
    `SELECT MFG_BND_NM, CMB_THD_PTY_ID, CLIENT_NM FROM ${TABLE} WHERE SO_NO = ? AND SVC_UN_NO = ? LIMIT 20`,
    [so, unit],
  );
  console.log(`4. Rows under the resolved unit: ${rows.length}`);
  rows.forEach((r, i) => console.log(`   row ${i + 1}: brand present=${present(r.MFG_BND_NM)}, warranty = ${warranty(r)}`));

  // 5. The columns removed on 2026-10-26: do they exist, and hold a value?
  console.log("5. Columns tried before for dispatch / model / serial:");
  for (const column of ["CTA_NO", "PSV_ITM_MDL_NO", "PSV_MDS_SRL_NO"]) {
    try {
      const values = await run(`SELECT ${column} AS V FROM ${TABLE} WHERE SO_NO = ? AND SVC_UN_NO = ? LIMIT 20`, [so, unit]);
      const filled = values.filter((v) => present(v.V));
      console.log(`   - ${column}: exists, value in ${filled.length} of ${values.length} row(s)${filled.length ? `, shape ${shape(filled[0].V)}` : ""}`);
    } catch (e) {
      console.log(`   - ${column}: QUERY ERROR ${errorText(e)}`);
    }
  }

  // 6. The parts statement.
  const parts = await run(lookup.AHS_PREFILL_PARTS_SQL, [so, so, district]);
  const live = parts.filter((p) => !["X", "V"].includes(String(p.STATUS ?? "").trim().toUpperCase()));
  console.log(`6. Parts on the order: ${parts.length} line(s), ${live.length} live, ${live.filter((p) => present(p.UNIT_PRICE)).length} with a price`);

  // 7. HSSOM settings (names only).
  console.log("7. HSSOM settings present:");
  for (const name of ["AHS_HSSOM_CUSTOMER_PREFILL_ENABLED", "HSSOM_ORDER_LOOKUP_URL", "HSSOM_AUTH_URL", "HSSOM_CLIENT_CODE", "HSSOM_CLIENT_SECRET", "HSSOM_CLIENT_ID"]) {
    console.log(`   - ${name}: ${present(process.env[name]) ? "set" : "NOT SET"}`);
  }
} catch (e) {
  console.log("QUERY ERROR:", errorText(e));
} finally {
  connection.destroy(() => process.exit(0));
}
