import { describe, expect, it } from "vitest";
import type { BackupInspectOutcome } from "../../packages/desktop-core/src/index.js";
import { inspectedItems, problemOf } from "../../packages/desktop-core/src/shell/restore-classify.js";
import {
  busyText,
  formatBackupSize,
  pickFailureText,
  restoreMessages,
  runFailureText,
  runSuccessText,
} from "../../packages/desktop-core/src/shell/restore-i18n.js";
import type { RestoreFailureReason } from "../../packages/desktop-core/src/shell/restore-types.js";

const LOCALES = ["zh-TW", "en"] as const;

describe("restoreMessages", () => {
  it("has a non-empty string for every key in both languages and no command or terminal wording", () => {
    for (const locale of LOCALES) {
      const values = JSON.stringify(restoreMessages(locale));
      expect(values).not.toMatch(/terminal|command line|npx|pnpm|終端機|指令/i);
      const walk = (node: unknown): void => {
        if (typeof node === "string") expect(node.trim().length).toBeGreaterThan(0);
        else for (const child of Object.values(node as Record<string, unknown>)) walk(child);
      };
      walk(restoreMessages(locale));
    }
  });

  it("returns the zh-TW table for zh-TW and the English one otherwise", () => {
    expect(restoreMessages("zh-TW").heading).toBe("從備份還原");
    expect(restoreMessages("en").heading).toBe("Restore from backup");
  });
});

describe("formatBackupSize", () => {
  it.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1.0 KB"],
    [1536, "1.5 KB"],
    [150 * 1024, "150 KB"],
    [5 * 1024 * 1024, "5.0 MB"],
    [3 * 1024 ** 3, "3.0 GB"],
    [5000 * 1024 ** 3, "5000 GB"],
  ])("formats %d bytes as %s", (bytes, text) => {
    expect(formatBackupSize(bytes)).toBe(text);
  });
});

describe("busyText", () => {
  it.each(LOCALES)("names the real reason in %s", (locale) => {
    const m = restoreMessages(locale);
    expect(busyText(m, { source: "operation", operation: "restart" })).toContain(m.operations.restart);
    expect(busyText(m, { source: "activity", activities: ["import"] })).toBe(m.busyActivity);
    expect(busyText(m, { source: "page-action" })).toBe(m.busyPageAction);
    expect(busyText(m, { source: "unknown" })).toBe(m.busyUnknown);
    expect(busyText(m, undefined)).toBe(m.busyOperation);
  });

  it("fills the operation name into the sentence", () => {
    expect(busyText(restoreMessages("en"), { source: "operation", operation: "change-port" })).toBe(
      "The App is busy: changing the port. Wait for it to finish, then restore. Nothing was changed.",
    );
    expect(busyText(restoreMessages("zh-TW"), { source: "operation", operation: "change-port" })).toContain(
      "變更連接埠",
    );
  });
});

describe("pickFailureText", () => {
  it.each(LOCALES)("covers every refusal in %s", (locale) => {
    const m = restoreMessages(locale);
    expect(pickFailureText(m, { ok: false, reason: "newer-schema", schemaVersion: 99 })).toContain("99");
    expect(pickFailureText(m, { ok: false, reason: "newer-schema" })).toBe(m.problems["newer-schema"]);
    expect(pickFailureText(m, { ok: false, reason: "cancelled" })).toBe(m.pickCancelled);
    expect(pickFailureText(m, { ok: false, reason: "invalid" })).toBe(m.pickFailed);
    expect(pickFailureText(m, { ok: false, reason: "failed" })).toBe(m.pickFailed);
    expect(pickFailureText(m, { ok: false, reason: "corrupt" })).toBe(m.problems.corrupt);
    expect(pickFailureText(m, { ok: false, reason: "unreadable" })).toBe(m.problems.unreadable);
  });
});

