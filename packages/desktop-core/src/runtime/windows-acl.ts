import { execFile as nodeExecFile, spawn as nodeSpawnProcess, type ExecFileException } from "node:child_process";
import path from "node:path";
import {
  windowsPowerShell,
  windowsSystem32Directory,
  windowsSystemRoot,
  windowsSystemTool,
} from "@work-intelligence/shared/windows-system-tool";
import { RuntimeError } from "./errors.js";

export interface ParsedAce {
  readonly type: string;
  readonly flags: string;
  readonly rights: number;
  /** A full upper-case SID; domain- and machine-relative aliases (`DA`, `LA`, ...) cannot be expanded and stay two letters: unknown, never trusted. */
  readonly sid: string;
  readonly alias?: string;
}

export interface ParsedSddl {
  readonly ownerSid: string;
  readonly ownerAlias?: string;
  /** `D:NO_ACCESS_CONTROL`: no DACL at all, which grants everyone everything. */
  readonly nullDacl: boolean;
  readonly aces: readonly ParsedAce[];
}

export interface AclTrust {
  readonly currentUserSid: string;
}

export interface AclSnapshot {
  readonly currentUserSid: string;
  readonly sddls: readonly string[];
  readonly prewarmMs?: number;
}

export type AclReadTier = "dotnet" | "get-acl";

export type AclFailureKind = "timeout" | "exit" | "spawn" | "constrained-language" | "invalid";

export interface AclReadAttempt {
  readonly tier: AclReadTier;
  readonly ms: number;
  readonly ok: boolean;
  readonly failure?: AclFailureKind;
}

export interface AclReadReport {
  readonly tier: AclReadTier;
  readonly attempts: readonly AclReadAttempt[];
  readonly prewarmMs?: number;
}

/** `release` kills the process unless a read took it over; a second `prewarm()` shares the one process, and any `release()` ends it for all. */
export interface AclPrewarm {
  release(): void;
}

export interface WindowsAclReader {
  read(paths: readonly string[], tier?: AclReadTier): Promise<AclSnapshot>;
  /** Starts the tier-1 PowerShell now (about 2 s cold) so its start-up overlaps the caller's work. Never throws. */
  prewarm?(): AclPrewarm;
}

export interface ExecFileFailure extends Error {
  readonly exitCode?: number;
  readonly errno?: string;
  readonly signal?: string;
  readonly killed: boolean;
  readonly timedOut: boolean;
  readonly elapsedMs: number;
  readonly timeoutMs: number;
  readonly stderr: string;
}

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

export interface AclChild {
  readonly exited: Promise<{ readonly stdout: string }>;
  readonly ready: Promise<void>;
  send(input: string): void;
  kill(): void;
}

export type SpawnAclLike = (
  file: string,
  args: readonly string[],
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly windowsHide: true;
    readonly maxBuffer: number;
  },
) => AclChild;

interface PrewarmedProcess {
  read(paths: readonly string[]): Promise<string>;
  readyMs(): number | undefined;
  kill(): void;
}

interface TierFailure extends Error {
  readonly kind: AclFailureKind;
}

