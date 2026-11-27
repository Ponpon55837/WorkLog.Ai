import { commandName, STANDALONE_COMMAND_NAME } from "@work-intelligence/shared";
import { APP_VERSION } from "@work-intelligence/shared/app-version";
import { DEFAULT_SERVER_PORT } from "./server-port.js";

export type StandaloneCommand =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "start" }
  | { kind: "start-desktop" }
  | { kind: "mcp" }
  | { kind: "check" }
  | { kind: "track"; args: readonly string[] }
  | { kind: "track-help" }
  | { kind: "db"; args: readonly string[] }
  | { kind: "invalid"; message: string };

export interface StandaloneRuntime {
  log: (message: string) => void;
  error: (message: string) => void;
  start: () => Promise<void>;
  startDesktop: () => Promise<number>;
  mcp: () => Promise<void>;
  check: () => Promise<number>;
  database: (args: readonly string[]) => Promise<number>;
  trackUsage: () => Promise<string>;
}

const USAGE_EXIT_CODE = 2;
const HELP_FLAGS = new Set(["-h", "--help"]);
const VERSION_FLAGS = new Set(["-v", "--version", "version"]);
const SIMPLE_COMMANDS = ["start", "mcp", "check"] as const;
// Internal switch for the desktop App's runtime launcher, so `--help` does not list it.
const DESKTOP_IPC_FLAG = "--desktop-ipc";

const defaultRuntime: StandaloneRuntime = {
  log: (message) => console.log(message),
  error: (message) => console.error(message),
  start: async () => {
    const { collectStartupHints } = await import("./startup-check.js");
    const hints = collectStartupHints();
    if (hints.length > 0) {
      for (const hint of hints) console.error(hint);
      console.error(`詳細結果請執行 ${commandName("check", true)}`);
    }
    const { startApi } = await import("./start-api.js");
    startApi();
  },
  startDesktop: async () => (await import("./desktop-child.js")).runDesktopChild(),
  // The MCP bundle is a sibling of this one; importing it starts the server.
  mcp: async () => {
    await import(new URL("../../mcp/dist/index.js", import.meta.url).href);
  },
  check: async () => (await import("./doctor.js")).runDoctorCli(),
  database: async (args) => (await import("./cli.js")).runDatabaseCli(args, { standalone: true }),
  trackUsage: async () => (await import("./track-cli.js")).trackUsage(true),
};

export function standaloneUsage(): string {
  const name = STANDALONE_COMMAND_NAME;
  return `用法：${name} <指令> [選項]

指令：
  start                                        啟動 Web 介面與 API（http://127.0.0.1:${DEFAULT_SERVER_PORT}；WORK_INTELLIGENCE_PORT 可改 port）
  mcp                                          以 stdio 啟動 MCP server（供 Agent 連線）
  track <資料夾> [--name <名稱>] [--yes]        預覽後把專案加入並設為記錄中
  check                                        唯讀診斷套件、資料庫與 Agent 設定
  db <子指令>                                   資料庫維護、備份、匯出、匯入與還原（${name} db 查看說明）
  --version, -v                                顯示版本
  --help, -h                                   顯示這份說明

資料預設存在 ~/.work-intelligence/data；WORK_INTELLIGENCE_CONFIG_DIR 可改目錄，WORK_INTELLIGENCE_DB 可指定資料庫檔。`;
}

export function parseStandaloneArgs(argv: readonly string[]): StandaloneCommand {
  const [first, ...rest] = argv;
  if (first === undefined || first === "help" || HELP_FLAGS.has(first)) return { kind: "help" };
  if (VERSION_FLAGS.has(first)) {
    return rest.length === 0 ? { kind: "version" } : { kind: "invalid", message: `${first} 不接受參數。` };
  }
  if (first === "track") {
    return rest[0] !== undefined && HELP_FLAGS.has(rest[0]) ? { kind: "track-help" } : { kind: "track", args: rest };
  }
  if (first === "db") {
    return { kind: "db", args: rest[0] !== undefined && HELP_FLAGS.has(rest[0]) ? [] : rest };
  }
  if (first === "start" && rest.length === 1 && rest[0] === DESKTOP_IPC_FLAG) return { kind: "start-desktop" };
  const simple = SIMPLE_COMMANDS.find((command) => command === first);
  if (simple) {
    if (rest.length === 1 && rest[0] !== undefined && HELP_FLAGS.has(rest[0])) return { kind: "help" };
    return rest.length === 0 ? { kind: simple } : { kind: "invalid", message: `${simple} 不接受參數：${rest[0]}` };
  }
  return { kind: "invalid", message: `未知的指令：${first}` };
}

export async function runStandaloneCli(
  argv: readonly string[],
  runtime: StandaloneRuntime = defaultRuntime,
): Promise<number> {
  const command = parseStandaloneArgs(argv);
  try {
    switch (command.kind) {
      case "help":
        runtime.log(standaloneUsage());
        return 0;
      case "version":
        runtime.log(`${STANDALONE_COMMAND_NAME} ${APP_VERSION}`);
        return 0;
      case "invalid":
        runtime.error(`錯誤：${command.message}\n\n${standaloneUsage()}`);
        return USAGE_EXIT_CODE;
      case "track-help":
        runtime.log(await runtime.trackUsage());
        return 0;
      case "track":
        return await runtime.database(["track", ...command.args]);
      case "db":
        return await runtime.database(command.args);
      case "check":
        return await runtime.check();
      case "start":
        await runtime.start();
        return 0;
      case "start-desktop":
        return await runtime.startDesktop();
      case "mcp":
        await runtime.mcp();
        return 0;
    }
  } catch {
    // Never show a stack or an internal error message; the commands print their own actionable errors.
    runtime.error(`Work Intelligence 無法完成「${argv[0] ?? ""}」。請執行 ${commandName("check", true)} 檢查。`);
    return 1;
  }
}
