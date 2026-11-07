import { describe, expect, it } from "vitest";
import { isSupportedNodeVersion, SUPPORTED_NODE_RANGE } from "../../packages/shared/src/index.js";
import { satisfiesNodeRange } from "../../scripts/standalone/node-range.mjs";

describe("standalone Node.js range check", () => {
  it("agrees with the shared rule on the supported range, including the 23.x gap", () => {
    // Versions probed on GitHub Actions for FTS5, plus the edges of each comparator.
    const versions = ["22.12.0", "22.15.0", "22.16.0", "v22.22.0", "22.99.0", "23.0.0", "23.11.0", "24.0.0", "26.13.0"];
    expect(versions.map((version) => satisfiesNodeRange(SUPPORTED_NODE_RANGE, version))).toEqual(
      versions.map(isSupportedNodeVersion),
    );
  });

  it("reads partial bounds and lets an unreadable range or version through", () => {
    expect(satisfiesNodeRange(">=22.16.0 <23", "22.16.0")).toBe(true);
    expect(satisfiesNodeRange(">=22.16.0 <23", "23.0.0")).toBe(false);
    expect(satisfiesNodeRange("^22.16.0", "21.0.0")).toBe(true);
    expect(satisfiesNodeRange(SUPPORTED_NODE_RANGE, "nightly")).toBe(true);
  });
});
