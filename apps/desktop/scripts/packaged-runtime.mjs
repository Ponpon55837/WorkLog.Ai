import process from "node:process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function resourcesDirectory(executable, platform = process.platform) {
  return platform === "darwin"
    ? join(dirname(dirname(executable)), "Resources")
    : join(dirname(executable), "resources");
}

export function packagedRuntimeNode(executable, platform = process.platform) {
  const bundle = join(resourcesDirectory(executable, platform), "runtime-bundle");
  const runtimeId = readFileSync(join(bundle, "current"), "utf8").trim();
  const runtimeDirectory = join(bundle, "runtimes", runtimeId);
  const manifest = JSON.parse(readFileSync(join(runtimeDirectory, "runtime-manifest.json"), "utf8"));
  if (manifest.runtimeKind !== "node")
    throw new Error(`the packaged runtime is ${manifest.runtimeKind}, not a plain node`);
  return { runtimeId, nodePath: join(runtimeDirectory, ...String(manifest.executable).split("/")) };
}
