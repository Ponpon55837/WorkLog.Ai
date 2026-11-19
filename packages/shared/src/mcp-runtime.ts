import { createHash, randomUUID } from "node:crypto";
import {
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { configDirectory } from "./database-location.js";

export interface McpBuildIdentity {
  version: string;
  distHash: string;
  buildId: string;
  compatibilityId?: string;
  schemaVersion?: number;
}

export interface McpRestartStatus {
  restartRequired: boolean;
  monitoringAvailable: boolean;
  updateAvailable?: boolean;
  message?: string;
  /** Present when the server runs under the stable launcher: only a launcher update requires reconnecting. */
  launcher?: { version: number; restartRequired: boolean };
}

export interface McpRuntimeStatus extends McpRestartStatus {
  activeProcesses: number;
  outdatedProcesses: number;
  updateAvailableProcesses: number;
}

interface McpProcessLease {
  instanceId: string;
  buildId: string;
  version: string;
  compatibilityId?: string;
  startedAt: string;
  heartbeatAt: string;
}

interface McpRuntimeStatusOptions {
  now?: Date;
  heartbeatTtlMs?: number;
  probeRegistryWritable?: (directory: string) => boolean;
  /** The environment that names the App's lease scope; defaults to this process's. */
  environment?: Readonly<Record<string, string | undefined>>;
}

const MCP_RUNTIME_DIST_DIRECTORIES = [
  "apps/mcp/dist",
  "packages/core/dist",
  "packages/project-policy/dist",
  "packages/schema/dist",
  "packages/shared/dist",
  "packages/storage/dist",
] as const;
/**
 * The standalone package (and the desktop runtime built from it) ships the MCP server as bundles with every workspace
 * package inlined, so its code is the bundles of apps/mcp/dist alone. `scripts/build-standalone.mjs` marks that layout
 * with the name of the package.json it writes next to them.
 */
const MCP_STANDALONE_DIST_DIRECTORIES = ["apps/mcp/dist"] as const;
const MCP_STANDALONE_PACKAGE_NAME = "work-intelligence-libexec";
const MCP_ENTRY_FILE = "apps/mcp/dist/index.js";
const MCP_BUILD_HASH_PLACEHOLDER = "__WORK_INTELLIGENCE_BUILD_HASH__";
const MCP_ENTRY_IDENTITY = /const MCP_BUILD_DIST_HASH = "(?:[a-f0-9]{64}|__WORK_INTELLIGENCE_BUILD_HASH__)";/;
const MCP_ENTRY_IDENTITY_PATTERN = /const MCP_BUILD_DIST_HASH = "(?:[a-f0-9]{64}|__WORK_INTELLIGENCE_BUILD_HASH__)";/g;
const MCP_BUILD_PROGRESS_FILE = ".work-intelligence-build-in-progress";
const MCP_HEARTBEAT_INTERVAL_MS = 5_000;
const MCP_HEARTBEAT_TTL_MS = 30_000;
const MCP_LEASE_CLEANUP_GRACE_MS = 60_000;
const MCP_LEASE_CLEANUP_LIMIT = 64;
const MCP_REGISTRATION_SCAN_LIMIT = 512;
const MCP_LEASE_FILE_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(json|tmp)$/;
const MCP_RECONNECT_MESSAGE = "磁碟上的 Work Intelligence MCP 建置已更新，請重新連線 MCP。";
const MCP_UPDATE_MESSAGE =
  "Work Intelligence MCP 有新版可用；目前契約相容，讀寫可照常進行，收尾時提醒重新連線一次即可。";
const MCP_UNKNOWN_MESSAGE = "無法確認磁碟上的 MCP 建置；請重新連線 MCP 後再繼續。";
const ROOT_PACKAGE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;
/**
 * Build identity per repository root, keyed by a cheap stat signature of every runtime file. Hashing the whole
 * dist twice cost most of each System Status request; a rebuild changes a size, mtime or inode and misses here.
 */
const buildIdentityCache = new Map<string, { signature: string; identity: McpBuildIdentity | undefined }>();

function packageVersion(repositoryRoot: string): string | undefined {
  try {
    const packageJson: unknown = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
    if (!packageJson || typeof packageJson !== "object" || !("version" in packageJson)) {
      return undefined;
    }
    const version = packageJson.version;
    return typeof version === "string" && ROOT_PACKAGE_VERSION_PATTERN.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

/** The dist directories whose code is the MCP process: the repository's packages, or the standalone bundles. */
function runtimeDistDirectories(repositoryRoot: string): readonly string[] {
  try {
    const packageJson: unknown = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
    const name = packageJson && typeof packageJson === "object" && "name" in packageJson ? packageJson.name : undefined;
    return name === MCP_STANDALONE_PACKAGE_NAME ? MCP_STANDALONE_DIST_DIRECTORIES : MCP_RUNTIME_DIST_DIRECTORIES;
  } catch {
    return MCP_RUNTIME_DIST_DIRECTORIES;
  }
}

function javascriptFiles(directory: string, repositoryRoot: string): string[] {
  const children = readdirSync(directory, { withFileTypes: true });
  return children.flatMap((child) => {
    const childPath = join(directory, child.name);
    if (child.isDirectory()) {
      return javascriptFiles(childPath, repositoryRoot);
    }
    return child.isFile() && child.name.endsWith(".js")
      ? [relative(repositoryRoot, childPath).replaceAll("\\", "/")]
      : [];
  });
}

/** Paths, sizes, mtimes and inodes of package.json and every runtime dist file; undefined when unreadable. */
function runtimeDistSignature(repositoryRoot: string): string | undefined {
  try {
    const parts: string[] = [];
    for (const file of [
      "package.json",
      ...runtimeDistDirectories(repositoryRoot).flatMap((directory) => {
        const absolute = resolve(repositoryRoot, directory);
        return existsSync(absolute) ? javascriptFiles(absolute, repositoryRoot).sort() : [`missing:${directory}`];
      }),
    ]) {
      if (file.startsWith("missing:")) {
        parts.push(file);
        continue;
      }
      // Bigint stats keep the full 64-bit Windows file id; as a JS number a replaced file could keep its signature.
      const stats = statSync(resolve(repositoryRoot, file), { bigint: true });
      parts.push(`${file}\0${stats.size}\0${stats.mtimeNs}\0${stats.ino}`);
    }
    return parts.join("\n");
  } catch {
    return undefined;
  }
}

function stableFileRead(path: string): Buffer {
  const before = statSync(path, { bigint: true });
  const contents = readFileSync(path);
  const after = statSync(path, { bigint: true });
  if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ino !== after.ino) {
    throw new Error("A runtime dist file changed while its build identity was being read.");
  }
  return contents;
}

function embeddedMcpBuildHash(repositoryRoot: string): string | undefined {
  try {
    const source = stableFileRead(resolve(repositoryRoot, MCP_ENTRY_FILE)).toString("utf8");
    if (source.match(MCP_ENTRY_IDENTITY_PATTERN)?.length !== 1) return undefined;
    return source.match(/const MCP_BUILD_DIST_HASH = "([a-f0-9]{64})";/)?.[1];
  } catch {
    return undefined;
  }
}

function normalizedRuntimeFile(repositoryRoot: string, file: string): Buffer {
  const contents = stableFileRead(resolve(repositoryRoot, file));
  if (file !== MCP_ENTRY_FILE) return contents;
  const source = contents.toString("utf8");
  if (!MCP_ENTRY_IDENTITY.test(source) || source.match(MCP_ENTRY_IDENTITY_PATTERN)?.length !== 1) {
    throw new Error("The MCP entry point has no stable embedded build identity.");
  }
  return Buffer.from(
    // Spelled in parts: a bundle that inlines this module must not hold the declaration it looks for as a second copy.
    source.replace(MCP_ENTRY_IDENTITY_PATTERN, `const MCP_BUILD_DIST_HASH = "${MCP_BUILD_HASH_PLACEHOLDER}";`),
  );
}

function hashMcpRuntimeDist(repositoryRoot: string): string {
  const digest = createHash("sha256");
  let filesFound = 0;
  for (const relativeDirectory of runtimeDistDirectories(repositoryRoot)) {
    const directory = resolve(repositoryRoot, relativeDirectory);
    if (!existsSync(directory)) {
      throw new Error(`Required MCP runtime dist is unavailable: ${relativeDirectory}`);
    }
    const files = javascriptFiles(directory, repositoryRoot).sort();
    if (files.length === 0) {
      throw new Error(`Required MCP runtime dist has no JavaScript files: ${relativeDirectory}`);
    }
    for (const file of files) {
      filesFound += 1;
      digest.update(file).update("\0").update(normalizedRuntimeFile(repositoryRoot, file)).update("\0");
    }
  }
  if (filesFound === 0) {
    throw new Error("The MCP runtime distribution is unavailable.");
  }
  return digest.digest("hex");
}

function readProcessLease(path: string): Partial<McpProcessLease> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Partial<McpProcessLease>) : undefined;
  } catch {
    return undefined;
  }
}

