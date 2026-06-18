---
name: TechHub parts-photo object-store access boundary
description: Why surfacing TechHub part photos in VRS shows empty/broken images for ~all tickets despite the pipeline working — the image bytes live in a private S3 bucket VRS can't read.
---

# TechHub part photos: the bytes are gated, not the metadata

The VRS "Parts Photos (TechHub)" pipeline (Snowflake metadata query → `/api/submissions/:id/techhub-photos` → signed `/api/techhub-photo?token=` proxy → CloudFront/S3 host allowlist) is **correct and works end-to-end**. The blocker is **object-store access**, exactly the open risk the discovery report flagged.

**Fetchability of `PHOTO_PATHS` formats (tested with live curl):**
- Relative key `jobs/<SO>/parts/<uuid>.<ext>` (≈7,638 rows, the dominant format) → prefixing CloudFront origin gives `cloudfront.net/jobs/...` = **404** (CDN does not serve the `jobs/` prefix). The same key on the S3 bucket = **403** (bucket is private). **Not fetchable either way.**
- Full S3 URL `parts-images-pr-us-east-2.s3.us-east-2.amazonaws.com/jobs/.../parts/...` (≈25 rows) → **403** (private bucket).
- Full CloudFront URL `d1kq8vno1fudyz.cloudfront.net/uploads/YYYY/MM/DD/<uuid>.jpeg` (≈4 rows) → **206 image/jpeg = PUBLIC.** Only this tiny legacy slice renders.
- `cloudfront.net/sample-images/...` (demo) → 404 (gone).

**Net effect:** for essentially every real VRS ticket the proxy fetch returns non-OK → 502 → broken/empty card. The card's success path logs nothing server-side; only the `[express] GET .../techhub-photos 200` line and (if photos render) follow-up `GET /api/techhub-photo?token=` proxy lines appear.

**Match rate is also tiny independent of access:** of 3,975 VRS prod submissions, only ~7 service orders have any photo rows, and most of those rows are the empty Postgres-array literal `{}` (ingested as a 1-element array so `ARRAY_SIZE>0` passes the filter, but `normalizeTechHubPhotoRef` correctly yields zero usable URLs). At time of writing only SO `13713743` (sub 1866) had real `jobs/...` paths — and those are the private-S3 format, so they still won't render.

**Why:** the S3 bucket `parts-images-pr-us-east-2` / its CloudFront dist is a **separate trust domain not owned by VRS**; VRS holds no AWS/CloudFront credentials for it. Snowflake gives the reference, never the bytes.

**How to apply / to actually display images, the user must obtain ONE of:**
1. IAM read credentials for `parts-images-pr-us-east-2` (then proxy signs S3 GETs), or
2. a CloudFront signing key (signed URLs), or
3. a TechHub-owned signed-URL API, or
4. the object-store owner makes the `jobs/` prefix publicly readable via CloudFront (unlikely — customer-home imagery).
No VRS-side code change fixes this; it is an access grant from whoever owns the TechHub object store.

## Snowflake only carries ONE photo category — "parts used"
A whole-schema scan of `IH_DATASCIENCE` shows the only photo-bearing columns are `PUBLIC.PARTS_USED.PHOTO_PATHS` and its staging mirror `STG_PARTS_USED.PHOTO_PATHS`. There is **no** diagnostic / appliance-nameplate / before-after / general job-photo table in Snowflake. So if a user sees photos in the **TechHub app** for an order but our card shows none, those are very likely a *different photo category* that TechHub never replicates to Snowflake — surfacing them would require a direct TechHub app/API feed, not the warehouse.

**Timing mismatch:** parts-used photos only exist *after* a tech completes the job and logs the part. VRS authorization happens at *diagnosis*, before the repair — so at review time the photo usually does not exist yet. Freshly-dispatched TechHub jobs (status `available`/`assigned`) carry zero part photos.

**Coverage is near-zero, not a bug:** of 2,868 unique VRS service orders, 412 (14%) match a TechHub JOB, only 5 have any parts-used row, and historically only **1** (`SO 13713743`) had a real parts photo. Sync is current (not lag). TechHub-wide, only 4,577 of 174,479 jobs (2.6%) have any part photo at all.

**SO ↔ district mapping (verified):** VRS `service_order` is `DDDD-SSSSSSSS`; the `DDDD` district = TechHub `JOBS.SERVICE_UNIT_NUMBER` (zero-padded, e.g. district 8420 → `0008420`), and the 8-digit second segment = `JOBS.SO_NUMBER`. App keys photos on `SO_NUMBER` only (`fetchTechHubPartsPhotosForServiceOrder` splits on `-`).
