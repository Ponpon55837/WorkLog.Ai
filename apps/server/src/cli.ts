import { resolve } from "node:path";
import { restoreDatabase, WorkIntelligenceStore, type RestorePathRemap } from "@work-intelligence/storage";
import { databasePath, storeOptions } from "./config.js";

/** Database maintenance from the terminal: backup, export for another computer, and restore. */
const usage = `用法：
  pnpm db:backup                      立即備份（存到資料庫旁的 backups/）
  pnpm db:export <檔案>               把整份資料匯出成一個 .sqlite 檔，帶到別台電腦
  pnpm db:restore <檔案> [選項]       用匯出或備份的檔案取代目前的資料

restore 選項：
  --remap-root <舊路徑>=<新路徑>     專案在新電腦的位置不同時，把路徑前綴換掉（可重複）
  --force                           略過「資料庫使用中」的檢查（只在確定沒有程式開著時使用）

還原前請先停止 API server（pnpm dev／pnpm start:server），並關閉會啟動 MCP 的 Codex／Claude 對話。
還原會先自動備份目前的資料。`;

function fail(message: string): never {
  console.error(`錯誤：${message}\n\n${usage}`);
  process.exit(1);
}

function parseRemap(value: string | undefined): RestorePathRemap {
  const separator = value?.lastIndexOf("=") ?? -1;
  if (!value || separator <= 0 || separator === value.length - 1) {
    fail("--remap-root 需要 <舊路徑>=<新路徑>。");
  }
  return { from: value.slice(0, separator), to: value.slice(separator + 1) };
}

function withStore<T>(task: (store: WorkIntelligenceStore) => T): T {
  const store = new WorkIntelligenceStore(databasePath, storeOptions);
  try {
    return task(store);
  } finally {
    store.close();
  }
}

// pnpm runs root scripts from the repo root; resolve paths against where the user ran the command.
const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
const fromInvocation = (path: string): string => resolve(invocationDirectory, path);

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "backup") {
    const result = withStore((store) => store.createBackup());
    if (result.outcome !== "database_backups") {
      fail(result.reason);
    }
    console.log(`已備份：${result.created.fileName}（保留最近 ${result.keep} 份）`);
  } else if (command === "export") {
    const target = args[0] ? fromInvocation(args[0]) : fail("請指定匯出檔案的路徑。");
    const { bytes } = withStore((store) => store.exportTo(target));
    console.log(`已匯出到 ${target}（${(bytes / 1024 / 1024).toFixed(1)} MB）。這個檔案包含全部工作記錄，請妥善保管。`);
  } else if (command === "restore") {
    const remap: RestorePathRemap[] = [];
    let source: string | undefined;
    let force = false;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "--remap-root") {
        index += 1;
        remap.push(parseRemap(args[index]));
      } else if (arg?.startsWith("--remap-root=")) {
        remap.push(parseRemap(arg.slice("--remap-root=".length)));
      } else if (arg === "--force") {
        force = true;
      } else if (arg && !arg.startsWith("--") && !source) {
        source = fromInvocation(arg);
      } else {
        fail(`看不懂的參數：${arg}`);
      }
    }
    if (!source) {
      fail("請指定要還原的檔案。");
    }
    const result = restoreDatabase({
      source,
      databasePath,
      remap,
      force,
      backupDirectory: storeOptions.backup?.directory,
    });
    if (result.safetyBackup) {
      console.log(`已先備份原本的資料：${result.safetyBackup}`);
    }
    console.log(
      `已還原 ${result.projects} 個專案、${result.sessions} 筆 Session（schema 版本 ${result.schemaVersion}）。`,
    );
    if (remap.length) {
      console.log(
        `已更新 ${result.remapped.projects} 個專案路徑、${result.remapped.handoffSnapshots} 個 handoff 路徑。`,
      );
    }
    // Opening the store once applies any newer migrations before the server or an Agent uses it.
    withStore(() => undefined);
    console.log("完成。重新啟動 API server 與 Agent 對話即可使用。");
  } else {
    console.log(usage);
    process.exit(command ? 1 : 0);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
