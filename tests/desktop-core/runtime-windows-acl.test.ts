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
  cleanPowerShellStderr,
  createWindowsAclReader,
  nodeExec,
  parseSddl,
  parseWhoamiSid,
  type ExecFileFailure,
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

const PROFILE_SDDL = `O:${USER}G:DUD:PAI(A;OICI;FA;;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`;

function failure(overrides: Partial<ExecFileFailure> = {}): ExecFileFailure {
  return Object.assign(new Error("failed"), {
    killed: false,
    timedOut: false,
    elapsedMs: 100,
    timeoutMs: 20_000,
    stderr: "",
    ...overrides,
  });
}

const timeoutFailure = (timeoutMs: number) =>
  failure({ killed: true, signal: "SIGTERM", timedOut: true, elapsedMs: timeoutMs, timeoutMs });

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

  it.each([
    ["WD", "S-1-1-0"],
    ["CO", "S-1-3-0"],
    ["CG", "S-1-3-1"],
    ["OW", "S-1-3-4"],
    ["NU", "S-1-5-2"],
    ["IU", "S-1-5-4"],
    ["SU", "S-1-5-6"],
    ["AN", "S-1-5-7"],
    ["ED", "S-1-5-9"],
    ["PS", "S-1-5-10"],
    ["AU", "S-1-5-11"],
    ["RC", "S-1-5-12"],
    ["SY", "S-1-5-18"],
    ["LS", "S-1-5-19"],
    ["NS", "S-1-5-20"],
    ["WR", "S-1-5-33"],
    ["BA", "S-1-5-32-544"],
    ["BU", "S-1-5-32-545"],
    ["BG", "S-1-5-32-546"],
    ["PU", "S-1-5-32-547"],
    ["AO", "S-1-5-32-548"],
    ["SO", "S-1-5-32-549"],
    ["PO", "S-1-5-32-550"],
    ["BO", "S-1-5-32-551"],
    ["RE", "S-1-5-32-552"],
    ["RU", "S-1-5-32-554"],
    ["RD", "S-1-5-32-555"],
    ["NO", "S-1-5-32-556"],
    ["MU", "S-1-5-32-558"],
    ["LU", "S-1-5-32-559"],
    ["IS", "S-1-5-32-568"],
    ["CY", "S-1-5-32-569"],
    ["ER", "S-1-5-32-573"],
    ["CD", "S-1-5-32-574"],
    ["RA", "S-1-5-32-575"],
    ["ES", "S-1-5-32-576"],
    ["MS", "S-1-5-32-577"],
    ["HA", "S-1-5-32-578"],
    ["AA", "S-1-5-32-579"],
    ["RM", "S-1-5-32-580"],
    ["AC", "S-1-15-2-1"],
    ["LW", "S-1-16-4096"],
    ["ME", "S-1-16-8192"],
    ["MP", "S-1-16-8448"],
    ["HI", "S-1-16-12288"],
    ["SI", "S-1-16-16384"],
  ])("expands the fixed alias %s to %s and remembers the alias", (alias, sid) => {
    const parsed = parseSddl(`O:${alias}G:DUD:(A;;FR;;;${alias})`);
    expect(parsed).toMatchObject({ ownerSid: sid, ownerAlias: alias });
    expect(parsed.aces[0]).toMatchObject({ sid, alias });
  });

  it.each(["LA", "LG", "DA", "DU", "DG", "DC", "DD", "CA", "SA", "EA", "PA", "RS", "RO", "CN", "AP", "KA", "EK"])(
    "keeps the domain or machine relative alias %s as an unknown principal",
    (alias) => {
      const parsed = parseSddl(`O:BAG:DUD:(A;;FR;;;${alias})`);
      expect(parsed.aces[0]).toMatchObject({ sid: alias });
      expect(parsed.aces[0]?.alias).toBeUndefined();
    },
  );

  it("upper-cases a SID written in lower case, and fails closed on a principal that is neither SID nor alias", () => {
    expect(parseSddl(`O:${USER.toLowerCase()}G:DUD:(A;;FR;;;${USER.toLowerCase()})`).aces[0]?.sid).toBe(USER);
    for (const principal of ["bu", "S-1-", "S-2-5-18", "WORLD", "B", "S-1-5-18x"]) {
      expect(() => parseSddl(`O:BAG:DUD:(A;;FR;;;${principal})`)).toThrow(RangeError);
      expect(() => parseSddl(`O:${principal}G:DUD:(A;;FR;;;BA)`)).toThrow(RangeError);
    }
  });

  it("does not read an object property name as an alias", () => {
    expect(() => parseSddl("O:BAG:DUD:(A;;FR;;;constructor)")).toThrow(RangeError);
  });

  it("reads numeric rights, nested conditions and a SACL that follows", () => {
    const parsed = parseSddl(`O:BAG:SYD:AI(A;ID;0x1301bf;;;BU)(XA;;FA;;;WD;(Member_of{SID(BA)}))S:AI(AU;SA;FA;;;WD)`);
    expect(parsed.ownerSid).toBe("S-1-5-32-544");
    expect(parsed.aces.map((ace) => [ace.type, ace.rights, ace.sid])).toEqual([
      ["A", 0x1301bf, "S-1-5-32-545"],
      ["XA", 0x1f01ff, "S-1-1-0"],
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

  it.each([
    ["CREATOR OWNER", "CO"],
    ["OWNER RIGHTS", "OW"],
  ])("refuses %s as the owner although it may hold entries", (_name, owner) => {
    expect(problem(`O:${owner}G:DUD:PAI(A;;FA;;;${USER})`)).toContain("擁有者");
    expect(problem(`O:BAG:DUD:PAI(A;;FA;;;${owner})`)).toBeUndefined();
  });

  it.each([
    ["SYSTEM", "SY"],
    ["Administrators", "BA"],
    ["TrustedInstaller", "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"],
    ["the current user in lower case", USER.toLowerCase()],
  ])("accepts %s as the owner", (_name, owner) => {
    expect(problem(`O:${owner}G:DUD:PAI(A;;FA;;;${USER})`)).toBeUndefined();
  });

  it("names the SID, and the alias in parentheses, of the principal that holds the write right", () => {
    expect(problem(`O:${USER}G:DUD:PAI(A;OICI;0x1301bf;;;BU)`)).toBe("S-1-5-32-545 (BU) 擁有寫入權限（0x1301bf）");
    expect(problem(`O:${USER}G:DUD:PAI(A;;FA;;;S-1-5-32-545)`)).toBe("S-1-5-32-545 擁有寫入權限（0x1f01ff）");
    expect(problem(`O:BUG:DUD:PAI(A;;FA;;;${USER})`)).toContain("S-1-5-32-545 (BU)");
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
      { tier: "dotnet", ms: expect.any(Number), ok: false, failure: "invalid" },
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

  it("retries a timed-out tier once, and records both attempts", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(timeoutFailure(20_000))
      .mockResolvedValueOnce({ currentUserSid: USER, sddls: [PROFILE_SDDL] });
    const report = await assertWindowsAcl(["a"], { read });
    expect(report.tier).toBe("dotnet");
    expect(read.mock.calls.map((call) => call[1])).toEqual(["dotnet", "dotnet"]);
    expect(report.attempts).toEqual([
      { tier: "dotnet", ms: expect.any(Number), ok: false, failure: "timeout" },
      { tier: "dotnet", ms: expect.any(Number), ok: true },
    ]);
  });

  it("does not retry a failure that is not a timeout", async () => {
    const read = vi.fn<WindowsAclReader["read"]>(async (_paths, tier) =>
      tier === "dotnet" ? Promise.reject(failure({ exitCode: 1 })) : { currentUserSid: USER, sddls: [PROFILE_SDDL] },
    );
    const report = await assertWindowsAcl(["a"], { read });
    expect(read.mock.calls.map((call) => call[1])).toEqual(["dotnet", "get-acl"]);
    expect(report.attempts.map((attempt) => attempt.failure)).toEqual(["exit", undefined]);
  });

  it("retries each tier once and gives up with every reason when both keep timing out", async () => {
    const read = vi.fn<WindowsAclReader["read"]>(async (_paths, tier) =>
      Promise.reject(timeoutFailure(tier === "dotnet" ? 20_000 : 60_000)),
    );
    await expect(assertWindowsAcl(["a"], { read })).rejects.toMatchObject({
      code: "RUNTIME_ACL_UNREADABLE",
      detail: {
        actual:
          "dotnet: timeout after 20000 ms, then timeout after 20000 ms; get-acl: timeout after 60000 ms, then timeout after 60000 ms",
      },
    });
    expect(read).toHaveBeenCalledTimes(4);
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

describe("cleanPowerShellStderr", () => {
  const clixml = (...records: string[]) =>
    `#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">${records.join("")}</Objs>`;
  const errorRecord = (text: string) => `<S S="Error">${text}</S>`;

  it("keeps plain text, trimmed", () => {
    expect(cleanPowerShellStderr("  boom\r\n")).toBe("boom");
    expect(cleanPowerShellStderr("")).toBe("");
  });

  it("keeps only the Error elements of a CLIXML document, decoded, and drops progress records", () => {
    const text = clixml(
      '<Obj S="progress" RefId="0"><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparing modules</AV></PR></MS></Obj>',
      errorRecord("Get-Acl : Cannot find path &apos;C:\\x&apos; &lt;here&gt; &amp; &quot;there&quot;_x000D__x000A_"),
      errorRecord("At line:1 char:1_x000D__x000A_"),
    );
    expect(cleanPowerShellStderr(text)).toBe("Get-Acl : Cannot find path 'C:\\x' <here> & \"there\"\nAt line:1 char:1");
  });

  it("decodes other _xHHHH_ escapes", () => {
    expect(cleanPowerShellStderr(clixml(errorRecord("a_x0009_b_x4E2D_c")))).toBe("a\tb中c");
  });

  it("is empty for a CLIXML document without an error", () => {
    expect(cleanPowerShellStderr(clixml('<Obj S="progress" RefId="0"></Obj>'))).toBe("");
  });

  it("cuts long text to about 500 characters", () => {
    const cleaned = cleanPowerShellStderr("x".repeat(2_000));
    expect(cleaned).toHaveLength(501);
    expect(cleaned.endsWith("…")).toBe(true);
  });
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
    expect(args.slice(0, 6)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-InputFormat", "None", "-Command"]);
    expect(args.join(" ")).not.toContain("runtime");
    expect(options.env.WI_ACL_PATHS).toBe("C:\\Users\\me\\a b\\runtime|C:\\Users\\me\\x");
    expect(options.windowsHide).toBe(true);
    expect(options.timeout).toBe(20_000);
  });

  it("gives tier two its own, longer timeout for PowerShell, and whoami a timeout of its own", async () => {
    const exec = vi.fn<ExecFileLike>(async (file) =>
      file.endsWith("whoami.exe") ? output(`"HOST\\me","${USER}"`) : output(PROFILE_SDDL),
    );
    await createWindowsAclReader(exec, env).read(["a"], "get-acl");
    expect((exec.mock.calls as Call[]).map((call) => call[2].timeout)).toEqual([15_000, 60_000]);
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
    // Constrained Language Mode is detected by the exit code, before any method call, not by a localized message.
    expect(script.startsWith("$ProgressPreference='SilentlyContinue';$PSModuleAutoLoadingPreference='None';")).toBe(
      true,
    );
    expect(script).toContain("if($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage'){exit 3}");
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
    expect(script.startsWith("$ProgressPreference='SilentlyContinue';$PSModuleAutoLoadingPreference='None';")).toBe(
      true,
    );
    // The module is imported by absolute path, from $PSHOME, before Get-Acl runs: no auto-loading across PSModulePath.
    expect(script).toContain(
      "Import-Module -Name ($PSHOME + '\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1')",
    );
    expect(script).not.toContain("Join-Path");
    expect(script).toContain("Get-Acl -LiteralPath $p | ForEach-Object Sddl");
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
    expect(exec).toHaveBeenCalledTimes(2);
    for (const finish of pending) finish();
    await expect(reading).resolves.toEqual({ currentUserSid: USER, sddls: [PROFILE_SDDL] });
  });

  it("tier two reports whoami and PowerShell when both fail, and either one alone", async () => {
    const both: ExecFileLike = async (file) => {
      throw new Error(file.endsWith("whoami.exe") ? "whoami blocked" : "powershell blocked");
    };
    await expect(createWindowsAclReader(both, env).read(["a"], "get-acl")).rejects.toThrow(
      "powershell blocked; whoami: whoami blocked",
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
    await expect(createWindowsAclReader(noSid, env).read(["a"], "get-acl")).rejects.toThrow(
      "whoami: the current user's SID was not in the whoami output",
    );
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
          /dotnet: powershell blocked \(.* ms\); get-acl: powershell blocked; whoami: whoami blocked/,
        ),
      },
    });
  });

  it("reports Constrained Language Mode from tier one's exit code 3, whatever the localized stderr says", async () => {
    const exec = vi.fn<ExecFileLike>(async (file, args) => {
      if (file.endsWith("whoami.exe")) return output(`"HOST\\me","${USER}"`);
      if (args.at(-1)?.includes("GetAccessControl"))
        throw failure({ exitCode: 3, elapsedMs: 412.4, stderr: "ausgeschaltet" });
      return output(PROFILE_SDDL);
    });
    await expect(createWindowsAclReader(exec, env).read(["a"])).rejects.toMatchObject({
      kind: "constrained-language",
      message: "exit=3 (ConstrainedLanguage) 412 ms",
    });
    const report = await assertWindowsAcl(["a"], createWindowsAclReader(exec, env));
    expect(report.tier).toBe("get-acl");
    expect(report.attempts[0]).toMatchObject({ tier: "dotnet", ok: false, failure: "constrained-language" });
  });

  it("describes every failed tier and whoami as one line", async () => {
    const exec: ExecFileLike = async (file, args) => {
      if (file.endsWith("whoami.exe")) return output(`"HOST\\me","${USER}"`);
      if (args.at(-1)?.includes("GetAccessControl")) throw failure({ exitCode: 3, elapsedMs: 412 });
      throw timeoutFailure(60_000);
    };
    await expect(assertWindowsAcl(["a"], createWindowsAclReader(exec, env))).rejects.toMatchObject({
      code: "RUNTIME_ACL_UNREADABLE",
      detail: {
        actual: expect.stringMatching(
          /^dotnet: exit=3 \(ConstrainedLanguage\) 412 ms; get-acl: timeout after 60000 ms; whoami: ok \d+ ms, then timeout after 60000 ms; whoami: cached$/,
        ),
      },
    });
  });

  it("describes an exit code with its cleaned stderr and a spawn error, never with the command", async () => {
    const exit: ExecFileLike = async () => {
      throw failure({ exitCode: 1, elapsedMs: 12.6, stderr: "first line\nsecond line" });
    };
    await expect(createWindowsAclReader(exit, env).read(["a"])).rejects.toMatchObject({ exitCode: 1 });
    const outcome = await assertWindowsAcl(["a"], createWindowsAclReader(exit, env)).catch((error: unknown) => error);
    expect(outcome).toMatchObject({
      detail: { actual: expect.stringContaining("dotnet: exit=1 13 ms, stderr: first line | second line") },
    });
    const spawn: ExecFileLike = async () => {
      throw failure({ errno: "ENOENT", elapsedMs: 3 });
    };
    await expect(assertWindowsAcl(["a"], createWindowsAclReader(spawn, env))).rejects.toMatchObject({
      detail: { actual: expect.stringContaining("dotnet: ENOENT 3 ms") },
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

  it("the real process runner rejects with the facts of the failure and no command line", async () => {
    const error = await nodeExec("/wi-no-such-tool", ["--secret-script"], {
      env: {},
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 1024,
    }).then(
      () => undefined,
      (caught: ExecFileFailure) => caught,
    );
    if (error === undefined) throw new Error("the runner should have failed");
    expect(error).toMatchObject({ errno: "ENOENT", killed: false, timedOut: false, timeoutMs: 5_000, stderr: "" });
    expect(error.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(error.message).not.toContain("wi-no-such-tool");
    expect(error.message).not.toContain("secret-script");
  });

  it("the real process runner closes stdin and reports a timeout and an exit code", async () => {
    const run = (script: string, timeout: number) =>
      nodeExec(process.execPath, ["-e", script], { env: {}, timeout, windowsHide: true, maxBuffer: 1024 }).then(
        () => undefined,
        (caught: ExecFileFailure) => caught,
      );
    expect(
      await nodeExec(process.execPath, ["-e", "process.stdin.on('data',()=>{}).on('end',()=>console.log('closed'))"], {
        env: {},
        timeout: 20_000,
        windowsHide: true,
        maxBuffer: 1024,
      }),
    ).toMatchObject({ stdout: expect.stringContaining("closed") });
    expect(await run("process.stderr.write('oops');process.exit(7)", 20_000)).toMatchObject({
      exitCode: 7,
      timedOut: false,
      stderr: "oops",
    });
    expect(await run("setInterval(()=>{},1000)", 300)).toMatchObject({ timedOut: true, killed: true });
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

  // CI measured tier one at about 0.4 s and tier two at about 6 s, with a tail up to 28.7 s against a 30 s timeout.
  const REAL_READER_TIMEOUT_MS = 60_000;
  const DIAGNOSTIC_TIMEOUT_MS = 120_000;
  const SECURITY_MODULE = "$PSHOME + '\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1'";
  const PREFERENCES = "$ProgressPreference='SilentlyContinue';$PSModuleAutoLoadingPreference='None';";
  const execFileAsync = promisify(execFile);
  const childEnv = () => ({
    ...ps7Env,
    PSModulePath: path.win32.join(path.win32.dirname(windowsPowerShell(ps7Env)), "Modules"),
  });

  function spied() {
    const calls: string[] = [];
    const exec: ExecFileLike = (file, args, options) => {
      calls.push(args.at(-1)?.includes("GetAccessControl") ? "dotnet" : path.win32.basename(file));
      return nodeExec(file, args, options);
    };
    return { calls, reader: createWindowsAclReader(exec, ps7Env) };
  }

  async function timed<T>(steps: string[], label: string, step: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await step();
    } finally {
      steps.push(`${label}=${(performance.now() - started).toFixed(1)}ms`);
    }
  }

  const powerShell = (script: string, extraArguments: readonly string[] = []) =>
    execFileAsync(
      windowsPowerShell(ps7Env),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-InputFormat", "None", ...extraArguments, "-Command", script],
      { env: childEnv(), timeout: REAL_READER_TIMEOUT_MS },
    );

  it(
    "reads a locked directory with tier one under a PowerShell 7 module path, and both tiers agree",
    { timeout: REAL_READER_TIMEOUT_MS },
    async () => {
      const dir = await directory((created) => securePrivateDirectory(created));
      const steps: string[] = [];
      try {
        const timing = spied().reader;
        await timed(steps, "powershell-start", () => powerShell("$null"));
        await timed(steps, "import-module", () => powerShell(`Import-Module -Name (${SECURITY_MODULE})`));
        await timed(steps, "whoami", () =>
          execFileAsync(windowsSystemTool("whoami.exe"), ["/user", "/fo", "csv", "/nh"]),
        );
        await timed(steps, "tier-get-acl-cold", () => timing.read([dir], "get-acl"));
        await timed(steps, "tier-get-acl-warm", () => timing.read([dir], "get-acl"));
        await timed(steps, "tier-dotnet-cold", () => timing.read([dir], "dotnet"));
        await timed(steps, "tier-dotnet-warm", () => timing.read([dir], "dotnet"));
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
        console.info(`ACL steps: ${steps.join(" ")}`);
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
        await expect(assertWindowsAcl([dir], reader)).rejects.toMatchObject({
          code: "RUNTIME_UNSAFE_PERMISSIONS",
          detail: { actual: expect.stringContaining("S-1-5-32-545") },
        });
        expect(calls).toEqual(["dotnet"]);
        for (const tier of ["dotnet", "get-acl"] as const) {
          const snapshot = await reader.read([dir], tier);
          const descriptor = parseSddl(snapshot.sddls[0] as string);
          expect(descriptor.aces.some((ace) => ace.sid === "S-1-5-32-545")).toBe(true);
          expect(aclProblem(descriptor, { currentUserSid: snapshot.currentUserSid })).toContain("S-1-5-32-545");
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it(
    "tier two reads a locked directory through its explicit import with module auto-loading off",
    { timeout: REAL_READER_TIMEOUT_MS },
    async () => {
      const dir = await directory((created) => securePrivateDirectory(created));
      try {
        const inner = spied().reader;
        const onlyGetAcl: WindowsAclReader = {
          read: (paths, tier) => (tier === "dotnet" ? Promise.reject(new Error("skipped")) : inner.read(paths, tier)),
        };
        const report = await assertWindowsAcl([dir], onlyGetAcl);
        expect(report.tier).toBe("get-acl");
        expect(report.attempts.at(-1)).toMatchObject({ tier: "get-acl", ok: true });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it(
    "tier one runs with module auto-loading off and loads no module of its own",
    { timeout: REAL_READER_TIMEOUT_MS },
    async () => {
      const dir = await directory((created) => securePrivateDirectory(created));
      try {
        let captured: Parameters<ExecFileLike> | undefined;
        const capture: ExecFileLike = async (file, args, options) => {
          captured = [file, args, options];
          return nodeExec(file, args, options);
        };
        await createWindowsAclReader(capture, ps7Env).read([dir], "dotnet");
        const [file, args, options] = captured as Parameters<ExecFileLike>;
        const script = args.at(-1) as string;
        expect(script).toContain("$PSModuleAutoLoadingPreference='None'");
        const listing = "[Console]::Out.WriteLine('modules='+((Get-Module).Name -join ','))";
        const { stdout } = await execFileAsync(file, [...args.slice(0, -1), `${script};${listing}`], {
          env: options.env,
          timeout: REAL_READER_TIMEOUT_MS,
        });
        const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
        expect(lines).toHaveLength(3);
        expect(lines[0]).toBe(currentUserSid());
        // Nothing was auto-loaded: tier one calls only language constructs and .NET types.
        expect(lines[2]).toBe("modules=");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it(
    "prints a timing breakdown of PowerShell and Get-Acl (diagnostic)",
    { timeout: DIAGNOSTIC_TIMEOUT_MS },
    async () => {
      const steps: string[] = [];
      const stopwatch = (label: string) => `$o+='${label}='+$sw.ElapsedMilliseconds;`;
      const breakdown =
        "$sw=[Diagnostics.Stopwatch]::StartNew();$o=@();" +
        stopwatch("start") +
        `Import-Module -Name (${SECURITY_MODULE});` +
        stopwatch("import") +
        "$null=Get-Acl -LiteralPath $env:TEMP;" +
        stopwatch("get-acl-1") +
        "$null=Get-Acl -LiteralPath $env:TEMP;" +
        stopwatch("get-acl-2") +
        "$o+=('modules='+((Get-Module).Name -join ','));$o -join ' '";
      const tierTwo = `${PREFERENCES}Import-Module -Name (${SECURITY_MODULE});(Get-Acl -LiteralPath $env:TEMP).Sddl`;
      const tierOne =
        "$s=[Security.AccessControl.AccessControlSections]'Owner,Group,Access';" +
        "[Console]::Out.WriteLine([IO.Directory]::GetAccessControl($env:TEMP,$s).GetSecurityDescriptorSddlForm($s))";
      const attempt = async (label: string, run: () => Promise<{ stdout: string }>) => {
        try {
          await timed(steps, label, run);
        } catch (error) {
          steps.push(`${label}=FAILED(${String(error).slice(0, 120)})`);
        }
      };
      try {
        await attempt("breakdown", async () => {
          const result = await powerShell(breakdown);
          console.info(`ACL breakdown (ms): ${result.stdout.trim()}`);
          return result;
        });
        await attempt("tier2-policy-default", () => powerShell(tierTwo));
        await attempt("tier2-policy-bypass", () => powerShell(tierTwo, ["-ExecutionPolicy", "Bypass"]));
        await attempt("tier2-policy-restricted", () => powerShell(tierTwo, ["-ExecutionPolicy", "Restricted"]));
        await attempt("tier1-without-preferences", () => powerShell(tierOne));
        await attempt("tier1-with-preferences", () => powerShell(`${PREFERENCES}${tierOne}`));
        await attempt("tier1-without-preferences-again", () => powerShell(tierOne));
        await attempt("tier1-with-preferences-again", () => powerShell(`${PREFERENCES}${tierOne}`));
        await attempt("authenticode-security-psd1", () =>
          powerShell(
            `${PREFERENCES}Import-Module -Name (${SECURITY_MODULE});` +
              `$f=${SECURITY_MODULE};$sig=Get-AuthenticodeSignature -LiteralPath $f;[Console]::Out.WriteLine($sig.Status)`,
          ),
        );
      } finally {
        console.info(`ACL diagnostic: ${steps.join(" ")}`);
      }
    },
  );

  // Needs a machine with the PowerShell lockdown policy (see the Constrained Language Mode step of ci.yml).
  it.runIf(process.env.WI_ACL_CLM_TEST === "1")(
    "reads under Constrained Language Mode: tier one reports it by exit code 3, tier two answers",
    { timeout: 180_000 },
    async () => {
      const mode = (
        await execFileAsync(
          windowsPowerShell(),
          ["-NoProfile", "-Command", "$ExecutionContext.SessionState.LanguageMode"],
          {
            timeout: REAL_READER_TIMEOUT_MS,
          },
        )
      ).stdout.trim();
      if (mode !== "ConstrainedLanguage") {
        expect.fail(
          `a fresh powershell.exe reports ${mode}, not ConstrainedLanguage: the lockdown policy did not apply`,
        );
      }
      const dir = await directory((created) => securePrivateDirectory(created));
      try {
        const { reader } = spied();
        await expect(reader.read([dir], "dotnet")).rejects.toMatchObject({
          kind: "constrained-language",
          message: expect.stringContaining("exit=3 (ConstrainedLanguage)"),
        });
        const report = await assertWindowsAcl([dir], reader);
        expect(report.tier).toBe("get-acl");
        expect(report.attempts[0]).toMatchObject({ tier: "dotnet", ok: false, failure: "constrained-language" });
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
