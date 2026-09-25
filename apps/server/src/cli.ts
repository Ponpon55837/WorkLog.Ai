import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ProjectDataExport,
  ProjectDataImportInput,
  ProjectDataImportPreview,
  ProjectPathRemap,
} from "@work-intelligence/core";
import { projectDataExportSchema, projectDataImportInputSchema } from "@work-intelligence/schema";
import { restoreDatabase, WorkIntelligenceStore, type RestorePathRemap } from "@work-intelligence/storage";
import { databasePath, storeOptions } from "./config.js";

/** Database maintenance from the terminal: backup, export for another computer, and restore. */
const MAX_PROJECT_IMPORT_BYTES = 50 * 1024 * 1024;
const usage = `用法：
  pnpm db:backup                      立即備份（存到資料庫旁的 backups/）
  pnpm db:export <檔案>               把整份資料匯出成一個 .sqlite 檔，帶到別台電腦
  pnpm db:export --all [選項]         匯出全部專案為可攜式 JSON
  pnpm db:export --project <名稱或 id> [選項]  匯出單一專案為可攜式 JSON
  pnpm db:import <檔案> [選項]         預覽後合併匯入可攜式 JSON
  pnpm db:restore <檔案> [選項]       用匯出或備份的檔案取代目前的資料

export 選項：
  --out <檔案.json>                  指定可攜式 JSON 匯出檔路徑

import 選項：
  --project <名稱或 id>              只匯入檔案中的單一專案；預設為全部
  --remap-root <舊路徑>=<新路徑>     換電腦時替換路徑前綴（可重複）
  --dry-run                         只顯示預覽，不寫入資料

restore 選項：
  --remap-root <舊路徑>=<新路徑>     專案在新電腦的位置不同時，把路徑前綴換掉（可重複）
  --force                           略過「資料庫使用中」的檢查（只在確定沒有程式開著時使用）

還原前請先停止 API server（pnpm dev／pnpm start:server），並關閉會啟動 MCP 的 Codex／Claude 對話。
還原會先自動備份目前的資料。`;

function fail(message: string): never {
  throw new Error(message);
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

function totalCounts(counts: ProjectDataImportPreview["additions"]): number {
  return Object.values(counts).reduce((total, count) => total + (count ?? 0), 0);
}

function findProjectId(projects: Array<{ id: string; name: string }>, value: string): string {
  const matches = projects.filter((project) => project.id === value || project.name === value);
  if (matches.length === 0) {
    fail(`找不到專案「${value}」。`);
  }
  if (matches.length > 1) {
    fail(`專案名稱「${value}」不唯一，請改用專案 id。`);
  }
  return matches[0]?.id ?? fail(`找不到專案「${value}」。`);
}

function defaultPortableFileName(scope: "all" | "project", invocationDirectory: string, projectId?: string): string {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const safeProjectId = projectId?.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8) || "data";
  const suffix = scope === "all" ? "all-projects" : `project-${safeProjectId}`;
  return resolve(invocationDirectory, `work-intelligence-${suffix}-${stamp}.json`);
}

function writePortableExport(target: string, bundle: ProjectDataExport): number {
  const content = JSON.stringify(bundle);
  const bytes = Buffer.byteLength(content);
  if (bytes > MAX_PROJECT_IMPORT_BYTES) {
    fail("可攜式匯出檔超過 50 MiB，請改用整份 SQLite 快照。");
  }
  mkdirSync(resolve(target, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(target, content, { flag: "wx", mode: 0o600 });
  return bytes;
}

function printImportPreview(preview: ProjectDataImportPreview): void {
  console.log(`匯入專案：${preview.selectedProjects.map((project) => project.name).join("、")}`);
  console.log(
    `新增 ${totalCounts(preview.additions)} 筆、略過 ${totalCounts(preview.skipped)} 筆、衝突 ${totalCounts(preview.conflicts)} 筆。`,
  );
  console.log(
    `明細：專案新增 ${preview.additions.projects ?? 0}、Session 新增 ${preview.additions.sessions ?? 0}、Knowledge 新增 ${preview.additions.knowledge ?? 0}。`,
  );
  for (const conflict of preview.conflictDetails) {
    console.log(`衝突：${conflict.table} ${conflict.id}：${conflict.reason}`);
  }
  if (preview.conflictDetailsTruncated) {
    console.log("衝突明細超過 100 筆，僅顯示前 100 筆。");
  }
}

async function confirmPortableImport(): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail("匯入前必須互動確認；非互動環境請加上 --dry-run，並在互動終端重新執行正式匯入。");
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question("新專案會以暫停狀態加入；確認合併匯入？輸入 yes 繼續：");
    return answer.trim().toLowerCase() === "yes";
  } finally {
    prompt.close();
  }
}

