import { readFileSync } from "node:fs";
import { posix, win32 } from "node:path";
import { configDirectory } from "@work-intelligence/shared/database-location";
import { resolveDatabasePath } from "@work-intelligence/shared/database-path";
import type { DbCandidate, DbSourceKind } from "./types.js";

export interface EnvironmentSource {
  label: string;
  environment: Record<string, string | undefined>;
  resolutionBase: string;
  managedByCurrentUser?: boolean | "unknown";
}

export interface CollectOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  home?: string;
  checkoutRoot?: string;
  desktopCommitted?: string | null;
  explicitSelection?: string | null;
  serviceDefinitions?: readonly EnvironmentSource[];
  agentMcpConfigs?: readonly EnvironmentSource[];
  readTextFile?: (path: string) => string;
}

const DATABASE_FILE_NAME = "work-intelligence.sqlite";

function pathApi(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

function makeCandidate(
  kind: DbSourceKind,
  rawValue: string,
  resolutionBase: string,
  platform: NodeJS.Platform,
  managedByCurrentUser: boolean | "unknown",
): DbCandidate {
  const base = { kind, rawValue, resolutionBase, managedByCurrentUser };
  try {
    const absolutePath = resolveDatabasePath(rawValue, { baseDirectory: resolutionBase, fallback: "", platform });
    if (absolutePath === ":memory:") return { ...base, absolutePath: rawValue, invalidReason: "in-memory database" };
    return { ...base, absolutePath };
  } catch (error) {
    return { ...base, absolutePath: rawValue, invalidReason: error instanceof Error ? error.message : String(error) };
  }
}

function pluginLinkRoot(configDir: string, platform: NodeJS.Platform, read: (path: string) => string): string | null {
  try {
    const value: unknown = JSON.parse(read(pathApi(platform).join(configDir, "plugin-link.json")));
    const root =
      value && typeof value === "object" ? (value as { repositoryRoot?: unknown }).repositoryRoot : undefined;
    return typeof root === "string" && root.trim() ? root.trim() : null;
  } catch {
    return null;
  }
}

function environmentCandidates(
  kind: "legacy-service" | "agent-mcp",
  sources: readonly EnvironmentSource[],
  platform: NodeJS.Platform,
): DbCandidate[] {
  const candidates: DbCandidate[] = [];
  for (const source of sources) {
    const raw = source.environment.WORK_INTELLIGENCE_DB?.trim();
    if (!raw) continue;
    candidates.push(
      makeCandidate(kind, raw, source.resolutionBase, platform, source.managedByCurrentUser ?? "unknown"),
    );
  }
  return candidates;
}

export function collectDbCandidates(options: CollectOptions = {}): DbCandidate[] {
  const platform = options.platform ?? process.platform;
  const path = pathApi(platform);
  const read = options.readTextFile ?? ((file: string) => readFileSync(file, "utf8"));
  const configDir = configDirectory({ environment: options.environment, home: options.home, platform });
  const candidates: DbCandidate[] = [];

  if (options.desktopCommitted?.trim()) {
    candidates.push(makeCandidate("desktop-committed", options.desktopCommitted.trim(), configDir, platform, true));
  }
  if (options.explicitSelection?.trim()) {
    candidates.push(makeCandidate("explicit-selection", options.explicitSelection.trim(), configDir, platform, true));
  }
  candidates.push(...environmentCandidates("legacy-service", options.serviceDefinitions ?? [], platform));
  const linkedRoot = pluginLinkRoot(configDir, platform, read);
  if (linkedRoot) {
    const linked = path.join(linkedRoot, "data", DATABASE_FILE_NAME);
    candidates.push(makeCandidate("plugin-link", linked, configDir, platform, true));
  }
  candidates.push(...environmentCandidates("agent-mcp", options.agentMcpConfigs ?? [], platform));
  candidates.push(
    makeCandidate("standalone-default", path.join(configDir, "data", DATABASE_FILE_NAME), configDir, platform, true),
  );
  if (options.checkoutRoot) {
    const checkout = path.join(options.checkoutRoot, "data", DATABASE_FILE_NAME);
    candidates.push(makeCandidate("checkout-default", checkout, options.checkoutRoot, platform, true));
  }
  return candidates;
}