/** Domain- and machine-relative aliases are deliberately absent: they need the domain or machine id, so they stay unknown and untrusted. */
const SID_ALIASES: Readonly<Record<string, string>> = {
  WD: "S-1-1-0",
  CO: "S-1-3-0",
  CG: "S-1-3-1",
  OW: "S-1-3-4",
  NU: "S-1-5-2",
  IU: "S-1-5-4",
  SU: "S-1-5-6",
  AN: "S-1-5-7",
  ED: "S-1-5-9",
  PS: "S-1-5-10",
  AU: "S-1-5-11",
  RC: "S-1-5-12",
  SY: "S-1-5-18",
  LS: "S-1-5-19",
  NS: "S-1-5-20",
  WR: "S-1-5-33",
  BA: "S-1-5-32-544",
  BU: "S-1-5-32-545",
  BG: "S-1-5-32-546",
  PU: "S-1-5-32-547",
  AO: "S-1-5-32-548",
  SO: "S-1-5-32-549",
  PO: "S-1-5-32-550",
  BO: "S-1-5-32-551",
  RE: "S-1-5-32-552",
  RU: "S-1-5-32-554",
  RD: "S-1-5-32-555",
  NO: "S-1-5-32-556",
  MU: "S-1-5-32-558",
  LU: "S-1-5-32-559",
  IS: "S-1-5-32-568",
  CY: "S-1-5-32-569",
  ER: "S-1-5-32-573",
  CD: "S-1-5-32-574",
  RA: "S-1-5-32-575",
  ES: "S-1-5-32-576",
  MS: "S-1-5-32-577",
  HA: "S-1-5-32-578",
  AA: "S-1-5-32-579",
  RM: "S-1-5-32-580",
  AC: "S-1-15-2-1",
  LW: "S-1-16-4096",
  ME: "S-1-16-8192",
  MP: "S-1-16-8448",
  HI: "S-1-16-12288",
  SI: "S-1-16-16384",
};

const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";
const CREATOR_OWNER_SID = "S-1-3-0";
const OWNER_RIGHTS_SID = "S-1-3-4";
const TRUSTED_INSTALLER_SID = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
const TRUSTED_WRITERS: ReadonlySet<string> = new Set([
  SYSTEM_SID,
  ADMINISTRATORS_SID,
  TRUSTED_INSTALLER_SID,
  CREATOR_OWNER_SID,
  OWNER_RIGHTS_SID,
]);
/** The owner can always rewrite the ACL, so it is narrower: CREATOR OWNER and OWNER RIGHTS are placeholders, never an owner. */
const TRUSTED_OWNERS: ReadonlySet<string> = new Set([SYSTEM_SID, ADMINISTRATORS_SID, TRUSTED_INSTALLER_SID]);
const LOCAL_ADMIN_ALIAS = "LA";
const BUILTIN_ADMIN_RID_SUFFIX = /-500$/;
const SDDL_SID_FIELD = /^S-1-\d+(?:-\d+)+$/i;
const SDDL_ALIAS_FIELD = /^[A-Z]{2}$/;

/**
 * The directory-service codes (CC, DC, LC, SW, RP, WP, DT, LO, CR) mean something else on a directory object, but a file
 * ACL stores the same bits (FILE_WRITE_DATA, ...): the numeric mask is what is judged.
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

/** Read, execute and traverse alone are fine (`Read & execute` is 0x1200a9); any other right can change the runtime. */
const WRITE_MASK = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x40000000 | 0x10000000;

const DENY_TYPES: ReadonlySet<string> = new Set(["D", "OD", "XD", "ZD"]);

/** CI (windows-latest) measured tier 1 at about 0.4 s and tier 2 at about 6 s, with a tail up to 28.7 s. A timeout is retried once (the second start is warm). */
const DOTNET_TIMEOUT_MS = 20_000;
const GET_ACL_TIMEOUT_MS = 60_000;
const WHOAMI_TIMEOUT_MS = 15_000;
/** Tier 1 exits with this code when the session is not in Full Language Mode (Constrained Language Mode). */
const CONSTRAINED_LANGUAGE_EXIT_CODE = 3;
const TIMEOUT_RETRIES = 1;
const ACL_MAX_BUFFER = 1024 * 1024;
/** Only bounds a caller that never gets to the read; the read then spawns a fresh process. */
const PREWARM_IDLE_LIMIT_MS = 120_000;
const PATH_SEPARATOR = "|";
const PATHS_VARIABLE = "WI_ACL_PATHS";
const SID_PATTERN = /^S-1-\d+(?:-\d+)+$/;
const WHOAMI_SID_PATTERN = /"(S-1-\d+(?:-\d+)+)"\s*$/;
const POWERSHELL_ARGUMENTS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-InputFormat", "None", "-Command"] as const;
/** The prewarmed process reads its paths from stdin, so it must not be started with `-InputFormat None`. */
const PREWARM_ARGUMENTS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"] as const;
const STDERR_LIMIT = 500;
const CLIXML_HEADER = "#< CLIXML";
const CLIXML_ERROR_ELEMENT = /<S S="Error">([\s\S]*?)<\/S>/g;
const XML_ENTITIES: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
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
/** No CLIXML progress records and no module auto-loading (it scans the PSModulePath); plain assignments, so allowed in Constrained Language Mode. */
const SCRIPT_PREFERENCES = "$ProgressPreference='SilentlyContinue';$PSModuleAutoLoadingPreference='None';";
/**
 * Tier 1 must stay cmdlet-free (no module autoload). The paths travel in an environment variable, never in the command
 * text, so no quoting can be abused. Outside Full Language Mode it exits with CONSTRAINED_LANGUAGE_EXIT_CODE instead of a localized error.
 */
