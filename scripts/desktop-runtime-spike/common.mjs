import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const spikeDirectory = join(repositoryRoot, "dist", "desktop-runtime-spike");
export const RUNTIME_CHOICES = ["node", "electron"];
/** Pinned to an exact release so every run measures the same binary; its archives' SHA-256 are pinned in node-checksums.mjs. */
export const DEFAULT_NODE_VERSION = "v24.22.3";
export const DEFAULT_ELECTRON_VERSION = "45.3.3";

export const platformTag = `${process.platform}-${process.arch}`;

/** The name has a space and Chinese characters on purpose, so every local run covers the paths real users have. */
export function defaultLauncherRoot(runtime) {
  return join(spikeDirectory, `${platformTag}-${runtime}`, "啟動器 root");
}

export function parseSpikeArguments(argv, extra = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      runtime: { type: "string", default: "node" },
      out: { type: "string" },
      ...extra,
    },
  });
  if (!RUNTIME_CHOICES.includes(values.runtime)) {
    throw new Error(`--runtime must be one of ${RUNTIME_CHOICES.join(", ")} (got ${values.runtime})`);
  }
  return { ...values, root: resolve(values.out ?? defaultLauncherRoot(values.runtime)) };
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function ensureDirectory(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

export function formatBytes(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${(bytes / 1024).toFixed(0)} KiB`;
}

export function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