function cleanupExpiredLease(
  directory: string,
  file: string,
  now: number,
  heartbeatTtlMs: number,
  budget: { attempts: number },
  lease?: Partial<McpProcessLease>,
): void {
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(heartbeatTtlMs) ||
    budget.attempts >= MCP_LEASE_CLEANUP_LIMIT ||
    !MCP_LEASE_FILE_PATTERN.test(file)
  )
    return;
  const path = join(directory, file);
  try {
    const stats = lstatSync(path);
    const cutoff = now - heartbeatTtlMs - MCP_LEASE_CLEANUP_GRACE_MS;
    // A recently rewritten file may belong to a resumed heartbeat; never remove it from a stale snapshot.
    if (!stats.isFile() || stats.mtimeMs >= cutoff) return;
    if (file.endsWith(".json") && typeof lease?.heartbeatAt === "string") {
      const heartbeat = Date.parse(lease.heartbeatAt);
      if (Number.isFinite(heartbeat) && heartbeat >= cutoff) return;
    }
    budget.attempts += 1;
    unlinkSync(path);
  } catch {
    // Best-effort maintenance must not prevent startup or a System Status response.
  }
}

function cleanupRegistrationLeases(directory: string, now: number): void {
  try {
    if (!lstatSync(directory).isDirectory()) return;
    const entries = opendirSync(directory);
    const budget = { attempts: 0 };
    try {
      for (let inspected = 0; inspected < MCP_REGISTRATION_SCAN_LIMIT; inspected += 1) {
        const entry = entries.readSync();
        if (!entry || budget.attempts >= MCP_LEASE_CLEANUP_LIMIT) break;
        if (!entry.isFile() || !MCP_LEASE_FILE_PATTERN.test(entry.name)) continue;
        const lease = entry.name.endsWith(".json") ? readProcessLease(join(directory, entry.name)) : undefined;
        cleanupExpiredLease(directory, entry.name, now, MCP_HEARTBEAT_TTL_MS, budget, lease);
      }
    } finally {
      entries.closeSync();
    }
  } catch {
    // Unreadable registries are handled by the existing runtime monitoring path.
  }
}

