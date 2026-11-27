import path from "node:path";

export type StorageRisk = "none" | "network" | "removable" | "cloud-sync" | "hard-link" | "unknown";

export interface StorageRiskResult {
  readonly risk: StorageRisk;
  readonly evidence: readonly string[];
  readonly symlinked: boolean;
}

export interface StorageRiskFileInfo {
  isSymbolicLink(): boolean;
  isFile(): boolean;
  dev: number | bigint;
  nlink: number | bigint;
}

export interface StorageRiskDeps {
  readonly platform: NodeJS.Platform;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
  readonly realpath: (target: string) => Promise<string>;
  readonly lstat: (target: string) => Promise<StorageRiskFileInfo>;
  readonly readFile: (target: string) => Promise<string>;
  readonly run: (command: string, args: readonly string[], timeoutMs: number) => Promise<string>;
  readonly windowsTimeoutMs?: number;
  readonly macTimeoutMs?: number;
  readonly cache?: Map<string, Promise<StorageRiskResult>>;
}

interface Located {
  readonly real: string;
  readonly dev: string;
  readonly file: StorageRiskFileInfo;
  readonly isTargetFile: boolean;
}

interface CloudRoot {
  readonly name: string;
  readonly root: string;
}

interface Finding {
  readonly risks: StorageRisk[];
  readonly evidence: string[];
  readonly failed: boolean;
}

export const WINDOWS_DRIVE_TIMEOUT_MS = 3000;
export const MACOS_PROBE_TIMEOUT_MS = 2000;
const LINUX_MOUNTS_TIMEOUT_MS = 3000;

const MAC_NETWORK_TYPES: ReadonlySet<string> = new Set(["smbfs", "nfs", "afpfs", "webdav", "macfuse", "osxfuse"]);
const LINUX_NETWORK_TYPES: ReadonlySet<string> = new Set(["nfs", "nfs4", "cifs", "smb3", "smbfs", "fuse.sshfs", "9p"]);
const WINDOWS_CLOUD_VARIABLES = ["OneDrive", "OneDriveCommercial", "OneDriveConsumer"] as const;
const MAX_ANCESTOR_STEPS = 64;
const RISK_ORDER: readonly Exclude<StorageRisk, "none" | "unknown">[] = [
  "network",
  "removable",
  "cloud-sync",
  "hard-link",
];

