import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BackendRecovery,
  CandidateRegistry,
  ErrorPresenter,
  interpretManagedStart,
  previewToCandidate,
  QuitFlow,
  RecentErrors,
  RestartPolicy,
  RetryIdIssuer,
  type BackendRecoveryDeps,
  type BackendStopReport,
  type DatabasePreviewResult,
  type ManagedStartResult,
  type QuitFlowDeps,
  type RestartOutcome,
  type StopAttempt,
} from "../../packages/desktop-core/src/index.js";

const STOPPED: BackendStopReport = {
  graceful: true,
  forced: false,
  exitCode: 0,
  signal: null,
  exited: true,
  portReleased: true,
  wasRunning: true,
};

describe("RetryIdIssuer", () => {
  function issuer() {
    let counter = 0;
    return new RetryIdIssuer(() => `id-${(counter += 1)}`);
  }

  it("keeps one id while the page polls, so a button's id never goes stale", () => {
    const ids = issuer();
    expect([ids.current(), ids.current(), ids.current()]).toEqual(["id-1", "id-1", "id-1"]);
  });

  it("accepts an id once, then replaces it; an old or unknown id is refused", () => {
    const ids = issuer();
    expect(ids.consume("nope")).toBe(false);
    expect(ids.current()).toBe("id-1");
    expect(ids.consume("id-1")).toBe(true);
    expect(ids.consume("id-1")).toBe(false);
    expect(ids.current()).toBe("id-2");
  });

  it("voids ids handed out before a state change", () => {
    const ids = issuer();
    const before = ids.current();
    ids.rotate();
    expect(ids.consume(before)).toBe(false);
    expect(ids.consume(ids.current())).toBe(true);
  });
});

describe("interpretManagedStart", () => {
  const completed = { status: "completed", result: {} } as const;
  const backend = { pid: 1 } as unknown as NonNullable<ManagedStartResult["backend"]>;

  it("reads a completed start with a backend as started", () => {
    expect(interpretManagedStart({ operation: completed, backend })).toEqual({ kind: "started" });
  });

  it("reads busy as busy, not as a failure", () => {
    const current = { operationId: "x", kind: "restart", phase: "STARTING", cancellable: false } as const;
    expect(interpretManagedStart({ operation: { status: "busy", current } })).toEqual({ kind: "busy" });
  });

  it("reads everything else as a failure with its code, or the generic repair code", () => {
    expect(
      interpretManagedStart({ operation: { status: "failed", error: "DB_MISSING: gone" }, errorCode: "DB_MISSING" }),
    ).toEqual({ kind: "failed", code: "DB_MISSING" });
    expect(interpretManagedStart({ operation: { status: "failed", error: "weird" } })).toEqual({
      kind: "failed",
      code: "REPAIR_REQUIRED",
    });
    expect(interpretManagedStart({ operation: { status: "cancelled" } })).toEqual({
      kind: "failed",
      code: "REPAIR_REQUIRED",
    });
    expect(interpretManagedStart({ operation: completed })).toEqual({ kind: "failed", code: "REPAIR_REQUIRED" });
  });
});