/** Build-only fingerprint calculation. Runtime status reads must use readMcpBuildIdentity instead. */
export function computeMcpBuildIdentity(repositoryRoot: string): McpBuildIdentity | undefined {
  const root = resolve(repositoryRoot);
  const version = packageVersion(root);
  if (!version) return undefined;
  try {
    const distHash = hashMcpRuntimeDist(root);
    if (packageVersion(root) !== version || hashMcpRuntimeDist(root) !== distHash) return undefined;
    const entry = stableFileRead(resolve(root, MCP_ENTRY_FILE)).toString("utf8");
    const compatibilityId = entry.match(/const MCP_BUILD_COMPATIBILITY_ID = "([a-f0-9]{64})";/)?.[1];
    return { version, distHash, buildId: `${version}:${distHash}`, ...(compatibilityId ? { compatibilityId } : {}) };
  } catch {
    return undefined;
  }
}

/** Captures the application version and the code-bearing dist files used by the stdio MCP process. */
export function readMcpBuildIdentity(repositoryRoot: string): McpBuildIdentity | undefined {
  const root = resolve(repositoryRoot);
  if (existsSync(resolve(root, MCP_BUILD_PROGRESS_FILE))) return undefined;
  const signature = runtimeDistSignature(root);
  const cached = signature === undefined ? undefined : buildIdentityCache.get(root);
  if (cached && cached.signature === signature) return cached.identity;
  const computed = computeMcpBuildIdentity(root);
  const identity = computed && embeddedMcpBuildHash(root) === computed.distHash ? computed : undefined;
  if (existsSync(resolve(root, MCP_BUILD_PROGRESS_FILE))) return undefined;
  // Cache only when nothing changed while hashing, so a half-written build is never remembered.
  if (signature !== undefined && runtimeDistSignature(root) === signature) {
    buildIdentityCache.set(root, { signature, identity });
  }
  return identity;
}

