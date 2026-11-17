import { describe, expect, it } from "vitest";
import { createSetupMemory } from "../../apps/desktop/src/renderer/repair/setup-memory.js";

describe("the first-run page memory", () => {
  it("keeps a ticked migration consent and the opened 進階 across renders", () => {
    const memory = createSetupMemory();
    expect(memory.consent("a")).toBe(false);
    expect(memory.advancedOpen()).toBe(false);
    memory.setConsent("a", true);
    memory.setAdvancedOpen(true);
    memory.keepConsentFor(["a", "b"]);
    expect(memory.consent("a")).toBe(true);
    expect(memory.advancedOpen()).toBe(true);
  });

  it("forgets the consent of a source that is no longer listed", () => {
    const memory = createSetupMemory();
    memory.setConsent("gone", true);
    memory.keepConsentFor(["other"]);
    expect(memory.consent("gone")).toBe(false);
  });

  it("an unticked box stays unticked", () => {
    const memory = createSetupMemory();
    memory.setConsent("a", true);
    memory.setConsent("a", false);
    expect(memory.consent("a")).toBe(false);
  });
});
