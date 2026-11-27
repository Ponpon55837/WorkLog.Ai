import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkIntelligenceStore } from "../../packages/storage/src/index.js";

/** About 8.3 KiB per Session (a long summary and 13 work events), so 2,120 Sessions make about 17.5 MiB. */
export function writeSyntheticProjectExport(target: string, sessionCount: number): { bytes: number } {
  const directory = mkdtempSync(join(tmpdir(), "work-intelligence-synthetic-export-"));
  try {
    const databasePath = join(directory, "source.sqlite");
    const projectRoot = join(directory, "synthetic-project");
    mkdirSync(projectRoot);
    const seed = new WorkIntelligenceStore(databasePath);
    const project = seed.addProject("Synthetic export fixture", projectRoot);
    seed.updateProject(project.id, { status: "tracked" });
    seed.finalizeSession({
      projectRoot,
      idempotencyKey: "synthetic-template",
      title: "Synthetic template",
      summary: "Synthetic Session text. ".repeat(40),
      changedFiles: ["src/a.ts", "src/b.ts"],
      verification: { status: "passed" },
      workSummary: { outcomes: ["Synthetic outcome"], scope: [], decisions: [], verification: [], nextSteps: [] },
    });
    seed.close();
    insertSyntheticSessions(databasePath, sessionCount);
    const store = new WorkIntelligenceStore(databasePath);
    try {
      return store.writeProjectDataExport({ type: "all" }, target);
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function insertSyntheticSessions(databasePath: string, sessionCount: number): void {
  const db = new DatabaseSync(databasePath);
  try {
    const session = db.prepare("SELECT * FROM sessions WHERE idempotency_key = 'synthetic-template'").get() as Record<
      string,
      string | number | null
    >;
    const events = db.prepare("SELECT * FROM work_events WHERE session_id = ?").all(String(session.id)) as Array<
      Record<string, string | number | null>
    >;
    const statements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
    const insert = (table: string, row: Record<string, string | number | null>): void => {
      const columns = Object.keys(row);
      const key = `${table}:${columns.join(",")}`;
      let statement = statements.get(key);
      if (!statement) {
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
          ...events[0]!,
          id: `${id}-extra-${extra}`,
          session_id: id,
          summary: `Synthetic event ${extra} of ${index}. ${"event text ".repeat(20)}`,
        });
      }
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

export function writeImportRequest(bundleFile: string, target: string): { bytes: number } {
  const fd = openSync(target, "wx", 0o600);
  try {
    writeSync(fd, '{"bundle":');
    writeSync(fd, readFileSync(bundleFile));
    writeSync(fd, "}");
  } finally {
    closeSync(fd);
  }
  return { bytes: statSync(target).size };
}
