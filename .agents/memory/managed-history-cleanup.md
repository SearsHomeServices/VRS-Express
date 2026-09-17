---
name: Managed history cleanup limits
description: Why cleaning an active task branch does not prove deletion from upstream history or managed asset storage
---
Treat active-branch cleanup, upstream Git history, and managed asset storage as separate deletion boundaries.

**Why:** During authorized cleanup, background fetch repeatedly restored `refs/heads/main-repl/main` after a local history rewrite and ref update. Expiring reflogs and garbage collection could not remove blobs still reachable through that restored upstream ref. Completion rebasing also restored upstream ancestry, requiring an explicit file deletion in the conflict resolution. Updating the upstream required authentication unavailable to the task session. Removing an asset registration also did not establish deletion of its managed cloud copy.

**How to apply:** Verify reachability separately for the active branch and all refs. Do not repeatedly fight the managed ref or claim complete erasure from a clean working tree. Preserve application changes, report upstream/cloud deletion as unverified, and use the supported platform cleanup path rather than inventing deletion endpoints or seeking internal credentials.