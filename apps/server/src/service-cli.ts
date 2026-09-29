import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import {
  createUserServicePlan,
  formatUserServiceStatus,
  getUserServiceStatus,
  installUserServiceWithConfirmation,
  uninstallUserService,
} from "./user-service.js";

async function confirm(prompt: string): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) {
    console.log("目前沒有互動終端，服務設定沒有變更。請在終端機重新執行並確認預覽內容。");
    return false;
  }
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await terminal.question(`${prompt} [y/N] `);
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    terminal.close();
  }
}

async function install(): Promise<void> {
  const plan = createUserServicePlan();
  const installed = await installUserServiceWithConfirmation(plan, (preview) => console.log(preview), confirm);
  if (!installed) {
    console.log("已取消，沒有寫入設定或建立資料夾。");
    return;
  }
  console.log("登入啟動服務已安裝並啟動。");
  console.log(formatUserServiceStatus(getUserServiceStatus()));
}

async function uninstall(): Promise<void> {
  const plan = createUserServicePlan();
  const status = getUserServiceStatus();
  if (status.state === "not_installed") {
    console.log("目前沒有已安裝的 Work Intelligence 登入啟動服務。");
    return;
  }
  console.log(`將停用並移除服務設定：${plan.configPath}`);
  console.log("資料庫、備份與日誌會保留。");
  if (!(await confirm("確認移除目前使用者的登入啟動服務？"))) {
    console.log("已取消，服務設定沒有變更。");
    return;
  }
  uninstallUserService(plan);
  console.log("登入啟動服務已移除；資料庫、備份與日誌已保留。");
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "status") {
    console.log(formatUserServiceStatus(getUserServiceStatus()));
    return;
  }
  if (command === "install") {
    await install();
    return;
  }
  if (command === "uninstall") {
    await uninstall();
    return;
  }
  console.error("用法：pnpm service:install | pnpm service:uninstall | pnpm service:status");
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "服務命令失敗。");
    process.exitCode = 1;
  });
}
