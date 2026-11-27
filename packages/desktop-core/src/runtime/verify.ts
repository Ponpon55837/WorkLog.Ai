import fs from "node:fs/promises";
import path from "node:path";
import { errorCode, isMissingError } from "../internal/error-code.js";
import { forEachLimited } from "./concurrency.js";
import { RuntimeError } from "./errors.js";
import { hashFile } from "./hash.js";
import {
  BIN_DIRECTORY_NAME,
  LAUNCHER_SCRIPT_NAME,
  LAUNCH_FILE_NAME,
  MANIFEST_FILE_NAME,
  POSIX_SHIM_NAME,
  WINDOWS_SHIM_NAME,
  runtimeDirectoryFor,
  runtimeLayout,
} from "./layout.js";
import { parseRuntimeManifest, type RuntimeManifest } from "./manifest.js";
import { currentPermissionPolicy, permissionProblem, type AclCheck, type PermissionPolicy } from "./permissions.js";
import { assertSymlinksStayInside } from "./symlinks.js";
import { lstatEntry, sameFingerprint, scanRuntimeDirectory, type RuntimeScan, type ScannedFile } from "./scan.js";
import {
  readVerifiedCache,
  writeVerifiedCache,
  type AclStamp,
  type AclStampEntry,
  type CachedFile,
} from "./verified-cache.js";
import { assertWindowsAcl, createWindowsAclReader, type AclReadReport, type WindowsAclReader } from "./windows-acl.js";

export interface VerifyRuntimeOptions {
  readonly policy?: PermissionPolicy;
  readonly concurrency?: number;
  readonly useCache?: boolean;
  readonly aclReader?: WindowsAclReader;
  /**
   * Windows: false only for a runtime verified on a build machine (build agent's ACLs); the installed App never sets
   * it.
   */
  readonly checkAcl?: boolean;
  readonly alwaysCheckAcl?: boolean;
  /**
   * Only a stamp this process just produced; never the `.verified.json` one, which may come from an earlier process.
   */
  readonly reuseAclStamp?: AclStamp;
}

export interface VerifiedRuntime {
  readonly runtimeId: string;
  readonly runtimeDirectory: string;
  readonly manifest: RuntimeManifest;
  readonly acl: AclCheck;
  readonly aclRead: boolean;
  readonly aclReport?: AclReadReport;
  readonly aclStamp?: AclStamp;
  readonly fileCount: number;
  readonly hashedCount: number;
  readonly cachedCount: number;
}

const DEFAULT_CONCURRENCY = 4;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const SYSTEM_JUNK_NAMES: ReadonlySet<string> = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

async function readManifest(runtimeDirectory: string, runtimeId: string): Promise<RuntimeManifest> {
  const manifestPath = path.join(runtimeDirectory, MANIFEST_FILE_NAME);
  let text: string;
  try {
    const stat = await fs.lstat(manifestPath);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) {
      throw new RuntimeError("RUNTIME_MANIFEST_INVALID", "manifest 不是大小合理的一般檔案", { file: manifestPath });
    }
    text = await fs.readFile(manifestPath, "utf8");
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    const summary = isMissingError(error) ? "找不到 runtime manifest" : "無法讀取 runtime manifest";
    throw new RuntimeError(
      "RUNTIME_MANIFEST_INVALID",
      summary,
      { file: manifestPath, actual: String(error) },
      { cause: error },
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new RuntimeError(
      "RUNTIME_MANIFEST_INVALID",
      "runtime manifest 不是合法的 JSON",
      { file: manifestPath, actual: String(error) },
      { cause: error },
    );
  }
  const manifest = parseRuntimeManifest(raw);
  if (manifest.runtimeId !== runtimeId) {
    throw new RuntimeError("RUNTIME_MANIFEST_INVALID", "manifest 的 runtimeId 與所在目錄不同", {
      file: manifestPath,
      expected: runtimeId,
      actual: manifest.runtimeId,
    });
  }
  return manifest;
}

