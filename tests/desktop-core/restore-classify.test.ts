import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_LEASE_MAX_AGE_MS,
  REPAIR_CHANNELS,
  RESTORE_FAILURE_REASONS,
  busyDetailOf,
  countActiveAgentLeases,
  repairInputSchemas,
  restoreFailureOf,
  restoreMessages,
  runFailureText,
  viewOf,
  type DatabaseRestoreOutcome,
} from "../../packages/desktop-core/src/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function checked(status: string): DatabaseRestoreOutcome {
  return { outcome: "checked", result: { type: "restore-result", status } } as unknown as DatabaseRestoreOutcome;
}

describe("restore failure classification", () => {
  it.each([
    ["ok", null],
    ["in-use", "agents-running"],
    ["locked", "locked"],
    ["no-space", "no-space"],
    ["newer-schema", "newer-schema"],
    ["not-database", "not-database"],
    ["corrupt", "corrupt"],
    ["verify-failed", "verify-failed"],
    ["missing", "missing"],
    ["same-file", "same-file"],
    ["failed", "failed"],
  ])("maps the child's %s to %s", (status, reason) => {
    expect(restoreFailureOf(checked(status))).toBe(reason);
  });

  it("treats a child that could not answer as failed", () => {
    expect(restoreFailureOf({ outcome: "failed" } as unknown as DatabaseRestoreOutcome)).toBe("failed");
  });

  it("names what holds a restore back", () => {
    expect(busyDetailOf({ current: { kind: "restore" }, pageAction: false, activity: null })).toEqual({
      source: "operation",
      operation: "restore",
    });
    expect(busyDetailOf({ current: null, pageAction: true, activity: null })).toEqual({ source: "page-action" });
    expect(busyDetailOf({ current: null, pageAction: false, activity: { status: "unknown" } })).toEqual({
      source: "unknown",
    });
    expect(
      busyDetailOf({
        current: null,
        pageAction: false,
        activity: { status: "known", busy: ["import"], pendingImport: false },
      }),
    ).toEqual({ source: "activity", activities: ["import"] });
    expect(
      busyDetailOf({
        current: null,
        pageAction: false,
        activity: { status: "known", busy: [], pendingImport: false },
      }),
    ).toBeNull();
  });

  it("marks a file that cannot be restored from with its problem", () => {
    const base = { path: "/p/a.sqlite", fileName: "a.sqlite", bytes: 10 };
    expect(viewOf({ ...base, status: "ok", schemaVersion: 3, projects: 1, sessions: 2 }).problem).toBeNull();
    expect(viewOf({ ...base, status: "newer-schema" }).problem).toBe("newer-schema");
    expect(viewOf({ ...base, status: "corrupt" }).problem).toBe("corrupt");
  });
});

describe("restore messages", () => {
  it("covers every failure reason in both languages without command wording", () => {
    for (const locale of ["zh-TW", "en"] as const) {
      const messages = restoreMessages(locale);
      for (const reason of RESTORE_FAILURE_REASONS) {
        const text = runFailureText(messages, { ok: false, reason, dataIntact: true, backendRunning: true });
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toMatch(/pnpm|npm|terminal|終端|命令列|指令/i);
      }
    }
  });

  it("asks to close the Agents first, and says the data was not changed", () => {
    expect(restoreMessages("zh-TW").agentsRunning).toContain("請先關閉 Claude Code / Codex 等 Agent 再還原");
    expect(restoreMessages("en").agentsRunning).toMatch(/Close Claude Code, Codex and other Agents/);
    const locked = runFailureText(restoreMessages("en"), {
      ok: false,
      reason: "locked",
      dataIntact: true,
      backendRunning: true,
    });
    expect(locked).toMatch(/unchanged|not changed|intact/i);
  });
});

describe("agent lease counting", () => {
  function lease(root: string, runtime: string, name: string, action: string, ageMs: number): void {
    const directory = join(root, "leases", runtime);
    mkdirSync(directory, { recursive: true });
    const file = join(directory, name);
    writeFileSync(file, JSON.stringify({ action, createdAt: "2026-01-01T00:00:00.000Z" }));
    const time = new Date(Date.now() - ageMs);
    utimesSync(file, time, time);
  }

  it("counts only fresh mcp leases", async () => {
    const root = mkdtempSync(join(tmpdir(), "wi-agent-leases-"));
    roots.push(root);
    lease(root, "rt1", "a.lease", "mcp", 1_000);
    lease(root, "rt1", "b.lease", "serve", 1_000);
    lease(root, "rt2", "c.lease", "mcp", AGENT_LEASE_MAX_AGE_MS + 60_000);
    expect(await countActiveAgentLeases(root)).toBe(1);
  });

  it("counts none for a missing folder", async () => {
    expect(await countActiveAgentLeases(join(tmpdir(), "wi-no-such-root-xyz"))).toBe(0);
  });
});

describe("restore IPC contract", () => {
  it("accepts no path from the page", () => {
    expect(repairInputSchemas.restoreList.safeParse({}).success).toBe(true);
    expect(repairInputSchemas.restoreList.safeParse({ path: "/etc/x" }).success).toBe(false);
    expect(repairInputSchemas.restorePick.safeParse({ path: "/etc/x" }).success).toBe(false);
    expect(repairInputSchemas.restoreRun.safeParse({ backupId: "/etc/passwd" }).success).toBe(false);
    expect(repairInputSchemas.restoreRun.safeParse({ backupId: crypto.randomUUID(), path: "/x" }).success).toBe(false);
    expect(repairInputSchemas.restoreRun.safeParse({ backupId: crypto.randomUUID() }).success).toBe(true);
  });

  it("registers the channels", () => {
    expect(REPAIR_CHANNELS.restoreRun).toBe("restore:run");
  });
});
