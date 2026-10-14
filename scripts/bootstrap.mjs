import { error as consoleError, log as consoleLog } from "node:console";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runPnpm } from "./run-pnpm.mjs";

/*
 * `pnpm bootstrap`: the single install path (install, build, connect Agents, optional login service, doctor).
 * Node built-ins only, because it can run before `pnpm install`. Steps, prompts and output are injectable so the
 * flow is testable without running pnpm.
 */

export const MINIMUM_NODE = "22.13.0";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SERVICE_RESTART_REMINDER = "更新後請重新執行 pnpm service:install 重啟服務（會顯示預覽並要求確認），讓新版生效。";

const FLAGS = new Set(["--yes", "--skip-agents", "--service", "--help"]);

const USAGE = [
  "用法：pnpm bootstrap [--yes] [--skip-agents] [--service] [--help]",
  "",
  "  --yes          不詢問，直接執行安裝與建置（非互動終端必須帶這個旗標才會執行）",
  "  --skip-agents  略過連接 Agent（pnpm setup:agents）",
  "  --service      執行登入自動啟動設定（pnpm service:install，仍會顯示預覽並要求確認）",
  "  --help         顯示這段說明",
  "",
  "可重複執行；git pull 之後再跑一次，就等於更新後同步。",
].join("\n");

const NEXT_STEPS = [
  "完成。接下來：",
  "  1. 啟動：pnpm start（若已安裝登入自動啟動服務，Dashboard 網址為 http://127.0.0.1:3210；更新後請重新執行 pnpm service:install 重啟服務，讓新版生效）",
  "  2. 開啟 http://127.0.0.1:3210 →「專案」→「加入專案」→ 設為「記錄中」",
  "  3. 在 Agent 重新連線 MCP；Codex 需在 /hooks 信任 hook",
].join("\n");

/** Splits a "v22.13.0" or "22.13.0" style version into numbers; undefined when it is not one. */
function versionParts(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? "").trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function atLeast(installed, minimum) {
  const have = versionParts(installed);
  const need = versionParts(minimum);
  if (!have || !need) return false;
  for (let index = 0; index < 3; index += 1) {
    if (have[index] !== need[index]) return have[index] > need[index];
  }
  return true;
}

/** The pnpm minimum from the root package.json `engines.pnpm` (">=x.y.z"), or undefined when it cannot be read. */
function readRequiredPnpm() {
  try {
    const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
    return /^>=\s*(\S+)$/.exec(String(manifest?.engines?.pnpm ?? "").trim())?.[1];
  } catch {
    return undefined;
  }
}

function readPnpmVersion() {
  const result = runPnpm(["--version"], { cwd: repositoryRoot, encoding: "utf8" });
  return result.status === 0 && typeof result.stdout === "string" ? result.stdout.trim() : undefined;
}

export function parseBootstrapArguments(argv) {
  const unknown = argv.filter((argument) => !FLAGS.has(argument));
  return {
    unknown,
    yes: argv.includes("--yes"),
    skipAgents: argv.includes("--skip-agents"),
    service: argv.includes("--service"),
    help: argv.includes("--help"),
  };
}

/**
 * Whether the login service is already installed, read from the freshly built user-service module (a read-only OS
 * query). Any failure counts as "not installed", which falls back to asking.
 */
async function readServiceInstalled() {
  try {
    const module = await import(pathToFileURL(resolve(repositoryRoot, "apps/server/dist/user-service.js")).href);
    const state = module.getUserServiceStatus({ repositoryRoot }).state;
    return state === "running" || state === "stopped";
  } catch {
    return false;
  }
}

export function defaultBootstrapDependencies() {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return {
    nodeVersion: process.versions.node,
    pnpmVersion: readPnpmVersion,
    requiredPnpm: readRequiredPnpm(),
    interactive,
    serviceInstalled: readServiceInstalled,
    log: (message) => consoleLog(message),
    error: (message) => consoleError(message),
    async ask(question) {
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return (await terminal.question(question)).trim().toLowerCase();
      } finally {
        terminal.close();
      }
    },
    /** Runs one pnpm command with the terminal attached and returns its exit status (1 when it could not start). */
    runStep(args) {
      const result = runPnpm(args, { cwd: repositoryRoot, stdio: "inherit" });
      return typeof result.status === "number" ? result.status : 1;
    },
  };
}

