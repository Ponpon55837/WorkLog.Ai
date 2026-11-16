import { execFile as nodeExecFile } from "node:child_process";
import path from "node:path";
import { RuntimeError } from "./errors.js";

/** One access control entry, reduced to what the trust decision needs. */
export interface ParsedAce {
  /** The SDDL ace type: `A` allow, `D` deny, `XA` callback allow, `ZA` ... */
  readonly type: string;
  /** Inheritance flag letters, e.g. `OICIIO`. */
  readonly flags: string;
  /** The access mask as a number; every right code of the SDDL text is expanded to its numeric value. */
  readonly rights: number;
  /** A full SID (`S-1-5-18`); the SDDL aliases this module knows are expanded, others stay as written (`BU`, `WD`). */
  readonly sid: string;
}

/** The owner and the entries of one descriptor. */
export interface ParsedSddl {
  readonly ownerSid: string;
  /** `D:NO_ACCESS_CONTROL`: no DACL at all, which grants everyone everything. */
  readonly nullDacl: boolean;
  readonly aces: readonly ParsedAce[];
}

/** The principals that may own and write the runtime: the current user plus the well-known system ones. */
export interface AclTrust {
  readonly currentUserSid: string;
}

/** What one read of the Windows security descriptors returns. */
export interface AclSnapshot {
  readonly currentUserSid: string;
  /** One SDDL string per requested path, in order. */
  readonly sddls: readonly string[];
}

/**
 * How the descriptors are read: `dotnet` calls the .NET security API directly (no module needed); `get-acl` runs the
 * `Get-Acl` cmdlet and `whoami`, for a PowerShell in Constrained Language Mode where method calls are refused.
 */
export type AclReadTier = "dotnet" | "get-acl";

/** One try of one read tier: how long it took (milliseconds, rounded to 0.1) and whether it read and parsed. */
export interface AclReadAttempt {
  readonly tier: AclReadTier;
  readonly ms: number;
  readonly ok: boolean;
}

/** Which tier answered an ACL check and what every tier tried cost; the evidence for the first-launch cost on Windows. */
export interface AclReadReport {
  /** The tier whose read was used. */
  readonly tier: AclReadTier;
  /** Every tier tried, in order; the last one is the successful `tier`. */
  readonly attempts: readonly AclReadAttempt[];
}

/** Reads the current user's SID and the SDDL of each path; injectable so tests need no Windows. */
export interface WindowsAclReader {
  read(paths: readonly string[], tier?: AclReadTier): Promise<AclSnapshot>;
}

/** What the fixed `execFile` seam needs; injectable so the reader is testable on any platform. */
export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly timeout: number;
    readonly windowsHide: true;
    readonly maxBuffer: number;
  },
) => Promise<{ readonly stdout: string }>;

const SID_ALIASES: Readonly<Record<string, string>> = {
  SY: "S-1-5-18",
  BA: "S-1-5-32-544",
  CO: "S-1-3-0",
  OW: "S-1-3-4",
};

/** SYSTEM, Administrators, CREATOR OWNER and OWNER RIGHTS may hold any right. */
const ALWAYS_TRUSTED = new Set(["S-1-5-18", "S-1-5-32-544", "S-1-3-0", "S-1-3-4"]);
const TRUSTED_INSTALLER = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
/** SDDL's alias for the local built-in administrator account, which is trusted only when it is the current user. */
const LOCAL_ADMIN_ALIAS = "LA";
const BUILTIN_ADMIN_RID_SUFFIX = /-500$/;

/**
 * The two-letter SDDL right codes with their numeric values (sddl.h). The directory-service codes (CC, DC, LC, SW, RP, WP,
 * DT, LO, CR) mean something else on a directory service object, but a file system ACL stores the same bits, where they
 * are FILE_WRITE_DATA (0x2), FILE_APPEND_DATA (0x4), FILE_WRITE_EA (0x10), ...: judging the numeric mask is what counts.
 */
