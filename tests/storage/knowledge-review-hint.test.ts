import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

function trackedProject(store: WorkIntelligenceStore, name: string): string {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-knowledge-review-"));
  tempDirs.push(root);
  const project = store.addProject(name, root);
  store.updateProject(project.id, { status: "tracked" });
  return root;
}

function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-01T08:00:00.000Z"));
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const root = trackedProject(store, "Knowledge review fixture");
  const otherRoot = trackedProject(store, "Knowledge review neighbour");
  let minute = 0;
  const record = (projectRoot: string, key: string, appliesTo: string[], extra: { supersedesId?: string } = {}) => {
    minute += 1;
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 1, 8, minute)));
    const result = store.recordKnowledge({
      projectRoot,
      idempotencyKey: `knowledge-review-${key}`,
      kind: "gotcha",
      title: `Synthetic ${key} rule`,
      body: `A fictional rule about ${key}.`,
      appliesTo,
      ...extra,
    });
    if (result.outcome !== "knowledge_recorded") throw new Error(`Expected Knowledge ${key}.`);
    return result.knowledge.id;
  };
  const ids = {
    exact: record(root, "exact", ["packages/shared/src/lease.ts"]),
    glob: record(root, "glob", ["docs/**", "packages/shared/**"]),
    directory: record(root, "directory", ["packages/shared"]),
    unrelated: record(root, "unrelated", ["apps/web/**"]),
    suffix: record(root, "suffix", ["src/lease.ts"]),
    exactNewer: record(root, "exact-newer", ["packages/shared/src/lease.ts"]),
    globNarrow: record(root, "glob-narrow", ["packages/shared/src/*.ts"]),
    noScope: record(root, "no-scope", []),
    neighbour: record(otherRoot, "neighbour", ["packages/shared/src/lease.ts"]),
    applied: record(root, "applied", ["packages/shared/src/lease.ts"]),
    contradicted: record(root, "contradicted", ["packages/shared/src/lease.ts"]),
    replaced: record(root, "replaced", ["packages/shared/src/lease.ts"]),
  };
  record(root, "replacement", ["apps/web/**"], { supersedesId: ids.replaced });
  vi.setSystemTime(new Date("2026-06-01T09:00:00.000Z"));
  return { store, root, ids };
}

function finalize(
  store: WorkIntelligenceStore,
  root: string,
  changedFiles: string[],
  ids?: { applied: string; contradicted: string },
) {
  const result = store.finalizeSession({
    projectRoot: root,
    idempotencyKey: `knowledge-review-finalize-${changedFiles.length}`,
    title: "Synthetic lease change",
    summary: "Changed a fictional lease module.",
    changedFiles,
    verification: { status: "passed" },
    ...(ids ? { appliedKnowledgeIds: [ids.applied], contradictedKnowledgeIds: [ids.contradicted] } : {}),
  });
  if (result.outcome !== "finalized") throw new Error("Expected a finalized Session.");
  return result;
}

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("knowledge to review at finalize", () => {
  it("lists Knowledge naming a changed file, exact paths before globs, newest first, at most three", () => {
    const { store, root, ids } = setup();
    const before = store.searchKnowledge({ projectRoot: root, limit: 50 });
    const result = finalize(store, root, ["README.md", "packages/shared/src/lease.ts"], ids);
    const lease = "packages/shared/src/lease.ts";
    expect(result.knowledgeToReview).toEqual([
      { id: ids.exactNewer, title: "Synthetic exact-newer rule", path: lease },
      { id: ids.exact, title: "Synthetic exact rule", path: lease },
      { id: ids.globNarrow, title: "Synthetic glob-narrow rule", path: lease, appliesTo: "packages/shared/src/*.ts" },
    ]);
    // Advisory only: no Knowledge record changes.
    const after = store.searchKnowledge({ projectRoot: root, limit: 50 });
    if (before.outcome !== "knowledge" || after.outcome !== "knowledge") throw new Error("Expected Knowledge lists.");
    const updatedAt = (list: typeof after) => list.items.map((item) => [item.id, item.updatedAt]);
    expect(updatedAt(after)).toEqual(updatedAt(before));
  });

  it("skips Knowledge the Session recorded or gave feedback on, also on a retry", () => {
    const { store, root, ids } = setup();
    const first = finalize(store, root, ["packages/shared/src/lease.ts"], ids);
    const listed = first.knowledgeToReview?.map((item) => item.id) ?? [];
    for (const excluded of [ids.applied, ids.contradicted, ids.replaced, ids.neighbour, ids.unrelated, ids.noScope]) {
      expect(listed).not.toContain(excluded);
    }
    const recorded = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: "knowledge-review-own",
      kind: "pattern",
      title: "Synthetic rule recorded by the Session",
      body: "A fictional rule.",
      appliesTo: ["packages/shared/src/lease.ts"],
      sessionId: first.session.id,
    });
    if (recorded.outcome !== "knowledge_recorded") throw new Error("Expected the Session's own Knowledge.");
    const retry = finalize(store, root, ["packages/shared/src/lease.ts"], ids);
    expect(retry.duplicate).toBe(true);
    expect(retry.knowledgeToReview?.map((item) => item.id)).not.toContain(recorded.knowledge.id);
    expect(retry.knowledgeToReview).toEqual(first.knowledgeToReview);
  });

  it("does not count directory entries or loose path suffixes as naming a file", () => {
    const { store, root, ids } = setup();
    const result = finalize(store, root, ["packages/shared/src/other.ts"]);
    expect(result.knowledgeToReview?.map((item) => item.id)).toEqual([ids.globNarrow, ids.glob]);
  });

  it("skips Knowledge an earlier Session already put in doubt until it is confirmed again", () => {
    const { store, root, ids } = setup();
    vi.setSystemTime(new Date("2026-06-01T09:00:00.000Z"));
    finalize(store, root, ["packages/shared/src/lease.ts"]);
    vi.setSystemTime(new Date("2026-06-01T10:00:00.000Z"));
    // The first Session made every lease rule possiblyStale; a later Session adds nothing new.
    expect(finalize(store, root, ["packages/shared/src/lease.ts", "docs/guide.md"])).not.toHaveProperty(
      "knowledgeToReview",
    );
    const confirmed = store.updateKnowledge({ projectRoot: root, knowledgeId: ids.exact, confirm: true });
    expect(confirmed.outcome).toBe("knowledge_updated");
    vi.setSystemTime(new Date("2026-06-01T11:00:00.000Z"));
    expect(finalize(store, root, ["packages/shared/src/lease.ts", "docs/guide.md", "docs/more.md"])).toMatchObject({
      knowledgeToReview: [{ id: ids.exact }],
    });
    // A backfilled Session that finished before the confirmation does not put it in doubt.
    const backfilled = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "knowledge-review-backfill",
      title: "Synthetic backfill",
      summary: "Backfilled a fictional lease change.",
      completedAt: "2026-06-01T09:30:00.000Z",
      changedFiles: ["packages/shared/src/lease.ts"],
      verification: { status: "passed" },
    });
    expect(backfilled).not.toHaveProperty("knowledgeToReview");
  });

  it("omits the hint when the Session changed no covered file", () => {
    const { store, root } = setup();
    expect(finalize(store, root, [])).not.toHaveProperty("knowledgeToReview");
    expect(finalize(store, root, ["scripts/other.mjs"])).not.toHaveProperty("knowledgeToReview");
  });
});
