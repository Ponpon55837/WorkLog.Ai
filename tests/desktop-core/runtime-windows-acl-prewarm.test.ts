import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertWindowsAcl,
  createWindowsAclReader,
  type AclChild,
  type ExecFileFailure,
  nodeSpawn,
  type ExecFileLike,
  type SpawnAclLike,
} from "../../packages/desktop-core/src/runtime/index.js";

const USER = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const PROFILE_SDDL = `O:${USER}G:DUD:PAI(A;OICI;FA;;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`;
const SYSTEM32 = "C:\\Windows\\System32";
const POWERSHELL = `${SYSTEM32}\\WindowsPowerShell\\v1.0\\powershell.exe`;
const env = { SystemRoot: "C:\\Windows", Path: "C:\\evil", FOO: "bar" };

function failure(overrides: Partial<ExecFileFailure> = {}): ExecFileFailure {
  return Object.assign(new Error("failed"), {
    killed: false,
    timedOut: false,
    elapsedMs: 100,
    timeoutMs: 0,
    stderr: "",
    ...overrides,
  });
}

interface FakeProcess {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  received: string[] | undefined;
  killed: boolean;
}

type Behavior =
  | "answer"
  | "hang"
  | "bad-output"
  | "exit-1-at-start"
  | "exit-0-at-start"
  | "constrained-at-start"
  | "constrained-after-paths"
  | "exit-1-after-paths";

function fakeSpawner(behavior: Behavior = "answer", startupMs = 0) {
  const processes: FakeProcess[] = [];
  const spawn: SpawnAclLike = (file, args, options) => {
    const record: FakeProcess = { file, args, env: options.env, received: undefined, killed: false };
    processes.push(record);
    let settle: { resolve: (value: { stdout: string }) => void; reject: (error: unknown) => void } | undefined;
    const exited = new Promise<{ stdout: string }>((resolve, reject) => {
      settle = { resolve, reject };
    });
    let signalReady = () => {};
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    const started = new Promise<void>((resolve) => setTimeout(resolve, startupMs));
    void started.then(() => {
      if (behavior === "exit-1-at-start") settle?.reject(failure({ exitCode: 1 }));
      else if (behavior === "exit-0-at-start") settle?.resolve({ stdout: "" });
      else if (behavior === "constrained-at-start") settle?.reject(failure({ exitCode: 3 }));
      else signalReady();
    });
    const child: AclChild = {
      exited,
      ready,
      send: (input) => {
        record.received = input
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => Buffer.from(line, "base64").toString("utf8"));
        void started.then(() => {
          if (behavior === "answer") {
            settle?.resolve({ stdout: [USER, ...record.received!.map(() => PROFILE_SDDL)].join("\r\n") });
          } else if (behavior === "bad-output") settle?.resolve({ stdout: "garbage" });
          else if (behavior === "exit-1-after-paths") settle?.reject(failure({ exitCode: 1 }));
          else if (behavior === "constrained-after-paths") settle?.reject(failure({ exitCode: 3 }));
        });
      },
      kill: () => {
        record.killed = true;
        settle?.reject(failure({ killed: true, signal: "SIGTERM" }));
      },
    };
    return child;
  };
  return { spawn, processes };
}

