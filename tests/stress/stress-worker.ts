// Test-only SQLite timing loads first (only with WI_SQLITE_TIMING=1): its ESM hook must register before anything resolves "node:sqlite", so the body is a dynamic import.
if (process.env.WI_SQLITE_TIMING === "1") await import("../helpers/sqlite-timing.js");

await import("./stress-worker-main.js");