describe("CandidateRegistry", () => {
  function registry(capacity = 3) {
    let counter = 0;
    return new CandidateRegistry(() => `c${(counter += 1)}`, capacity);
  }
  const identity = { realPath: "/p/a.sqlite", fileId: null, lineageId: null };
  const ok = { status: "ok", needsMigration: false, identity } as const;

  it("hands out opaque ids, keeps a bounded number and replaces a path that is picked again", () => {
    const candidates = registry();
    const first = candidates.add("/p/a.sqlite");
    candidates.add("/p/b.sqlite");
    candidates.add("/p/c.sqlite");
    candidates.add("/p/d.sqlite");
    expect(candidates.get(first)).toBeUndefined();
    expect(candidates.list().map((entry) => entry.path)).toEqual(["/p/b.sqlite", "/p/c.sqlite", "/p/d.sqlite"]);
    candidates.add("/p/b.sqlite");
    expect(candidates.list().map((entry) => entry.path)).toEqual(["/p/c.sqlite", "/p/d.sqlite", "/p/b.sqlite"]);
    candidates.remove("c4");
    expect(candidates.list()).toHaveLength(2);
  });

  it("only confirms a previewed ok database, and one that needs a schema update only with consent", () => {
    const candidates = registry();
    const id = candidates.add("/p/a.sqlite");
    expect(candidates.checkConfirm("missing-id", false)).toEqual({ ok: false, reason: "unknown" });
    expect(candidates.checkConfirm(id, false)).toEqual({ ok: false, reason: "not-previewed" });

    candidates.setPreview(id, { status: "missing", needsMigration: false });
    expect(candidates.checkConfirm(id, true)).toEqual({ ok: false, reason: "not-usable" });
    for (const status of ["offline", "denied", "unreadable", "unsupported-schema"] as const) {
      candidates.setPreview(id, { status, needsMigration: false });
      expect(candidates.checkConfirm(id, true).ok).toBe(false);
    }

    candidates.setPreview(id, ok);
    expect(candidates.checkConfirm(id, false).ok).toBe(true);

    candidates.setPreview(id, { status: "ok", needsMigration: true, identity });
    expect(candidates.checkConfirm(id, false)).toEqual({ ok: false, reason: "migration-consent-required" });
    const confirmed = candidates.checkConfirm(id, true);
    expect(confirmed.ok && confirmed.identity).toEqual(identity);
    candidates.setPreview("gone", ok);
  });

  it("never confirms an ok preview that carries no identity: there would be nothing to check the start against", () => {
    const candidates = registry();
    const id = candidates.add("/p/a.sqlite");
    candidates.setPreview(id, { status: "ok", needsMigration: false });
    expect(candidates.checkConfirm(id, true)).toEqual({ ok: false, reason: "not-usable" });
    expect(
      previewToCandidate({
        outcome: "checked",
        preflight: { type: "preflight-result", status: "ok" },
        willMigrate: false,
      }),
    ).toEqual({ status: "unreadable", needsMigration: false });
  });

  it("turns the supervisor's preview into a candidate preview", () => {
    const identity = { realPath: "/p/a.sqlite", fileId: null, lineageId: null };
    const checked: DatabasePreviewResult = {
      outcome: "checked",
      preflight: { type: "preflight-result", status: "ok", identity, compatibility: "older-needs-migration" },
      willMigrate: true,
    };
    expect(previewToCandidate(checked)).toEqual({ status: "ok", needsMigration: true, identity });
    expect(
      previewToCandidate({
        outcome: "checked",
        preflight: { type: "preflight-result", status: "missing" },
        willMigrate: false,
      }),
    ).toEqual({ status: "missing", needsMigration: false });
    // The real code survives, so the page can say why (the runtime is missing, the check timed out, ...).
    for (const code of ["RUNTIME_MISSING", "CHILD_START_TIMEOUT"] as const) {
      expect(previewToCandidate({ outcome: "failed", code, detail: "x" })).toEqual({
        status: "unreadable",
        needsMigration: false,
        errorCode: code,
      });
    }
  });
});