const RIGHT_CODES: Readonly<Record<string, number>> = {
  CC: 0x1,
  DC: 0x2,
  LC: 0x4,
  SW: 0x8,
  RP: 0x10,
  WP: 0x20,
  DT: 0x40,
  LO: 0x80,
  CR: 0x100,
  SD: 0x10000,
  RC: 0x20000,
  WD: 0x40000,
  WO: 0x80000,
  GA: 0x10000000,
  GX: 0x20000000,
  GW: 0x40000000,
  GR: 0x80000000,
  FA: 0x1f01ff,
  FR: 0x120089,
  FW: 0x120116,
  FX: 0x1200a0,
  KA: 0xf003f,
  KR: 0x20019,
  KW: 0x20006,
  KX: 0x20019,
};

/**
 * Any right that lets a principal change the runtime: FILE_WRITE_DATA, FILE_APPEND_DATA, FILE_WRITE_EA, FILE_DELETE_CHILD,
 * FILE_WRITE_ATTRIBUTES, DELETE, WRITE_DAC, WRITE_OWNER, GENERIC_WRITE and GENERIC_ALL. Read, execute and traverse alone
 * are fine (`Read & execute` is 0x1200a9).
 */
const WRITE_MASK = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x40000000 | 0x10000000;

/** Ace types that only take rights away; every other type is treated as granting them. */
const DENY_TYPES: ReadonlySet<string> = new Set(["D", "OD", "XD", "ZD"]);

const ACL_TIMEOUT_MS = 10_000;
const ACL_MAX_BUFFER = 1024 * 1024;
const PATH_SEPARATOR = "|";
const PATHS_VARIABLE = "WI_ACL_PATHS";
const SID_PATTERN = /^S-1-\d+(?:-\d+)+$/;
const WHOAMI_SID_PATTERN = /"(S-1-\d+(?:-\d+)+)"\s*$/;
const DEFAULT_SYSTEM_ROOT = "C:\\Windows";
const POWERSHELL_ARGUMENTS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"] as const;
/** The only variables PowerShell inherits from the parent; the rest (PSModulePath, Path, ...) is set or left out. */
const INHERITED_VARIABLES = [
  "SystemRoot",
  "windir",
  "SystemDrive",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "ProgramData",
  "ProgramFiles",
  "USERNAME",
  "USERDOMAIN",
  "COMPUTERNAME",
  "PATHEXT",
  "ComSpec",
] as const;
/**
 * Tier 1, no cmdlets and so no module autoload: the first output line is the current user's SID, then one SDDL line per
 * path, from the .NET Framework security API of Windows PowerShell 5.1. The paths travel in an environment variable,
 * never in the command text, so no quoting can be abused.
 */
const DOTNET_SCRIPT =
  "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';try{$s=[Security.AccessControl.AccessControlSections]'Owner,Group,Access';" +
  "[Console]::Out.WriteLine([Security.Principal.WindowsIdentity]::GetCurrent().User.Value);" +
  "foreach($p in $env:WI_ACL_PATHS.Split('|')){" +
  "if([IO.Directory]::Exists($p)){$a=[IO.Directory]::GetAccessControl($p,$s)}else{$a=[IO.File]::GetAccessControl($p,$s)}" +
  "[Console]::Out.WriteLine($a.GetSecurityDescriptorSddlForm($s))}}" +
  "catch{[Console]::Error.WriteLine($_.Exception.Message);exit 1}";
/** Tier 2, for Constrained Language Mode, where tier 1's method calls fail: one SDDL line per path. */
const GET_ACL_SCRIPT =
  "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';foreach($p in $env:WI_ACL_PATHS.Split('|')){(Get-Acl -LiteralPath $p).Sddl}";

/** `execFile` (no shell: the arguments are an argv) as a promise. */
const nodeExec: ExecFileLike = (file, args, options) =>
  new Promise((resolve, reject) => {
    nodeExecFile(file, [...args], { ...options, encoding: "utf8" }, (error, stdout) =>
      error ? reject(error) : resolve({ stdout }),
    );
  });

