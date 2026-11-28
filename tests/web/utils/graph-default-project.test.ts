import { describe, expect, it } from "vitest";
import { latestTrackedProjectId } from "../../../apps/web/src/utils/graph-default-project.js";

const projects = [
  { id: "old", lastIngestedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
  { id: "fresh", lastIngestedAt: "2026-03-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" },
  { id: "never", lastIngestedAt: undefined, updatedAt: "2026-02-15T00:00:00Z" },
];

describe("latestTrackedProjectId", () => {
  it("picks the project of the newest Session among tracked projects", () => {
    expect(
      latestTrackedProjectId([{ projectId: "paused" }, { projectId: "old" }, { projectId: "fresh" }], projects),
    ).toBe("old");
  });

  it("falls back to the project ingested last, using the update time when it was never ingested", () => {
    expect(latestTrackedProjectId([], projects)).toBe("fresh");
    expect(latestTrackedProjectId([{ projectId: "paused" }], projects.slice(0, 1).concat(projects.slice(2)))).toBe(
      "never",
    );
  });

  it("returns nothing without tracked projects", () => {
    expect(latestTrackedProjectId([{ projectId: "paused" }], [])).toBeUndefined();
  });
});
