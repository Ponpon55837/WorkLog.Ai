#!/usr/bin/env node
/**
 * The `work-intelligence` command of the standalone package (copied to `bin/` by scripts/build-standalone.mjs).
 * It only checks the Node.js version and hands over to the bundled CLI in this process: no child process, so signals
 * and stdio behave as they do for `node apps/.../index.js`, including on Windows.
 */
import { readFileSync } from "node:fs";
import console from "node:console";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

/** The ">=x.y.z" minimum in the package's engines.node, or undefined when it cannot be read. */
function requiredNode() {
  try {
    const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
    const range = JSON.parse(readFileSync(packagePath, "utf8")).engines?.node;
    const match = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(typeof range === "string" ? range.trim() : "");
    return match ? { text: `${match[1]}.${match[2]}.${match[3]}`, parts: match.slice(1, 4).map(Number) } : undefined;
  } catch {
    return undefined;
  }
}

function nodeIsSupported(required, actual) {
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== required.parts[index]) return actual[index] > required.parts[index];
  }
  return true;
}

const required = requiredNode();
if (required && !nodeIsSupported(required, process.versions.node.split(".").map(Number))) {
  console.error(`Work Intelligence 需要 Node.js ${required.text} 以上（目前是 ${process.versions.node}）。`);
  process.exit(1);
}

const { runStandaloneCli } = await import(
  new URL("../libexec/apps/server/dist/standalone-cli.js", import.meta.url).href
);
const exitCode = await runStandaloneCli(process.argv.slice(2));
// start and mcp keep the process alive and may already have set a failure code; only add a failure, never clear one.
if (exitCode !== 0) process.exitCode = exitCode;
