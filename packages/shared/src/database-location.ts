import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { resolveDatabasePath } from "./database-path.js";

/**
 * True only inside a self-contained bundle (the build scripts define it); the repository build leaves it undeclared,
 * so a checkout keeps using its own data/ directory exactly as before.
 */
declare const __WORK_INTELLIGENCE_STANDALONE__: boolean | undefined;
export const STANDALONE =
  typeof __WORK_INTELLIGENCE_STANDALONE__ !== "undefined" && __WORK_INTELLIGENCE_STANDALONE__ === true;

export interface DatabaseLocationOptions {
  environment?: NodeJS.ProcessEnv;
  home?: string;
  /** Path rules to apply; defaults to the running platform. */
  platform?: NodeJS.Platform;
}

export interface DatabaseLocationModeOptions extends DatabaseLocationOptions {
  /** Defaults to STANDALONE. */
  standalone?: boolean;
}

function pathApi(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

/** Where Work Intelligence keeps per-user files outside any checkout (plugin link, standalone database). */
export function configDirectory({
  environment = process.env,
  home = homedir(),
  platform = process.platform,
}: DatabaseLocationOptions = {}): string {
  return environment.WORK_INTELLIGENCE_CONFIG_DIR?.trim() || pathApi(platform).join(home, ".work-intelligence");
}

function isRepository(root: string): boolean {
  return existsSync(posix.join(root, "pnpm-workspace.yaml")) && existsSync(posix.join(root, "apps/mcp/package.json"));
}

function existingRepository(root: string): string | undefined {
  const resolved = pathApi(process.platform).resolve(root);
  return isRepository(resolved) ? resolved : undefined;
}

/**
 * The checkout the plugin launcher would pick: WORK_INTELLIGENCE_HOME, else the one recorded by
 * `pnpm plugin:link`, when it still looks like a Work Intelligence repository.
 */
export function linkedRepositoryRoot(options: DatabaseLocationOptions = {}): string | undefined {
  const fromEnvironment = (options.environment ?? process.env).WORK_INTELLIGENCE_HOME?.trim();
  if (fromEnvironment) {
    const root = existingRepository(fromEnvironment);
    if (root) return root;
  }
  try {
    const link = pathApi(process.platform).join(configDirectory(options), "plugin-link.json");
    const value: unknown = JSON.parse(readFileSync(link, "utf8"));
    const root =
      value && typeof value === "object" ? (value as { repositoryRoot?: unknown }).repositoryRoot : undefined;
    if (typeof root !== "string" || !root.trim()) return undefined;
    return existingRepository(root);
  } catch {
    return undefined;
  }
}

/**
 * The database a standalone bundle opens: WORK_INTELLIGENCE_DB (a relative value hangs off the config directory,
 * `~/.work-intelligence` by default, never the install location or the cwd), else the data/ of the checkout from
 * WORK_INTELLIGENCE_HOME or `pnpm plugin:link` (so the plugin and the Web UI share one database), else data/ under
 * the config directory.
 */
export function standaloneDatabasePath(options: DatabaseLocationOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const path = pathApi(platform);
  const directory = configDirectory(options);
  const defaultPath = (): string => {
    const linked = linkedRepositoryRoot(options);
    return linked
      ? path.join(linked, "data", "work-intelligence.sqlite")
      : path.join(directory, "data", "work-intelligence.sqlite");
  };
  const raw = (options.environment ?? process.env).WORK_INTELLIGENCE_DB;
  if (!raw?.trim()) return defaultPath();
  return resolveDatabasePath(raw, { baseDirectory: directory, fallback: "", platform });
}

/**
 * The one rule behind the API server, MCP server, CLI, doctor, and login service. The repository build uses
 * `WORK_INTELLIGENCE_DB` (relative paths resolve from the repository root, not the cwd) or `<repo>/data`; only the
 * standalone bundle looks further.
 */
export function databasePathFor(
  repositoryRoot: string,
  { standalone = STANDALONE, ...options }: DatabaseLocationModeOptions = {},
): string {
  if (standalone) return standaloneDatabasePath(options);
  const platform = options.platform ?? process.platform;
  return resolveDatabasePath((options.environment ?? process.env).WORK_INTELLIGENCE_DB, {
    baseDirectory: repositoryRoot,
    fallback: pathApi(platform).resolve(repositoryRoot, "data", "work-intelligence.sqlite"),
    platform,
  });
}
