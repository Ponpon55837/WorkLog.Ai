import { z } from "zod";
import { getMcpRuntimeStatus } from "@work-intelligence/shared/mcp-runtime";
import { resolveServerPort } from "./server-port.js";
import { getUserServiceStatus, WINDOWS_TASK_NAME } from "./user-service.js";

export interface DatabaseBusyDiagnosisDependencies {
  /** Resolves true when a Work Intelligence server answers /api/health on this port. */
  probeServer?: (port: number) => Promise<boolean>;
  /** Fresh Agent MCP process leases; `monitoringAvailable: false` means the count is unknown. */
  getMcpStatus?: () => { activeProcesses: number; monitoringAvailable: boolean };
  /** Read-only login-service state; `running` means the server was started by the login service. */
  getServiceStatus?: () => { state: string };
  platform?: NodeJS.Platform;
  port?: number;
}

const HEALTH_PROBE_TIMEOUT_MS = 1500;
const HEALTH_SCHEMA = z.object({ ok: z.boolean(), app: z.literal("Work Intelligence") });

/** True for the typed storage errors that mean another process holds the database file. */
export function isDatabaseInUseError(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === "DATABASE_IN_USE";
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
  const getServiceStatus = dependencies.getServiceStatus ?? (() => getUserServiceStatus({ repositoryRoot }));
  const platform = dependencies.platform ?? process.platform;
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
    const where = `Work Intelligence server 正在 http://127.0.0.1:${port} 執行：`;
    const terminalHint = "若是用 pnpm start 啟動，請在該終端機按 Ctrl+C。";
    const serviceHint = `若是登入自動啟動服務，請執行 pnpm service:uninstall 停止，維護完成後執行 pnpm service:install 恢復${
      platform === "win32"
        ? `；也可以在工作排程器「結束」名為「${WINDOWS_TASK_NAME}」的工作，維護後執行 pnpm service:install 重新啟動`
        : ""
    }。`;
    let serviceState: string | undefined;
    try {
      serviceState = getServiceStatus().state;
    } catch {
      serviceState = undefined;
    }
    if (serviceState === "running") {
      lines.push(
        `${where}這是登入自動啟動服務${platform === "win32" ? "" : "，服務管理器會自動重啟它，Ctrl+C 沒有用"}。${serviceHint}`,
      );
    } else if (serviceState === undefined) {
      lines.push(`${where}${terminalHint}${serviceHint}`);
    } else {
      lines.push(`${where}請在執行 pnpm start 的終端機按 Ctrl+C。`);
    }
  }
  if (mcpCount > 0) {
    lines.push(
      `有 ${mcpCount} 個 Agent MCP 連線（Claude Code／Codex 對話）正在使用（依此 checkout 的 MCP 連線計算）：請結束這些對話後重試。`,
    );
  } else if (mcpUnknown) {
    lines.push("無法判斷 MCP 連線數。");
  }
  if (!serverRunning && mcpCount === 0) {
    lines.push("可能是其他程式開著這個資料庫檔（例如雲端同步或資料庫檢視工具）。");
  }
  return lines;
}
