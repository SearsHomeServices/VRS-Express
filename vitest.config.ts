import { defineConfig } from "vitest/config";
import path from "path";

// Tyler 2026-04-28: vitest+supertest harness for the intake-form confirm
// endpoint failure ("Could not record intake / Failed to record intake form"
// red toast). The harness runs against the already-running dev server on
// localhost:5000 (workflow "Start application") so we exercise the same
// Express stack, the same DB connection, and the same seeded test
// fixtures (SO 99999000006 / 99999000007) as the live UI.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    environment: "node",
    pool: "forks",
  },
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "shared"),
    },
  },
});
