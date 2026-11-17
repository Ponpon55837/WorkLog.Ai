import { describe, expect, it } from "vitest";
import {
  chosenPathProblem,
  runSetupStart,
  type SetupStartDeps,
  type SetupStartInput,
} from "../../packages/desktop-core/src/shell/setup-start.js";
import type { DatabasePreviewResult } from "../../packages/desktop-core/src/backend/backend-supervisor.js";

const DB = "/home/tester/data/wi.db";
const IDENTITY = {
  realPath: DB,
  fileId: { device: "1", inode: "2" },
  lineageId: "lineage-1",
  databaseId: "db-1",
} as never;

function created(): DatabasePreviewResult {
  return {
    outcome: "checked",
    preflight: { status: "ok", identity: IDENTITY, schemaVersion: 1, projectCount: 0, projectNames: [] },
  } as unknown as DatabasePreviewResult;
}

function harness(overrides: Partial<SetupStartDeps> = {}) {
  const events: string[] = [];
  const deps: SetupStartDeps = {
    nothingExistsAt: () => true,
    legacyBlocks: () => Promise.resolve(false),
    allowLegacy: () => events.push("allow"),
    prepareRuntime: () => Promise.resolve(),
    missingParentDirectories: () => ["/home/tester/data"],
    createDatabase: () => {
      events.push("create");
      return Promise.resolve(created());
    },
    removeCreatedDatabase: () => {
      events.push("remove-db");
      return true;
    },
    removeEmptyDirectories: () => events.push("remove-dirs"),
    stageSettings: () => events.push("stage"),
    start: () => {
      events.push("start");
      return Promise.resolve({ ok: true });
    },
    stopBackend: () => {
      events.push("stop");
      return Promise.resolve();
    },
    commit: () => {
      events.push("commit");
      return Promise.resolve();
    },
    createdOverride: (path) => ({ path }),
    log: (line) => events.push(`log:${line}`),
    ...overrides,
  };
  return { events, deps };
}

const defaults: SetupStartInput = { databasePath: DB, override: undefined, createNew: true, startAnyway: false };
const steps = (events: string[]) => events.filter((event) => !event.startsWith("log:"));

describe("runSetupStart", () => {
  it("creates, starts and commits on the happy path", async () => {
    const { events, deps } = harness();
    expect(await runSetupStart(defaults, deps)).toEqual({ kind: "started" });
    expect(steps(events)).toEqual(["stage", "create", "start", "commit"]);
  });

  it("creates nothing when the old login service holds the start back", async () => {
    const { events, deps } = harness({ legacyBlocks: () => Promise.resolve(true) });
    expect(await runSetupStart(defaults, deps)).toEqual({ kind: "held-back" });
    expect(steps(events)).toEqual(["stage"]);
  });

  it("does not create a database that already exists", async () => {
    const { events, deps } = harness({ nothingExistsAt: () => false });
    await runSetupStart(defaults, deps);
    expect(steps(events)).toEqual(["stage", "start", "commit"]);
  });

  it("takes back the database it created when the backend does not start", async () => {
    const { events, deps } = harness({ start: () => Promise.resolve({ ok: false, code: "PORT_OCCUPIED_BY_OTHER" }) });
    expect(await runSetupStart(defaults, deps)).toEqual({ kind: "failed", errorCode: "PORT_OCCUPIED_BY_OTHER" });
    expect(steps(events)).toEqual(["stage", "create", "remove-db"]);
  });

  it("maps a busy start and a start the old service held back", async () => {
    const busy = harness({ start: () => Promise.resolve({ ok: false, busy: true }) });
    expect(await runSetupStart(defaults, busy.deps)).toEqual({ kind: "busy" });
    const held = harness({ start: () => Promise.resolve({ ok: false, code: "LEGACY_SERVICE_ACTIVE" }) });
    expect(await runSetupStart(defaults, held.deps)).toEqual({ kind: "held-back" });
    expect(steps(held.events)).toContain("remove-db");
  });

  it("removes the folders and reports the code when the new database cannot be created", async () => {
    const { events, deps } = harness({
      createDatabase: () =>
        Promise.resolve({ outcome: "failed", code: "DB_PERMISSION" } as unknown as DatabasePreviewResult),
    });
    expect(await runSetupStart(defaults, deps)).toEqual({ kind: "failed", errorCode: "DB_PERMISSION" });
    expect(steps(events)).toEqual(["stage", "remove-dirs"]);
  });

  it("an exception from the runtime preparation fails the start and leaves nothing behind", async () => {
    const { events, deps } = harness({
      prepareRuntime: () => Promise.reject(Object.assign(new Error("boom"), { code: "RUNTIME_INSTALL_FAILED" })),
    });
    expect(await runSetupStart(defaults, deps)).toEqual({ kind: "failed", errorCode: "RUNTIME_INSTALL_FAILED" });
    expect(steps(events)).toEqual(["stage"]);
  });

  it("an exception from the backend start removes the created database", async () => {
    const { events, deps } = harness({ start: () => Promise.reject(new Error("spawn failed")) });
    expect(await runSetupStart(defaults, deps)).toEqual({ kind: "failed", errorCode: "REPAIR_REQUIRED" });
    expect(steps(events)).toEqual(["stage", "create", "remove-db"]);
  });

  it("an exception while the settings are written stops the backend and removes the created database", async () => {
    const { events, deps } = harness({ commit: () => Promise.reject(new Error("disk full")) });
    expect(await runSetupStart(defaults, deps)).toEqual({ kind: "failed", errorCode: "REPAIR_REQUIRED" });
    expect(steps(events)).toEqual(["stage", "create", "start", "stop", "remove-db"]);
  });

  it("still removes the created database when stopping the backend fails too", async () => {
    const { events, deps } = harness({
      commit: () => Promise.reject(new Error("disk full")),
      stopBackend: () => Promise.reject(new Error("stuck")),
    });
    expect(await runSetupStart(defaults, deps)).toEqual({ kind: "failed", errorCode: "REPAIR_REQUIRED" });
    expect(steps(events)).toContain("remove-db");
  });

  it("remembers 仍要啟動 before anything else", async () => {
    const { events, deps } = harness();
    await runSetupStart({ ...defaults, startAnyway: true }, deps);
    expect(steps(events)[0]).toBe("allow");
  });
});

describe("chosenPathProblem", () => {
  it("refuses a network share and a device path with the reason in the page's language", () => {
    expect(chosenPathProblem("\\\\server\\share\\wi.db", "win32", "zh-TW")).toContain("網路共用");
    expect(chosenPathProblem("\\\\server\\share\\wi.db", "win32", "en")).toContain("Network share");
    expect(chosenPathProblem("\\\\?\\C:\\wi.db", "win32", "en")).toContain("Device paths");
  });

  it("lets a local absolute path through", () => {
    expect(chosenPathProblem("C:\\Users\\tester\\wi.db", "win32", "en")).toBeUndefined();
    expect(chosenPathProblem("/home/tester/wi.db", "linux", "en")).toBeUndefined();
  });
});
