---
name: Newly added secrets need a workflow restart to propagate
description: After adding/updating Replit secrets, the running process and agent shell can be stale; restart the workflow before concluding a secret "didn't persist".
---

# Newly added secrets need a workflow restart before they're live

After a secret is added/updated via `requestEnvVar` (or the Secrets pane), it is saved to the store, but it is NOT immediately visible everywhere:
- The **already-running workflow process** keeps its old environment — it only gets the new value after a **workflow restart** (its `/proc/<pid>/environ` won't have it until then).
- The **agent `bash` shell** is inconsistent: freshly-added secrets sometimes appear in the very next `bash` call and then drop out of later calls; older secrets can read as `0 chars` even though they're in the store.
- `viewEnvVars()` can **lag / under-report** — it showed three just-added secrets as `false` immediately after the platform confirmed they were added.

**Why this matters:** chasing a "secret won't persist" bug across `bash`, `/proc`, and `viewEnvVars` wasted a long loop. The secrets WERE saved; the running process and stale shells just hadn't picked them up. A single `restart_workflow` made all five appear consistently in both the agent shell and the live `/proc/<pid>/environ`.

**How to apply:** after adding/updating any secret, **restart the workflow first**, then verify with `bash` `${!VAR}` length checks AND `tr '\0' '\n' < /proc/<pid>/environ | grep '^VAR='`. Treat post-restart `/proc/<pid>/environ` of the running server as the authoritative "is it live in the app" check. Don't conclude a secret failed to persist until you've restarted.