const DOTNET_HEAD =
  `${SCRIPT_PREFERENCES}if($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage'){exit 3};` +
  "$ErrorActionPreference='Stop';try{$s=[Security.AccessControl.AccessControlSections]'Owner,Group,Access';" +
  "[Console]::Out.WriteLine([Security.Principal.WindowsIdentity]::GetCurrent().User.Value);";
const DOTNET_READ_ONE =
  "if([IO.Directory]::Exists($p)){$a=[IO.Directory]::GetAccessControl($p,$s)}else{$a=[IO.File]::GetAccessControl($p,$s)}" +
  "[Console]::Out.WriteLine($a.GetSecurityDescriptorSddlForm($s))";
const DOTNET_TAIL = "}catch{[Console]::Error.WriteLine($_.Exception.Message);exit 1}";
const DOTNET_SCRIPT = `${DOTNET_HEAD}foreach($p in $env:WI_ACL_PATHS.Split('|')){${DOTNET_READ_ONE}}${DOTNET_TAIL}`;
/** Paths arrive on stdin, one per line as Base64 of UTF-8, so the transport is ASCII whatever the console code page. A dead parent closes stdin. */
const DOTNET_STDIN_SCRIPT =
  `${DOTNET_HEAD}$e=[Text.Encoding]::UTF8;` +
  "while($null -ne ($l=[Console]::In.ReadLine())){if($l.Length -eq 0){continue};" +
  `$p=$e.GetString([Convert]::FromBase64String($l));${DOTNET_READ_ONE}}${DOTNET_TAIL}`;
/**
 * Tier 2 (Constrained Language Mode). The security module is imported by absolute path first: auto-loading would analyse
 * every module on the PSModulePath. Before the import only language constructs and Microsoft.PowerShell.Core cmdlets (no `Join-Path`).
 */
const GET_ACL_SCRIPT =
  `${SCRIPT_PREFERENCES}$ErrorActionPreference='Stop';` +
  "Import-Module -Name ($PSHOME + '\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1');" +
  "foreach($p in $env:WI_ACL_PATHS.Split('|')){Get-Acl -LiteralPath $p | ForEach-Object Sddl}";

function isExecFailure(error: unknown): error is ExecFileFailure {
  const candidate = error as Partial<ExecFileFailure>;
  return error instanceof Error && typeof candidate.timedOut === "boolean" && typeof candidate.elapsedMs === "number";
}

function describeExecFailure(
  failure: Pick<ExecFileFailure, "exitCode" | "errno" | "signal" | "timedOut" | "elapsedMs" | "timeoutMs" | "stderr">,
  meaning?: string,
): string {
  const elapsed = `${Math.round(failure.elapsedMs)} ms`;
  let head = `failed ${elapsed}`;
  if (failure.timedOut) head = `timeout after ${failure.timeoutMs} ms`;
  else if (failure.exitCode !== undefined)
    head = `exit=${failure.exitCode}${meaning ? ` (${meaning})` : ""} ${elapsed}`;
  else if (failure.errno !== undefined) head = `${failure.errno} ${elapsed}`;
  else if (failure.signal !== undefined) head = `signal=${failure.signal} ${elapsed}`;
  const stderr = failure.stderr.replace(/\s*\n\s*/g, " | ");
  return stderr === "" || meaning ? head : `${head}, stderr: ${stderr}`;
}

