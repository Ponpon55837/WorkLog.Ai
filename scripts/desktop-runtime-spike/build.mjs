#!/usr/bin/env node
/**
 * `pnpm spike:runtime:build [--runtime node|electron] [--out <launcher root>]` lays out a desktop launcher root
 * (design R4 §3.3 and §10.2) from the standalone package and a bundled runtime, installs it with the real
 * desktop-core code and commits `current`:
 *
 *   <root>/bin/work-intelligence-launcher[.cmd]      fixed shims an Agent's `command` points at
 *   <root>/current                                   the runtime id, the single atomic switch point
 *   <root>/runtimes/<id>/runtime-manifest.json      sizes and SHA-256 of every file below
 *   <root>/runtimes/<id>/{node|electron}/…          the official runtime, verified against SHASUMS256.txt
 *   <root>/runtimes/<id>/launcher.mjs               verifies the runtime, then runs the fixed action in-process
 *   <root>/runtimes/<id>/app/…                      the standalone package (server, MCP, hooks, Web UI)
 *
 * Needs `pnpm build` first (apps/web/dist and packages/desktop-core/dist). The default root is under
 * dist/desktop-runtime-spike/ and contains a space and Chinese characters. Downloads are cached in
 * dist/desktop-runtime-spike/downloads. `--node-version` takes a major ("24") or an exact version ("v24.22.3");
 * `--electron-version` an exact Electron version.
 *
 * Symlinks (an Electron.app bundle on macOS has them) are kept as links and listed in the manifest with their
 * targets, which must stay inside the runtime; the launcher refuses any link the manifest does not list.
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import console from "node:console";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { buildStandalone } from "../build-standalone.mjs";
import {
  DEFAULT_ELECTRON_VERSION,
  DEFAULT_NODE_VERSION,
  ensureDirectory,
  parseSpikeArguments,
  platformTag,
  readJson,
  repositoryRoot,
  spikeDirectory,
} from "./common.mjs";
import { prepareElectron, prepareNode } from "./download.mjs";
import { securePrivateDirectory } from "./secure-directory.mjs";

const ACTIONS = {
  mcp: { entry: "app/libexec/apps/mcp/dist/index.js" },
  serve: { entry: "app/bin/work-intelligence.mjs", args: ["start"] },
  "codex-finalize-reminder": { entry: "app/libexec/apps/mcp/dist/codex-finalize-reminder.js" },
  "claude-finalize-reminder": { entry: "app/libexec/apps/mcp/dist/finalize-reminder.js" },
};

/**
 * Refuses to wipe a directory that is neither empty nor an earlier launcher root, so `--out ~` cannot do damage. The new
 * root is locked to the current user, SYSTEM and Administrators on Windows before anything is put in it, like the App's
 * own root: a runner's temp folder grants BUILTIN\Users write access, which the launcher's ACL check refuses.
 */
function prepareOutputRoot(root) {
  if (existsSync(root)) {
    const looksLikeRoot = readdirSync(root).every((name) => ["bin", "runtimes", "current"].includes(name));
    if (!looksLikeRoot) {
      throw new Error(`${root} is not empty and is not a launcher root; choose another --out`);
    }
    rmSync(root, { recursive: true, force: true });
  }
  securePrivateDirectory(ensureDirectory(root));
}

/** The launcher script of every runtime: desktop-core's launcher-entry, bundled with its few dependencies. */
async function bundleLauncher(destination) {
  await build({
    entryPoints: [join(repositoryRoot, "packages/desktop-core/src/runtime/launcher-entry.ts")],
    outfile: destination,
    bundle: true,
    minify: true,
    platform: "node",
    format: "esm",
    target: "node22",
    legalComments: "none",
    logLevel: "warning",
  });
}

async function placeRuntime(prepared, stage) {
  if (prepared.keepDirectory) {
    // verbatimSymlinks: relative links stay relative (the default would rewrite them to absolute paths).
    cpSync(prepared.keepDirectory.from, join(stage, prepared.keepDirectory.to), {
      recursive: true,
      verbatimSymlinks: true,
    });
    return;
  }
  for (const file of prepared.keep) {
    await mkdir(dirname(join(stage, file.to)), { recursive: true });
    await copyFile(file.from, join(stage, file.to));
  }
}

async function main() {
  const options = parseSpikeArguments(process.argv.slice(2), {
    "node-version": { type: "string", default: DEFAULT_NODE_VERSION },
    "electron-version": { type: "string", default: DEFAULT_ELECTRON_VERSION },
  });
  const { installRuntime, commitCurrent } = await import(
    pathToFileURL(join(repositoryRoot, "packages/desktop-core/dist/index.js")).href
  );
  const appVersion = readJson(join(repositoryRoot, "package.json")).version;
  const cacheDirectory = ensureDirectory(join(spikeDirectory, "downloads"));
  const workDirectory = mkdtempSync(join(ensureDirectory(join(spikeDirectory, "work")), "build-"));
  try {
    const started = Date.now();
    const prepared =
      options.runtime === "node"
        ? await prepareNode({ version: options["node-version"], cacheDirectory, workDirectory })
        : await prepareElectron({ version: options["electron-version"], cacheDirectory, workDirectory });
    const runtimeKind = options.runtime === "node" ? "node" : "electron-run-as-node";
    const runtimeId = `${appVersion}-${options.runtime}${prepared.version}-${platformTag}`;

    prepareOutputRoot(options.root);
    const stage = ensureDirectory(join(options.root, "runtimes", runtimeId));
    await placeRuntime(prepared, stage);
    const standalone = await buildStandalone(join(workDirectory, "standalone"));
    cpSync(standalone.packageDirectory, join(stage, "app"), { recursive: true });
    await bundleLauncher(join(stage, "launcher.mjs"));

    const installed = await installRuntime(
      options.root,
      {
        runtimeId,
        runtimeKind,
        executable: prepared.executable,
        actions: ACTIONS,
      },
      { checkAcl: false },
    ); // a build machine's folders carry the build agent's ACLs: content only; the installed App checks them
    await commitCurrent(options.root, runtimeId, { checkAcl: false });
    const { verification } = installed;
    console.log(
      JSON.stringify(
        {
          root: options.root,
          runtimeId,
          runtimeKind,
          runtimeVersion: prepared.version,
          archiveSha256: prepared.archiveSha256,
          downloaded: prepared.downloaded,
          files: installed.manifest.files.length,
          symlinks: installed.manifest.symlinks.length,
          verification: { hashed: verification.hashedCount, acl: verification.acl },
          seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
          launcherBytes: statSync(join(stage, "launcher.mjs")).size,
        },
        null,
        2,
      ),
    );
  } finally {
    rmSync(workDirectory, { recursive: true, force: true });
  }
}

await main();