function expandSid(token: string): string {
  return SID_ALIASES[token] ?? token;
}

/** The numeric mask of an SDDL rights string: hex, decimal, or concatenated two-letter codes. Throws on anything else. */
function parseRights(text: string): number {
  if (/^0x[0-9a-f]{1,8}$/i.test(text)) return Number.parseInt(text, 16) >>> 0;
  if (/^\d{1,10}$/.test(text)) return Number.parseInt(text, 10) >>> 0;
  if (text.length % 2 !== 0) throw new RangeError(`odd-length rights string "${text}"`);
  let rights = 0;
  for (let index = 0; index < text.length; index += 2) {
    const code = text.slice(index, index + 2);
    const value = RIGHT_CODES[code];
    if (value === undefined) throw new RangeError(`unknown right code "${code}"`);
    rights |= value;
  }
  return rights >>> 0;
}

/** The text of every top-level `( ... )` group of `text`; nested groups (conditions) stay inside their parent. */
function splitAces(text: string): string[] {
  const aces: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") {
      if (depth === 0) start = index + 1;
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) aces.push(text.slice(start, index));
      if (depth < 0) throw new RangeError("unbalanced parentheses in SDDL");
    }
  }
  if (depth !== 0) throw new RangeError("unbalanced parentheses in SDDL");
  return aces;
}

/**
 * Parses the `O:` owner and the `D:` entries of an SDDL string (the name-free form that `Get-Acl` returns in `.Sddl`).
 * Throws a RangeError for text that is not SDDL or has a right code it does not know, so the caller fails closed instead
 * of reading the unknown as "no rights".
 */
export function parseSddl(sddl: string): ParsedSddl {
  const text = sddl.trim();
  const owner = /^O:(.+?)(?=G:|D:|S:|$)/.exec(text)?.[1];
  const daclStart = text.indexOf("D:");
  if (!owner || daclStart < 0) throw new RangeError("not an SDDL string with an owner and a DACL");
  const afterDacl = text.slice(daclStart + 2);
  const saclStart = afterDacl.indexOf("S:");
  const daclBody = saclStart < 0 ? afterDacl : afterDacl.slice(0, saclStart);
  if (daclBody.includes("NO_ACCESS_CONTROL")) {
    return { ownerSid: expandSid(owner.trim()), nullDacl: true, aces: [] };
  }
  const aces: ParsedAce[] = [];
  for (const ace of splitAces(daclBody)) {
    const fields = ace.split(";");
    if (fields.length < 6) throw new RangeError("an access control entry has too few fields");
    aces.push({
      type: fields[0] as string,
      flags: fields[1] as string,
      rights: parseRights(fields[2] as string),
      sid: expandSid((fields[5] as string).trim()),
    });
  }
  return { ownerSid: expandSid(owner.trim()), nullDacl: false, aces };
}

function isTrusted(sid: string, trust: AclTrust): boolean {
  if (ALWAYS_TRUSTED.has(sid) || sid === TRUSTED_INSTALLER) return true;
  if (sid.toUpperCase() === trust.currentUserSid.toUpperCase()) return true;
  return sid === LOCAL_ADMIN_ALIAS && BUILTIN_ADMIN_RID_SUFFIX.test(trust.currentUserSid);
}

/**
 * Why a descriptor cannot be trusted, or undefined: a missing DACL (everyone may do everything), an owner (who can
 * always rewrite the ACL) that is not the current user, SYSTEM or Administrators, or any granting entry with a write
 * right for another principal. Only the deny types D, OD, XD and ZD are skipped; every other type counts as a grant.
 * An inheritance-only entry is NOT ignored: it does not apply to the object itself but it is copied to every child
 * created or re-inherited later. Entries are judged by SID, never by name, so a localized Windows reads the same.
 */
