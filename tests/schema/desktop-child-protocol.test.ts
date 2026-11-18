import { describe, expect, it } from "vitest";
import {
  DESKTOP_BACKEND_ERROR_CODES,
  DESKTOP_CHILD_PROTOCOL_VERSION,
  parseDesktopChildMessage,
  parseDesktopParentMessage,
} from "../../packages/schema/src/index.js";

// Fictional values only.
const RUN_ID = "r".repeat(43);
const IDENTITY = {
  realPath: "/synthetic/work.sqlite",
  fileId: { device: "7", inode: "42" },
  lineageId: "a".repeat(64),
};
const READY = {
  type: "ready",
  protocolVersion: DESKTOP_CHILD_PROTOCOL_VERSION,
  runId: RUN_ID,
  port: 40_123,
  appVersion: "9.9.9",
  schemaVersion: 33,
  databaseIdentity: IDENTITY,
  execPath: "/synthetic/node",
  pid: 4321,
};

describe("parent messages", () => {
  it("accepts preflight, start and shutdown", () => {
    expect(parseDesktopParentMessage({ type: "preflight", path: "/synthetic/work.sqlite" }).ok).toBe(true);
    expect(parseDesktopParentMessage({ type: "shutdown" }).ok).toBe(true);
    expect(
      parseDesktopParentMessage({ type: "preflight", path: "/synthetic/work.sqlite", createIfMissing: true }).ok,
    ).toBe(true);
    expect(parseDesktopParentMessage({ type: "preflight", path: "/synthetic/work.sqlite", quickCheck: true }).ok).toBe(
      true,
    );
    const start = parseDesktopParentMessage({
      type: "start",
      runId: RUN_ID,
      port: 40_123,
      database: { path: "/synthetic/work.sqlite", identity: IDENTITY },
      backupDirectory: "/synthetic/backups",
    });
    expect(start).toMatchObject({ ok: true, message: { type: "start", port: 40_123 } });
  });

  it.each([
    ["an unknown type", { type: "format-disk" }],
    ["a non-object", "start"],
    ["null", null],
    ["a port of zero", { type: "start", runId: RUN_ID, port: 0, database: { path: "/p", identity: IDENTITY } }],
    [
      "a port above 65535",
      { type: "start", runId: RUN_ID, port: 65_536, database: { path: "/p", identity: IDENTITY } },
    ],
    ["a short run id", { type: "start", runId: "short", port: 1, database: { path: "/p", identity: IDENTITY } }],
    [
      "a run id with a space",
      { type: "start", runId: `${"a".repeat(30)} b`, port: 1, database: { path: "/p", identity: IDENTITY } },
    ],
    ["an extra field", { type: "shutdown", force: true }],
    ["an empty path", { type: "preflight", path: "" }],
    ["createIfMissing false", { type: "preflight", path: "/p", createIfMissing: false }],
    ["createIfMissing as a string", { type: "preflight", path: "/p", createIfMissing: "true" }],
    ["quickCheck false", { type: "preflight", path: "/p", quickCheck: false }],
    ["quickCheck as a string", { type: "preflight", path: "/p", quickCheck: "true" }],
    ["quickCheck as a number", { type: "preflight", path: "/p", quickCheck: 1 }],
    ["createIfMissing on a start", { type: "shutdown", createIfMissing: true }],
  ])("rejects %s without throwing", (_name, value) => {
    expect(parseDesktopParentMessage(value).ok).toBe(false);
  });

  it("names the failing fields but never echoes a rejected value", () => {
    const result = parseDesktopParentMessage({ type: "preflight", path: "", secret: "hunter2" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("path");
      expect(result.reason).not.toContain("hunter2");
    }
  });
});

describe("child messages", () => {
  it("accepts every message type", () => {
    const messages = [
      { type: "hello", protocolVersion: 1, pid: 10, execPath: "/synthetic/node" },
      {
        type: "preflight-result",
        status: "ok",
        identity: IDENTITY,
        schemaVersion: 33,
        compatibility: "current",
        projectCount: 2,
        sidecars: {
          before: { wal: { exists: false, size: 0 }, shm: { exists: false, size: 0 } },
          after: { wal: { exists: false, size: 0 }, shm: { exists: false, size: 0 } },
        },
      },
      { type: "preflight-result", status: "missing", detail: "ENOENT" },
      READY,
      { type: "failed", code: "DB_MISSING", detail: "the database file is missing" },
      { type: "stopped" },
      { type: "backup-completed", at: "2026-03-01T12:00:00.000Z" },
      { type: "backups-changed" },
    ];
    for (const message of messages) expect(parseDesktopChildMessage(message).ok).toBe(true);
  });

  it("accepts a ready message with or without a project count", () => {
    expect(parseDesktopChildMessage(READY)).toMatchObject({ ok: true });
    expect(parseDesktopChildMessage({ ...READY, projectCount: 0 })).toMatchObject({
      ok: true,
      message: { projectCount: 0 },
    });
    expect(parseDesktopChildMessage({ ...READY, projectCount: 12 }).ok).toBe(true);
  });

  it.each([-1, 1.5, "3", null])("refuses a ready message whose project count is %j", (projectCount) => {
    expect(parseDesktopChildMessage({ ...READY, projectCount }).ok).toBe(false);
  });

  it("keeps a protocol version it does not support parseable so the parent can report it", () => {
    expect(parseDesktopChildMessage({ ...READY, protocolVersion: 2 })).toMatchObject({ ok: true });
  });

  it.each([
    ["an unknown error code", { type: "failed", code: "SOMETHING_ELSE", detail: "x" }],
    ["an unknown preflight status", { type: "preflight-result", status: "weird" }],
    ["a malformed identity", { ...READY, databaseIdentity: { ...IDENTITY, lineageId: "not-hex" } }],
    ["a missing pid", { type: "hello", protocolVersion: 1, execPath: "/p" }],
    ["a negative pid", { type: "hello", protocolVersion: 1, pid: -1, execPath: "/p" }],
    ["an oversized detail", { type: "failed", code: "DB_MISSING", detail: "x".repeat(2001) }],
    ["a backup report without a valid instant", { type: "backup-completed", at: "yesterday" }],
    ["a backup report with extra fields", { type: "backup-completed", at: "2026-03-01T12:00:00Z", path: "/x" }],
    ["a backups-changed event with extra fields", { type: "backups-changed", path: "/x" }],
    ["an unknown type", { type: "ping" }],
    ["an array", [READY]],
  ])("rejects %s", (_name, value) => {
    expect(parseDesktopChildMessage(value).ok).toBe(false);
  });
});

describe("desktop facts and open-agent-setup", () => {
  const START = {
    type: "start",
    runId: RUN_ID,
    port: 40_123,
    database: { path: "/synthetic/work.sqlite", identity: IDENTITY },
  };
  const LEGACY = { running: "running", removeCommand: "synthetic remove", fallbackRemoveCommand: "synthetic fallback" };

  it("accepts start with or without the optional desktop facts", () => {
    expect(parseDesktopParentMessage(START).ok).toBe(true);
    expect(parseDesktopParentMessage({ ...START, desktop: {} }).ok).toBe(true);
    expect(parseDesktopParentMessage({ ...START, desktop: { legacyService: LEGACY } })).toMatchObject({
      ok: true,
      message: { desktop: { legacyService: LEGACY } },
    });
    const withoutRemove = { running: "unknown", fallbackRemoveCommand: "synthetic fallback" };
    expect(parseDesktopParentMessage({ ...START, desktop: { legacyService: withoutRemove } }).ok).toBe(true);
  });

  it("rejects unknown or malformed desktop facts", () => {
    expect(parseDesktopParentMessage({ ...START, desktop: { other: true } }).ok).toBe(false);
    expect(parseDesktopParentMessage({ ...START, desktop: { legacyService: { ...LEGACY, running: "yes" } } }).ok).toBe(
      false,
    );
    expect(parseDesktopParentMessage({ ...START, desktop: { legacyService: { running: "running" } } }).ok).toBe(false);
    expect(
      parseDesktopParentMessage({
        ...START,
        desktop: { legacyService: { ...LEGACY, fallbackRemoveCommand: "x".repeat(4097) } },
      }).ok,
    ).toBe(false);
  });

  it("accepts a bare open-agent-setup from the child and rejects extra fields", () => {
    expect(parseDesktopChildMessage({ type: "open-agent-setup" }).ok).toBe(true);
    expect(parseDesktopChildMessage({ type: "open-agent-setup", path: "/synthetic" }).ok).toBe(false);
  });
});

describe("activity reply", () => {
  const base = { type: "activity", requestId: "request-1", busy: ["import", "backup"] };

  it("accepts the busy kinds with or without the idle import preview flag", () => {
    expect(parseDesktopChildMessage(base).ok).toBe(true);
    expect(parseDesktopChildMessage({ ...base, pendingImport: true }).ok).toBe(true);
    expect(parseDesktopChildMessage({ ...base, busy: [], pendingImport: false }).ok).toBe(true);
  });

  it("rejects a preview that is named as a busy kind, a malformed flag and unknown fields", () => {
    expect(parseDesktopChildMessage({ ...base, busy: ["import-pending"] }).ok).toBe(false);
    expect(parseDesktopChildMessage({ ...base, pendingImport: "yes" }).ok).toBe(false);
    expect(parseDesktopChildMessage({ ...base, pendingImport: true, path: "/synthetic" }).ok).toBe(false);
  });
});

describe("error codes", () => {
  it("lists every R4 section 8.1 backend code once", () => {
    expect(new Set(DESKTOP_BACKEND_ERROR_CODES).size).toBe(DESKTOP_BACKEND_ERROR_CODES.length);
    for (const code of [
      "DB_MISSING",
      "DB_OFFLINE",
      "DB_PERMISSION",
      "SCHEMA_TOO_NEW",
      "PORT_OCCUPIED_BY_OTHER",
      "REPAIR_REQUIRED",
    ]) {
      expect(DESKTOP_BACKEND_ERROR_CODES).toContain(code);
    }
  });
});
