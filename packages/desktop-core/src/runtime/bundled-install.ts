import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { errorCode } from "../internal/error-code.js";
import { forEachLimited } from "./concurrency.js";
import { REINSTALLABLE_CODES, RuntimeError } from "./errors.js";
import { commitCurrent, writeShims } from "./install.js";
import {
  MANIFEST_FILE_NAME,
  QUARANTINE_DIRECTORY_PREFIX,
  RUNTIMES_DIRECTORY_NAME,
  STAGING_DIRECTORY_PREFIX,
  readCurrentRuntimeId,
  runtimeDirectoryFor,
} from "./layout.js";
import { SHA256_PATTERN, parseRuntimeManifest, type RuntimeKind, type RuntimeManifest } from "./manifest.js";
import { scanRuntimeDirectory } from "./scan.js";
import { assertSymlinksStayInside } from "./symlinks.js";
import { verifyRuntime, type VerifyRuntimeOptions } from "./verify.js";
import type { AclReadReport } from "./windows-acl.js";

/** How `ensureBundledRuntime` found the installed runtime and what it did about it. */
export type BundledRuntimeStatus = "already-current" | "switched" | "installed" | "reinstalled";

/** The result of {@link ensureBundledRuntime}. */
export interface EnsuredRuntime {
  readonly status: BundledRuntimeStatus;
  readonly runtimeId: string;
  readonly elapsedMs: number;
  /** Bytes written into the launcher root (zero unless installed or reinstalled). */
  readonly bytesCopied: number;
  /** Files whose content was read and hashed (zero on the fast path). */
  readonly hashedCount: number;
  /** The runtime `current` named before this call, when it was another one (a candidate fallback to keep). */
  readonly previousRuntimeId: string | undefined;
  /** Windows: which tier read the ACLs and how long each tier took, when this call read them (absent on the fast path). */
  readonly aclReport?: AclReadReport;
  /** Windows: how many times this call spawned PowerShell to read the ACLs (0 on the fast path or from the stamp cache). */
  readonly aclReads: number;
}

/** The file system calls that can be made to fail in tests. */
export interface BundledInstallDeps {
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly now: () => number;
}

/** Options of {@link ensureBundledRuntime}. */
export interface EnsureBundledRuntimeOptions {
  /** Hex SHA-256 of the bundle's `runtime-manifest.json` bytes, fixed when the App was built. */
  readonly expectedManifestSha256: string;
  /** Refuse a bundle of another kind; the packaged App only runs `node`. */
  readonly requiredRuntimeKind?: RuntimeKind;
  /**
   * Skip the fast path: verify the installed runtime (through the fingerprint cache) even when it looks current, and
   * reinstall it when that fails. For a retry after the backend refused the runtime.
   */
  readonly verifyInstalled?: boolean;
  /** Passed to every verification (platform policy and the Windows ACL reader). */
  readonly verify?: Pick<VerifyRuntimeOptions, "policy" | "aclReader" | "concurrency">;
  readonly deps?: Partial<BundledInstallDeps>;
}

/** The bundle as read and checked: its id, directory and the manifest bytes the App was built with. */
interface Bundle {
  readonly runtimeId: string;
  readonly directory: string;
  readonly manifestBytes: Buffer;
  readonly manifest: RuntimeManifest;
}

const COPY_CONCURRENCY = 4;
/** Waits before each retry of a rename that Windows refused while Defender or the indexer holds the new files. */
const RENAME_RETRY_DELAYS_MS: readonly number[] = [50, 100, 200, 400, 800, 1_000, 1_000, 1_000];
const RENAME_RETRYABLE: ReadonlySet<string> = new Set(["EPERM", "EBUSY", "EACCES"]);
const MAX_BUNDLE_MANIFEST_BYTES = 4 * 1024 * 1024;
const GROUP_OTHER_WRITE = 0o022;
const MANIFEST_MODE = 0o644;

const NODE_DEPS: BundledInstallDeps = {
  rename: (from, to) => fs.rename(from, to),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now: () => performance.now(),
};

function bundleError(summary: string, file: string, cause?: unknown): RuntimeError {
  return new RuntimeError("RUNTIME_BUNDLE_INVALID", summary, { file }, cause === undefined ? undefined : { cause });
}

function installFailed(summary: string, file: string, cause: unknown): RuntimeError {
  return new RuntimeError(
    "RUNTIME_INSTALL_FAILED",
    summary,
    { file, actual: cause instanceof Error ? cause.message : String(cause) },
    { cause },
  );
}

