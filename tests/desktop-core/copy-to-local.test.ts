import { describe, expect, it } from "vitest";
import {
  COPY_TO_LOCAL_FAILURES,
  copyFailureCode,
  copyFailureOfCode,
  requiredCopyBytes,
  runCopyToLocal,
  type CopyToLocalDeps,
} from "../../packages/desktop-core/src/shell/copy-to-local.js";

const IDENTITY = { realPath: "/local/copy.db", fileId: { device: "1", inode: "2" }, lineageId: "l" };
const MB = 1024 * 1024;

function harness(overrides: Partial<CopyToLocalDeps> = {}) {
  const events: string[] = [];
  const deps: CopyToLocalDeps = {
    targetFolderRisky: async () => false,
    confirm: async () => (events.push("confirm"), true),
    sourceBytes: async () => ({ database: 10 * MB, wal: 2 * MB }),
    freeBytes: async () => 10_000 * MB,
    chooseTarget: async () => "/local/copy.db",
    prepareRuntime: async () => void events.push("runtime"),
    copyDatabase: async () => (events.push("copy"), { type: "copy-result", status: "ok", identity: IDENTITY }),
    switchTo: async () => (events.push("switch"), { ok: true }),
    removeCopy: () => void events.push("remove"),
    log: () => undefined,
    ...overrides,
  };
  return { deps, events };
}

describe("copy to the local disk", () => {
  it("names its failures with stable codes", () => {
    expect(copyFailureCode("no-space")).toBe("COPY_NO_SPACE");
    expect(copyFailureCode("start-failed")).toBe("COPY_START_FAILED");
    for (const failure of COPY_TO_LOCAL_FAILURES) expect(copyFailureOfCode(copyFailureCode(failure))).toBe(failure);
    expect(copyFailureOfCode("OTHER")).toBeUndefined();
    expect(copyFailureOfCode(undefined)).toBeUndefined();
  });

  it("needs the files, a margin of at least 64 MB, or a tenth of a big database", () => {
    expect(requiredCopyBytes(10 * MB, 2 * MB)).toBe(76 * MB);
    expect(requiredCopyBytes(1000 * MB, 0)).toBe(1100 * MB);
  });

  it("copies, then switches, and leaves the original to the caller", async () => {
    const { deps, events } = harness();
    expect(await runCopyToLocal(deps)).toEqual({ ok: true, target: "/local/copy.db" });
    expect(events).toEqual(["confirm", "runtime", "copy", "switch"]);
  });

  it("does nothing when the user cancels", async () => {
    const { deps, events } = harness({ confirm: async () => false });
    expect(await runCopyToLocal(deps)).toEqual({ ok: false, reason: "cancelled" });
    expect(events).toEqual([]);
  });

  it("refuses before asking anything when the target folder is itself on risky storage", async () => {
    const { deps, events } = harness({ targetFolderRisky: async () => true });
    expect(await runCopyToLocal(deps)).toMatchObject({
      ok: false,
      failure: "target-risky",
      errorCode: "COPY_TARGET_RISKY",
    });
    expect(events).toEqual([]);
  });

  it("refuses before copying when there is not enough free space, but tries when the OS will not say", async () => {
    const full = harness({ freeBytes: async () => 70 * MB });
    expect(await runCopyToLocal(full.deps)).toMatchObject({
      ok: false,
      failure: "no-space",
      errorCode: "COPY_NO_SPACE",
    });
    expect(full.events).not.toContain("copy");
    const unknown = harness({ freeBytes: async () => undefined });
    expect((await runCopyToLocal(unknown.deps)).ok).toBe(true);
  });

  it("maps every failed child verdict", async () => {
    for (const [status, failure] of [
      ["no-space", "no-space"],
      ["target-exists", "target-exists"],
      ["integrity-failed", "integrity-failed"],
      ["failed", "copy-failed"],
    ] as const) {
      const { deps, events } = harness({ copyDatabase: async () => ({ type: "copy-result", status }) });
      expect(await runCopyToLocal(deps)).toMatchObject({ ok: false, failure });
      expect(events).not.toContain("switch");
    }
  });

  it("fails an ok copy that carries no identity", async () => {
    const { deps } = harness({ copyDatabase: async () => ({ type: "copy-result", status: "ok" }) });
    expect(await runCopyToLocal(deps)).toMatchObject({ failure: "integrity-failed" });
  });

  it("takes the copy back when the switch fails or throws, and reports a busy switch", async () => {
    const failed = harness({ switchTo: async () => ({ ok: false, code: "X" }) });
    // The backend's own code survives, so the page can show the real reason.
    expect(await runCopyToLocal(failed.deps)).toMatchObject({
      failure: "start-failed",
      errorCode: "COPY_START_FAILED",
      backendCode: "X",
    });
    expect(failed.events).toContain("remove");
    const thrown = harness({
      switchTo: async () => {
        throw new Error("x");
      },
    });
    const thrownResult = await runCopyToLocal(thrown.deps);
    expect(thrownResult).toMatchObject({ failure: "start-failed" });
    expect(thrownResult).not.toHaveProperty("backendCode");
    expect(thrown.events).toContain("remove");
    const busy = harness({ switchTo: async () => ({ ok: false, busy: true }) });
    expect(await runCopyToLocal(busy.deps)).toEqual({ ok: false, reason: "busy" });
    expect(busy.events).toContain("remove");
  });

  it("reports a copy-failed when any earlier step throws", async () => {
    const { deps } = harness({
      sourceBytes: async () => {
        throw new Error("gone");
      },
    });
    expect(await runCopyToLocal(deps)).toMatchObject({ failure: "copy-failed" });
  });
});
