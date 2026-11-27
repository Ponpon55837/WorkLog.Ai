#!/usr/bin/env node
// Runs the bundled CLI in this process, not a child, so signals and stdio behave as for `node apps/.../index.js`, including
// on Windows. The exception is `mcp` with the desktop App installed, which goes through the App's fixed launcher.
import { readFileSync } from "node:fs";
import console from "node:console";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { resolveDesktopLauncher, runDesktopLauncher } from "./desktop-integration.mjs";
import { satisfiesNodeRange } from "./node-range.mjs";

function requiredNodeRange() {
  try {
    const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
    const range = JSON.parse(readFileSync(packagePath, "utf8")).engines?.node;
    return typeof range === "string" && range.trim() ? range.trim() : undefined;
  } catch {
    return undefined;
  }
}

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
const desktopLauncher =
  process.argv[2] === "mcp"
    ? resolveDesktopLauncher("mcp", {
        onProblem: (problem) => console.error(`Work Intelligence: the desktop App's launcher is not used: ${problem}.`),
      })
    : undefined;
if (desktopLauncher) runDesktopLauncher(desktopLauncher, { hook: false });
else await runBundledCli();
