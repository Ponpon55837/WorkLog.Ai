import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * True only inside the self-contained plugin bundle (scripts/build-plugin.mjs defines it); the repository build
 * leaves it undeclared, so a checkout keeps using its own data/ directory exactly as before.
 */
declare const __WORK_INTELLIGENCE_STANDALONE__: boolean | undefined;
export const STANDALONE =
  typeof __WORK_INTELLIGENCE_STANDALONE__ !== "undefined" && __WORK_INTELLIGENCE_STANDALONE__ === true;

interface LocationOptions {
  environment?: NodeJS.ProcessEnv;
  home?: string;
}

/** Where Work Intelligence keeps per-user files outside any checkout (plugin link, standalone database). */
export function configDirectory({ environment = process.env, home = homedir() }: LocationOptions = {}): string {
  return environment.WORK_INTELLIGENCE_CONFIG_DIR?.trim() || join(home, ".work-intelligence");
}

function isRepository(root: string): boolean {
  return existsSync(join(root, "pnpm-workspace.yaml")) && existsSync(join(root, "apps/mcp/package.json"));
}

/**
 * The checkout the plugin launcher would pick: WORK_INTELLIGENCE_HOME, else the one recorded by
 * `pnpm plugin:link`, when it still looks like a Work Intelligence repository.
 */
export function linkedRepositoryRoot(options: LocationOptions = {}): string | undefined {
  const fromEnvironment = (options.environment ?? process.env).WORK_INTELLIGENCE_HOME?.trim();
  if (fromEnvironment && isRepository(resolve(fromEnvironment))) return resolve(fromEnvironment);
  try {
    const value: unknown = JSON.parse(readFileSync(join(configDirectory(options), "plugin-link.json"), "utf8"));
    const root =
      value && typeof value === "object" ? (value as { repositoryRoot?: unknown }).repositoryRoot : undefined;
    if (typeof root !== "string" || !root.trim()) return undefined;
    return isRepository(resolve(root)) ? resolve(root) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The database a standalone bundle opens: WORK_INTELLIGENCE_DB, else the data/ of the checkout from
 * WORK_INTELLIGENCE_HOME or `pnpm plugin:link` (so the plugin and the Web UI share one database), else data/ under
 * the config directory.
 */
export function standaloneDatabasePath(options: LocationOptions = {}): string {
  const fromEnvironment = (options.environment ?? process.env).WORK_INTELLIGENCE_DB?.trim();
  if (fromEnvironment) return fromEnvironment;
  const linked = linkedRepositoryRoot(options);
  if (linked) return join(linked, "data", "work-intelligence.sqlite");
  return join(configDirectory(options), "data", "work-intelligence.sqlite");
}

/** The repository build keeps `WORK_INTELLIGENCE_DB ?? <repo>/data`; only the standalone bundle looks further. */
export function databasePathFor(
  repositoryDataPath: string,
  { standalone = STANDALONE, ...options }: LocationOptions & { standalone?: boolean } = {},
): string {
  if (standalone) return standaloneDatabasePath(options);
  return (options.environment ?? process.env).WORK_INTELLIGENCE_DB ?? repositoryDataPath;
}
