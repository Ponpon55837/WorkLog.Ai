import { homedir } from "node:os";
import {
  detectLegacyService,
  legacyServiceConflicts,
  type LegacyServiceDetection,
} from "@work-intelligence/desktop-core";
import type { DesktopFacts } from "@work-intelligence/schema";
import type { Logger } from "./log.js";

/**
 * The old login service `pnpm service:install` (and `pnpm bootstrap`) leaves behind: a second backend that may use the
 * App's database. Detection is read-only; this only decides whether the App holds its own backend back. Nothing here
 * stops, edits or removes that service.
 */
export interface LegacyGuard {
  /** Detects again and keeps the result. */
  refresh(): Promise<LegacyServiceDetection>;
  /** The last detection, or null before the first one finished. */
  latest(): LegacyServiceDetection | null;
  /**
   * Whether a start on `databasePath` must wait for the user: the old service may serve it, and the user has not said
   * "仍要啟動" for it in this run. Detects again first, so a service removed in the meantime no longer blocks.
   */
  blocks(databasePath: string): Promise<boolean>;
  /**
   * What the backend tells the Web about the old service for `databasePath` (from the last detection, no new one): the
   * status page shows the same warning. Nothing when it does not concern this database.
   */
  facts(databasePath: string): DesktopFacts | undefined;
  /** The user said "仍要啟動" for this database; remembered until the App quits, never written anywhere. */
  allow(databasePath: string): void;
}

export interface LegacyGuardOptions {
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
  readonly log: Logger;
  /** Test seam; defaults to the real read-only detection. */
  readonly detect?: () => Promise<LegacyServiceDetection>;
}

function describe(detection: LegacyServiceDetection): string {
  if (detection.kind === "none") return "none";
  return `${detection.recognised ? "recognised" : "unrecognised"} ${detection.running}`;
}

export function createLegacyGuard(options: LegacyGuardOptions): LegacyGuard {
  const { platform, log } = options;
  const detect =
    options.detect ??
    (() =>
      detectLegacyService({ platform, homeDirectory: homedir(), environment: options.environment }).catch(
        (): LegacyServiceDetection => ({ kind: "none" }),
      ));
  const allowed = new Set<string>();
  let latest: LegacyServiceDetection | null = null;
  let logged: string | undefined;

  const key = (databasePath: string): string => (platform === "win32" ? databasePath.toLowerCase() : databasePath);

  async function refresh(): Promise<LegacyServiceDetection> {
    const started = Date.now();
    latest = await detect();
    const summary = describe(latest);
    // One line when what was found changes, not one per start: see the log contract in log.ts.
    if (summary !== logged) {
      logged = summary;
      log(`[shell] legacy service ${summary} (${Date.now() - started} ms)`);
    }
    return latest;
  }

  return {
    refresh,
    latest: () => latest,
    blocks: async (databasePath) => {
      const detection = await refresh();
      if (!legacyServiceConflicts(detection, databasePath, platform)) return false;
      return !allowed.has(key(databasePath));
    },
    facts: (databasePath) => {
      if (latest?.kind !== "found" || !legacyServiceConflicts(latest, databasePath, platform)) return undefined;
      return {
        legacyService: {
          running: latest.running,
          fallbackRemoveCommand: latest.fallbackRemoveCommand,
          ...(latest.removeCommand === undefined ? {} : { removeCommand: latest.removeCommand }),
        },
      };
    },
    allow: (databasePath) => {
      allowed.add(key(databasePath));
      log("[shell] start anyway: the user accepted the old login service on this database");
    },
  };
}
