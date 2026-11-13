import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FinalizeSessionInput } from "../../packages/core/src/index.js";
import type { GitObservedChanges } from "../../packages/storage/src/git-change-observation.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only.
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup(tracked = true) {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-observed-changes-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Observed changes", root);
  if (tracked) store.updateProject(project.id, { status: "tracked" });
  let counter = 0;
  const request = (overrides: Partial<FinalizeSessionInput> = {}): FinalizeSessionInput => {
    counter += 1;
    return {
      projectRoot: root,
      idempotencyKey: `observed-changes-${counter}`,
      title: `Session ${counter}`,
      summary: `Observed changes ${counter} summary.`,
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
      verification: { status: "not_run" },
      ...overrides,
    };
  };
  const finalize = (input: FinalizeSessionInput, observed?: GitObservedChanges) => {
    const result = store.finalizeSession(input, observed ? { observedChangedFileChanges: observed } : {});
    if (result.outcome !== "finalized") throw new Error("Expected finalize");
    return result;
  };
  return { store, root, request, finalize };
}

describe("server-observed changed file changes", () => {
  it("fills statuses only for paths the Agent gave none for, and notes it", () => {
    const { store, request, finalize } = setup();
    const observed: GitObservedChanges = {
      base: "c".repeat(40),
      changes: [
        { path: "src/a.ts", status: "added" },
        { path: "src/b.ts", status: "deleted" },
        { path: "src/outside.ts", status: "added" },
      ],
    };

    const result = finalize(request({ changedFileChanges: [{ path: "src/b.ts", status: "modified" }] }), observed);

    expect(result.session.changedFileChanges).toEqual([
      { path: "src/b.ts", status: "modified" },
      { path: "src/a.ts", status: "added" },
    ]);
    expect(result.changedFileChangesSource).toEqual({ serverObservedGit: 1 });
    expect(result.changedFileChangesFollowUp).toMatchObject({
      required: true,
      sessionId: result.session.id,
      missingPaths: ["src/c.ts"],
      missingCount: 1,
    });
    const note = store
      .getSessionDetail(result.session.id)
      ?.events.find((event) => event.details?.field === "changedFileChanges");
    expect(note).toMatchObject({
      type: "note",
      details: { field: "changedFileChanges", source: "server_observed_git", base: observed.base, paths: ["src/a.ts"] },
    });
    expect(note?.summary).toBe("變更狀態取自 MCP 伺服器觀察 Git（相對於 cccccccccccc）：1 個路徑（Agent 未回報）。");
  });

  it("adds a rename's previousPath to the changed files and never overrides a covering rename", () => {
    const { finalize, request } = setup();
    const result = finalize(request({ changedFiles: ["src/new.ts"] }), {
      base: "HEAD",
      changes: [{ path: "src/new.ts", status: "renamed", previousPath: "src/old.ts" }],
    });
    expect(result.session.changedFiles).toEqual(["src/new.ts", "src/old.ts"]);
    expect(result.session.changedFileChanges).toEqual([
      { path: "src/new.ts", status: "renamed", previousPath: "src/old.ts" },
    ]);
    expect(result.changedFileChangesFollowUp).toBeUndefined();

    const covered = finalize(
      request({
        changedFiles: ["src/x.ts"],
        changedFileChanges: [{ path: "src/y.ts", status: "renamed", previousPath: "src/x.ts" }],
      }),
      { base: "HEAD", changes: [{ path: "src/x.ts", status: "deleted" }] },
    );
    expect(covered.changedFileChangesSource).toBeUndefined();
    expect(covered.session.changedFileChanges).toEqual([
      { path: "src/y.ts", status: "renamed", previousPath: "src/x.ts" },
    ]);
  });

  it("ignores baseline paths and malformed observed paths", () => {
    const { finalize, request } = setup();
    const result = finalize(request({ baselineChangedFiles: ["src/a.ts"] }), {
      base: "HEAD",
      changes: [
        { path: "src/a.ts", status: "modified" },
        { path: "../escape.ts", status: "added" },
        { path: "src/b.ts", status: "added" },
      ],
    });
    expect(result.session.changedFiles).toEqual(["src/b.ts", "src/c.ts"]);
    expect(result.session.changedFileChanges).toEqual([]);

    const clean = finalize(request({ baselineChangedFiles: ["src/a.ts"] }), {
      base: "HEAD",
      changes: [{ path: "src/b.ts", status: "added" }],
    });
    expect(clean.session.changedFileChanges).toEqual([{ path: "src/b.ts", status: "added" }]);
  });

  it("lists at most 20 missing paths and the full count", () => {
    const { finalize, request } = setup();
    const changedFiles = Array.from({ length: 25 }, (_, index) => `src/file-${index}.ts`);
    const result = finalize(request({ changedFiles }));
    expect(result.changedFileChangesFollowUp?.missingPaths).toEqual(changedFiles.slice(0, 20));
    expect(result.changedFileChangesFollowUp?.missingCount).toBe(25);
    expect(result.changedFileChangesSource).toBeUndefined();
  });

  it("has no follow-up when every path has a status or no files changed", () => {
    const { finalize, request } = setup();
    expect(finalize(request({ changedFiles: [] })).changedFileChangesFollowUp).toBeUndefined();
    const all = finalize(
      request({
        changedFileChanges: ["a", "b", "c"].map((name) => ({ path: `src/${name}.ts`, status: "modified" as const })),
      }),
    );
    expect(all.changedFileChangesFollowUp).toBeUndefined();
  });
});

