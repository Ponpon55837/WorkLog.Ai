import { describe, expect, it, vi } from "vitest";
import { DatabaseInitializationError, type WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { isTransientStartupFailure, McpStoreAccess } from "../../apps/mcp/src/store-access.js";

function fakeStore(): WorkIntelligenceStore {
  return { close: vi.fn() } as unknown as WorkIntelligenceStore;
}

function failing(code: ConstructorParameters<typeof DatabaseInitializationError>[0]): () => never {
  return () => {
    throw new DatabaseInitializationError(code, `${code} message`);
  };
}

/** A clock the test moves by hand, so retry spacing never depends on wall-clock time. */
function manualClock(): { now: () => number; advance: (ms: number) => void } {
  let current = 1_000_000;
  return { now: () => current, advance: (ms) => (current += ms) };
}

describe("MCP store access", () => {
  it("opens the store once and reuses it", () => {
    const store = fakeStore();
    const open = vi.fn(() => store);
    const access = new McpStoreAccess(open);

    expect(access.startupFailure).toBeUndefined();
    expect(access.resolve()).toEqual({ store });
    expect(access.resolve()).toEqual({ store });
    expect(open).toHaveBeenCalledTimes(1);
    access.close();
    expect(store.close).toHaveBeenCalledTimes(1);
  });

  it("retries a busy startup on a later call and then keeps the opened store", () => {
    const clock = manualClock();
    const store = fakeStore();
    const open = vi.fn<() => WorkIntelligenceStore>().mockImplementationOnce(failing("DATABASE_BUSY"));
    open.mockImplementation(() => store);
    const onFailure = vi.fn();
    const access = new McpStoreAccess(open, { now: clock.now, onFailure });

    expect(access.startupFailure).toEqual({ code: "DATABASE_BUSY", message: "DATABASE_BUSY message" });
    expect(onFailure).toHaveBeenCalledTimes(1);
    clock.advance(1000);
    expect(access.resolve()).toEqual({ store });
    expect(access.resolve()).toEqual({ store });
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("bounds retries to one open attempt per call and per retry interval", () => {
    const clock = manualClock();
    const open = vi.fn(failing("DATABASE_BUSY"));
    const access = new McpStoreAccess(open, { now: clock.now, retryIntervalMs: 1000 });

    for (let call = 0; call < 5; call += 1) {
      expect(access.resolve()).toEqual({ failure: { code: "DATABASE_BUSY", message: "DATABASE_BUSY message" } });
    }
    expect(open).toHaveBeenCalledTimes(1);

    for (let call = 0; call < 3; call += 1) {
      clock.advance(1000);
      access.resolve();
    }
    expect(open).toHaveBeenCalledTimes(4);
  });

  it("retries read-only and disk-full startups, which the user can fix without a restart", () => {
    for (const code of ["DATABASE_READ_ONLY", "DATABASE_DISK_FULL"] as const) {
      const clock = manualClock();
      const store = fakeStore();
      const open = vi.fn<() => WorkIntelligenceStore>().mockImplementationOnce(failing(code));
      open.mockImplementation(() => store);
      const access = new McpStoreAccess(open, { now: clock.now });
      expect(access.startupFailure?.code).toBe(code);
      clock.advance(1000);
      expect(access.resolve()).toEqual({ store });
    }
  });

  it("keeps permanent startup failures until the process restarts", () => {
    for (const code of [
      "DATABASE_SCHEMA_VERSION_TOO_NEW",
      "DATABASE_SCHEMA_VERSION_INVALID",
      "DATABASE_MIGRATION_FAILED",
      "DATABASE_MIGRATION_BACKUP_FAILED",
    ] as const) {
      const clock = manualClock();
      const open = vi.fn(failing(code));
      const access = new McpStoreAccess(open, { now: clock.now });
      clock.advance(60_000);
      expect(access.resolve()).toEqual({ failure: { code, message: `${code} message` } });
      expect(open).toHaveBeenCalledTimes(1);
      expect(isTransientStartupFailure({ code, message: "" })).toBe(false);
    }
  });

  it("answers an unclassified open failure with fixed text and keeps it", () => {
    const clock = manualClock();
    const open = vi.fn(() => {
      throw new Error("SQLITE_NOTADB: file is not a database at /fiction/private/path.sqlite");
    });
    const access = new McpStoreAccess(open, { now: clock.now });
    clock.advance(60_000);
    const resolution = access.resolve();

    expect(resolution).toEqual({
      failure: {
        code: "DATABASE_INITIALIZATION_FAILED",
        message: "Work Intelligence 資料庫無法開啟，請檢查資料庫檔案、目錄與權限。",
      },
    });
    expect(JSON.stringify(resolution)).not.toMatch(/sqlite|fiction/i);
    expect(open).toHaveBeenCalledTimes(1);
    expect(() => access.close()).not.toThrow();
  });
});
