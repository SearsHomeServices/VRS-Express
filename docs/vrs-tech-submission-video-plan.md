# VRS Technician Submission Video - Fast Ship Plan

Status: verified against the current local checkout after GitHub sync on 2026-04-27.

Source branch/commit: `main` at `52ebd75` (`origin/main`). No remote branch named `development` exists in GitHub at the time of this plan.

## Goal

Create one short instructional video for the East Coast team meeting on 2026-04-28 morning. Scope is technician-side only: how to log in, start a new submission, choose the correct request type, complete the required fields, review, and submit.

Do not include agent or admin screens.

## Fastest Production Path

Use a single 7-9 minute screen recording with light trimming, not a polished training course.

Recommended workflow:

1. Record the current app in a mobile-sized browser viewport or on a mirrored phone.
2. Use a seeded/demo technician account, not production customer data.
3. Walk through the same shared form once, then branch into the three request types.
4. Add simple title cards or verbal section breaks for the three request types.
5. Export MP4 at 1080p and post to Teams/SharePoint before the meeting.

Fastest Windows tools:

- Clipchamp: quickest for trimming, title cards, and MP4 export.
- Teams solo meeting recording: fastest if captions/transcript matter more than clean editing.
- PowerPoint screen recording: useful if the final artifact should live beside slides.

## Recording Setup

Use the Replit/dev URL if it already has the right database and upload storage. Use local only if `DATABASE_URL`, object storage env vars, and upload paths are already working.

Demo login:

- Technician login is LDAP-only.
- Seeded development tech LDAP IDs found in the repo: `testtech1`, `tmorri1`.
- The user guide also lists `testtech1` / `tmorri1` for passwordless technician login.

PowerShell local smoke commands if needed:

```powershell
git status --short --branch
$env:NODE_ENV = "development"
npx tsx server/index.ts
```

Before recording:

- Clear old drafts or click `Start fresh` if a draft restore banner appears.
- Prepare fake/demo values:
  - Service order format: `8175-12345678`
  - Phone number: use a non-customer demo number
  - Appliance: pick Refrigerator or Laundry for easy examples
  - Issue photos: one or two sample appliance issue photos
  - Model/serial and TechHub estimate screenshots: have images ready
  - NLA part number example: `WPW10321304`
- Increase browser zoom or use a 390x844 mobile viewport so text is readable in the meeting.

## The Three Technician Request Types

These are the current request type choices in `client/src/pages/tech-submit.tsx`:

1. Authorization
   - Use for repair approval or non-repairable determination.
   - Supported in VRS for Sears Protect / Sears PA / Sears Home Warranty (Cinch), American Home Shield, and First American.
   - Key evidence: diagnosis, required repair, model/serial tag, TechHub estimate, issue photos.

2. Infestation / Non-Accessible
   - Use when the technician cannot safely service because of infestation, unsafe conditions, or blocked access.
   - Key evidence: clear photos of pests, droppings, mold/biohazard, unsafe access, or blocked appliance access.
   - The form changes the second photo section to model/serial tag instead of full estimate screenshots.

3. Parts - No Longer Available (NLA)
   - Use only when TechHub shows a part as no longer available.
   - Current in-app guidance says this is for Sears Protect / Sears PA / Sears Home Warranty (Cinch) calls only.
   - AHS and First American NLA should be handled through TechHub, not VRS.
   - Key fields: NLA part numbers plus any other available parts that still need to remain on the order.

## Run Of Show

Target length: 7-9 minutes.

0:00-0:20 - Title and promise:
Show the app and say: "This is how to submit a VRS request from the technician side. We are covering the three request types only: Authorization, Infestation / Non-Accessible, and Parts NLA."

0:20-0:50 - Login:
Show Field Technician login. Enter LDAP ID. Confirm phone number. Continue to dashboard.

0:50-1:20 - Technician home:
Point out Pending / Approved / Rejected counts, Recent Submissions, and `New Submission`. Do not explain agent workflow.

1:20-2:10 - Pick the correct request type:
Show all three request cards. Use this talk track:

"Start by choosing the request type. Authorization is for repair approval or non-repairable review. Infestation / Non-Accessible is for conditions that prevent safe service. Parts NLA is only when TechHub marks a part no longer available, and it is for Sears Protect, Sears PA, and Cinch calls only."

2:10-3:30 - Shared required fields:
Show technician info, phone, service order split into district and service order number, appliance type, warranty auto-detection, and issue description. Mention that the description should answer: symptom, diagnosis, repair needed, and why approval is needed.

3:30-4:35 - Authorization example:
Select `Authorization`. Fill service order, appliance, warranty, and issue description. Upload issue photos plus model/serial and TechHub estimate screenshots. Mention optional video and voice note only briefly.

4:35-5:35 - Infestation / Non-Accessible example:
Switch to `Infestation / Non-Accessible`. Show the photo evidence warning. Say:

"This is not a general repair approval. Use it when the job cannot be safely completed because of infestation, biohazard, blocked access, or unsafe access. The photos are the proof."

5:35-7:00 - NLA example:
Switch to `Parts - No Longer Available (NLA)`. Show the blue NLA guidance and the part number sections. Enter one NLA part number and optionally one available part number. Say:

"NLA means TechHub says the part is no longer available. Put the unavailable part here. If there are other parts that are available and still needed, add those in the available parts section so they do not get lost."

7:00-8:00 - Review and submit:
Show `Submit NLA Request` or `Submit for Review`, then the pre-submit review dialog. Point out warnings for short descriptions, missing photos, or NLA part issues. Use `Go back & edit` once if you want to demonstrate correction, then confirm.

8:00-8:45 - After submission:
Show the submission detail or home status. Say:

"After submission, watch the status in VRS and your SMS messages. If rejected, open the rejection reason and resubmit with the missing information or clearer photos."

8:45-9:00 - Close:
Repeat the decision rule: Authorization for approval, Infestation / Non-Accessible for unsafe/no-access service, NLA only for TechHub no-longer-available parts on Sears Protect / PA / Cinch.

## Must-Say Points

- Technician login uses LDAP ID.
- Service order format is district plus service order number.
- Clear photos reduce rejections.
- The review screen is the last chance to catch missing information.
- AHS and First American authorization can go through VRS.
- AHS and First American NLA does not go through VRS.
- NLA is not for "part is on backorder" unless TechHub marks it no longer available.

## Avoid Saying

- Do not promise every approval in a fixed number of minutes.
- Do not show or mention agent/admin screens.
- Do not use real customer names, phone numbers, service orders, addresses, or live claim data.
- Do not teach technicians to bypass TechHub for AHS / First American NLA.

## Quick Meeting Delivery Package

Ship these three items:

1. MP4 recording, 7-9 minutes.
2. One-slide decision grid:
   - Authorization: VRS
   - Infestation / Non-Accessible: VRS
   - Sears Protect / PA / Cinch NLA: VRS
   - AHS / First American NLA: TechHub
3. Optional one-page checklist:
   - LDAP login
   - Service order
   - Appliance type
   - Warranty/provider
   - Description
   - Issue photos
   - Model/serial and estimate screenshots
   - NLA part numbers if applicable
   - Review before submit

## Dry Run Checklist

- Login works with demo technician.
- Demo media uploads, or you have a backup plan to describe uploads without waiting.
- Browser viewport is readable on a meeting screen.
- No real customer data appears.
- The three request types are visible in the first two minutes.
- NLA limitation for AHS / First American is stated clearly.
- Final exported MP4 plays with audio before posting.
