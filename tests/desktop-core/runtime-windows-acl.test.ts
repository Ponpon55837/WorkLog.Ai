import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  aclProblem,
  assertWindowsAcl,
  createWindowsAclReader,
  parseSddl,
  parseWhoamiSid,
  type ExecFileLike,
  type WindowsAclReader,
} from "../../packages/desktop-core/src/runtime/index.js";
import { windowsPowerShell, windowsSystemTool } from "../../packages/shared/src/windows-system-tool.js";
import {
  allowBuiltinUsersToWrite,
  currentUserSid,
  securePrivateDirectory,
} from "../../scripts/desktop-runtime-spike/secure-directory.mjs";

const USER = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const OTHER = "S-1-5-21-1111111111-2222222222-3333333333-1002";
const TRUST = { currentUserSid: USER };

/** What `Get-Acl` returns for a profile folder: the user, SYSTEM and Administrators with full control. */
const PROFILE_SDDL = `O:${USER}G:DUD:PAI(A;OICI;FA;;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`;

function reader(sddls: readonly string[], sid = USER): WindowsAclReader {
  return { read: async () => ({ currentUserSid: sid, sddls }) };
}

describe("parseSddl", () => {
  it("reads the owner and every allow entry, expanding the aliases it knows", () => {
    const parsed = parseSddl(PROFILE_SDDL);
    expect(parsed.ownerSid).toBe(USER);
    expect(parsed.aces.map((ace) => ace.sid)).toEqual([USER, "S-1-5-18", "S-1-5-32-544"]);
    expect(parsed.aces[0]).toMatchObject({ type: "A", flags: "OICI", rights: 0x1f01ff });
  });

  it("reads numeric rights, nested conditions and a SACL that follows", () => {
    const parsed = parseSddl(`O:BAG:SYD:AI(A;ID;0x1301bf;;;BU)(XA;;FA;;;WD;(Member_of{SID(BA)}))S:AI(AU;SA;FA;;;WD)`);
    expect(parsed.ownerSid).toBe("S-1-5-32-544");
    expect(parsed.aces.map((ace) => [ace.type, ace.rights, ace.sid])).toEqual([
      ["A", 0x1301bf, "BU"],
      ["XA", 0x1f01ff, "WD"],
    ]);
  });

  it.each(["", "hello", "D:(A;;FA;;;BA)", "O:BAG:SYD:(A;;FA;BA)", "O:BAD:(A;;FA;;;BA"])("rejects %j", (text) => {
    expect(() => parseSddl(text)).toThrow(RangeError);
  });
});

describe("aclProblem", () => {
  const problem = (sddl: string) => aclProblem(parseSddl(sddl), TRUST);

  it("accepts the user, SYSTEM, Administrators, CREATOR OWNER and an Administrators owner", () => {
    expect(problem(PROFILE_SDDL)).toBeUndefined();
    expect(problem("O:BAG:SYD:PAI(A;OICIIO;FA;;;CO)(A;;FA;;;BA)")).toBeUndefined();
  });

  it("accepts read and execute for anyone", () => {
    expect(problem(`O:${USER}G:DUD:PAI(A;OICI;0x1200a9;;;BU)(A;;FRFX;;;WD)(A;;GR;;;AU)`)).toBeUndefined();
  });

  it.each([
    ["Users modify", "(A;OICI;0x1301bf;;;BU)"],
    ["Everyone full control", "(A;;FA;;;WD)"],
    ["Authenticated Users file write", "(A;;FW;;;AU)"],
    ["another user, generic write", `(A;;GW;;;${OTHER})`],
    ["write DAC only", "(A;;WD;;;BU)"],
    ["write owner only", "(A;;WO;;;BU)"],
    ["delete only", "(A;;SD;;;BU)"],
    ["append only (subdirectory)", "(A;;0x4;;;BU)"],
    ["an inherit-only grant that reaches every child", "(A;OICIIO;FA;;;BU)"],
    ["a callback allow", "(XA;;FA;;;BU;(Member_of{SID(BA)}))"],
  ])("rejects %s", (_name, ace) => {
    expect(problem(`O:${USER}G:DUD:PAI(A;;FA;;;${USER})${ace}`)).toContain("寫入權限");
  });

  it("ignores deny entries, which only subtract", () => {
    expect(problem(`O:${USER}G:DUD:PAI(D;;FA;;;BU)(A;;FA;;;${USER})`)).toBeUndefined();
  });

  it.each([
    ["another user", OTHER],
    ["Users", "BU"],
    ["Everyone", "WD"],
  ])("rejects an owner that is %s", (_name, owner) => {
    expect(problem(`O:${owner}G:DUD:PAI(A;;FA;;;${USER})`)).toContain("擁有者");
  });

  it("compares SIDs, never names, so the Windows display language does not matter", () => {
    expect(aclProblem(parseSddl(PROFILE_SDDL), { currentUserSid: USER.toLowerCase() })).toBeUndefined();
    expect(aclProblem(parseSddl(PROFILE_SDDL), { currentUserSid: OTHER })).toContain("擁有者");
  });
});

