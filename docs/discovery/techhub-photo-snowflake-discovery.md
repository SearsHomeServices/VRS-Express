# TechHub Photo Source — Production Snowflake Discovery (Read-Only Findings)

> **Status:** Discovery complete. **No VRS UI shipped, no Snowflake writes/schema changes.** This report scopes the V1 read-only display work.
> **Method:** Connected to production Snowflake with the existing service account using the JWT logic from `server/services/snowflake.ts` (reused `normalizeKey`, `SNOWFLAKE_JWT` authenticator). All queries were strictly read-only (a `GUARD` regex blocked any non-SELECT statement). The private key was never logged or echoed.

## TL;DR

- **Yes — technician-uploaded TechHub photos ARE readable from Snowflake** by `SVC_SCA_AUTO`, but **only one photo type is cataloged: PART photos.**
- **Source of truth:** `IH_DATASCIENCE.PUBLIC.PARTS_USED`, column **`PHOTO_PATHS` (ARRAY)**. This database is a full **Snowflake-synced replica of the TechHub operational app DB** (has `SNOWFLAKE_SYNC_RUNS`, `LAST_SYNCED_AT`, `JOBS`, `JOB_ASSIGNMENTS`, `USERS`, `VENDORS`, etc.).
- **Photos are stored as object-storage references (paths/URLs), NOT binary.** Canonical key shape: `jobs/<8-digit-SO_NO>/parts/<uuid>.<ext>`.
- **Keys to service order two ways:** (1) the **8-digit SO_NO is embedded in the path** (`jobs/13832124/parts/...`), and (2) via the join `PARTS_USED.JOB_ASSIGNMENT_ID → JOB_ASSIGNMENTS.ID → JOB_ASSIGNMENTS.JOB_ID → JOBS.ID → JOBS.SO_NUMBER`. **99% (7638/7711)** of relative paths match `JOBS.SO_NUMBER` exactly.
- **SO format match:** `JOBS.SO_NUMBER` is **8-digit numeric** (173,694 of 173,707 rows) — exactly the `SSSSSSSS` half of VRS's `DDDD-SSSSSSSS`. Split the VRS `serviceOrder` on `-` and take index `[1]` to match.
- **Gap:** Model/serial-plate photos, estimate screenshots, and appliance-condition photos are **NOT cataloged anywhere in Snowflake.** Only parts photos are indexed. Model & serial exist only as **plain text** (`JOB_ASSIGNMENTS.APPLIANCE_MODEL`, `JOB_ASSIGNMENTS.APPLIANCE_SERIAL`), not as images.

---

## 1. Connectivity & access (confirmed)

- Credentials (`SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_USERNAME`, `SNOWFLAKE_PRIVATE_KEY`, `SNOWFLAKE_WAREHOUSE`) are present in the **production runtime process env** (not in the dev/workspace secrets store). JWT connect succeeded.
- `CURRENT_*` identity: account `SEARS_HS_PROD`, user `SVC_SCA_AUTO`, role `SCIENTIST`, warehouse `SCIENTIST_PRD_WH`.
- Visibility: **69 databases**; the account holds ~63 `*_READ` roles (full list available via `SELECT CURRENT_AVAILABLE_ROLES()`). It has **`IH_DATASCIENCE_READ` and `IH_DATASCIENCE_WRITE`** (we used READ only).
- **`SNOWFLAKE.ACCOUNT_USAGE` is NOT granted** — account-wide column search is unavailable, so discovery used per-database `INFORMATION_SCHEMA.COLUMNS` / `.TABLES`.

## 2. What was scanned

- **Column search** for `%PHOTO%`, `%IMAGE%`, `%IMG%`, `%ATTACH%`, `%MEDIA%`, `%PICTURE%`, `%THUMBNAIL%`, `%FILE%URL%`, `%DOC%URL%` across all priority service/media DBs (`PRD_SRDM`, `PRD_TPMS`, `PRD_DB2`, `PRD_OMS`, `PRD_CLAIMS`, `PRD_SERVICE_CONTRACT`, `PRD_NOTIFICATION`, `PRD_SERVICEPOWER`, `PRD_SERVICELIVE`, `IH_DATASCIENCE`, `HS_ANALYTICS`, `PRD_CIBOODLE`, `PRD_CLICK`).
- **Table-name search** for `%TECHHUB%`, `%TECH_HUB%`, `%PHOTO%`, `%IMAGE%`, `%ATTACH%`, `%UPLOAD%`, `%MEDIA%`, `%PARTS_USED%`, `%ESTIMATE%` across **all 63 readable databases.**