async function checkRootPermissions(root: string, policy: PermissionPolicy): Promise<void> {
  const layout = runtimeLayout(root);
  // The root may be reached through a link (macOS /private/var, Windows short names): its target is checked, but the
  // folders and the pointer inside it must be real.
  const candidates = [
    { path: root, follow: true },
    { path: path.join(root, BIN_DIRECTORY_NAME), follow: false },
    { path: layout.leasesDirectory, follow: false },
    { path: layout.gcStateFile, follow: false },
    { path: layout.runtimesDirectory, follow: false },
    { path: layout.currentFile, follow: false },
  ];
  for (const candidate of candidates) {
    let stat;
    try {
      stat = candidate.follow ? await fs.stat(candidate.path) : await fs.lstat(candidate.path);
    } catch (error) {
      if ((isMissingError(error) || errorCode(error) === "ENOTDIR") && candidate.path !== root) continue;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new RuntimeError(
        "RUNTIME_SYMLINK_REJECTED",
        "launcher 的 bin、leases、gc-state.json、runtimes 或 current 是符號連結",
        {
          file: candidate.path,
        },
      );
    }
    const problem = permissionProblem(stat, policy);
    if (problem !== undefined) {
      throw new RuntimeError("RUNTIME_UNSAFE_PERMISSIONS", "launcher 目錄的權限不安全", {
        file: candidate.path,
        actual: problem,
      });
    }
  }
}

interface AclTarget {
  readonly label: string;
  readonly path: string;
  readonly stamp: AclStampEntry | undefined;
}

async function aclTargets(root: string, runtimeDirectory: string, manifest: RuntimeManifest): Promise<AclTarget[]> {
  const layout = runtimeLayout(root);
  const candidates: { label: string; path: string; stamped: boolean }[] = [
    { label: "root", path: root, stamped: true },
    { label: "bin", path: path.join(root, BIN_DIRECTORY_NAME), stamped: true },
    { label: "runtimes", path: layout.runtimesDirectory, stamped: true },
    { label: "leases", path: layout.leasesDirectory, stamped: false },
    { label: "current", path: layout.currentFile, stamped: true },
    { label: "shim", path: path.join(root, BIN_DIRECTORY_NAME, POSIX_SHIM_NAME), stamped: true },
    { label: "shim-cmd", path: path.join(root, BIN_DIRECTORY_NAME, WINDOWS_SHIM_NAME), stamped: true },
    // Its change time moves with every cache write, so it is checked but not stamped.
    { label: "runtime", path: runtimeDirectory, stamped: false },
    { label: "manifest", path: path.join(runtimeDirectory, MANIFEST_FILE_NAME), stamped: true },
    { label: "launch", path: path.join(runtimeDirectory, LAUNCH_FILE_NAME), stamped: true },
    { label: "launcher", path: path.join(runtimeDirectory, LAUNCHER_SCRIPT_NAME), stamped: true },
    { label: "executable", path: path.join(runtimeDirectory, manifest.executable), stamped: true },
  ];
  const targets: AclTarget[] = [];
  for (const candidate of candidates) {
    try {
      const stat =
        candidate.label === "root"
          ? await fs.stat(candidate.path, { bigint: true })
          : await fs.lstat(candidate.path, { bigint: true });
      targets.push({
        label: candidate.label,
        path: candidate.path,
        stamp: candidate.stamped ? { ctimeNs: String(stat.ctimeNs), ino: String(stat.ino) } : undefined,
      });
    } catch (error) {
      if (!isMissingError(error)) throw error;
    }
  }
  return targets;
}

function sameAclStamp(left: AclStamp, right: AclStamp): boolean {
  const labels = Object.keys(right);
  return (
    Object.keys(left).length === labels.length &&
    labels.every((label) => left[label]?.ctimeNs === right[label]?.ctimeNs && left[label]?.ino === right[label]?.ino)
  );
}

async function checkWindowsAcl(
  root: string,
  runtimeDirectory: string,
  manifest: RuntimeManifest,
  known: AclStamp | undefined,
  force: boolean,
  reader: WindowsAclReader | undefined,
): Promise<{ readonly report?: AclReadReport; readonly stamp: AclStamp }> {
  const targets = await aclTargets(root, runtimeDirectory, manifest);
  const stamp: Record<string, AclStampEntry> = {};
  for (const target of targets) if (target.stamp !== undefined) stamp[target.label] = target.stamp;
  if (!force && known !== undefined && sameAclStamp(known, stamp)) return { stamp };
  const report = await assertWindowsAcl(
    targets.map((target) => target.path),
    reader ?? createWindowsAclReader(),
  );
  return { report, stamp };
}

