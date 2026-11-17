// Memory benchmark for a large project-data export and import through the real built API server.
//
// Usage:
//   pnpm --filter @work-intelligence/server... build
//   node packages/storage/bench/export-import-memory.bench.mjs [runs=3] [--sessions=N] [--idle=10] [--json]
//
// Each run starts the server twice with the desktop backend's Node flags, on synthetic data only:
//   export server: a database of generated Sessions and events; it reports the RSS (the whole process, the backup
//                  worker thread included) at baseline, the peak while exporting, and idle after the export.
//   import server: an empty database; it imports the file the export produced and reports the same, plus the import.
// RSS comes from /proc/<pid>/status (VmRSS, RssAnon) on Linux and `ps -o rss=` elsewhere; the peak is sampled every
// 25 ms, so it is a lower bound. Prints the median of the runs. The default size gives a project-data file of about
// 45 MiB, close to the 50 MiB the API accepts.
import { Buffer } from "node:buffer";
import console from "node:console";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { clearInterval, setInterval } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { performance } from "node:perf_hooks";

const { fetch } = globalThis;
const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const found = args.find((argument) => argument.startsWith(`--${name}=`));
  return found ? Number(found.split("=")[1]) : fallback;
};
const runs = Number(args.find((argument) => /^\d+$/.test(argument)) ?? 3);
const sessionCount = option("sessions", 4_000);
const idleSeconds = option("idle", 10);
// --heap: the main thread's own heapUsed/external/arrayBuffers, asked of the server with SIGUSR2 (POSIX only).
// --server-env=NAME=VALUE,...: extra environment for the server (to compare allocator settings, for example).
const serverEnvironment = Object.fromEntries(
  (args.find((argument) => argument.startsWith("--server-env="))?.slice("--server-env=".length) ?? "")
    .split(",")
    .filter(Boolean)
    .map((pair) => pair.split("=")),
);
// --save-db=PATH: keeps a copy of the seeded database for other tools (a heap profile, smaps).
const savedDatabase = args.find((argument) => argument.startsWith("--save-db="))?.slice("--save-db=".length);
const heapMode = args.includes("--heap") && process.platform !== "win32";
const MIB = 1024 * 1024;
const SAMPLE_MS = 25;
// What the desktop App gives its backend (packages/desktop-core/src/backend/node-dependencies.ts).
const NODE_FLAGS = ["--max-old-space-size=1024", "--max-semi-space-size=2"];

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function readHeap(directory, pid) {
  if (!heapMode) return undefined;
  const file = join(directory, "heap.json");
  rmSync(file, { force: true });
  process.kill(pid, "SIGUSR2");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const { heapUsed, external, arrayBuffers } = JSON.parse(readFileSync(file, "utf8"));
      return { heapUsed: heapUsed / MIB, external: external / MIB, arrayBuffers: arrayBuffers / MIB };
    } catch {
      execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 20)"]);
    }
  }
  return undefined;
}

