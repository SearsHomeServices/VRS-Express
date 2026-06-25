---
name: Prod deploy URL redirects & slow-boot health window
description: Why a renamed .replit.app subdomain can't be redirected from app code, and why the app returns 500 on / for ~40s after every (re)deploy.
---

# Renamed `.replit.app` subdomain cannot be redirected from app code

When the deployment's auto-generated Replit subdomain changes (e.g. `vrs-auth-tool.replit.app` → `vrs-express.replit.app`), the OLD subdomain **detaches** from the deployment.

- `getDeploymentInfo().additionalUrls` is `[]` — only the new primary URL is attached.
- Hitting the old subdomain returns Replit's platform page `<title>This app isn't live yet</title>` (HTTP 404, response header `via: 1.1 google`). That response comes from Replit's edge, **not** our Express server.
- **Why:** the request never reaches our app, so Express middleware / a 301 canonical-redirect handler can never see it. App code can only redirect hosts whose traffic actually reaches the server (the canonical URL itself, or custom domains explicitly attached to the deployment).
- **How to apply:** Don't promise an in-app redirect for an old `.replit.app` subdomain — it's platform-controlled and (being auto-generated, not a user-owned custom domain) generally can't be re-attached or given a redirect rule. The practical fix is to repoint links/bookmarks/QR/PWA-install URLs to the new canonical URL. An in-app canonical 301 only helps for custom domains the user attaches.
- **Footgun if you DO add a canonical redirect:** scope it to an explicit allowlist of public hosts. Never "redirect every host != canonical" — the VM startup health probe hits `GET /` from an internal host (seen as `http://127.0.0.1:<port>/`); a blanket redirect would 3xx the probe, it never gets 200, and the deployment fails to promote.

# Slow boot: `/` returns 500 for ~40s after every (re)deploy

This app does heavy synchronous-ish startup work **before** it starts serving: Snowflake probe, seeding technicians, ensuring added columns, building 14 perf indexes CONCURRENTLY, etc. The HTTP server only logs `serving on port 5000` at the very end.

- During that window the deployer's `GET /` health probe gets `connection refused` then HTTP 500 repeatedly (`healthcheck / returned status 500`), until boot finishes and it flips to 200.
- **Why VM matters here:** a Reserved VM keeps retrying the startup probe and eventually promotes once `/` returns 200, so the ~40s window is tolerated. Autoscale's startup-probe window is tighter and this slow boot is a promotion risk — another reason this app is on `vm`.
- **How to apply:** the 500s right after a publish are expected boot noise, not necessarily a real outage — re-check liveness ~60s later before diagnosing. If startup ever needs to be probe-fast, call `httpServer.listen()` first (so `/`/healthz answer 200 immediately) and run seeding/index work asynchronously after.