/** Reads `<bundleRoot>/current` and the bundle manifest, and refuses a manifest that is not the one baked into the App. */
async function readBundle(bundleRoot: string, options: EnsureBundledRuntimeOptions): Promise<Bundle> {
  const expected = options.expectedManifestSha256.toLowerCase();
  if (!SHA256_PATTERN.test(expected)) {
    throw bundleError("App 內建的 runtime manifest 雜湊格式不正確", bundleRoot);
  }
  let runtimeId: string;
  try {
    runtimeId = await readCurrentRuntimeId(bundleRoot);
  } catch (error) {
    throw bundleError("找不到或無法讀取隨 App 附的 runtime 指標", bundleRoot, error);
  }
  const directory = runtimeDirectoryFor(bundleRoot, runtimeId);
  const manifestPath = path.join(directory, MANIFEST_FILE_NAME);
  let manifestBytes: Buffer;
  try {
    const stat = await fs.lstat(manifestPath);
    if (!stat.isFile() || stat.size > MAX_BUNDLE_MANIFEST_BYTES)
      throw new RangeError("not a regular file of sane size");
    manifestBytes = await fs.readFile(manifestPath);
  } catch (error) {
    throw bundleError("找不到或無法讀取隨 App 附的 runtime manifest", manifestPath, error);
  }
  if (createHash("sha256").update(manifestBytes).digest("hex") !== expected) {
    throw bundleError("隨 App 附的 runtime manifest 與建置時記錄的不同", manifestPath);
  }
  let manifest: RuntimeManifest;
  try {
    manifest = parseRuntimeManifest(JSON.parse(manifestBytes.toString("utf8")));
  } catch (error) {
    throw bundleError("隨 App 附的 runtime manifest 格式不正確", manifestPath, error);
  }
  if (manifest.runtimeId !== runtimeId) throw bundleError("隨 App 附的 manifest 的 runtimeId 與指標不同", manifestPath);
  if (options.requiredRuntimeKind !== undefined && manifest.runtimeKind !== options.requiredRuntimeKind) {
    throw new RuntimeError("RUNTIME_KIND_NOT_ALLOWED", "隨 App 附的 runtime 種類不允許", {
      file: manifestPath,
      expected: options.requiredRuntimeKind,
      actual: manifest.runtimeKind,
    });
  }
  return { runtimeId, directory, manifestBytes, manifest };
}

async function readIfPresent(file: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return undefined;
    throw error;
  }
}

function uniqueName(prefix: string, runtimeId: string): string {
  return `${prefix}${runtimeId}-${randomBytes(4).toString("hex")}`;
}

/**
 * `rename` with a bounded backoff for the errors Windows gives while another process (Defender scanning a fresh
 * `node.exe`, the search indexer) briefly holds a file inside the directory. Any other error, and the last of these,
 * is thrown.
 */
async function renameWithRetry(deps: BundledInstallDeps, from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await deps.rename(from, to);
      return;
    } catch (error) {
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !RENAME_RETRYABLE.has(errorCode(error) ?? "")) throw error;
      await deps.sleep(delay);
    }
  }
}

async function removeQuietly(target: string): Promise<void> {
  try {
    await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // Best effort: a directory another process still holds is tried again by a later start.
  }
}

/** Removes staging directories a crashed attempt left. Quarantined directories are collected later (see runtime-gc.ts). */
async function cleanLeftovers(root: string): Promise<void> {
  const runtimes = path.join(root, RUNTIMES_DIRECTORY_NAME);
  let names: string[];
  try {
    names = await fs.readdir(runtimes);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((name) => name.startsWith(STAGING_DIRECTORY_PREFIX))
      .map((name) => removeQuietly(path.join(runtimes, name))),
  );
}

/** Moves a runtime directory out of the way without deleting it: a process that still runs from it keeps working. */
async function quarantine(root: string, runtimeId: string, deps: BundledInstallDeps): Promise<string> {
  const target = runtimeDirectoryFor(root, runtimeId);
  const aside = path.join(root, RUNTIMES_DIRECTORY_NAME, uniqueName(QUARANTINE_DIRECTORY_PREFIX, runtimeId));
  try {
    await renameWithRetry(deps, target, aside);
    return aside;
  } catch (error) {
    throw installFailed("無法移開損壞的 runtime 目錄", target, error);
  }
}

/** Moves a set-aside directory back to `target` when the failed install left nothing there; best effort. */
async function restoreQuarantined(deps: BundledInstallDeps, aside: string, target: string): Promise<void> {
  const taken = await fs.lstat(target).then(
    () => true,
    () => false,
  );
  if (taken) return;
  await renameWithRetry(deps, aside, target).catch(() => undefined);
}

