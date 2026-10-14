import { z } from "zod";
import { getMcpRuntimeStatus } from "@work-intelligence/shared/mcp-runtime";
import { DEFAULT_SERVER_PORT } from "./server-port.js";

export interface DatabaseBusyDiagnosisDependencies {
  /** Resolves true when a Work Intelligence server answers /api/health on this port. */
  probeServer?: (port: number) => Promise<boolean>;
  /** Fresh Agent MCP process leases; `monitoringAvailable: false` means the count is unknown. */
  getMcpStatus?: () => { activeProcesses: number; monitoringAvailable: boolean };
  port?: number;
}

const HEALTH_PROBE_TIMEOUT_MS = 1500;
const HEALTH_SCHEMA = z.object({ ok: z.boolean(), app: z.literal("Work Intelligence") });

/** True for the typed storage errors that mean another process holds the database file. */
export function isDatabaseInUseError(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === "DATABASE_IN_USE";
}

function resolveServerPort(): number {
  const port = Number(process.env.WORK_INTELLIGENCE_PORT ?? DEFAULT_SERVER_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_SERVER_PORT;
}

async function probeServerHealth(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    const parsed = HEALTH_SCHEMA.safeParse(await response.json());
    return response.ok && parsed.success && parsed.data.ok;
  } catch {
    return false;
  }
}

/**
 * Read-only hints appended to a DATABASE_IN_USE error: whether the server is running and how many Agent MCP
 * connections are alive. Never throws; a failed probe is simply omitted so the original error stays visible.
 */
export async function diagnoseDatabaseInUse(
  repositoryRoot: string,
  dependencies: DatabaseBusyDiagnosisDependencies = {},
): Promise<string[]> {
  const port = dependencies.port ?? resolveServerPort();
  const probeServer = dependencies.probeServer ?? probeServerHealth;
  const getMcpStatus = dependencies.getMcpStatus ?? (() => getMcpRuntimeStatus(repositoryRoot));
  const lines: string[] = [];
  let serverRunning: boolean;
  let mcpCount = 0;
  let mcpUnknown = false;
  try {
    serverRunning = await probeServer(port);
  } catch {
    serverRunning = false;
  }
  try {
    const status = getMcpStatus();
    if (!status.monitoringAvailable) {
      mcpUnknown = true;
    } else {
      mcpCount = status.activeProcesses;
    }
  } catch {
    mcpUnknown = true;
  }
  if (serverRunning) {
    lines.push(
      `Work Intelligence server 正在 http://127.0.0.1:${port} 執行：請在執行 pnpm start 的終端機按 Ctrl+C；若是登入自動啟動服務，請執行 pnpm service:uninstall（Windows 也可在工作排程器停止「Work Intelligence」）。`,
    );
  }
  if (mcpCount > 0) {
    lines.push(`有 ${mcpCount} 個 Agent MCP 連線（Claude Code／Codex 對話）正在使用：請結束這些對話後重試。`);
  } else if (mcpUnknown) {
    lines.push("無法判斷 MCP 連線數。");
  }
  if (!serverRunning && mcpCount === 0) {
    lines.push("可能是其他程式開著這個資料庫檔（例如雲端同步或資料庫檢視工具）。");
  }
  return lines;
}