async function checkRuntimeDirectory(runtimeDirectory: string): Promise<void> {
  let isLink: boolean;
  try {
    isLink = (await fs.lstat(runtimeDirectory)).isSymbolicLink();
  } catch (error) {
    throw new RuntimeError("RUNTIME_FILE_MISSING", "找不到 runtime 目錄", { file: runtimeDirectory }, { cause: error });
  }
  if (isLink) throw new RuntimeError("RUNTIME_SYMLINK_REJECTED", "runtime 目錄是符號連結", { file: runtimeDirectory });
}

function checkStructure(
  scan: RuntimeScan,
  manifest: RuntimeManifest,
  policy: PermissionPolicy,
): Map<string, ScannedFile> {
  const listedFiles = new Map(manifest.files.map((entry) => [entry.path, entry]));
  const listedLinks = new Map(manifest.symlinks.map((entry) => [entry.path, entry.target]));

  if (scan.special.length > 0) {
    throw new RuntimeError("RUNTIME_FILE_UNEXPECTED", "runtime 內有特殊檔案（socket、FIFO 或裝置）", {
      file: scan.special[0],
    });
  }
  for (const directory of scan.directories) {
    const problem = permissionProblem(directory.stat, policy);
    if (problem !== undefined) {
      throw new RuntimeError("RUNTIME_UNSAFE_PERMISSIONS", "runtime 目錄的權限不安全", {
        file: directory.path || ".",
        actual: problem,
      });
    }
  }
  for (const link of scan.symlinks) {
    const expected = listedLinks.get(link.path);
    if (expected === undefined) {
      throw new RuntimeError("RUNTIME_SYMLINK_REJECTED", "runtime 內有 manifest 未列出的符號連結", {
        file: link.path,
        actual: link.target,
      });
    }
    if (expected !== link.target) {
      throw new RuntimeError("RUNTIME_FILE_TAMPERED", "符號連結的目標與 manifest 不符", {
        file: link.path,
        expected,
        actual: link.target,
      });
    }
  }
  const scannedFiles = new Map<string, ScannedFile>();
  for (const file of scan.files) {
    if (!listedFiles.has(file.path)) {
      if (SYSTEM_JUNK_NAMES.has(file.path.slice(file.path.lastIndexOf("/") + 1))) continue;
      throw new RuntimeError("RUNTIME_FILE_UNEXPECTED", "runtime 內有 manifest 未列出的檔案", { file: file.path });
    }
    const problem = permissionProblem(file.stat, policy);
    if (problem !== undefined) {
      throw new RuntimeError("RUNTIME_UNSAFE_PERMISSIONS", "runtime 檔案的權限不安全", {
        file: file.path,
        actual: problem,
      });
    }
    scannedFiles.set(file.path, file);
  }
  const scannedLinks = new Set(scan.symlinks.map((link) => link.path));
  for (const link of manifest.symlinks) {
    if (!scannedLinks.has(link.path))
      throw new RuntimeError("RUNTIME_FILE_MISSING", "manifest 列出的符號連結不存在", { file: link.path });
  }
  for (const entry of manifest.files) {
    const scanned = scannedFiles.get(entry.path);
    if (scanned === undefined)
      throw new RuntimeError("RUNTIME_FILE_MISSING", "manifest 列出的檔案不存在", { file: entry.path });
    if (scanned.stat.size !== entry.size) {
      throw new RuntimeError("RUNTIME_FILE_TAMPERED", "檔案大小與 manifest 不符", {
        file: entry.path,
        expected: `${entry.size} bytes`,
        actual: `${scanned.stat.size} bytes`,
      });
    }
  }
  return scannedFiles;
}

