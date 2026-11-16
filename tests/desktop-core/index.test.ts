import { describe, expect, it } from "vitest";
import { DESKTOP_CORE_CONTRACT_VERSION } from "../../packages/desktop-core/src/index.js";

describe("desktop-core", () => {
  it("exposes the contract version", () => {
    expect(DESKTOP_CORE_CONTRACT_VERSION).toBe(1);
  });
});