export function aclProblem(descriptor: ParsedSddl, trust: AclTrust): string | undefined {
  if (descriptor.nullDacl) return "沒有存取控制清單（DACL 為空），任何人都能寫入";
  if (!isTrusted(descriptor.ownerSid, trust)) {
    return `擁有者是 ${descriptor.ownerSid}，不是目前使用者、SYSTEM 或 Administrators`;
  }
  for (const ace of descriptor.aces) {
    if (DENY_TYPES.has(ace.type)) continue;
    if ((ace.rights & WRITE_MASK) === 0) continue;
    if (!isTrusted(ace.sid, trust)) return `${ace.sid} 擁有寫入權限（0x${ace.rights.toString(16)}）`;
  }
  return undefined;
}

/** The SID in the output of `whoami /user /fo csv /nh` (`"HOST\\user","S-1-5-21-..."`), read from its last non-empty line. */
export function parseWhoamiSid(output: string): string {
  const lastLine = output
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .pop();
  const sid = WHOAMI_SID_PATTERN.exec(lastLine ?? "")?.[1];
  if (sid === undefined) throw new RangeError("the current user's SID was not in the whoami output");
  return sid;
}

/**
 * The environment of the child PowerShell: only the allow-listed variables copied from the parent (names matched
 * case-insensitively), then a module path, a search path and the ACL paths set here. A parent's PSModulePath (PowerShell 7
 * entries make Windows PowerShell 5.1 fail to load its own modules) and Path never reach the child. One key per name.
 */
function powerShellEnvironment(env: NodeJS.ProcessEnv, paths: readonly string[]): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const name of INHERITED_VARIABLES) {
    const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    const value = key === undefined ? undefined : env[key];
    if (value !== undefined) child[name] = value;
  }
  const systemRoot = child.SystemRoot ?? DEFAULT_SYSTEM_ROOT;
  const powerShellDirectory = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0");
  child.PSModulePath = path.win32.join(powerShellDirectory, "Modules");
  child.Path = [path.win32.join(systemRoot, "System32"), systemRoot, powerShellDirectory].join(";");
  child[PATHS_VARIABLE] = paths.join(PATH_SEPARATOR);
  return child;
}

function systemRootOf(env: NodeJS.ProcessEnv): string {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === "systemroot");
  return (key === undefined ? undefined : env[key]) || DEFAULT_SYSTEM_ROOT;
}

/**
 * The real reader. Both tiers start Windows PowerShell 5.1 by absolute path, without a shell, in a clean environment (see
 * powerShellEnvironment), and fail on any error, a malformed SID or a wrong line count. Tier `dotnet` is the default.
 * Tier `get-acl` takes the SID from `whoami` (cached for this reader) because it must not call .NET methods.
 */