function tierFailure(message: string, kind: AclFailureKind): TierFailure {
  return Object.assign(new Error(message), { kind });
}

function isTierFailure(error: unknown): error is TierFailure {
  return error instanceof Error && typeof (error as Partial<TierFailure>).kind === "string";
}

function failureKindOf(error: unknown): AclFailureKind {
  if (isTierFailure(error)) return error.kind;
  if (!isExecFailure(error)) return "invalid";
  if (error.timedOut) return "timeout";
  return error.exitCode === undefined ? "spawn" : "exit";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeFailure(error: unknown, ms: number): string {
  if (isExecFailure(error)) return describeExecFailure(error);
  return isTierFailure(error) ? error.message : `${messageOf(error)} (${ms} ms)`;
}

function describePart(error: unknown): string {
  return isExecFailure(error) ? describeExecFailure(error) : messageOf(error);
}

function decodeClixml(text: string): string {
  return text
    .replace(/&(lt|gt|amp|quot|apos);/g, (_match, name: string) => XML_ENTITIES[name] as string)
    .replace(/_x([0-9a-fA-F]{4})_/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** Windows PowerShell writes errors to stderr as CLIXML when redirected; keeps the `<S S="Error">` text, decoded. */
export function cleanPowerShellStderr(raw: string): string {
  const text = raw.trim();
  const cleaned = text.startsWith(CLIXML_HEADER)
    ? [...text.matchAll(CLIXML_ERROR_ELEMENT)].map((match) => decodeClixml(match[1] as string)).join("")
    : text;
  const normalized = cleaned.replace(/\r\n/g, "\n").trim();
  return normalized.length > STDERR_LIMIT ? `${normalized.slice(0, STDERR_LIMIT)}…` : normalized;
}

function execFailure(error: ExecFileException, stderr: string, elapsedMs: number, timeoutMs: number): ExecFileFailure {
  const killed = error.killed === true;
  const signal = error.signal ?? undefined;
  const failure = {
    exitCode: typeof error.code === "number" ? error.code : undefined,
    errno: typeof error.code === "string" ? error.code : undefined,
    signal,
    killed,
    timedOut: (killed && signal === "SIGTERM") || elapsedMs >= timeoutMs,
    elapsedMs,
    timeoutMs,
    stderr: cleanPowerShellStderr(stderr),
  };
  return Object.assign(new Error(""), failure, { message: describeExecFailure(failure) });
}

export const nodeExec: ExecFileLike = (file, args, options) =>
  new Promise((resolve, reject) => {
    const started = performance.now();
    const child = nodeExecFile(file, [...args], { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(execFailure(error, stderr, performance.now() - started, options.timeout));
      else resolve({ stdout });
    });
    // Destroy the pipe: the child reads end of input at once, and unlike `end()` no pending write can fail with EPIPE.
    child.stdin?.destroy();
  });

function timeoutFailure(elapsedMs: number, timeoutMs: number): ExecFileFailure {
  const failure = {
    exitCode: undefined,
    errno: undefined,
    signal: "SIGTERM",
    killed: true,
    timedOut: true,
    elapsedMs,
    timeoutMs,
    stderr: "",
  };
  return Object.assign(new Error(""), failure, { message: describeExecFailure(failure) });
}

/** No shell; a write to an already-exited process is ignored. Timeouts are the caller's: this never kills by time. */
export const nodeSpawn: SpawnAclLike = (file, args, options) => {
  const started = performance.now();
  const child = nodeSpawnProcess(file, [...args], { env: options.env, windowsHide: true });
  let stdout = "";
  let stderr = "";
  let overflowed = false;
  let signalReady: () => void;
  const ready = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    signalReady();
    stdout += chunk;
    if (stdout.length > options.maxBuffer && !overflowed) {
      overflowed = true;
      child.kill();
    }
  });
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < options.maxBuffer) stderr += chunk;
  });
  child.stdin.on("error", () => undefined);
  const exited = new Promise<{ readonly stdout: string }>((resolve, reject) => {
    const fail = (exitCode: number | null, errno: string | undefined, signal: string | null) => {
      const failure = {
        exitCode: exitCode ?? undefined,
        errno,
        signal: signal ?? undefined,
        killed: child.killed,
        timedOut: false,
        elapsedMs: performance.now() - started,
        timeoutMs: 0,
        stderr: cleanPowerShellStderr(stderr),
      };
      reject(Object.assign(new Error(""), failure, { message: describeExecFailure(failure) }));
    };
    child.once("error", (error: NodeJS.ErrnoException) => fail(null, error.code ?? error.name, null));
    child.once("close", (code, signal) => {
      if (overflowed) fail(null, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", signal);
      else if (code === 0) resolve({ stdout });
      else fail(code, undefined, signal);
    });
  });
  return {
    exited,
    ready,
    send: (input) => {
      child.stdin.end(input);
    },
    kill: () => {
      child.kill();
    },
  };
};

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

