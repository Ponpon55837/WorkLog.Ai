#!/usr/bin/env node
/**
 * Downloads the Electron binary when it is missing. Plain `pnpm install`, build, typecheck and test never need it (the
 * workspace sets `allowBuilds: electron: false`, so its postinstall does not run); only the desktop smoke test does.
 * Uses the package's own `install.js` over the normal HTTPS proxy settings.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const require = createRequire(import.meta.url);
const electronDirectory = dirname(require.resolve("electron/package.json"));

function installed() {
  const pathFile = join(electronDirectory, "path.txt");
  return existsSync(pathFile) && existsSync(join(electronDirectory, "dist"));
}

if (installed()) {
  process.stdout.write("electron binary present\n");
} else {
  process.stdout.write("downloading the electron binary\n");
  const result = spawnSync(process.execPath, [join(electronDirectory, "install.js")], { stdio: "inherit" });
  if (result.status !== 0 || !installed()) {
    process.stderr.write("could not install the electron binary\n");
    process.exit(result.status ?? 1);
  }
}
