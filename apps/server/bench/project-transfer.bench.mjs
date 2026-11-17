// Memory and time of the streamed portable import, preview and export, by file size.
//
// Usage (reads the built packages, so build first):
//   pnpm build
//   node apps/server/bench/project-transfer.bench.mjs [--check] [--sizes=10,40,100]
//
// Each operation runs in a fresh process with the desktop backend's heap flags, through the same functions the
// background worker calls (apps/server/dist/http.js and the storage package), and reports its peak RSS
// (process.resourceUsage().maxRSS, which Linux, macOS and Windows all report). The data is synthetic: one project
// whose Sessions each carry a long summary and 13 work events, about 8.3 KiB per Session.
//
// --check fails the run when peak RSS grows with the file instead of staying bounded: the largest size may use at most
// RSS_GROWTH_LIMIT_MIB more than the smallest, and no run may pass RSS_LIMIT_MIB. Before 1.6.48 the whole file was
// parsed, so peak RSS grew about 2.2 times the file size (75 to 245 MiB for 17.5 MiB).
import console from "node:console";
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const scriptPath = fileURLToPath(import.meta.url);
const BACKEND_FLAGS = ["--max-old-space-size=1024", "--max-semi-space-size=2"];
/** Synthetic Sessions per MiB of export file (2,120 Sessions make 17.5 MiB). */
const SESSIONS_PER_MIB = 2120 / 17.5;
/** Peak RSS may grow at most this much from the smallest to the largest file; the rows the planner keeps grow too. */
const RSS_GROWTH_LIMIT_MIB = Number(process.env.WI_TRANSFER_RSS_GROWTH_MIB ?? 160);
/** No single run may pass this peak RSS (the backend's heap is 1 GiB). */
const RSS_LIMIT_MIB = Number(process.env.WI_TRANSFER_RSS_LIMIT_MIB ?? 400);

const dist = (...parts) => pathToFileURL(join(repositoryRoot, ...parts)).href;

/** Runs one operation in this (child) process and prints its time and peak RSS. */
async function runOperation(operation, databasePath, file, directory) {
  const { LATEST_SCHEMA_VERSION, WorkIntelligenceStore } = await import(
    dist("packages", "storage", "dist", "index.js")
  );
  const { importProjectDataUpload, previewProjectDataImportUpload } = await import(
    dist("apps", "server", "dist", "http.js")
  );
  const rss0 = process.memoryUsage().rss;
  // Opened as the background worker opens them: read-only for preview and export, existing (no migration) to import.
  const store = new WorkIntelligenceStore(databasePath, {
    mode: operation === "import" ? "existing" : "read-only",
    expectedSchemaVersion: LATEST_SCHEMA_VERSION,
  });
  const start = performance.now();
  let summary;
  if (operation === "export") {
    summary = { bytes: store.writeProjectDataExport({ type: "all" }, file).bytes };
  } else {
    const upload = { path: file, directory };
    const result =
      operation === "preview" ? previewProjectDataImportUpload(store, upload) : importProjectDataUpload(store, upload);
    summary = { sessions: result.additions.sessions };
  }
  const ms = performance.now() - start;
  store.close();
  process.stdout.write(
    JSON.stringify({ ms, rss0Mib: rss0 / 1048576, maxRssMib: process.resourceUsage().maxRSS / 1024, ...summary }),
  );
}