function readRss(pid) {
  if (process.platform === "linux") {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const kib = (name) => Number(new RegExp(`^${name}:\\s+(\\d+) kB`, "m").exec(status)?.[1] ?? 0);
    return { rss: (kib("VmRSS") * 1024) / MIB, anon: (kib("RssAnon") * 1024) / MIB };
  }
  const rss = (Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" })) * 1024) / MIB;
  return { rss, anon: rss };
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

/** Sessions copied in SQL from one finalized template, each with its events, so the file reaches its size quickly. */
async function seedDatabase(directory) {
  const { WorkIntelligenceStore } = await import(
    pathToFileURL(join(repositoryRoot, "packages", "storage", "dist", "index.js")).href
  );
  const { DatabaseSync } = await import("node:sqlite");
  const databasePath = join(directory, "export.sqlite");
  const projectRoot = join(directory, "synthetic-project");
  mkdirSync(projectRoot);
  const store = new WorkIntelligenceStore(databasePath);
  const project = store.addProject("Memory fixture", projectRoot);
  store.updateProject(project.id, { status: "tracked" });
  const template = store.finalizeSession({
    projectRoot,
    idempotencyKey: "template",
    title: "Synthetic template",
    summary: "Synthetic Session text. ".repeat(40),
    changedFiles: ["src/a.ts", "src/b.ts"],
    verification: { status: "passed" },
    workSummary: { outcomes: ["Synthetic outcome"], scope: [], decisions: [], verification: [], nextSteps: [] },
  });
  if (template.outcome !== "finalized") throw new Error("Could not seed the template Session.");
  store.close();

  const db = new DatabaseSync(databasePath);
  try {
    const session = db.prepare("SELECT * FROM sessions WHERE idempotency_key = 'template'").get();
    const events = db.prepare("SELECT * FROM work_events WHERE session_id = ?").all(session.id);
    const insert = (table, row) =>
      db
        .prepare(
          `INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row)
            .map(() => "?")
            .join(", ")})`,
        )
        .run(...Object.values(row));
    db.exec("BEGIN");
    for (let index = 0; index < sessionCount; index += 1) {
      const id = `synthetic-session-${index}`;
      const copy = {
        ...session,
        id,
        idempotency_key: id,
        title: `Synthetic Session ${index}`,
        summary: `Synthetic summary ${index}. ${"Generated text for the memory benchmark. ".repeat(60)}`,
        completed_at: new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * 60_000).toISOString(),
      };
      insert("sessions", copy);
      for (const [eventIndex, event] of events.entries()) {
        insert("work_events", { ...event, id: `${id}-event-${eventIndex}`, session_id: id });
      }
      for (let extra = 0; extra < 12; extra += 1) {
        const base = events[0];
        if (base) {
          insert("work_events", {
            ...base,
            id: `${id}-extra-${extra}`,
            session_id: id,
            summary: `Synthetic event ${extra} of ${index}. ${"event text ".repeat(20)}`,
          });
        }
      }
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  return databasePath;
}

async function startServer(databasePath, directory, name) {
  const port = await freePort();
  const home = join(directory, `${name}-home`);
  mkdirSync(home, { recursive: true });
  const preload = join(directory, "heap-probe.mjs");
  writeFileSync(
    preload,
    `import { writeFileSync } from "node:fs";
process.on("SIGUSR2", () => writeFileSync(${JSON.stringify(join(directory, "heap.json"))}, JSON.stringify(process.memoryUsage())));
`,
  );
  const child = spawn(
    process.execPath,
    [
      ...NODE_FLAGS,
      ...(heapMode ? ["--import", pathToFileURL(preload).href] : []),
      join(repositoryRoot, "apps", "server", "dist", "index.js"),
    ],
    {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: home,
        TMPDIR: directory,
        WORK_INTELLIGENCE_DB: databasePath,
        WORK_INTELLIGENCE_PORT: String(port),
        ...serverEnvironment,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return { child, base };
    } catch {
      // not listening yet
    }
    if (child.exitCode !== null) throw new Error(`Server exited: ${stderr}`);
    await delay(100);
  }
  throw new Error(`Server did not start: ${stderr}`);
}

async function stopServer(server) {
  server.child.kill();
  await new Promise((resolveExit) =>
    server.child.exitCode === null ? server.child.once("exit", resolveExit) : resolveExit(),
  );
}

/** Runs `operation` while sampling the process RSS; returns its result, the duration and the peak. */
async function measuring(pid, operation) {
  let peak = readRss(pid);
  const timer = setInterval(() => {
    const sample = readRss(pid);
    if (sample.rss > peak.rss) peak = sample;
  }, SAMPLE_MS);
  const start = performance.now();
  try {
    const value = await operation();
    return { value, ms: performance.now() - start, peak };
  } finally {
    clearInterval(timer);
  }
}

async function phases(server, directory, operation) {
  const pid = server.child.pid;
  await delay(2_000);
  const baseline = readRss(pid);
  const baselineHeap = readHeap(directory, pid);
  const operated = await measuring(pid, operation);
  const afterOperation = readRss(pid);
  await delay(Math.min(3, idleSeconds) * 1_000);
  const afterThreeSeconds = readRss(pid);
  await delay(Math.max(0, idleSeconds - 3) * 1_000);
  const idle = readRss(pid);
  const idleHeap = readHeap(directory, pid);
  return {
    baseline,
    baselineHeap,
    peak: operated.peak,
    afterOperation,
    afterThreeSeconds,
    idle,
    idleHeap,
    ms: operated.ms,
    value: operated.value,
  };
}

async function oneRun() {
  const directory = mkdtempSync(join(tmpdir(), "work-intelligence-memory-bench-"));
  try {
    const databasePath = await seedDatabase(directory);
    if (savedDatabase) copyFileSync(databasePath, savedDatabase);
    const exportServer = await startServer(databasePath, directory, "export");
    let exported;
    try {
      exported = await phases(exportServer, directory, async () => {
        const response = await fetch(`${exportServer.base}/api/export`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope: "all" }),
        });
        if (!response.ok) throw new Error(`Export failed: ${response.status} ${await response.text()}`);
        return Buffer.from(await response.arrayBuffer());
      });
    } finally {
      await stopServer(exportServer);
    }
    const bundle = exported.value;
    const bundlePath = join(directory, "bundle.json");
    writeFileSync(bundlePath, bundle);

    const importServer = await startServer(join(directory, "import.sqlite"), directory, "import");
    let imported;
    try {
      imported = await phases(importServer, directory, async () => {
        const response = await fetch(`${importServer.base}/api/import`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: Buffer.concat([Buffer.from('{"bundle":'), readFileSync(bundlePath), Buffer.from("}")]),
        });
        if (!response.ok) throw new Error(`Import failed: ${response.status} ${await response.text()}`);
        return response.json();
      });
    } finally {
      await stopServer(importServer);
    }
    return { bundleMiB: bundle.length / MIB, exported, imported };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const results = [];
for (let run = 0; run < runs; run += 1) results.push(await oneRun());
const pick = (select) => median(results.map(select));
const summary = {
  bundleMiB: pick((result) => result.bundleMiB),
  export: {
    baselineMiB: pick((result) => result.exported.baseline.rss),
    peakMiB: pick((result) => result.exported.peak.rss),
    afterMiB: pick((result) => result.exported.afterOperation.rss),
    threeSecondsMiB: pick((result) => result.exported.afterThreeSeconds.rss),
    idleMiB: pick((result) => result.exported.idle.rss),
    idleAnonMiB: pick((result) => result.exported.idle.anon),
    ms: pick((result) => result.exported.ms),
  },
  import: {
    baselineMiB: pick((result) => result.imported.baseline.rss),
    peakMiB: pick((result) => result.imported.peak.rss),
    afterMiB: pick((result) => result.imported.afterOperation.rss),
    threeSecondsMiB: pick((result) => result.imported.afterThreeSeconds.rss),
    idleMiB: pick((result) => result.imported.idle.rss),
    idleAnonMiB: pick((result) => result.imported.idle.anon),
    ms: pick((result) => result.imported.ms),
  },
};
if (args.includes("--json")) {
  console.log(JSON.stringify(summary));
} else {
  if (heapMode) {
    for (const [key, run] of [
      ["export", results[0].exported],
      ["import", results[0].imported],
    ]) {
      const show = (heap) =>
        heap &&
        `heapUsed ${heap.heapUsed.toFixed(0)} external ${heap.external.toFixed(0)} arrayBuffers ${heap.arrayBuffers.toFixed(0)}`;
      console.log(`${key} main thread (first run) baseline: ${show(run.baselineHeap)}; idle: ${show(run.idleHeap)}`);
    }
  }
  console.log(
    `Median of ${runs} runs, ${sessionCount} Sessions, project-data file ${summary.bundleMiB.toFixed(1)} MiB, idle ${idleSeconds} s`,
  );
  for (const key of ["export", "import"]) {
    const part = summary[key];
    console.log(
      `${key.padEnd(7)} baseline ${part.baselineMiB.toFixed(0)} MiB  peak ${part.peakMiB.toFixed(0)} MiB  ` +
        `just after ${part.afterMiB.toFixed(0)} MiB  +3 s ${part.threeSecondsMiB.toFixed(0)} MiB  idle ${part.idleMiB.toFixed(0)} MiB (anon ${part.idleAnonMiB.toFixed(0)})  ` +
        `${key} ${part.ms.toFixed(0)} ms`,
    );
  }
}