/** Compares a process's embedded startup build with the current runtime dist on disk. */
export function getMcpRestartStatus(
  repositoryRoot: string,
  runningBuild: McpBuildIdentity | undefined,
): McpRestartStatus {
  const currentBuild = readMcpBuildIdentity(repositoryRoot);
  if (!currentBuild) {
    return { restartRequired: true, updateAvailable: false, monitoringAvailable: false, message: MCP_UNKNOWN_MESSAGE };
  }
  if (!runningBuild?.compatibilityId || !currentBuild.compatibilityId) {
    return { restartRequired: true, updateAvailable: false, monitoringAvailable: true, message: MCP_RECONNECT_MESSAGE };
  }
  if (currentBuild.buildId === runningBuild.buildId) {
    return { restartRequired: false, updateAvailable: false, monitoringAvailable: true };
  }
  if (runningBuild.compatibilityId && currentBuild.compatibilityId === runningBuild.compatibilityId) {
    return { restartRequired: false, updateAvailable: true, monitoringAvailable: true, message: MCP_UPDATE_MESSAGE };
  }
  return { restartRequired: true, updateAvailable: false, monitoringAvailable: true, message: MCP_RECONNECT_MESSAGE };
}

/**
 * Names the one stable place an installation of the desktop App keeps behind every runtime it ships. The App's launcher
 * sets it (to the App's runtime root) before it hands over to the backend or to an Agent's MCP, so both agree on the
 * lease directory even though each runs from a different `runtimes/<id>` checkout. A runtime that predates the variable
 * ignores it and keeps the older, root-based scope; a launcher that predates it never sets it, so the root decides.
 */
export const MCP_LEASE_SCOPE_ENVIRONMENT = "WORK_INTELLIGENCE_APP_LEASE_SCOPE";

/**
 * Windows paths are case-insensitive, accept both separators and may carry the `\\?\` long-path prefix or a trailing
 * separator: one install must hash to one scope however it is spelled.
 */
