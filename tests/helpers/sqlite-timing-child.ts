// Child of tests/storage/sqlite-timing.test.ts: waits on a write lock held by the test so the hook sees a slow BEGIN IMMEDIATE, then runs transactions.
// The hook must be registered before node:sqlite is resolved, so neither may be a static import here.
if (process.env.WI_SQLITE_TIMING === "1") await import("./sqlite-timing.js");
const { DatabaseSync } = await import("node:sqlite");

const databasePath = process.argv[2] as string;
const db = new DatabaseSync(databasePath);
db.exec("PRAGMA busy_timeout = 5000");
process.stdout.write("ready\n");
db.exec("BEGIN IMMEDIATE");
db.prepare("INSERT INTO items (name) VALUES (?)").run("secret-parameter-value");
// Held 150 ms on purpose: a transaction is recorded from 100 ms, and a COMMIT that merely happens to be quick must not
// decide whether this one is counted (a loaded Windows runner fsyncs slowly, which made the record count vary).
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
db.exec("COMMIT");
// A deferred transaction that writes, held for 150 ms: recorded with write true, a candidate holder in the report.
db.exec("BEGIN");
db.prepare("INSERT INTO items (name) VALUES (?)").run("second");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
db.exec("COMMIT");
// A deferred transaction that only reads, held for 150 ms: recorded with write false, never a holder. Its column is named
// `changes` on purpose: only run() reports changed rows, a row from get() must not count as a write.
db.exec("BEGIN");
db.prepare("SELECT COUNT(*) AS changes FROM items").get();
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
db.exec("COMMIT");
db.exec("BEGIN");
try {
  db.prepare("INSERT INTO items (id, name) VALUES (1, 'duplicate')").run();
} catch {
  // Expected: the duplicate key fails, but the statement already took the write lock.
}
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
db.exec("ROLLBACK");
db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
for (const row of db.prepare("SELECT name FROM items").iterate()) void row;
db.close();
process.stdout.write(`${JSON.stringify({ className: DatabaseSync.name })}\n`);
