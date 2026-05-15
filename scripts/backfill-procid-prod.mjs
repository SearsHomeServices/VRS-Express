import snowflake from 'snowflake-sdk';
import pg from 'pg';

const PROD_DB_URL = process.env.PROD_DATABASE_URL;
if (!PROD_DB_URL) { console.error('PROD_DATABASE_URL not set'); process.exit(1); }
if (!process.env.SNOWFLAKE_PRIVATE_KEY) { console.error('SNOWFLAKE_PRIVATE_KEY not set'); process.exit(1); }

function normalizeKey(key) {
  let n = key.trim().replace(/\\n/g, '\n');
  const h = n.match(/-----BEGIN (RSA )?PRIVATE KEY-----/);
  const f = n.match(/-----END (RSA )?PRIVATE KEY-----/);
  if (h && f) {
    const body = n.replace(h[0], '').replace(f[0], '').replace(/[\s\r\n]+/g, '');
    const lines = body.match(/.{1,64}/g) || [];
    return h[0] + '\n' + lines.join('\n') + '\n' + f[0] + '\n';
  }
  return n;
}

function connectSnowflake() {
  return new Promise((resolve, reject) => {
    const conn = snowflake.createConnection({
      account: process.env.SNOWFLAKE_ACCOUNT,
      username: process.env.SNOWFLAKE_USERNAME,
      authenticator: 'SNOWFLAKE_JWT',
      privateKey: normalizeKey(process.env.SNOWFLAKE_PRIVATE_KEY),
      warehouse: process.env.SNOWFLAKE_WAREHOUSE,
      database: 'PRD_TPMS',
      schema: 'HSTECH',
    });
    conn.connect((e, c) => (e ? reject(e) : resolve(c)));
  });
}

function lookup(conn, soNumber) {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText: `SELECT CMB_THD_PTY_ID, CLIENT_NM FROM PRD_DB2.HS_PERM_TBLS.IH_SERVICEORDER_FULLDETAIL_TBL WHERE SO_NO = ? LIMIT 1`,
      binds: [soNumber],
      complete: (err, stmt, rows) => (err ? reject(err) : resolve(rows || [])),
    });
  });
}

const pool = new pg.Pool({ connectionString: PROD_DB_URL, ssl: { rejectUnauthorized: false } });

const { rows: stuck } = await pool.query(
  `SELECT id, service_order FROM submissions
   WHERE (proc_id = 'Not Found' OR proc_id IS NULL OR client_nm = 'Not Found' OR client_nm IS NULL)
     AND created_at >= '2026-05-14 02:00'
   ORDER BY id`
);
console.log(`Found ${stuck.length} stuck tickets`);

const conn = await connectSnowflake();
console.log('Snowflake connected');

let updated = 0, stillNotFound = 0, errors = 0;
for (const s of stuck) {
  const soNum = s.service_order.includes('-') ? s.service_order.split('-')[1] : s.service_order;
  try {
    const rows = await lookup(conn, soNum);
    let procId = 'Not Found', clientNm = 'Not Found';
    if (rows.length > 0) {
      procId = String(rows[0].CMB_THD_PTY_ID ?? '').trim() || 'Not Found';
      clientNm = String(rows[0].CLIENT_NM ?? '').trim() || 'Not Found';
    }
    if (procId !== 'Not Found' || clientNm !== 'Not Found') {
      await pool.query('UPDATE submissions SET proc_id=$1, client_nm=$2 WHERE id=$3', [procId, clientNm, s.id]);
      updated++;
    } else {
      stillNotFound++;
    }
  } catch (e) {
    console.log(`  err id=${s.id} so=${s.service_order}: ${e.message}`);
    errors++;
  }
  if ((updated + stillNotFound + errors) % 25 === 0) {
    console.log(`  progress: ${updated + stillNotFound + errors}/${stuck.length} (updated=${updated})`);
  }
}

conn.destroy(() => {});
await pool.end();
console.log(`\nDONE. updated=${updated} stillNotFound=${stillNotFound} errors=${errors}`);
