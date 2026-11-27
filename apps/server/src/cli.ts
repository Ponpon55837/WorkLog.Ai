import { mkdirSync, rmSync, statSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  DatabaseBackup,
  DatabaseBackupKind,
  ProjectDataExportScope,
  ProjectDataImportInput,
  ProjectDataImportPreview,
  ProjectDataImportConflictCategory,
  ProjectDataImportStrategy,
  ProjectPathRemap,
} from "@work-intelligence/core";
import { PROJECT_DATA_IMPORT_STRATEGIES } from "@work-intelligence/core";
import {
  maintainDatabase,
  redactDatabase,
  canonicalizeProjectRoot,
  initializeWorkIntelligenceDatabase,
  ProjectDataImportSyntaxError,
  ProjectDataTransferError,
  readProjectDataImportFile,
  restoreDatabase,
  ValidatedProjectDataImport,
  WorkIntelligenceStore,
  type DatabaseMaintenanceResult,
  type DatabaseRedactionResult,
  type RestorePathRemap,
} from "@work-intelligence/storage";
import { commandName } from "@work-intelligence/shared";
import { STANDALONE } from "@work-intelligence/shared/database-location";
import { CLI_DASH_HELP, checkCliArgs, isHelpFlag, type CliOptionSpec, type ParsedCliArgs } from "./cli-args.js";
import { databasePath, repositoryRoot, storeOptions } from "./config.js";
import {
  diagnoseDatabaseInUse,
  isDatabaseInUseError,
  type DatabaseBusyDiagnosisDependencies,
} from "./database-busy-diagnosis.js";
import {
  MAX_PROJECT_IMPORT_BYTES,
  PROJECT_EXPORT_TOO_LARGE_MESSAGE,
  PROJECT_IMPORT_TOO_LARGE_MESSAGE,
} from "./http.js";
import { createTransferDirectory, removeTransferDirectory, transferRoot } from "./transfer-workspace.js";
import { runTrackCommand, type TrackCliDependencies } from "./track-cli.js";
import { defaultUsageScanContext, type UsageScanContext } from "./usage-scan.js";
import { runUsageCommand } from "./usage-cli.js";

const NO_PARSED_ARGS: ParsedCliArgs = { kind: "ok", flags: new Set(), values: new Map(), positionals: [] };
const COMMAND_SUMMARIES: readonly (readonly [script: string, summary: string])[] = [
  ["db:maintain", "備份後檢查、整理資料庫並重建搜尋索引"],
  ["db:redact [--dry-run]", "唯讀預覽既有資料的敏感資訊遮蔽數量"],
  ["db:redact --apply", "先備份，再遮蔽資料並標記搜尋索引待更新"],
  ["db:backup", "立即備份（存到資料庫旁的 backups/）"],
  ["db:backups", "列出備份與總大小"],
  ["db:backups --delete <檔名>", "確認後刪除一份備份"],
  ["db:export <檔案>", "把整份資料匯出成一個 .sqlite 檔，帶到別台電腦"],
  ["db:export --all [選項]", "匯出全部專案為可攜式 JSON（只加 --out 時等同 --all）"],
  ["db:export --project <名稱或 id> [選項]", "匯出單一專案為可攜式 JSON"],
  ["db:import <檔案> [選項]", "預覽後合併匯入可攜式 JSON"],
  ["db:restore <檔案> [選項]", "用匯出或備份的檔案取代目前的資料"],
  ["track <資料夾> [--name <名稱>] [--yes]", "預覽後把專案加入並設為記錄中"],
  ["usage [--project <名稱>] [--all] [--json] [--for-agent]", "統計本機 Agent 用量（只有次數與 token）"],
];

const EXPORT_OPTIONS_HELP = `export 選項：
  --out <檔案.json>                  指定可攜式 JSON 匯出檔路徑；沒有 --all／--project 時等同 --all
                                    （整份 SQLite 快照請用 db:export <檔案>）`;
