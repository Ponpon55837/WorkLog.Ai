/**
 * Ad-hoc signing of the macOS .app, owned by this repository instead of electron-builder (which skips every signing step
 * on GitHub pull_request runs, so the fuse-flipped app would keep Electron's broken original signature).
 *
 * `codesign --force --sign -` is run inside-out, one path at a time, with no --deep: nested code is signed before the
 * bundle that seals it. No hardened runtime, entitlements or metadata are carried over (there is no Developer ID yet).
 * Everything is walked with lstat and never through symlinks (`Versions/Current`, `Electron Framework` links). The runtime
 * bundle under Contents/Resources/runtime-bundle is never touched: its official Node binary keeps its own signature and
 * its bytes keep matching the runtime manifest.
 */
import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { closeSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MACH_O_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe]);
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_SWAPPED = 0xbebafeca;
/** A fat header holds a handful of architectures; a Java class file (same 0xcafebabe) has a version number >= 45 there. */
const MAX_FAT_ARCHITECTURES = 8;
const RUNTIME_BUNDLE = "Contents/Resources/runtime-bundle/";
const MAIN_EXECUTABLE = /(^|\/)Contents\/MacOS\/[^/]+$/;
const FRAMEWORK_EXECUTABLE = /(^|\/)([^/]+)\.framework\/Versions\/[^/]+\/\2$/;
const TOP_LEVEL_BUNDLE = /^Contents\/Frameworks\/[^/]+$/;

/** Whether the first bytes of a file (at least 8) are a Mach-O or fat Mach-O header. */
export function isMachOHeader(bytes) {
  if (bytes.length < 8) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, false);
  if (MACH_O_MAGICS.has(magic)) return true;
  if (magic === FAT_MAGIC) return view.getUint32(4, false) <= MAX_FAT_ARCHITECTURES;
  if (magic === FAT_MAGIC_SWAPPED) return view.getUint32(4, true) <= MAX_FAT_ARCHITECTURES;
  return false;
}

function depth(path) {
  return path.split("/").length;
}

/**
 * Orders what to sign, innermost first.
 *
 * @param {{ path: string; type: "file" | "directory"; machO?: boolean }[]} entries every non-symlink entry below the app,
 *   paths relative to the .app directory with "/" separators (symbolic links must already be left out)
 * @returns {string[]} relative paths to pass to `codesign`; "." is the app itself, always last
 */
export function planSigningOrder(entries) {
  const deepestFirst = (a, b) => depth(b) - depth(a) || a.localeCompare(b);
  const code = entries
    .filter(
      (entry) =>
        entry.type === "file" &&
        entry.machO &&
        entry.path.startsWith("Contents/") &&
        !entry.path.startsWith(RUNTIME_BUNDLE) &&
        !MAIN_EXECUTABLE.test(entry.path) &&
        !FRAMEWORK_EXECUTABLE.test(entry.path),
    )
    .map((entry) => entry.path)
    .sort(deepestFirst);
  const topLevelDirectories = entries
    .filter((entry) => entry.type === "directory" && TOP_LEVEL_BUNDLE.test(entry.path))
    .map((entry) => entry.path)
    .sort();
  const frameworks = topLevelDirectories.filter((path) => path.endsWith(".framework"));
  const helpers = topLevelDirectories.filter((path) => path.endsWith(".app") && path.includes("Helper"));
  return [...code, ...frameworks, ...helpers, "."];
}

function readHeader(path) {
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(8);
    const read = readSync(descriptor, buffer, 0, 8, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(descriptor);
  }
}

/** Lists every file and directory below `root` without following symbolic links; paths are relative with "/". */
export function listAppEntries(root) {
  const entries = [];
  const visit = (relative) => {
    for (const name of readdirSync(join(root, relative))) {
      const path = relative ? `${relative}/${name}` : name;
      const stat = lstatSync(join(root, path));
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        entries.push({ path, type: "directory" });
        visit(path);
      } else if (stat.isFile()) {
        entries.push({ path, type: "file", machO: isMachOHeader(readHeader(join(root, path))) });
      }
    }
  };
  visit("");
  return entries;
}

/** A one-line count of a signing plan by kind, e.g. "57 code files, 4 frameworks, 5 helpers, main app". */
export function describeSigningPlan(plan) {
  const frameworks = plan.filter((path) => path.endsWith(".framework")).length;
  const helpers = plan.filter((path) => path.endsWith(".app")).length;
  const code = plan.length - frameworks - helpers - (plan.includes(".") ? 1 : 0);
  const parts = [`${code} code files`, `${frameworks} frameworks`, `${helpers} helpers`];
  if (plan.includes(".")) parts.push("main app");
  return parts.join(", ");
}

/** Ad-hoc signs the .app inside-out; returns the paths signed, in order. */
export async function adHocSignApp(appPath) {
  const plan = planSigningOrder(listAppEntries(appPath));
  for (const relative of plan) {
    const target = relative === "." ? appPath : join(appPath, relative);
    await execFileAsync("codesign", ["--force", "--sign", "-", "--timestamp=none", target]);
  }
  return plan;
}