/** Runs the flow and returns the process exit code: 0 done or plan only, 1 a step or precheck failed, 2 bad usage. */
export async function runBootstrap(argv, dependencies = defaultBootstrapDependencies()) {
  const options = parseBootstrapArguments(argv);
  const { log, error } = dependencies;

  if (options.unknown.length > 0) {
    error(`不認得的旗標：${options.unknown.join(" ")}`);
    error(USAGE);
    return 2;
  }
  if (options.help) {
    log(USAGE);
    return 0;
  }

  if (!atLeast(dependencies.nodeVersion, MINIMUM_NODE)) {
    error(`Node.js 版本過低：目前 ${dependencies.nodeVersion}，需要 ${MINIMUM_NODE} 以上。`);
    error("請升級 Node.js（建議 24），再重新執行 pnpm bootstrap。");
    return 1;
  }
  const requiredPnpm = dependencies.requiredPnpm;
  const installedPnpm = dependencies.pnpmVersion();
  if (requiredPnpm && !atLeast(installedPnpm, requiredPnpm)) {
    error(`pnpm 版本不符：目前 ${installedPnpm ?? "無法取得"}，需要 ${requiredPnpm} 以上。`);
    error("請執行 corepack enable 或 npm install -g pnpm 更新，再重新執行 pnpm bootstrap。");
    return 1;
  }

  log(
    [
      "pnpm bootstrap 會依序執行：",
      "  ① 安裝依賴（pnpm install）— 只寫入此 repo",
      "  ② 建置（pnpm build）— 只寫入此 repo",
      options.skipAgents
        ? "  ③ 連接 Agent（pnpm setup:agents）— 已用 --skip-agents 略過"
        : "  ③ 連接 Agent（pnpm setup:agents）— 會寫入全域 Agent 設定，另外顯示預覽並要求輸入 yes",
      options.service
        ? "  ④ 登入自動啟動（pnpm service:install）— 會寫入服務設定，另外顯示預覽並要求確認"
        : "  ④ 登入自動啟動（pnpm service:install，選用）— 會寫入服務設定，另外顯示預覽並要求確認",
      "  ⑤ 診斷（pnpm run doctor）— 唯讀",
    ].join("\n"),
  );

  if (!options.yes) {
    if (!dependencies.interactive) {
      log("非互動終端：只顯示計畫。要直接執行請加上 --yes。");
      return 0;
    }
    const answer = await dependencies.ask("要執行 ①② 嗎？[Y/n] ");
    if (answer === "n" || answer === "no") {
      log("已取消，沒有執行任何步驟。");
      return 0;
    }
  }

  const steps = [
    { label: "① 安裝依賴", args: ["install"] },
    { label: "② 建置", args: ["build"] },
  ];
  if (!options.skipAgents) steps.push({ label: "③ 連接 Agent", args: ["setup:agents"] });

  let runService = options.service;
  for (const step of steps) {
    log(`\n== ${step.label}（pnpm ${step.args.join(" ")}）==`);
    if (dependencies.runStep(step.args) !== 0) {
      error(`${step.label} 失敗。請依上方訊息修正後，重新執行 pnpm bootstrap。`);
      return 1;
    }
  }

  if (!runService) {
    if (await dependencies.serviceInstalled()) {
      // Re-running service:install stops, rewrites and starts the service; it keeps its own preview and confirmation.
      log("\n登入自動啟動服務已安裝，不再詢問是否設定。");
      log(SERVICE_RESTART_REMINDER);
    } else if (dependencies.interactive) {
      const answer = await dependencies.ask("要設定登入自動啟動嗎？[y/N] ");
      runService = answer === "y" || answer === "yes";
    }
  }
  if (runService) {
    log("\n== ④ 登入自動啟動（pnpm service:install）==");
    if (dependencies.runStep(["service:install"]) !== 0) {
      error("④ 登入自動啟動 失敗。請依上方訊息修正後，重新執行 pnpm bootstrap。");
      return 1;
    }
  }

  log("\n== ⑤ 診斷（pnpm run doctor）==");
  if (dependencies.runStep(["run", "doctor"]) !== 0) {
    log("診斷回報了需要處理的項目（不影響 bootstrap 結果）；請依上方建議修正。");
  }

  log(`\n${NEXT_STEPS}`);
  return 0;
}

/** Run directly, not imported. Compares real paths: the checkout may sit behind a symlink. */
function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = await runBootstrap(process.argv.slice(2));
}
