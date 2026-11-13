import { describe, expect, it } from "vitest";
import { SegmentObserver, segmentObserverKey } from "../../apps/mcp/src/segment-observer.js";

// Fictional paths only.
function clock(start: string) {
  let current = Date.parse(start);
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("segment observer", () => {
  it("keeps the first call time per project and ignores later calls", () => {
    const time = clock("2030-01-01T08:00:00.000Z");
    const observer = new SegmentObserver(time.now);

    observer.record("/fiction/alpha", "work_get_context");
    time.advance(60_000);
    observer.record("/fiction/alpha", "work_recall");

    expect(observer.peek("/fiction/alpha")).toEqual({ at: "2030-01-01T08:00:00.000Z", tool: "work_get_context" });
  });

  it("keeps projects independent and normalizes trailing separators", () => {
    const time = clock("2030-01-01T08:00:00.000Z");
    const observer = new SegmentObserver(time.now);

    observer.record("/fiction/alpha/", "work_recall");
    time.advance(1_000);
    observer.record("/fiction/beta", "work_search");
    observer.reset("/fiction/alpha");

    expect(segmentObserverKey("/fiction/alpha/")).toBe(segmentObserverKey("/fiction/alpha"));
    expect(observer.peek("/fiction/alpha")).toBeUndefined();
    expect(observer.peek("/fiction/beta")).toMatchObject({ tool: "work_search" });
  });

  it("starts a new segment after a reset", () => {
    const time = clock("2030-01-01T08:00:00.000Z");
    const observer = new SegmentObserver(time.now);
    observer.record("/fiction/alpha", "work_recall");
    observer.reset("/fiction/alpha");
    time.advance(3_600_000);

    observer.record("/fiction/alpha", "work_search");

    expect(observer.peek("/fiction/alpha")).toEqual({ at: "2030-01-01T09:00:00.000Z", tool: "work_search" });
  });

  it("drops the oldest project when the cap is reached", () => {
    const observer = new SegmentObserver(() => new Date("2030-01-01T08:00:00.000Z"), 2);

    observer.record("/fiction/one", "work_recall");
    observer.record("/fiction/two", "work_recall");
    observer.record("/fiction/three", "work_recall");

    expect(observer.peek("/fiction/one")).toBeUndefined();
    expect(observer.peek("/fiction/two")).toBeDefined();
    expect(observer.peek("/fiction/three")).toBeDefined();
  });

  it("captures the head commit only when a new entry is created, and survives a failing lookup", () => {
    const observer = new SegmentObserver();
    let lookups = 0;
    const head = () => {
      lookups += 1;
      return "a".repeat(40);
    };

    observer.record("/fiction/alpha", "work_get_context", head);
    observer.record("/fiction/alpha", "work_recall", head);
    observer.record("/fiction/beta", "work_recall", () => {
      throw new Error("no repository");
    });
    observer.record("/fiction/gamma", "work_recall");

    expect(lookups).toBe(1);
    expect(observer.peek("/fiction/alpha")?.headCommit).toBe("a".repeat(40));
    expect(observer.peek("/fiction/beta")).toMatchObject({ tool: "work_recall" });
    expect(observer.peek("/fiction/beta")).not.toHaveProperty("headCommit");
    expect(observer.peek("/fiction/gamma")).not.toHaveProperty("headCommit");
  });
});