const IMPORT_OPTIONS_HELP = `import 選項：
  --project <名稱或 id>              只匯入檔案中的單一專案；預設為全部
  --remap-root <舊路徑>=<新路徑>     換電腦時替換路徑前綴（可重複）；相同專案 ID 會自動沿用本機路徑
  --strategy <merge|newer-wins>     merge 只新增（預設）；newer-wins 同 ID 內容不同時以較新者覆寫，本機較新則保留
  --dry-run                         只顯示預覽，不寫入資料`;
const RESTORE_OPTIONS_HELP = `restore 選項：
  --remap-root <舊路徑>=<新路徑>     專案在新電腦的位置不同時，把路徑前綴換掉（可重複）`;
const OPTIONS_HELP: Readonly<Record<string, string>> = {
  export: EXPORT_OPTIONS_HELP,
  import: IMPORT_OPTIONS_HELP,
  restore: RESTORE_OPTIONS_HELP,
};

const COMMAND_OPTIONS: Readonly<Record<string, CliOptionSpec>> = {
  maintain: {},
  backup: {},
  backups: { valued: ["--delete"] },
  redact: { flags: ["--apply", "--dry-run"] },
  export: { flags: ["--all"], valued: ["--project", "--out"] },
  import: { flags: ["--dry-run"], valued: ["--project", "--remap-root", "--strategy"] },
  restore: { valued: ["--remap-root"] },
};

export function databaseUsage(standalone?: boolean, subcommand?: string): string {
  const commands = COMMAND_SUMMARIES.filter(
    ([script]) => !subcommand || script.split(" ")[0]?.replace(/^db:/, "") === subcommand,
  ).map(([script, summary]) => {
    const [name = script, ...rest] = script.split(" ");
    return [[commandName(name, standalone), ...rest].join(" "), summary] as const;
  });
  const width = Math.max(...commands.map(([command]) => command.length));
  const lines = `用法：
${commands.map(([command, summary]) => `  ${command.padEnd(width)}  ${summary}`).join("\n")}`;
  const restoreNote = `還原前請先停止 API server（${(standalone ?? STANDALONE) ? commandName("start", true) : "pnpm dev／pnpm start:server"}），並關閉會啟動 MCP 的 Codex／Claude 對話。
還原會先取得獨佔鎖、自動備份目前的資料，並將資料庫升級至本版 schema；回傳新的 revision，重新啟動 server 後前端會重新讀取資料。`;
  if (subcommand) {
    return [lines, OPTIONS_HELP[subcommand], subcommand === "restore" ? restoreNote : undefined, CLI_DASH_HELP]
      .filter(Boolean)
      .join("\n\n");
  }
  return `${lines}

${EXPORT_OPTIONS_HELP}

${IMPORT_OPTIONS_HELP}

${RESTORE_OPTIONS_HELP}

${restoreNote}

${CLI_DASH_HELP}`;
}

const backupKindLabels: Record<DatabaseBackupKind, string> = {
  automatic: "每日自動",
  manual: "手動",
  migration: "資料庫遷移前",
  deletion: "專案刪除前",
  session_deletion: "Session 刪除前",
  maintenance: "資料維護前",
  import: "專案資料匯入前",
};

