import { defineConfig } from "vitest/config";
import base from "./vitest.config";

// Hermetic critical workflows only. Live endpoint/provider tests remain opt-in
// and must not send messages or depend on production credentials at build time.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      "tests/tech-warranty-lookup.test.ts",
      "tests/direct-ahs.test.ts",
      "tests/direct-ahs-workflow-ui.test.ts",
      "tests/release-gate.test.ts",
      "tests/password-input.test.ts",
      "tests/storage-result-types.test.ts",
      "tests/snowflake-*.test.ts",
      "tests/vrs-bridge-photo-*.test.ts",
      "tests/vrs-sasha-intake.test.ts",
      "tests/vrs-sasha-queue.test.ts",
      "tests/vrs-sasha-stage-one.test.ts",
      "tests/vrs-sasha-contract-v5-v8.test.ts",
      "tests/vrs-sasha-contract-v9.test.ts",
      "tests/vrs-callback-safety.test.ts",
      "tests/vrs-callback-handler.test.ts",
      "tests/vrs-ai-call-result.test.ts",
      "tests/vrs-admin-audit.test.ts",
      "tests/vrs-admin-media.test.ts",
      "tests/vrs-agent-media.test.ts",
      "tests/vrs-ai-bridge-ui.test.ts",
      "tests/vrs-object-storage-photo-url.test.ts",
      "tests/exec-summary-delivery.test.ts",
      "tests/exec-summary-routes.test.ts",
      "tests/weekly-exec-summary-metrics.test.ts",
      "tests/nla-ready-for-order.test.ts",
      "tests/queue-wait-alerts.test.ts",
      "tests/analytics-refresh.test.ts",
      "tests/ticket-media-metadata.test.ts",
      "tests/pilot-queue-audio.test.ts",
      "tests/pilot-queue-alert.test.ts",
    ],
    maxWorkers: 2,
  },
});