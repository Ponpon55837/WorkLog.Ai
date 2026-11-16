import { describe, expect, it, vi } from "vitest";
import {
  aclProblem,
  assertWindowsAcl,
  createWindowsAclReader,
  parseSddl,
  type ExecFileLike,
  type WindowsAclReader,
} from "../../packages/desktop-core/src/runtime/index.js";

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
    await expect(assertWindowsAcl(["a", "b"], reader([PROFILE_SDDL, PROFILE_SDDL]))).resolves.toBeUndefined();
  });

  it("names the first object that is not", async () => {
    const bad = `O:${USER}G:DUD:PAI(A;;FA;;;${USER})(A;;FA;;;BU)`;
    await expect(assertWindowsAcl(["a", "b"], reader([PROFILE_SDDL, bad]))).rejects.toMatchObject({
      code: "RUNTIME_UNSAFE_PERMISSIONS",
      detail: { file: "b" },
    });
  });

  it("retries a failed read once and then reports the ACL as unreadable, not as unsafe", async () => {
    const read = vi.fn(async () => Promise.reject(new Error("timeout")));
    await expect(assertWindowsAcl(["a"], { read })).rejects.toMatchObject({ code: "RUNTIME_ACL_UNREADABLE" });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("succeeds when the second read works", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("blocked"))
      .mockResolvedValueOnce({ currentUserSid: USER, sddls: [PROFILE_SDDL] });
    await expect(assertWindowsAcl(["a"], { read })).resolves.toBeUndefined();
  });

  it.each([
    ["garbage", reader(["not sddl"])],
    ["an unknown right code", reader([`O:${USER}G:DUD:(A;;ZZ;;;BU)`])],
    ["the wrong number of ACLs", reader([PROFILE_SDDL, PROFILE_SDDL])],
  ])("fails closed on %s as unreadable", async (_name, failing) => {
    await expect(assertWindowsAcl(["a"], failing)).rejects.toMatchObject({ code: "RUNTIME_ACL_UNREADABLE" });
  });
});

describe("the Windows reader", () => {
  const env = { SystemRoot: "C:\\Windows", Path: "C:\\evil" };
  const output = (...lines: string[]) => ({ stdout: `${lines.join("\r\n")}\r\n` });

  it("runs PowerShell by absolute path, without a shell, with the paths in the environment, and reads the SID first", async () => {
    const exec = vi.fn<ExecFileLike>(async () => output(USER, PROFILE_SDDL, PROFILE_SDDL));
    const snapshot = await createWindowsAclReader(exec, env).read(["C:\\Users\\me\\a b\\runtime", "C:\\Users\\me\\x"]);
    expect(snapshot.currentUserSid).toBe(USER);
    expect(snapshot.sddls).toHaveLength(2);
    expect(exec).toHaveBeenCalledTimes(1);
    const [file, args, options] = exec.mock.calls[0] as Parameters<ExecFileLike>;
    expect(file).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    expect(args.join(" ")).not.toContain("runtime");
    expect(args.join(" ")).toContain("WindowsIdentity");
    expect(options.env.WI_ACL_PATHS).toBe("C:\\Users\\me\\a b\\runtime|C:\\Users\\me\\x");
    expect(options.windowsHide).toBe(true);
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