export function normalizeScopePath(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return path;
  const unified = path.replace(/\\/g, "/").replace(/^\/\/[?.]\//, "");
  const trimmed = unified.length > 3 ? unified.replace(/\/+$/, "") : unified;
  return trimmed.toLowerCase();
}

type RealPath = (path: string) => string;

/**
 * The scope path of an install. `realpathSync.native` asks the OS, so a Windows 8.3 short name (`PROGRA~1`) and the
 * long name it stands for, or a junction, give one path; the JavaScript implementation `legacy` keeps does not.
 */
function canonicalPath(path: string, platform: NodeJS.Platform, realpath: RealPath): string {
  const resolved = resolve(path);
  try {
    return normalizeScopePath(realpath(resolved), platform);
  } catch {
    // Keep the resolved path for a not-yet-created synthetic installation in tests.
    return normalizeScopePath(resolved, platform);
  }
}

/**
 * The App's runtime root when `path` lies inside one of its runtimes (`<root>/runtimes/<id>/...`, the root holding the
 * `current` pointer); undefined for a repository checkout or a standalone install.
 */
export function appRootOf(path: string): string | undefined {
  let current = resolve(path);
  for (let depth = 0; depth < 12; depth += 1) {
    const parent = dirname(current);
    if (parent === current) return undefined;
    if (basename(parent) === "runtimes") {
      const root = dirname(parent);
      return existsSync(join(root, "current")) ? root : undefined;
    }
    current = parent;
  }
  return undefined;
}

/**
 * Whether an MCP process keeps a lease. A repository checkout always does. A standalone bundle is replaced as a whole on
 * update and has no on-disk build to watch, so a plain standalone install does not; but the desktop App's runtime is a
 * standalone bundle too, and its connection count is exactly what the lease feeds, so a bundle that runs inside the App
 * (its scope variable is set, or it sits in `<App root>/runtimes/<id>/`) registers like any other.
 */
export function mcpKeepsLease(
  standalone: boolean,
  repositoryRoot: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return (
    !standalone || Boolean(environment[MCP_LEASE_SCOPE_ENVIRONMENT]?.trim()) || appRootOf(repositoryRoot) !== undefined
  );
}

function scopeIdFor(
  repositoryRoot: string,
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  realpath: RealPath,
): string {
  // The variable is only set by the launcher; a process started another way (the backend, an Agent's older launcher) still sits
  // inside `<App root>/runtimes/<id>/`, which names the same App root without it.
  const appScope = environment[MCP_LEASE_SCOPE_ENVIRONMENT]?.trim() || appRootOf(repositoryRoot);
  const scopeKey = appScope
    ? `app:${canonicalPath(appScope, platform, realpath)}`
    : canonicalPath(repositoryRoot, platform, realpath);
  return createHash("sha256").update(scopeKey).digest("hex").slice(0, 24);
}

/**
 * The opaque id (24 hex characters of a hash, no path) of the lease scope of one install. The MCP records it in its
 * observation and the backend compares it with its own, so a mismatch is stated instead of guessed.
 */
export function getMcpLeaseScopeId(
  repositoryRoot: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  realpath: RealPath = realpathSync.native,
): string {
  return scopeIdFor(repositoryRoot, environment, platform, realpath);
}

/**
 * Returns the process-lease directory shared by the MCP, local API server, and doctor for one install. Under the
 * desktop App the scope is the App's stable runtime root (see {@link MCP_LEASE_SCOPE_ENVIRONMENT}); otherwise it is the
 * installation root, as before. The directory sits in the config directory, the place the Agent observations already
 * rely on: an Agent that starts the MCP with another `TEMP`/`TMP` (or none) still writes where the backend reads.
 */
export function getMcpRuntimeDirectory(
  repositoryRoot: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  realpath: RealPath = realpathSync.native,
): string {
  return join(
    configDirectory({ environment, platform }),
    "mcp-runtime",
    scopeIdFor(repositoryRoot, environment, platform, realpath),
  );
}

/**
 * Where 1.6.59 and earlier kept the leases: the system temp directory, scoped by a hash of the JavaScript `realpathSync`
 * path. Read only, so an MCP process that was already running before the upgrade is still counted.
 * TODO: remove in 1.8.0 together with its use in getMcpRuntimeStatus.
 */
function legacyMcpRuntimeDirectory(
  repositoryRoot: string,
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): string {
  return join(
    tmpdir(),
    "work-intelligence",
    "mcp-runtime",
    scopeIdFor(repositoryRoot, environment, platform, realpathSync),
  );
}

/** Why a lease could not be kept: a code, never a path or a system message. */
export type McpLeaseFailure = "directory_unavailable" | "write_failed";

/** What one MCP process knows about its own lease; ids, booleans and a code, no path. */
export interface McpLeaseRegistration {
  /** {@link getMcpLeaseScopeId} of this process. */
  scopeId: string;
  /** The lease directory could be created and the lease file written. */
  directoryWritable: boolean;
  failure?: McpLeaseFailure;
  /** The system error code (`EACCES`, `ENOENT`…) of the failure, when it is one. */
  errorCode?: string;
}

export interface McpProcessRegistration {
  /** Stops the heartbeat and removes the lease. */
  release: () => void;
  /** The state right now: a failed heartbeat shows here, and a later one that succeeds clears it. */
  registration: () => McpLeaseRegistration;
}

const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,23}$/;

