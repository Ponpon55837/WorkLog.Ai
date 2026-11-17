import { describe, expect, it, vi } from "vitest";
import {
  DesktopChild,
  type DesktopChildDependencies,
  type DesktopChildHost,
} from "../../apps/server/src/desktop-child.js";
import type { StartedApi } from "../../apps/server/src/start-api.js";

// DT-08 messages of the desktop child with a fake host: `update-facts` and `copy-database`. Fictional values only.
const RUN_ID = "synthetic-run-id-0123456789abcdef-storage";
const IDENTITY = { realPath: "/synthetic/work.sqlite", fileId: { device: "1", inode: "2" }, lineageId: "b".repeat(64) };
const START = {
  type: "start",
  runId: RUN_ID,
  port: 43_211,
  database: { path: "/synthetic/work.sqlite", identity: IDENTITY },
};

function setup(overrides: Partial<DesktopChildDependencies> = {}) {
  const sent: Record<string, unknown>[] = [];
  const logs: string[] = [];
  const host: DesktopChildHost = {
    pid: 778,
    execPath: "/synthetic/node",
    send: (message, done) => {
      sent.push(message as unknown as Record<string, unknown>);
      done();
    },
    onMessage: () => undefined,
    onDisconnect: () => undefined,
    onSignal: () => undefined,
    exit: () => undefined,
    log: (line) => logs.push(line),
  };
  const startApi = vi.fn((_options?: unknown): StartedApi => ({
    listening: Promise.resolve({ port: START.port, databaseIdentity: IDENTITY }),
    shutdown: async () => undefined,
    activity: () => [],
  }));
  const dependencies: DesktopChildDependencies = {
    preflight: async () => ({ status: "ok", identity: IDENTITY, schemaVersion: 33 }),
    probePort: async () => ({ free: true }),
    startApi: startApi as unknown as DesktopChildDependencies["startApi"],
    ...overrides,
  };
  const child = new DesktopChild(host, dependencies);
  child.begin();
  return { child, sent, logs, startApi };
}

describe("update-facts", () => {
  it("replaces the facts the running backend's status endpoint reads, keeping nothing of the old ones", async () => {
    const { child, startApi } = setup();
    const legacyService = { running: "running", fallbackRemoveCommand: "synthetic fallback" };
    await child.handle({ ...START, desktop: { legacyService, activePort: 43_211 } });
    const options = startApi.mock.calls[0]?.[0] as unknown as { desktop: { getFacts: () => unknown } };
    expect(options.desktop.getFacts()).toEqual({ legacyService, activePort: 43_211 });

    const next = { legacyService, activePort: 43_211, storageRisk: { risk: "removable", migrationBlocked: true } };
    await child.handle({ type: "update-facts", desktop: next });

    expect(options.desktop.getFacts()).toEqual(next);
    await child.handle({ type: "update-facts", desktop: { activePort: 43_211 } });
    expect(options.desktop.getFacts()).toEqual({ activePort: 43_211 });
  });

  it("drops an update-facts message that is not valid", async () => {
    const { child, logs } = setup();
    await child.handle({ type: "update-facts", desktop: { storageRisk: { risk: "bogus", migrationBlocked: true } } });
    expect(logs.at(-1)).toContain("dropped a message");
  });
});

describe("copy-database", () => {
  it("answers with the copy's status and identity from the injected copy, for a preview child", async () => {
    const copyDatabase = vi.fn(async () => ({ status: "ok" as const, identity: IDENTITY }));
    const { child, sent } = setup({ copyDatabase });

    await child.handle({ type: "copy-database", source: "/synthetic/a.sqlite", target: "/synthetic/b.sqlite" });

    expect(copyDatabase).toHaveBeenCalledWith("/synthetic/a.sqlite", "/synthetic/b.sqlite");
    expect(sent.at(-1)).toEqual({ type: "copy-result", status: "ok", identity: IDENTITY });
  });

  it.each(["no-space", "target-exists", "integrity-failed", "failed"] as const)(
    "relays %s with its detail",
    async (status) => {
      const { child, sent } = setup({ copyDatabase: async () => ({ status, detail: "synthetic detail" }) });
      await child.handle({ type: "copy-database", source: "/synthetic/a.sqlite", target: "/synthetic/b.sqlite" });
      expect(sent.at(-1)).toEqual({ type: "copy-result", status, detail: "synthetic detail" });
    },
  );

  it("answers failed, with a fixed detail, when the copy throws", async () => {
    const { child, sent } = setup({
      copyDatabase: async () => {
        throw new Error("secret detail at /private/path");
      },
    });
    await child.handle({ type: "copy-database", source: "/synthetic/a.sqlite", target: "/synthetic/b.sqlite" });
    expect(sent.at(-1)).toEqual({ type: "copy-result", status: "failed", detail: "the copy could not be made" });
  });

  it("refuses to copy once it has started serving, and never calls the copy", async () => {
    const copyDatabase = vi.fn();
    const { child, sent, logs } = setup({ copyDatabase });
    await child.handle(START);

    await child.handle({ type: "copy-database", source: "/synthetic/a.sqlite", target: "/synthetic/b.sqlite" });

    expect(copyDatabase).not.toHaveBeenCalled();
    expect(sent.at(-1)).toMatchObject({ type: "copy-result", status: "failed" });
    expect(logs.at(-1)).toContain("not a preview child");
  });

  it("refuses when this build has no copy implementation", async () => {
    const { child, sent } = setup({ copyDatabase: undefined });
    await child.handle({ type: "copy-database", source: "/synthetic/a.sqlite", target: "/synthetic/b.sqlite" });
    expect(sent.at(-1)).toMatchObject({ type: "copy-result", status: "failed" });
  });
});