function normalizePrincipal(field: string): { readonly sid: string; readonly alias?: string } {
  const token = field.trim();
  if (Object.hasOwn(SID_ALIASES, token)) return { sid: SID_ALIASES[token] as string, alias: token };
  if (SDDL_SID_FIELD.test(token)) return { sid: token.toUpperCase() };
  if (SDDL_ALIAS_FIELD.test(token)) return { sid: token };
  throw new RangeError(`unrecognized principal "${token}"`);
}

/** Throws RangeError for anything it does not know, so the caller fails closed instead of reading it as "no rights". */
export function parseSddl(sddl: string): ParsedSddl {
  const text = sddl.trim();
  const owner = /^O:(.+?)(?=G:|D:|S:|$)/.exec(text)?.[1];
  const daclStart = text.indexOf("D:");
  if (!owner || daclStart < 0) throw new RangeError("not an SDDL string with an owner and a DACL");
  const { sid: ownerSid, alias: ownerAlias } = normalizePrincipal(owner);
  const ownerFields = ownerAlias === undefined ? { ownerSid } : { ownerSid, ownerAlias };
  const afterDacl = text.slice(daclStart + 2);
  const saclStart = afterDacl.indexOf("S:");
  const daclBody = saclStart < 0 ? afterDacl : afterDacl.slice(0, saclStart);
  if (daclBody.includes("NO_ACCESS_CONTROL")) return { ...ownerFields, nullDacl: true, aces: [] };
  const aces: ParsedAce[] = [];
  for (const ace of splitAces(daclBody)) {
    const fields = ace.split(";");
    if (fields.length < 6) throw new RangeError("an access control entry has too few fields");
    const { sid, alias } = normalizePrincipal(fields[5] as string);
    aces.push({
      type: fields[0] as string,
      flags: fields[1] as string,
      rights: parseRights(fields[2] as string),
      sid,
      ...(alias === undefined ? {} : { alias }),
    });
  }
  return { ...ownerFields, nullDacl: false, aces };
}

function isCurrentUser(sid: string, trust: AclTrust): boolean {
  return sid === trust.currentUserSid.toUpperCase();
}

function isCurrentLocalAdmin(sid: string, trust: AclTrust): boolean {
  return sid === LOCAL_ADMIN_ALIAS && BUILTIN_ADMIN_RID_SUFFIX.test(trust.currentUserSid);
}

function isTrustedWriter(sid: string, trust: AclTrust): boolean {
  return TRUSTED_WRITERS.has(sid) || isCurrentUser(sid, trust) || isCurrentLocalAdmin(sid, trust);
}

function isTrustedOwner(sid: string, trust: AclTrust): boolean {
  return TRUSTED_OWNERS.has(sid) || isCurrentUser(sid, trust) || isCurrentLocalAdmin(sid, trust);
}

function principalName(sid: string, alias: string | undefined): string {
  return alias === undefined ? sid : `${sid} (${alias})`;
}

/**
 * Only deny types D, OD, XD and ZD are skipped. An inheritance-only entry still counts: it is copied to every child
 * created later. Entries are judged by SID, never by name, so a localized Windows reads the same.
 */
