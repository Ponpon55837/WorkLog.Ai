import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDatabaseBusyError, WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import {
  CHECKPOINT_MODES,
  createRandom,
  describeError,
  eventSummary,
  expectedEventCount,
  idempotencyKey,
  paddingFor,
} from "./stress-support.js";

// Child-process body for tests/stress/sqlite-wal-stress.test.ts, started by stress-worker.ts. One role per process; every role reports to the
// orchestrator over IPC. Writers go through the real WorkIntelligenceStore (the path API, MCP and CLI use), readers
// and the snapshotter open their own connections the way hooks and the backup worker do. Synthetic data only.
type Role = "writer" | "reader-long" | "reader-short" | "checkpointer" | "snapshotter";
type Message = { type: string; [key: string]: unknown };

interface WorkerConfig {
  databasePath: string;
  projectRoot: string;
  seed: number;
  writer?: number;
  startSeq?: number;
  snapshotDirectory?: string;
}

interface Counters {
  ops: number;
  busy: number;
  otherErrors: number;
  extra: Record<string, number>;
}

const BUSY_TIMEOUT_MS = 5000;
const counters: Counters = { ops: 0, busy: 0, otherErrors: 0, extra: {} };
let stopping = false;
const inbox: Message[] = [];
const waiting: Array<{ types: string[]; resolve: (message: Message) => void }> = [];

function send(message: Message): void {
  process.send?.(message);
}

function log(text: string): void {
  send({ type: "log", text });
}

function fail(error: unknown, context: string): void {
  counters.otherErrors += 1;
  log(`UNEXPECTED ${context}: ${describeError(error)}`);
  send({ type: "fatal", context, error: describeError(error) });
}

/** Counts an operation that failed: lock contention is recorded (report-only), anything else is a real failure. */
function recordFailure(error: unknown, context: string): void {
  if (isDatabaseBusyError(error)) {
    counters.busy += 1;
    log(`busy during ${context}`);
  } else fail(error, context);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

process.on("message", (message: Message) => {
  if (message.type === "stop") stopping = true;
  const index = waiting.findIndex((entry) => entry.types.includes(message.type));
  if (index >= 0) waiting.splice(index, 1)[0]?.resolve(message);
  else inbox.push(message);
});

/** Resolves with the next message of any of these types (earlier ones are kept, so none is missed). */
function receive(...types: string[]): Promise<Message> {
  const index = inbox.findIndex((message) => types.includes(message.type));
  if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0] as Message);
  return new Promise((resolve) => waiting.push({ types, resolve }));
}

function reportStats(): void {
  send({ type: "stats", ...counters });
}

/** One synthetic Session with a seq-dependent number of events; sequence and writer are embedded in key, title and events. */
function writeOne(store: WorkIntelligenceStore, config: WorkerConfig, writer: number, seq: number): string {
  const count = expectedEventCount(writer, seq);
  const result = store.finalizeSession({
    projectRoot: config.projectRoot,
    idempotencyKey: idempotencyKey(writer, seq),
    title: `Stress write ${writer}/${seq}`,
    summary: `Synthetic stress session writer ${writer} seq ${seq}. ${paddingFor(config.seed, writer, seq)}`.trim(),
    workSummary: {
      outcomes: [`Stress outcome ${writer}/${seq}`],
      scope: [],
      decisions: [],
      verification: [],
      nextSteps: [],
    },
    changedFiles: [],
    verification: { status: "passed" },
    // Supplied so the store does not spawn git for every write; the stress is about SQLite, not about git.
    git: { branch: "stress" },
    events: Array.from({ length: count }, (_unused, index) => ({
      type: "note" as const,
      summary: eventSummary(writer, seq, index),
      details: { writer, seq, index },
    })),
  });
  return result.outcome;
}

/**
 * Lock-step writer: the orchestrator sends "go" for each write and gets the ack only after finalizeSession returned
 * (committed). Because "go" for write N+1 follows the ack of N, at most one committed write is ever unacknowledged,
 * which is what lets the orchestrator bound a SIGKILLed writer's in-flight write exactly.
 */
async function runWriter(config: WorkerConfig): Promise<void> {
  const writer = config.writer ?? 0;
  let seq = config.startSeq ?? 1;
  let store: WorkIntelligenceStore | undefined;
  for (let attempt = 0; !store; attempt += 1) {
    try {
      store = new WorkIntelligenceStore(config.databasePath);
    } catch (error) {
      recordFailure(error, "open store");
      if (!isDatabaseBusyError(error) || attempt >= 5) return;
    }
  }
  send({ type: "ready" });
  try {
    for (;;) {
      const message = await receive("go", "stop");
      if (message.type === "stop") break;
      for (let attempt = 0; ; attempt += 1) {
        try {
          const outcome = writeOne(store, config, writer, seq);
          counters.ops += 1;
          // Every tenth write also refreshes the search index, as the first read after a write does in production.
          if (seq % 10 === 0) store.syncSearchIndex();
          send({ type: "ack", writer, seq, outcome });
          break;
        } catch (error) {
          recordFailure(error, `write ${writer}/${seq}`);
          if (!isDatabaseBusyError(error) || attempt >= 20) {
            send({ type: "ack-failed", writer, seq });
            return;
          }
          await sleep(5);
        }
      }
      seq += 1;
    }
  } finally {
    store.close();
  }
}

