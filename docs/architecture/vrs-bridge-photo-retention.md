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

### Real-source evidence — 2026-09-17

The earlier fresh-request blocker is resolved. DEV tickets 842 and 843 contain
two real allowlisted Sasha images each. No synthetic intake or mocked upstream
was used for this check. All times below are UTC.

| Ticket | Intake created | Photo index | Private object created | Decoded image | Bytes |
| --- | --- | --- | --- | --- | --- |
| 842 | 20:11:00.754 | 0 | 21:10:00.389 | JPEG 515×471 | 40,889 |
| 842 | 20:11:00.754 | 1 | 21:10:00.688 | JPEG 307×629 | 33,505 |
| 843 | 20:52:42.100 | 0 | 21:09:58.559 | JPEG 307×629 | 33,505 |
| 843 | 20:52:42.100 | 1 | 21:09:59.939 | JPEG 515×471 | 40,889 |

The DEV workflow was initially stopped. Starting it recovered all four images
before expiry (`attempted=4 failures=0`). This establishes startup recovery,
not capture at the original intake time. Independent private-object reads
confirmed capture before testing the authorized HTTP photo route.

At 21:12:42–21:12:44, every original source returned HTTP 200. Saved bytes,
live-source bytes, and authorized photo-route bytes had identical SHA-256
hashes. ImageMagick decoded both JPEGs successfully:

- 40,889-byte image: `dcf789af6d82c1d3466265070f0a68ac33a04b355ffe77056226849d81c5266a`
- 33,505-byte image: `72965fccc32447df09bf2e46d4a84d34ca028949c796a3d5e31b38ea7d467d57`

For all four photo routes, the DEV test administrator received HTTP 200 with
matching bytes; an unrelated test technician received 403; unauthenticated
requests received 401. The generic object route returned 404 even with a valid
path-bound media token issued to the test administrator.

Ticket 841 was also inspected: all four sources returned 410 and no private
copies existed. It cannot provide successful retention evidence.

### Post-expiry and restart evidence — 2026-09-17

At 22:12:01 UTC, both actual Sasha sources for ticket 842 returned HTTP 410,
more than two hours after intake. Independent private-object reads still
matched the pre-expiry hashes. The background probe then stopped successfully.

The DEV application was restarted after that observation. At 22:12:33 UTC,
both original sources still returned 410, while both authenticated photo routes
returned HTTP 200 with the exact pre-expiry bytes and original object creation
times. Both images decoded successfully. The unrelated technician received 403,
anonymous requests received 401, and generic object downloads with valid
path-bound media tokens received 404.

Ticket 843 also retained matching saved bytes across this restart, but its
sources still returned 200 at 22:12:34 UTC. It is not counted as post-expiry proof.

The first desktop browser check uncovered a separate Admin-view gap: the
read-only Media tab loaded only legacy submission attachments, not bridge
context. Its audit response now includes sanitized bridge context only when the
DEV photo feature is enabled, and the Media tab uses the existing shared
bridge gallery alongside the unchanged legacy galleries.

After the fix and another DEV restart, a targeted desktop browser check on
ticket 842 confirmed two decoded thumbnails, lightbox opening, next/previous
navigation, closing without dismissing the parent Media dialog, and reopening.
No ticket mutations or mocked sources were used.

Validation: 51 focused bridge UI, photo proxy, and Pilot tests passed.
The repository-wide TypeScript check still reports errors outside the edited
logic (including existing ES5 iteration/block-function and Snowflake typings);
it is not a passing validation result.

**Deferred at the user's request when closing this verification:** physical phone/tablet pinch, pan, reset, navigation,
close/reopen and page-scroll behavior. No device results were supplied.
Neither physical touch hardware nor mobile gesture emulation was used.
Production enablement/settings and legacy/TechHub media remain unchanged.