export function aclProblem(descriptor: ParsedSddl, trust: AclTrust): string | undefined {
  if (descriptor.nullDacl) return "沒有存取控制清單（DACL 為空），任何人都能寫入";
  if (!isTrustedOwner(descriptor.ownerSid, trust)) {
    return `擁有者是 ${principalName(descriptor.ownerSid, descriptor.ownerAlias)}，不是目前使用者、SYSTEM、Administrators 或 TrustedInstaller`;
  }
  for (const ace of descriptor.aces) {
    if (DENY_TYPES.has(ace.type)) continue;
    if ((ace.rights & WRITE_MASK) === 0) continue;
    if (!isTrustedWriter(ace.sid, trust)) {
      return `${principalName(ace.sid, ace.alias)} 擁有寫入權限（0x${ace.rights.toString(16)}）`;
    }
  }
  return undefined;
}

export function parseWhoamiSid(output: string): string {
  const lastLine = output
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .pop();
  const sid = WHOAMI_SID_PATTERN.exec(lastLine ?? "")?.[1];
  if (sid === undefined) throw new RangeError("the current user's SID was not in the whoami output");
  return sid;
}

function powerShellEnvironment(env: NodeJS.ProcessEnv, paths?: readonly string[]): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const name of INHERITED_VARIABLES) {
    const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    const value = key === undefined ? undefined : env[key];
    if (value !== undefined) child[name] = value;
  }
  const systemRoot = windowsSystemRoot(child);
  const powerShellDirectory = path.win32.dirname(windowsPowerShell(child));
  child.PSModulePath = path.win32.join(powerShellDirectory, "Modules");
  child.Path = [windowsSystem32Directory(child), systemRoot, powerShellDirectory].join(";");
  if (paths !== undefined) child[PATHS_VARIABLE] = paths.join(PATH_SEPARATOR);
  return child;
}

const roundMs = (ms: number) => Math.round(ms * 10) / 10;

