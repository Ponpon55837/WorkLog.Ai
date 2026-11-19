import { realpath } from "node:fs/promises";

/** How long the other server gets to answer; a port that holds something silent is not a Work Intelligence server. */
const PROBE_TIMEOUT_MS = 1500;

export interface PortOccupantProbe {
  /** The port another program holds. */
  readonly port: number;
  /** The database file the App is about to start on. */
  readonly databasePath: string;
  readonly fetchStatus?: (url: string, timeoutMs: number) => Promise<unknown>;
  readonly realPath?: (path: string) => Promise<string>;
  readonly platform?: NodeJS.Platform;
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return response.ok ? ((await response.json()) as unknown) : undefined;
}

function comparable(path: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? path.replace(/\\/g, "/").toLowerCase() : path;
}

async function resolved(path: string, realPath: (path: string) => Promise<string>): Promise<string> {
  try {
    return await realPath(path);
  } catch {
    return path;
  }
}

/**
 * Whether the program that holds `port` is another Work Intelligence server (a CLI or standalone one) that serves the
 * same database file. A start that fell back to another port would then run a second server on one database, so the
 * fallback must not be tried. Asks the loopback status endpoint only; any failure, silence or a different database
 * answers false (the port really belongs to something else). Never throws.
 */
export async function isSameDatabaseServer(probe: PortOccupantProbe): Promise<boolean> {
  const platform = probe.platform ?? process.platform;
  const realPath = probe.realPath ?? realpath;
  try {
    const body = await (probe.fetchStatus ?? fetchJson)(
      `http://127.0.0.1:${probe.port}/api/system/status`,
      PROBE_TIMEOUT_MS,
    );
    const status = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const database = status.database !== null && typeof status.database === "object" ? status.database : undefined;
    const path = database ? (database as Record<string, unknown>).path : undefined;
    if (typeof status.version !== "string" || typeof path !== "string") return false;
    return (
      comparable(await resolved(path, realPath), platform) ===
      comparable(await resolved(probe.databasePath, realPath), platform)
    );
  } catch {
    return false;
  }
}
