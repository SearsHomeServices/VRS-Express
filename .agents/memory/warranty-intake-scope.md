---
name: Warranty intake lookup scope
description: Why warranty classification must work before an IH ticket exists.
---
The IH intake warranty preview must not require a previous VRS submission.

**Why:** It is used while creating the first ticket. Requiring ownership through an existing submission creates a circular dependency that prevents first-time intake. The intended narrow permission is authenticated IH technicians reading only a warranty classification, not accessing another technician's ticket or raw Snowflake records.

**How to apply:** Preserve technician-only access, rate limiting, and derived-only responses. Keep submission-time warranty verification and existing ticket access rules intact. Do not extend this permission to the provider portal or use it to bypass Snowflake outage handling.