export function createWindowsAclReader(
  exec: ExecFileLike = nodeExec,
  env: NodeJS.ProcessEnv = process.env,
): WindowsAclReader {
  const systemDirectory = path.win32.join(systemRootOf(env), "System32");
  let whoamiSid: string | undefined;

  const run = (file: string, args: readonly string[], childEnv: NodeJS.ProcessEnv) =>
    exec(file, args, { env: childEnv, timeout: ACL_TIMEOUT_MS, windowsHide: true, maxBuffer: ACL_MAX_BUFFER });

  const runPowerShell = (script: string, paths: readonly string[]) =>
    run(
      path.win32.join(systemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe"),
      [...POWERSHELL_ARGUMENTS, script],
      powerShellEnvironment(env, paths),
    );

  // PowerShell may still write a serialized progress record ("#< CLIXML" then one `<Objs …>` line) to stdout on the first
  // use of a module; it is never an SID or SDDL line, so it is dropped before the line count is checked.
  const lines = (stdout: string) =>
    stdout.split(/\r?\n/).filter((line) => line.trim() !== "" && !/^(#< CLIXML|<Objs\b)/.test(line.trim()));

  return {
    read: async (paths, tier = "dotnet") => {
      if (tier === "get-acl") {
        whoamiSid ??= parseWhoamiSid(
          (
            await run(
              path.win32.join(systemDirectory, "whoami.exe"),
              ["/user", "/fo", "csv", "/nh"],
              powerShellEnvironment(env, []),
            )
          ).stdout,
        );
        const sddls = lines((await runPowerShell(GET_ACL_SCRIPT, paths)).stdout);
        if (sddls.length !== paths.length) throw new RangeError("unexpected number of ACLs returned");
        return { currentUserSid: whoamiSid, sddls };
      }
      const output = lines((await runPowerShell(DOTNET_SCRIPT, paths)).stdout);
      const currentUserSid = output.shift()?.trim() ?? "";
      if (!SID_PATTERN.test(currentUserSid)) throw new RangeError("the current user's SID was not returned");
      if (output.length !== paths.length) throw new RangeError("unexpected number of ACLs returned");
      return { currentUserSid, sddls: output };
    },
  };
}

async function readAndParse(
  paths: readonly string[],
  reader: WindowsAclReader,
  tier: AclReadTier,
): Promise<{ descriptors: ParsedSddl[]; trust: AclTrust }> {
  const snapshot = await reader.read(paths, tier);
  if (snapshot.sddls.length !== paths.length) throw new RangeError("unexpected number of ACLs returned");
  return {
    descriptors: snapshot.sddls.map((sddl) => parseSddl(sddl)),
    trust: { currentUserSid: snapshot.currentUserSid },
  };
}

const roundMs = (ms: number) => Math.round(ms * 10) / 10;

/** `readAndParse` that records its duration and outcome in `attempts`. */
async function timedReadAndParse(
  paths: readonly string[],
  reader: WindowsAclReader,
  tier: AclReadTier,
  attempts: AclReadAttempt[],
): Promise<Awaited<ReturnType<typeof readAndParse>>> {
  const started = performance.now();
  try {
    const result = await readAndParse(paths, reader, tier);
    attempts.push({ tier, ms: roundMs(performance.now() - started), ok: true });
    return result;
  } catch (error) {
    attempts.push({ tier, ms: roundMs(performance.now() - started), ok: false });
    throw error;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Checks the ACL of every path. The descriptors are read with the .NET API first and, only when that read or its parse
 * fails (spawn error, timeout, bad output, Constrained Language Mode), with `Get-Acl`; when both fail the result is
 * RUNTIME_ACL_UNREADABLE with both messages: an ACL that cannot be read is not trusted, and it is not a reason to
 * reinstall. A verdict is final: the first object owned or writable by someone other than the trusted principals throws
 * RUNTIME_UNSAFE_PERMISSIONS and the second tier is never asked. The owner is part of the check, which is why no tier
 * reads the DACL alone. The report says which tier answered and how long each tier took (the error detail of an
 * unreadable ACL carries the same durations).
 */
export async function assertWindowsAcl(paths: readonly string[], reader: WindowsAclReader): Promise<AclReadReport> {
  const attempts: AclReadAttempt[] = [];
  let read: Awaited<ReturnType<typeof readAndParse>>;
  try {
    read = await timedReadAndParse(paths, reader, "dotnet", attempts);
  } catch (dotnetError) {
    try {
      read = await timedReadAndParse(paths, reader, "get-acl", attempts);
    } catch (getAclError) {
      const [dotnet, getAcl] = attempts;
      throw new RuntimeError(
        "RUNTIME_ACL_UNREADABLE",
        "無法讀取 Windows 存取控制清單（ACL），無法確認 runtime 安全；PowerShell 可能被原則封鎖",
        {
          actual: `dotnet: ${messageOf(dotnetError)} (${dotnet?.ms} ms); get-acl: ${messageOf(getAclError)} (${getAcl?.ms} ms)`,
        },
        { cause: getAclError },
      );
    }
  }
  for (const [index, descriptor] of read.descriptors.entries()) {
    const problem = aclProblem(descriptor, read.trust);
    if (problem !== undefined) {
      throw new RuntimeError("RUNTIME_UNSAFE_PERMISSIONS", "launcher 或 runtime 的 Windows 存取權限不安全", {
        file: paths[index] as string,
        actual: problem,
      });
    }
  }
  return { tier: attempts[attempts.length - 1]?.tier as AclReadTier, attempts };
}
