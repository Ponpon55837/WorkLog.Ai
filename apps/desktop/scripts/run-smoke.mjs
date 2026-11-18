#!/usr/bin/env node
/**
 * `pnpm test:desktop-smoke`: the Electron smoke test.
 *
 *   1. makes sure the Electron binary is present (the only step that downloads it),
 *   2. builds the desktop shell,
 *   3. lays out a runtime with the repository's runtime builder (`spike:runtime:build --runtime node`) in a temp folder,
 *   4. runs Playwright against dist/main with that runtime. Linux without a display runs under `xvfb-run -a`.
 *
 * Needs `pnpm build` first (the runtime builder packages the built server and Web UI).
 */
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

/** Runs every step and returns the exit status; cleanup is in `finally`, so no exit path skips it. */
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
      ? run("xvfb-run", ["-a", "-s", "-screen 0 1280x1024x24", process.execPath, ...playwrightArguments], { cwd: desktopRoot, env: environment })
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
