import { describe, expect, it } from "vitest";
import {
  metricsOverGate,
  withResamples,
  type PackagedPerfGates,
  type PackagedPerfSamples,
} from "../../apps/desktop/tests/packaged-smoke/packaged-perf-gates.js";

const GATES: PackagedPerfGates = {
  firstStartMs: 100,
  firstStartAclMs: 0,
  firstStartAclPrewarmMs: 0,
  warmStartMs: 50,
  repairWindowMs: 60,
  quitMs: 10,
  idleMemoryBytes: 1_000,
  backendMemoryBytes: 500,
};

function samples(overrides: Partial<PackagedPerfSamples> = {}): PackagedPerfSamples {
  return {
    firstStartMs: [90, 95, 99],
    firstStartAclMs: [0, 0, 0],
    firstStartAclPrewarmMs: [0, 0, 0],
    warmStartMs: [40, 45, 49],
    repairWindowMs: [50, 55, 59],
    quitMs: [5, 6, 7],
    idleMemoryBytes: [900, 950, 990],
    backendMemoryBytes: [400, 450, 490],
    ...overrides,
  };
}

describe("packaged performance re-sampling", () => {
  it("names no metric when every median is inside its gate", () => {
    expect(metricsOverGate(samples(), GATES)).toEqual([]);
  });

  it("gates the median, so one slow sample alone does not miss", () => {
    expect(metricsOverGate(samples({ repairWindowMs: [50, 55, 17_000] }), GATES)).toEqual([]);
  });

  it("names the metrics whose median is above the gate, and only those", () => {
    const slow = samples({ repairWindowMs: [70, 80, 50], quitMs: [11, 12, 1] });
    expect(metricsOverGate(slow, GATES)).toEqual(["repairWindowMs", "quitMs"]);
  });

  it("appends the extra samples of the re-sampled metrics only", () => {
    const first = samples({ repairWindowMs: [70, 80, 50] });
    const extra = samples({ repairWindowMs: [40, 45, 50], quitMs: [99, 99, 99] });
    const combined = withResamples(first, extra, ["repairWindowMs"]);
    expect(combined.repairWindowMs).toEqual([70, 80, 50, 40, 45, 50]);
    expect(combined.quitMs).toEqual(first.quitMs);
  });

  it("gates the median of all samples after a re-sample", () => {
    const first = samples({ repairWindowMs: [70, 80, 50] });
    const recovered = withResamples(first, samples({ repairWindowMs: [40, 45, 50] }), ["repairWindowMs"]);
    expect(metricsOverGate(recovered, GATES)).toEqual([]);
    const stillSlow = withResamples(first, samples({ repairWindowMs: [70, 90, 100] }), ["repairWindowMs"]);
    expect(metricsOverGate(stillSlow, GATES)).toEqual(["repairWindowMs"]);
  });
});
