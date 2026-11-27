import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  identifiersIn,
  issueSpansIn,
  sharesIdentifier,
  spansOverlap,
} from "../../packages/storage/src/outstanding-item-relevance.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const roots: string[] = [];
const stores: WorkIntelligenceStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function finalize(
  store: WorkIntelligenceStore,
  root: string,
  key: string,
  completedAt: string,
  fields: { title?: string; summary?: string; outcomes?: string[]; nextSteps?: string[] },
) {
  const result = store.finalizeSession({
    projectRoot: root,
    idempotencyKey: key,
    title: fields.title ?? `Synthetic ${key}`,
    summary: fields.summary ?? `Synthetic ${key} summary.`,
    workSummary: {
      outcomes: fields.outcomes ?? [],
      scope: [],
      decisions: [],
      verification: [],
      nextSteps: fields.nextSteps ?? [],
    },
    changedFiles: [],
    verification: { status: "passed", summary: "Synthetic verification." },
    completedAt,
  });
  if (result.outcome !== "finalized") throw new Error(`Expected finalized; got ${result.outcome}.`);
  return result;
}

describe("identifier extraction", () => {
  it("reads issue references and versions as whole tokens", () => {
    expect([...identifiersIn("Fix #48 and v1.6.87, see /issues/12 and /pull/7")].sort()).toEqual([
      "#12",
      "#48",
      "#7",
      "1.6.87",
    ]);
    expect(identifiersIn("Issue &#48; and abc#9 and 1.2.3.4 and 10.20")).toEqual(new Set());
  });

  it("does not let #48 match #481", () => {
    expect(sharesIdentifier("Verify #481 later", identifiersIn("Closes #48"))).toBe(false);
    expect(sharesIdentifier("Verify #48 later", identifiersIn("Closes #48"))).toBe(true);
    expect(sharesIdentifier("Verify #48", new Set())).toBe(false);
  });
});

describe("issue spans", () => {
  it("reads single references and ranges, and overlaps a referenced number with a range", () => {
    expect(issueSpansIn("#485、#483 之後 #486–#490")).toEqual([
      [485, 485],
      [483, 483],
      [486, 486],
      [490, 490],
      [486, 490],
    ]);
    expect(issueSpansIn("issue #483-490 and #9~#3")).toContainEqual([483, 490]);
    expect(issueSpansIn("issue #483-490 and #9~#3")).not.toContainEqual([9, 3]);
    expect(spansOverlap(issueSpansIn("UX #485"), issueSpansIn("issue #483–#490"))).toBe(true);
    expect(spansOverlap(issueSpansIn("UX #491"), issueSpansIn("issue #483–#490"))).toBe(false);
    expect(spansOverlap(issueSpansIn("#48"), issueSpansIn("#481"))).toBe(false);
    expect(spansOverlap([], issueSpansIn("#48"))).toBe(false);
  });
});

describe("possibleDuplicateOf in the finalize receipt", () => {
  it("lists pending items of the project that share an issue with a stored nextStep first, with its index", () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-duplicates-"));
    roots.push(root);
    const store = new WorkIntelligenceStore(":memory:");
    stores.push(store);
    const project = store.addProject("Duplicate fixture", root);
    store.updateProject(project.id, { status: "tracked" });
    finalize(store, root, "older-source", "2026-05-01T09:00:00.000Z", {
      nextSteps: [
        "Unrelated reminder",
        "#474 read volume work has not started.",
        "UX walkthrough issue #483–#490 by priority.",
      ],
    });

    const result = finalize(store, root, "closing", "2026-05-02T09:00:00.000Z", {
      title: "Plan follow-ups",
      summary: "Planned the next steps for the read volume work.",
      nextSteps: ["Reading volume #474.", "Fix #485 and #483 first, then #484 and #486–#490."],
    });

    const related = result.relatedOutstandingItems;
    expect(related?.items.slice(0, 2).map((item) => [item.text, item.possibleDuplicateOf])).toEqual([
      ["#474 read volume work has not started.", 0],
      ["UX walkthrough issue #483–#490 by priority.", 1],
    ]);
    expect(related?.items.find((item) => item.text === "Unrelated reminder")?.possibleDuplicateOf).toBeUndefined();
    expect(related?.hint).toContain("possibleDuplicateOf");

    const noSteps = finalize(store, root, "no-steps", "2026-05-03T09:00:00.000Z", {
      title: "Read volume",
      summary: "Read volume #474 again.",
    });
    expect(noSteps.relatedOutstandingItems?.items.some((item) => item.possibleDuplicateOf !== undefined)).toBe(false);
    expect(noSteps.relatedOutstandingItems?.hint).not.toContain("possibleDuplicateOf");
  });
});

describe("possiblyDone ranking in the finalize receipt", () => {
  it("ranks pending items sharing an issue or version with this Session first and labels them", () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-identifiers-"));
    roots.push(root);
    const store = new WorkIntelligenceStore(":memory:");
    stores.push(store);
    const project = store.addProject("Identifier fixture", root);
    store.updateProject(project.id, { status: "tracked" });
    finalize(store, root, "older-source", "2026-05-01T09:00:00.000Z", {
      nextSteps: [
        "Unrelated reminder",
        "Check the release notes for v2.3.4",
        "Verify #481 follow-up",
        "Verify #48 follow-up",
      ],
    });

    const result = finalize(store, root, "closing", "2026-05-02T09:00:00.000Z", {
      title: "Ship #48",
      summary: "Closed the work for issue #48.",
      outcomes: ["Released v2.3.4."],
    });

    const items = result.relatedOutstandingItems?.items ?? [];
    expect(
      items
        .map((item) => item.text)
        .slice(0, 2)
        .sort(),
    ).toEqual(["Check the release notes for v2.3.4", "Verify #48 follow-up"]);
    expect(
      items
        .filter((item) => item.possiblyDone)
        .map((item) => item.text)
        .sort(),
    ).toEqual(["Check the release notes for v2.3.4", "Verify #48 follow-up"]);
    expect(items.find((item) => item.text === "Verify #481 follow-up")?.possiblyDone).toBeUndefined();
    expect(items.find((item) => item.text === "Unrelated reminder")?.possiblyDone).toBeUndefined();
  });
});
