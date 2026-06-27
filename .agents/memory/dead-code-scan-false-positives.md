---
name: Dead-code scan false positives
description: Why automated/explorer "dead code" lists must be grep-verified before removal in this repo
---

Automated dead-code analysis (explore subagent, and any "unused export" heuristic) is unreliable here — in one sweep it flagged 9 candidates and ALL 9 were actually in use.

**Why:** common miss patterns in this codebase:
- Dynamic imports: e.g. `clearAllTechSubmitDrafts` is called via `await import("./draft-identity")` in `client/src/lib/auth.tsx`, invisible to static "from '...'" import scans.
- Default-export components imported under a different local name (notification-settings, onboarding-wizard, help-tooltip were all imported and rendered).
- Symbols used only as a TS return/param type (NlaLookupRow, SyncedTechnician) or only internally within their own module (isTransientApiError).

**How to apply:** before deleting any "dead" symbol/file, grep the bare name across client/src + server + shared + tests + scripts, including `import(` and `require(`. Only remove on ZERO real references. A reliable mechanical check is: for each file, search for `from '...<stem>'` and `import('...<stem>')`; files with zero hits (excluding entry points main.tsx/App.tsx/index.ts and components/ui/*) are genuine orphan candidates.

Also: dead/unused code does NOT make runtime slow (it's never executed). Real speed wins in this repo came from query parallelization (Promise.all) and SQL ports, not deletions. Don't conflate "remove dead code" with "make it faster."

Confirmed genuinely-dead and removed once: `client/src/components/ObjectUploader.tsx` + `client/src/hooks/use-upload.ts` (orphaned Uppy object-storage scaffolding, only self-references in their own JSDoc).

**attached_assets pruning gotcha:** files there are loaded two ways — `@assets/<name>` imports in client (static-scannable) AND by LITERAL filename in server code (`path.join(process.cwd(),'attached_assets','<name>.csv')` in server/routes.ts), which an `@assets` scan completely misses. Before deleting any attached_asset, grep its *basename* across server+client+shared+scripts, not just `@assets` import sites. In practice nearly all attached_assets are orphaned dev paste artifacts; only a tiny live set survives (the @assets-referenced logo + the server-loaded CSV). Same literal-filename risk applies to any `path.join(cwd, ...)` data file.
