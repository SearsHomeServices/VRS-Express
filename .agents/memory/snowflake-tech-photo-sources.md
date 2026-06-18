---
name: Snowflake technician-photo sources (account-wide)
description: Where technician-uploaded photos actually live across all 69 connected Snowflake DBs; which "photo" hits are noise.
---

# Technician photo sources in Snowflake (account-wide scan)

Scanned INFORMATION_SCHEMA.COLUMNS/TABLES of all 69 visible databases (no ACCOUNT_USAGE needed). Two real SO-keyed technician-photo sources exist:

1. **Part photos** — `IH_DATASCIENCE.PUBLIC.PARTS_USED.PHOTO_PATHS` (ARRAY). The source already surfaced on the agent dashboard "TechHub Photos" card. Most rows store a `"{}"` placeholder; real photos are sparse.
2. **Appliance model/serial-tag photos** — `HS_DEEPLEARNING.ADHOC.KAIROS_HOME_MANAGER_SERVICE_ORDERS`, column `DATA_APPLIANCECONDITION_MODELTAGIMAGEURL`. URLs point to the TINA/TechHub media service with the SO embedded: `http://tina-service-pr.shs-core.com/v2/order-info/{unit}-{SO}/media/{mediaId}`. Tech-attributed (`DATA_TECHNICIAN_*`), SO-linked (`DATA_ORDERNUMBER`), capture ts in `...MODELTAGIMAGECAPTUREDAT`. Maintained daily snapshot (table rebuilt daily). NOT yet surfaced in VRS. Different photo type (model tag) than the parts photos, covers more SOs.

**Why:** user asked to find ANY TechHub/SRDM technician photo refs across all DBs, ignoring prior discovery doc. KAIROS was the only net-new tech-photo source beyond PARTS_USED.

## SRDM is never a photo source
- `IH_DATASCIENCE.HS_PRICING.SRDM_D2C_UPLOAD` = pricing rate card (diagnostic/job rates), no photo cols.
- `PRD_SRDM` database = CAPACITY + PRICING + PRICING_VIEWS only; zero ARRAY/photo columns.

## Known noise (do NOT mistake for tech photos)
- `DID_YOU_SUBMIT_A_PHOTO_TO_TECHHUB` — hundreds of copies in HS_DEEPLEARNING.ADHOC / BI_ANALYTICS; it's a post-repair survey **flag** (BOOLEAN/TEXT), not a photo.
- All other `*TECHHUB*` tables = time-punch / Lawson parts-cost, no photo cols.
- `MARKETPARTS.*_IMG_URL`, `SP_PARTS.IMAGEURL`, `PRD_KM.MODEL/PART.IMAGE_URL` = catalog/vendor part images.
- `PRD_CLICK ... ATTACHMENTS` (VARIANT) = ClickSoftware scheduling attachments.
- `CREDIT_CARD_*.IMAGE_NAME` = receipts; PeopleSoft `DISPLAY_PICTURE` = HR boolean flag.