export function createWindowsAclReader(
  exec: ExecFileLike = nodeExec,
  env: NodeJS.ProcessEnv = process.env,
  spawn: SpawnAclLike = nodeSpawn,
): WindowsAclReader {
  let whoamiSid: string | undefined;
  let pending: PrewarmedProcess | undefined;

  const run = (file: string, args: readonly string[], childEnv: NodeJS.ProcessEnv, timeout: number) =>
    exec(file, args, { env: childEnv, timeout, windowsHide: true, maxBuffer: ACL_MAX_BUFFER });

  const runPowerShell = (script: string, paths: readonly string[], timeout: number) =>
    run(windowsPowerShell(env), [...POWERSHELL_ARGUMENTS, script], powerShellEnvironment(env, paths), timeout);

  const readWhoami = async (): Promise<{ sid: string; ms: number }> => {
    const started = performance.now();
    const { stdout } = await run(
      windowsSystemTool("whoami.exe", env),
      ["/user", "/fo", "csv", "/nh"],
      powerShellEnvironment(env, []),
      WHOAMI_TIMEOUT_MS,
    );
    return { sid: parseWhoamiSid(stdout), ms: performance.now() - started };
  };

  // A serialized progress record ("#< CLIXML") may reach stdout; it is never an SID or SDDL line, so it is dropped first.
  const lines = (stdout: string) =>
    stdout.split(/\r?\n/).filter((line) => line.trim() !== "" && !/^(#< CLIXML|<Objs\b)/.test(line.trim()));

  const readGetAcl = async (paths: readonly string[]): Promise<AclSnapshot> => {
    const [sid, acls] = await Promise.allSettled([
      whoamiSid === undefined ? readWhoami() : Promise.resolve(undefined),
      runPowerShell(GET_ACL_SCRIPT, paths, GET_ACL_TIMEOUT_MS),
    ]);
    if (sid.status === "fulfilled" && sid.value) whoamiSid = sid.value.sid;
    if (sid.status === "rejected" || acls.status === "rejected") {
      const reasons = [acls, sid].flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
      const whoami =
        sid.status === "rejected"
          ? describePart(sid.reason)
          : sid.value
            ? `ok ${Math.round(sid.value.ms)} ms`
            : "cached";
      const kinds = reasons.map(failureKindOf);
      throw tierFailure(
        acls.status === "rejected" ? `${describePart(acls.reason)}; whoami: ${whoami}` : `whoami: ${whoami}`,
        kinds.includes("timeout") ? "timeout" : (kinds[0] as AclFailureKind),
      );
    }
    const sddls = lines(acls.value.stdout);
    if (sddls.length !== paths.length) throw new RangeError("unexpected number of ACLs returned");
    return { currentUserSid: whoamiSid as string, sddls };
  };

  const classifyDotnetFailure = (error: unknown): unknown =>
    isExecFailure(error) && !error.timedOut && error.exitCode === CONSTRAINED_LANGUAGE_EXIT_CODE
      ? tierFailure(describeExecFailure(error, "ConstrainedLanguage"), "constrained-language")
      : error;

  const parseDotnet = (stdout: string, paths: readonly string[]): AclSnapshot => {
    const output = lines(stdout);
    const currentUserSid = output.shift()?.trim() ?? "";
    if (!SID_PATTERN.test(currentUserSid)) throw new RangeError("the current user's SID was not returned");
    if (output.length !== paths.length) throw new RangeError("unexpected number of ACLs returned");
    return { currentUserSid, sddls: output };
  };

  const startPrewarmed = (): PrewarmedProcess => {
    const started = performance.now();
    const child = spawn(windowsPowerShell(env), [...PREWARM_ARGUMENTS, DOTNET_STDIN_SCRIPT], {
      env: powerShellEnvironment(env),
      windowsHide: true,
      maxBuffer: ACL_MAX_BUFFER,
    });
    let ended = false;
    let readyMs: number | undefined;
    const exited = child.exited.finally(() => {
      ended = true;
    });
    // Whoever never reads from this process must not see its failure as an unhandled rejection.
    exited.catch(() => undefined);
    void child.ready.then(() => {
      readyMs ??= performance.now() - started;
    });
    const idleTimer = setTimeout(() => child.kill(), PREWARM_IDLE_LIMIT_MS);
    idleTimer.unref();
    const kill = () => {
      clearTimeout(idleTimer);
      child.kill();
    };
    return {
      kill,
      readyMs: () => (readyMs === undefined ? undefined : roundMs(readyMs)),
      read: async (paths) => {
        clearTimeout(idleTimer);
        if (ended) {
          return exited.then(() => {
            throw new RangeError("the prewarmed PowerShell ended before it was given the paths");
          });
        }
        child.send(`${paths.map((target) => Buffer.from(target, "utf8").toString("base64")).join("\n")}\n`);
        const waited = performance.now();
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            child.kill();
            reject(timeoutFailure(performance.now() - waited, DOTNET_TIMEOUT_MS));
          }, DOTNET_TIMEOUT_MS);
        });
        try {
          return (await Promise.race([exited, timeout])).stdout;
        } finally {
          clearTimeout(timer);
        }
      },
    };
  };

  /** Its answer, a read timeout and Constrained Language Mode are the tier's outcome; any other failure re-reads in a fresh process. */
  const readPrewarmed = async (paths: readonly string[]): Promise<AclSnapshot | undefined> => {
    const warm = pending;
    pending = undefined;
    if (warm === undefined) return undefined;
    try {
      const snapshot = parseDotnet(await warm.read(paths), paths);
      const prewarmMs = warm.readyMs();
      return prewarmMs === undefined ? snapshot : { ...snapshot, prewarmMs };
    } catch (error) {
      const classified = classifyDotnetFailure(error);
      if (classified !== error || (isExecFailure(error) && error.timedOut)) throw classified;
      return undefined;
    } finally {
      warm.kill();
    }
  };

  const readDotnet = async (paths: readonly string[]): Promise<AclSnapshot> => {
    const prewarmed = await readPrewarmed(paths);
    if (prewarmed !== undefined) return prewarmed;
    let stdout: string;
    try {
      ({ stdout } = await runPowerShell(DOTNET_SCRIPT, paths, DOTNET_TIMEOUT_MS));
    } catch (error) {
      throw classifyDotnetFailure(error);
    }
    return parseDotnet(stdout, paths);
  };

  const prewarm = (): AclPrewarm => {
    if (pending === undefined) {
      try {
        pending = startPrewarmed();
      } catch {
        return { release: () => undefined };
      }
    }
    const mine = pending;
    return {
      release: () => {
        if (pending !== mine) return;
        pending = undefined;
        mine.kill();
      },
    };
  };

  return {
    read: async (paths, tier = "dotnet") => (tier === "get-acl" ? readGetAcl(paths) : readDotnet(paths)),
    prewarm,
  };
}

