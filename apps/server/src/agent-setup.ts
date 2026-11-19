import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyAgentSetupPlan,
  createAgentSetupPlan,
  type AgentSetupPlan,
  type AgentSetupPlanOptions,
} from "@work-intelligence/agent-setup";

/** @internal test-only */
export interface AgentSetupCliDependencies extends AgentSetupPlanOptions {
  print: (message: string) => void;
  confirm?: (question: string) => Promise<boolean>;
}

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function printPlan(plan: AgentSetupPlan, options: AgentSetupCliDependencies): void {
  options.print(plan.mode === "install" ? "Agent 設定預覽（尚未寫入）：" : "解除安裝預覽（尚未寫入）：");
  for (const action of plan.actions) options.print(`- ${action}`);
  for (const conflict of plan.conflicts) options.print(`- 衝突：${conflict}`);
  if (plan.conflicts.length) options.print("發現設定衝突，沒有任何項目會寫入；請先手動處理衝突後重試。");
}

function printProjectInstructionSnippet(options: AgentSetupCliDependencies): void {
  const snippet = [
    "## Work Intelligence",
    "",
    "- 在已由使用者明確設為「記錄中」的專案，開始工作前透過 `work_read` 執行一次 `work_get_context`，提供 `projectRoot`、任務與已知路徑；它同時回傳 `tracked` 與 `projectStatus`，不必另外呼叫 `work_get_project_status`。結果為 `skipped` 時不要讀取該專案的任何資料。",
    "- 第一次呼叫某個 operation 前，讀取 `work-intelligence://agent/tool-contracts/<operation>` 取得該操作的完整契約（索引在 `work-intelligence://agent/tool-contracts`）；開始前先讀 `work-intelligence://agent/work-intelligence/SKILL.md`：每次工作都需要的隱私規則與開始、收尾流程，並列出報告、修正、整理未結項與 Knowledge 等流程的指南，開始該流程時再讀。",
    "- 工作完成後，在完成驗證與交接後透過 `work_write_idempotent` 執行 operation `work_finalize_session`；只回報實際確認的成果、變更檔案與驗證結果。若專案不是 tracked，或無法確認狀態，不要建立 Work Intelligence 記錄。",
  ].join("\n");
  options.print(`\n可貼入其他專案的 AGENTS.md 或 CLAUDE.md：\n\`\`\`markdown\n${snippet}\n\`\`\``);
}

export async function runAgentSetupCli(args: string[], dependencies: AgentSetupCliDependencies): Promise<number> {
  let mode: "install" | "uninstall" = "install";
  for (const arg of args) {
    if (arg === "--uninstall") mode = "uninstall";
    else return (dependencies.print(`不支援的參數：${arg}`), 1);
  }
  let exitCode = 0;
  try {
    const plan = createAgentSetupPlan(dependencies, mode);
    printPlan(plan, dependencies);
    if (plan.conflicts.length) {
      exitCode = 1;
    } else if (plan.mutations.length) {
      if (!dependencies.confirm || !(await dependencies.confirm("確認套用以上變更？輸入 yes 後才會寫入："))) {
        dependencies.print("已取消；設定未變更。");
      } else {
        const result = applyAgentSetupPlan(plan);
        if (!result.applied) {
          for (const conflict of result.conflicts) dependencies.print(`- 衝突：${conflict}`);
          if (result.error) dependencies.print(`錯誤：${result.error}`);
          exitCode = 1;
        } else {
          dependencies.print(mode === "install" ? "Agent 設定完成。" : "Work Intelligence 設定已解除安裝。");
          for (const action of result.actions) dependencies.print(`- ${action}`);
        }
      }
    }
  } catch (error) {
    dependencies.print(`錯誤：${error instanceof Error ? error.message : String(error)}`);
    exitCode = 1;
  }
  printProjectInstructionSnippet(dependencies);
  return exitCode;
}

export function defaultAgentSetupDependencies(
  print: (message: string) => void,
  confirm?: (question: string) => Promise<boolean>,
): AgentSetupCliDependencies {
  const homeDirectory = homedir();
  const codexHomeDirectory = process.env.CODEX_HOME?.trim();
  const claudeConfigDirectory = process.env.CLAUDE_CONFIG_DIR?.trim();
  return {
    homeDirectory,
    repositoryRoot: REPOSITORY_ROOT,
    ...(codexHomeDirectory ? { codexHomeDirectory } : {}),
    ...(claudeConfigDirectory ? { claudeConfigDirectory } : {}),
    print,
    ...(confirm ? { confirm } : {}),
  };
}
