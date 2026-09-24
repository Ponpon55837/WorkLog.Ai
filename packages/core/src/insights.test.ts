import { describe, expect, it } from "vitest";
import { INSIGHT_AVAILABILITIES, NOOP_INSIGHT_PROVIDER_DESCRIPTOR, NoopInsightProvider } from "./insights.js";

describe("InsightProvider contracts", () => {
  it("keeps the frozen availability values stable", () => {
    expect(INSIGHT_AVAILABILITIES).toEqual(["available", "disabled", "policy_denied", "failed", "budget_exceeded"]);
  });

  it("provides a local no-op provider without derived signals", async () => {
    const provider = new NoopInsightProvider();
    const evaluation = await provider.evaluate({
      state: { summary: "must not be sent anywhere" },
      questions: {
        meaningful: { type: "noul", instructions: "Is this meaningful?" },
      },
    });

    expect(provider.descriptor).toEqual(NOOP_INSIGHT_PROVIDER_DESCRIPTOR);
    expect(provider.descriptor.execution).toBe("local");
    expect(evaluation).toMatchObject({
      provider: "noop",
      model: "none",
      results: {},
      latencyMs: 0,
    });
    expect(Number.isNaN(Date.parse(evaluation.evaluatedAt))).toBe(false);
  });
});
