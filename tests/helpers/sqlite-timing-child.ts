// Child process for tests/storage/sqlite-timing.test.ts: waits for a write lock held by the test process, so the timing
// hook sees a slow BEGIN IMMEDIATE, then runs a few more statements. Prints what it observed as one JSON line.
// The hook must be registered before node:sqlite is resolved, so neither may be a static import here.
if (process.env.WI_SQLITE_TIMING === "1") await import("./sqlite-timing.js");
const { DatabaseSync } = await import("node:sqlite");

const databasePath = process.argv[2] as string;
const db = new DatabaseSync(databasePath);
db.exec("PRAGMA busy_timeout = 5000");
process.stdout.write("ready\n");
db.exec("BEGIN IMMEDIATE");
db.prepare("INSERT INTO items (name) VALUES (?)").run("secret-parameter-value");
db.exec("COMMIT");
db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
for (const row of db.prepare("SELECT name FROM items").iterate()) void row;
db.close();
process.stdout.write(`${JSON.stringify({ className: DatabaseSync.name })}\n`);
