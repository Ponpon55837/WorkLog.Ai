#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const repositoryRoot = join(desktopRoot, "..", "..");
const require = createRequire(join(repositoryRoot, "package.json"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function main() {
  const prepared = run(process.execPath, [join(here, "ensure-electron.mjs")]);
  if (prepared !== 0) return prepared;
  const compiled = run(process.execPath, [join(here, "build.mjs")], { cwd: desktopRoot });
  if (compiled !== 0) return compiled;

  const temporary = mkdtempSync(join(os.tmpdir(), "wi-desktop-runtime-"));
  try {
    const runtimeRoot = join(temporary, "runtime");
    const built = run(
      process.execPath,
      [
        join(repositoryRoot, "scripts", "desktop-runtime-spike", "build.mjs"),
        "--runtime",
        "node",
        "--out",
        runtimeRoot,
        "--desktop-test-build",
      ],
      { cwd: repositoryRoot },
    );
    if (built !== 0) return built;

    const playwright = require.resolve("@playwright/test/cli");
    const playwrightArguments = [
      playwright,
      "test",
      "-c",
      join(desktopRoot, "playwright.config.ts"),
      ...process.argv.slice(2),
    ];
    const environment = { ...process.env, WORK_INTELLIGENCE_SMOKE_RUNTIME_ROOT: runtimeRoot };
    const needsDisplay = process.platform === "linux" && !process.env.DISPLAY;
    return needsDisplay
      ? run("xvfb-run", ["-a", "-s", "-screen 0 1280x1024x24", process.execPath, ...playwrightArguments], {
          cwd: desktopRoot,
          env: environment,
        })
      : run(process.execPath, playwrightArguments, { cwd: desktopRoot, env: environment });
  } finally {
    rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

let status = 1;
try {
  status = main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
}
process.exitCode = status;
