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

/** Options of {@link verifyRuntime}. */
export interface VerifyRuntimeOptions {
  /** Platform and uid for the permission check; defaults to this process. */
  readonly policy?: PermissionPolicy;
  /** Files hashed at the same time, a positive integer; defaults to 4. */
  readonly concurrency?: number;
  /** Use and update `.verified.json`; defaults to true. */
  readonly useCache?: boolean;
  /** Windows: how the ACLs are read; defaults to Windows PowerShell 5.1 in a clean environment (.NET API, then `Get-Acl` and `whoami`). Tests inject fixtures. */
  readonly aclReader?: WindowsAclReader;
  /**
   * Windows: false verifies content and structure only and skips the ACL read (the result says `acl: "skipped"`). For a
   * runtime verified on a BUILD machine, whose folders have the build agent's ACLs; the installed App never sets it.
   * POSIX owner and mode checks are not affected. Defaults to true.
   */
  readonly checkAcl?: boolean;
  /** Windows: read the ACLs even when every file is a cache hit (installing or switching to a runtime). */
  readonly alwaysCheckAcl?: boolean;
  /**
   * Windows: the stamp ({@link VerifiedRuntime.aclStamp}) of an ACL read this same process made a moment ago, for one
   * provisioning that verifies twice (install, then commit). With `alwaysCheckAcl`, the read is skipped when every object
   * covered now has exactly the ctime and inode that stamp recorded and no object is covered that the read did not
   * cover (same labels). Any difference, or any file that missed the fingerprint cache, reads the ACLs as usual. Never
   * taken from disk: the `.verified.json` stamp may be from an earlier process and is not enough for an always-check.
   */
  readonly reuseAclStamp?: AclStamp;
}

/** A runtime that passed every check. */
export interface VerifiedRuntime {
  readonly runtimeId: string;
  readonly runtimeDirectory: string;
  readonly manifest: RuntimeManifest;
  /** `checked`: POSIX owner and mode, or on Windows the ACLs (read only when it can matter, see checkWindowsAcl). `skipped`: `checkAcl: false` on Windows. */
  readonly acl: AclCheck;
  /** Windows: whether the ACLs were read this time. Always false elsewhere. */
  readonly aclRead: boolean;
  /** Windows: which tier read the ACLs and how long each tier took; present only when they were read this time (absent when skipped or served from the stamp cache). */
  readonly aclReport?: AclReadReport;
  /** Windows: the change-time stamp of the objects that read vouched for; present exactly when the ACLs were read this time. */
  readonly aclStamp?: AclStamp;
  readonly fileCount: number;
  /** Files whose content was read and hashed this time. */
  readonly hashedCount: number;
  /** Files accepted from the stat-fingerprint cache without reading them. */
  readonly cachedCount: number;
}

const DEFAULT_CONCURRENCY = 4;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
/** Files the OS file managers create by themselves; an unlisted one of these does not fail verification. */
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

/** The launcher root, its `bin`, `leases` and `runtimes` folders and the pointer must not be writable by other users. */
async function checkRootPermissions(root: string, policy: PermissionPolicy): Promise<void> {
  const layout = runtimeLayout(root);
  // The root may be reached through a link (macOS /private/var, Windows short names): its target is what gets checked.
  // The folders and the pointer inside it must be real: a link there would move the check to wherever it points.
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
      // ENOTDIR: the state file below a `leases` that is not a folder; that is reported for `leases` itself.
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
  /** The object's change time and inode, when the object belongs to the stamp; the runtime directory itself does not. */
  readonly stamp: AclStampEntry | undefined;
}

