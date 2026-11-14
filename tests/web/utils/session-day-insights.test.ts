import { describe, expect, it } from "vitest";
import type { TimelineResult } from "@work-intelligence/core";
import {
  buildSessionDayInsights,
  localDayOf,
  sessionDayRange,
} from "../../../apps/web/src/utils/session-day-insights.js";

const now = new Date(2030, 9, 20, 15);
const at = (month: number, day: number, hour: number) => new Date(2030, month - 1, day, hour).toISOString();

function timeline(overrides: Partial<Extract<TimelineResult, { outcome: "timeline" }>> = {}): TimelineResult {
  return {
    outcome: "timeline",
    from: "2030-10-01",
    to: "2030-10-20",
    projects: [],
    sessions: [],
    knowledgeEvents: [],
    links: [],
    truncated: false,
    ...overrides,
  };
}

describe("session day insights", () => {
  it("covers the page's days plus a week of lookahead, never past today", () => {
    expect(sessionDayRange([at(10, 8, 9), at(10, 5, 9)], now)).toEqual({ from: "2030-10-05", to: "2030-10-15" });
    expect(sessionDayRange([at(10, 18, 9), at(10, 19, 9)], now)).toEqual({ from: "2030-10-18", to: "2030-10-20" });
    expect(sessionDayRange([], now)).toBeNull();
  });

  it("gives up when the page spans more than the API allows", () => {
    expect(sessionDayRange([at(10, 19, 9), new Date(2028, 0, 1).toISOString()], now)).toBeNull();
  });

  it("counts whole days and created Knowledge per Session", () => {
    const result = timeline({
      sessions: [
        { id: "a", projectId: "p", title: "A", completedAt: at(10, 8, 9), verificationStatus: "passed" },
        { id: "b", projectId: "p", title: "B", completedAt: at(10, 8, 11), verificationStatus: "failed" },
        { id: "c", projectId: "p", title: "C", completedAt: at(10, 7, 11), verificationStatus: "not_supplied" },
      ],
      knowledgeEvents: [
        { knowledgeId: "k1", projectId: "p", title: "K1", kind: "created", at: at(10, 8, 10), sessionId: "a" },
        { knowledgeId: "k2", projectId: "p", title: "K2", kind: "created", at: at(10, 8, 10), sessionId: "a" },
        { knowledgeId: "k3", projectId: "p", title: "K3", kind: "confirmed", at: at(10, 8, 10), sessionId: "b" },
        { knowledgeId: "k4", projectId: "p", title: "K4", kind: "created", at: at(10, 8, 10) },
      ],
    });
    const insights = buildSessionDayInsights(result)!;
    expect(insights.days.get(localDayOf(at(10, 8, 9)))).toEqual({ total: 2, passed: 1, failed: 1 });
    expect(insights.days.get(localDayOf(at(10, 7, 11)))).toEqual({ total: 1, passed: 0, failed: 0 });
    expect([...insights.createdBySession]).toEqual([["a", 2]]);
  });

  it("returns nothing for a truncated, skipped or missing timeline", () => {
    expect(buildSessionDayInsights(timeline({ truncated: true }))).toBeNull();
    expect(buildSessionDayInsights(undefined)).toBeNull();
    expect(
      buildSessionDayInsights({ outcome: "skipped", projectRoot: "x", projectStatus: "ignored", reason: "r" } as never),
    ).toBeNull();
  });
});
