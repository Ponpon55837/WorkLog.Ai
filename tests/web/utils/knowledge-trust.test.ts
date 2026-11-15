import { describe, expect, it } from "vitest";
import {
  appliesToBreadthNotice,
  knowledgeStaleNotes,
  trustCells,
} from "../../../apps/web/src/utils/knowledge-trust.js";
import { t } from "../../../apps/web/src/i18n/index.js";

const count = (cells: string[], kind: string) => cells.filter((cell) => cell === kind).length;

describe("knowledge trust cells", () => {
  it("draws nothing without feedback, and one cell per count when small", () => {
    expect(trustCells(0, 0)).toEqual([]);
    expect(trustCells(3, 1)).toEqual(["confirmed", "confirmed", "confirmed", "contradicted"]);
  });

  it("scales large counts to the cell limit and keeps a minority visible", () => {
    const cells = trustCells(100, 1);
    expect(cells).toHaveLength(12);
    expect(count(cells, "contradicted")).toBe(1);
    const mostlyContradicted = trustCells(1, 100);
    expect(mostlyContradicted).toHaveLength(12);
    expect(count(mostlyContradicted, "confirmed")).toBe(1);
    expect(trustCells(50, 0)).toHaveLength(12);
  });
});

describe("knowledge stale notes", () => {
  const stale = (reason: "applies_to_changed" | "broad_applies_to", breadth?: { share: number; sessions: number }) => ({
    sessionId: "s1",
    sessionTitle: "Change",
    completedAt: "2026-01-01T00:00:00.000Z",
    paths: ["src/a.ts"],
    sessionCount: 1,
    reason,
    ...(breadth ? { appliesToBreadth: breadth } : {}),
  });

  it("explains a broad appliesTo as a weak signal with rounded percent and sessions", () => {
    const notes = knowledgeStaleNotes({ possiblyStale: stale("broad_applies_to", { share: 0.333, sessions: 12 }) });
    expect(notes.broadAppliesTo).toBe(t("knowledge.broadAppliesToWeakSignal", { sessions: 12, percent: 33 }));
    expect(notes.broadAppliesTo).toContain("33%");
    expect(notes.broadChanges).toBeNull();
  });

  it("adds no weak-signal note for an ordinary applies_to_changed reason", () => {
    expect(knowledgeStaleNotes({ possiblyStale: stale("applies_to_changed") }).broadAppliesTo).toBeNull();
  });

  it("shows the broad change count without any possiblyStale marker", () => {
    const notes = knowledgeStaleNotes({ broadChangesSince: 3 });
    expect(notes.broadChanges).toBe(t("knowledge.broadChangesSince", { count: 3 }));
    expect(notes.broadAppliesTo).toBeNull();
    expect(knowledgeStaleNotes({}).broadChanges).toBeNull();
    expect(knowledgeStaleNotes({ broadChangesSince: 0 }).broadChanges).toBeNull();
  });

  it("builds a save-time notice only when the backend measured the appliesTo as broad", () => {
    expect(appliesToBreadthNotice({ appliesToBreadth: { share: 0.1, sessions: 20, broad: false } })).toBeNull();
    expect(appliesToBreadthNotice({ warnings: ["x"] })).toBeNull();
    expect(
      appliesToBreadthNotice({ warnings: ["x"], appliesToBreadth: { share: 0.1, sessions: 20, broad: false } }),
    ).toBeNull();
    expect(appliesToBreadthNotice({ appliesToBreadth: { share: 0.4, sessions: 20, broad: true } })).toContain("40%");
  });
});
