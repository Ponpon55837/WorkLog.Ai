import console from "node:console";
import { Buffer } from "node:buffer";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const serverDist = join(repositoryRoot, "apps", "server", "dist");
const workerEntry = join(serverDist, "backup-worker.js");
if (!existsSync(workerEntry)) {
  throw new Error("The built backup worker is missing from apps/server/dist after runtime finalization.");
}

const [{ WorkIntelligenceStore }, { BackupWorkerClient }] = await Promise.all([
  import(pathToFileURL(join(repositoryRoot, "packages", "storage", "dist", "index.js")).href),
  import(pathToFileURL(join(serverDist, "backup-worker-client.js")).href),
]);
const root = mkdtempSync(join(tmpdir(), "work-intelligence-built-backup-worker-"));
const databasePath = join(root, "synthetic.sqlite");
const projectRoot = join(root, "synthetic-project");
mkdirSync(projectRoot);
const store = new WorkIntelligenceStore(databasePath);
const worker = new BackupWorkerClient(databasePath);

try {
  const project = store.addProject("Built worker fixture", projectRoot);
  store.updateProject(project.id, { status: "tracked" });
  const session = store.finalizeSession({
    projectRoot,
    idempotencyKey: "built-backup-worker-session",
    title: "Built worker Session",
    summary: "Synthetic data used by the built worker verification.",
    changedFiles: ["src/worker.ts"],
    verification: { status: "passed" },
    workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
  });
  if (session.outcome !== "finalized") throw new Error("Could not create the synthetic built-worker Session.");

  const backup = await worker.createBackup();
  if (backup.outcome !== "database_backups") throw new Error("The synthetic database was not backed up.");
  const exported = await worker.exportProjectData({ type: "all" });
  const bundle = JSON.parse(exported.content);
  if (bundle.tables.sessions.length !== 1 || exported.bytes !== Buffer.byteLength(exported.content)) {
    throw new Error("The built worker returned an incomplete project-data export.");
  }
  const preview = await worker.previewProjectDataImport({ bundle });
  if (preview.outcome !== "project_data_import_preview" || preview.skipped.sessions !== 1) {
    throw new Error("The built worker returned an unexpected project-data preview.");
  }
  const exportPath = join(root, "synthetic-export.sqlite");
  const wholeDatabase = await worker.exportTo(exportPath);
  if (wholeDatabase.bytes <= 0) throw new Error("The built worker returned an empty SQLite export.");
  const exportedDatabase = new DatabaseSync(exportPath, { readOnly: true });
  try {
    if (exportedDatabase.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") {
      throw new Error("The built SQLite export failed its integrity check.");
    }
  } finally {
    exportedDatabase.close();
  }
  console.log("Built backup worker passed synthetic backup, export, import-preview and SQLite integrity checks.");
} finally {
  try {
    await worker.close();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}
