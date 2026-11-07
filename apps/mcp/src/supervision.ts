import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { McpRestartStatus } from "@work-intelligence/shared/mcp-runtime";
// Types only: importing launcher.ts at runtime would bundle its entry point into the server (pnpm build:plugin).
import type { McpLauncherIdentity } from "./launcher.js";

/** Must equal MCP_LAUNCHER_ENVIRONMENT in launcher.ts; tests/mcp/launcher.test.ts checks that they match. */
export const SUPERVISED_ENVIRONMENT = {
  path: "WORK_INTELLIGENCE_MCP_LAUNCHER_PATH",
  hash: "WORK_INTELLIGENCE_MCP_LAUNCHER_HASH",
  version: "WORK_INTELLIGENCE_MCP_LAUNCHER_VERSION",
} as const;

const RACY_WINDOW_MS = 2_000;
const LAUNCHER_RESTART_MESSAGE =
  "Work Intelligence MCP launcher 已更新；請重新連線 MCP 一次，之後的建置更新會自動切換。";
const AUTO_SWITCH_MESSAGE = "磁碟上的 MCP 建置已更新；launcher 會在下一個請求前自動切換，不必重新連線。";

/** The launcher identity passed to a supervised server, or undefined when the server was started directly. */
export function readLauncherIdentity(environment: NodeJS.ProcessEnv = process.env): McpLauncherIdentity | undefined {
  const path = environment[SUPERVISED_ENVIRONMENT.path]?.trim();
  const hash = environment[SUPERVISED_ENVIRONMENT.hash]?.trim();
  const version = Number(environment[SUPERVISED_ENVIRONMENT.version]);
  if (!path || !hash || !Number.isInteger(version) || version < 1) return undefined;
  return { path, hash, version };
}

/**
 * Whether the launcher file on disk still matches the running launcher. A missing or unreadable file (for example
 * while `pnpm build` recreates dist) is not an update: the running launcher keeps working.
 */
export function createLauncherUpdateCheck(identity: McpLauncherIdentity): () => boolean {
  let cached: { signature: string; updated: boolean } | undefined;
  return () => {
    let signature: string;
    let recent: boolean;
    try {
      const stats = statSync(identity.path);
      signature = `${stats.size}:${stats.mtimeMs}:${stats.ino}`;
      // A file written within the timestamp resolution could change again without a new signature (coarse on Windows).
      recent = Date.now() - stats.mtimeMs < RACY_WINDOW_MS;
    } catch {
      return false;
    }
    if (cached?.signature === signature) return cached.updated;
    let hash: string | undefined;
    try {
      hash = createHash("sha256").update(readFileSync(identity.path)).digest("hex");
    } catch {
      hash = undefined;
    }
    const updated = hash !== undefined && hash !== identity.hash;
    cached = recent ? undefined : { signature, updated };
    return updated;
  };
}

/**
 * Restart status for a server under the launcher. A newer server build is not a reason to reconnect, because the
 * launcher switches to it before the next request; only an updated launcher is.
 */
export function supervisedRestartStatus(
  base: McpRestartStatus,
  identity: McpLauncherIdentity,
  launcherUpdated: boolean,
): McpRestartStatus {
  if (launcherUpdated) {
    return {
      restartRequired: true,
      updateAvailable: false,
      monitoringAvailable: base.monitoringAvailable,
      message: LAUNCHER_RESTART_MESSAGE,
      launcher: { version: identity.version, restartRequired: true },
    };
  }
  const buildChanged = base.restartRequired || base.updateAvailable === true;
  return {
    restartRequired: false,
    updateAvailable: false,
    monitoringAvailable: base.monitoringAvailable,
    ...(buildChanged ? { message: AUTO_SWITCH_MESSAGE } : {}),
    launcher: { version: identity.version, restartRequired: false },
  };
}
