import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { WorkIntelligenceStore } from "../packages/storage/dist/index.js";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixturePath = join(repositoryRoot, "tests", "fixtures", "recall-eval-example.json");
const temporaryRoot = mkdtempSync(join(tmpdir(), "wi-recall-eval-smoke-"));
const databasePath = join(temporaryRoot, "synthetic.sqlite");
const projectRoot = join(temporaryRoot, "synthetic-project");
const questionsPath = join(temporaryRoot, "questions.json");
const reportPath = join(temporaryRoot, "report.json");
const hardLinkPath = join(temporaryRoot, "database-hardlink.sqlite");
const evaluatorPath = join(repositoryRoot, "apps", "mcp", "dist", "eval-recall.js");
const protectedOutputPaths = [
  databasePath,
  hardLinkPath,
  questionsPath,
  `${databasePath}-wal`,
  `${databasePath}-shm`,
  `${databasePath}-journal`,
];
const runEvaluator = (args) =>
  spawnSync(process.execPath, ["--experimental-sqlite", evaluatorPath, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: process.env,
  });

let store;

try {
  mkdirSync(projectRoot);
  store = new WorkIntelligenceStore(databasePath);
  const project = store.addProject("Synthetic recall evaluation", projectRoot);
  store.updateProject(project.id, { status: "tracked" });
  const session = store.finalizeSession({
    projectRoot,
    idempotencyKey: "recall-eval-smoke-session",
    title: "Aurora moss relay calibration",
    summary: "Validated the aurora moss irrigation relay startup calibration after a cold restart.",
    workSummary: {
      outcomes: ["Verified stable startup calibration."],
      scope: ["src/relay.ts"],
      decisions: [],
      verification: ["Synthetic relay restart passed."],
      nextSteps: [],
    },
    changedFiles: ["src/relay.ts"],
    verification: { status: "passed" },
  });
  if (session.outcome !== "finalized") throw new Error("Could not seed the synthetic Session.");

  const knowledge = store.recordKnowledge({
    projectRoot,
    idempotencyKey: "recall-eval-smoke-knowledge",
    kind: "gotcha",
    title: "Aurora moss relay restart drift",
    body: "After restart, verify the aurora moss relay before repeating calibration.",
  });
  if (knowledge.outcome !== "knowledge_recorded") throw new Error("Could not seed synthetic Knowledge.");
  store.close();
  store = undefined;
  linkSync(databasePath, hardLinkPath);

  const questions = JSON.parse(readFileSync(fixturePath, "utf8"));
  for (const question of questions.questions) {
    if (question.projectRoot === "__PROJECT_ROOT__") question.projectRoot = projectRoot;
    if (Array.isArray(question.expectedIds)) {
      question.expectedIds = question.expectedIds.map((expectedId) => {
        if (expectedId === "__SESSION_ID__") return session.session.id;
        if (expectedId === "__KNOWLEDGE_ID__") return knowledge.knowledge.id;
        return expectedId;
      });
    }
  }
  writeFileSync(questionsPath, `${JSON.stringify(questions)}\n`, { encoding: "utf8", mode: 0o600 });
  writeFileSync(reportPath, "an existing report must remain unchanged\n", { encoding: "utf8", mode: 0o600 });
  const existingReport = readFileSync(reportPath);
  const existingOutputAttempt = runEvaluator([questionsPath, "--db", databasePath, "--out", reportPath]);
  if (existingOutputAttempt.error) throw existingOutputAttempt.error;
  if (existingOutputAttempt.status === 0 || !readFileSync(reportPath).equals(existingReport)) {
    throw new Error("The CLI must refuse to overwrite an existing --out file.");
  }
  rmSync(reportPath);

  const missingDatabaseParent = join(temporaryRoot, "missing-database-parent");
  const missingDatabasePath = join(missingDatabaseParent, "not-created.sqlite");
  mkdirSync(missingDatabaseParent);
  const missingDatabaseAttempt = runEvaluator([questionsPath, "--db", missingDatabasePath]);
  if (missingDatabaseAttempt.error) throw missingDatabaseAttempt.error;
  if (
    missingDatabaseAttempt.status === 0 ||
    existsSync(missingDatabasePath) ||
    readdirSync(missingDatabaseParent).length !== 0
  ) {
    throw new Error("The CLI must reject a missing database without creating it or its parent directory.");
  }

  const evaluation = runEvaluator([questionsPath, "--db", databasePath, "--out", reportPath]);
  if (evaluation.stdout) process.stdout.write(evaluation.stdout);
  if (evaluation.stderr) process.stderr.write(evaluation.stderr);
  if (evaluation.error) throw evaluation.error;
  if (evaluation.status !== 0)
    throw new Error(`Recall evaluation CLI exited with ${evaluation.status ?? "no status"}.`);

  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  if (!report.passed || report.questionCount !== 4) throw new Error("The synthetic recall evaluation did not pass.");
  const positiveQuestions = report.questions.filter((question) => !question.expectedNoHit);
  if (
    positiveQuestions.length !== 2 ||
    positiveQuestions.some(
      (question) => question.hitAt1 !== true || question.hitAt5 !== true || question.reciprocalRank !== 1,
    )
  ) {
    throw new Error("The synthetic recall evaluation must keep both positive examples at rank 1.");
  }
  for (const mode of ["recall", "context"]) {
    const metrics = report.metrics[mode];
    if (metrics.hitAt1.rate !== 1 || metrics.hitAt5.rate !== 1 || metrics.mrr !== 1) {
      throw new Error(`The synthetic ${mode} quality gate failed.`);
    }
  }

  const falsePositiveQuestions = {
    version: 1,
    questions: [
      {
        id: "synthetic-false-positive-no-hit",
        mode: "recall",
        query: "aurora moss relay",
        projectRoot,
        expectedNoHit: true,
      },
    ],
  };
  writeFileSync(questionsPath, `${JSON.stringify(falsePositiveQuestions)}\n`, { encoding: "utf8", mode: 0o600 });
  const falsePositiveReportPath = join(temporaryRoot, "false-positive-report.json");
  const falsePositiveAttempt = runEvaluator([questionsPath, "--db", databasePath, "--out", falsePositiveReportPath]);
  if (falsePositiveAttempt.error) throw falsePositiveAttempt.error;
  if (falsePositiveAttempt.status === 0 || !existsSync(falsePositiveReportPath)) {
    throw new Error("A high-confidence result marked as expected no-hit must make the CLI fail.");
  }
  const falsePositiveReport = JSON.parse(readFileSync(falsePositiveReportPath, "utf8"));
  if (
    falsePositiveReport.passed ||
    falsePositiveReport.expectedNoHitWithHighConfidence.length !== 1 ||
    falsePositiveReport.questions[0]?.confidence !== "high" ||
    falsePositiveReport.questions[0]?.passed !== false
  ) {
    throw new Error("The CLI must report the high-confidence expected no-hit false positive.");
  }

  for (const protectedPath of protectedOutputPaths) {
    const existedBefore = existsSync(protectedPath);
    const bytesBefore = existedBefore ? readFileSync(protectedPath) : undefined;
    const protectedAttempt = runEvaluator([questionsPath, "--db", databasePath, "--out", protectedPath]);
    if (protectedAttempt.status === 0) throw new Error(`The CLI accepted protected output path ${protectedPath}.`);
    if (existsSync(protectedPath) !== existedBefore)
      throw new Error(`The CLI changed protected output path ${protectedPath}.`);
    if (bytesBefore && !readFileSync(protectedPath).equals(bytesBefore)) {
      throw new Error(`The CLI modified protected output path ${protectedPath}.`);
    }
  }
  process.stdout.write(`${JSON.stringify(report.metrics, null, 2)}\n`);
} finally {
  try {
    store?.close();
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