function runChild(operation, databasePath, file, directory) {
  const result = spawnSync(
    process.execPath,
    [...BACKEND_FLAGS, "--no-warnings", scriptPath, "--child", operation, databasePath, file, directory],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(`The ${operation} run failed:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

/** A synthetic export of `sessionCount` Sessions, from rows inserted directly after one finalized template. */
async function writeSyntheticExport(root, sessionCount, target) {
  const { WorkIntelligenceStore } = await import(dist("packages", "storage", "dist", "index.js"));
  const databasePath = join(root, "source.sqlite");
  const projectRoot = join(root, "synthetic-project");
  mkdirSync(projectRoot);
  const seed = new WorkIntelligenceStore(databasePath);
  const project = seed.addProject("Transfer benchmark fixture", projectRoot);
  seed.updateProject(project.id, { status: "tracked" });
  seed.finalizeSession({
    projectRoot,
    idempotencyKey: "template",
    title: "Synthetic template",
    summary: "Synthetic Session text. ".repeat(40),
    changedFiles: ["src/a.ts", "src/b.ts"],
    verification: { status: "passed" },
    workSummary: { outcomes: ["Synthetic outcome"], scope: [], decisions: [], verification: [], nextSteps: [] },
  });
  seed.close();
  const db = new DatabaseSync(databasePath);
  const session = db.prepare("SELECT * FROM sessions WHERE idempotency_key = 'template'").get();
  const events = db.prepare("SELECT * FROM work_events WHERE session_id = ?").all(session.id);
  const statements = new Map();
  const insert = (table, row) => {
    const key = `${table}:${Object.keys(row).join(",")}`;
    let statement = statements.get(key);
    if (!statement) {
      const columns = Object.keys(row);
      statement = db.prepare(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      );
      statements.set(key, statement);
    }
    statement.run(...Object.values(row));
  };
  db.exec("BEGIN");
  for (let index = 0; index < sessionCount; index += 1) {
    const id = `synthetic-session-${index}`;
    insert("sessions", {
      ...session,
      id,
      idempotency_key: id,
      title: `Synthetic Session ${index}`,
      summary: `Synthetic summary ${index}. ${"Generated text for the memory benchmark. ".repeat(60)}`,
      completed_at: new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * 60_000).toISOString(),
    });
    for (const [eventIndex, event] of events.entries()) {
      insert("work_events", { ...event, id: `${id}-event-${eventIndex}`, session_id: id });
    }
    for (let extra = 0; extra < 12; extra += 1) {
      insert("work_events", {
        ...events[0],
        id: `${id}-extra-${extra}`,
        session_id: id,
        summary: `Synthetic event ${extra} of ${index}. ${"event text ".repeat(20)}`,
      });
    }
  }
  db.exec("COMMIT");
  db.close();
  const source = new WorkIntelligenceStore(databasePath);
  source.writeProjectDataExport({ type: "all" }, target);
  source.close();
  rmSync(databasePath, { force: true });
}

function writeRequest(bundleFile, target) {
  const fd = openSync(target, "wx", 0o600);
  try {
    writeSync(fd, '{"bundle":');
    writeSync(fd, readFileSync(bundleFile));
    writeSync(fd, "}");
  } finally {
    closeSync(fd);
  }
}

async function emptyDatabase(path) {
  const { WorkIntelligenceStore } = await import(dist("packages", "storage", "dist", "index.js"));
  new WorkIntelligenceStore(path).close();
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--child") {
    await runOperation(args[1], args[2], args[3], args[4]);
    return;
  }
  const check = args.includes("--check");
  const sizesArgument = args.find((argument) => argument.startsWith("--sizes="));
  const sizes = (sizesArgument?.slice("--sizes=".length) ?? "10,40,100").split(",").map(Number);
  if (sizes.some((size) => !Number.isFinite(size) || size <= 0)) throw new Error("--sizes takes positive MiB values.");
  const results = [];
  for (const size of sizes) {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-transfer-bench-"));
    try {
      const bundleFile = join(root, "export.json");
      await writeSyntheticExport(root, Math.round(size * SESSIONS_PER_MIB), bundleFile);
      const fileMib = statSync(bundleFile).size / 1048576;
      const databasePath = join(root, "destination.sqlite");
      await emptyDatabase(databasePath);
      const request = () => {
        const directory = mkdtempSync(join(root, "import-"));
        const path = join(directory, "import.json");
        writeRequest(bundleFile, path);
        return { path, directory };
      };
      const preview = request();
      const previewRun = runChild("preview", databasePath, preview.path, preview.directory);
      const imported = request();
      const importRun = runChild("import", databasePath, imported.path, imported.directory);
      const exportDirectory = mkdtempSync(join(root, "export-"));
      const exportRun = runChild("export", databasePath, join(exportDirectory, "export.json"), exportDirectory);
      const row = { fileMib, preview: previewRun, import: importRun, export: exportRun };
      results.push(row);
      console.log(
        `${fileMib.toFixed(1).padStart(6)} MiB  ` +
          ["preview", "import", "export"]
            .map((name) => `${name} ${row[name].ms.toFixed(0)} ms, peak RSS ${row[name].maxRssMib.toFixed(0)} MiB`)
            .join("  |  "),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  if (!check) return;
  const failures = [];
  const peak = (row) => Math.max(row.preview.maxRssMib, row.import.maxRssMib, row.export.maxRssMib);
  for (const row of results) {
    if (peak(row) > RSS_LIMIT_MIB) {
      failures.push(`${row.fileMib.toFixed(1)} MiB peaked at ${peak(row).toFixed(0)} MiB (limit ${RSS_LIMIT_MIB}).`);
    }
  }
  const growth = peak(results.at(-1)) - peak(results[0]);
  if (growth > RSS_GROWTH_LIMIT_MIB) {
    failures.push(`Peak RSS grew ${growth.toFixed(0)} MiB across the sizes (limit ${RSS_GROWTH_LIMIT_MIB}).`);
  }
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(
      `Streamed transfer memory stayed bounded: ${growth.toFixed(0)} MiB growth, limit ${RSS_GROWTH_LIMIT_MIB}.`,
    );
  }
}

await main();
