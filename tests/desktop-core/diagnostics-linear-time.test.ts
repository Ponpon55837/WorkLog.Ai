import { describe, expect, it } from "vitest";
import { buildDiagnostics, createRedactor, scanText } from "../../packages/desktop-core/src/index.js";
import { bestOfMs, doublingGrowth, scaledLimit } from "../helpers/timing.js";
import { adversarialShapes } from "./diagnostics-shapes.js";

const FULL_LENGTH = 200_000;
const HALF_LENGTH = FULL_LENGTH / 2;
const MAX_MILLISECONDS = 200;
// Like the other linear-time tests: the limit is for an ordinary machine and follows how slow a realistic text of the
// same size runs here; a quadratic pattern costs seconds on its shape while the realistic text does not move.
const REFERENCE_BUDGET_MS = 40;
const REFERENCE_TEXT = "[shell] runtime already-current rt-1 in 12 ms; backend started pid=100 port=3210 ".repeat(
  Math.ceil(FULL_LENGTH / 80),
);
const TEST_TIMEOUT_MS = 90_000;
const MAX_DOUBLING_RATIO = 3.2;
const RATIO_BASELINE_FLOOR_MS = 10;

const redact = createRedactor({ platform: "linux", homeDirectory: "/synthetic/home/me", userName: "me" });
const redactWindows = createRedactor({ platform: "win32", homeDirectory: "C:\\Users\\Me", userName: "Me" });

function build(text: string): void {
  buildDiagnostics({
    platform: "linux",
    homeDirectory: "/synthetic/home/me",
    userName: "me",
    appVersion: "1.0.0",
    arch: "x64",
    locale: "en-US",
    owner: "MANAGED",
    backend: "running",
    databaseStatus: "ok",
    recentErrors: [],
    lastBackup: { status: "none" },
    generatedAt: new Date(Date.UTC(2026, 0, 1)),
    recentOutput: [`[shell] ${text}`],
  });
}

describe("diagnostics linear time", () => {
  it(
    "redacts, scans and builds 200,000 characters of every adversarial shape quickly",
    () => {
      const { limitMs } = scaledLimit({
        limitMs: MAX_MILLISECONDS,
        reference: () => build(REFERENCE_TEXT),
        referenceBudgetMs: REFERENCE_BUDGET_MS,
      });
      for (const [shape, input] of Object.entries(adversarialShapes(FULL_LENGTH))) {
        expect(input.length, shape).toBeGreaterThanOrEqual(FULL_LENGTH - 1);
        expect(
          bestOfMs(() => redact(input)),
          `redact: ${shape}`,
        ).toBeLessThan(limitMs);
        expect(
          bestOfMs(() => redactWindows(input)),
          `redact (Windows): ${shape}`,
        ).toBeLessThan(limitMs);
        expect(
          bestOfMs(() => scanText(input)),
          `scan: ${shape}`,
        ).toBeLessThan(limitMs);
        expect(
          bestOfMs(() => build(input)),
          `build: ${shape}`,
        ).toBeLessThan(limitMs * 2);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "takes about twice as long when the input doubles",
    () => {
      const half = adversarialShapes(HALF_LENGTH);
      const full = adversarialShapes(FULL_LENGTH);
      for (const shape of Object.keys(full)) {
        const { smallMs, largeMs } = doublingGrowth({
          small: () => build(half[shape] ?? ""),
          large: () => build(full[shape] ?? ""),
          floorMs: RATIO_BASELINE_FLOOR_MS,
          withinLimit: (small, large) => large < small * MAX_DOUBLING_RATIO,
        });
        expect(largeMs, shape).toBeLessThan(smallMs * MAX_DOUBLING_RATIO);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
