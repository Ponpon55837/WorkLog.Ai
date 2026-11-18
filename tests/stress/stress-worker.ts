// Child-process entry for tests/stress/sqlite-wal-stress.test.ts; the body lives in stress-worker-main.ts.
// Test-only SQLite timing (evidence for lock stalls) is loaded first and only when WI_SQLITE_TIMING=1: its ESM hook has
// to be registered before anything resolves "node:sqlite", so the body must be a dynamic import, never a static one.
if (process.env.WI_SQLITE_TIMING === "1") await import("../helpers/sqlite-timing.js");

await import("./stress-worker-main.js");
