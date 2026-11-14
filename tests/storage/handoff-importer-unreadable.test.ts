import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverHandoffCandidates } from "../../packages/storage/src/handoff-importer.js";

const UNREADABLE_NAME = "unreadable-fixture.md";

// Root ignores permission bits and Windows locks files differently, so the failed read is simulated for one file.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    // The importer opens the file itself (it checks the open descriptor before reading), so the open is what fails.
    openSync: ((path: Parameters<typeof actual.openSync>[0], ...rest: unknown[]) => {
      if (String(path).endsWith(UNREADABLE_NAME)) {
        throw Object.assign(new Error(`EACCES: permission denied, open '${String(path)}'`), { code: "EACCES" });
      }
      return (actual.openSync as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.openSync,
  };
});

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("unreadable handoff files", () => {
  it("answer with fixed text and the relative path, never the file-system message", () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-handoff-unreadable-"));
    tempDirs.push(root);
    mkdirSync(join(root, ".openspec", "handoffs"), { recursive: true });
    writeFileSync(join(root, ".openspec", "handoffs", UNREADABLE_NAME), "# Synthetic\nStatus: complete\n", "utf8");

    const [candidate] = discoverHandoffCandidates(root).candidates;
    expect(candidate).toMatchObject({
      sourcePath: `.openspec/handoffs/${UNREADABLE_NAME}`,
      decision: "error",
      reason: "unreadable",
      detail: "The handoff file could not be read.",
      changedFilesStatus: "not_read",
    });
    expect(JSON.stringify(candidate)).not.toMatch(/EACCES|permission denied/);
    expect(JSON.stringify(candidate)).not.toContain(root);
  });
});