/** Refuses a bundle whose files are not exactly the manifest's, before anything is copied. */
async function checkBundleContent(bundle: Bundle): Promise<Awaited<ReturnType<typeof scanRuntimeDirectory>>> {
  const scan = await scanRuntimeDirectory(bundle.directory);
  if (scan.special.length > 0) throw bundleError("隨 App 附的 runtime 內有特殊檔案", scan.special[0] as string);
  await assertSymlinksStayInside(bundle.directory, scan.symlinks);
  const listed = new Map(bundle.manifest.files.map((entry) => [entry.path, entry.size]));
  const found = new Set(scan.files.map((file) => file.path));
  const unexpected = scan.files.find((file) => listed.get(file.path) !== file.stat.size);
  const missing = bundle.manifest.files.find((entry) => !found.has(entry.path));
  if (unexpected !== undefined)
    throw bundleError("隨 App 附的 runtime 內有 manifest 未列出或大小不符的檔案", unexpected.path);
  if (missing !== undefined) throw bundleError("隨 App 附的 runtime 缺少 manifest 列出的檔案", missing.path);
  return scan;
}

/**
 * Copies the bundle into `staging`: directories, then files (with the owner's permission bits, minus group and other
 * write, so an executable stays executable and a bundle built with a loose umask cannot make the copy unsafe), then the
 * symlinks exactly as listed, then the manifest bytes that were already checked. Returns the bytes written.
 */
async function copyBundle(
  bundle: Bundle,
  scan: Awaited<ReturnType<typeof scanRuntimeDirectory>>,
  staging: string,
): Promise<number> {
  await fs.mkdir(staging, { recursive: true });
  for (const directory of scan.directories) {
    if (directory.path !== "") await fs.mkdir(path.join(staging, directory.path), { recursive: true });
  }
  let bytes = 0;
  await forEachLimited(scan.files, COPY_CONCURRENCY, async (file) => {
    const target = path.join(staging, file.path);
    // FICLONE is "clone if the volume can, copy otherwise": instant on APFS, a plain copy elsewhere.
    await fs.copyFile(path.join(bundle.directory, file.path), target, fsConstants.COPYFILE_FICLONE);
    const mode = file.stat.mode & 0o777 & ~GROUP_OTHER_WRITE;
    if (process.platform !== "win32") await fs.chmod(target, mode);
    bytes += file.stat.size;
  });
  for (const link of scan.symlinks) await fs.symlink(link.target, path.join(staging, link.path));
  await fs.writeFile(path.join(staging, MANIFEST_FILE_NAME), bundle.manifestBytes, { mode: MANIFEST_MODE });
  return bytes + bundle.manifestBytes.length;
}

/** Copies, renames into place, writes the shims, verifies every file against the bundle manifest and points `current` at it. */
async function installFromBundle(
  root: string,
  bundle: Bundle,
  options: EnsureBundledRuntimeOptions,
  deps: BundledInstallDeps,
): Promise<{ bytesCopied: number; hashedCount: number; aclReport: AclReadReport | undefined }> {
  const runtimes = path.join(root, RUNTIMES_DIRECTORY_NAME);
  const staging = path.join(runtimes, uniqueName(STAGING_DIRECTORY_PREFIX, bundle.runtimeId));
  const target = runtimeDirectoryFor(root, bundle.runtimeId);
  await fs.mkdir(runtimes, { recursive: true });
  let bytesCopied: number;
  try {
    const scan = await checkBundleContent(bundle);
    bytesCopied = await copyBundle(bundle, scan, staging);
    await renameWithRetry(deps, staging, target);
  } catch (error) {
    await removeQuietly(staging);
    throw error instanceof RuntimeError ? error : installFailed("無法把 runtime 複製到安裝目錄", target, error);
  }
  try {
    await writeShims(root);
    // No cache exists yet, so this reads and hashes every file once, against the bundle's own manifest, and writes the cache.
    const verification = await commitCurrent(root, bundle.runtimeId, { ...options.verify, useCache: true });
    return { bytesCopied, hashedCount: verification.hashedCount, aclReport: verification.aclReport };
  } catch (error) {
    // Wrong content must not stay where `current` or a retry could pick it up. A permission problem is not the files'
    // fault and copying again would not fix it: the directory stays, `current` is not switched, and the repair flow explains.
    if (error instanceof RuntimeError && REINSTALLABLE_CODES.has(error.code)) {
      await quarantine(root, bundle.runtimeId, deps).catch(() => undefined);
    }
    throw error instanceof RuntimeError ? error : installFailed("無法完成 runtime 安裝", target, error);
  }
}