function failure(tag: string): Finding {
  return { risks: [], evidence: [tag], failed: true };
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function pathApi(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function comparable(value: string, platform: NodeJS.Platform): string {
  const api = pathApi(platform);
  const normal = api.normalize(value);
  const trimmed = normal.length > api.parse(normal).root.length ? normal.replace(/[\\/]+$/, "") : normal;
  return platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

function isUnder(target: string, root: string, platform: NodeJS.Platform): boolean {
  const separator = pathApi(platform).sep;
  const child = comparable(target, platform);
  const parent = comparable(root, platform);
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(separator) ? parent : `${parent}${separator}`);
}

async function safeRealpath(deps: StorageRiskDeps, target: string): Promise<string> {
  try {
    return await deps.realpath(target);
  } catch {
    return target;
  }
}

async function withRealRoots(deps: StorageRiskDeps, roots: readonly CloudRoot[]): Promise<CloudRoot[]> {
  const resolved = await Promise.all(
    roots.map(async (entry) => ({ name: entry.name, root: await safeRealpath(deps, entry.root) })),
  );
  return [...roots, ...resolved.filter((entry, index) => entry.root !== roots[index]?.root)];
}

function matchCloud(real: string, roots: readonly CloudRoot[], platform: NodeJS.Platform): string | undefined {
  return roots.find((entry) => entry.root.length > 0 && isUnder(real, entry.root, platform))?.name;
}

async function locate(target: string, deps: StorageRiskDeps): Promise<Located> {
  const api = pathApi(deps.platform);
  let candidate = api.resolve(target);
  for (let step = 0; step <= MAX_ANCESTOR_STEPS; step += 1) {
    try {
      const real = await deps.realpath(candidate);
      const file = await deps.lstat(real);
      return { real, dev: String(file.dev), file, isTargetFile: candidate === api.resolve(target) && file.isFile() };
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      const parent = api.dirname(candidate);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === candidate) throw error;
      candidate = parent;
    }
  }
  throw new Error("path has no existing ancestor");
}

async function hasSymlinkSegment(target: string, deps: StorageRiskDeps): Promise<boolean> {
  const api = pathApi(deps.platform);
  const absolute = api.resolve(target);
  const { root } = api.parse(absolute);
  const parts = absolute
    .slice(root.length)
    .split(api.sep)
    .filter((part) => part.length > 0);
  let current = root;
  for (const part of parts) {
    current = api.join(current, part);
    try {
      if ((await deps.lstat(current)).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

function parseOctalEscapes(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

interface MountEntry {
  readonly mountPoint: string;
  readonly type: string;
}

function parseLinuxMounts(text: string): MountEntry[] {
  return text
    .split("\n")
    .map((line) => line.split(" "))
    .filter((fields) => fields.length >= 3)
    .map((fields) => ({ mountPoint: parseOctalEscapes(fields[1] as string), type: fields[2] as string }));
}

function parseMacMounts(text: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of text.split("\n")) {
    const match = /^(.+?) on (\/.*) \(([^()]*)\)\s*$/.exec(line);
    if (match) entries.push({ mountPoint: match[2] as string, type: (match[3] as string).split(",")[0]?.trim() ?? "" });
  }
  return entries;
}

function mountOf(real: string, entries: readonly MountEntry[]): MountEntry | undefined {
  let best: MountEntry | undefined;
  for (const entry of entries) {
    if (!isUnder(real, entry.mountPoint, "linux")) continue;
    if (!best || entry.mountPoint.length > best.mountPoint.length) best = entry;
  }
  return best;
}

function plistBoolean(plist: string, key: string): boolean | undefined {
  const match = new RegExp(`<key>${key}</key>\\s*<(true|false)\\s*/>`).exec(plist);
  return match ? match[1] === "true" : undefined;
}

async function classifyLinux(located: Located, deps: StorageRiskDeps): Promise<Finding> {
  let entries: MountEntry[];
  try {
    entries = parseLinuxMounts(await withTimeout(deps.readFile("/proc/mounts"), LINUX_MOUNTS_TIMEOUT_MS));
  } catch {
    return failure("mounts-unreadable");
  }
  const mount = mountOf(located.real, entries);
  if (!mount) return failure("mount-not-found");
  return LINUX_NETWORK_TYPES.has(mount.type)
    ? { risks: ["network"], evidence: [`mount-type:${mount.type}`], failed: false }
    : { risks: [], evidence: [], failed: false };
}

async function macCloudRoots(deps: StorageRiskDeps): Promise<CloudRoot[]> {
  const home = deps.homeDirectory;
  return withRealRoots(deps, [
    { name: "icloud", root: path.posix.join(home, "Library", "Mobile Documents") },
    { name: "cloud-storage", root: path.posix.join(home, "Library", "CloudStorage") },
    { name: "dropbox", root: path.posix.join(home, "Dropbox") },
  ]);
}

async function classifyMac(located: Located, deps: StorageRiskDeps): Promise<Finding> {
  const cloud = matchCloud(located.real, await macCloudRoots(deps), "darwin");
  if (cloud) return { risks: ["cloud-sync"], evidence: [`cloud-root:${cloud}`], failed: false };
  const timeoutMs = deps.macTimeoutMs ?? MACOS_PROBE_TIMEOUT_MS;
  let entries: MountEntry[];
  try {
    entries = parseMacMounts(await withTimeout(deps.run("/sbin/mount", [], timeoutMs), timeoutMs));
  } catch {
    return failure("mount-probe-failed");
  }
  const mount = mountOf(located.real, entries);
  if (!mount) return failure("mount-not-found");
  if (mount.mountPoint === "/" || mount.mountPoint === "/System/Volumes/Data") {
    return { risks: [], evidence: ["fast-path:startup-volume"], failed: false };
  }
  if (MAC_NETWORK_TYPES.has(mount.type)) {
    return { risks: ["network"], evidence: [`mount-type:${mount.type}`], failed: false };
  }
  try {
    const plist = await withTimeout(
      deps.run("/usr/sbin/diskutil", ["info", "-plist", mount.mountPoint], timeoutMs),
      timeoutMs,
    );
    const internal = plistBoolean(plist, "Internal");
    const removable = plistBoolean(plist, "RemovableMedia");
    const ejectable = plistBoolean(plist, "Ejectable");
    if (internal === undefined && removable === undefined && ejectable === undefined) {
      return failure("diskutil-no-answer");
    }
    return internal === false || removable === true || ejectable === true
      ? { risks: ["removable"], evidence: ["diskutil:external-or-ejectable"], failed: false }
      : { risks: [], evidence: [], failed: false };
  } catch {
    return failure("diskutil-failed");
  }
}

async function windowsCloudRoots(deps: StorageRiskDeps): Promise<CloudRoot[]> {
  const { environment } = deps;
  const roots: CloudRoot[] = [];
  for (const name of WINDOWS_CLOUD_VARIABLES) {
    const value = environment[name];
    if (value) roots.push({ name: "onedrive", root: value });
  }
  const profile = environment.USERPROFILE ?? deps.homeDirectory;
  if (profile) roots.push({ name: "icloud", root: path.win32.join(profile, "iCloudDrive") });
  const infoFiles = [environment.APPDATA, environment.LOCALAPPDATA]
    .filter((base): base is string => typeof base === "string" && base.length > 0)
    .map((base) => path.win32.join(base, "Dropbox", "info.json"));
  const dropbox = await Promise.all(infoFiles.map((file) => readDropboxRoots(deps, file)));
  for (const found of dropbox.flat()) roots.push({ name: "dropbox", root: found });
  return withRealRoots(deps, roots);
}

async function readDropboxRoots(deps: StorageRiskDeps, file: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await deps.readFile(file)) as Record<string, unknown>;
    return Object.values(parsed).flatMap((account) => {
      const value = (account as { path?: unknown } | null)?.path;
      return typeof value === "string" && value.length > 0 ? [value] : [];
    });
  } catch {
    return [];
  }
}

function windowsDriveOf(real: string): { drive: string } | { unc: true } | undefined {
  const stripped = real.replace(/^\\\\\?\\/, "");
  if (/^UNC\\/i.test(stripped) || /^\\\\/.test(stripped)) return { unc: true };
  const match = /^([A-Za-z]):/.exec(stripped);
  return match ? { drive: (match[1] as string).toUpperCase() } : undefined;
}

async function classifyWindows(located: Located, deps: StorageRiskDeps): Promise<Finding> {
  const location = windowsDriveOf(located.real);
  if (!location) return failure("no-drive-letter");
  if ("unc" in location) return { risks: ["network"], evidence: ["unc-path"], failed: false };
  const cloud = matchCloud(located.real.replace(/^\\\\\?\\/, ""), await windowsCloudRoots(deps), "win32");
  if (cloud) return { risks: ["cloud-sync"], evidence: [`cloud-root:${cloud}`], failed: false };
  const systemDrive = /^([A-Za-z]):/.exec(deps.environment.SystemDrive ?? "")?.[1]?.toUpperCase() ?? "C";
  if (location.drive === systemDrive) return { risks: [], evidence: ["fast-path:system-drive"], failed: false };
  const timeoutMs = deps.windowsTimeoutMs ?? WINDOWS_DRIVE_TIMEOUT_MS;
  // An external USB disk reports DriveType Fixed, so a fixed drive is also asked for its bus (L-11); best effort.
  const script = [
    `$t = [System.IO.DriveInfo]::new('${location.drive}:\\').DriveType`,
    `$b = ''`,
    `if ($t -eq 'Fixed') { try { $b = (Get-Partition -DriveLetter '${location.drive}' -ErrorAction Stop | Get-Disk -ErrorAction Stop).BusType } catch {} }`,
    `"$t $b"`,
  ].join("; ");
  let output: string;
  try {
    output = await withTimeout(
      deps.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], timeoutMs),
      timeoutMs,
    );
  } catch {
    return failure("drive-probe-failed");
  }
  const [type = "", bus] = output.trim().split(/\s+/);
  if (type === "Network") return { risks: ["network"], evidence: ["drive-type:network"], failed: false };
  if (type === "Removable") return { risks: ["removable"], evidence: ["drive-type:removable"], failed: false };
  if (bus?.toUpperCase() === "USB") return { risks: ["removable"], evidence: ["bus-type:usb"], failed: false };
  return /^[A-Za-z]+$/.test(type) ? { risks: [], evidence: [], failed: false } : failure("drive-probe-no-answer");
}

async function classifyPlatform(located: Located, deps: StorageRiskDeps): Promise<Finding> {
  if (deps.platform === "win32") return classifyWindows(located, deps);
  if (deps.platform === "darwin") return classifyMac(located, deps);
  if (deps.platform === "linux") return classifyLinux(located, deps);
  return failure("unsupported-platform");
}

async function compute(target: string, deps: StorageRiskDeps, located: Located): Promise<StorageRiskResult> {
  const [finding, symlinked] = await Promise.all([
    classifyPlatform(located, deps).catch(() => failure("adapter-error")),
    hasSymlinkSegment(target, deps),
  ]);
  const risks = [...finding.risks];
  const evidence = [...finding.evidence];
  if (symlinked) evidence.push("symlink-in-path");
  if (located.isTargetFile && Number(located.file.nlink) > 1) {
    risks.push("hard-link");
    evidence.push("hard-link-count");
  }
  const positive = RISK_ORDER.find((risk) => risks.includes(risk));
  if (positive) return { risk: positive, evidence, symlinked };
  return { risk: finding.failed ? "unknown" : "none", evidence, symlinked };
}

/**
 * Never throws. An `unknown` verdict is not cached, so the next look asks again instead of blocking one-click selection
 * until restart.
 */
export async function classifyStorageRisk(databasePath: string, deps: StorageRiskDeps): Promise<StorageRiskResult> {
  let located: Located;
  try {
    located = await locate(databasePath, deps);
  } catch {
    return { risk: "unknown", evidence: ["path-unreadable"], symlinked: false };
  }
  const key = `${comparable(located.real, deps.platform)}|${located.dev}|${located.isTargetFile ? "file" : "folder"}`;
  const cached = deps.cache?.get(key);
  if (cached) return cached;
  const pending = compute(databasePath, deps, located);
  deps.cache?.set(key, pending);
  const result = await pending;
  if (result.risk === "unknown" && deps.cache?.get(key) === pending) deps.cache.delete(key);
  return result;
}
