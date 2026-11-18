import { describe, expect, it, vi } from "vitest";
import type { LegacyServiceDetection } from "@work-intelligence/desktop-core";

vi.mock("electron", () => ({ app: { getLoginItemSettings: () => ({ wasOpenedAtLogin: false }) } }));

const { createLegacyGuard } = await import("../../apps/desktop/src/main/legacy.js");

const FOUND: LegacyServiceDetection = {
  kind: "found",
  platform: "win32",
  definitionPath: "C:\\synthetic\\task.xml",
  definitionSource: "file",
  recognised: false,
  running: "running",
};

function guardAnswering(answers: LegacyServiceDetection[]) {
  const calls = { count: 0 };
  const guard = createLegacyGuard({
    platform: "win32",
    environment: {},
    log: () => undefined,
    detect: async () => answers[Math.min(calls.count++, answers.length - 1)] as LegacyServiceDetection,
    launchMode: () => ({ background: false }) as never,
  });
  return { guard, calls };
}

describe("legacy service guard on a query that did not answer", () => {
  it("asks once more at once, and keeps the second answer", async () => {
    const { guard, calls } = guardAnswering([{ kind: "unknown" }, FOUND]);
    expect(await guard.refresh()).toEqual(FOUND);
    expect(calls.count).toBe(2);
  });

  it("does not ask again when the first answer is real", async () => {
    const { guard, calls } = guardAnswering([{ kind: "none" }]);
    expect(await guard.refresh()).toEqual({ kind: "none" });
    expect(calls.count).toBe(1);
  });

  it("keeps the last real answer when a later query stays unanswered", async () => {
    const { guard } = guardAnswering([FOUND, { kind: "unknown" }, { kind: "unknown" }]);
    await guard.refresh();
    expect(await guard.refresh()).toEqual(FOUND);
    expect(guard.latest()).toEqual(FOUND);
  });

  it("reports unknown when it never got a real answer", async () => {
    const { guard } = guardAnswering([{ kind: "unknown" }]);
    expect(await guard.refresh()).toEqual({ kind: "unknown" });
  });
});