export interface DatabaseCliDependencies {
  withStore?: <T>(task: (store: WorkIntelligenceStore) => T) => T;
  invocationDirectory?: string;
  log?: (message: string) => void;
  error?: (message: string) => void;
  confirmPortableImport?: () => Promise<boolean>;
}

export async function runDatabaseCli(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: DatabaseCliDependencies = {},
): Promise<number> {
  // pnpm runs root scripts from the repo root; resolve paths against where the user ran the command.
  const invocationDirectory = dependencies.invocationDirectory ?? process.env.INIT_CWD ?? process.cwd();
  const fromInvocation = (path: string): string => resolve(invocationDirectory, path);
  const runWithStore = dependencies.withStore ?? withStore;
  const print = dependencies.log ?? ((message: string) => console.log(message));
  const printError = dependencies.error ?? ((message: string) => console.error(message));
  const confirmImport = dependencies.confirmPortableImport ?? confirmPortableImport;
  const [command, ...args] = argv;
  try {
    if (command === "backup") {
      const result = runWithStore((store) => store.createBackup());
      if (result.outcome !== "database_backups") {
        fail(result.reason);
      }
      print(`已備份：${result.created.fileName}（手動保留 ${result.keep} 份、自動保留 ${result.automaticKeep} 份）`);
    } else if (command === "export") {
      if (args[0] === "--all" || args[0] === "--project") {
        const scopeType = args[0] === "--all" ? "all" : "project";
        let projectValue: string | undefined = scopeType === "project" ? args[1] : undefined;
        let output: string | undefined;
        for (let index = scopeType === "project" ? 2 : 1; index < args.length; index += 1) {
          const arg = args[index];
          if (!arg) {
            fail("缺少 export 選項的值。");
          }
          if (arg === "--out") {
            index += 1;
            output = args[index];
          } else if (arg.startsWith("--out=")) {
            output = arg.slice("--out=".length);
          } else {
            fail(`看不懂的參數：${arg}`);
          }
        }
        if (scopeType === "project" && !projectValue) {
          fail("--project 需要專案名稱或 id。");
        }
        const result = runWithStore((store) => {
          const projectId =
            scopeType === "project"
              ? findProjectId(
                  store.listProjects().map(({ id, name }) => ({ id, name })),
                  projectValue ?? "",
                )
              : undefined;
          const scope = projectId ? { type: "project" as const, projectId } : { type: "all" as const };
          const bundle = store.exportProjectData(scope);
          const target = output
            ? fromInvocation(output)
            : defaultPortableFileName(scopeType, invocationDirectory, projectId);
          return { target, bytes: writePortableExport(target, bundle) };
        });
        print(`已匯出到 ${result.target}（${(result.bytes / 1024 / 1024).toFixed(1)} MiB）。JSON 未加密，請妥善保管。`);
      } else {
        const target = args[0] ? fromInvocation(args[0]) : fail("請指定匯出檔案的路徑。");
        const { bytes } = runWithStore((store) => store.exportTo(target));
        print(`已匯出到 ${target}（${(bytes / 1024 / 1024).toFixed(1)} MB）。這個檔案包含全部工作記錄，請妥善保管。`);
      }
    } else if (command === "import") {
      let source: string | undefined;
      let projectValue: string | undefined;
      let dryRun = false;
      const remap: ProjectPathRemap[] = [];
      for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (!arg) {
          fail("缺少 import 選項的值。");
        }
        if (arg === "--project") {
          index += 1;
          projectValue = args[index];
        } else if (arg.startsWith("--project=")) {
          projectValue = arg.slice("--project=".length);
        } else if (arg === "--remap-root") {
          index += 1;
          remap.push(parseRemap(args[index]));
        } else if (arg.startsWith("--remap-root=")) {
          remap.push(parseRemap(arg.slice("--remap-root=".length)));
        } else if (arg === "--dry-run") {
          dryRun = true;
        } else if (arg && !arg.startsWith("--") && !source) {
          source = fromInvocation(arg);
        } else {
          fail(`看不懂的參數：${arg}`);
        }
      }
      if (!source) {
        fail("請指定要匯入的 JSON 檔案。");
      }
      if (statSync(source).size > MAX_PROJECT_IMPORT_BYTES) {
        fail("匯入檔不可超過 50 MiB。");
      }
      const file = readFileSync(source);
      if (file.byteLength > MAX_PROJECT_IMPORT_BYTES) {
        fail("匯入檔不可超過 50 MiB。");
      }
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(file.toString("utf8"));
      } catch {
        fail("匯入檔不是有效的 JSON。");
      }
      const parsedBundle = projectDataExportSchema.safeParse(parsedJson);
      if (!parsedBundle.success) {
        fail(`匯入檔格式錯誤：${parsedBundle.error.issues[0]?.message ?? "欄位驗證失敗。"}`);
      }
      const bundle = parsedBundle.data as unknown as ProjectDataExport;
      const projectId = projectValue
        ? findProjectId(
            bundle.tables.projects.map((project) => ({ id: String(project.id), name: String(project.name) })),
            projectValue,
          )
        : undefined;
      const input: ProjectDataImportInput = {
        bundle,
        ...(projectId ? { projectId } : {}),
        ...(remap.length > 0 ? { remap } : {}),
      };
      const parsedInput = projectDataImportInputSchema.safeParse(input);
      if (!parsedInput.success) {
        fail(`匯入選項格式錯誤：${parsedInput.error.issues[0]?.message ?? "欄位驗證失敗。"}`);
      }
      const validatedInput = parsedInput.data as unknown as ProjectDataImportInput;
      const preview = runWithStore((store) => store.previewProjectDataImport(validatedInput));
      printImportPreview(preview);
      if (dryRun) {
        print("僅預覽，資料沒有變更。");
      } else if (await confirmImport()) {
        const result = runWithStore((store) => store.importProjectData(validatedInput));
        print(
          `匯入完成：新增 ${totalCounts(result.additions)} 筆，略過 ${totalCounts(result.skipped)} 筆，衝突 ${totalCounts(result.conflicts)} 筆。`,
        );
        print("新匯入的專案已暫停；確認專案路徑後，可在專案頁啟用記錄。");
      } else {
        print("已取消匯入，資料沒有變更。");
      }
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
        print(`已先備份原本的資料：${result.safetyBackup}`);
      }
      print(`已還原 ${result.projects} 個專案、${result.sessions} 筆 Session（schema 版本 ${result.schemaVersion}）。`);
      if (remap.length) {
        print(`已更新 ${result.remapped.projects} 個專案路徑、${result.remapped.handoffSnapshots} 個 handoff 路徑。`);
      }
      // Opening the store once applies any newer migrations before the server or an Agent uses it.
      runWithStore(() => undefined);
      print("完成。重新啟動 API server 與 Agent 對話即可使用。");
    } else {
      print(usage);
      return command ? 1 : 0;
    }
    return 0;
  } catch (error) {
    printError(`錯誤：${error instanceof Error ? error.message : String(error)}\n\n${usage}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runDatabaseCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
