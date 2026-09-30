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
import { basename, join, relative, resolve } from "node:path";

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
}

const MCP_RUNTIME_DIST_DIRECTORIES = [
  "apps/mcp/dist",
  "packages/core/dist",
  "packages/project-policy/dist",
  "packages/schema/dist",
  "packages/shared/dist",
  "packages/storage/dist",
] as const;
const MCP_ENTRY_FILE = "apps/mcp/dist/index.js";
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
      ...MCP_RUNTIME_DIST_DIRECTORIES.flatMap((directory) => {
        const absolute = resolve(repositoryRoot, directory);
        return existsSync(absolute) ? javascriptFiles(absolute, repositoryRoot).sort() : [`missing:${directory}`];
      }),
    ]) {
      if (file.startsWith("missing:")) {
        parts.push(file);
        continue;
      }
      const stats = statSync(resolve(repositoryRoot, file));
      parts.push(`${file}\0${stats.size}\0${stats.mtimeMs}\0${stats.ino}`);
    }
    return parts.join("\n");
  } catch {
    return undefined;
  }
}

function stableFileRead(path: string): Buffer {
  const before = statSync(path);
  const contents = readFileSync(path);
  const after = statSync(path);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
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
    source.replace(MCP_ENTRY_IDENTITY_PATTERN, 'const MCP_BUILD_DIST_HASH = "__WORK_INTELLIGENCE_BUILD_HASH__";'),
  );
}

function hashMcpRuntimeDist(repositoryRoot: string): string {
  const digest = createHash("sha256");
  let filesFound = 0;
  for (const relativeDirectory of MCP_RUNTIME_DIST_DIRECTORIES) {
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

/** Returns the process-lease directory shared by the MCP, local API server, and doctor for one install. */
export function getMcpRuntimeDirectory(repositoryRoot: string): string {
  let canonicalRoot = resolve(repositoryRoot);
  try {
    canonicalRoot = realpathSync(canonicalRoot);
  } catch {
    // Keep the resolved path for a not-yet-created synthetic installation in tests.
  }
  const scopeId = createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 24);
  return join(tmpdir(), "work-intelligence", "mcp-runtime", scopeId);
}

/** Registers one MCP process with an atomic lease file; each client process has its own independent lease. */
export function registerMcpProcess(
  repositoryRoot: string,
  build: McpBuildIdentity | undefined,
  options: { heartbeatIntervalMs?: number; now?: () => Date } = {},
): () => void {
  const directory = getMcpRuntimeDirectory(repositoryRoot);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch {
    return () => undefined;
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
    } catch {
      // An unavailable registry must not crash the stdio process; the MCP response still reports local status.
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
  return cleanup;
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

/** Reads only fresh process leases and reports whether any currently observable MCP process is outdated. */
export function getMcpRuntimeStatus(
  repositoryRoot: string,
  currentBuild: McpBuildIdentity | undefined = readMcpBuildIdentity(repositoryRoot),
  options: McpRuntimeStatusOptions = {},
): McpRuntimeStatus {
  const directory = getMcpRuntimeDirectory(repositoryRoot);
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
  const activeLeases = files.flatMap((file) => {
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
    return Number.isFinite(heartbeatTime) && age <= heartbeatTtlMs && age >= -5_000 ? [lease] : [];
  });
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
