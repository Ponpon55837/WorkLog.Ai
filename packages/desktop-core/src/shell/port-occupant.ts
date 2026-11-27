import { realpath } from "node:fs/promises";

const PROBE_TIMEOUT_MS = 1500;

export interface PortOccupantProbe {
  readonly port: number;
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
