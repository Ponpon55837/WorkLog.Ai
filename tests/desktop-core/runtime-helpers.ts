import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import {
  commitCurrent,
  createWindowsAclReader,
  installRuntime,
  runtimeDirectoryFor,
  type InstalledRuntime,
  type RuntimeDefinition,
  type RuntimeKind,
  type WindowsAclReader,
} from "../../packages/desktop-core/src/runtime/index.js";
import { securePrivateDirectory } from "../../scripts/desktop-runtime-spike/secure-directory.mjs";

export const IS_WINDOWS = process.platform === "win32";
/**
 * The per-test timeout of the suites that install, verify and launch real fixture runtimes. On Windows their NTFS copies,
 * hashes and renames compete with the real PowerShell and MCP child processes other workers start at the same time: on a
 * GitHub runner one reinstall measured 0.35 s in one run and 6.3 s in the next (the whole file 9 s vs 57 s), past
 * vitest's default 5 s. The work is the same; only the wait is longer. POSIX keeps the default.
 */
export const RUNTIME_FS_TEST_TIMEOUT_MS = IS_WINDOWS ? 30_000 : 5_000;

/** A fake runtime executable: prints the Electron flag and its arguments, one per line (POSIX only). */
const FAKE_EXECUTABLE = '#!/bin/sh\nprintf \'%s\\n\' "${ELECTRON_RUN_AS_NODE-unset}${ELECTRON_NO_ASAR-unset}" "$@"\n';

/** Files of a small fake runtime; sizes and contents are arbitrary. */
export const FIXTURE_FILES: Readonly<Record<string, string>> = {
  "node/bin/node": FAKE_EXECUTABLE,
  "launcher.mjs": "// launcher\n",
  "app/mcp.js": "// mcp\n",
  "app/serve.mjs": "// serve\n",
  "app/hook.js": "// hook\n",
  "app/web/index.html": "<!doctype html><p>synthetic</p>\n",
  "app/web/assets/app.js": "console.log('synthetic');\n",
};

export function fixtureDefinition(runtimeId: string, runtimeKind: RuntimeKind = "node"): RuntimeDefinition {
  return {
    runtimeId,
    runtimeKind,
    executable: "node/bin/node",
    actions: {
      mcp: { entry: "app/mcp.js" },
      serve: { entry: "app/serve.mjs", args: ["start"] },
      "codex-finalize-reminder": { entry: "app/hook.js" },
      "claude-finalize-reminder": { entry: "app/hook.js" },
    },
  };
}

let sharedParent: Promise<string> | undefined;
let parentAclSnapshot: Promise<Awaited<ReturnType<WindowsAclReader["read"]>>> | undefined;

/**
 * The one directory per test process that holds every launcher root. On Windows it is locked like the App's real root
 * (the runner's temp folder grants BUILTIN\Users write access, which the runtime's ACL check refuses), once: `icacls`
 * costs hundreds of milliseconds, and every folder created inside inherits the locked ACL. `realpath.native` so
 * comparisons survive macOS /private/var and Windows 8.3 names. Removed after the file's tests.
 */
function sharedParentDirectory(): Promise<string> {
  sharedParent ??= fs
    .mkdtemp(path.join(os.tmpdir(), "desktop-runtime-tests-"))
    .then((directory) => securePrivateDirectory(realpathSync.native(directory)));
  return sharedParent;
}

afterAll(async () => {
  if (sharedParent !== undefined) await fs.rm(await sharedParent, { recursive: true, force: true });
  sharedParent = undefined;
  parentAclSnapshot = undefined;
});

/** A fresh launcher root inside the shared locked parent, so it carries the App root's ACL without its own `icacls`. */
export async function makeRoot(label = "desktop-runtime"): Promise<string> {
  return fs.mkdtemp(path.join(await sharedParentDirectory(), `${label} 測試-`));
}

/**
 * For tests whose subject is not the ACL check: on Windows, a reader that answers every path with the ONE real read
 * (real SDDL and SID, taken once per process) of the shared parent, whose ACL every root and file below it inherits, so
 * no test starts PowerShell. Undefined elsewhere, where no reader is used. Tests of the ACL check itself must not use it.
 */
const inheritedAclReader: WindowsAclReader | undefined = IS_WINDOWS
  ? {
      read: async (paths) => {
        parentAclSnapshot ??= sharedParentDirectory().then((parent) => createWindowsAclReader().read([parent]));
        const { currentUserSid, sddls } = await parentAclSnapshot;
        return { currentUserSid, sddls: paths.map(() => sddls[0] as string) };
      },
    }
  : undefined;

/** `{ aclReader }` on Windows, `{}` elsewhere: spread it into the options of `installRuntime`, `commitCurrent` and `verifyRuntime`. */
export const fixtureAcl: { readonly aclReader?: WindowsAclReader } =
  inheritedAclReader === undefined ? {} : { aclReader: inheritedAclReader };

export async function writeFiles(directory: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(directory, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, { mode: relative.endsWith("/node") ? 0o755 : 0o644 });
  }
}

/** Copies the fixture files into `runtimes/<id>/` without installing. */
export async function stageFixture(
  root: string,
  runtimeId: string,
  files: Readonly<Record<string, string>> = FIXTURE_FILES,
): Promise<string> {
  const directory = runtimeDirectoryFor(root, runtimeId);
  await writeFiles(directory, files);
  return directory;
}

/** Stages and installs the fixture runtime; with `commit` also points `current` at it. Windows ACLs come from {@link fixtureAcl}. */
export async function installFixture(
  root: string,
  runtimeId = "rt-1",
  options: { kind?: RuntimeKind; commit?: boolean; files?: Readonly<Record<string, string>> } = {},
): Promise<InstalledRuntime> {
  await stageFixture(root, runtimeId, options.files);
  const installed = await installRuntime(root, fixtureDefinition(runtimeId, options.kind), fixtureAcl);
  if (options.commit) await commitCurrent(root, runtimeId, fixtureAcl);
  return installed;
}

/** Waits long enough that a later write gets a different ctime even on file systems with coarse timestamps. */
export function tick(milliseconds = 25): Promise<void> {
  return new Promise((done) => setTimeout(done, milliseconds));
}

/** Flips one bit of the first byte, keeping the size. */
export async function flipFirstByte(file: string): Promise<void> {
  const content = await fs.readFile(file);
  content[0] = (content[0] as number) ^ 0x01;
  await fs.writeFile(file, content);
}
