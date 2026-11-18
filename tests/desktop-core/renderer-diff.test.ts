import { describe, expect, it } from "vitest";
import { createChangeTracker, stableKey } from "../../apps/desktop/src/renderer/repair/diff.js";

describe("the poll's change key", () => {
  it("does not depend on the order of an object's fields, at any depth", () => {
    expect(stableKey({ a: 1, b: { c: 2, d: [3, { e: 4, f: 5 }] } })).toBe(
      stableKey({ b: { d: [3, { f: 5, e: 4 }], c: 2 }, a: 1 }),
    );
  });

  it("keeps the order of an array, since it is part of what is shown", () => {
    expect(stableKey([1, 2])).not.toBe(stableKey([2, 1]));
  });

  it("tells a changed value, a new field and a removed field apart", () => {
    const base = stableKey({ a: 1, b: 2 });
    expect(stableKey({ a: 1, b: 3 })).not.toBe(base);
    expect(stableKey({ a: 1, b: 2, c: 0 })).not.toBe(base);
    expect(stableKey({ a: 1 })).not.toBe(base);
  });
});

describe("the change tracker", () => {
  it("says changed the first time, unchanged for an equal input, changed again for a different one", () => {
    const tracker = createChangeTracker();
    expect(tracker.changed("status", { a: 1, b: 2 })).toBe(true);
    expect(tracker.changed("status", { b: 2, a: 1 })).toBe(false);
    expect(tracker.changed("status", { a: 1, b: 3 })).toBe(true);
    expect(tracker.changed("status", { a: 1, b: 3 })).toBe(false);
  });

  it("tracks each section on its own", () => {
    const tracker = createChangeTracker();
    expect(tracker.changed("status", 1)).toBe(true);
    expect(tracker.changed("data", 1)).toBe(true);
    expect(tracker.changed("status", 1)).toBe(false);
    expect(tracker.changed("data", 2)).toBe(true);
    expect(tracker.changed("status", 1)).toBe(false);
  });

  it("forgetting a section makes its next draw count as a change", () => {
    const tracker = createChangeTracker();
    tracker.changed("status", 1);
    tracker.forget("status");
    expect(tracker.changed("status", 1)).toBe(true);
  });
});
