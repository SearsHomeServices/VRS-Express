// READ-ONLY diagnostic (run by hand, never by the app):
//   npx tsx scripts/diagnostics/ahs-prefill-check.mts DDDD-SSSSSSSS
// Runs the AHS prefill's own Snowflake statements for one service order and
// says why a field was or was not filled: which rows and units the order
// has, the warranty each row derives to, whether brand and parts are there,
// whether the dispatch / model / serial columns tried before
// (CTA_NO, PSV_ITM_MDL_NO, PSV_MDS_SRL_NO) exist and hold a value, and
// whether the repair / replace calculator's statements answer, and what the
// WOM work order gives the calculator (visit, attempts, trip, labor), what
// a fresh HSSOM token is granted, and which fields the HSSOM Order Lookup
// returns for the order. Sections 8 and 9 still run when Snowflake fails.
// Uses the app's Snowflake, HSSOM and WOM env vars. Prints no secrets, no
// tokens and no values: only yes/no, counts, warranty types, grant paths and
// masked shapes (digits -> 9, letters -> A).
import { createRequire } from "node:module";
import { createPrivateKey } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const require = createRequire(path.join(root, "server/services/snowflake.ts"));
const sdk = require("snowflake-sdk");
sdk.configure({ logLevel: "ERROR" });
const lookup = await import(pathToFileURL(path.join(root, "server/services/snowflake-lookup.ts")).href);
const rrPrefill = await import(pathToFileURL(path.join(root, "server/repair-replace-prefill.ts")).href);
const womFacts = await import(pathToFileURL(path.join(root, "server/services/wom-repair-facts.ts")).href);
const womClient = await import(pathToFileURL(path.join(root, "server/services/wom-work-order.ts")).href);
const hssomAuth = await import(pathToFileURL(path.join(root, "server/services/hssom-auth.ts")).href);
const hssomLookup = await import(pathToFileURL(path.join(root, "server/services/hssom-order-lookup.ts")).href);
const { deriveWarrantyFromProcId } = await import(pathToFileURL(path.join(root, "shared/warranty.ts")).href);

const match = /^(\d{4})-(\d{8})$/.exec((process.argv[2] ?? "").trim());
if (!match) {
  console.log("Usage: npx tsx scripts/diagnostics/ahs-prefill-check.mts DDDD-SSSSSSSS");
  process.exit(1);
}
const [, district, so] = match;
const districtUnit = district.padStart(7, "0");
const TABLE = "PRD_DB2.HS_PERM_TBLS.IH_SERVICEORDER_FULLDETAIL_TBL";
// The documented PROD WOM path (wom-work-order.ts), for the grant check
// when WOM_WORK_ORDER_URL is not set.
const WOM_DOCUMENTED_URL = "https://hssom-api-gateway.shs-core.com/v1/api/sb/proxy/serviceOrder/api/v1/work-orders";

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
// Snowflake failures (missing settings included) stop only sections 1-7.
let connection: any = null;
let conn: any = null;
let connectError: unknown = null;
try {
  connection = sdk.createConnection({
    account: process.env.SNOWFLAKE_ACCOUNT,
    username: process.env.SNOWFLAKE_USERNAME,
    authenticator: "SNOWFLAKE_JWT",
    privateKey,
    warehouse: process.env.SNOWFLAKE_WAREHOUSE,
    database: "PRD_TPMS",
    schema: "HSTECH",
  });
  conn = await new Promise((resolve, reject) => connection.connect((err: any, c: any) => (err ? reject(err) : resolve(c))));
} catch (e) {
  connectError = e;
}
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
  if (!conn) throw connectError;
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

  // 7. Repair / replace calculator sources (Sears Protect tickets): the
  // four statements the calculator runs, and what the prefill makes of them.
  console.log("7. Repair / replace calculator statements:");
  const rr: Array<[string, string, string[]]> = [
    ["order (MDS_CD, AP_PCHS_DATE, SL_DT, JOB_CD_DS, CC_LAB_NET)", lookup.REPAIR_REPLACE_ORDER_SQL, [so, district]],
    ["TechHub NPSXTFS (deLabor, deTripCharge, applianceAssessment)", lookup.REPAIR_REPLACE_TECHHUB_SQL, [so, so, district]],
    ["parts NPSXTPN (status, type, quantity, price)", lookup.REPAIR_REPLACE_PARTS_SQL, [so, so, district]],
    ["12-month history (same model + serial)", lookup.REPAIR_REPLACE_HISTORY_SQL, [so, district, so, so]],
  ];
  const rrRows: Array<any[] | null> = [];
  for (const [label, sqlText, binds] of rr) {
    try {
      const found = await run(sqlText, binds);
      rrRows.push(found);
      console.log(`   - ${label}: ok, ${found.length} row(s)`);
    } catch (e) {
      rrRows.push(null);
      console.log(`   - ${label}: QUERY ERROR ${errorText(e)}`);
    }
  }
  if (rrRows[0]?.[0]) {
    const result = rrPrefill.buildRepairReplacePrefill({
      serviceOrder: `${district}-${so}`, row: rrRows[0][0], techhub: rrRows[1], parts: rrRows[2], history: rrRows[3],
    });
    console.log(`   prefill status=${result.status}; filled: ${Object.keys(result.fields).join(", ") || "nothing"}`);
    console.log(`   AP_PCHS_DATE present=${present(rrRows[0][0].AP_PCHS_DATE)}, SL_DT present=${present(rrRows[0][0].SL_DT)}, MDS_CD present=${present(rrRows[0][0].MDS_CD)}, CC_LAB_NET present=${present(rrRows[0][0].CC_LAB_NET)}`);
    const types = (rrRows[2] ?? []).map((p) => String(p.SVC_PRT_TYP_CD ?? "?").trim() || "?");
    console.log(`   part line types: ${types.join(",") || "none"}`);
    const history = rrRows[3] ?? [];
    console.log(`   history: serial usable=${String(history[0]?.SERIAL_USABLE ?? "n/a")}, other orders=${history.filter((h) => present(h.H_SO)).length}, with a repeated part=${history.filter((h) => Number(h.SAME_PART_LINES) > 0).length}`);
  }
} catch (e) {
  console.log("SNOWFLAKE ERROR (sections 1-7 stopped):", errorText(e));
}

