import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverHandoffCandidates, MAX_HANDOFF_FILE_BYTES } from "../../packages/storage/src/handoff-importer.js";
import { readRegularFileUtf8 } from "../../packages/storage/src/regular-file-read.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const MAX_MILLISECONDS = 1_000;
const COMPLETE_HANDOFF = "# Fictional orchard handoff\n\nStatus: complete\nRecorded date: 2026-09-14\n";

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

function trackedProject(): { store: WorkIntelligenceStore; root: string; handoffDirectory: string } {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-handoff-fifo-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Fictional orchard project", root);
  store.updateProject(project.id, { status: "tracked" });
  const handoffDirectory = join(root, ".openspec", "handoffs");
  mkdirSync(handoffDirectory, { recursive: true });
  return { store, root, handoffDirectory };
}

function makeFifo(path: string): void {
  execFileSync("mkfifo", [path]);
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === "win32")("handoff discovery with a named pipe", () => {
  it("skips a FIFO named like a handoff in discovery and keeps reading regular files", () => {
    const { root, handoffDirectory } = trackedProject();
    writeFileSync(join(handoffDirectory, "done.md"), COMPLETE_HANDOFF, "utf8");
    makeFifo(join(handoffDirectory, "pipe.md"));

    const started = performance.now();
    const discovery = discoverHandoffCandidates(root);
    expect(performance.now() - started).toBeLessThan(MAX_MILLISECONDS);

    expect(
      discovery.candidates.map((candidate) => [candidate.sourcePath, candidate.decision, candidate.reason]),
    ).toEqual([
      [".openspec/handoffs/done.md", "eligible", undefined],
      [".openspec/handoffs/pipe.md", "excluded", "not_regular_file"],
    ]);
    expect(discovery.candidates[1]).toMatchObject({
      title: "pipe",
      content: "",
      changedFilesStatus: "not_read",
      detail: expect.stringContaining("source content was not read"),
    });
  });

  it("reports the FIFO as skipped in the preview and in an import, and never selects it", () => {
    const { store, root, handoffDirectory } = trackedProject();
    writeFileSync(join(handoffDirectory, "done.md"), COMPLETE_HANDOFF, "utf8");
    makeFifo(join(handoffDirectory, "pipe.md"));

    const started = performance.now();
    const preview = store.previewHandoffImport({ projectRoot: root });
    const imported = store.importHandoffs({
      projectRoot: root,
      sourcePaths: [".openspec/handoffs/done.md", ".openspec/handoffs/pipe.md"],
    });
    expect(performance.now() - started).toBeLessThan(MAX_MILLISECONDS);

    expect(preview).toMatchObject({
      outcome: "preview",
      totals: { discovered: 2, eligible: 1, excluded: 1, alreadyImported: 0, errors: 0 },
    });
    if (preview.outcome !== "preview" || imported.outcome !== "imported") {
      throw new Error("Expected a preview and an import result");
    }
    expect(preview.items).toContainEqual(
      expect.objectContaining({
        sourcePath: ".openspec/handoffs/pipe.md",
        decision: "excluded",
        reason: "not_regular_file",
      }),
    );
    expect(imported.imported).toHaveLength(1);
    expect(imported.skipped).toEqual([
      expect.objectContaining({ sourcePath: ".openspec/handoffs/pipe.md", reason: "not_regular_file" }),
    ]);
  });

  it("does not read a FIFO named as the handoff of a finalize call", () => {
    const { store, root } = trackedProject();
    makeFifo(join(root, "closing.md"));

    const started = performance.now();
    const result = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "fifo-handoff",
      title: "Fictional work",
      summary: "Fictional summary of fictional work.",
      handoffPath: "closing.md",
      changedFiles: [],
    });
    expect(performance.now() - started).toBeLessThan(MAX_MILLISECONDS);
    expect(result).toMatchObject({ outcome: "finalized" });
    if (result.outcome !== "finalized") {
      throw new Error("Expected a finalized result");
    }
    expect(store.getSessionDetail(result.session.id)?.rawSnapshots).toEqual([]);
  });

  it("checks the open descriptor, so a FIFO swapped in after a listing is skipped", () => {
    const { handoffDirectory } = trackedProject();
    const path = join(handoffDirectory, "swapped.md");
    makeFifo(path);

    const started = performance.now();
    expect(readRegularFileUtf8(path, MAX_HANDOFF_FILE_BYTES)).toEqual({ kind: "skipped", reason: "not_regular_file" });
    expect(performance.now() - started).toBeLessThan(MAX_MILLISECONDS);
  });
});

describe("handoff file size", () => {
  it("reads a regular file and reports its modification time", () => {
    const { handoffDirectory } = trackedProject();
    const path = join(handoffDirectory, "regular.md");
    writeFileSync(path, "héllo 世界", "utf8");

    expect(readRegularFileUtf8(path, 1_000)).toMatchObject({ kind: "read", text: "héllo 世界" });
  });

  it("skips a file over the limit without reading it", () => {
    const { handoffDirectory } = trackedProject();
    const path = join(handoffDirectory, "large.md");
    writeFileSync(path, "x".repeat(101), "utf8");

    expect(readRegularFileUtf8(path, 100)).toEqual({ kind: "skipped", reason: "too_large" });
  });

  it("lists an oversized handoff as unreadable with fixed text and never reads it", () => {
    const { root, handoffDirectory } = trackedProject();
    writeFileSync(join(handoffDirectory, "huge.md"), "x".repeat(MAX_HANDOFF_FILE_BYTES + 1), "utf8");

    const [candidate] = discoverHandoffCandidates(root).candidates;
    expect(candidate).toMatchObject({
      sourcePath: ".openspec/handoffs/huge.md",
      decision: "error",
      reason: "unreadable",
      detail: "The handoff file is too large to read.",
      content: "",
      changedFilesStatus: "not_read",
    });
  });
});