export async function verifyRuntime(
  root: string,
  runtimeId: string,
  options: VerifyRuntimeOptions = {},
): Promise<VerifiedRuntime> {
  const policy = options.policy ?? currentPermissionPolicy();
  const runtimeDirectory = runtimeDirectoryFor(root, runtimeId);
  await checkRootPermissions(root, policy);
  await checkRuntimeDirectory(runtimeDirectory);
  const manifest = await readManifest(runtimeDirectory, runtimeId);
  const manifestProblem = permissionProblem(await lstatEntry(path.join(runtimeDirectory, MANIFEST_FILE_NAME)), policy);
  if (manifestProblem !== undefined) {
    throw new RuntimeError("RUNTIME_UNSAFE_PERMISSIONS", "manifest 的權限不安全", {
      file: path.join(runtimeDirectory, MANIFEST_FILE_NAME),
      actual: manifestProblem,
    });
  }

  const scan = await scanRuntimeDirectory(runtimeDirectory);
  const scannedFiles = checkStructure(scan, manifest, policy);
  await assertSymlinksStayInside(runtimeDirectory, scan.symlinks);

  const useCache = options.useCache ?? true;
  const cache = useCache ? await readVerifiedCache(runtimeDirectory, runtimeId) : undefined;
  const previous = cache?.files ?? new Map<string, CachedFile>();
  const verified = new Map<string, CachedFile>();
  const toHash: { entry: RuntimeManifest["files"][number]; scanned: ScannedFile }[] = [];
  for (const entry of manifest.files) {
    const scanned = scannedFiles.get(entry.path) as ScannedFile;
    const cached = previous.get(entry.path);
    if (cached !== undefined && cached.sha256 === entry.sha256 && sameFingerprint(cached, scanned.stat.fingerprint)) {
      verified.set(entry.path, cached);
    } else {
      toHash.push({ entry, scanned });
    }
  }

  // Permissions are read on an install or switch, a full pass, a cache that vouched for nothing, or a missed file; else
  // only when the ACL stamp changed. An install or switch trusts only a stamp this process just produced.
  const alwaysCheck = options.alwaysCheckAcl === true;
  const aclCheck =
    policy.platform === "win32" && options.checkAcl !== false
      ? checkWindowsAcl(
          root,
          runtimeDirectory,
          manifest,
          alwaysCheck ? options.reuseAclStamp : cache?.acl,
          !useCache || previous.size === 0 || toHash.length > 0,
          options.aclReader,
        )
      : Promise.resolve(undefined);

  // Hashing overlaps the ACL read (a PowerShell start on Windows); nothing is trusted until both have passed.
  const hashing = forEachLimited(toHash, options.concurrency ?? DEFAULT_CONCURRENCY, async ({ entry, scanned }) => {
    const digest = await hashFile(path.join(runtimeDirectory, entry.path));
    if (digest.bytes !== entry.size || digest.sha256 !== entry.sha256) {
      throw new RuntimeError("RUNTIME_FILE_TAMPERED", "檔案內容與 manifest 的 SHA-256 不符", {
        file: entry.path,
        expected: entry.sha256,
        actual: digest.sha256,
      });
    }
    // The fingerprint is the one taken before reading: a write during the read leaves a stale one, so the next run hashes again.
    verified.set(entry.path, { sha256: entry.sha256, ...scanned.stat.fingerprint });
  });
  const [aclOutcome, hashOutcome] = await Promise.allSettled([aclCheck, hashing]);
  if (aclOutcome.status === "rejected") throw aclOutcome.reason;
  if (hashOutcome.status === "rejected") throw hashOutcome.reason;
  const acl = aclOutcome.value;

  if (useCache && (toHash.length > 0 || previous.size !== verified.size || acl?.report !== undefined)) {
    const ordered = new Map(manifest.files.map((entry) => [entry.path, verified.get(entry.path) as CachedFile]));
    await writeVerifiedCache(runtimeDirectory, runtimeId, ordered, acl?.stamp);
  }
  return {
    runtimeId,
    runtimeDirectory,
    manifest,
    acl: policy.platform === "win32" && options.checkAcl === false ? "skipped" : "checked",
    aclRead: acl?.report !== undefined,
    ...(acl?.report ? { aclReport: acl.report, aclStamp: acl.stamp } : {}),
    fileCount: manifest.files.length,
    hashedCount: toHash.length,
    cachedCount: manifest.files.length - toHash.length,
  };
}
