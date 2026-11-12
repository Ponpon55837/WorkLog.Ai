import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverHandoffCandidates } from "../../packages/storage/src/handoff-importer.js";

const tempDirs: string[] = [];

const COMPLETE_HANDOFF = `# Fictional orchard handoff

Status: complete
Recorded date: 2026-09-14

## Summary
Pruned the synthetic orchard cache.
`;

function projectWithHandoffs(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-handoff-importer-"));
  tempDirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ".openspec", "handoffs", path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  return root;
}

function sourcePaths(root: string, options: Parameters<typeof discoverHandoffCandidates>[1] = {}): string[] {
  return discoverHandoffCandidates(root, options).candidates.map((candidate) => candidate.sourcePath);
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("handoff discovery", () => {
  it("reports a missing handoff directory as not found without reading elsewhere", () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-handoff-missing-"));
    tempDirs.push(root);
    writeFileSync(join(root, "README.md"), COMPLETE_HANDOFF, "utf8");
    expect(discoverHandoffCandidates(root)).toEqual({
      handoffDirectory: ".openspec/handoffs",
      directoryFound: false,
      truncated: false,
      candidates: [],
    });
  });

  it("finds an empty directory and ignores files that are not Markdown", () => {
    const root = projectWithHandoffs({ "notes.txt": "not a handoff", "data.json": "{}" });
    expect(discoverHandoffCandidates(root)).toMatchObject({ directoryFound: true, candidates: [] });
  });

  it("lists an excluded file without reading it and skips an excluded directory entirely", () => {
    const root = projectWithHandoffs({
      "kept.md": COMPLETE_HANDOFF,
      "private.md": "# Private synthetic note\nStatus: complete\n",
      "drafts/first.md": COMPLETE_HANDOFF,
    });
    const result = discoverHandoffCandidates(root, {
      excludePaths: [".openspec/handoffs/private.md", ".openspec/handoffs/drafts/"],
    });

    expect(result.candidates.map((candidate) => candidate.sourcePath)).toEqual([
      ".openspec/handoffs/kept.md",
      ".openspec/handoffs/private.md",
    ]);
    expect(result.candidates[1]).toMatchObject({
      decision: "excluded",
      reason: "excluded_by_user",
      content: "",
      summary: "",
      changedFilesStatus: "not_read",
    });
    expect(result.candidates[0]).toMatchObject({ decision: "eligible", completedAt: "2026-09-14T12:00:00.000Z" });
  });

  it("matches exclusions case-insensitively, as on case-insensitive file systems", () => {
    const root = projectWithHandoffs({ "Kept.md": COMPLETE_HANDOFF });
    const [candidate] = discoverHandoffCandidates(root, { excludePaths: [".openspec/handoffs/kept.md"] }).candidates;
    expect(candidate?.decision).toBe("excluded");
  });

  it("stops at maxFiles, including inside a nested directory, and says the list is truncated", () => {
    const root = projectWithHandoffs({
      "a.md": COMPLETE_HANDOFF,
      "b/c.md": COMPLETE_HANDOFF,
      "b/d.md": COMPLETE_HANDOFF,
      "e.md": COMPLETE_HANDOFF,
    });
    const result = discoverHandoffCandidates(root, { maxFiles: 2 });
    expect(result.truncated).toBe(true);
    expect(result.candidates.map((candidate) => candidate.sourcePath)).toEqual([
      ".openspec/handoffs/a.md",
      ".openspec/handoffs/b/c.md",
    ]);
    expect(discoverHandoffCandidates(root, { maxFiles: 0 }).candidates).toHaveLength(1);
    expect(sourcePaths(root, { maxFiles: 10_000 })).toHaveLength(4);
  });

  it("refuses a handoff directory or exclusion outside the project root", () => {
    const root = projectWithHandoffs({ "a.md": COMPLETE_HANDOFF });
    expect(() => discoverHandoffCandidates(root, { handoffDirectory: "../outside" })).toThrow(
      /inside the tracked project root/,
    );
    expect(() => discoverHandoffCandidates(root, { handoffDirectory: "." })).toThrow(/inside the tracked project root/);
    expect(() => discoverHandoffCandidates(root, { excludePaths: ["../outside.md"] })).toThrow(
      /inside the tracked project root/,
    );
  });

  it.skipIf(process.platform === "win32")("never follows a symbolic link out of the handoff directory", () => {
    const root = projectWithHandoffs({ "a.md": COMPLETE_HANDOFF });
    const outside = mkdtempSync(join(tmpdir(), "work-intelligence-handoff-outside-"));
    tempDirs.push(outside);
    writeFileSync(join(outside, "secret.md"), "# Outside synthetic file\nStatus: complete\n", "utf8");
    symlinkSync(join(outside, "secret.md"), join(root, ".openspec", "handoffs", "linked.md"));
    symlinkSync(outside, join(root, ".openspec", "handoffs", "linked-dir"));
    expect(sourcePaths(root)).toEqual([".openspec/handoffs/a.md"]);
  });
});
