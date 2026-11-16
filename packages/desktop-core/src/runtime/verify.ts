import fs from "node:fs/promises";
import path from "node:path";
import { isMissingError } from "../internal/error-code.js";
import { forEachLimited } from "./concurrency.js";
import { RuntimeError } from "./errors.js";
import { hashFile } from "./hash.js";
import { BIN_DIRECTORY_NAME, MANIFEST_FILE_NAME, runtimeDirectoryFor, runtimeLayout } from "./layout.js";
import { parseRuntimeManifest, type RuntimeManifest } from "./manifest.js";
import {
  aclCheckFor,
  currentPermissionPolicy,
  permissionProblem,
  type AclCheck,
  type PermissionPolicy,
} from "./permissions.js";
import { assertSymlinksStayInside } from "./symlinks.js";
import { lstatEntry, sameFingerprint, scanRuntimeDirectory, type RuntimeScan, type ScannedFile } from "./scan.js";
import { readVerifiedCache, writeVerifiedCache, type CachedFile } from "./verified-cache.js";

/** Options of {@link verifyRuntime}. */
export interface VerifyRuntimeOptions {
  /** Platform and uid for the permission check; defaults to this process. */
  readonly policy?: PermissionPolicy;
  /** Files hashed at the same time, a positive integer; defaults to 4. */
  readonly concurrency?: number;
  /** Use and update `.verified.json`; defaults to true. */
  readonly useCache?: boolean;
}

/** A runtime that passed every check. */
export interface VerifiedRuntime {
  readonly runtimeId: string;
  readonly runtimeDirectory: string;
  readonly manifest: RuntimeManifest;
  /** `not-implemented` on Windows: file contents were verified but ACLs were not. */
  readonly acl: AclCheck;
  readonly fileCount: number;
  /** Files whose content was read and hashed this time. */
  readonly hashedCount: number;
  /** Files accepted from the stat-fingerprint cache without reading them. */
  readonly cachedCount: number;
}

const DEFAULT_CONCURRENCY = 4;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

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

/** The launcher root, its `bin` and `runtimes` folders and the pointer must not be writable by other users. */
async function checkRootPermissions(root: string, policy: PermissionPolicy): Promise<void> {
  const layout = runtimeLayout(root);
  // The root may be reached through a link (macOS /private/var, Windows short names): its target is what gets checked.
  // The folders and the pointer inside it must be real: a link there would move the check to wherever it points.
  const candidates = [
    { path: root, follow: true },
    { path: path.join(root, BIN_DIRECTORY_NAME), follow: false },
    { path: layout.runtimesDirectory, follow: false },
    { path: layout.currentFile, follow: false },
  ];
  for (const candidate of candidates) {
    let stat;
    try {
      stat = candidate.follow ? await fs.stat(candidate.path) : await fs.lstat(candidate.path);
    } catch (error) {
      if (isMissingError(error) && candidate.path !== root) continue;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new RuntimeError("RUNTIME_SYMLINK_REJECTED", "launcher 的 bin、runtimes 或 current 是符號連結", {
        file: candidate.path,
      });
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
 *    world-writable and must belong to the current user. Windows ACLs are not inspected yet (`acl: "not-implemented"`).
 * 2. Structure, from one walk: a file the manifest does not list is refused (so a planted module cannot be loaded), as
 *    is any symlink the manifest does not list; a missing file or a size that differs fails before any hashing.
 * 3. Content: files are hashed as streams, four at a time. After a full pass `.verified.json` records every file's
 *    stat fingerprint; later runs only `lstat` and re-hash the files whose fingerprint changed. A damaged or forged-for-
 *    another-runtime cache is ignored, so it can only cost time.
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
  const previous = useCache ? await readVerifiedCache(runtimeDirectory, runtimeId) : new Map<string, CachedFile>();
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

  await forEachLimited(toHash, options.concurrency ?? DEFAULT_CONCURRENCY, async ({ entry, scanned }) => {
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

  if (useCache && (toHash.length > 0 || previous.size !== verified.size)) {
    const ordered = new Map(manifest.files.map((entry) => [entry.path, verified.get(entry.path) as CachedFile]));
    await writeVerifiedCache(runtimeDirectory, runtimeId, ordered);
  }
  return {
    runtimeId,
    runtimeDirectory,
    manifest,
    acl: aclCheckFor(policy),
    fileCount: manifest.files.length,
    hashedCount: toHash.length,
    cachedCount: manifest.files.length - toHash.length,
  };
}
