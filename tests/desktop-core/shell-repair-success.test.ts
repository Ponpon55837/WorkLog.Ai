import { describe, expect, it, vi } from "vitest";
import {
  buildRepairState,
  celebrateRepair,
  DashboardOpenCounter,
  RecentErrors,
  recordRepairFailure,
  shellMessages,
  shouldCelebrateRepair,
  shouldOpenDashboardAfterRepair,
  type RepairSuccessDeps,
  type RepairSource,
} from "../../packages/desktop-core/src/index.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

function makeDeps(overrides: Partial<RepairSuccessDeps> = {}) {
  const errors = new RecentErrors();
  errors.record("DB_MISSING", NOW);
  errors.record("PORT_OCCUPIED_BY_OTHER", NOW);
  const calls: string[] = [];
  const scheduled: { callback: () => void; ms: number }[] = [];
  let opens = 0;
  const deps: RepairSuccessDeps = {
    errors,
    clearPresenter: () => calls.push("clear-presenter"),
    setRecovered: (recovered) =>
      calls.push(recovered ? `recovered:${recovered.projectCount ?? "none"}` : "recovered:off"),
    notifyRecovered: () => calls.push("notify"),
    schedule: (callback, ms) => scheduled.push({ callback, ms }),
    closeWindow: () => calls.push("close"),
    openDashboard: () => {
      opens += 1;
      calls.push("open");
    },
    dashboardOpens: () => opens,
    delayMs: 1500,
    ...overrides,
  };
  return { deps, errors, calls, scheduled, openedElsewhere: () => (opens += 1) };
}

describe("shouldCelebrateRepair", () => {
  it("celebrates only a user-started repair that ended running and managed", () => {
    const base = { ok: true, owner: "MANAGED", backend: "running" } as const;
    expect(shouldCelebrateRepair({ ...base, source: "user" })).toBe(true);
  });

  it.each<RepairSource>(["automatic", "startup"])("never celebrates a %s start", (source) => {
    expect(shouldCelebrateRepair({ source, ok: true, owner: "MANAGED", backend: "running" })).toBe(false);
  });

  it("does not celebrate a failure or a backend that is not running under the managed owner", () => {
    expect(shouldCelebrateRepair({ source: "user", ok: false, owner: "NEEDS_REPAIR", backend: "stopped" })).toBe(false);
    expect(shouldCelebrateRepair({ source: "user", ok: true, owner: "NEEDS_REPAIR", backend: "running" })).toBe(false);
    expect(shouldCelebrateRepair({ source: "user", ok: true, owner: "MANAGED", backend: "starting" })).toBe(false);
  });
});

describe("celebrateRepair", () => {
  it("clears stale errors, shows the card, notifies, then closes the window and opens the Dashboard once", () => {
    const { deps, errors, calls, scheduled } = makeDeps();

    celebrateRepair(deps, { projectCount: 3 }, 0);

    expect(errors.list()).toEqual([]);
    expect(calls).toEqual(["clear-presenter", "recovered:3", "notify"]);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.ms).toBe(1500);

    scheduled[0]?.callback();
    expect(calls.slice(3)).toEqual(["recovered:off", "close", "open"]);
  });

  it("passes a missing project count through as absent", () => {
    const { deps, calls } = makeDeps();
    celebrateRepair(deps, {}, 0);
    expect(calls).toContain("recovered:none");
  });

  it("does not open the Dashboard again when a pending request already opened it", () => {
    const { deps, calls, scheduled, openedElsewhere } = makeDeps();
    celebrateRepair(deps, {}, 0);
    openedElsewhere();

    scheduled[0]?.callback();

    expect(calls).toEqual(["clear-presenter", "recovered:none", "notify", "recovered:off", "close"]);
  });

  it("ignores a notification that throws", () => {
    const notifyRecovered = vi.fn(() => {
      throw new Error("not supported");
    });
    const { deps, calls, scheduled } = makeDeps({ notifyRecovered });

    expect(() => celebrateRepair(deps, {}, 0)).not.toThrow();
    scheduled[0]?.callback();

    expect(calls).toContain("open");
  });
});

describe("the dashboard open counter", () => {
  it("opens only when nothing opened it since the repair began", () => {
    const counter = new DashboardOpenCounter();
    const before = counter.count;
    expect(shouldOpenDashboardAfterRepair(before, counter.count)).toBe(true);
    counter.mark();
    expect(shouldOpenDashboardAfterRepair(before, counter.count)).toBe(false);
  });
});

describe("recordRepairFailure", () => {
  it("replaces the stale errors with the current one", () => {
    const errors = new RecentErrors();
    errors.record("DB_MISSING", NOW);
    errors.record("PORT_OCCUPIED_BY_OTHER", NOW);

    recordRepairFailure(errors, "DB_PERMISSION", NOW);

    expect(errors.list().map((entry) => entry.code)).toEqual(["DB_PERMISSION"]);
  });
});

describe("the recovered repair state", () => {
  const base = {
    platform: "linux",
    homeDirectory: "/home/synthetic",
    locale: "en",
    owner: "MANAGED",
    backend: "running",
    databasePath: "/home/synthetic/work.sqlite",
    databaseStatus: "ok",
    candidates: [],
    recentErrors: [],
    lastBackup: { status: "none" },
    retryOperationId: "id-1",
    busy: false,
  } as const;

  it("carries the success card with the redacted path and the project count when known", () => {
    const state = buildRepairState({ ...base, recovered: { projectCount: 4 } });
    expect(state.recovered).toEqual({ projectCount: 4 });
    expect(state.database.display).toBe("~/work.sqlite");
  });

  it("has no success card by default", () => {
    expect(buildRepairState(base).recovered).toBeNull();
  });

  it("has the recovered texts in both languages", () => {
    expect(shellMessages("zh-TW").repairRecovered).toBe("✓ 已恢復");
    expect(shellMessages("zh-TW").notifyRecoveredTitle).toBe("Work Intelligence 已可使用");
    expect(shellMessages("en").repairRecovered).toBe("✓ Recovered");
  });
});
