#!/usr/bin/env node
/**
 * Plugin launcher for Claude Code and Codex. The plugin carries no copy of Work Intelligence: it finds the local
 * repository checkout and runs the same built entry points that `pnpm setup:agents` registers, so the MCP server,
 * database location, and build checks behave exactly as they do without the plugin.
 *
 * Usage: node launch.mjs mcp | finalize-reminder
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
};

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
 * Where the repository is, in order: WORK_INTELLIGENCE_HOME, an ancestor of the plugin (the plugin loaded in place
 * from this repository's marketplace), then the link file. Returns the first candidate with the reason it was picked,
 * or undefined when none points at a Work Intelligence checkout.
 */
export function findRepository({ pluginRoot, environment = process.env, home = homedir() }) {
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
  return candidates.find((candidate) => isRepository(candidate.root));
}

/** Resolves the script to run, or explains (for stderr) why it cannot. */
export function resolveEntryPoint(command, options) {
  const relativePath = ENTRY_POINTS[command];
  if (!relativePath) return { error: `Unknown command "${command}". Use: ${Object.keys(ENTRY_POINTS).join(" | ")}.` };
  const repository = findRepository(options);
  if (!repository) {
    return {
      error:
        "Work Intelligence repository not found. Clone it, run `pnpm install && pnpm build && pnpm plugin:link` " +
        "there, or set WORK_INTELLIGENCE_HOME to the checkout.",
    };
  }
  const script = join(repository.root, relativePath);
  if (!existsSync(script)) {
    return { error: `Missing ${relativePath} in ${repository.root} (found via ${repository.source}); run pnpm build.` };
  }
  return { script, repository };
}

function main() {
  const [command = "", ...rest] = process.argv.slice(2);
  const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = resolveEntryPoint(command, { pluginRoot });
  if (result.error) {
    // A Stop hook must never block the Agent because Work Intelligence is unavailable; the MCP server should fail.
    if (command === "finalize-reminder") return;
    console.error(`Work Intelligence plugin: ${result.error}`);
    process.exitCode = 1;
    return;
  }
  const child = spawn(process.execPath, [result.script, ...rest], { stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    if (command !== "finalize-reminder") console.error(`Work Intelligence plugin: ${error.message}`);
    process.exitCode = command === "finalize-reminder" ? 0 : 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = command === "finalize-reminder" ? 0 : (code ?? (signal ? 1 : 0));
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