function formatBackupSize(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? size : size.toFixed(1)} ${units[unit]}`;
}

function printBackupList(
  backups: DatabaseBackup[],
  keep: number,
  automaticKeep: number,
  print: (message: string) => void,
): void {
  print(`備份清單（自動保留 ${automaticKeep} 份、其他備份保留 ${keep} 份）：`);
  if (backups.length === 0) {
    print("目前沒有備份。");
  }
  for (const backup of backups) {
    print(
      `${backupKindLabels[backup.kind]} | ${backup.createdAt} | ${formatBackupSize(backup.bytes)} | ${backup.fileName}`,
    );
  }
  const totalBytes = backups.reduce((total, backup) => total + backup.bytes, 0);
  print(`總計 ${backups.length} 份，${formatBackupSize(totalBytes)}。`);
}

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

function writePortableExport(store: WorkIntelligenceStore, scope: ProjectDataExportScope, target: string): number {
  mkdirSync(resolve(target, ".."), { recursive: true, mode: 0o700 });
  const { bytes } = store.writeProjectDataExport(scope, target);
  if (bytes > MAX_PROJECT_IMPORT_BYTES) {
    rmSync(target, { force: true });
    fail(PROJECT_EXPORT_TOO_LARGE_MESSAGE);
  }
  return bytes;
}

function readPortableImport(source: string, directory: string): ValidatedProjectDataImport {
  if (statSync(source).size > MAX_PROJECT_IMPORT_BYTES) fail(PROJECT_IMPORT_TOO_LARGE_MESSAGE);
  try {
    return readProjectDataImportFile(source, { envelope: "bundle", spillPath: join(directory, "import.spill") });
  } catch (error) {
    if (error instanceof ProjectDataImportSyntaxError) {
      fail(error.kind === "invalid_json" ? "匯入檔不是有效的 JSON。" : error.message);
    }
    if (error instanceof ProjectDataTransferError) fail(error.message);
    throw error;
  }
}

const IMPORT_CONFLICT_CATEGORY_LABELS: Record<ProjectDataImportConflictCategory, string> = {
  path: "路徑",
  newer_content: "匯入資料較新",
  content: "內容不同",
  unique: "唯一識別值",
  dependency: "依賴連帶",
  missing_parent: "匯入檔缺少上層資料",
  deleted: "已在本機刪除",
};

function printImportPreview(
  preview: ProjectDataImportPreview,
  log: (message: string) => void = (message) => console.log(message),
): void {
  log(`匯入專案：${preview.selectedProjects.map((project) => project.name).join("、")}`);
  for (const project of preview.selectedProjects) {
    const status = isLocalProjectFolder(project.rootPath) ? "找到資料夾" : "這台電腦找不到資料夾";
    log(`位置：${project.name} | 匯出路徑 ${project.sourceRootPath} | 套用路徑 ${project.rootPath} | ${status}`);
  }
  log(
    `新增 ${totalCounts(preview.additions)} 筆、略過 ${totalCounts(preview.skipped)} 筆、衝突 ${totalCounts(preview.conflicts)} 筆。`,
  );
  log(
    `明細：專案新增 ${preview.additions.projects ?? 0}、Session 新增 ${preview.additions.sessions ?? 0}、Knowledge 新增 ${preview.additions.knowledge ?? 0}。`,
  );
  log(`合併策略：${preview.strategy === "newer-wins" ? "較新者優先" : "只新增"}`);
  log(
    `將以匯入資料更新 ${totalCounts(preview.updates)} 筆、保留本機較新 ${totalCounts(preview.keptLocal)} 筆、知識頁版本重新編號 ${totalCounts(preview.renumbered)} 筆。`,
  );
  for (const remap of preview.autoRemaps) {
    log(`自動沿用本機路徑：${remap.from} → ${remap.to}（handoff 路徑 ${remap.snapshots} 筆）`);
  }
  for (const group of preview.conflictGroups) {
    log(
      `衝突（${IMPORT_CONFLICT_CATEGORY_LABELS[group.category]}）：${group.table} ${group.count} 筆：${group.reason}（例：${group.sampleIds.join("、")}）`,
    );
  }
}

function isLocalProjectFolder(path: string): boolean {
  if (!isAbsolute(path) || path.includes("\0")) return false;
  try {
    return statSync(canonicalizeProjectRoot(path)).isDirectory();
  } catch {
    return false;
  }
}

async function promptImportProjectLocation(
  project: ProjectDataImportPreview["selectedProjects"][number],
): Promise<string> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await prompt.question(
      `找不到「${project.name}」的資料夾（${project.sourceRootPath}）。輸入新位置，直接按 Enter 略過：`,
    );
  } finally {
    prompt.close();
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

async function confirmBackupDeletion(backup: DatabaseBackup, isLastBackup: boolean): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail("刪除備份前必須互動確認；請在互動終端重新執行。");
  }
  console.log(`即將刪除備份：${backup.fileName}（${backupKindLabels[backup.kind]}）。`);
  if (isLastBackup) {
    console.log("警告：這是目前唯一列出的備份；刪除後將沒有可供還原的備份。");
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question("這會永久刪除備份檔。輸入 yes 確認：");
    return answer.trim().toLowerCase() === "yes";
  } finally {
    prompt.close();
  }
}

export interface DatabaseCliDependencies {
  withStore?: <T>(task: (store: WorkIntelligenceStore) => T) => T;
  runMaintenance?: () => DatabaseMaintenanceResult;
  runRedaction?: (apply: boolean) => DatabaseRedactionResult;
  invocationDirectory?: string;
  log?: (message: string) => void;
  error?: (message: string) => void;
  confirmPortableImport?: () => Promise<boolean>;
  chooseImportProjectLocation?: (project: ProjectDataImportPreview["selectedProjects"][number]) => Promise<string>;
  confirmBackupDeletion?: (backup: DatabaseBackup, isLastBackup: boolean) => Promise<boolean>;
  busyDiagnosis?: DatabaseBusyDiagnosisDependencies;
  track?: Pick<TrackCliDependencies, "isInteractive" | "confirm" | "port">;
  usage?: UsageScanContext;
  usageLocale?: "en" | "zh-TW";
  standalone?: boolean;
}

export async function runDatabaseCli(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: DatabaseCliDependencies = {},
): Promise<number> {
  // pnpm runs root scripts from the repo root, so a checkout resolves paths against INIT_CWD; a standalone command
  // runs where the user typed it and ignores an inherited INIT_CWD.
  const invocationDirectory =
    dependencies.invocationDirectory ?? (STANDALONE ? undefined : process.env.INIT_CWD) ?? process.cwd();
  const usage = databaseUsage(dependencies.standalone);
  const commandText = (script: string): string => commandName(script, dependencies.standalone);
  const fromInvocation = (path: string): string => resolve(invocationDirectory, path);
  const runWithStore = dependencies.withStore ?? withStore;
  const runMaintenance =
    dependencies.runMaintenance ?? (() => maintainDatabase({ databasePath, backup: storeOptions.backup }));
  const runRedaction =
    dependencies.runRedaction ??
    ((apply: boolean) => redactDatabase({ databasePath, apply, backup: storeOptions.backup }));
  const print = dependencies.log ?? ((message: string) => console.log(message));
  const printError = dependencies.error ?? ((message: string) => console.error(message));
  const confirmImport = dependencies.confirmPortableImport ?? confirmPortableImport;
  const chooseImportProjectLocation = dependencies.chooseImportProjectLocation ?? promptImportProjectLocation;
  const confirmDeleteBackup = dependencies.confirmBackupDeletion ?? confirmBackupDeletion;
  const [command, ...args] = argv;
  if (isHelpFlag(command)) {
    print(usage);
    return 0;
  }
  if (command === "track") {
    return runTrackCommand(args, {
      withStore: runWithStore,
      invocationDirectory,
      standalone: dependencies.standalone,
      log: print,
      error: printError,
      ...dependencies.track,
    });
  }
  if (command === "usage") {
    return runUsageCommand(args, {
      withStore: runWithStore,
      invocationDirectory,
      standalone: dependencies.standalone,
      log: print,
      error: printError,
      context: dependencies.usage ?? defaultUsageScanContext(dirname(databasePath)),
      ...(dependencies.usageLocale ? { locale: dependencies.usageLocale } : {}),
    });
  }
  const optionSpec = command ? COMMAND_OPTIONS[command] : undefined;
  let parsed = NO_PARSED_ARGS;
  if (command && optionSpec) {
    const check = checkCliArgs(args, optionSpec);
    if (check.kind === "help") {
      print(databaseUsage(dependencies.standalone, command));
      return 0;
    }
    if (check.kind === "error") {
      printError(`錯誤：${check.message}\n\n${databaseUsage(dependencies.standalone, command)}`);
      return 1;
    }
    parsed = check;
  }
  try {
    if (command === "maintain") {
      if (parsed.positionals.length > 0) {
        fail(`${commandText("db:maintain")} 不接受參數。`);
      }
      const result = runMaintenance();
      print(
        `維護完成：備份 ${result.backupFileName}；重新索引 ${result.indexedSessions} 筆 Session、${result.indexedKnowledge} 筆 Knowledge，共 ${result.indexedChunks} 個搜尋段落與 ${result.indexedPaths} 個路徑。`,
      );
      print("doctor 已記錄最近一次維護結果。");
    } else if (command === "redact") {
      if (parsed.positionals.length > 0 || (parsed.flags.has("--apply") && parsed.flags.has("--dry-run"))) {
        fail(
          `敏感資料整理只接受 \`${commandText("db:redact")} [--dry-run]\` 或 \`${commandText("db:redact")} --apply\`。`,
        );
      }
      const apply = parsed.flags.has("--apply");
      const result = runRedaction(apply);
      const counts = Object.entries(result.redactions.byKind)
        .filter((entry): entry is [string, number] => typeof entry[1] === "number")
        .map(([kind, count]) => `${kind} ${count}`)
        .join("、");
      print(
        `${apply ? "整理完成" : "唯讀預覽"}：涉及 ${result.affectedSessions} 筆 Session；各類型遮蔽數量：${counts || "0"}。`,
      );
      if (apply && result.backupFileName) {
        print(`整理前備份：${result.backupFileName}。舊備份與舊匯出仍可能保留原始文字，請在備份管理中檢視。`);
      }
    } else if (command === "backup") {
      if (parsed.positionals.length > 0) {
        fail(`${commandText("db:backup")} 不接受參數：${parsed.positionals[0]}`);
      }
      const result = runWithStore((store) => store.createBackup());
      if (result.outcome !== "database_backups") {
        fail(result.reason);
      }
      print(`已備份：${result.created.fileName}（手動保留 ${result.keep} 份、自動保留 ${result.automaticKeep} 份）`);
    } else if (command === "backups") {
      const deleteValues = parsed.values.get("--delete") ?? [];
      if (deleteValues.length === 0 && parsed.positionals.length === 0) {
        const result = runWithStore((store) => store.listBackups());
        if (result.outcome !== "database_backups") {
          fail(result.reason);
        }
        printBackupList(result.backups, result.keep, result.automaticKeep, print);
      } else if (deleteValues.length === 1 && parsed.positionals.length === 0 && deleteValues[0]) {
        const fileName = deleteValues[0];
        const list = runWithStore((store) => store.listBackups());
        if (list.outcome !== "database_backups") {
          fail(list.reason);
        }
        const backup = list.backups.find((entry) => entry.fileName === fileName);
        if (!backup) {
          fail("找不到這份備份。");
        }
        const isLastBackup = list.backups.length === 1;
        if (!(await confirmDeleteBackup(backup, isLastBackup))) {
          print("已取消刪除，備份仍保留。");
        } else {
          const result = runWithStore((store) => store.deleteBackup(fileName));
          if (result.outcome === "backup_deleted") {
            print(`已刪除：${result.deleted.fileName}（${backupKindLabels[result.deleted.kind]}）。`);
            printBackupList(result.backups, result.keep, result.automaticKeep, print);
          } else if (result.outcome === "backup_not_found") {
            fail("找不到這份備份。");
          } else if (result.outcome === "invalid_backup_file_name") {
            fail("備份檔名無效。");
          } else {
            fail(result.reason);
          }
        }
      } else {
        fail(`備份管理只接受 \`${commandText("db:backups")}\` 或 \`${commandText("db:backups")} --delete <檔名>\`。`);
      }
    } else if (command === "export") {
      const projectValues = parsed.values.get("--project") ?? [];
      const outputValues = parsed.values.get("--out") ?? [];
      const portable = parsed.flags.has("--all") || projectValues.length > 0 || outputValues.length > 0;
      if (portable) {
        if (parsed.positionals.length > 0) fail(`看不懂的參數：${parsed.positionals[0]}`);
        if (parsed.flags.has("--all") && projectValues.length > 0) fail("--all 與 --project 不能同時使用。");
        if (projectValues.length > 1 || outputValues.length > 1) fail("--project 與 --out 各只能指定一次。");
        const projectValue = projectValues[0];
        const output = outputValues[0];
        const scopeType = projectValue ? "project" : "all";
        const result = runWithStore((store) => {
          const projectId =
            scopeType === "project"
              ? findProjectId(
                  store.listProjects().map(({ id, name }) => ({ id, name })),
                  projectValue ?? "",
                )
              : undefined;
          const scope = projectId ? { type: "project" as const, projectId } : { type: "all" as const };
          const target = output
            ? fromInvocation(output)
            : defaultPortableFileName(scopeType, invocationDirectory, projectId);
          return { target, bytes: writePortableExport(store, scope, target) };
        });
        print(`已匯出到 ${result.target}（${(result.bytes / 1024 / 1024).toFixed(1)} MiB）。JSON 未加密，請妥善保管。`);
      } else {
        if (parsed.positionals.length === 0) fail("請指定匯出檔案的路徑。");
        if (parsed.positionals.length > 1) fail(`看不懂的參數：${parsed.positionals[1]}`);
        const target = fromInvocation(parsed.positionals[0] ?? "");
        const { bytes } = runWithStore((store) => store.exportTo(target));
        print(`已匯出到 ${target}（${(bytes / 1024 / 1024).toFixed(1)} MB）。這個檔案包含全部工作記錄，請妥善保管。`);
      }
    } else if (command === "import") {
      if (parsed.positionals.length > 1) fail(`看不懂的參數：${parsed.positionals[1]}`);
      const projectValues = parsed.values.get("--project") ?? [];
      const strategyValues = parsed.values.get("--strategy") ?? [];
      if (projectValues.length > 1 || strategyValues.length > 1) fail("--project 與 --strategy 各只能指定一次。");
      const projectValue = projectValues[0];
      const dryRun = parsed.flags.has("--dry-run");
      const strategy = strategyValues[0] as ProjectDataImportStrategy | undefined;
      if (strategy && !PROJECT_DATA_IMPORT_STRATEGIES.includes(strategy)) {
        fail("--strategy 只接受 merge 或 newer-wins。");
      }
      const remap: ProjectPathRemap[] = (parsed.values.get("--remap-root") ?? []).map((value) => parseRemap(value));
      const source = parsed.positionals[0] ? fromInvocation(parsed.positionals[0]) : undefined;
      if (!source) {
        fail("請指定要匯入的 JSON 檔案。");
      }
      const directory = createTransferDirectory(transferRoot(databasePath), "import");
      try {
        let validatedInput = readPortableImport(source, directory);
        try {
          const bundle = validatedInput.input.bundle;
          const projectId = projectValue
            ? findProjectId(
                bundle.tables.projects.map((project) => ({ id: String(project.id), name: String(project.name) })),
                projectValue,
              )
            : undefined;
          const withOptions = (options: Omit<ProjectDataImportInput, "bundle">): ValidatedProjectDataImport => {
            try {
              return validatedInput.withOptions(options);
            } catch (error) {
              if (!(error instanceof ProjectDataTransferError)) throw error;
              fail(error.message);
            }
          };
          validatedInput = withOptions({
            ...(projectId ? { projectId } : {}),
            ...(remap.length > 0 ? { remap } : {}),
            ...(strategy ? { strategy } : {}),
          });
          let preview = runWithStore((store) => store.previewProjectDataImport(validatedInput));
          const canAskForLocations =
            Boolean(dependencies.chooseImportProjectLocation) || (process.stdin.isTTY && process.stdout.isTTY);
          if (!dryRun && canAskForLocations) {
            for (const project of preview.selectedProjects) {
              if (isLocalProjectFolder(project.rootPath)) continue;
              const selectedRoot = (await chooseImportProjectLocation(project)).trim();
              if (!selectedRoot) continue;
              if (!isLocalProjectFolder(selectedRoot)) {
                print(`略過「${project.name}」：選擇的位置不是可用資料夾。`);
                continue;
              }
              const current = validatedInput.input;
              const remapsBySource = new Map((current.remap ?? []).map((mapping) => [mapping.from, mapping]));
              remapsBySource.set(project.rootPath, { from: project.rootPath, to: selectedRoot });
              validatedInput = withOptions({
                ...(current.projectId ? { projectId: current.projectId } : {}),
                remap: [...remapsBySource.values()],
                ...(current.strategy ? { strategy: current.strategy } : {}),
              });
              preview = runWithStore((store) => store.previewProjectDataImport(validatedInput));
            }
          }
          printImportPreview(preview, print);
          if (dryRun) {
            print("僅預覽，資料沒有變更。");
          } else if (await confirmImport()) {
            const result = runWithStore((store) => store.importProjectData(validatedInput));
            print(
              `匯入完成：新增 ${totalCounts(result.additions)} 筆，更新 ${totalCounts(result.updates)} 筆，保留本機 ${totalCounts(result.keptLocal)} 筆，略過 ${totalCounts(result.skipped)} 筆，衝突 ${totalCounts(result.conflicts)} 筆。`,
            );
            if (result.backupFileName) print(`匯入前的資料已備份為 ${result.backupFileName}。`);
            if (result.changed) {
              print("新匯入的專案已暫停；確認專案路徑後，可在專案頁啟用記錄。");
            } else {
              print("檔案中的資料這裡都已經有了，資料沒有變更，也沒有建立備份。");
            }
          } else {
            print("已取消匯入，資料沒有變更。");
          }
        } finally {
          // Every copy made with withOptions shares one spill file, so disposing the last one closes it.
          validatedInput.dispose();
        }
      } finally {
        removeTransferDirectory(directory);
      }
    } else if (command === "restore") {
      if (parsed.positionals.length > 1) fail(`看不懂的參數：${parsed.positionals[1]}`);
      const remap: RestorePathRemap[] = (parsed.values.get("--remap-root") ?? []).map((value) => parseRemap(value));
      const source = parsed.positionals[0] ? fromInvocation(parsed.positionals[0]) : undefined;
      if (!source) {
        fail("請指定要還原的檔案。");
      }
      const result = restoreDatabase({
        source,
        databasePath,
        remap,
        initializeStaging: (database) => initializeWorkIntelligenceDatabase(database, ":memory:"),
        backupDirectory: storeOptions.backup?.directory,
      });
      if (result.safetyBackup) {
        print(`已先備份原本的資料：${result.safetyBackup}`);
      }
      print(`已還原 ${result.projects} 個專案、${result.sessions} 筆 Session（schema 版本 ${result.schemaVersion}）。`);
      if (remap.length) {
        print(`已更新 ${result.remapped.projects} 個專案路徑、${result.remapped.handoffSnapshots} 個 handoff 路徑。`);
      }
      // Applies newer migrations and re-indexes the restored documents now, before the server or an Agent opens it.
      runWithStore((store) => store.syncSearchIndex());
      print("完成。重新啟動 API server 與 Agent 對話即可使用。");
    } else if (command) {
      printError(`錯誤：未知的指令：${command}\n\n${usage}`);
      return 1;
    } else {
      print(usage);
      return 0;
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let diagnosis: string[] = [];
    if ((command === "maintain" || command === "redact") && isDatabaseInUseError(error)) {
      try {
        diagnosis = await diagnoseDatabaseInUse(repositoryRoot, dependencies.busyDiagnosis);
      } catch {
        // The diagnosis is advisory; never hide the original error.
      }
    }
    printError(`錯誤：${message}${diagnosis.length > 0 ? `\n${diagnosis.join("\n")}` : ""}\n\n${usage}`);
    return 1;
  }
}

// A standalone bundle is started through its bin, which calls runDatabaseCli itself.
if (!STANDALONE && process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runDatabaseCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
