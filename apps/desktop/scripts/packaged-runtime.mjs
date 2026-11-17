import process from "node:process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** `resources` of a packaged App: `<install dir>/resources` (Windows, Linux) or `<name>.app/Contents/Resources` (macOS). */
export function resourcesDirectory(executable, platform = process.platform) {
  return platform === "darwin"
    ? join(dirname(dirname(executable)), "Resources")
    : join(dirname(executable), "resources");
}

/**
 * The Node binary the packaged App ships for its backend: `resources/runtime-bundle/runtimes/<id>/<manifest executable>`.
 * The App copies this bundle byte for byte into its runtime folder (verified against the manifest hash) and runs the
 * backend from that copy. Returns the runtime id and the binary path.
 */
export function packagedRuntimeNode(executable, platform = process.platform) {
  const bundle = join(resourcesDirectory(executable, platform), "runtime-bundle");
  const runtimeId = readFileSync(join(bundle, "current"), "utf8").trim();
  const runtimeDirectory = join(bundle, "runtimes", runtimeId);
  const manifest = JSON.parse(readFileSync(join(runtimeDirectory, "runtime-manifest.json"), "utf8"));
  if (manifest.runtimeKind !== "node")
    throw new Error(`the packaged runtime is ${manifest.runtimeKind}, not a plain node`);
  return { runtimeId, nodePath: join(runtimeDirectory, ...String(manifest.executable).split("/")) };
}