function errorCodeOf(error: unknown): string | undefined {
  const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" && ERROR_CODE_PATTERN.test(code) ? code : undefined;
}

/**
 * Registers one MCP process with an atomic lease file; each client process has its own independent lease. A failure is
 * not thrown (a stdio process must keep serving) and not hidden either: {@link McpProcessRegistration.registration}
 * says whether the directory is writable and why not, for the observation file and the status page.
 */
export function registerMcpLease(
  repositoryRoot: string,
  build: McpBuildIdentity | undefined,
  options: {
    heartbeatIntervalMs?: number;
    now?: () => Date;
    environment?: Readonly<Record<string, string | undefined>>;
  } = {},
): McpProcessRegistration {
  const directory = getMcpRuntimeDirectory(repositoryRoot, options.environment);
  const state: McpLeaseRegistration = {
    scopeId: getMcpLeaseScopeId(repositoryRoot, options.environment),
    directoryWritable: true,
  };
  const registration = (): McpLeaseRegistration => ({ ...state });
  const fail = (failure: McpLeaseFailure, error: unknown): void => {
    state.directoryWritable = false;
    state.failure = failure;
    const code = errorCodeOf(error);
    if (code) state.errorCode = code;
    else delete state.errorCode;
  };
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    fail("directory_unavailable", error);
    return { release: () => undefined, registration };
  }
  cleanupRegistrationLeases(directory, (options.now?.() ?? new Date()).getTime());
  const instanceId = randomUUID();
  const leasePath = join(directory, `${instanceId}.json`);
  const temporaryPath = join(directory, `${instanceId}.tmp`);
  const startedAt = (options.now?.() ?? new Date()).toISOString();
  const heartbeatIntervalMs = Math.max(1_000, options.heartbeatIntervalMs ?? MCP_HEARTBEAT_INTERVAL_MS);
  let closed = false;

  const writeLease = (): void => {
    if (closed) return;
    const lease: McpProcessLease = {
      instanceId,
      buildId: build?.buildId ?? "unknown",
      compatibilityId: build?.compatibilityId,
      version: build?.version ?? packageVersion(resolve(repositoryRoot)) ?? "unknown",
      startedAt,
      heartbeatAt: (options.now?.() ?? new Date()).toISOString(),
    };
    try {
      writeFileSync(temporaryPath, JSON.stringify(lease), { encoding: "utf8", mode: 0o600 });
      renameSync(temporaryPath, leasePath);
      state.directoryWritable = true;
      delete state.failure;
      delete state.errorCode;
    } catch (error) {
      // An unavailable registry must not crash the stdio process; the MCP response still reports local status.
      fail("write_failed", error);
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        // The next heartbeat can retry; readers ignore incomplete files.
      }
    }
  };

  writeLease();
  const timer = setInterval(writeLease, heartbeatIntervalMs);
  timer.unref();

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    try {
      rmSync(temporaryPath, { force: true });
      rmSync(leasePath, { force: true });
    } catch {
      // A leftover lease naturally expires after its heartbeat TTL.
    }
    process.off("exit", cleanup);
  };
  process.once("exit", cleanup);
  return { release: cleanup, registration };
}

