import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ZodError } from "zod";
import { evaluateRecallQuestions, parseRecallEvaluationQuestions } from "./recall-evaluation.js";

interface CliOptions {
  questionPath: string;
  databasePath?: string;
  outputPath?: string;
  help: boolean;
}

const USAGE = `用法：
  pnpm eval:recall <題目.json> [--db <資料庫.sqlite>] [--out <結果.json>]

題目須逐題指定 mode: recall 或 context、query、expectedIds 或 expectedNoHit；可指定 projectRoot、recall 日期範圍、paths 與 expectedConfidence。
資料庫來源以 SQLite 唯讀連線複製到 OS 暫存目錄，再透過 MCP in-memory transport 評估；結果不回寫資料庫、不上傳。`;
const MAX_QUESTION_FILE_BYTES = 1_000_000;

function parseArguments(args: string[]): CliOptions {
  let questionPath: string | undefined;
  let databasePath: string | undefined;
  let outputPath: string | undefined;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === undefined) continue;
    if (value === "--help" || value === "-h") {
      help = true;
      continue;
    }
    if (value === "--db" || value === "--out") {
      const argument = args[index + 1];
      if (!argument || argument.startsWith("--")) throw new Error(`${value} 後面需要檔案路徑。`);
      if (value === "--db") databasePath = argument;
      else outputPath = argument;
      index += 1;
      continue;
    }
    if (value.startsWith("-")) throw new Error(`不支援的選項：${value}`);
    if (questionPath) throw new Error("只能指定一個題目 JSON 檔案。");
    questionPath = value;
  }
  if (!help && !questionPath) throw new Error(USAGE);
  return { questionPath: questionPath ?? "", databasePath, outputPath, help };
}

function canonicalPath(path: string): string {
  const absolutePath = resolve(path);
  try {
    return realpathSync(absolutePath);
  } catch {
    const canonicalParent = realpathSync(dirname(absolutePath));
    return resolve(canonicalParent, basename(absolutePath));
  }
}

function refersToSameFile(left: string, right: string): boolean {
  const canonicalLeft = canonicalPath(left);
  const canonicalRight = canonicalPath(right);
  if (canonicalLeft === canonicalRight) return true;
  try {
    const leftStat = statSync(canonicalLeft);
    const rightStat = statSync(canonicalRight);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  }
}

function assertFileInput(path: string, label: string): string {
  const canonical = realpathSync(resolve(path));
  if (!statSync(canonical).isFile()) throw new Error(`${label} 必須是檔案。`);
  return canonical;
}

function assertOutputIsSeparate(outputPath: string, questionPath: string, databasePath: string): string {
  const canonicalOutput = canonicalPath(outputPath);
  if (refersToSameFile(canonicalOutput, questionPath)) throw new Error("--out 不可覆寫題目檔案。");
  const databasePaths = ["", "-wal", "-shm", "-journal"].map((suffix) =>
    suffix ? `${databasePath}${suffix}` : databasePath,
  );
  if (databasePaths.some((path) => refersToSameFile(canonicalOutput, path))) {
    throw new Error("--out 不可覆寫 SQLite 資料庫或其 WAL／SHM／journal sidecar。");
  }
  if (existsSync(canonicalOutput)) {
    if (!statSync(canonicalOutput).isFile()) throw new Error("--out 必須指向檔案。");
    throw new Error("--out 目標已存在，不會覆寫；請指定新檔案路徑。");
  }
  return canonicalOutput;
}

function describeValidationError(error: unknown): string {
  if (!(error instanceof ZodError)) return error instanceof Error ? error.message : "題目檔格式無效。";
  return error.issues.map((issue) => `${issue.path.join(".") || "questions"}: ${issue.message}`).join("\n");
}

async function main(): Promise<void> {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log(USAGE);
      return;
    }
    const invocationDirectory = resolve(process.env.INIT_CWD ?? process.cwd());
    const questionPath = assertFileInput(resolve(invocationDirectory, options.questionPath), "題目 JSON");
    if (statSync(questionPath).size > MAX_QUESTION_FILE_BYTES) {
      throw new Error(`題目 JSON 不可超過 ${MAX_QUESTION_FILE_BYTES} bytes。`);
    }
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const defaultDatabasePath = join(resolve(appRoot, "../.."), "data", "work-intelligence.sqlite");
    const requestedDatabasePath = options.databasePath
      ? resolve(invocationDirectory, options.databasePath)
      : process.env.WORK_INTELLIGENCE_DB
        ? resolve(invocationDirectory, process.env.WORK_INTELLIGENCE_DB)
        : defaultDatabasePath;
    const databasePath = assertFileInput(requestedDatabasePath, "SQLite 資料庫");
    if (refersToSameFile(questionPath, databasePath)) throw new Error("題目檔不可指向 SQLite 資料庫。");
    const outputPath = options.outputPath
      ? assertOutputIsSeparate(resolve(invocationDirectory, options.outputPath), questionPath, databasePath)
      : undefined;

    let parsedInput: unknown;
    try {
      parsedInput = JSON.parse(readFileSync(questionPath, "utf8")) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("題目檔不是有效的 JSON。", { cause: error });
      throw error;
    }
    let questions;
    try {
      questions = parseRecallEvaluationQuestions(parsedInput);
    } catch (error) {
      throw new Error(`題目檔格式無效：\n${describeValidationError(error)}`, { cause: error });
    }

    const report = await evaluateRecallQuestions(databasePath, questions);
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (outputPath) {
      try {
        writeFileSync(outputPath, output, { encoding: "utf8", flag: "wx", mode: 0o600 });
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
          throw new Error("--out 目標已存在，不會覆寫；請指定新檔案路徑。", { cause: error });
        }
        throw error;
      }
      console.log(`檢索評估結果已寫入：${outputPath}`);
    } else {
      process.stdout.write(output);
    }
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "檢索評估失敗。");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main();
}
