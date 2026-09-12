---
name: Email delivery ambiguity
description: Why uncertain provider outcomes require operator review instead of automatic resend.
---

Treat a transport timeout or interrupted in-flight email as an unknown outcome, not a confirmed failure. Require an intentional resend for these cases.

**Why:** SendGrid Mail Send acceptance does not prove mailbox delivery, and this integration has no provider-side idempotency guarantee. Retrying an uncertain request automatically can send executives duplicate mail. Database locks prevent concurrent local sends but cannot resolve an HTTP request accepted just before a process crash.

**How to apply:** Keep automatic retries for definite retryable HTTP rejections. Preserve uncertain attempts for audit and warn operators that an intentional resend may duplicate mail. Never label HTTP 202 as delivered; verified provider delivery events would be needed to make that claim.