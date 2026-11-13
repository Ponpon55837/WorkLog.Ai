// Read-only: prints only per-table row counts and the project count per status (no text, ids, names or paths).
// Usage: node docs/experiments/code-health-audit/inspect-row-counts.mjs <db.sqlite>
import console from "node:console";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.argv[2], { readOnly: true });
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%fts%' ORDER BY name")
  .all();
const counts = {};
for (const { name } of tables) {
  try {
    counts[name] = db.prepare(`SELECT count(*) AS c FROM "${String(name).replaceAll('"', '""')}"`).get().c;
  } catch {
    counts[name] = null;
  }
}
const projectsByStatus = Object.fromEntries(
  db
    .prepare("SELECT status, count(*) AS c FROM projects GROUP BY status")
    .all()
    .map((row) => [row.status, row.c]),
);
console.log(JSON.stringify({ counts, projectsByStatus }, null, 2));