async function readAndParse(
  paths: readonly string[],
  reader: WindowsAclReader,
  tier: AclReadTier,
): Promise<{ descriptors: ParsedSddl[]; trust: AclTrust; prewarmMs: number | undefined }> {
  const snapshot = await reader.read(paths, tier);
  if (snapshot.sddls.length !== paths.length) throw new RangeError("unexpected number of ACLs returned");
  return {
    descriptors: snapshot.sddls.map((sddl) => parseSddl(sddl)),
    trust: { currentUserSid: snapshot.currentUserSid },
    prewarmMs: snapshot.prewarmMs,
  };
}

async function readTier(
  paths: readonly string[],
  reader: WindowsAclReader,
  tier: AclReadTier,
  attempts: AclReadAttempt[],
): Promise<{ read: Awaited<ReturnType<typeof readAndParse>> } | { failure: string; error: unknown }> {
  const failures: string[] = [];
  let lastError: unknown;
  for (let retry = 0; retry <= TIMEOUT_RETRIES; retry += 1) {
    const started = performance.now();
    try {
      const read = await readAndParse(paths, reader, tier);
      attempts.push({ tier, ms: roundMs(performance.now() - started), ok: true });
      return { read };
    } catch (error) {
      const ms = roundMs(performance.now() - started);
      const kind = failureKindOf(error);
      attempts.push({ tier, ms, ok: false, failure: kind });
      failures.push(describeFailure(error, ms));
      lastError = error;
      if (kind !== "timeout") break;
    }
  }
  return { failure: `${tier}: ${failures.join(", then ")}`, error: lastError };
}

/** An ACL that cannot be read is not trusted (RUNTIME_ACL_UNREADABLE), and it is not a reason to reinstall. */
export async function assertWindowsAcl(paths: readonly string[], reader: WindowsAclReader): Promise<AclReadReport> {
  const attempts: AclReadAttempt[] = [];
  let outcome = await readTier(paths, reader, "dotnet", attempts);
  if ("failure" in outcome) {
    const dotnetFailure = outcome.failure;
    outcome = await readTier(paths, reader, "get-acl", attempts);
    if ("failure" in outcome) {
      throw new RuntimeError(
        "RUNTIME_ACL_UNREADABLE",
        "無法讀取 Windows 存取控制清單（ACL），無法確認 runtime 安全；PowerShell 可能被原則封鎖",
        { actual: `${dotnetFailure}; ${outcome.failure}` },
        { cause: outcome.error },
      );
    }
  }
  const { descriptors, trust } = outcome.read;
  for (const [index, descriptor] of descriptors.entries()) {
    const problem = aclProblem(descriptor, trust);
    if (problem !== undefined) {
      throw new RuntimeError("RUNTIME_UNSAFE_PERMISSIONS", "launcher 或 runtime 的 Windows 存取權限不安全", {
        file: paths[index] as string,
        actual: problem,
      });
    }
  }
  const { prewarmMs } = outcome.read;
  return {
    tier: attempts[attempts.length - 1]?.tier as AclReadTier,
    attempts,
    ...(prewarmMs === undefined ? {} : { prewarmMs }),
  };
}
