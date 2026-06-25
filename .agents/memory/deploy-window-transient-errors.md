---
name: Deploy-window transient HTML errors
description: Why client API calls during a republish/cold-boot show raw Replit HTML, and the transient-classification contract that hides it
---

During a republish or the ~40s cold-boot window, the Replit edge returns an HTML
page (not our JSON) for in-flight POST/PATCH requests. Observed variants:
- 403 "Forbidden" HTML
- 50x edge HTML
- 404 "This app isn't live yet" / "publish your app" page

**Symptom:** agents saw a red error toast containing the raw 404 HTML page when
clicking Approve & Notify mid-republish, because the failing mutation's onError
dumped raw `err.message` (the HTML body) into the toast.

**Contract (keep these in lockstep):**
- `isTransientApiError()` in `client/src/lib/queryClient.ts` decides what counts as
  a transient edge/boot error and is retried by `apiRequestWithRetry`. It must match
  ALL the HTML variants above. The 404 match is gated on `<!doctype html` so our own
  real 404s (always JSON `{error:"..."}`) are never swallowed.
- User-facing mutation `onError` toasts must show `friendlyApiErrorMessage(err)`,
  NOT raw `.message` — otherwise any HTML body leaks into the toast. Real server JSON
  messages pass through unchanged.

**Why retries are safe for /process & /process-nla:** server uses
`updateSubmissionIfStatus` (optimistic lock), so a retry that races a successful
first attempt returns a structured 409 STALE_STATUS, not duplicate side effects.

**Reality check:** `apiRequestWithRetry` backoff (even maxAttempts:5 ≈ 12s) does NOT
fully ride out a ~40s boot. The real fix is: classify as transient + show a friendly
"try again in a moment" message so the agent re-clicks once the deploy finishes.