/**
 * Makes sure the launcher root `root` holds, and points `current` at, the runtime that ships inside the App
 * (`<bundleRoot>/current` plus `<bundleRoot>/runtimes/<id>/`, complete except for `.verified.json`).
 *
 * The bundle manifest is trusted only if its bytes hash to `expectedManifestSha256`, a value fixed in the main bundle at
 * build time; the manifest in turn lists every file's SHA-256, so the copy is verified against the bundle's own manifest,
 * not a re-measured one.
 *
 * - Fast path (the usual start): the installed manifest has the same bytes and `current` names the runtime. Nothing is
 *   hashed or copied; the backend launch verifies through the fingerprint cache anyway. `verifyInstalled` runs that
 *   verification here instead and reinstalls when it fails.
 * - Installed but not current: verified (cache) and switched.
 * - Otherwise: copied into `runtimes/.staging-<id>-<random>` (same volume, a name no runtime id can have), renamed into
 *   place with a bounded retry, shims written, every file hashed once, `current` switched. A directory that exists with a
 *   different manifest or fails verification is renamed to `runtimes/.quarantine-<id>-<random>` first (never deleted at
 *   that moment: a process may still run from it) and later starts remove such leftovers.
 * Two Apps never run this at once: the single-instance lock is held first.
 */
export async function ensureBundledRuntime(
  root: string,
  bundleRoot: string,
  options: EnsureBundledRuntimeOptions,
): Promise<EnsuredRuntime> {
  const deps: BundledInstallDeps = { ...NODE_DEPS, ...options.deps };
  const started = deps.now();
  const bundle = await readBundle(bundleRoot, options);
  const target = runtimeDirectoryFor(root, bundle.runtimeId);
  const installedManifest = await readIfPresent(path.join(target, MANIFEST_FILE_NAME));
  const sameManifest = installedManifest?.equals(bundle.manifestBytes) === true;
  const currentId = await readCurrentRuntimeId(root).catch(() => undefined);
  const previousRuntimeId = currentId !== bundle.runtimeId ? currentId : undefined;
  const finish = (
    status: BundledRuntimeStatus,
    bytesCopied: number,
    hashedCount: number,
    aclReport?: AclReadReport,
  ): EnsuredRuntime => ({
    status,
    runtimeId: bundle.runtimeId,
    elapsedMs: Math.round(deps.now() - started),
    bytesCopied,
    hashedCount,
    previousRuntimeId,
    aclReads: aclReport === undefined ? 0 : 1,
    ...(aclReport ? { aclReport } : {}),
  });

  if (sameManifest && currentId === bundle.runtimeId && options.verifyInstalled !== true) {
    await writeShims(root).catch((error: unknown) => {
      throw installFailed("無法寫入 launcher shim", path.join(root, "bin"), error);
    });
    return finish("already-current", 0, 0);
  }
  if (sameManifest) {
    try {
      const verified =
        currentId === bundle.runtimeId
          ? await verifyRuntime(root, bundle.runtimeId, { ...options.verify, useCache: true })
          : await commitCurrent(root, bundle.runtimeId, { ...options.verify, useCache: true });
      await writeShims(root).catch((error: unknown) => {
        throw installFailed("無法寫入 launcher shim", path.join(root, "bin"), error);
      });
      return finish(
        currentId === bundle.runtimeId ? "already-current" : "switched",
        0,
        verified.hashedCount,
        verified.aclReport,
      );
    } catch (error) {
      if (!(error instanceof RuntimeError) || !REINSTALLABLE_CODES.has(error.code)) throw error;
      // Damaged files: fall through to a clean reinstall.
    }
  }

  await cleanLeftovers(root);
  const existed =
    installedManifest !== undefined ||
    (await fs.lstat(target).then(
      () => true,
      () => false,
    ));
  const quarantined = existed ? await quarantine(root, bundle.runtimeId, deps) : undefined;
  try {
    const { bytesCopied, hashedCount, aclReport } = await installFromBundle(root, bundle, options, deps);
    return finish(existed ? "reinstalled" : "installed", bytesCopied, hashedCount, aclReport);
  } catch (error) {
    // `current` must never name a directory that is gone: put the set-aside one back when nothing took its place.
    if (quarantined !== undefined) await restoreQuarantined(deps, quarantined, target);
    throw error;
  }
}
