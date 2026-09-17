# DEV Sasha bridge photo retention

## Approved scope

Private durable copies of Sasha bridge photos were approved for DEV on
2026-09-17. Production remains disabled, including when the photo proxy flag
is accidentally set in a production process. Legacy submission photos,
TechHub photos, outbound photo contracts, and original bridge photo identities
are not replaced.

No supported Sasha media-refresh API is documented in this project. A proxy
cannot recover a source that already returns `410 Gone`. Durable storage
preserves only images downloaded successfully before the upstream link expires.

## Retention and access

- Use the existing private Object Storage service, not public uploads or a
  local filesystem cache.
- Keep copies for at most 30 days from bridge creation. This is a bounded DEV
  default; the approval did not specify a retention period.
- Retention expiration ends access. Background cleanup deletes expired bytes;
  ticket deletion also triggers cleanup. Cleanup failures must be reported
  without raw upstream URLs, and retried.
- Serve copies only through the authenticated bridge photo route and its
  ticket-level authorization. Generic object downloads must not expose this
  reserved namespace, even to a logged-in user.
- Keep original signed URLs server-side in their existing bridge payload.
  Do not return private storage paths, signed storage URLs, or upstream error
  text to the viewer.
- Capture asynchronously when an intake is accepted, without delaying the
  accepted response for image downloads. Retry still-fresh records after
  restart and during the two-hour upstream availability window.
- Preserve the upstream HTTPS host allowlist, redirect restrictions, image
  type restrictions, size limit, and download timeout.

These copies are an operational aid, not a permanent archive. A storage outage,
an already-expired upstream link, or a request that arrives with unusable links
can still leave photos unavailable. The viewer must retain a clear unavailable
state rather than display a false success.

## Verification boundaries

Automated expiration tests must use decodable image bytes, advance beyond the
two-hour source lifetime, make the upstream return `410`, and recreate the
storage service to prove that access does not depend on process memory.
Authorization checks must happen before storage or upstream reads.

An actual Object Storage write/read/delete check confirms storage connectivity.
It does not prove Sasha link timing, nor does it establish physical-device
gesture behavior.

### Real Sasha acceptance check

1. Send a new DEV Sasha bridge request containing fresh appliance photos.
2. Confirm the authorized ticket viewer displays decodable images, and that
   private copies were captured before link expiration.
3. Record the capture time without recording the signed URLs in logs or
   screenshots.
4. After more than two hours and after the original source has actually
   expired, restart the application and reopen the same ticket.
5. Confirm the same images load from private storage. Check that an unrelated
   technician cannot access them and that the generic object route remains
   blocked.

### Physical touch acceptance check

On a real touch device, open a captured bridge photo in the ticket viewer.
Pinch outward and inward, pan while zoomed, reset zoom, switch images, close,
and reopen. Confirm the image remains visible and the page does not scroll
instead of manipulating the image. Record the device/browser and results.
Desktop synthetic touch or mobile browser emulation is useful regression
coverage, but must not be described as physical-device validation.

### Current real-source limitation

On 2026-09-17 there were no DEV photo-bearing bridge records created within the
previous two hours. Three sampled recent Sasha source links returned `410`.
Those records cannot establish a successful fresh-capture/real-expiration
check. A fresh upstream request is required.