async function runLongReader(config: WorkerConfig): Promise<void> {
  const random = createRandom(config.seed ^ 0x1001);
  const db = new DatabaseSync(config.databasePath, { readOnly: true });
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  send({ type: "ready" });
  try {
    while (!stopping) {
      try {
        db.exec("BEGIN");
        db.prepare("SELECT COUNT(*) AS total FROM sessions").get();
        const holdUntil = Date.now() + 300 + Math.floor(random() * 900);
        while (!stopping && Date.now() < holdUntil) {
          // The read snapshot stays pinned while later queries run against it.
          db.prepare("SELECT COUNT(*) AS total FROM work_events").get();
          counters.ops += 1;
          await sleep(25);
        }
        counters.extra.transactions = (counters.extra.transactions ?? 0) + 1;
      } catch (error) {
        recordFailure(error, "long read");
      } finally {
        if (db.isTransaction) db.exec("COMMIT");
      }
      await sleep(Math.floor(random() * 30));
    }
  } finally {
    db.close();
  }
}

async function runShortReader(config: WorkerConfig): Promise<void> {
  const random = createRandom(config.seed ^ 0x2002);
  const db = new DatabaseSync(config.databasePath, { readOnly: true });
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  send({ type: "ready" });
  try {
    while (!stopping) {
      try {
        db.prepare("SELECT id, title FROM sessions ORDER BY created_at DESC LIMIT 5").all();
        db.prepare("SELECT COUNT(*) AS total FROM sessions").get();
        counters.ops += 1;
      } catch (error) {
        recordFailure(error, "short read");
      }
      await sleep(Math.floor(random() * 6));
    }
  } finally {
    db.close();
  }
}

async function runCheckpointer(config: WorkerConfig): Promise<void> {
  const random = createRandom(config.seed ^ 0x3003);
  const db = new DatabaseSync(config.databasePath);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  send({ type: "ready" });
  let round = 0;
  try {
    while (!stopping) {
      const mode = CHECKPOINT_MODES[round % CHECKPOINT_MODES.length] ?? "PASSIVE";
      round += 1;
      try {
        const row = db.prepare(`PRAGMA wal_checkpoint(${mode})`).get() as {
          busy: number;
          log: number;
          checkpointed: number;
        };
        counters.ops += 1;
        send({
          type: "checkpoint",
          mode,
          busy: Number(row.busy),
          log: Number(row.log),
          checkpointed: Number(row.checkpointed),
        });
      } catch (error) {
        if (isDatabaseBusyError(error)) send({ type: "checkpoint", mode, thrownBusy: true });
        recordFailure(error, `checkpoint ${mode}`);
      }
      await sleep(30 + Math.floor(random() * 250));
    }
  } finally {
    db.close();
  }
}

/** Periodic VACUUM INTO, bracketed by two orchestrator round trips that capture the per-writer ack high-water marks. */
async function runSnapshotter(config: WorkerConfig): Promise<void> {
  const random = createRandom(config.seed ^ 0x4004);
  const db = new DatabaseSync(config.databasePath, { readOnly: true });
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  send({ type: "ready" });
  let index = 0;
  try {
    while (!stopping) {
      await sleep(800 + Math.floor(random() * 1200));
      if (stopping) break;
      index += 1;
      const target = join(config.snapshotDirectory ?? "", `snapshot-${String(index).padStart(3, "0")}.sqlite`);
      send({ type: "snapshot-begin-request", index });
      if ((await receive("snapshot-begin", "stop")).type === "stop") break;
      try {
        db.prepare("VACUUM INTO ?").run(target);
        counters.ops += 1;
        send({ type: "snapshot-end", index, path: target });
      } catch (error) {
        send({ type: "snapshot-failed", index });
        recordFailure(error, "VACUUM INTO");
      }
    }
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const [role, rawConfig] = process.argv.slice(2) as [Role, string];
  const config = JSON.parse(rawConfig) as WorkerConfig;
  process.env.WI_STRESS_ROLE = role === "writer" ? `writer-${config.writer ?? 0}` : role;
  const statsTimer = setInterval(reportStats, 1000);
  try {
    if (role === "writer") await runWriter(config);
    else if (role === "reader-long") await runLongReader(config);
    else if (role === "reader-short") await runShortReader(config);
    else if (role === "checkpointer") await runCheckpointer(config);
    else if (role === "snapshotter") await runSnapshotter(config);
    else throw new Error(`Unknown stress role: ${String(role)}`);
  } catch (error) {
    fail(error, `${role} crashed`);
  } finally {
    clearInterval(statsTimer);
  }
  send({ type: "final", ...counters });
}

await main();
// Closing the channel flushes the last message and lets the process end on its own.
process.disconnect();
