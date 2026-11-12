import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { OutstandingItem } from "../../packages/core/src/index.js";
import type { OutstandingItemFocus } from "../../packages/storage/src/outstanding-item-service.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

interface SessionFixture {
  key: string;
  completedAt: string;
  nextSteps: string[];
  title?: string;
  summary?: string;
  /** Stored verbatim, bypassing finalize normalization, so case and separator variants reach the matcher. */
  rawChangedFiles?: string[];
  changedFileChanges?: Array<{ path: string; status: "renamed"; previousPath: string }>;
}

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

const SESSIONS: SessionFixture[] = [
  {
    key: "two-paths",
    completedAt: "2026-05-01T09:00:00.000Z",
    nextSteps: ["Two-path follow-up"],
    rawChangedFiles: ["packages/shared/src/lease.ts", "apps/web/index.ts"],
  },
  {
    key: "alpha",
    completedAt: "2026-05-01T10:00:00.000Z",
    nextSteps: ["Tune lease renewal", "Plain follow-up alpha"],
    rawChangedFiles: ["packages\\Shared\\SRC\\Lease.ts"],
  },
  {
    key: "bravo",
    completedAt: "2026-05-01T10:00:00.000Z",
    nextSteps: ["Check LEASE clock"],
    rawChangedFiles: ["packages/shared/src/lease.ts"],
  },
  {
    key: "suffix",
    completedAt: "2026-05-01T11:00:00.000Z",
    nextSteps: ["Suffix follow-up"],
    rawChangedFiles: ["src/lease.ts"],
  },
  {
    key: "directory",
    completedAt: "2026-05-01T12:00:00.000Z",
    nextSteps: ["Directory follow-up"],
    rawChangedFiles: ["Apps/Web/src/App.vue"],
  },
  {
    key: "nested-root",
    completedAt: "2026-05-01T13:00:00.000Z",
    nextSteps: ["Nested root follow-up"],
    rawChangedFiles: ["legacy/apps/web"],
  },
  {
    key: "boundary",
    completedAt: "2026-05-01T14:00:00.000Z",
    nextSteps: ["Boundary miss"],
    // Segment boundaries are literal, and only ASCII letters fold, as SQLite lower() does.
    rawChangedFiles: [
      "apps/webapp/main.ts",
      "packages/shared/src/xlease.ts",
      "old/packages/shared/src/lease.tsx",
      "packages/shared/src/Ärger.ts",
    ],
  },
  {
    key: "renamed",
    completedAt: "2026-05-01T15:00:00.000Z",
    nextSteps: ["Renamed follow-up"],
    changedFileChanges: [
      { path: "packages/shared/src/lease-v2.ts", status: "renamed", previousPath: "packages/shared/src/lease.ts" },
    ],
  },
  {
    key: "title-only",
    completedAt: "2026-05-01T16:00:00.000Z",
    nextSteps: ["Title-only follow-up"],
    title: "Lease planning",
  },
  {
    key: "summary-only",
    completedAt: "2026-05-01T17:00:00.000Z",
    nextSteps: ["Summary-only follow-up"],
    summary: "A neutral record that mentions the lease once.",
  },
  { key: "source-weighted", completedAt: "2026-05-01T18:00:00.000Z", nextSteps: ["Source-weighted follow-up"] },
  {
    key: "excluded",
    completedAt: "2026-05-01T19:00:00.000Z",
    nextSteps: ["Excluded lease follow-up"],
    rawChangedFiles: ["packages/shared/src/lease.ts"],
  },
  {
    key: "completed",
    completedAt: "2026-05-01T19:30:00.000Z",
    nextSteps: ["Completed lease follow-up"],
    rawChangedFiles: ["packages/shared/src/lease.ts"],
  },
];

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "work-intelligence-related-pending-"));
  tempDirs.push(directory);
  const root = mkdtempSync(join(directory, "project-"));
  const otherRoot = mkdtempSync(join(directory, "other-"));
  const databasePath = join(directory, "work-intelligence.sqlite");
  const store = new WorkIntelligenceStore(databasePath);
  stores.push(store);
  const project = store.addProject("Related pending fixture", root);
  const other = store.addProject("Related pending neighbour", otherRoot);
  store.updateProject(project.id, { status: "tracked" });
  store.updateProject(other.id, { status: "tracked" });

  const sessionIds = new Map<string, string>();
  const finalizeFixture = (projectRoot: string, fixture: SessionFixture) => {
    const result = store.finalizeSession({
      projectRoot,
      idempotencyKey: `related-pending-${fixture.key}`,
      title: fixture.title ?? `Session ${fixture.key}`,
      summary: fixture.summary ?? `Neutral notes for ${fixture.key}.`,
      completedAt: fixture.completedAt,
      changedFiles: [],
      ...(fixture.changedFileChanges ? { changedFileChanges: fixture.changedFileChanges } : {}),
      verification: { status: "passed" },
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: fixture.nextSteps },
    });
    if (result.outcome !== "finalized") throw new Error(`Expected fixture Session ${fixture.key}.`);
    sessionIds.set(fixture.key, result.session.id);
  };
  for (const fixture of SESSIONS) finalizeFixture(root, fixture);
  finalizeFixture(otherRoot, {
    key: "neighbour",
    completedAt: "2026-05-01T20:00:00.000Z",
    nextSteps: ["Neighbour lease follow-up"],
    rawChangedFiles: ["packages/shared/src/lease.ts"],
  });

  const database = new DatabaseSync(databasePath);
  try {
    const update = database.prepare("UPDATE sessions SET changed_files_json = ? WHERE id = ?");
    for (const fixture of [...SESSIONS, { key: "neighbour", rawChangedFiles: ["packages/shared/src/lease.ts"] }]) {
      if (fixture.rawChangedFiles) update.run(JSON.stringify(fixture.rawChangedFiles), sessionIds.get(fixture.key)!);
    }
  } finally {
    database.close();
  }

  const items = new Map<string, OutstandingItem>();
  for (const projectId of [project.id, other.id]) {
    const listed = store.listOutstandingItems({ projectId, pageSize: 0 });
    if (listed.outcome !== "outstanding_items") throw new Error("Expected the fixture items.");
    for (const item of listed.items) items.set(item.text, item);
  }
  store.updateOutstandingItemStatus(items.get("Completed lease follow-up")!.id, "completed");

  const service = (
    store as unknown as {
      outstandingItems: { relatedPending(input: OutstandingItemFocus): { items: OutstandingItem[]; total: number } };
    }
  ).outstandingItems;
  const related = (focus: Omit<OutstandingItemFocus, "excludeSourceSessionId">, projectScoped = true) => {
    const result = service.relatedPending({
      ...(projectScoped ? { projectId: project.id } : {}),
      ...focus,
      excludeSourceSessionId: sessionIds.get("excluded"),
    });
    return { total: result.total, texts: result.items.map((item) => item.text) };
  };
  /** Equal relevance and completion time fall back to the source Session id, descending. */
  const byDescendingSessionId = (...entries: Array<[key: string, texts: string[]]>) =>
    entries
      .sort(([left], [right]) => (sessionIds.get(right)! < sessionIds.get(left)! ? -1 : 1))
      .flatMap(([, texts]) => texts);
  return { related, sessionIds, byDescendingSessionId };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("related pending outstanding items", () => {
  it("scores text, title, summary, source order, and every matching path, then orders ties by recency and id", () => {
    const { related, sessionIds, byDescendingSessionId } = setup();
    expect(
      related({
        task: "lease",
        paths: ["packages/shared/src/lease.ts", "Apps\\Web\\"],
        sourceSessionIds: [sessionIds.get("title-only")!, sessionIds.get("source-weighted")!],
      }),
    ).toEqual({
      total: 11,
      texts: [
        "Two-path follow-up",
        ...byDescendingSessionId(["alpha", ["Tune lease renewal"]], ["bravo", ["Check LEASE clock"]]),
        "Renamed follow-up",
        "Nested root follow-up",
      ],
    });
  });

  it("matches directory prefixes and nested-root suffixes on segment boundaries only", () => {
    const { related } = setup();
    expect(related({ paths: ["apps/web"] })).toEqual({
      total: 3,
      texts: ["Nested root follow-up", "Directory follow-up", "Two-path follow-up"],
    });
    expect(related({ paths: ["packages/shared/src/ärger.ts"] })).toEqual({ total: 0, texts: [] });
  });

  it("matches a shorter stored path as a suffix of the query and keeps item positions within a Session", () => {
    const { related, byDescendingSessionId } = setup();
    expect(related({ paths: ["src/lease.ts"] })).toEqual({
      total: 6,
      texts: [
        "Renamed follow-up",
        "Suffix follow-up",
        ...byDescendingSessionId(
          ["alpha", ["Tune lease renewal", "Plain follow-up alpha"]],
          ["bravo", ["Check LEASE clock"]],
        ),
      ].slice(0, 5),
    });
  });

  it("weights terms by field and recalled sources by their order", () => {
    const { related, sessionIds, byDescendingSessionId } = setup();
    expect(related({ task: "lease" })).toEqual({
      total: 4,
      texts: [
        ...byDescendingSessionId(["alpha", ["Tune lease renewal"]], ["bravo", ["Check LEASE clock"]]),
        "Title-only follow-up",
        "Summary-only follow-up",
      ],
    });
    expect(related({ sourceSessionIds: [sessionIds.get("source-weighted")!, sessionIds.get("title-only")!] })).toEqual({
      total: 2,
      texts: ["Source-weighted follow-up", "Title-only follow-up"],
    });
    expect(related({})).toEqual({ total: 0, texts: [] });
  });

  it("reads every tracked project without a project scope but never the excluded or a terminal item", () => {
    const { related } = setup();
    const result = related({ paths: ["packages/shared/src/lease.ts"] }, false);
    expect(result.total).toBe(7);
    expect(result.texts[0]).toBe("Neighbour lease follow-up");
    expect(result.texts).not.toContain("Excluded lease follow-up");
    expect(result.texts).not.toContain("Completed lease follow-up");
  });
});
