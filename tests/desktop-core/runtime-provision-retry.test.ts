/// <reference path="../../apps/desktop/src/main/build-flags.d.ts" />
import { describe, expect, it } from "vitest";
import { worthRetrying } from "../../apps/desktop/src/main/runtime-provision.js";

describe("whether a runtime cleanup that left something is tried again while the App runs (L-12)", () => {
  it("does not retry runtimes that only wait for their grace period", () => {
    expect(worthRetrying({ deferred: [{ name: "old-1", reason: "retired-recently" }], failed: [] })).toBe(false);
  });

  it("retries a runtime whose lease may still be live, or one that could not be removed", () => {
    expect(worthRetrying({ deferred: [{ name: "old-1", reason: "live-lease" }], failed: [] })).toBe(true);
    expect(
      worthRetrying({
        deferred: [
          { name: "old-1", reason: "retired-recently" },
          { name: "old-2", reason: "live-lease" },
        ],
        failed: [],
      }),
    ).toBe(true);
    expect(worthRetrying({ deferred: [], failed: ["old-1"] })).toBe(true);
  });

  it("has nothing to retry when nothing was left", () => {
    expect(worthRetrying({ deferred: [], failed: [] })).toBe(false);
  });
});
