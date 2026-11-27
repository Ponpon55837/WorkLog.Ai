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
import { currentPermissionPolicy } from "./permissions.js";
import { verifyRuntime, type VerifiedRuntime, type VerifyRuntimeOptions } from "./verify.js";

export interface RuntimeDefinition {
  readonly runtimeId: string;
  readonly runtimeKind: RuntimeKind;
  readonly executable: string;
  readonly actions: RuntimeActions;
}

export interface InstalledRuntime {
  readonly manifest: RuntimeManifest;
  readonly runtimeDirectory: string;
  readonly verification: VerifiedRuntime;
}

export interface InstallRuntimeOptions {
  readonly fullVerification?: boolean;
  readonly aclReader?: VerifyRuntimeOptions["aclReader"];
  readonly policy?: VerifyRuntimeOptions["policy"];
  readonly checkAcl?: boolean;
}

export interface MeasuredRuntime {
  readonly manifest: RuntimeManifest;
  readonly cache: ReadonlyMap<string, CachedFile>;
}

const HASH_CONCURRENCY = 4;
const MANIFEST_MODE = 0o644;
const SHIM_MODE = 0o755;

async function writeIfChanged(target: string, content: string, mode: number): Promise<void> {
  try {
    if ((await fs.readFile(target, "utf8")) === content) return;
  } catch {
    // Missing or unreadable: write it.
  }
  await writeFileAtomic(target, content, { mode });
}

/**
 * `leases` is created here, before verification stamps the root, so a later lease does not cost the next start an ACL
 * read.
 */
export async function writeShims(root: string): Promise<void> {
  const { binDirectory, leasesDirectory } = runtimeLayout(root);
  await fs.mkdir(leasesDirectory, { recursive: true, mode: 0o700 });
  await writeIfChanged(path.join(binDirectory, POSIX_SHIM_NAME), renderPosixShim(), SHIM_MODE);
  await writeIfChanged(path.join(binDirectory, WINDOWS_SHIM_NAME), renderWindowsShim(), SHIM_MODE);
}

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

export async function buildRuntimeManifest(
  runtimeDirectory: string,
  definition: RuntimeDefinition,
): Promise<RuntimeManifest> {
  return (await measureRuntime(runtimeDirectory, definition)).manifest;
}

/** Does not switch `current`: call commitCurrent once the installer is satisfied. */
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
  await writeFileAtomic(path.join(runtimeDirectory, LAUNCH_FILE_NAME), renderLaunchFile(definition.executable), {
    mode: MANIFEST_MODE,
  });
  const { manifest, cache } = await measureRuntime(runtimeDirectory, definition);
  await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: MANIFEST_MODE });
  await writeVerifiedCache(runtimeDirectory, definition.runtimeId, cache);

  await writeShims(root);

  const verification = await verifyRuntime(root, definition.runtimeId, {
    useCache: !options.fullVerification,
    alwaysCheckAcl: true,
    ...(options.checkAcl === undefined ? {} : { checkAcl: options.checkAcl }),
    ...(options.aclReader ? { aclReader: options.aclReader } : {}),
    ...(options.policy ? { policy: options.policy } : {}),
  });
  return { manifest, runtimeDirectory, verification };
}

export async function commitCurrent(
  root: string,
  runtimeId: string,
  options: VerifyRuntimeOptions = {},
): Promise<VerifiedRuntime> {
  const currentFile = runtimeLayout(root).currentFile;
  const readsAcl = (options.policy ?? currentPermissionPolicy()).platform === "win32" && options.checkAcl !== false;
  if (!readsAcl || options.reuseAclStamp !== undefined) {
    const verification = await verifyRuntime(root, runtimeId, { alwaysCheckAcl: true, ...options });
    await writeFileAtomic(currentFile, `${runtimeId}\n`, { mode: MANIFEST_MODE });
    return verification;
  }
  // Windows stamps the ACL read with change times that the switch itself moves (M-09), so the pointer moves first and one
  // full verification follows; a runtime that fails verification is not left named (the previous pointer is restored).
  const previous = await fs.readFile(currentFile, "utf8").catch(() => undefined);
  await writeFileAtomic(currentFile, `${runtimeId}\n`, { mode: MANIFEST_MODE });
  try {
    return await verifyRuntime(root, runtimeId, { alwaysCheckAcl: true, ...options });
  } catch (error) {
    try {
      if (previous === undefined) await fs.rm(currentFile, { force: true });
      else await writeFileAtomic(currentFile, previous, { mode: MANIFEST_MODE });
    } catch {
      // The verification failure below is the error to report; a pointer that cannot be put back is found by the next start.
    }
    throw error;
  }
}
