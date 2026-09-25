import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface RootPackageMetadata {
  version?: unknown;
}

const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../package.json");
const packageMetadata = JSON.parse(readFileSync(packagePath, "utf8")) as RootPackageMetadata;

if (
  typeof packageMetadata.version !== "string" ||
  !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(packageMetadata.version)
) {
  throw new Error("根目錄 package.json 必須提供有效的 semver 版本。");
}

/** The root package.json is the single source of truth for the application version. */
export const APP_VERSION = packageMetadata.version;
