/**
 * Seed ONE queued/claimable test ticket in DEV DB using a real service_order
 * pulled from PROD DB. Use this when you need an SHSAI-realistic test ticket
 * — picking a real prod SO guarantees SHSAI has customer history to return.
 *
 * Usage (on Replit where both DBs are reachable):
 *   PROD_DATABASE_URL=... DEV_DATABASE_URL=... node scripts/seed-test-ticket-from-prod.mjs
 *
 * Pin a specific SO instead of "most recent completed":
 *   PROD_DATABASE_URL=... DEV_DATABASE_URL=... node scripts/seed-test-ticket-from-prod.mjs 8555-13712781
 *
 * Behavior:
 *   - PROD read: most recent completed ticket (auth_code populated) OR the SO
 *     passed as argv[2]. Only NON-PII columns are read (service_order,
 *     proc_id, client_nm, district_code, appliance_type, warranty_type).
 *     Customer name + phone + address all live in SHSAI's data store and are
 *     fetched on demand by the agent dashboard — never copied into dev.
 *   - DEV write: ensures the test_tech_1 fixture (matches seed-test-tickets.ts
 *     conventions) and inserts a new queued submission. Idempotent: if a row
 *     with that service_order already exists in dev, skips it.
 *   - The dev row is tagged "[TEST]" in issue_description for easy cleanup.
 *
 * Cleanup:
 *   DELETE FROM submissions WHERE issue_description LIKE '[TEST]%';
 */

import pg from 'pg';
import bcryptjs from 'bcryptjs';

const PROD_URL = process.env.PROD_DATABASE_URL;
const DEV_URL = process.env.DEV_DATABASE_URL;
const SO_OVERRIDE = process.argv[2] || null;

if (!PROD_URL) {
  console.error('PROD_DATABASE_URL not set');
  process.exit(1);
}
if (!DEV_URL) {
  console.error('DEV_DATABASE_URL not set');
  process.exit(1);
}

const TECH_LDAP = 'test_tech_1';
const TECH_NAME = 'TEST_TECH_1';
const TECH_PHONE = '555-0100';
const TECH_RAC = 'TEST_TECH_1';
const TECH_UN_NO = '9999001';
const DISTRICT_FALLBACK = '8175';

function sslOpt(url) {
  return url.includes('sslmode=disable') ? false : { rejectUnauthorized: false };
}

const prodPool = new pg.Pool({ connectionString: PROD_URL, ssl: sslOpt(PROD_URL) });
const devPool = new pg.Pool({ connectionString: DEV_URL, ssl: sslOpt(DEV_URL) });

