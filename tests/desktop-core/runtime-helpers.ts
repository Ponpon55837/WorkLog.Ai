import fs from "node:fs/promises";
import path from "node:path";
import { inject } from "vitest";
import {
  commitCurrent,
  installRuntime,
  runtimeDirectoryFor,
  type InstalledRuntime,
  type RuntimeDefinition,
  type RuntimeKind,
  type WindowsAclReader,
} from "../../packages/desktop-core/src/runtime/index.js";
import type { DesktopRuntimeFixtures } from "./runtime-global-setup.js";

export const IS_WINDOWS = process.platform === "win32";
/** The most a hook may pay for one extra step of the launcher: the budget of the `[hook cost]` measurement. */
export const HOOK_BUDGET_MS = 5;
export const INERT_LEASE_HOST = {
  acquireLease: () => ({ refresh: () => undefined, remove: () => undefined }),
  onExit: () => undefined,
  startHeartbeat: () => undefined,
} as const;
const FAKE_EXECUTABLE = '#!/bin/sh\nprintf \'%s\\n\' "${ELECTRON_RUN_AS_NODE-unset}${ELECTRON_NO_ASAR-unset}" "$@"\n';

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

function fixtures(): DesktopRuntimeFixtures {
  const provided = inject("desktopRuntimeFixtures");
  if (provided === undefined) {
    throw new Error(
      "desktop runtime fixtures are missing: run the suites through packages/desktop-core/vitest.config.ts",
    );
  }
  return provided;
}

/** Inherits the ACL the global setup locked once, so no test pays `icacls`. */
export async function makeRoot(label = "desktop-runtime"): Promise<string> {
  return fs.mkdtemp(path.join(fixtures().parent, `${label} 測試-`));
}

const FIXTURE_USER_SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const FIXTURE_SDDL = `O:${FIXTURE_USER_SID}G:DUD:PAI(A;OICI;FA;;;${FIXTURE_USER_SID})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`;

/** Windows only: answers every path with the synthetic locked descriptor, so no test starts PowerShell. */
const inheritedAclReader: WindowsAclReader | undefined = IS_WINDOWS
  ? { read: async (paths) => ({ currentUserSid: FIXTURE_USER_SID, sddls: paths.map(() => FIXTURE_SDDL) }) }
  : undefined;

export const fixtureAcl: { readonly aclReader?: WindowsAclReader } =
  inheritedAclReader === undefined ? {} : { aclReader: inheritedAclReader };

export async function writeFiles(directory: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(directory, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, { mode: relative.endsWith("/node") ? 0o755 : 0o644 });
  }
}

export async function stageFixture(
  root: string,
  runtimeId: string,
  files: Readonly<Record<string, string>> = FIXTURE_FILES,
): Promise<string> {
  const directory = runtimeDirectoryFor(root, runtimeId);
  await writeFiles(directory, files);
  return directory;
}

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

export async function flipFirstByte(file: string): Promise<void> {
  const content = await fs.readFile(file);
  content[0] = (content[0] as number) ^ 0x01;
  await fs.writeFile(file, content);
}
