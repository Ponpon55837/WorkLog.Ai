import { basename, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { ProjectRecord, ProjectStatus } from "@work-intelligence/core";
import { canonicalizeProjectRoot, isPathWithinProject, type WorkIntelligenceStore } from "@work-intelligence/storage";
import { inspectProjectFolder } from "./http.js";
import { resolveServerPort } from "./server-port.js";

export interface TrackCliDependencies {
  withStore: <T>(task: (store: WorkIntelligenceStore) => T) => T;
  /** Directory the user ran the command from (pnpm sets INIT_CWD); relative folders resolve against it. */
  invocationDirectory: string;
  log: (message: string) => void;
  error: (message: string) => void;
  /** Whether a person can answer a prompt; without it and without --yes the command only previews. */
  isInteractive?: () => boolean;
  confirm?: (question: string) => Promise<boolean>;
  port?: number;
}

interface TrackOptions {
  folder: string;
  name?: string;
  yes: boolean;
}

type TrackPlan =
  | { kind: "already_tracked"; project: ProjectRecord }
  | { kind: "apply"; name: string; rootPath: string; current?: ProjectRecord; overlaps: ProjectRecord[] };

const USAGE_EXIT_CODE = 2;
const statusLabels: Record<ProjectStatus, string> = {
  tracked: "記錄中",
  paused: "已暫停",
  ignored: "已忽略",
  unregistered: "未註冊",
};
const TRACKED_MEANING =
  "「記錄中」的意思：Agent 可以在這個專案讀取 handoff、Git／worktree 與 source，並保存工作紀錄；其他狀態會安靜略過所有讀取。之後可以在 Web 的「專案」頁暫停或忽略。";
export const trackUsage = `用法：
  pnpm track <資料夾> [--name <名稱>] [--yes]

把一個專案加入並設為「記錄中」。會先顯示預覽，確認後才寫入。
  --name <名稱>   專案名稱；預設使用資料夾名稱
  --yes           略過確認直接套用（非互動環境沒有 --yes 時只顯示預覽）`;

function parseTrackArgs(args: readonly string[]): TrackOptions | string {
  let folder: string | undefined;
  let name: string | undefined;
  let yes = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--yes") {
      yes = true;
    } else if (arg === "--name") {
      index += 1;
      name = args[index];
      if (!name?.trim()) return "--name 需要專案名稱。";
    } else if (arg?.startsWith("--name=")) {
      name = arg.slice("--name=".length);
      if (!name.trim()) return "--name 需要專案名稱。";
    } else if (arg && !arg.startsWith("--") && folder === undefined) {
      folder = arg;
    } else {
      return `看不懂的參數：${arg ?? ""}`;
    }
  }
  if (!folder?.trim()) return "請指定要記錄的專案資料夾。";
  return { folder, yes, ...(name ? { name: name.trim() } : {}) };
}

function planTrack(store: WorkIntelligenceStore, rootPath: string, options: TrackOptions): TrackPlan {
  const projects = store.listProjects();
  const current = projects.find((project) => project.rootPath === rootPath);
  if (current?.status === "tracked") {
    return { kind: "already_tracked", project: current };
  }
  const overlaps = projects.filter(
    (project) =>
      project.rootPath !== rootPath &&
      (isPathWithinProject(rootPath, project.rootPath) || isPathWithinProject(project.rootPath, rootPath)),
  );
  return {
    kind: "apply",
    name: options.name ?? current?.name ?? (basename(rootPath) || rootPath),
    rootPath,
    overlaps,
    ...(current ? { current } : {}),
  };
}

function printPreview(
  plan: Extract<TrackPlan, { kind: "apply" }>,
  applying: boolean,
  print: (message: string) => void,
): void {
  print(applying ? "即將套用（--yes）：" : "預覽（尚未寫入任何資料）：");
  print(`  專案名稱：${plan.name}`);
  print(`  路徑：${plan.rootPath}`);
  print(
    plan.current
      ? `  狀態：${statusLabels[plan.current.status]} → ${statusLabels.tracked}`
      : `  狀態：新增專案 → ${statusLabels.tracked}`,
  );
  for (const other of plan.overlaps) {
    print(`  警告：與專案「${other.name}」的根目錄重疊（${other.rootPath}）；兩個專案都可能讀到重疊的檔案。`);
  }
  print(TRACKED_MEANING);
}

async function askToConfirm(question: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(question);
    return ["y", "yes"].includes(answer.trim().toLowerCase());
  } finally {
    prompt.close();
  }
}

/** `pnpm track`: the user, in a terminal, explicitly adds a folder and switches it to tracked. Never callable by Agents. */
export async function runTrackCommand(args: readonly string[], dependencies: TrackCliDependencies): Promise<number> {
  const parsed = parseTrackArgs(args);
  if (typeof parsed === "string") {
    dependencies.error(`錯誤：${parsed}\n\n${trackUsage}`);
    return USAGE_EXIT_CODE;
  }
  try {
    const rootPath = canonicalizeProjectRoot(resolve(dependencies.invocationDirectory, parsed.folder));
    if (inspectProjectFolder(rootPath) !== "found") {
      dependencies.error(`錯誤：找不到資料夾或無法讀取：${rootPath}`);
      return 1;
    }
    const plan = dependencies.withStore((store) => planTrack(store, rootPath, parsed));
    if (plan.kind === "already_tracked") {
      dependencies.log(`「${plan.project.name}」已在記錄中，資料沒有變更。`);
      return 0;
    }
    printPreview(plan, parsed.yes, dependencies.log);
    const interactive = dependencies.isInteractive ?? (() => Boolean(process.stdin.isTTY && process.stdout.isTTY));
    if (!parsed.yes) {
      if (!interactive()) {
        dependencies.log("非互動環境：只顯示預覽，資料沒有變更。確認無誤後請加上 --yes 重新執行。");
        return 0;
      }
      const confirm = dependencies.confirm ?? askToConfirm;
      if (!(await confirm("確認開始記錄這個專案？[y/N] "))) {
        dependencies.log("已取消，資料沒有變更。");
        return 0;
      }
    }
    const project = dependencies.withStore((store) => {
      const added = store.addProject(plan.name, plan.rootPath);
      return store.updateProject(added.id, {
        status: "tracked",
        ...(parsed.name ? { name: parsed.name } : {}),
      });
    });
    if (!project) {
      dependencies.error("錯誤：專案加入後找不到記錄，資料沒有完成變更。");
      return 1;
    }
    const port = dependencies.port ?? resolveServerPort();
    dependencies.log(`已開始記錄「${project.name}」（${project.rootPath}）。`);
    dependencies.log(`Dashboard：http://127.0.0.1:${port}`);
    dependencies.log("已連線的 Agent 下次讀取時就會生效，不需要重新連線 MCP；完成工作時請 Agent 保存這次工作。");
    return 0;
  } catch (error) {
    dependencies.error(`錯誤：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
