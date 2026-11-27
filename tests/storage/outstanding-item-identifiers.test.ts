import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { identifiersIn, sharesIdentifier } from "../../packages/storage/src/outstanding-item-relevance.js";
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