/**
 * {@link registerMcpLease} for a caller that only needs the release function.
 * @internal test-only
 */
export function registerMcpProcess(
  repositoryRoot: string,
  build: McpBuildIdentity | undefined,
  options: Parameters<typeof registerMcpLease>[2] = {},
): () => void {
  return registerMcpLease(repositoryRoot, build, options).release;
}

function probeRuntimeDirectoryWritable(directory: string): boolean {
  const probePath = join(directory, `.${randomUUID()}.probe`);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(probePath, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
    rmSync(probePath);
    return true;
  } catch {
    try {
      rmSync(probePath, { force: true });
    } catch {
      // An undeletable probe means the registry cannot be trusted for process leases.
    }
    return false;
  }
}

/** The leases of `entries` (the files of `directory`) whose heartbeat is fresh; expired files are cleaned up on the way. */
function freshLeases(
  directory: string,
  entries: readonly Dirent[],
  now: number,
  heartbeatTtlMs: number,
  cleanupBudget: { attempts: number },
): McpProcessLease[] {
  return entries.flatMap((file) => {
    if (!file.isFile() || !MCP_LEASE_FILE_PATTERN.test(file.name)) return [];
    const lease = file.name.endsWith(".json") ? readProcessLease(join(directory, file.name)) : undefined;
    cleanupExpiredLease(directory, file.name, now, heartbeatTtlMs, cleanupBudget, lease);
    if (
      !lease ||
      typeof lease.instanceId !== "string" ||
      basename(file.name) !== `${lease.instanceId}.json` ||
      typeof lease.buildId !== "string" ||
      typeof lease.heartbeatAt !== "string"
    ) {
      return [];
    }
    const heartbeatTime = Date.parse(lease.heartbeatAt);
    const age = now - heartbeatTime;
    return Number.isFinite(heartbeatTime) && age <= heartbeatTtlMs && age >= -5_000 ? [lease as McpProcessLease] : [];
  });
}

/** What the lease registry of one install holds right now; ids, a count and a boolean, no path. */
export interface McpLeaseCensus {
  scopeId: string;
  directoryWritable: boolean;
  activeLeases: number;
}

/**
 * The scope id of `repositoryRoot`'s lease registry, whether it can be written and how many fresh leases it holds (the
 * old temp-directory registry included, see {@link getMcpRuntimeStatus}). For the diagnostics summary, which has no build
 * to compare with.
 */
export function readMcpLeaseCensus(
  repositoryRoot: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  now: Date = new Date(),
): McpLeaseCensus {
  const directory = getMcpRuntimeDirectory(repositoryRoot, environment);
  const directories = [directory, legacyMcpRuntimeDirectory(repositoryRoot, environment, process.platform)];
  const seen = new Set<string>();
  for (const [index, candidate] of directories.entries()) {
    if (index === 1 && candidate === directory) continue;
    try {
      for (const lease of freshLeases(
        candidate,
        readdirSync(candidate, { withFileTypes: true }),
        now.getTime(),
        MCP_HEARTBEAT_TTL_MS,
        { attempts: 0 },
      )) {
        seen.add(lease.instanceId);
      }
    } catch {
      // A registry that does not exist or cannot be read holds no lease.
    }
  }
  return {
    scopeId: getMcpLeaseScopeId(repositoryRoot, environment),
    directoryWritable: probeRuntimeDirectoryWritable(directory),
    activeLeases: seen.size,
  };
}

