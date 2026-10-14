---
name: Bridge result routing policy
description: User-required AI callback behavior for future Sasha bridge calls.
---
For future bridge calls, AI must honor the supplied callback_url, send the signed result to /webhook using the existing contract, reuse the same event ID when retrying, and never send the same completion through both result endpoints.

**Why:** The user explicitly required this routing policy after a completed Express ticket lacked a recorded Sasha acknowledgment.

**How to apply:** Make the change in the AI callback sender. Do not treat an Express ticket-close receipt as proof of upstream delivery. Do not resend historical results, change independent direct-result behavior, or restore the deferred direct-AHS feature without separate authorization.
