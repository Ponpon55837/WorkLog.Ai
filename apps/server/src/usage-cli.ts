import { resolve } from "node:path";
import type { ProjectRecord } from "@work-intelligence/core";
import { commandName } from "@work-intelligence/shared";
import {
  UsageScanAbortedError,
  UsageScanTimeoutError,
  formatForAgent,
  formatTable,
  type UsageProjectInput,
} from "@work-intelligence/shared/agent-usage";
import { canonicalizeProjectRoot, isPathWithinProject, type WorkIntelligenceStore } from "@work-intelligence/storage";
import { CLI_DASH_HELP, checkCliArgs, type ParsedCliArgs } from "./cli-args.js";
import { buildUsageResponse } from "./usage-response.js";
import { runUsageScan, USAGE_SCAN_TIMEOUT_MS, type UsageScanContext } from "./usage-scan.js";

interface UsageCliDependencies {
  withStore: <T>(task: (store: WorkIntelligenceStore) => T) => T;
  /** Directory the user ran the command from; the default project is the one whose root contains it. */
  invocationDirectory: string;
  log: (message: string) => void;
  error: (message: string) => void;
  /** Where the logs are read and the cache lives; injectable so tests never read the real home directory. */
  context: UsageScanContext;
  /** Language of `--for-agent`; defaults to the terminal's (`LANG`). */
  locale?: "en" | "zh-TW";
  /** Which command names to show; defaults to the running mode. */
  standalone?: boolean;
}

interface UsageOptions {
  projects: string[];
  all: boolean;
  json: boolean;
  forAgent: boolean;
  since?: string;
  until?: string;
}

const USAGE_EXIT_CODE = 2;

/** @internal test-only */
export function usageHelp(standalone?: boolean): string {
  return `用法：
  ${commandName("usage:report", standalone)} [--project <名稱或根目錄>]... [--all] [--since <ISO>] [--until <ISO>] [--json] [--for-agent]

統計本機 Claude Code／Codex 紀錄的 Agent 用量（只有次數、token 與工具名稱，不含訊息內容或路徑）。
  --project <名稱或根目錄>   只統計這個記錄中的專案（可重複）；預設為目前資料夾所在的專案，找不到則為全部
  --all                      統計全部記錄中的專案
  --since <ISO> / --until <ISO>   時間範圍
  --json                     輸出彙總 JSON（與 Dashboard 相同的欄位）
  --for-agent                輸出可貼給 Agent 的純文字報告
${CLI_DASH_HELP}`;
}

function toInput(project: ProjectRecord): UsageProjectInput {
  return { id: project.id, name: project.name, root: project.rootPath };
}

function readOptions(parsed: ParsedCliArgs): UsageOptions | string {
  if (parsed.positionals.length > 0) return `看不懂的參數：${parsed.positionals[0]}`;
  const since = parsed.values.get("--since") ?? [];
  const until = parsed.values.get("--until") ?? [];
  if (since.length > 1 || until.length > 1) return "--since 與 --until 只能各指定一次。";
  for (const value of [...since, ...until]) {
    if (!Number.isFinite(Date.parse(value))) return `時間格式不正確：${value}`;
  }
  if (parsed.flags.has("--json") && parsed.flags.has("--for-agent")) return "--json 與 --for-agent 只能擇一。";
  return {
    projects: [...(parsed.values.get("--project") ?? [])],
    all: parsed.flags.has("--all"),
    json: parsed.flags.has("--json"),
    forAgent: parsed.flags.has("--for-agent"),
    ...(since[0] ? { since: since[0] } : {}),
    ...(until[0] ? { until: until[0] } : {}),
  };
}

function sameRoot(project: ProjectRecord, value: string, directory: string): boolean {
  try {
    return canonicalizeProjectRoot(resolve(directory, value)) === project.rootPath;
  } catch {
    return false;
  }
}

/** The tracked projects the options select, or a message saying which name matched nothing. */
function selectProjects(tracked: ProjectRecord[], options: UsageOptions, directory: string): ProjectRecord[] | string {
  if (options.all) return tracked;
  if (options.projects.length > 0) {
    const selected: ProjectRecord[] = [];
    for (const value of options.projects) {
      const match = tracked.find(
        (project) => project.name === value || project.id === value || sameRoot(project, value, directory),
      );
      if (!match) return `找不到記錄中的專案：${value}`;
      if (!selected.includes(match)) selected.push(match);
    }
    return selected;
  }
  const containing = tracked.filter((project) => isPathWithinProject(directory, project.rootPath));
  if (containing.length === 0) return tracked;
  // The deepest root is the most specific project when roots are nested.
  return [containing.reduce((best, project) => (project.rootPath.length > best.rootPath.length ? project : best))];
}

/** `usage:report`: the same counts as the Dashboard's Usage page, from the terminal, scanned in this process. */
export async function runUsageCommand(args: readonly string[], dependencies: UsageCliDependencies): Promise<number> {
  const check = checkCliArgs(args, {
    flags: ["--all", "--json", "--for-agent"],
    valued: ["--project", "--since", "--until"],
  });
  if (check.kind === "help") {
    dependencies.log(usageHelp(dependencies.standalone));
    return 0;
  }
  const options = check.kind === "error" ? check.message : readOptions(check);
  if (typeof options === "string") {
    dependencies.error(`錯誤：${options}\n\n${usageHelp(dependencies.standalone)}`);
    return USAGE_EXIT_CODE;
  }
  try {
    const tracked = dependencies.withStore((store) =>
      store.listProjects().filter((project) => project.status === "tracked"),
    );
    const projects = selectProjects(tracked, options, dependencies.invocationDirectory);
    if (typeof projects === "string") {
      dependencies.error(`錯誤：${projects}`);
      return 1;
    }
    if (projects.length === 0) {
      dependencies.error("錯誤：沒有記錄中的專案可以統計。");
      return 1;
    }
    const started = Date.now();
    const outcome = await runUsageScan(
      {
        projects: projects.map(toInput),
        allProjects: tracked.map(toInput),
        manualFolders: [],
        ...(options.since ? { since: options.since } : {}),
        ...(options.until ? { until: options.until } : {}),
      },
      dependencies.context,
      { deadlineMs: started + USAGE_SCAN_TIMEOUT_MS },
    );
    const locale = dependencies.locale ?? (/^zh/i.test(process.env.LANG ?? "") ? "zh-TW" : "en");
    const range = { since: options.since ?? null, until: options.until ?? null };
    const names = projects.map((project) => project.name);
    const namesById = Object.fromEntries(tracked.map((project) => [project.id, project.name]));
    if (options.json) {
      dependencies.log(
        JSON.stringify(
          buildUsageResponse(outcome.report, {
            problems: outcome.problems,
            projectNames: names,
            projectNamesById: namesById,
            range,
            durationMs: Date.now() - started,
            locale,
          }),
          null,
          2,
        ),
      );
    } else if (options.forAgent) {
      dependencies.log(
        formatForAgent(outcome.report, {
          projectNames: names,
          projectNamesById: namesById,
          ...(options.since ? { since: options.since } : {}),
          ...(options.until ? { until: options.until } : {}),
          locale,
        }),
      );
    } else {
      dependencies.log(formatTable(outcome.report));
    }
    return 0;
  } catch (error) {
    // Only the kind of failure is printed: messages of file-system errors embed paths.
    const reason =
      error instanceof UsageScanTimeoutError ? "逾時" : error instanceof UsageScanAbortedError ? "已取消" : "讀取失敗";
    dependencies.error(`錯誤：無法統計 Agent 用量（${reason}）。`);
    return 1;
  }
}
