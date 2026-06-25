---
name: Prod deploy URL, visibility shield & slow-boot health window
description: The canonical prod URL is whatever getDeploymentInfo().primaryUrl says (NOT inferred from which subdomain 404s); Private visibility blocks all non-collaborator logins via the Replit shield; and the app returns 500 on / for ~40s after every (re)deploy.
---

# Canonical prod URL = `getDeploymentInfo().primaryUrl` (authoritative)

The live production URL is **`vrs-auth-tool.replit.app`** (confirmed by `getDeploymentInfo().primaryUrl`). `vrs-express.replit.app` is a dead/never-promoted subdomain that returns `<title>This app isn't live yet</title>`.

- **Why this matters / past mistake:** do NOT infer which subdomain is canonical from which one currently 404s. A "This app isn't live yet" 404 can mean the build is down OR that subdomain simply isn't the deployment's URL — not that the *other* one is canonical. Once I wrongly concluded vrs-auth-tool was detached and told the user to repoint everything to vrs-express; in fact vrs-auth-tool was always the primary and was only unreachable because the build was failing + visibility was Private. Always trust `getDeploymentInfo().primaryUrl`.
- A subdomain that isn't attached returns Replit's edge platform page `<title>This app isn't live yet</title>` (HTTP 404, header `via: 1.1 google`) — that response is from Replit's edge, **not** our Express server, so in-app redirects can never catch it. Repoint links/bookmarks/QR/PWA to the canonical URL instead.

# Private visibility → Replit shield blocks ALL field-tech/agent logins

If `getDeploymentInfo().visibility === "private"`, every request to the live app `307`-redirects to `https://replit.com/__replshield?redirect=...` — Replit's privacy gate that forces a *Replit account* login before traffic reaches Express.

- **Symptom:** users report "can't log in" even though the build is healthy (`hasSuccessfulBuild: true`) and the code is fine. They never reach the login page — the shield bounces them. `curl /api/healthz` returns HTTP 307 to `__replshield` instead of our JSON.
- **Why:** field technicians / VRS agents are not Replit collaborators, so a Private deployment is unusable for them. This app must be published **Public**.
- **How to apply:** the agent cannot change visibility — it's a Publishing-UI control. Tell the user to set Visibility to Public. Diagnose with `getDeploymentInfo()` (`visibility`) + a `curl` that shows the `__replshield` 307.

# (historical) renamed-subdomain detach note
- **Why:** the request never reaches our app, so Express middleware / a 301 canonical-redirect handler can never see it. App code can only redirect hosts whose traffic actually reaches the server (the canonical URL itself, or custom domains explicitly attached to the deployment).
- **How to apply:** Don't promise an in-app redirect for an old `.replit.app` subdomain — it's platform-controlled and (being auto-generated, not a user-owned custom domain) generally can't be re-attached or given a redirect rule. The practical fix is to repoint links/bookmarks/QR/PWA-install URLs to the new canonical URL. An in-app canonical 301 only helps for custom domains the user attaches.
- **Footgun if you DO add a canonical redirect:** scope it to an explicit allowlist of public hosts. Never "redirect every host != canonical" — the VM startup health probe hits `GET /` from an internal host (seen as `http://127.0.0.1:<port>/`); a blanket redirect would 3xx the probe, it never gets 200, and the deployment fails to promote.

# Slow boot: `/` returns 500 for ~40s after every (re)deploy

This app does heavy synchronous-ish startup work **before** it starts serving: Snowflake probe, seeding technicians, ensuring added columns, building 14 perf indexes CONCURRENTLY, etc. The HTTP server only logs `serving on port 5000` at the very end.

- During that window the deployer's `GET /` health probe gets `connection refused` then HTTP 500 repeatedly (`healthcheck / returned status 500`), until boot finishes and it flips to 200.
- **Why VM matters here:** a Reserved VM keeps retrying the startup probe and eventually promotes once `/` returns 200, so the ~40s window is tolerated. Autoscale's startup-probe window is tighter and this slow boot is a promotion risk — another reason this app is on `vm`.
- **How to apply:** the 500s right after a publish are expected boot noise, not necessarily a real outage — re-check liveness ~60s later before diagnosing. If startup ever needs to be probe-fast, call `httpServer.listen()` first (so `/`/healthz answer 200 immediately) and run seeding/index work asynchronously after.