describe("runFailureText", () => {
  const base = { ok: false, dataIntact: true, backendRunning: true } as const;
  const failure = (reason: RestoreFailureReason, extra: object = {}, running = true) =>
    ({ ...base, backendRunning: running, reason, ...extra }) as Parameters<typeof runFailureText>[1];

  it.each(LOCALES)("builds the sentence for every reason in %s", (locale) => {
    const m = restoreMessages(locale);
    expect(runFailureText(m, failure("expired"))).toBe(m.expired);
    expect(runFailureText(m, failure("cancelled"))).toBe(m.cancelled);
    expect(runFailureText(m, failure("busy", { busy: { source: "page-action" } }))).toBe(m.busyPageAction);
    expect(runFailureText(m, failure("busy"))).toBe(m.busyOperation);
    expect(runFailureText(m, failure("agents-running"))).toBe(`${m.agentsRunning} ${m.dataIntact}`);
    expect(runFailureText(m, failure("locked"))).toBe(m.locked);
    expect(runFailureText(m, failure("no-space"))).toBe(m.noSpace);
    expect(runFailureText(m, failure("verify-failed"))).toBe(m.verifyFailed);
    expect(runFailureText(m, failure("same-file"))).toBe(m.sameFile);
    expect(runFailureText(m, failure("no-database"))).toBe(m.noDatabaseToRestore);
    for (const reason of ["newer-schema", "not-database", "corrupt", "missing"] as const) {
      expect(runFailureText(m, failure(reason))).toBe(`${m.problems[reason]} ${m.dataIntact}`);
    }
    expect(runFailureText(m, failure("outcome-unknown"))).toBe(m.outcomeUnknown);
    expect(runFailureText(m, failure("failed"))).toBe(m.failed);
    expect(runFailureText(m, failure("start-failed", { safetyBackup: "safe.sqlite" }, false))).toContain("safe.sqlite");
    expect(runFailureText(m, failure("start-failed"))).not.toContain("undefined");
  });

  it.each(LOCALES)("adds the not-running note only when the service is stopped (%s)", (locale) => {
    const m = restoreMessages(locale);
    for (const reason of [
      "agents-running",
      "locked",
      "no-space",
      "verify-failed",
      "corrupt",
      "outcome-unknown",
      "failed",
    ] as const) {
      expect(runFailureText(m, failure(reason, {}, true))).not.toContain(m.notRunning);
      expect(runFailureText(m, failure(reason, {}, false))).toContain(m.notRunning);
    }
  });
});

describe("runSuccessText", () => {
  it("names the counts and, when there is one, the safety backup", () => {
    const en = restoreMessages("en");
    expect(runSuccessText(en, { ok: true, projects: 3, sessions: 42, safetyBackup: "before.sqlite" })).toBe(
      "Restored: 3 projects, 42 sessions. The data from before the restore was backed up as “before.sqlite”.",
    );
    expect(runSuccessText(en, { ok: true, projects: 0, sessions: 0 })).toBe("Restored: 0 projects, 0 sessions.");
    const zh = restoreMessages("zh-TW");
    expect(runSuccessText(zh, { ok: true, projects: 3, sessions: 42, safetyBackup: "before.sqlite" })).toBe(
      "已還原：3 個專案、42 筆 Session。還原前的資料已備份為「before.sqlite」。",
    );
    expect(runSuccessText(zh, { ok: true, projects: 1, sessions: 2 })).toBe("已還原：1 個專案、2 筆 Session。");
  });
});

describe("restore classification helpers", () => {
  it("reads the inspected items only from a checked outcome", () => {
    const items = [{ path: "/a", fileName: "a", bytes: 1, status: "ok" }];
    const checked = { outcome: "checked", result: { type: "inspect-result", items, directoryReadable: true } };
    expect(inspectedItems(checked as unknown as BackupInspectOutcome)).toBe(items);
    expect(inspectedItems({ outcome: "failed", code: "X", detail: "y" } as unknown as BackupInspectOutcome)).toBeNull();
  });

  it("has no problem for an ok file and the status otherwise", () => {
    expect(problemOf({ status: "ok" })).toBeNull();
    expect(problemOf({ status: "corrupt" })).toBe("corrupt");
  });
});
