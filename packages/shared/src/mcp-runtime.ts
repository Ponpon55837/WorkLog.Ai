import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

export interface McpBuildIdentity {
  version: string;
  distHash: string;
  buildId: string;
}

export interface McpRestartStatus {
  restartRequired: boolean;
  monitoringAvailable: boolean;
  message?: string;
}

export interface McpRuntimeStatus extends McpRestartStatus {
  activeProcesses: number;
  outdatedProcesses: number;
}

interface McpProcessLease {
  instanceId: string;
  buildId: string;
  version: string;
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
const MCP_RECONNECT_MESSAGE = "磁碟上的 Work Intelligence MCP 建置已更新，請重新連線 MCP。";
const MCP_UNKNOWN_MESSAGE = "無法確認磁碟上的 MCP 建置；請重新連線 MCP 後再繼續。";
const ROOT_PACKAGE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;

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

/** Build-only fingerprint calculation. Runtime status reads must use readMcpBuildIdentity instead. */
export function computeMcpBuildIdentity(repositoryRoot: string): McpBuildIdentity | undefined {
  const root = resolve(repositoryRoot);
  const version = packageVersion(root);
  if (!version) return undefined;
  try {
    const distHash = hashMcpRuntimeDist(root);
    if (packageVersion(root) !== version || hashMcpRuntimeDist(root) !== distHash) return undefined;
    return { version, distHash, buildId: `${version}:${distHash}` };
  } catch {
    return undefined;
  }
}

/** Captures the application version and the code-bearing dist files used by the stdio MCP process. */
export function readMcpBuildIdentity(repositoryRoot: string): McpBuildIdentity | undefined {
  const root = resolve(repositoryRoot);
  if (existsSync(resolve(root, MCP_BUILD_PROGRESS_FILE))) return undefined;
  const identity = computeMcpBuildIdentity(root);
  if (!identity || embeddedMcpBuildHash(root) !== identity.distHash) return undefined;
  if (existsSync(resolve(root, MCP_BUILD_PROGRESS_FILE))) return undefined;
  return identity;
}

/** Compares a process's embedded startup build with the current runtime dist on disk. */
export function getMcpRestartStatus(
  repositoryRoot: string,
  runningBuild: McpBuildIdentity | undefined,
): McpRestartStatus {
  const currentBuild = readMcpBuildIdentity(repositoryRoot);
  if (!currentBuild) {
    return { restartRequired: false, monitoringAvailable: false, message: MCP_UNKNOWN_MESSAGE };
  }
  if (!runningBuild) {
    return { restartRequired: true, monitoringAvailable: true, message: MCP_RECONNECT_MESSAGE };
  }
  if (currentBuild.buildId === runningBuild.buildId) {
    return { restartRequired: false, monitoringAvailable: true };
  }
  return { restartRequired: true, monitoringAvailable: true, message: MCP_RECONNECT_MESSAGE };
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
  const now = options.now?.getTime() ?? Date.now();
  const heartbeatTtlMs = Math.max(1_000, options.heartbeatTtlMs ?? MCP_HEARTBEAT_TTL_MS);
  const probeRegistryWritable = options.probeRegistryWritable ?? probeRuntimeDirectoryWritable;
  if (!probeRegistryWritable(directory)) {
    return {
      activeProcesses: 0,
      outdatedProcesses: 0,
      restartRequired: false,
      monitoringAvailable: false,
      message: MCP_UNKNOWN_MESSAGE,
    };
  }

  let files: string[];
  try {
    files = readdirSync(directory).filter((name) => name.endsWith(".json"));
  } catch {
    return {
      activeProcesses: 0,
      outdatedProcesses: 0,
      restartRequired: false,
      monitoringAvailable: false,
      message: MCP_UNKNOWN_MESSAGE,
    };
  }

  const activeLeases = files.flatMap((file) => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(directory, file), "utf8"));
      if (!parsed || typeof parsed !== "object") return [];
      const lease = parsed as Partial<McpProcessLease>;
      if (
        typeof lease.instanceId !== "string" ||
        basename(file) !== `${lease.instanceId}.json` ||
        typeof lease.buildId !== "string" ||
        typeof lease.heartbeatAt !== "string"
      ) {
        return [];
      }
      const heartbeatTime = Date.parse(lease.heartbeatAt);
      const age = now - heartbeatTime;
      return Number.isFinite(heartbeatTime) && age <= heartbeatTtlMs && age >= -5_000 ? [lease] : [];
    } catch {
      return [];
    }
  });
  const outdatedProcesses = currentBuild
    ? activeLeases.filter((lease) => lease.buildId !== currentBuild.buildId).length
    : 0;
  const restartRequired = outdatedProcesses > 0;
  const message = !currentBuild
    ? MCP_UNKNOWN_MESSAGE
    : restartRequired
      ? MCP_RECONNECT_MESSAGE
      : activeLeases.length > 0
        ? "所有可監測的 MCP 連線都是目前建置。"
        : "尚無可監測的 MCP 連線。";

  return {
    activeProcesses: activeLeases.length,
    outdatedProcesses,
    restartRequired,
    monitoringAvailable: currentBuild !== undefined,
    message,
  };
}