### What the scan ruled OUT
- **`PRD_SRDM`** (the name suggested a "Service Request Data Mart" media store) contains only `CAPACITY`, `PRICING`, `PRICING_VIEWS` schemas — **no service-request media. Not a photo source.** (Relevant to the V2 write direction: SRDM as seen here is not a media catalog.)
- `PRD_TPMS`, `PRD_OMS`, `PRD_NOTIFICATION` — **zero real photo columns** (only `INFORMATION_SCHEMA` system-view noise).
- The many `%FILE%NAME%` / `*TECHHUB*` hits elsewhere are **batch-load metadata or time-punch / parts-cost data** (`TECHHUBTIMEPUNCHES`, `STG_PARTS_CST_LAWSON_TECHHUB`, `TBL_PROCESSTECHTIMETECHHUB`, NPS-survey ingest filenames) — **not technician photos.**
- **`PRD_KM.KM.PART_MEDIA`** (503k rows, `MEDIAURL`) is a **knowledge-base catalog of reference part imagery keyed by `SERIAL_NUMBER`/`HSIN`** — not technician-uploaded per-service-order photos. Ruled out.
- No table named `TECHHUB_PHOTO` / `*_MEDIA` / `*_ATTACHMENT` for service photos exists anywhere readable.

## 3. The located photo source

**`IH_DATASCIENCE.PUBLIC`** is a synced replica of the TechHub app database. Relevant objects:

| Object | Rows | Role |
|---|---|---|
| `PARTS_USED` | 8,969 | **Photo catalog** — `PHOTO_PATHS ARRAY` |
| `JOB_ASSIGNMENTS` | 14,590 | links part → job; has `APPLIANCE_MODEL`, `APPLIANCE_SERIAL`, `VRS_CODE` (text, not photos) |
| `JOBS` | 173,707 | has **`SO_NUMBER`** (service order), customer, appliance, brand |
| `VENDORS` | 295 | vendor/provider names (used to filter TEST/TRAIN) |
| `PARTS_USED_VW` (`HS_1099`) | view | convenience view already joining `PARTS_USED → JOB_ASSIGNMENTS → JOBS → VENDORS`, exposing `SERVICE_ORDER` |

`STG_*` twins are staging copies of each.

### `PARTS_USED` columns
`TIMESTAMP_TZ, ID, JOB_ASSIGNMENT_ID, BRAND, APPLIANCE_TYPE, PART_NUMBER, SERIAL_NUMBER, QUANTITY, CREATED_AT, NOTES, PHOTO_PATHS (ARRAY), PART_TYPE, DISPOSITION, CREATED_TS_DW, CREATED_USER_DW, UPDATED_TS_DW, UPDATED_USER_DW`

### Photo coverage
- 8,949 / 8,969 rows have ≥1 photo; **4,576 distinct job assignments** represented.
- Date range `CREATED_AT`: **2025-07-25 → 2026-06-17** (actively populated; newest row was today).

## 4. Photo reference format (paths, not binary)

`PHOTO_PATHS` is an `ARRAY` of string references. Across all flattened elements:

| Kind | Count | Example |
|---|---|---|
| Relative object key (modern, dominant) | 7,638 | `jobs/13832124/parts/<uuid>.jpeg` |
| Full S3 URL | ~70 | `https://parts-images-pr-us-east-2.s3.us-east-2.amazonaws.com/jobs/13066860/parts/<uuid>.jpg` |
| Full CloudFront URL | ~30 | `https://d1kq8vno1fudyz.cloudfront.net/uploads/2026/01/28/<uuid>.jpeg` |
| Legacy `/uploads/photos/<hash>` (no extension) | ~330 | `/uploads/photos/857efb60f82c1909bdbc7e01afb09753` |
| Demo/seed (`/sample-images/...`) | few | `https://d1kq8vno1fudyz.cloudfront.net/sample-images/drain-pump.png` |

**Object store (derived from the full URLs):**
- **S3 bucket:** `parts-images-pr-us-east-2` in **`us-east-2`**.
- **CDN:** `d1kq8vno1fudyz.cloudfront.net`.
- A relative key `jobs/<SO>/parts/<uuid>.<ext>` resolves to `https://parts-images-pr-us-east-2.s3.us-east-2.amazonaws.com/jobs/<SO>/parts/<uuid>.<ext>` (the full S3 URLs in the data carry the identical `jobs/<SO>/parts/` key).

