import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  commitCurrent,
  installRuntime,
  runtimeDirectoryFor,
  type InstalledRuntime,
  type RuntimeDefinition,
  type RuntimeKind,
} from "../../packages/desktop-core/src/runtime/index.js";

export const IS_WINDOWS = process.platform === "win32";

/** A fake runtime executable: prints the Electron flag and its arguments, one per line (POSIX only). */
const FAKE_EXECUTABLE = '#!/bin/sh\nprintf \'%s\\n\' "${ELECTRON_RUN_AS_NODE-unset}" "$@"\n';

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

/** A fresh launcher root; `realpath.native` so comparisons survive macOS /private/var and Windows 8.3 names. */
export async function makeRoot(label = "desktop-runtime"): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `${label} 測試-`));
  return realpathSync.native(root);
}

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

/** Stages and installs the fixture runtime; with `commit` also points `current` at it. */
export async function installFixture(
  root: string,
  runtimeId = "rt-1",
  options: { kind?: RuntimeKind; commit?: boolean; files?: Readonly<Record<string, string>> } = {},
): Promise<InstalledRuntime> {
  await stageFixture(root, runtimeId, options.files);
  const installed = await installRuntime(root, fixtureDefinition(runtimeId, options.kind));
  if (options.commit) await commitCurrent(root, runtimeId);
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