function fakeExec() {
  return vi.fn<ExecFileLike>(async (file, args) => {
    if (file.endsWith("whoami.exe")) return { stdout: `"HOST\\me","${USER}"\r\n` };
    const tierTwo = (args.at(-1) as string).includes("Get-Acl");
    return { stdout: tierTwo ? `${PROFILE_SDDL}\r\n` : `${USER}\r\n${PROFILE_SDDL}\r\n` };
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the prewarmed tier-1 PowerShell", () => {
  it("starts by absolute path with the allow-listed environment and no paths in it, and hands the paths over on stdin", async () => {
    const { spawn, processes } = fakeSpawner();
    const exec = fakeExec();
    const reader = createWindowsAclReader(exec, env, spawn);
    reader.prewarm?.();
    const paths = ["C:\\Users\\測試 使用者\\AppData\\Local\\a b\\runtime", "C:\\Users\\me\\x|y"];
    const snapshot = await reader.read(paths);
    expect(snapshot.currentUserSid).toBe(USER);
    expect(snapshot.sddls).toEqual([PROFILE_SDDL, PROFILE_SDDL]);
    expect(exec).not.toHaveBeenCalled();
    expect(processes).toHaveLength(1);
    const [only] = processes as [FakeProcess];
    expect(only.file).toBe(POWERSHELL);
    expect(only.args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    expect(only.args).not.toContain("-InputFormat");
    expect(only.args.join(" ")).not.toContain("runtime");
    expect(only.env.WI_ACL_PATHS).toBeUndefined();
    expect(only.env.FOO).toBeUndefined();
    expect(only.env.PSModulePath).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules");
    expect(only.received).toEqual(paths);
    expect(only.killed).toBe(true);
  });

  it("reads its paths from stdin as Base64 lines, keeps every protection of the one-shot script and uses no cmdlet", async () => {
    const { spawn, processes } = fakeSpawner();
    const reader = createWindowsAclReader(fakeExec(), env, spawn);
    reader.prewarm?.();
    const script = (processes[0] as FakeProcess).args.at(-1) as string;
    expect(script.startsWith("$ProgressPreference='SilentlyContinue';$PSModuleAutoLoadingPreference='None';")).toBe(
      true,
    );
    expect(script).toContain("if($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage'){exit 3}");
    expect(script).toContain("[Console]::In.ReadLine()");
    expect(script).toContain("FromBase64String");
    expect(script).toContain("GetAccessControl");
    expect(script).not.toContain("WI_ACL_PATHS");
    expect(script).not.toMatch(/Get-Acl|Get-Item|ConvertFrom-Json/);
    reader.prewarm?.().release();
  });

  it("starts exactly one process per install, however often the reader is asked to prewarm", async () => {
    const { spawn, processes } = fakeSpawner();
    const reader = createWindowsAclReader(fakeExec(), env, spawn);
    reader.prewarm?.();
    reader.prewarm?.();
    await reader.read(["a"]);
    expect(processes).toHaveLength(1);
  });

  it("reports how long the process took to start, apart from the wait for the answer", async () => {
    const { spawn } = fakeSpawner("answer", 40);
    const reader = createWindowsAclReader(fakeExec(), env, spawn);
    reader.prewarm?.();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const snapshot = await reader.read(["a"]);
    expect(snapshot.prewarmMs).toBeGreaterThanOrEqual(30);
    expect(snapshot.prewarmMs).toBeLessThan(80);
  });

  it("through assertWindowsAcl: one tier-one attempt, the prewarm time in the report, the same SID rules", async () => {
    const { spawn } = fakeSpawner("answer", 20);
    const reader = createWindowsAclReader(fakeExec(), env, spawn);
    reader.prewarm?.();
    const report = await assertWindowsAcl(["a", "b"], reader);
    expect(report.tier).toBe("dotnet");
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]).toMatchObject({ tier: "dotnet", ok: true });
    expect(report.prewarmMs).toBeGreaterThanOrEqual(10);
  });

  it("a verdict from a prewarmed read is the same verdict: a stranger's write access is refused", async () => {
    const stranger = "S-1-5-21-1111111111-2222222222-3333333333-1002";
    const unsafe = `O:${USER}G:DUD:PAI(A;OICI;FA;;;${USER})(A;OICI;FA;;;${stranger})`;
    const spawn: SpawnAclLike = () => ({
      exited: Promise.resolve({ stdout: `${USER}\r\n${unsafe}\r\n` }),
      ready: Promise.resolve(),
      send: () => undefined,
      kill: () => undefined,
    });
    const reader = createWindowsAclReader(fakeExec(), env, spawn);
    reader.prewarm?.();
    await expect(assertWindowsAcl(["a"], reader)).rejects.toMatchObject({ code: "RUNTIME_UNSAFE_PERMISSIONS" });
  });

  it("never throws from prewarm: a spawn that throws leaves the read to the one-shot path", async () => {
    const spawn: SpawnAclLike = () => {
      throw new Error("no powershell");
    };
    const exec = fakeExec();
    const reader = createWindowsAclReader(exec, env, spawn);
    expect(() => reader.prewarm?.().release()).not.toThrow();
    expect((await reader.read(["a"])).currentUserSid).toBe(USER);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("a read of the other tier does not take the process, and release kills it", async () => {
    const { spawn, processes } = fakeSpawner();
    const exec = fakeExec();
    const reader = createWindowsAclReader(exec, env, spawn);
    const prewarm = reader.prewarm?.();
    await reader.read(["a"], "get-acl");
    expect(processes[0]?.killed).toBe(false);
    expect(processes[0]?.received).toBeUndefined();
    prewarm?.release();
    expect(processes[0]?.killed).toBe(true);
  });

  it("release after the read took the process is harmless, and release is idempotent", async () => {
    const { spawn, processes } = fakeSpawner();
    const reader = createWindowsAclReader(fakeExec(), env, spawn);
    const prewarm = reader.prewarm?.();
    await reader.read(["a"]);
    prewarm?.release();
    prewarm?.release();
    expect(processes).toHaveLength(1);
  });

  it("kills a process that never gets its paths after its own bound, and the read then spawns a fresh one", async () => {
    vi.useFakeTimers();
    const { spawn, processes } = fakeSpawner("answer", 0);
    const exec = fakeExec();
    const reader = createWindowsAclReader(exec, env, spawn);
    reader.prewarm?.();
    await vi.advanceTimersByTimeAsync(120_001);
    expect(processes[0]?.killed).toBe(true);
    const reading = reader.read(["a"]);
    await vi.advanceTimersByTimeAsync(1);
    expect((await reading).currentUserSid).toBe(USER);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  describe("falls back exactly like a read with no prewarm", () => {
    it("a process that died before it had paths: the read spawns again (one-shot) and succeeds", async () => {
      const { spawn, processes } = fakeSpawner("exit-1-at-start");
      const exec = fakeExec();
      const reader = createWindowsAclReader(exec, env, spawn);
      reader.prewarm?.();
      await new Promise((resolve) => setTimeout(resolve, 5));
      const report = await assertWindowsAcl(["a"], reader);
      expect(report).toMatchObject({ tier: "dotnet", attempts: [{ tier: "dotnet", ok: true }] });
      expect(report.prewarmMs).toBeUndefined();
      expect(exec).toHaveBeenCalledTimes(1);
      expect(processes[0]?.killed).toBe(true);
    });

    it("a process that exited cleanly without ever getting paths is a broken protocol: the read spawns again (one-shot)", async () => {
      const { spawn, processes } = fakeSpawner("exit-0-at-start");
      const exec = fakeExec();
      const reader = createWindowsAclReader(exec, env, spawn);
      reader.prewarm?.();
      await new Promise((resolve) => setTimeout(resolve, 5));
      const report = await assertWindowsAcl(["a"], reader);
      expect(report).toMatchObject({ tier: "dotnet", attempts: [{ tier: "dotnet", ok: true }] });
      expect(report.prewarmMs).toBeUndefined();
      expect(processes[0]?.received).toBeUndefined();
      expect(processes[0]?.killed).toBe(true);
      expect(exec).toHaveBeenCalledTimes(1);
    });

    it("Constrained Language Mode reported by the prewarmed process goes to tier two", async () => {
      const { spawn } = fakeSpawner("constrained-at-start");
      const exec = fakeExec();
      const reader = createWindowsAclReader(exec, env, spawn);
      reader.prewarm?.();
      await new Promise((resolve) => setTimeout(resolve, 5));
      const report = await assertWindowsAcl(["a"], reader);
      expect(report.tier).toBe("get-acl");
      expect(report.attempts.map((attempt) => [attempt.tier, attempt.ok, attempt.failure])).toEqual([
        ["dotnet", false, "constrained-language"],
        ["get-acl", true, undefined],
      ]);
      expect(exec.mock.calls.map((call) => call[0])).toEqual([`${SYSTEM32}\\whoami.exe`, POWERSHELL]);
    });

    it("Constrained Language Mode reported after the paths were sent goes to tier two as well", async () => {
      const { spawn } = fakeSpawner("constrained-after-paths", 10);
      const exec = fakeExec();
      const reader = createWindowsAclReader(exec, env, spawn);
      reader.prewarm?.();
      const report = await assertWindowsAcl(["a"], reader);
      expect(report.tier).toBe("get-acl");
      expect(report.attempts[0]).toMatchObject({ tier: "dotnet", ok: false, failure: "constrained-language" });
    });

    it("an error exit after the paths were sent is read again in a fresh process, as the one-shot read would be", async () => {
      const { spawn } = fakeSpawner("exit-1-after-paths");
      const exec = fakeExec();
      const reader = createWindowsAclReader(exec, env, spawn);
      reader.prewarm?.();
      await expect(reader.read(["a"])).resolves.toMatchObject({ currentUserSid: USER });
      expect(exec).toHaveBeenCalledTimes(1);
    });

    it("a prewarmed process that answers badly is read again in a fresh process", async () => {
      const { spawn, processes } = fakeSpawner("bad-output");
      const exec = fakeExec();
      const reader = createWindowsAclReader(exec, env, spawn);
      reader.prewarm?.();
      await expect(reader.read(["a"])).resolves.toMatchObject({ currentUserSid: USER });
      expect(exec).toHaveBeenCalledTimes(1);
      expect(processes[0]?.killed).toBe(true);
    });

    it("a hung process times out after the paths were delivered (20 s), is killed, and the retry spawns fresh", async () => {
      vi.useFakeTimers();
      const { spawn, processes } = fakeSpawner("hang");
      const exec = fakeExec();
      const reader = createWindowsAclReader(exec, env, spawn);
      reader.prewarm?.();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(processes[0]?.killed).toBe(false);
      const reporting = assertWindowsAcl(["a"], reader);
      await vi.advanceTimersByTimeAsync(19_999);
      expect(processes[0]?.killed).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      const report = await reporting;
      expect(processes[0]?.killed).toBe(true);
      expect(report.attempts.map((attempt) => [attempt.tier, attempt.ok, attempt.failure])).toEqual([
        ["dotnet", false, "timeout"],
        ["dotnet", true, undefined],
      ]);
      expect(exec).toHaveBeenCalledTimes(1);
    });
  });
});

describe("nodeSpawn", () => {
  const run = (script: string, maxBuffer = 1024) =>
    nodeSpawn(process.execPath, ["-e", script], { env: { PATH: process.env.PATH }, windowsHide: true, maxBuffer });

  it("feeds stdin after the start, reports the first output as ready and resolves with the standard output", async () => {
    const child = run(
      "process.stdout.write('ready\\n');let t='';process.stdin.on('data',c=>t+=c).on('end',()=>process.stdout.write(t.toUpperCase()))",
    );
    await child.ready;
    child.send("abc\n");
    await expect(child.exited).resolves.toEqual({ stdout: "ready\nABC\n" });
  });

  it("rejects with the exit code and the cleaned standard error of a failing process", async () => {
    const child = run("console.error('boom');process.exit(3)");
    await expect(child.exited).rejects.toMatchObject({ exitCode: 3, timedOut: false, stderr: "boom" });
  });

  it("rejects with the error code of a process that cannot start", async () => {
    const child = nodeSpawn("Z:\\no\\such\\powershell.exe", [], { env: {}, windowsHide: true, maxBuffer: 1024 });
    await expect(child.exited).rejects.toMatchObject({ errno: "ENOENT" });
  });

  it("kills a process that is still running, and ignores a write to one that is gone", async () => {
    const child = run("setInterval(()=>{},1000)");
    child.kill();
    await expect(child.exited).rejects.toMatchObject({ killed: true });
    expect(() => child.send("late\n")).not.toThrow();
  });

  it("survives the process closing its stdin: the write error is ignored and the exit is still reported", async () => {
    const child = run(
      "process.stdout.write('ready\\n');require('node:fs').closeSync(0);setTimeout(()=>process.stdout.write('done'),300)",
    );
    await child.ready;
    await new Promise((resolve) => setTimeout(resolve, 100));
    child.send("x".repeat(1_000_000));
    await expect(child.exited).resolves.toEqual({ stdout: "ready\ndone" });
  });

  it("kills a process whose output outgrows the buffer", async () => {
    const child = run("process.stdout.write('x'.repeat(5000));setInterval(()=>{},1000)", 100);
    await expect(child.exited).rejects.toMatchObject({ errno: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
  });
});
