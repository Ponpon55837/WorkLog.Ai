#!/usr/bin/env node
/**
 * `pnpm plugin:link` records this checkout in ~/.work-intelligence/plugin-link.json so the Claude Code or Codex
 * plugin can find it after the agent copies the plugin into its own cache. `--remove` deletes the link; nothing
 * else is written, and the repository's data/ and agent settings are left alone.
 */
import console from "node:console";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { linkFilePath } from "../plugins/work-intelligence/scripts/launch.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function linkRepository({ root = repositoryRoot, remove = false, environment = process.env, home } = {}) {
  const path = home === undefined ? linkFilePath(environment) : linkFilePath(environment, home);
  if (remove) {
    if (!existsSync(path)) return { path, message: "No plugin link to remove." };
    rmSync(path);
    return { path, message: `Removed the plugin link ${path}.` };
  }
  const missing = existsSync(join(root, "apps/mcp/dist/index.js")) ? "" : " Run pnpm build before using the plugin.";
  let previous;
  try {
    previous = JSON.parse(readFileSync(path, "utf8")).repositoryRoot;
  } catch {
    previous = undefined;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ repositoryRoot: root }, null, 2)}\n`, { mode: 0o600 });
  const replaced = previous && previous !== root ? ` (replaced ${previous})` : "";
  return { path, message: `Linked the Work Intelligence plugin to ${root}${replaced}.${missing}` };
}

/** Run directly, not imported. Compares real paths: the plugin cache or temp directory may sit behind a symlink. */
function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const { path, message } = linkRepository({ remove: process.argv.includes("--remove") });
  console.log(message);
  console.log(`Link file: ${path}`);
}
