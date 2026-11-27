import { describe, expect, it } from "vitest";
import type { AttentionItem } from "../../../packages/core/src/index.js";
import {
  attentionGroupRoute,
  attentionSourceRoute,
  attentionRoute,
  groupAttentionItems,
  isWaitingForAgent,
  sharedAttentionReason,
} from "../../../apps/web/src/utils/attention.js";

function item(
  id: string,
  kind: AttentionItem["kind"],
  projectId: string | undefined,
  updatedAt = "2026-11-01T00:00:00Z",
) {
  return {
    id: `${kind}:${id}`,
    kind,
    sourceId: id,
    projectId,
    title: id,
    reason: "pending",
    updatedAt,
    sourceRevision: "revision",
    target: { kind, sourceId: id, projectId },
  } satisfies AttentionItem;
}

describe("groupAttentionItems", () => {
  it("folds same-kind same-project pointers into one group placed where the first one sat", () => {
    const entries = groupAttentionItems([
      item("d1", "decision", "p1"),
      item("o1", "outstanding", "p1"),
      item("d2", "decision", "p1"),
      item("d3", "decision", "p2"),
      item("d4", "decision", "p1"),
    ]);
    expect(entries.map((entry) => (entry.type === "group" ? `group:${entry.group.id}` : entry.item.sourceId))).toEqual([
      "group:decision:p1",
      "o1",
      "d3",
    ]);
    const group = entries[0];
    expect(group?.type === "group" && group.group.items.map((entry) => entry.sourceId)).toEqual(["d1", "d2", "d4"]);
  });

  it("never groups kinds that already stand for a whole project or request, or items without a project", () => {
    const entries = groupAttentionItems([
      item("o1", "outstanding", "p1"),
      item("o2", "outstanding", "p1"),
      item("m1", "metadata", "p1"),
      item("m2", "metadata", "p1"),
      item("d1", "decision", undefined),
      item("d2", "decision", undefined),
    ]);
    expect(entries.every((entry) => entry.type === "item")).toBe(true);
    expect(entries).toHaveLength(6);
  });

  it("keeps a single pointer as a plain row", () => {
    expect(groupAttentionItems([item("k1", "knowledge", "p1")])).toEqual([
      { type: "item", item: item("k1", "knowledge", "p1") },
    ]);
  });
});

describe("isWaitingForAgent", () => {
  const requests = new Map([["p1", "2026-11-02T00:00:00Z"]]);

  it("holds for a decision whose Session finished before the project's open request", () => {
    expect(isWaitingForAgent(item("d1", "decision", "p1", "2026-11-01T00:00:00Z"), requests)).toBe(true);
  });

  it("does not hold for a later decision, another project, or another kind", () => {
    expect(isWaitingForAgent(item("d1", "decision", "p1", "2026-11-03T00:00:00Z"), requests)).toBe(false);
    expect(isWaitingForAgent(item("d1", "decision", "p2"), requests)).toBe(false);
    expect(isWaitingForAgent(item("k1", "knowledge", "p1"), requests)).toBe(false);
    expect(isWaitingForAgent(item("d1", "decision", undefined), requests)).toBe(false);
  });
});

describe("attention routes", () => {
  it("carries the decision id so the target page can find the record", () => {
    expect(attentionRoute(item("d1", "decision", "p1"))).toEqual({
      name: "knowledge",
      params: { tab: "decisions" },
      query: { project: "p1", decision: "d1" },
    });
  });

  it("sends a group to its list page without pointing at one record", () => {
    const [group] = groupAttentionItems([item("d1", "decision", "p1"), item("d2", "decision", "p1")]);
    expect(group?.type === "group" && attentionGroupRoute(group.group)).toEqual({
      name: "knowledge",
      params: { tab: "decisions" },
      query: { project: "p1" },
    });
  });
});

describe("attentionSourceRoute", () => {
  it("points each kind at its own list and keeps the project", () => {
    expect(attentionSourceRoute("decision", "p1")).toEqual({
      name: "knowledge",
      params: { tab: "decisions" },
      query: { project: "p1" },
    });
    expect(attentionSourceRoute("outstanding", "p1")).toMatchObject({ query: { itemProject: "p1" } });
    expect(attentionSourceRoute("synthesis")).toEqual({ name: "reports", query: {} });
  });
});

describe("sharedAttentionReason", () => {
  it("returns the reason every member shares and nothing when they differ", () => {
    const stale = { ...item("k1", "knowledge", "p1"), reason: "stale" as const };
    const review = { ...item("k2", "knowledge", "p1"), reason: "review" as const };
    const group = (items: AttentionItem[]) => ({
      id: "knowledge:p1",
      kind: "knowledge" as const,
      projectId: "p1",
      items,
    });
    expect(sharedAttentionReason(group([stale, { ...stale, id: "knowledge:k3" }]))).toBe("stale");
    expect(sharedAttentionReason(group([stale, review]))).toBeUndefined();
  });
});
