#!/usr/bin/env node
/**
 * Plugin launcher for Claude Code and Codex. The plugin carries no copy of Work Intelligence: it finds the local
 * repository checkout and runs the same built entry points that `pnpm setup:agents` registers, so the MCP server,
 * database location, and build checks behave exactly as they do without the plugin.
 *
 * A release build (`pnpm build:plugin`) also carries a bundled server, used when no checkout is found.
 *
 * Usage: node launch.mjs mcp | finalize-reminder | codex-finalize-reminder
 */
import { spawn } from "node:child_process";
import console from "node:console";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ENTRY_POINTS = {
  mcp: "apps/mcp/dist/index.js",
  "finalize-reminder": "apps/mcp/dist/finalize-reminder.js",
  "codex-finalize-reminder": "apps/mcp/dist/codex-finalize-reminder.js",
};
/** Hook commands: they must never block the Agent, so they stay silent and exit 0 whatever happens. */
const HOOK_COMMANDS = new Set(["finalize-reminder", "codex-finalize-reminder"]);

/** Written by `pnpm plugin:link`; read when the plugin runs from an agent's plugin cache outside the repository. */
export function linkFilePath(environment = process.env, home = homedir()) {
  const directory = environment.WORK_INTELLIGENCE_CONFIG_DIR?.trim() || join(home, ".work-intelligence");
  return join(directory, "plugin-link.json");
}

function isRepository(directory) {
  return (
    existsSync(join(directory, "pnpm-workspace.yaml")) &&
    existsSync(join(directory, "apps/mcp/package.json")) &&
    existsSync(join(directory, "packages/shared/package.json"))
  );
}

function readLinkedRoot(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"))?.repositoryRoot;
    return typeof value === "string" && value.trim() ? resolve(value) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every checkout the plugin could use, in order: WORK_INTELLIGENCE_HOME, an ancestor of the plugin (the plugin loaded
 * in place from this repository's marketplace), then the link file. Codex runs a plugin inside its own clone of the
 * marketplace repository, which is never built, so an ancestor is only one candidate among several.
 */
export function findRepositories({ pluginRoot, environment = process.env, home = homedir() }) {
  const candidates = [];
  const fromEnvironment = environment.WORK_INTELLIGENCE_HOME?.trim();
  if (fromEnvironment) candidates.push({ root: resolve(fromEnvironment), source: "WORK_INTELLIGENCE_HOME" });
  for (let directory = resolve(pluginRoot); ; directory = dirname(directory)) {
    if (isRepository(directory)) {
      candidates.push({ root: directory, source: "plugin location" });
      break;
    }
    if (dirname(directory) === directory) break;
  }
  const linked = readLinkedRoot(linkFilePath(environment, home));
  if (linked) candidates.push({ root: linked, source: "plugin link" });
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (!isRepository(candidate.root) || seen.has(candidate.root)) return false;
    seen.add(candidate.root);
    return true;
  });
}

/**
 * A release build of the plugin (`pnpm build:plugin`) carries the MCP server in server/; it is used only when no
 * built checkout is found, and it opens the linked checkout's database when there is one.
 */
function bundledServer(pluginRoot) {
  const root = join(resolve(pluginRoot), "server");
  return existsSync(join(root, ENTRY_POINTS.mcp)) ? { root, source: "bundled server" } : undefined;
}

/**
 * Resolves the script to run: the first candidate checkout that is built, else the bundled server, else an
 * explanation (for stderr) of why nothing can run.
 */
export function resolveEntryPoint(command, options) {
  const relativePath = ENTRY_POINTS[command];
  if (!relativePath) return { error: `Unknown command "${command}". Use: ${Object.keys(ENTRY_POINTS).join(" | ")}.` };
  const repositories = findRepositories(options);
  const built = repositories.find((repository) => existsSync(join(repository.root, relativePath)));
  if (built) return { script: join(built.root, relativePath), repository: built };
  // The bundle still opens a linked checkout's database even when that checkout is not built (database-location.ts).
  const bundled = bundledServer(options.pluginRoot);
  if (bundled) return { script: join(bundled.root, relativePath), repository: bundled };
  if (repositories.length === 0) {
    return {
      error:
        "Work Intelligence repository not found. Clone it, run `pnpm install && pnpm build && pnpm plugin:link` " +
        "there, or set WORK_INTELLIGENCE_HOME to the checkout.",
    };
  }
  const tried = repositories.map((repository) => `${repository.root} (${repository.source})`).join(", ");
  return {
    error:
      `Missing ${relativePath} in ${tried}. Run pnpm build in your checkout, then pnpm plugin:link ` +
      "so the plugin finds it.",
  };
}

function main() {
  const [command = "", ...rest] = process.argv.slice(2);
  const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = resolveEntryPoint(command, { pluginRoot });
  if (result.error) {
    // A hook must never block the Agent because Work Intelligence is unavailable; the MCP server should fail.
    if (HOOK_COMMANDS.has(command)) return;
    console.error(`Work Intelligence plugin: ${result.error}`);
    process.exitCode = 1;
    return;
  }
  // The real path: the entry points compare it with import.meta.url to decide that they were run directly.
  const child = spawn(process.execPath, [realpathSync(result.script), ...rest], { stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    if (!HOOK_COMMANDS.has(command)) console.error(`Work Intelligence plugin: ${error.message}`);
    process.exitCode = HOOK_COMMANDS.has(command) ? 0 : 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = HOOK_COMMANDS.has(command) ? 0 : (code ?? (signal ? 1 : 0));
  });
}

/** Run directly, not imported. Compares real paths: the plugin cache or temp directory may sit behind a symlink. */
function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) main();
