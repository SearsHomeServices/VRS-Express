const jwt = require("jsonwebtoken");
const SECRET = process.env.SESSION_SECRET;
const BASE = "https://vrs-express.replit.app";
// Mint a token for prod super_admin (id 10 = System Administrator)
const token = jwt.sign({ id: 10, email: "", name: "System Administrator", role: "super_admin" }, SECRET, { expiresIn: "10m" });

const STARTED = new Date().toISOString();

(async () => {
  console.log(`[trigger_sync] START ${STARTED} target=${BASE}`);

  // 1) validate token against prod
  const me = await fetch(`${BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  console.log("auth/me status:", me.status);
  const meBody = await me.text();
  console.log("auth/me body:", meBody.slice(0, 300));
  if (me.status !== 200) {
    console.log(`[trigger_sync] RESULT: ABORTED reason=token-not-accepted auth_status=${me.status} startedAt=${STARTED}`);
    process.exit(1);
  }

  // 2) trigger sync
  console.log("\nTriggering /api/admin/sync-technicians ...");
  const t0 = Date.now();
  const r = await fetch(`${BASE}/api/admin/sync-technicians`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" });
  const body = await r.text();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("sync status:", r.status, "in", secs + "s");
  console.log("sync body:", body.slice(0, 500));

  if (r.status !== 200) {
    console.log(`[trigger_sync] RESULT: FAILED sync_status=${r.status} durationSec=${secs} startedAt=${STARTED}`);
    process.exit(1);
  }

  let summary = "";
  try {
    const j = JSON.parse(body);
    summary = `synced=${j.synced} added=${j.added} updated=${j.updated} deactivated=${j.deactivated}`;
  } catch {
    summary = "synced=? (unparseable body)";
  }
  console.log(`[trigger_sync] RESULT: SUCCESS ${summary} durationSec=${secs} startedAt=${STARTED}`);
})().catch(e => {
  console.error("ERR", e.message);
  console.log(`[trigger_sync] RESULT: ERROR reason=${(e && e.message) || "unknown"} startedAt=${STARTED}`);
  process.exit(1);
});