// 8. HSSOM: settings (names only); a fresh token's subject, expiry and
// grant paths (never the token); whether those grants claim the Order
// Lookup and WOM paths (unverified claims, HSSOM enforces access); and
// which fields the Order Lookup returns for this order (never the values).
console.log("8. HSSOM settings present:");
for (const name of ["AHS_HSSOM_CUSTOMER_PREFILL_ENABLED", "HSSOM_ORDER_LOOKUP_URL", "HSSOM_AUTH_URL", "HSSOM_CLIENT_CODE", "HSSOM_CLIENT_SECRET", "HSSOM_CLIENT_ID"]) {
  console.log(`   - ${name}: ${present(process.env[name]) ? "set" : "NOT SET"}`);
}
const authConfigured = hssomAuth.readHssomAuthConfig() != null;
let hssomToken: string | null = null;
if (!authConfigured) {
  console.log("   token: skipped (auth settings missing, or HSSOM_AUTH_URL is not https)");
} else {
  try {
    hssomToken = await hssomAuth.getHssomBearerToken();
    console.log("   token: ok");
  } catch (e) {
    console.log(`   token: FAILED (${errorText(e)})`);
  }
}
const lookupConfig = hssomLookup.readHssomOrderLookupConfig();
const hssomOrderId: string | null = hssomLookup.buildHssomOrderId(district, so);
if (hssomToken) {
  const summary = hssomAuth.hssomTokenGrants(hssomToken);
  const expiresIn = summary?.exp != null ? Math.round(summary.exp - Date.now() / 1000) : null;
  console.log(`   token subject=${summary?.sub ?? "unknown"}, expires in ${expiresIn ?? "unknown"} s`);
  console.log(`   grants (${summary?.grants.length ?? 0}):`);
  for (const g of summary?.grants ?? []) console.log(`     ${g.method ?? "ANY"} ${g.pattern}`);
  // Grants may be written relative to the service rather than the gateway
  // URL, so every path suffix is tried; the first match is shown.
  const claims = (url: string | undefined): string => {
    let pathname: string;
    try { pathname = new URL(url ?? "").pathname; } catch { return "n/a (no usable URL)"; }
    const segments = pathname.split("/").filter(Boolean);
    for (let i = 0; i < segments.length; i++) {
      const candidate = `/${segments.slice(i).join("/")}`;
      if (hssomAuth.hssomTokenAllows(hssomToken!, "GET", candidate)) return `yes (as ${candidate})`;
    }
    return "no";
  };
  const lookupUrl = lookupConfig && hssomOrderId ? `${lookupConfig.lookupUrl}/${encodeURIComponent(hssomOrderId)}` : undefined;
  const womUrl = process.env.WOM_WORK_ORDER_URL?.trim() || WOM_DOCUMENTED_URL;
  console.log("   token claims (unverified; HSSOM enforces access):");
  console.log(`     Order Lookup GET: ${claims(lookupUrl)}`);
  console.log(`     WOM work-orders GET: ${claims(womUrl)}`);
}
if (!lookupConfig) {
  console.log("   order lookup: skipped (HSSOM_ORDER_LOOKUP_URL missing or not https)");
} else if (authConfigured) {
  // Runs even with AHS_HSSOM_CUSTOMER_PREFILL_ENABLED off.
  const result = await hssomLookup.createHssomOrderLookup({ enabled: () => true })(district, so);
  console.log(`   order lookup (clientid header ${lookupConfig.lookupClientId}): status=${result.status}`);
  if (result.status === "found") {
    const fields = ["customerName", "customerAddress", "serviceContractId", "brand", "modelNumber", "serialNumber", "purchaseDate"] as const;
    console.log(`   fields: ${fields.map((f) => `${f}=${present(result[f]) ? "yes" : "no"}`).join(", ")}`);
    if (result.purchaseDate) console.log(`   purchase year: ${String(result.purchaseDate).slice(0, 4)}`);
    // The calculator's facts from SOM: amounts, codes, statuses and counts
    // only (repairFactsFromOrder never reads customer fields).
    const facts = result.repairFacts;
    if (!facts) {
      console.log("   SOM repair facts: none on this order");
    } else {
      const amount = (v: number | undefined) => (v == null ? "-" : v.toFixed(2));
      console.log(`   SOM repair facts: trip=${amount(facts.tripCharge)} partsTax=${facts.partsTaxRate ?? "-"} laborTax=${facts.laborTaxRate ?? "-"} attempts=${facts.attemptCount ?? "-"} previousAttempts=${facts.previousAttemptCount ?? "-"} provider=${facts.providerId ?? "-"}`);
      console.log(`   job codes (${facts.jobCodes.length}):`);
      for (const j of facts.jobCodes) {
        console.log(`     ${j.jobCode ?? "?"} "${(j.description ?? "").slice(0, 40)}" charge=${amount(j.chargeAmount)} chargeCode=${j.chargeCode ?? "-"} coverage=${j.coverageCode ?? "-"}`);
      }
      console.log(`   parts (${facts.parts.length}):`);
      // Sell (price) and cost per line, plus cost / sell, so a quantity
      // above 1 shows whether the cost is per line like the price.
      for (const p of facts.parts) {
        const ratio = p.price && p.costPrice != null ? ` cost/sell=${(p.costPrice / p.price).toFixed(2)}` : "";
        console.log(`     sell=${amount(p.price)} cost=${amount(p.costPrice)} localCost=${amount(p.localCost)} qty=${p.quantity ?? "-"} status=${p.status ?? "-"}${ratio}`);
      }
      const fromSom = rrPrefill.buildRepairReplacePrefill({ serviceOrder: `${district}-${so}`, row: null, hssom: facts });
      const filled = Object.entries(fromSom.fields).filter(([, f]) => f?.source === "hssom");
      console.log(`   calculator from SOM: ${filled.map(([name, f]) => `${name}=${String(f!.value)}`).join(", ") || "nothing"}`);
      for (const w of fromSom.warnings.filter((w) => /SOM/.test(w))) console.log(`   note: ${w}`);
    }
  }
}
// The Order Lookup body's key paths to depth 4 (names only, never values;
// arrays show as []), to see whether it carries anything for the
// calculator. Separate raw GETs with the lookup's own URL and headers: the
// plain lookup (all key paths), then the spec's ?type=ORDER_DETAILS
// (estimate.tripCharge, jobCodes[].chargeAmount, monetaryDetails) and
// ?type=ORDER (attemptCount, previousAttempts), calculator keys only.
// HSSOMOrderLookupService spec V0.13, "Order Lookup Full - V2".
const calculatorHint = /jobcode|labo|trip|charge|attempt|visit|part|history|monetary|provider|price|total|amt/i;
const keyPathsOf = (body: unknown): string[] => {
  const paths = new Set<string>();
  const walk = (value: unknown, prefix: string, depth: number) => {
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 5)) walk(item, `${prefix}[]`, depth);
      return;
    }
    if (!value || typeof value !== "object" || depth >= 4) return;
    for (const [key, child] of Object.entries(value)) {
      // Key names only; anything that doesn't look like a field name is masked.
      const name = /^[A-Za-z_][A-Za-z0-9_]{0,60}$/.test(key) ? key : "<key>";
      const keyPath = prefix ? `${prefix}.${name}` : name;
      paths.add(keyPath);
      walk(child, keyPath, depth + 1);
    }
  };
  walk(body, "", 0);
  return [...paths].sort();
};
if (lookupConfig && hssomToken && hssomOrderId) {
  for (const lookupType of ["", "ORDER_DETAILS", "ORDER"]) {
    const label = lookupType ? `?type=${lookupType}` : "plain";
    try {
      const query = lookupType ? `?type=${lookupType}` : "";
      const res = await fetch(`${lookupConfig.lookupUrl}/${encodeURIComponent(hssomOrderId)}${query}`, {
        method: "GET",
        headers: hssomLookup.lookupHeaders(lookupConfig, hssomToken),
        signal: AbortSignal.timeout(lookupConfig.timeoutMs),
      });
      console.log(`   order lookup body (${label}): http=${res.status}`);
      if (!res.ok) continue;
      const sorted = keyPathsOf(await res.json());
      const hits = sorted.filter((keyPath) => calculatorHint.test(keyPath));
      if (!lookupType) {
        console.log(`   key paths (${sorted.length}, depth <= 4):`);
        for (const keyPath of sorted) console.log(`     ${keyPath}`);
      }
      console.log(`   calculator-related keys (${label}): ${hits.length ? `${hits.length}` : "none"}`);
      if (lookupType) for (const keyPath of hits) console.log(`     ${keyPath}`);
    } catch (e) {
      console.log(`   order lookup body (${label}): FAILED (${errorText(e)})`);
    }
  }
}

