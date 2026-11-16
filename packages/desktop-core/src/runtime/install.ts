import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../internal/atomic-file.js";
import { forEachLimited } from "./concurrency.js";
import { RuntimeError } from "./errors.js";
import { hashFile } from "./hash.js";
import {
  LAUNCH_FILE_NAME,
  MANIFEST_FILE_NAME,
  POSIX_SHIM_NAME,
  WINDOWS_SHIM_NAME,
  runtimeDirectoryFor,
  runtimeLayout,
} from "./layout.js";
import { parseRuntimeManifest, type RuntimeActions, type RuntimeKind, type RuntimeManifest } from "./manifest.js";
import { lstatEntry, sameFingerprint, scanRuntimeDirectory } from "./scan.js";
import { renderLaunchFile, renderPosixShim, renderWindowsShim } from "./shims.js";
import { assertSymlinksStayInside } from "./symlinks.js";
import { writeVerifiedCache, type CachedFile } from "./verified-cache.js";
import { verifyRuntime, type VerifiedRuntime, type VerifyRuntimeOptions } from "./verify.js";

/** What an installer decides about a runtime whose files are already in `runtimes/<runtimeId>/`. */
export interface RuntimeDefinition {
  readonly runtimeId: string;
  readonly runtimeKind: RuntimeKind;
  /** Relative path of the Node (or Electron) executable. */
  readonly executable: string;
  readonly actions: RuntimeActions;
}

/** The result of installing one runtime. */
export interface InstalledRuntime {
  readonly manifest: RuntimeManifest;
  readonly runtimeDirectory: string;
  /**
   * The verification run right after writing the manifest. By default it accepts the hashes computed while the
   * manifest was built (through the fingerprint cache); with `fullVerification` it re-reads every file.
   */
  readonly verification: VerifiedRuntime;
}

/** Options of {@link installRuntime}. */
export interface InstallRuntimeOptions {
  /** Re-read and re-hash every file after writing the manifest instead of trusting the hashes just computed. */
  readonly fullVerification?: boolean;
}

/** A manifest, and the fingerprints its files had while they were hashed (for files that did not change meanwhile). */
export interface MeasuredRuntime {
  readonly manifest: RuntimeManifest;
  readonly cache: ReadonlyMap<string, CachedFile>;
}

const HASH_CONCURRENCY = 4;
const MANIFEST_MODE = 0o644;
const SHIM_MODE = 0o755;

/** Writes `content` atomically unless the file already holds it, so installing twice does not touch a live shim. */
async function writeIfChanged(target: string, content: string, mode: number): Promise<void> {
  try {
    if ((await fs.readFile(target, "utf8")) === content) return;
  } catch {
    // Missing or unreadable: write it.
  }
  await writeFileAtomic(target, content, { mode });
}

/**
 * Computes the manifest of a staged runtime directory: every file's size and SHA-256 (streamed, four at a time) and
 * every symlink with its target. The manifest and the cache themselves are excluded. The result is validated with the
 * same schema the launcher uses, so an installer cannot produce a manifest the launcher would refuse for format, and
 * every symlink must resolve (links followed) to a place inside the directory.
 *
 * Each file's fingerprint is taken before hashing and again after; only a file whose fingerprint did not change while
 * it was read gets a cache entry, so the returned cache never vouches for a file that was modified during the hash.
 */