describe("QuitFlow", () => {
  function setup(overrides: Partial<QuitFlowDeps> = {}) {
    const calls: string[] = [];
    const deps: QuitFlowDeps = {
      confirm: async () => (calls.push("confirm"), true),
      cancelOperation: async () => void calls.push("cancel"),
      tryManagedStop: async (): Promise<StopAttempt> => (
        calls.push("managed-stop"),
        { status: "stopped", report: STOPPED }
      ),
      forceStop: async () => (calls.push("force-stop"), STOPPED),
      sleep: async () => void calls.push("sleep"),
      log: (line) => calls.push(`log:${line.split(":")[0]}`),
      warnIncompleteStop: async () => void calls.push("warn"),
      waitLimitMs: 300,
      pollMs: 100,
      ...overrides,
    };
    return { flow: new QuitFlow(deps), calls };
  }

  it("confirms first, stops through the managed service and lets the process exit", async () => {
    const { flow, calls } = setup();
    expect(await flow.request({ confirmFirst: true })).toBe("exit");
    expect(calls.filter((call) => !call.startsWith("log"))).toEqual(["confirm", "managed-stop"]);
  });

  it("does not ask when the quit did not come from the user (a signal)", async () => {
    const { flow, calls } = setup();
    expect(await flow.request({ confirmFirst: false })).toBe("exit");
    expect(calls).not.toContain("confirm");
  });

  it("stays running when the user says no, and can be asked again", async () => {
    let answer = false;
    const { flow, calls } = setup({ confirm: async () => answer });
    expect(await flow.request({ confirmFirst: true })).toBe("cancelled");
    expect(calls).not.toContain("managed-stop");
    answer = true;
    expect(await flow.request({ confirmFirst: true })).toBe("exit");
  });

  it("refuses a second request while the first runs or has finished", async () => {
    let release: (() => void) | undefined;
    const { flow } = setup({
      confirm: () => new Promise<boolean>((resolve) => (release = () => resolve(true))),
    });
    const first = flow.request({ confirmFirst: true });
    expect(await flow.request({ confirmFirst: true })).toBe("ignored");
    release?.();
    expect(await first).toBe("exit");
    expect(await flow.request({ confirmFirst: false })).toBe("ignored");
  });

  it("cancels a running operation once, waits for it, then stops normally when it ends", async () => {
    let busy = 2;
    const { flow, calls } = setup({
      tryManagedStop: async () => {
        calls.push("managed-stop");
        return busy-- > 0 ? { status: "busy" } : { status: "stopped", report: STOPPED };
      },
    });
    expect(await flow.request({ confirmFirst: false })).toBe("exit");
    expect(calls.filter((call) => call === "cancel")).toHaveLength(1);
    expect(calls).not.toContain("force-stop");
  });

  it("stops the child directly when the operation never ends, so no orphan is left behind", async () => {
    const { flow, calls } = setup({ tryManagedStop: async () => ({ status: "busy" }) });
    expect(await flow.request({ confirmFirst: false })).toBe("exit");
    expect(calls).toContain("force-stop");
    expect(calls).not.toContain("warn");
    // 300 ms of waiting in 100 ms steps, then the direct stop.
    expect(calls.filter((call) => call === "sleep")).toHaveLength(3);
  });

  it("logs and warns before exiting when the report does not prove the backend stopped", async () => {
    for (const report of [
      { ...STOPPED, exited: false },
      { ...STOPPED, portReleased: false },
    ]) {
      const { flow, calls } = setup({ tryManagedStop: async () => ({ status: "stopped", report }) });
      expect(await flow.request({ confirmFirst: false })).toBe("exit");
      expect(calls.indexOf("warn")).toBeGreaterThan(-1);
      expect(calls).toContain("log:[shell] backend not proven stopped");
    }
  });

  it("warns when even the direct stop fails, and still lets the process exit", async () => {
    const { flow, calls } = setup({
      tryManagedStop: async () => ({ status: "busy" }),
      forceStop: async () => {
        throw new Error("boom");
      },
    });
    expect(await flow.request({ confirmFirst: false })).toBe("exit");
    expect(calls).toContain("warn");
  });

  it("survives a failing cancel and a failing warning", async () => {
    const { flow } = setup({
      tryManagedStop: async () => ({ status: "busy" }),
      cancelOperation: async () => {
        throw new Error("no");
      },
      forceStop: async () => ({ ...STOPPED, exited: false }),
      warnIncompleteStop: async () => {
        throw new Error("dialog failed");
      },
    });
    expect(await flow.request({ confirmFirst: false })).toBe("exit");
  });

  it("gives the quit back (cancelled) when the confirmation itself throws", async () => {
    const { flow } = setup({
      confirm: async () => {
        throw new Error("dialog failed");
      },
    });
    expect(await flow.request({ confirmFirst: true })).toBe("cancelled");
    expect(await flow.request({ confirmFirst: true })).toBe("cancelled");
  });

  it("uses default waits when none are given", async () => {
    const calls: string[] = [];
    const flow = new QuitFlow({
      confirm: async () => true,
      cancelOperation: async () => undefined,
      tryManagedStop: async () => ({ status: "stopped", report: STOPPED }),
      forceStop: async () => STOPPED,
      sleep: async () => void calls.push("sleep"),
      log: () => undefined,
      warnIncompleteStop: async () => undefined,
    });
    expect(await flow.request({ confirmFirst: false })).toBe("exit");
  });
});