describe("rights codes and ACE types", () => {
  const problem = (ace: string, sddl = `O:${USER}G:DUD:PAI(A;;FA;;;${USER})`) =>
    aclProblem(parseSddl(`${sddl}${ace}`), TRUST);

  it.each([
    ["DC (FILE_WRITE_DATA)", "(A;;DC;;;BU)"],
    ["LC (FILE_APPEND_DATA)", "(A;;LC;;;BU)"],
    ["KW (key write, 0x20006)", "(A;;KW;;;BU)"],
    ["KR (0x20019 carries the 0x10 bit, FILE_WRITE_EA on a file)", "(A;;KR;;;BU)"],
    ["RP (0x10, FILE_WRITE_EA)", "(A;;RP;;;WD)"],
    ["DT (FILE_DELETE_CHILD)", "(A;;DT;;;BU)"],
    ["CR (FILE_WRITE_ATTRIBUTES)", "(A;;CR;;;BU)"],
    ["hex 0x2", "(A;;0x2;;;BU)"],
    ["hex 0x100", "(A;;0x100;;;BU)"],
    ["GW", "(A;;GW;;;BU)"],
    ["a callback object allow", "(ZA;;FA;;;WD;;)"],
    ["an object allow", "(OA;;FA;;;WD)"],
    ["an unknown allow type", "(QA;;FA;;;WD)"],
  ])("refuses %s for another principal", (_name, ace) => {
    expect(problem(ace)).toContain("寫入權限");
  });

  it.each([
    ["FR", "(A;;FR;;;BU)"],
    ["FRFX", "(A;;FRFX;;;BU)"],
    ["read and execute mask", "(A;;0x1200a9;;;BU)"],
    ["GR GX", "(A;;GRGX;;;WD)"],
    ["a deny of everything", "(D;;FA;;;BU)"],
    ["an object deny", "(OD;;FA;;;BU)"],
    ["a callback deny", "(XD;;FA;;;BU;(x))"],
    ["a zero deny", "(ZD;;FA;;;BU;;)"],
  ])("accepts %s", (_name, ace) => {
    expect(problem(ace)).toBeUndefined();
  });

  it("refuses a null DACL, which grants everyone everything", () => {
    expect(aclProblem(parseSddl(`O:${USER}G:DUD:NO_ACCESS_CONTROL`), TRUST)).toContain("DACL");
  });

  it.each(["(A;;FA;;;WD)", "(A;;0xffffffff;;;WD)", "(A;OICI;0x1f01ff;;;WD)"])(
    "refuses the Everyone full-access entry %s that a null DACL can render as",
    (ace) => {
      expect(aclProblem(parseSddl(`O:${USER}G:DUD:${ace}`), TRUST)).toContain("寫入權限");
    },
  );

  it("cannot read a descriptor that has an owner but no DACL section at all", () => {
    expect(() => parseSddl(`O:${USER}G:DU`)).toThrow(RangeError);
  });

  it("accepts an empty DACL (nobody but the owner)", () => {
    expect(aclProblem(parseSddl(`O:${USER}G:DUD:P`), TRUST)).toBeUndefined();
  });

  it.each(["(A;;ZZ;;;BU)", "(A;;FAX;;;BU)", "(A;;0xZZ;;;BU)"])("throws on the unreadable right in %s", (ace) => {
    expect(() => parseSddl(`O:${USER}G:DUD:${ace}`)).toThrow(RangeError);
  });

  it("trusts the local administrator alias only when the current user is that account", () => {
    const sddl = parseSddl(`O:LAG:DUD:PAI(A;;FA;;;LA)`);
    expect(aclProblem(sddl, { currentUserSid: "S-1-5-21-1-2-3-500" })).toBeUndefined();
    expect(aclProblem(sddl, TRUST)).toContain("擁有者");
    expect(aclProblem(parseSddl(`O:BAG:DUD:PAI(A;;FA;;;DA)`), { currentUserSid: "S-1-5-21-1-2-3-500" })).toContain(
      "DA",
    );
  });
});