export async function measureRuntime(
  runtimeDirectory: string,
  definition: RuntimeDefinition,
): Promise<MeasuredRuntime> {
  const scan = await scanRuntimeDirectory(runtimeDirectory);
  if (scan.special.length > 0) {
    throw new RuntimeError("RUNTIME_FILE_UNEXPECTED", "要安裝的目錄內有特殊檔案", { file: scan.special[0] });
  }
  await assertSymlinksStayInside(runtimeDirectory, scan.symlinks);
  const hashes = new Map<string, string>();
  const cache = new Map<string, CachedFile>();
  await forEachLimited(scan.files, HASH_CONCURRENCY, async (file) => {
    const { sha256 } = await hashFile(path.join(runtimeDirectory, file.path));
    hashes.set(file.path, sha256);
    const after = await lstatEntry(path.join(runtimeDirectory, file.path));
    if (sameFingerprint(file.stat.fingerprint, after.fingerprint))
      cache.set(file.path, { sha256, ...after.fingerprint });
  });
  const manifest = parseRuntimeManifest({
    manifestVersion: 1,
    runtimeId: definition.runtimeId,
    runtimeKind: definition.runtimeKind,
    executable: definition.executable,
    actions: definition.actions,
    files: scan.files.map((file) => ({ path: file.path, size: file.stat.size, sha256: hashes.get(file.path) })),
    symlinks: scan.symlinks.map((link) => ({ path: link.path, target: link.target })),
  });
  return { manifest, cache };
}

/** {@link measureRuntime}, keeping only the manifest. */
export async function buildRuntimeManifest(
  runtimeDirectory: string,
  definition: RuntimeDefinition,
): Promise<RuntimeManifest> {
  return (await measureRuntime(runtimeDirectory, definition)).manifest;
}

/**
 * Installs a runtime whose files were already copied to `<root>/runtimes/<runtimeId>/`: writes the launch file and the
 * immutable manifest, makes sure the fixed shims exist in `<root>/bin`, then verifies the runtime. Every file is hashed
 * once, while the manifest is built; that measurement also seeds the fingerprint cache, so the verification here (and
 * the one in {@link commitCurrent}) only checks structure, permissions and fingerprints. Pass `fullVerification` to read
 * every file a second time instead. It does NOT switch `current`; call {@link commitCurrent} after the installer is happy.
 */
export async function installRuntime(
  root: string,
  definition: RuntimeDefinition,
  options: InstallRuntimeOptions = {},
): Promise<InstalledRuntime> {
  const runtimeDirectory = runtimeDirectoryFor(root, definition.runtimeId);
  const manifestPath = path.join(runtimeDirectory, MANIFEST_FILE_NAME);
  if (
    await fs.access(manifestPath).then(
      () => true,
      () => false,
    )
  ) {
    throw new RuntimeError("RUNTIME_ALREADY_INSTALLED", "這個 runtime id 已安裝；runtime 不可覆寫，請使用新的 id", {
      file: manifestPath,
    });
  }
  await writeFileAtomic(
    path.join(runtimeDirectory, LAUNCH_FILE_NAME),
    renderLaunchFile(definition.runtimeKind, definition.executable),
    { mode: MANIFEST_MODE },
  );
  const { manifest, cache } = await measureRuntime(runtimeDirectory, definition);
  await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: MANIFEST_MODE });
  await writeVerifiedCache(runtimeDirectory, definition.runtimeId, cache);

  const { binDirectory } = runtimeLayout(root);
  await writeIfChanged(path.join(binDirectory, POSIX_SHIM_NAME), renderPosixShim(), SHIM_MODE);
  await writeIfChanged(path.join(binDirectory, WINDOWS_SHIM_NAME), renderWindowsShim(), SHIM_MODE);

  const verification = await verifyRuntime(root, definition.runtimeId, { useCache: !options.fullVerification });
  return { manifest, runtimeDirectory, verification };
}

/**
 * Makes `runtimeId` the current runtime: verifies it completely, then replaces `current` atomically (temp file,
 * fsync, rename). A reader sees the old id or the new one, never a torn file, and an invalid runtime is never pointed at.
 */
export async function commitCurrent(
  root: string,
  runtimeId: string,
  options: VerifyRuntimeOptions = {},
): Promise<VerifiedRuntime> {
  const verification = await verifyRuntime(root, runtimeId, options);
  await writeFileAtomic(runtimeLayout(root).currentFile, `${runtimeId}\n`, { mode: MANIFEST_MODE });
  return verification;
}