describe("BackendRecovery under load", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(options: {
    restart: (operationId?: string) => Promise<RestartOutcome>;
    shouldAutoRetry?: () => boolean;
    isServing?: () => boolean;
    mode?: "interactive" | "background";
    onOwnerChange?: (owner: string) => void;
  }) {
    const calls: string[] = [];
    const errors = new RecentErrors();
    const presenter = new ErrorPresenter(options.mode ?? "interactive", {
      openRepairWindow: () => calls.push("window"),
      setTrayAttention: (code) => calls.push(`tray:${code}`),
      notify: (code) => calls.push(`notify:${code}`),
    });
    const deps: BackendRecoveryDeps = {
      policy: new RestartPolicy({ clock: () => Date.now() }),
      presenter,
      errors,
      restart: options.restart,
      shouldAutoRetry: options.shouldAutoRetry ?? (() => true),
      ...(options.isServing ? { isServing: options.isServing } : {}),
      now: () => new Date(),
      setTimer: (callback, ms) => setTimeout(callback, ms),
      clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
      onOwnerChange: (owner) => {
        calls.push(`owner:${owner}`);
        options.onOwnerChange?.(owner);
      },
      log: (line) => calls.push(`log:${line.split(" ").slice(0, 3).join(" ")}`),
    };
    return { recovery: new BackendRecovery(deps), calls, errors };
  }

  it("logs, and does not leak a rejection, when the follow-up of an automatic retry itself throws", async () => {
    for (const thrown of [new Error("tray broke"), "plain text"]) {
      const { recovery, calls } = setup({
        restart: async () => ({ ok: true }),
        onOwnerChange: (owner) => {
          if (owner === "MANAGED") throw thrown;
        },
      });
      recovery.handleFailure("CHILD_EXITED");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls).toContain("log:[shell] retry failed:");
      expect(recovery.restarting).toBe(false);
    }
  });

  it("treats a restart that throws as a failed restart: recorded, NEEDS_REPAIR, presented, never left starting", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const { recovery, calls, errors } = setup({
      restart: async () => {
        throw new Error("spawn exploded");
      },
    });
    recovery.handleFailure("CHILD_EXITED");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(errors.list().map((entry) => entry.code)).toContain("REPAIR_REQUIRED");
    expect(calls).toContain("owner:NEEDS_REPAIR");
    expect(calls).toContain("tray:REPAIR_REQUIRED");
    expect(calls).toContain("window");
    expect(recovery.restarting).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("a manual retry whose restart throws answers with the generic code and presents it by launch mode", async () => {
    const { recovery, calls } = setup({
      mode: "background",
      restart: async () => {
        throw new Error("spawn exploded");
      },
    });
    expect(await recovery.retryNow("op-1")).toEqual({ ok: false, code: "REPAIR_REQUIRED" });
    expect(calls).toContain("notify:REPAIR_REQUIRED");
    expect(calls).not.toContain("window");
  });

  it("does not restart on the timer when an operation runs or the backend already serves", async () => {
    let allowed = false;
    const restart = vi.fn(async (): Promise<RestartOutcome> => ({ ok: true }));
    const { recovery, calls } = setup({ restart, shouldAutoRetry: () => allowed });
    recovery.handleFailure("CHILD_EXITED");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(restart).not.toHaveBeenCalled();
    expect(calls).toContain("log:[shell] automatic retry");
    expect(calls).not.toContain("owner:MANAGED");
    allowed = true;
    recovery.handleFailure("CHILD_EXITED");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("tries again when an operation held the lock, and starts once the lock is free (M-05)", async () => {
    let allowed = false;
    const restart = vi.fn(async (): Promise<RestartOutcome> => ({ ok: true }));
    const { recovery } = setup({ restart, shouldAutoRetry: () => allowed, isServing: () => false });
    recovery.handleFailure("CHILD_EXITED");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(restart).not.toHaveBeenCalled();
    allowed = true;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("retries after a restart that found the lock held, and does not wait once a backend serves", async () => {
    const outcomes: RestartOutcome[] = [{ ok: false, busy: true }, { ok: true }];
    const restart = vi.fn(async (): Promise<RestartOutcome> => outcomes.shift() ?? { ok: true });
    const { recovery } = setup({ restart, isServing: () => false });
    recovery.handleFailure("CHILD_EXITED");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(restart).toHaveBeenCalledTimes(2);

    const serving = vi.fn(async (): Promise<RestartOutcome> => ({ ok: false, busy: true }));
    const second = setup({ restart: serving, isServing: () => true });
    second.recovery.handleFailure("CHILD_EXITED");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(serving).toHaveBeenCalledTimes(1);
  });

  it("shows the failure when the lock stays held for a minute, instead of staying silent", async () => {
    const restart = vi.fn(async (): Promise<RestartOutcome> => ({ ok: false, busy: true }));
    const { recovery, calls } = setup({ restart, isServing: () => false });
    recovery.handleFailure("CHILD_EXITED");
    expect(calls).not.toContain("window");
    await vi.advanceTimersByTimeAsync(70_000);
    expect(calls).toContain("window");
    expect(restart.mock.calls.length).toBeLessThanOrEqual(21);
  });

  it("answers busy, changes nothing and keeps no operation id while a restart is running", async () => {
    let finish: ((outcome: RestartOutcome) => void) | undefined;
    const seen: (string | undefined)[] = [];
    const restart = vi.fn((operationId?: string) => {
      seen.push(operationId);
      return new Promise<RestartOutcome>((resolve) => (finish = resolve));
    });
    const { recovery, calls } = setup({ restart });
    recovery.handleFailure("CHILD_EXITED");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(recovery.restarting).toBe(true);

    expect(await recovery.retryNow("user-op")).toEqual({ ok: false, busy: true });
    expect(calls.filter((call) => call === "owner:MANAGED")).toHaveLength(0);
    finish?.({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    // The automatic retry ran without the user's id; the user's id was never handed to anything.
    expect(seen).toEqual([undefined]);
  });

  it("hands the user's operation id to a manual retry and to nothing else", async () => {
    const seen: (string | undefined)[] = [];
    const { recovery } = setup({
      restart: async (operationId) => {
        seen.push(operationId);
        return { ok: false, code: "CHILD_EXITED" };
      },
    });
    await recovery.retryNow("user-op");
    recovery.handleFailure("CHILD_EXITED");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(seen).toEqual(["user-op", undefined]);
  });

  it("a restart refused as busy by the coordinator changes no state and is not an error", async () => {
    const { recovery, calls, errors } = setup({ restart: async () => ({ ok: false, busy: true }) });
    expect(await recovery.retryNow("op")).toEqual({ ok: false, busy: true });
    expect(calls.filter((call) => call.startsWith("owner:"))).toEqual([]);
    expect(calls).not.toContain("window");
    expect(errors.list()).toEqual([]);
  });
});