/** The objects whose ACLs matter, those that exist, with the stamp of each. */
async function aclTargets(root: string, runtimeDirectory: string, manifest: RuntimeManifest): Promise<AclTarget[]> {
  const layout = runtimeLayout(root);
  const candidates: { label: string; path: string; stamped: boolean }[] = [
    { label: "root", path: root, stamped: true },
    { label: "bin", path: path.join(root, BIN_DIRECTORY_NAME), stamped: true },
    { label: "runtimes", path: layout.runtimesDirectory, stamped: true },
    // Like the runtime directory, its change time moves (a new runtime gets a lease folder), so it is checked, not stamped.
    { label: "leases", path: layout.leasesDirectory, stamped: false },
    { label: "current", path: layout.currentFile, stamped: true },
    { label: "shim", path: path.join(root, BIN_DIRECTORY_NAME, POSIX_SHIM_NAME), stamped: true },
    { label: "shim-cmd", path: path.join(root, BIN_DIRECTORY_NAME, WINDOWS_SHIM_NAME), stamped: true },
    // Its change time moves with every cache write (a new entry in it), so it is checked but not stamped; a file planted
    // there is rejected by the structure check anyway.
    { label: "runtime", path: runtimeDirectory, stamped: false },
    { label: "manifest", path: path.join(runtimeDirectory, MANIFEST_FILE_NAME), stamped: true },
    { label: "launch", path: path.join(runtimeDirectory, LAUNCH_FILE_NAME), stamped: true },
    { label: "launcher", path: path.join(runtimeDirectory, LAUNCHER_SCRIPT_NAME), stamped: true },
    { label: "executable", path: path.join(runtimeDirectory, manifest.executable), stamped: true },
  ];
  const targets: AclTarget[] = [];
  for (const candidate of candidates) {
    try {
      // The root may be reached through a link; its target is what is checked. Everything inside must be real.
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

/**
 * Windows only. Reads the ACL (owner and entries, by SID) of the launcher root, `bin` and both shims, `runtimes`,
 * `current`, the runtime directory, its manifest, launch file, `launcher.mjs` and executable, and refuses any that a
 * stranger owns or can write. Spawning PowerShell costs far more than everything else here, so it runs only when it can
 * matter: at install time and in a full verification (`useCache: false`), when any file misses the fingerprint cache, and
 * when the ACL stamp in `.verified.json` no longer matches. The stamp holds the change time (ctime) and inode of every
 * object above except the runtime directory, taken before the last successful read: changing an ACL updates the NTFS
 * ChangeTime (libuv reports it as ctime), and so do replacing `current` or a shim. The runtime directory is left out
 * because every cache write touches it, and a file planted in it is rejected by the structure check.
 *
 * Residual risk, stated plainly: ChangeTime can be set back from user mode, so someone who already holds WRITE_DAC on an
 * object (its owner, whom the check trusts) can change its ACL and restore the stamp. This guards against ordinary tools
 * and accidents, not against that principal. Files below the runtime directory are not read one by one: they inherit.
 */
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

/** Refuses a runtime directory that is itself a link: the manifest would vouch for whatever the link points at. */
async function checkRuntimeDirectory(runtimeDirectory: string): Promise<void> {
  let isLink: boolean;
  try {
    isLink = (await fs.lstat(runtimeDirectory)).isSymbolicLink();
  } catch (error) {
    throw new RuntimeError("RUNTIME_FILE_MISSING", "找不到 runtime 目錄", { file: runtimeDirectory }, { cause: error });
  }
  if (isLink) throw new RuntimeError("RUNTIME_SYMLINK_REJECTED", "runtime 目錄是符號連結", { file: runtimeDirectory });
}

/** Structure checks that need no file content: nothing extra, nothing missing, no unsafe entry, sizes as recorded. */
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
      // A file manager adds these on its own (L-16); they are metadata, never loaded, so they are not tampering.
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

/**
 * Verifies the runtime `runtimeId` below `root` against its manifest and returns what was checked.
 *
 * 1. Permissions (POSIX): the launcher root, `bin`, `runtimes`, `current` and everything in the runtime must not be
 *    world-writable and must belong to the current user. On Windows the ACLs of the same objects are read by SID (see
 *    checkWindowsAcl) and must give write access only to the current user, SYSTEM and Administrators; mode bits mean
 *    nothing there. The result is `acl: "checked"` on every platform, and a check that cannot run throws.
 * 2. Structure, from one walk: a file the manifest does not list is refused (so a planted module cannot be loaded), as
 *    is any symlink the manifest does not list; a missing file or a size that differs fails before any hashing.
 * 3. Content: files are hashed as streams, four at a time, while the Windows ACLs of step 1 are being read. After a
 *    full pass `.verified.json` records every file's stat fingerprint; later runs only `lstat` and re-hash the files
 *    whose fingerprint changed. A damaged or forged-for-another-runtime cache is ignored, so it can only cost time.
 *
 * Threat model, stated plainly: this detects accidental damage, a partial or interrupted update, and tampering by a
 * process that can modify a file but not the verifier's own files. Rewriting a file changes its ctime, which user
 * space cannot set back (unlike mtime, which `utimes` restores), so the fingerprint cache cannot be fooled by
 * restoring the old mtime. That is true on POSIX only: on Windows the NTFS ChangeTime can be set back from user
 * mode (SetFileInformationByHandle with FILE_BASIC_INFO), so there the stat cache only guards against accidental damage
 * and changes made by ordinary tools, not against a deliberate attacker. It does NOT stop an attacker who can write inside the runtime directory and also rewrite
 * `.verified.json`, the manifest or `launcher.mjs` itself: such an attacker already runs code as this user. Ownership
 * and ACL checks (and, later, code signing) are what protect against that, not hashes. A file may also change between
 * verification and `exec` (time of check to time of use); the owner-only directory checks are the mitigation.
 *
 * The same boundary applies one step earlier. The shims validate nothing and cannot hash: they start the executable
 * named in `runtime-launch.txt` BEFORE this verification runs, and that executable then loads `launcher.mjs`, which
 * calls this function. Anyone who can rewrite `runtime-launch.txt`, `current`, the executable or `launcher.mjs` skips
 * verification altogether; the defence against that is directory ownership and ACLs, plus code signing of the
 * executable in the future. What the launcher adds afterwards (checkLaunchConsistency) is a cross-check, not a
 * boundary: `runtime-launch.txt` must hold the manifest's executable, `process.execPath` must be that executable, and
 * `current` must be a legal id (a different one only warns). It runs inside the process that was started, so it
 * cannot undo what a swapped executable already did.
 * Symlinks are followed only for the launcher root itself; `bin`, `runtimes` and `current` must be real, and every
 * link inside a runtime must resolve (chains included) to somewhere inside that runtime.
 */
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

  // The permissions are read when it can matter: an install or switch, a full pass, a cache that vouched for nothing, or
  // any file that missed it. Otherwise only when the ACL stamp changed (see checkWindowsAcl). An install or switch trusts
  // only a stamp this process just produced, never the one on disk.
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

  // Hashing overlaps the ACL read (a PowerShell start on Windows): reading a file runs nothing, and nothing is trusted
  // until both have passed. When both fail, the permissions are reported: they say why the content cannot be trusted.
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
