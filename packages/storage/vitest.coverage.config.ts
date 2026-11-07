import { defineConfig } from "vitest/config";
import { storageAliases, storageTestTimeout } from "./vitest.config";

type Threshold = { statements: number; branches: number; functions: number; lines: number };

/** Per-file floors are the Linux measurement rounded down, minus about 2 points (branches keep more room). */
const storageFileThresholds: Record<string, Threshold> = {
  // Policy and privacy boundaries.
  "policy-helper.ts": { statements: 98, branches: 98, functions: 98, lines: 98 },
  "secret-redaction.ts": { statements: 95, branches: 85, functions: 98, lines: 95 },
  "diagram-source-redaction.ts": { statements: 70, branches: 64, functions: 98, lines: 85 },
  "path-safety.ts": { statements: 98, branches: 98, functions: 98, lines: 98 },
  "project-path-remap.ts": { statements: 93, branches: 85, functions: 98, lines: 93 },
  "agent-read-audit-service.ts": { statements: 92, branches: 83, functions: 98, lines: 94 },
  // Reports and Agent projections.
  "report-synthesis-service.ts": { statements: 83, branches: 66, functions: 98, lines: 83 },
  "report-agent-view.ts": { statements: 88, branches: 84, functions: 81, lines: 89 },
  "report-service.ts": { statements: 90, branches: 70, functions: 82, lines: 90 },
  "report-builder.ts": { statements: 83, branches: 68, functions: 98, lines: 82 },
  // Attention, related work, and outstanding items.
  "attention-service.ts": { statements: 96, branches: 85, functions: 94, lines: 98 },
  "related-work-service.ts": { statements: 95, branches: 89, functions: 98, lines: 98 },
  "outstanding-item-service.ts": { statements: 92, branches: 80, functions: 98, lines: 95 },
  "outstanding-cleanup-service.ts": { statements: 80, branches: 74, functions: 94, lines: 87 },
  // Knowledge and recall.
  "knowledge-page-service.ts": { statements: 90, branches: 83, functions: 98, lines: 90 },
  "knowledge-candidates.ts": { statements: 86, branches: 66, functions: 94, lines: 86 },
  "knowledge-service.ts": { statements: 94, branches: 85, functions: 98, lines: 95 },
  "context-recall-service.ts": { statements: 85, branches: 72, functions: 89, lines: 86 },
  "search-repository.ts": { statements: 95, branches: 84, functions: 98, lines: 94 },
  // Data transfer, deletion, and transactions.
  "project-data-transfer.ts": { statements: 90, branches: 80, functions: 94, lines: 89 },
  "project-deletion-service.ts": { statements: 85, branches: 64, functions: 98, lines: 84 },
  "session-deletion-service.ts": { statements: 84, branches: 46, functions: 98, lines: 84 },
  "session-record-service.ts": { statements: 89, branches: 77, functions: 98, lines: 89 },
  "sqlite-transaction.ts": { statements: 95, branches: 83, functions: 98, lines: 98 },
  "sqlite-errors.ts": { statements: 77, branches: 65, functions: 98, lines: 80 },
  "schema-migrations.ts": { statements: 98, branches: 79, functions: 98, lines: 98 },
  "backup.ts": { statements: 87, branches: 80, functions: 95, lines: 87 },
  // Existing gate, never lowered.
  "handoff-parser.ts": { statements: 85, branches: 70, functions: 90, lines: 85 },
};

const fileThresholds = Object.fromEntries(
  Object.entries(storageFileThresholds).map(([file, threshold]) => [`packages/storage/src/${file}`, threshold]),
);

export default defineConfig({
  resolve: { alias: storageAliases },
  test: {
    include: ["tests/storage/**/*.test.ts"],
    testTimeout: storageTestTimeout,
    env: { TZ: "UTC" },
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["packages/storage/src/**/*.ts"],
      exclude: ["tests/storage/**/*.test.ts"],
      thresholds: {
        // Files without their own entry (store facade, CLI-only maintenance, legacy importer) share a looser floor.
        statements: 80,
        branches: 65,
        functions: 90,
        lines: 80,
        ...fileThresholds,
      },
    },
  },
});
