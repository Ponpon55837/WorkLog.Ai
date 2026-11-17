#!/usr/bin/env node
/**
 * The `work-intelligence` command of the standalone package (copied to `bin/` by scripts/build-standalone.mjs).
 * It only checks the Node.js version and hands over to the bundled CLI in this process: no child process, so signals
 * and stdio behave as they do for `node apps/.../index.js`, including on Windows.
 *
 * The one exception is `mcp` on a computer with the desktop App: it runs through the App's fixed launcher (see
 * desktop-integration.mjs), which has its own Node, keeps working after the App quits and follows App updates.
 */
import { readFileSync } from "node:fs";
import console from "node:console";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { resolveDesktopLauncher, runDesktopLauncher } from "./desktop-integration.mjs";
import { satisfiesNodeRange } from "./node-range.mjs";

/** The package's engines.node, or undefined when it cannot be read. */
function requiredNodeRange() {
  try {
    const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
    const range = JSON.parse(readFileSync(packagePath, "utf8")).engines?.node;
    return typeof range === "string" && range.trim() ? range.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Checks the Node.js version, then runs the bundled CLI in this process. */
async function runBundledCli() {
  const requiredRange = requiredNodeRange();
  if (requiredRange && !satisfiesNodeRange(requiredRange, process.versions.node)) {
    console.error(`Work Intelligence 需要 Node.js ${requiredRange}（目前是 ${process.versions.node}）。`);
    process.exit(1);
  }

  const { runStandaloneCli } = await import(
    new URL("../libexec/apps/server/dist/standalone-cli.js", import.meta.url).href
  );
  const exitCode = await runStandaloneCli(process.argv.slice(2));
  // start and mcp keep the process alive and may already have set a failure code; only add a failure, never clear one.
  if (exitCode !== 0) process.exitCode = exitCode;
}

// Before the version check: the launcher brings its own Node, so an old system Node does not matter for `mcp`.
const desktopLauncher = process.argv[2] === "mcp" ? resolveDesktopLauncher("mcp") : undefined;
if (desktopLauncher) runDesktopLauncher(desktopLauncher, { hook: false });
else await runBundledCli();
