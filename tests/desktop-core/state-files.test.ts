import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The files two parts of the product exchange state through. Each entry names the file, the product file that writes it
 * and the different product file that reads it back, so a file one side writes and nobody reads (or the other way
 * round) fails here. A new `*FILE*` constant that names a `.json` file must be added to this registry.
 */
interface StateFile {
  readonly name: string;
  /** Text both sides spell, so each file really deals with this state file (a constant, a name or a helper). */
  readonly marker: RegExp;
  readonly writer: string;
  readonly reader: string;
}

const STATE_FILES: readonly StateFile[] = [
  {
    name: "agent-observations.json",
    marker: /AGENT_OBSERVATIONS_FILE|agent-observations\.json/,
    writer: "apps/mcp/src/agent-observation.ts",
    reader: "packages/shared/src/agent-observations.ts",
  },
  {
    name: "agent-observations.json (Web status)",
    marker: /readHostObservations|withHostObservations/,
    writer: "packages/shared/src/agent-observations.ts",
    reader: "apps/server/src/agent-observations.ts",
  },
  {
    name: "contract-fingerprint.json",
    marker: /contract-fingerprint\.json|MCP_CONTRACT_FINGERPRINT_FILE/,
    writer: "scripts/build-standalone.mjs",
    reader: "packages/shared/src/agent-observations.ts",
  },
  {
    name: "desktop-integration.json",
    marker: /desktop-integration\.json|INTEGRATION_RECORD_FILE_NAME/,
    writer: "packages/desktop-core/src/integration/record.ts",
    reader: "plugins/work-intelligence/scripts/desktop-integration.mjs",
  },
  {
    name: "desktop-settings.json",
    marker: /desktop-settings\.json|settingsFile|DesktopSettings/,
    writer: "apps/desktop/src/main/settings.ts",
    reader: "packages/desktop-core/src/runtime/desktop-database.ts",
  },
  {
    name: "operations-journal.json",
    marker: /operations-journal|OperationJournal|FileOperationJournalStore/,
    writer: "packages/desktop-core/src/operations/journal-store.ts",
    reader: "packages/desktop-core/src/operations/startup-recovery.ts",
  },
  {
    name: "MCP process lease",
    marker: /registerMcpProcess|getMcpRuntimeStatus|McpRuntimeStatus/,
    writer: "packages/shared/src/mcp-runtime.ts",
    reader: "apps/server/src/server.ts",
  },
];

const ROOT = path.resolve(import.meta.dirname, "../..");

function productFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) return name === "node_modules" || name === "dist" ? [] : productFiles(full);
    return full.endsWith(".ts") && !full.endsWith(".d.ts") ? [full] : [];
  });
}

describe("state files have a writer and a different reader", () => {
  for (const entry of STATE_FILES) {
    it(entry.name, () => {
      expect(entry.writer).not.toBe(entry.reader);
      for (const file of [entry.writer, entry.reader]) {
        expect(existsSync(path.join(ROOT, file)), `${file} exists`).toBe(true);
        expect(readFileSync(path.join(ROOT, file), "utf8"), `${file} deals with ${entry.name}`).toMatch(entry.marker);
      }
    });
  }

  it("registers every exported state file name constant", () => {
    const registered = STATE_FILES.map((entry) => entry.marker.source).join("|");
    const declared: string[] = [];
    for (const directory of ["packages", "apps"]) {
      for (const package_ of readdirSync(path.join(ROOT, directory))) {
        const source = path.join(ROOT, directory, package_, "src");
        if (!existsSync(source)) continue;
        for (const file of productFiles(source)) {
          for (const match of readFileSync(file, "utf8").matchAll(/export const (\w*FILE\w*) = "[\w.-]+\.json"/g)) {
            declared.push(match[1] as string);
          }
        }
      }
    }
    expect(declared.length).toBeGreaterThan(3);
    // These are read and written by one module alone (runtime GC and manifest, the Agent setup manifest, the App's
    // language choice), not exchanged.
    const internal = new Set([
      "GC_STATE_FILE_NAME",
      "LANGUAGE_PREFERENCES_FILE_NAME",
      "MANIFEST_FILE_NAME",
      "MANIFEST_FILENAME",
      "JOURNAL_FILENAME",
      "VERIFIED_CACHE_FILE_NAME",
    ]);
    for (const constant of declared) if (!internal.has(constant)) expect(registered).toContain(constant);
  });
});