describe("prepareChangedFileObservation", () => {
  it("plans only the paths without a supplied status, minus the baseline", () => {
    const { store, request } = setup();
    const plan = store.prepareChangedFileObservation(
      request({
        changedFileChanges: [{ path: "src/a.ts", status: "added" }],
        baselineChangedFiles: ["src/c.ts"],
        changedFilesProvenance: [{ path: "src/d.ts", sources: ["git"] }],
      }),
      { baseCommit: "D".repeat(40) },
    );
    expect(plan).toMatchObject({ paths: ["src/b.ts", "src/d.ts"], baseCommit: "d".repeat(40) });
    expect(store.prepareChangedFileObservation(request(), { baseCommit: "not-a-sha" })?.baseCommit).toBeUndefined();
  });

  it("plans nothing for backfills, untracked projects, no paths, covered paths, or invalid paths", () => {
    const { store, request } = setup();
    expect(store.prepareChangedFileObservation(request({ completedAt: "2020-01-01T00:00:00.000Z" }))).toBeUndefined();
    expect(store.prepareChangedFileObservation(request({ changedFiles: [] }))).toBeUndefined();
    expect(
      store.prepareChangedFileObservation(
        request({ changedFiles: ["src/a.ts"], changedFileChanges: [{ path: "src/a.ts", status: "modified" }] }),
      ),
    ).toBeUndefined();
    expect(store.prepareChangedFileObservation(request({ changedFiles: ["../outside.ts"] }))).toBeUndefined();

    const untracked = setup(false);
    expect(untracked.store.prepareChangedFileObservation(untracked.request())).toBeUndefined();
  });

  it("plans nothing for a duplicate retry, which adds no second note", () => {
    const { store, request, finalize } = setup();
    const input = request();
    const observed: GitObservedChanges = { base: "HEAD", changes: [{ path: "src/a.ts", status: "added" }] };
    const first = finalize(input, observed);
    expect(store.prepareChangedFileObservation(input)).toBeUndefined();

    const retry = finalize(input, observed);
    expect(retry.duplicate).toBe(true);
    expect(retry.changedFileChangesFollowUp?.missingCount).toBe(2);
    const notes = store
      .getSessionDetail(first.session.id)
      ?.events.filter((event) => event.details?.field === "changedFileChanges");
    expect(notes).toHaveLength(1);
  });
});

describe("observeHeadCommit", () => {
  it("reads nothing for an untracked project", () => {
    const { store, root } = setup(false);
    expect(store.observeHeadCommit(root)).toBeUndefined();
  });

  it("returns undefined for a tracked project that is not a repository", () => {
    const { store, root } = setup();
    expect(store.observeHeadCommit(root)).toBeUndefined();
  });
});

describe("updating changed file changes", () => {
  it("lets a merge correct an observed status without leaving two entries", () => {
    const { store, finalize, request } = setup();
    const created = finalize(request({ changedFiles: ["src/a.ts", "src/b.ts"] }), {
      base: "HEAD",
      changes: [
        { path: "src/a.ts", status: "added" },
        { path: "src/b.ts", status: "modified" },
      ],
    });

    const updated = store.updateSessionMetadata({
      sessionId: created.session.id,
      changedFilesMode: "merge",
      changedFileChanges: [{ path: "src/a.ts", status: "modified" }],
    });

    expect(updated.outcome).toBe("updated");
    if (updated.outcome !== "updated") return;
    expect(updated.session.changedFileChanges).toEqual([
      { path: "src/a.ts", status: "modified" },
      { path: "src/b.ts", status: "modified" },
    ]);
    expect(updated.changedFileChangesFollowUp).toBeUndefined();
  });

  it("reports the remaining missing paths only when the update touched changed files", () => {
    const { store, finalize, request } = setup();
    const created = finalize(request());

    const touched = store.updateSessionMetadata({
      sessionId: created.session.id,
      changedFilesMode: "merge",
      changedFileChanges: [{ path: "src/a.ts", status: "added" }],
    });
    expect(touched.outcome === "updated" && touched.changedFileChangesFollowUp).toMatchObject({
      missingPaths: ["src/b.ts", "src/c.ts"],
      missingCount: 2,
    });

    const timeOnly = store.updateSessionMetadata({ sessionId: created.session.id, changedFilesMode: "merge" });
    expect(timeOnly.outcome === "updated" && timeOnly.changedFileChangesFollowUp).toBeFalsy();
  });

  it("drops stored changes for paths a replace no longer lists", () => {
    const { store, finalize, request } = setup();
    const created = finalize(
      request({
        changedFileChanges: [
          { path: "src/a.ts", status: "added" },
          { path: "src/b.ts", status: "deleted" },
        ],
      }),
    );

    const replaced = store.updateSessionMetadata({
      sessionId: created.session.id,
      changedFiles: ["src/a.ts", "src/c.ts"],
      changedFilesMode: "replace",
    });

    expect(replaced.outcome === "updated" && replaced.session.changedFileChanges).toEqual([
      { path: "src/a.ts", status: "added" },
    ]);
  });

  it("lets an incoming rename settle the stored entry for its old path", () => {
    const { store, finalize, request } = setup();
    const created = finalize(
      request({
        changedFiles: ["src/old.ts", "src/other.ts"],
        changedFileChanges: [
          { path: "src/old.ts", status: "deleted" },
          { path: "src/other.ts", status: "modified" },
        ],
      }),
    );

    const updated = store.updateSessionMetadata({
      sessionId: created.session.id,
      changedFilesMode: "merge",
      changedFileChanges: [{ path: "src/new.ts", status: "renamed", previousPath: "src/old.ts" }],
    });

    expect(updated.outcome === "updated" && updated.session.changedFileChanges).toEqual([
      { path: "src/other.ts", status: "modified" },
      { path: "src/new.ts", status: "renamed", previousPath: "src/old.ts" },
    ]);
  });
});