> ⚠️ **Data-quality wrinkle (must handle in V1):** `PHOTO_PATHS` was ingested from a stringified Postgres array literal, so the **first element has a leading `{` and the last element a trailing `}`** — e.g. `["{jobs/13832124/parts/0c93….jpeg", "jobs/13832124/parts/8fbc….jpeg}"]`. Consumers must strip `{`/`}` before use. Elements are also a mix of relative keys and absolute URLs, so normalize: if it starts with `http`, use as-is; otherwise prefix the bucket/CDN base.

## 5. Query-by-service-order recipe

VRS `submissions.serviceOrder` is `DDDD-SSSSSSSS`; the matching key is the 8-digit second half (`SSSSSSSS`).

```sql
-- Replace :so8 with the 8-digit SO_NO (VRS serviceOrder split on '-', index [1])
SELECT
  J.SO_NUMBER                       AS service_order,
  PU.ID                             AS part_used_id,
  PU.PART_NUMBER, PU.BRAND, PU.PART_TYPE, PU.DISPOSITION, PU.CREATED_AT,
  JA.APPLIANCE_MODEL, JA.APPLIANCE_SERIAL,   -- text, for context (not photos)
  PU.PHOTO_PATHS
FROM IH_DATASCIENCE.PUBLIC.PARTS_USED      PU
JOIN IH_DATASCIENCE.PUBLIC.JOB_ASSIGNMENTS JA ON PU.JOB_ASSIGNMENT_ID = JA.ID
JOIN IH_DATASCIENCE.PUBLIC.JOBS            J  ON JA.JOB_ID = J.ID
WHERE J.SO_NUMBER = :so8
  AND ARRAY_SIZE(PU.PHOTO_PATHS) > 0
ORDER BY PU.CREATED_AT DESC;
```

**Confirmed sample (SO `13832124`):** 3 `PARTS_USED` rows, `APPLIANCE_MODEL=10651762511`, `APPLIANCE_SERIAL=HR91651339`, photos at `jobs/13832124/parts/<uuid>.jpeg`. Path-embedded SO matched `JOBS.SO_NUMBER`.

A fallback that needs no join (path already contains the SO): match `PHOTO_PATHS` elements whose 2nd path segment equals the 8-digit SO. The join is preferred (authoritative and survives the legacy `/uploads/...` path variants).

## 6. Recommended V1 read path

1. **Query object:** `IH_DATASCIENCE.PUBLIC.PARTS_USED` joined to `JOB_ASSIGNMENTS` + `JOBS` (recipe above). Prefer the explicit join over the convenience view `HS_1099.PARTS_USED_VW` — that view hard-filters to `SCHEDULED_DATE >= 2026-01-01` and excludes TEST/TRAIN vendors, which would silently drop valid history.
2. **Reuse** the existing connection in `server/services/snowflake.ts` (same account/JWT). No new client pattern; no new grants needed — `SVC_SCA_AUTO` already has `IH_DATASCIENCE_READ`.
3. **Normalize each `PHOTO_PATHS` element** server-side: strip `{`/`}`; if it starts with `http`, use as-is; else prefix with the bucket/CDN base.
4. **Retrieval gap to resolve before display:** Snowflake gives the *reference*, not the bytes. The S3 bucket `parts-images-pr-us-east-2` / CloudFront `d1kq8vno1fudyz.cloudfront.net` is a **separate trust domain not owned by VRS.** V1 must confirm whether those objects are publicly fetchable via the CDN or require signed URLs / an SOM-provided proxy. **Recommend a server-side proxy/signing step in VRS rather than exposing raw bucket URLs to the browser** (avoids leaking customer-home imagery and matches the threat model's media-access boundary). Do **not** assume direct public access until verified.
5. **Scope expectation:** V1 can surface **parts photos only.** Model/serial-plate photos, estimate screenshots, and appliance-condition photos are **not in Snowflake** — surfacing those requires a new SOM-provided table/view/API (separate effort). Model & serial *values* are available as text on `JOB_ASSIGNMENTS` if useful for the agent view.

## 7. Access / grant gaps

- No grant gaps for the located data — `IH_DATASCIENCE_READ` is held.
- `SNOWFLAKE.ACCOUNT_USAGE` not granted (only affected discovery breadth, not the V1 read path).
- The **object store** (S3/CloudFront) is outside Snowflake and outside current VRS credentials — its access model is the one open item to confirm for V1.
