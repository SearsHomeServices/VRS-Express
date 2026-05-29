---
name: Dev and production use separate databases
description: The dev workspace DB and the deployed production DB are different; debugging live issues requires querying production explicitly.
---

This app connects to an external Postgres via `DATABASE_URL`. The development
workspace and the published/production deployment point at **different**
databases — they are NOT the same instance.

**Why it matters:** A user reporting a live/production problem cannot be
diagnosed by querying `DATABASE_URL` (psql) in the dev workspace — that hits the
dev DB, which can show a completely different state (e.g. an agent showed
`offline` in dev but was stuck `working` in production).

**How to apply:**
- For live incidents, query production read-only via the database skill:
  `executeSql({ sqlQuery, environment: "production" })`. It hits a read replica.
- There is no write access to production from the workspace. To change
  production data you must ship code (e.g. a startup self-heal in `server/seed.ts`,
  which runs on deploy) or use an authenticated admin API call against the
  deployed app. A merged fix only reaches production on the next Publish.