async function fetchProdSource(client, soOverride) {
  if (soOverride) {
    const r = await client.query(
      `SELECT service_order, proc_id, client_nm, district_code,
              appliance_type, warranty_type
       FROM submissions
       WHERE service_order = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [soOverride],
    );
    if (!r.rows.length) {
      throw new Error(`No prod submission found for SO ${soOverride}`);
    }
    return r.rows[0];
  }
  const r = await client.query(
    `SELECT service_order, proc_id, client_nm, district_code,
            appliance_type, warranty_type
     FROM submissions
     WHERE ticket_status = 'completed'
       AND auth_code IS NOT NULL
     ORDER BY status_changed_at DESC NULLS LAST,
              reviewed_at DESC NULLS LAST,
              created_at DESC
     LIMIT 1`,
  );
  if (!r.rows.length) {
    throw new Error('No completed tickets found in prod');
  }
  return r.rows[0];
}

async function ensureDevTechnician(client) {
  const userRes = await client.query(
    `SELECT id FROM users WHERE rac_id = $1 LIMIT 1`,
    [TECH_RAC],
  );
  let techUserId;
  if (userRes.rows.length) {
    techUserId = userRes.rows[0].id;
    console.log(`[skip] users row for ${TECH_RAC} exists (id=${techUserId})`);
  } else {
    const hash = await bcryptjs.hash('disabled-test-account-no-login', 10);
    const ins = await client.query(
      `INSERT INTO users
         (name, role, rac_id, phone, password,
          is_active, first_login, must_change_password, is_system_account)
       VALUES ($1, 'technician', $2, $3, $4, true, false, false, false)
       RETURNING id`,
      [TECH_NAME, TECH_RAC, TECH_PHONE, hash],
    );
    techUserId = ins.rows[0].id;
    console.log(`[create] users row for ${TECH_RAC} (id=${techUserId})`);
  }

  const techRes = await client.query(
    `SELECT id, tech_un_no FROM technicians WHERE ldap_id = $1 LIMIT 1`,
    [TECH_LDAP],
  );
  if (!techRes.rows.length) {
    await client.query(
      `INSERT INTO technicians
         (ldap_id, name, phone, district, tech_un_no, is_active)
       VALUES ($1, $2, $3, $4, $5, true)`,
      [TECH_LDAP, TECH_NAME, TECH_PHONE, DISTRICT_FALLBACK, TECH_UN_NO],
    );
    console.log(`[create] technicians row for ${TECH_LDAP}`);
  } else if (techRes.rows[0].tech_un_no !== TECH_UN_NO) {
    await client.query(
      `UPDATE technicians SET tech_un_no = $1 WHERE ldap_id = $2`,
      [TECH_UN_NO, TECH_LDAP],
    );
    console.log(
      `[update] technicians row for ${TECH_LDAP}: tech_un_no -> ${TECH_UN_NO}`,
    );
  } else {
    console.log(`[skip] technicians row for ${TECH_LDAP} exists`);
  }

  return techUserId;
}

async function ensureDevSubmission(client, techUserId, src) {
  const existing = await client.query(
    `SELECT id, ticket_status FROM submissions WHERE service_order = $1 LIMIT 1`,
    [src.service_order],
  );
  if (existing.rows.length) {
    console.log(
      `[skip] submission SO ${src.service_order} exists in dev (id=${existing.rows[0].id}, status=${existing.rows[0].ticket_status})`,
    );
    return existing.rows[0].id;
  }

  const description =
    `[TEST] SHSAI smoke from prod snapshot — queued copy of completed prod ticket. ` +
    `Use this to verify the restored Service Order History tab returns real ` +
    `customer history for SO ${src.service_order}.`;

  const r = await client.query(
    `INSERT INTO submissions (
       technician_id, rac_id, phone, service_order, district_code,
       appliance_type, request_type, warranty_type, issue_description,
       estimate_amount, technician_ldap_id, proc_id, client_nm,
       ticket_status, stage1_status, stage2_status,
       submission_approved, ai_enhanced
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, 'authorization', $7, $8,
       '0.00', $9, $10, $11,
       'queued', 'pending', 'pending',
       false, false
     )
     RETURNING id`,
    [
      techUserId,
      TECH_RAC,
      TECH_PHONE,
      src.service_order,
      src.district_code ?? DISTRICT_FALLBACK,
      src.appliance_type ?? 'refrigeration',
      src.warranty_type ?? 'sears_protect',
      description,
      TECH_LDAP,
      src.proc_id,
      src.client_nm,
    ],
  );
  console.log(
    `[create] submission SO ${src.service_order} in dev (id=${r.rows[0].id})`,
  );
  return r.rows[0].id;
}

async function main() {
  console.log('=== Seeding dev test ticket from prod-sourced SO ===');

  const prodClient = await prodPool.connect();
  let src;
  try {
    console.log(
      `[prod] reading ${SO_OVERRIDE ? `SO ${SO_OVERRIDE}` : 'most recent completed ticket'}...`,
    );
    src = await fetchProdSource(prodClient, SO_OVERRIDE);
    console.log(
      `[prod] picked SO ${src.service_order} (proc_id=${src.proc_id}, client=${src.client_nm}, district=${src.district_code}, appliance=${src.appliance_type}, warranty=${src.warranty_type})`,
    );
  } finally {
    prodClient.release();
    await prodPool.end();
  }

  const devClient = await devPool.connect();
  try {
    const techUserId = await ensureDevTechnician(devClient);
    const subId = await ensureDevSubmission(devClient, techUserId, src);
    console.log(
      `=== Done. Dev submission id=${subId} for SO ${src.service_order}. ` +
        `Log in to dev, open the queue, claim it, and verify the Service ` +
        `Order History tab populates. ===`,
    );
  } finally {
    devClient.release();
    await devPool.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