// 9. WOM work order (calculator): config, status, which facts it gives
// (numbers only; they are not customer data) and the record's key paths
// with types, never values. Customer subtrees are skipped.
console.log("9. WOM work order (calculator):");
for (const name of ["WOM_WORK_ORDER_URL", "WOM_TENANT_ID", "WOM_BEARER_TOKEN"]) {
  console.log(`   - ${name}: ${present(process.env[name]) ? "set" : "NOT SET"}`);
}
const womConfig = womClient.readWomWorkOrderConfig();
console.log(`   config usable: ${womConfig ? `yes (token: ${womConfig.staticToken ? "WOM_BEARER_TOKEN" : "HSSOM gateway"})` : "no"}`);
if (womConfig) {
  let womRecord: unknown;
  const womLookup = womFacts.createWomRepairFactsLookup({ onRecord: (r: unknown) => { womRecord = r; } });
  const result = await womLookup(district, so);
  console.log(`   status: ${result.status}`);
  if (result.status === "found") {
    const f = result.facts;
    console.log(
      `   visit number=${f.visitNumber ?? "none"}, unresolved=${f.unresolved ?? "unknown"}, ` +
        `failed attempts=${f.failedAttemptCount ?? "unknown"}, trip=${f.tripCharge ?? "none"}, ` +
        `labor=${f.laborTotal ?? "none"} (${f.laborLineCount ?? 0} line(s))`,
    );
    for (const warning of result.warnings) console.log(`   warning: ${warning}`);
    for (const rootKey of ["Extensions", "LabourJobCodes", "Parts", "WorkItems"]) {
      const paths = womFacts.workOrderShape(womRecord, [rootKey]);
      console.log(`   ${rootKey}: ${paths.length ? "" : "(absent)"}`);
      for (const p of paths) console.log(`     ${p}`);
    }
  }
}

if (conn) connection.destroy(() => process.exit(0));
else process.exit(0);