describe("assertWindowsAcl", () => {
  it("passes when every object is trusted", async () => {
    await expect(assertWindowsAcl(["a", "b"], reader([PROFILE_SDDL, PROFILE_SDDL]))).resolves.toMatchObject({
      tier: "dotnet",
    });
  });

  it("reports one successful dotnet attempt when the first tier reads", async () => {
    const report = await assertWindowsAcl(["a"], reader([PROFILE_SDDL]));
    expect(report.tier).toBe("dotnet");
    expect(report.attempts).toEqual([{ tier: "dotnet", ms: expect.any(Number), ok: true }]);
    expect(report.attempts[0]?.ms).toBeGreaterThanOrEqual(0);
  });

  it("reports both attempts, the failed dotnet one first, when get-acl answers", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("blocked"))
      .mockResolvedValueOnce({ currentUserSid: USER, sddls: [PROFILE_SDDL] });
    const report = await assertWindowsAcl(["a"], { read });
    expect(report.tier).toBe("get-acl");
    expect(report.attempts).toEqual([
      { tier: "dotnet", ms: expect.any(Number), ok: false },
      { tier: "get-acl", ms: expect.any(Number), ok: true },
    ]);
    for (const attempt of report.attempts) expect(attempt.ms).toBeGreaterThanOrEqual(0);
  });

  it("names the first object that is not", async () => {
    const bad = `O:${USER}G:DUD:PAI(A;;FA;;;${USER})(A;;FA;;;BU)`;
    await expect(assertWindowsAcl(["a", "b"], reader([PROFILE_SDDL, bad]))).rejects.toMatchObject({
      code: "RUNTIME_UNSAFE_PERMISSIONS",
      detail: { file: "b" },
    });
  });

  it("asks the second tier when the first cannot read, then reports both failures as unreadable, not unsafe", async () => {
    const read = vi.fn<WindowsAclReader["read"]>(async (_paths, tier) => Promise.reject(new Error(`${tier} failed`)));
    await expect(assertWindowsAcl(["a"], { read })).rejects.toMatchObject({
      code: "RUNTIME_ACL_UNREADABLE",
      detail: {
        actual: expect.stringMatching(
          /^dotnet: dotnet failed \(\d+(\.\d)? ms\); get-acl: get-acl failed \(\d+(\.\d)? ms\)$/,
        ),
      },
    });
    expect(read.mock.calls.map((call) => call[1])).toEqual(["dotnet", "get-acl"]);
  });

  it("describes a thrown non-error", async () => {
    const read = async () => Promise.reject("plain text");
    await expect(assertWindowsAcl(["a"], { read })).rejects.toMatchObject({
      detail: { actual: expect.stringMatching(/^dotnet: plain text \(.* ms\); get-acl: plain text \(.* ms\)$/) },
    });
  });

  it("succeeds when the second tier works", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("blocked"))
      .mockResolvedValueOnce({ currentUserSid: USER, sddls: [PROFILE_SDDL] });
    await expect(assertWindowsAcl(["a"], { read })).resolves.toMatchObject({ tier: "get-acl" });
  });

  it("never asks the second tier after an unsafe verdict from the first", async () => {
    const bad = `O:${USER}G:DUD:PAI(A;;FA;;;${USER})(A;;FA;;;BU)`;
    const read = vi.fn(async () => ({ currentUserSid: USER, sddls: [bad] }));
    await expect(assertWindowsAcl(["a"], { read })).rejects.toMatchObject({ code: "RUNTIME_UNSAFE_PERMISSIONS" });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["garbage", reader(["not sddl"])],
    ["an unknown right code", reader([`O:${USER}G:DUD:(A;;ZZ;;;BU)`])],
    ["the wrong number of ACLs", reader([PROFILE_SDDL, PROFILE_SDDL])],
  ])("fails closed on %s as unreadable", async (_name, failing) => {
    await expect(assertWindowsAcl(["a"], failing)).rejects.toMatchObject({ code: "RUNTIME_ACL_UNREADABLE" });
  });
});

