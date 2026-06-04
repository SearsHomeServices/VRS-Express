const jwt = require("jsonwebtoken");
const SECRET = process.env.SESSION_SECRET;
const BASE = "https://vrs-auth-tool.replit.app";
// Mint a token for prod super_admin (id 10 = System Administrator)
const token = jwt.sign({ id: 10, email: "", name: "System Administrator", role: "super_admin" }, SECRET, { expiresIn: "10m" });

(async () => {
  // 1) validate token against prod
  const me = await fetch(`${BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  console.log("auth/me status:", me.status);
  const meBody = await me.text();
  console.log("auth/me body:", meBody.slice(0, 300));
  if (me.status !== 200) { console.log("Token NOT accepted by prod — aborting sync."); return; }

  // 2) trigger sync
  console.log("\nTriggering /api/admin/sync-technicians ...");
  const t0 = Date.now();
  const r = await fetch(`${BASE}/api/admin/sync-technicians`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" });
  const body = await r.text();
  console.log("sync status:", r.status, "in", ((Date.now()-t0)/1000).toFixed(1)+"s");
  console.log("sync body:", body.slice(0, 500));
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