/** Reads only fresh process leases and reports whether any currently observable MCP process is outdated. */
export function getMcpRuntimeStatus(
  repositoryRoot: string,
  currentBuild: McpBuildIdentity | undefined = readMcpBuildIdentity(repositoryRoot),
  options: McpRuntimeStatusOptions = {},
): McpRuntimeStatus {
  const directory = getMcpRuntimeDirectory(repositoryRoot, options.environment);
  const requestedNow = options.now?.getTime();
  const now = requestedNow !== undefined && Number.isFinite(requestedNow) ? requestedNow : Date.now();
  const requestedTtl = options.heartbeatTtlMs;
  const heartbeatTtlMs = Math.max(
    1_000,
    requestedTtl !== undefined && Number.isFinite(requestedTtl) ? requestedTtl : MCP_HEARTBEAT_TTL_MS,
  );
  const probeRegistryWritable = options.probeRegistryWritable ?? probeRuntimeDirectoryWritable;
  if (!probeRegistryWritable(directory)) {
    return {
      activeProcesses: 0,
      outdatedProcesses: 0,
      updateAvailableProcesses: 0,
      updateAvailable: false,
      restartRequired: true,
      monitoringAvailable: false,
      message: MCP_UNKNOWN_MESSAGE,
    };
  }

  let files: Dirent[];
  try {
    if (!lstatSync(directory).isDirectory()) throw new Error("The runtime registry is not a directory.");
    files = readdirSync(directory, { withFileTypes: true });
  } catch {
    return {
      activeProcesses: 0,
      outdatedProcesses: 0,
      updateAvailableProcesses: 0,
      updateAvailable: false,
      restartRequired: true,
      monitoringAvailable: false,
      message: MCP_UNKNOWN_MESSAGE,
    };
  }

  const cleanupBudget = { attempts: 0 };
  const readActiveLeases = (leaseDirectory: string, entries: readonly Dirent[]): McpProcessLease[] =>
    freshLeases(leaseDirectory, entries, now, heartbeatTtlMs, cleanupBudget);
  const activeLeases = readActiveLeases(directory, files);
  // TODO: remove in 1.8.0. An MCP process started by 1.6.59 or earlier keeps writing to the system temp directory until
  // its Agent reconnects; it is counted from there when this process sees the same temp directory.
  try {
    const legacyDirectory = legacyMcpRuntimeDirectory(
      repositoryRoot,
      options.environment ?? process.env,
      process.platform,
    );
    if (legacyDirectory !== directory && lstatSync(legacyDirectory).isDirectory()) {
      const known = new Set(activeLeases.map((lease) => lease.instanceId));
      for (const lease of readActiveLeases(legacyDirectory, readdirSync(legacyDirectory, { withFileTypes: true }))) {
        if (!known.has(lease.instanceId)) activeLeases.push(lease);
      }
    }
  } catch {
    // No legacy registry (the usual case after the upgrade): nothing to add.
  }
  const outdatedProcesses = currentBuild
    ? activeLeases.filter(
        (lease) =>
          !lease.compatibilityId ||
          !currentBuild.compatibilityId ||
          lease.compatibilityId !== currentBuild.compatibilityId,
      ).length
    : 0;
  const updateAvailableProcesses = currentBuild
    ? activeLeases.filter(
        (lease) =>
          lease.buildId !== currentBuild.buildId &&
          lease.compatibilityId &&
          lease.compatibilityId === currentBuild.compatibilityId,
      ).length
    : 0;
  const compatibilityKnown = currentBuild?.compatibilityId !== undefined;
  const restartRequired = !compatibilityKnown || outdatedProcesses > 0;
  const message = !compatibilityKnown
    ? MCP_UNKNOWN_MESSAGE
    : restartRequired
      ? MCP_RECONNECT_MESSAGE
      : updateAvailableProcesses > 0
        ? MCP_UPDATE_MESSAGE
        : activeLeases.length > 0
          ? "所有可監測的 MCP 連線都是目前建置。"
          : "尚無可監測的 MCP 連線。";

  return {
    activeProcesses: activeLeases.length,
    outdatedProcesses,
    updateAvailableProcesses,
    updateAvailable: updateAvailableProcesses > 0,
    restartRequired,
    monitoringAvailable: compatibilityKnown,
    message,
  };
}