describe("parseWhoamiSid", () => {
  it.each([
    ["the csv line", `"HOST\\me","${USER}"\r\n`],
    ["a header line before it", `"User Name","SID"\r\n"HOST\\me","${USER}"\r\n\r\n`],
    ["a non-ASCII account name", `"主機\\使用者 é","${USER}"`],
  ])("reads the SID from %s", (_name, output) => {
    expect(parseWhoamiSid(output)).toBe(USER);
  });

  it.each(["", "ERROR: nothing", `"HOST\\me","${USER}"\r\nERROR: later`, `"HOST\\me","S-1-"`])(
    "throws on %j",
    (output) => {
      expect(() => parseWhoamiSid(output)).toThrow(RangeError);
    },
  );
});

describe("the Windows reader", () => {
  const SYSTEM32 = "C:\\Windows\\System32";
  const POWERSHELL = `${SYSTEM32}\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const env = { SystemRoot: "C:\\Windows", Path: "C:\\evil" };
  const output = (...lines: string[]) => ({ stdout: `${lines.join("\r\n")}\r\n` });
  type Call = Parameters<ExecFileLike>;

  it("runs PowerShell by absolute path, without a shell, with the paths in the environment, and reads the SID first", async () => {
    const exec = vi.fn<ExecFileLike>(async () => output(USER, PROFILE_SDDL, PROFILE_SDDL));
    const snapshot = await createWindowsAclReader(exec, env).read(["C:\\Users\\me\\a b\\runtime", "C:\\Users\\me\\x"]);
    expect(snapshot.currentUserSid).toBe(USER);
    expect(snapshot.sddls).toHaveLength(2);
    expect(exec).toHaveBeenCalledTimes(1);
    const [file, args, options] = exec.mock.calls[0] as Call;
    expect(file).toBe(POWERSHELL);
    expect(args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    expect(args.join(" ")).not.toContain("runtime");
    expect(options.env.WI_ACL_PATHS).toBe("C:\\Users\\me\\a b\\runtime|C:\\Users\\me\\x");
    expect(options.windowsHide).toBe(true);
    expect(options.timeout).toBe(10_000);
  });

  it("gives tier two its own, longer timeout for PowerShell and for whoami", async () => {
    const exec = vi.fn<ExecFileLike>(async (file) =>
      file.endsWith("whoami.exe") ? output(`"HOST\\me","${USER}"`) : output(PROFILE_SDDL),
    );
    await createWindowsAclReader(exec, env).read(["a"], "get-acl");
    expect((exec.mock.calls as Call[]).map((call) => call[2].timeout)).toEqual([30_000, 30_000]);
  });

  it("starts PowerShell with an allow-listed environment and its own module path", async () => {
    const exec = vi.fn<ExecFileLike>(async () => output(USER, PROFILE_SDDL));
    const parent = {
      SYSTEMROOT: "C:\\Windows",
      Path: "C:\\evil",
      PSMODULEPATH: "C:\\Program Files\\PowerShell\\7\\Modules",
      PSModulePath: "x",
      TEMP: "C:\\Temp",
      FOO: "bar",
    };
    await createWindowsAclReader(exec, parent).read(["a"]);
    const childEnv = (exec.mock.calls[0] as Call)[2].env;
    const moduleKeys = Object.keys(childEnv).filter((key) => /^psmodulepath$/i.test(key));
    expect(moduleKeys).toHaveLength(1);
    expect(childEnv[moduleKeys[0] as string]).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules");
    expect(childEnv.FOO).toBeUndefined();
    expect(childEnv.SystemRoot).toBe("C:\\Windows");
    expect(childEnv.TEMP).toBe("C:\\Temp");
    expect(Object.keys(childEnv).filter((key) => /^path$/i.test(key))).toEqual(["Path"]);
    expect(childEnv.Path).toBe("C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0");
    expect(childEnv.WI_ACL_PATHS).toBe("a");
  });

  it("falls back to C:\\Windows when the parent has no SystemRoot", async () => {
    const exec = vi.fn<ExecFileLike>(async () => output(USER, PROFILE_SDDL));
    await createWindowsAclReader(exec, {}).read(["a"]);
    expect((exec.mock.calls[0] as Call)[0]).toBe(POWERSHELL);
  });

  it("tier one calls the .NET API and no cmdlet, so no module has to load", async () => {
    const exec = vi.fn<ExecFileLike>(async () => output(USER, PROFILE_SDDL));
    await createWindowsAclReader(exec, env).read(["a"]);
    const script = (exec.mock.calls[0] as Call)[1].at(-1) as string;
    expect(script).toContain("GetAccessControl");
    expect(script).not.toMatch(/Get-Acl|Get-Item/);
  });

  it("tier two runs Get-Acl and takes the SID from whoami, once per reader", async () => {
    const exec = vi.fn<ExecFileLike>(async (file) =>
      file.endsWith("whoami.exe") ? output(`"HOST\\me","${USER}"`) : output(PROFILE_SDDL),
    );
    const reader = createWindowsAclReader(exec, env);
    expect(await reader.read(["a"], "get-acl")).toEqual({ currentUserSid: USER, sddls: [PROFILE_SDDL] });
    await reader.read(["a"], "get-acl");
    const calls = exec.mock.calls as Call[];
    expect(calls.map((call) => call[0])).toEqual([`${SYSTEM32}\\whoami.exe`, POWERSHELL, POWERSHELL]);
    expect(calls[0]?.[1]).toEqual(["/user", "/fo", "csv", "/nh"]);
    const script = calls[1]?.[1].at(-1) as string;
    expect(script).toContain("Get-Acl -LiteralPath");
    expect(script).toContain("$ErrorActionPreference='Stop'");
    // The module is imported by absolute path, from $PSHOME, before Get-Acl runs: no auto-loading across PSModulePath.
    expect(script).toContain(
      "Import-Module -Name (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1')",
    );
    expect(script.indexOf("Import-Module")).toBeLessThan(script.indexOf("Get-Acl"));
    expect(calls[1]?.[2].env.FOO).toBeUndefined();
  });

  it("tier two starts whoami and PowerShell together, and does not ask whoami again after it answered", async () => {
    const pending: Array<() => void> = [];
    const exec = vi.fn<ExecFileLike>(
      (file) =>
        new Promise((resolve) => {
          pending.push(() =>
            resolve(file.endsWith("whoami.exe") ? output(`"HOST\\me","${USER}"`) : output(PROFILE_SDDL)),
          );
        }),
    );
    const reading = createWindowsAclReader(exec, env).read(["a"], "get-acl");
    // Neither process has finished, and both were started.
    expect(exec).toHaveBeenCalledTimes(2);
    for (const finish of pending) finish();
    await expect(reading).resolves.toEqual({ currentUserSid: USER, sddls: [PROFILE_SDDL] });
  });

  it("tier two reports whoami and PowerShell when both fail, and either one alone", async () => {
    const both: ExecFileLike = async (file) => {
      throw new Error(file.endsWith("whoami.exe") ? "whoami blocked" : "powershell blocked");
    };
    await expect(createWindowsAclReader(both, env).read(["a"], "get-acl")).rejects.toThrow(
      "whoami: whoami blocked; powershell: powershell blocked",
    );
    const onlyWhoami: ExecFileLike = async (file) => {
      if (file.endsWith("whoami.exe")) throw new Error("whoami blocked");
      return output(PROFILE_SDDL);
    };
    await expect(createWindowsAclReader(onlyWhoami, env).read(["a"], "get-acl")).rejects.toThrow("whoami blocked");
    const onlyPowerShell: ExecFileLike = async (file) => {
      if (!file.endsWith("whoami.exe")) throw new Error("powershell blocked");
      return output(`"HOST\\me","${USER}"`);
    };
    await expect(createWindowsAclReader(onlyPowerShell, env).read(["a"], "get-acl")).rejects.toThrow(
      "powershell blocked",
    );
  });

  it("ignores a CLIXML progress record on stdout and silences progress in both scripts", async () => {
    const clixml =
      '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T></TN><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparing modules for first use.</AV></PR></MS></Obj></Objs>\r\n';
    const exec = vi.fn<ExecFileLike>(async (file) =>
      file.endsWith("whoami.exe") ? output(`"HOST\\me","${USER}"`) : output(`${clixml}${PROFILE_SDDL}\r\n`),
    );
    const reader = createWindowsAclReader(exec, env);
    expect(await reader.read(["a"], "get-acl")).toEqual({ currentUserSid: USER, sddls: [PROFILE_SDDL] });
    const dotnet = vi.fn<ExecFileLike>(async () => output(`${clixml}${USER}\r\n${PROFILE_SDDL}\r\n`));
    expect(await createWindowsAclReader(dotnet, env).read(["a"])).toEqual({
      currentUserSid: USER,
      sddls: [PROFILE_SDDL],
    });
    for (const call of [...(exec.mock.calls as Call[]), ...(dotnet.mock.calls as Call[])]) {
      if (call[0] === POWERSHELL) expect(call[1].at(-1)).toContain("$ProgressPreference='SilentlyContinue'");
    }
  });

  it("tier two fails on a wrong ACL count and on whoami output without a SID", async () => {
    const wrongCount: ExecFileLike = async (file) =>
      file.endsWith("whoami.exe") ? output(`"HOST\\me","${USER}"`) : output(PROFILE_SDDL);
    await expect(createWindowsAclReader(wrongCount, env).read(["a", "b"], "get-acl")).rejects.toThrow(RangeError);
    const noSid: ExecFileLike = async () => output("garbage");
    await expect(createWindowsAclReader(noSid, env).read(["a"], "get-acl")).rejects.toThrow(RangeError);
  });

  it("through assertWindowsAcl, a tier one module error leads to tier two", async () => {
    const exec = vi.fn<ExecFileLike>(async (file, args) => {
      if (file.endsWith("whoami.exe")) return output(`"HOST\\me","${USER}"`);
      if (args.at(-1)?.includes("GetAccessControl")) throw new Error("the module could not be loaded");
      return output(PROFILE_SDDL);
    });
    await expect(assertWindowsAcl(["a"], createWindowsAclReader(exec, env))).resolves.toMatchObject({
      tier: "get-acl",
    });
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it("through assertWindowsAcl, both tiers failing reports both messages", async () => {
    const exec: ExecFileLike = async (file) => {
      throw new Error(file.endsWith("whoami.exe") ? "whoami blocked" : "powershell blocked");
    };
    await expect(assertWindowsAcl(["a"], createWindowsAclReader(exec, env))).rejects.toMatchObject({
      code: "RUNTIME_ACL_UNREADABLE",
      detail: {
        actual: expect.stringMatching(
          /dotnet: powershell blocked .*; get-acl: whoami: whoami blocked; powershell: powershell blocked/,
        ),
      },
    });
  });

  it("fails when PowerShell returns a different number of ACLs than paths", async () => {
    const exec: ExecFileLike = async () => output(USER, PROFILE_SDDL);
    await expect(createWindowsAclReader(exec, env).read(["a", "b"])).rejects.toThrow(RangeError);
  });

  it("fails when the first line is not a SID", async () => {
    const exec: ExecFileLike = async () => output("DESKTOP\\me", PROFILE_SDDL);
    await expect(createWindowsAclReader(exec, env).read(["a"])).rejects.toThrow(RangeError);
  });

  it("uses the real process runner by default and reports a tool that cannot be started", async () => {
    // A system root that does not exist on any machine: the runner is exercised without ever starting PowerShell.
    await expect(
      createWindowsAclReader(undefined, { SystemRoot: "Z:\\wi-no-such-root" }).read(["a"]),
    ).rejects.toThrow();
  });
});

describe.runIf(process.platform === "win32")("the real Windows reader (Windows only)", () => {
  const PS7_MODULES = "C:\\Program Files\\PowerShell\\7\\Modules;C:\\Program Files\\PowerShell\\Modules;";
  const ps7Env = { ...process.env, PSModulePath: `${PS7_MODULES}${process.env.PSModulePath ?? ""}` };

  async function directory(prepare: (dir: string) => void): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wi-acl-"));
    prepare(dir);
    return dir;
  }

  /**
   * CI measured tier two (Get-Acl, then whoami) at 5 to 10 s before the security module was imported by path, which
   * overran vitest's 5 s default; the real-reader tests get a generous limit and print where the time goes.
   */
  const REAL_READER_TIMEOUT_MS = 60_000;
  const execFileAsync = promisify(execFile);

  function spied() {
    const calls: string[] = [];
    const exec: ExecFileLike = async (file, args, options) => {
      calls.push(args.at(-1)?.includes("GetAccessControl") ? "dotnet" : path.win32.basename(file));
      return { stdout: (await execFileAsync(file, [...args], { env: options.env, timeout: options.timeout })).stdout };
    };
    return { calls, reader: createWindowsAclReader(exec, ps7Env) };
  }

  async function timed(label: string, step: () => Promise<unknown>): Promise<string> {
    const started = performance.now();
    await step();
    return `${label}=${(performance.now() - started).toFixed(1)}ms`;
  }

  it(
    "reads a locked directory with tier one under a PowerShell 7 module path, and both tiers agree",
    { timeout: REAL_READER_TIMEOUT_MS },
    async () => {
      const dir = await directory((created) => securePrivateDirectory(created));
      try {
        // CI evidence for the first-launch cost, one line per step so the log shows the bottleneck.
        const powerShell = windowsPowerShell(ps7Env);
        const run = (script: string) => () =>
          execFileAsync(powerShell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
            env: { ...ps7Env, PSModulePath: path.win32.join(path.win32.dirname(powerShell), "Modules") },
          });
        const importModule =
          "Import-Module -Name (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1')";
        const timing = spied().reader;
        console.info(
          `ACL steps: ${[
            await timed("powershell-start", run("$null")),
            await timed("import-module", run(importModule)),
            await timed("whoami", () => execFileAsync(windowsSystemTool("whoami.exe"), ["/user", "/fo", "csv", "/nh"])),
            await timed("tier-get-acl-cold", () => timing.read([dir], "get-acl")),
            await timed("tier-get-acl-warm", () => timing.read([dir], "get-acl")),
            await timed("tier-dotnet-cold", () => timing.read([dir], "dotnet")),
            await timed("tier-dotnet-warm", () => timing.read([dir], "dotnet")),
          ].join(" ")}`,
        );
        const { calls, reader } = spied();
        const report = await assertWindowsAcl([dir], reader);
        expect(report.tier).toBe("dotnet");
        expect(calls).toEqual(["dotnet"]);
        const first = await reader.read([dir], "dotnet");
        const second = await reader.read([dir], "get-acl");
        expect(second.currentUserSid).toBe(first.currentUserSid);
        expect(second.currentUserSid).toBe(currentUserSid());
        expect(
          aclProblem(parseSddl(second.sddls[0] as string), { currentUserSid: second.currentUserSid }),
        ).toBeUndefined();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it(
    "refuses a directory BUILTIN\\Users can write, with either tier",
    { timeout: REAL_READER_TIMEOUT_MS },
    async () => {
      const dir = await directory((created) => allowBuiltinUsersToWrite(securePrivateDirectory(created)));
      try {
        const { calls, reader } = spied();
        await expect(assertWindowsAcl([dir], reader)).rejects.toMatchObject({ code: "RUNTIME_UNSAFE_PERMISSIONS" });
        expect(calls).toEqual(["dotnet"]);
        const second = await reader.read([dir], "get-acl");
        expect(aclProblem(parseSddl(second.sddls[0] as string), { currentUserSid: second.currentUserSid })).toContain(
          "S-1-5-32-545",
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it(
    "reproduces the bug: the old inherited-environment Get-Acl call fails when PowerShell 7 modules lead PSModulePath",
    { timeout: REAL_READER_TIMEOUT_MS },
    async () => {
      // Informative, not a gate: it only says something where PowerShell 7 is installed.
      const ps7 = "C:\\Program Files\\PowerShell\\7";
      const exec = (): string =>
        execFileSync(
          windowsPowerShell(),
          ["-NoProfile", "-NonInteractive", "-Command", "(Get-Acl -LiteralPath $env:TEMP).Sddl"],
          { env: ps7Env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 },
        );
      if (!existsSync(ps7)) return;
      let failure = "";
      try {
        exec();
      } catch (error) {
        failure = String((error as { stderr?: unknown }).stderr ?? error);
      }
      console.info(
        failure === "" ? "old command still works on this runner" : `old command fails: ${failure.slice(0, 200)}`,
      );
    },
  );
});
