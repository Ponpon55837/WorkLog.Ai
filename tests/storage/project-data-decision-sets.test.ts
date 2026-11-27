import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProjectDataImportInput,
  ProjectDataImportStrategy,
  ProjectDataRow,
  ProjectDataTable,
  ProjectDataValue,
} from "../../packages/core/src/index.js";
import { projectDataExportTableColumns } from "../../packages/schema/src/index.js";
import { canonicalizeProjectRoot } from "../../packages/project-policy/src/index.js";
import { readProjectDataImportBytes } from "../../packages/storage/src/project-data-import-stream.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

interface Decision {
  id: string;
  text: string;
  status?: "pending" | "confirmed";
  knowledgeId?: string;
  reviewRequestId?: string;
}

interface Machines {
  a: WorkIntelligenceStore;
  b: WorkIntelligenceStore;
  projectId: string;
  sessionId: string;
}

const OLD = "2026-10-01T00:00:00.000Z";
const NEWER = "2099-01-01T00:00:00.000Z";
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function d(id: string, text: string, status: Decision["status"] = "confirmed"): Decision {
  return { id, text, status };
}

function total(counts: Record<string, number | undefined>): number {
  return Object.values(counts).reduce<number>((sum, count) => sum + (count ?? 0), 0);
}

function row(table: ProjectDataTable, values: Record<string, ProjectDataValue>): ProjectDataRow {
  return Object.fromEntries(projectDataExportTableColumns[table].map((column) => [column, values[column] ?? null]));
}

function run(store: WorkIntelligenceStore, sql: string, ...values: ProjectDataValue[]): void {
  const db = new DatabaseSync(store.databasePath);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.prepare(sql).run(...values);
  } finally {
    db.close();
  }
}

function insert(store: WorkIntelligenceStore, table: ProjectDataTable, values: ProjectDataRow): void {
  const columns = projectDataExportTableColumns[table];
  run(
    store,
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    ...columns.map((column) => values[column] as ProjectDataValue),
  );
}

function read<T>(store: WorkIntelligenceStore, sql: string, ...values: ProjectDataValue[]): T[] {
  const db = new DatabaseSync(store.databasePath, { readOnly: true });
  try {
    return db.prepare(sql).all(...values) as T[];
  } finally {
    db.close();
  }
}

function layout(
  store: WorkIntelligenceStore,
  sessionId: string,
): Array<{ id: string; text: string; position: number }> {
  return read(
    store,
    "SELECT id, text, position FROM session_decisions WHERE session_id = ? ORDER BY position",
    sessionId,
  );
}

function createMachines(): Machines {
  const root = mkdtempSync(join(tmpdir(), "wi-decision-sets-"));
  tempDirs.push(root);
  const rootA = join(root, "a-project");
  const rootB = join(root, "b-project");
  mkdirSync(rootA);
  mkdirSync(rootB);
  const a = new WorkIntelligenceStore(join(root, "a.sqlite"));
  const b = new WorkIntelligenceStore(join(root, "b.sqlite"));
  stores.push(a, b);
  const project = a.addProject("Decision sets project", rootA);
  a.updateProject(project.id, { status: "tracked" });
  const finalized = a.finalizeSession({
    projectRoot: rootA,
    idempotencyKey: "decision-sets-session",
    title: "Decision sets session",
    summary: "Synthetic Session for decision sets.",
    completedAt: OLD,
  });
  if (finalized.outcome !== "finalized") throw new Error("The Session must be accepted.");
  b.importProjectData({
    bundle: a.exportProjectData({ type: "project", projectId: project.id }),
    remap: [{ from: canonicalizeProjectRoot(rootA), to: canonicalizeProjectRoot(rootB) }],
  });
  b.updateProject(project.id, { status: "tracked" });
  return { a, b, projectId: project.id, sessionId: finalized.session.id };
}

function setDecisions(
  store: WorkIntelligenceStore,
  { projectId, sessionId }: Machines,
  decisions: Decision[],
  summary: string[],
  updatedAt: string,
): void {
  run(store, "DELETE FROM session_decisions WHERE session_id = ?", sessionId);
  decisions.forEach((decision, position) => {
    const reviewed = decision.status !== "pending";
    insert(
      store,
      "session_decisions",
      row("session_decisions", {
        id: decision.id,
        session_id: sessionId,
        project_id: projectId,
        position,
        text: decision.text,
        origin: "agent_autonomous",
        review_status: decision.status ?? "confirmed",
        reviewed_at: reviewed ? OLD : null,
        reviewed_by: reviewed ? "user" : null,
        knowledge_id: decision.knowledgeId ?? null,
        review_request_id: decision.reviewRequestId ?? null,
      }),
    );
  });
  run(
    store,
    "UPDATE sessions SET work_summary_json = ?, updated_at = ? WHERE id = ?",
    JSON.stringify({ outcomes: [], scope: [], decisions: summary, verification: [], nextSteps: [] }),
    updatedAt,
    sessionId,
  );
}

const staleLocal = [d("w0", "W0"), d("w1", "W1"), d("x2", "X2"), d("x3", "X3")];
const rewritten = [d("m0", "M0"), d("m1", "M1"), d("x2", "X2"), d("x3", "X3")];
const texts = (decisions: Decision[]) => decisions.map((decision) => decision.text);

/** Both Sessions carry the rewritten summary, so the rows are identical and only A's decisions are stale. */
function staleMachines(): Machines {
  const machines = createMachines();
  setDecisions(machines.a, machines, staleLocal, texts(rewritten), OLD);
  setDecisions(machines.b, machines, rewritten, texts(rewritten), OLD);
  return machines;
}

/** B rewrote the decisions and updated the Session, so the import updates A's row. */
function newerMachines(local: Decision[], remote: Decision[]): Machines {
  const machines = createMachines();
  setDecisions(machines.a, machines, local, texts(local), OLD);
  setDecisions(machines.b, machines, remote, texts(remote), NEWER);
  return machines;
}

function fileOf(machines: Machines, from: "a" | "b", strategy: ProjectDataImportStrategy): ProjectDataImportInput {
  return {
    bundle: machines[from].exportProjectData({ type: "project", projectId: machines.projectId }),
    strategy,
  };
}

describe("decision sets on import", () => {
  it("replaces the stale local decisions with the file's and then skips everything", () => {
    const machines = staleMachines();
    const input = fileOf(machines, "b", "merge");

    const preview = machines.a.previewProjectDataImport(input);
    expect(preview.skipped.sessions).toBe(1);
    expect(preview.additions.session_decisions).toBe(2);
    expect(preview.skipped.session_decisions).toBe(2);
    expect(preview.replacedLocal).toEqual({ session_decisions: 2 });
    expect(total(preview.conflicts)).toBe(0);

    const result = machines.a.importProjectData(input);
    expect(result.changed).toBe(true);
    expect(result.backupFileName).toBeDefined();
    expect(result.additions.session_decisions).toBe(preview.additions.session_decisions);
    expect(result.replacedLocal).toEqual(preview.replacedLocal);
    expect(layout(machines.a, machines.sessionId)).toEqual(layout(machines.b, machines.sessionId));

    const again = machines.a.importProjectData(input);
    expect(again.changed).toBe(false);
    expect(again.replacedLocal).toEqual({});
    expect(total(again.additions) + total(again.updates) + total(again.conflicts)).toBe(0);
  });

  it("still replaces when the shared decisions were reviewed later on this machine", () => {
    const machines = createMachines();
    setDecisions(machines.a, machines, staleLocal, texts(rewritten), OLD);
    setDecisions(
      machines.b,
      machines,
      [d("m0", "M0"), d("m1", "M1", "pending"), d("x2", "X2", "pending"), d("x3", "X3", "pending")],
      texts(rewritten),
      OLD,
    );
    const input = fileOf(machines, "b", "newer-wins");

    const preview = machines.a.previewProjectDataImport(input);
    expect(preview.replacedLocal).toEqual({ session_decisions: 2 });
    expect(preview.keptLocal.session_decisions).toBe(2);
    expect(total(preview.conflicts)).toBe(0);

    machines.a.importProjectData(input);
    expect(layout(machines.a, machines.sessionId).map((decision) => decision.id)).toEqual(["m0", "m1", "x2", "x3"]);
    expect(
      read<{ review_status: string }>(
        machines.a,
        "SELECT review_status FROM session_decisions WHERE id IN ('x2', 'x3')",
      ).map((decision) => decision.review_status),
    ).toEqual(["confirmed", "confirmed"]);
  });

  it("keeps the local decisions when the file is the stale side", () => {
    const machines = staleMachines();
    const before = layout(machines.b, machines.sessionId);
    const input = fileOf(machines, "a", "merge");

    const preview = machines.b.previewProjectDataImport(input);
    expect(total(preview.conflicts)).toBe(0);
    expect(preview.keptLocal.session_decisions).toBe(2);
    expect(preview.skipped.session_decisions).toBe(2);
    expect(preview.replacedLocal).toEqual({});

    const result = machines.b.importProjectData(input);
    expect(result.changed).toBe(false);
    expect(result.backupFileName).toBeUndefined();
    expect(layout(machines.b, machines.sessionId)).toEqual(before);
  });

  it("takes a newer review of a shared decision from a stale file", () => {
    const machines = createMachines();
    setDecisions(machines.a, machines, staleLocal, texts(rewritten), OLD);
    setDecisions(
      machines.b,
      machines,
      [d("m0", "M0"), d("m1", "M1"), d("x2", "X2", "pending"), d("x3", "X3", "pending")],
      texts(rewritten),
      OLD,
    );
    const input = fileOf(machines, "a", "newer-wins");

    const preview = machines.b.previewProjectDataImport(input);
    expect(total(preview.conflicts)).toBe(0);
    expect(preview.keptLocal.session_decisions).toBe(2);
    expect(preview.updates.session_decisions).toBe(2);

    machines.b.importProjectData(input);
    expect(layout(machines.b, machines.sessionId).map((decision) => decision.id)).toEqual(["m0", "m1", "x2", "x3"]);
    expect(
      read<{ review_status: string }>(
        machines.b,
        "SELECT review_status FROM session_decisions WHERE id IN ('x2', 'x3')",
      ).map((decision) => decision.review_status),
    ).toEqual(["confirmed", "confirmed"]);
  });

  it("replaces under newer-wins when the Session row is updated, and leaves the decisions alone under merge", () => {
    const machines = newerMachines(staleLocal, rewritten);

    const merge = machines.a.previewProjectDataImport(fileOf(machines, "b", "merge"));
    expect(merge.conflicts.sessions).toBe(1);
    expect(merge.conflictDetails).toContainEqual(
      expect.objectContaining({ table: "sessions", category: "newer_content" }),
    );
    expect(merge.additions.session_decisions ?? 0).toBe(0);
    expect(merge.replacedLocal).toEqual({});
    machines.a.importProjectData(fileOf(machines, "b", "merge"));
    expect(texts(layout(machines.a, machines.sessionId))).toEqual(texts(staleLocal));

    const input = fileOf(machines, "b", "newer-wins");
    const preview = machines.a.previewProjectDataImport(input);
    expect(preview.updates.sessions).toBe(1);
    expect(preview.replacedLocal).toEqual({ session_decisions: 2 });
    expect(total(preview.conflicts)).toBe(0);
    machines.a.importProjectData(input);
    expect(layout(machines.a, machines.sessionId)).toEqual(layout(machines.b, machines.sessionId));
  });

  it("removes the surplus when the file has fewer decisions under the same ids", () => {
    const local = [d("a0", "T0"), d("a1", "T1"), d("a2", "T2"), d("a3", "T3")];
    const machines = newerMachines(local, local.slice(0, 2));
    const input = fileOf(machines, "b", "newer-wins");

    const result = machines.a.importProjectData(input);
    expect(result.replacedLocal).toEqual({ session_decisions: 2 });
    expect(result.backupFileName).toBeDefined();
    expect(layout(machines.a, machines.sessionId).map((decision) => decision.id)).toEqual(["a0", "a1"]);
  });

  it("pairs duplicate texts in order and moves the survivor without a position collision", () => {
    const local = [d("a0", "D"), d("a1", "E"), d("a2", "D"), d("a3", "F")];
    const machines = newerMachines(local, [d("a0", "D"), d("a2", "D")]);
    const input = fileOf(machines, "b", "newer-wins");

    const preview = machines.a.previewProjectDataImport(input);
    expect(preview.replacedLocal).toEqual({ session_decisions: 2 });
    expect(preview.updates.session_decisions).toBe(1);
    expect(preview.skipped.session_decisions).toBe(1);
    machines.a.importProjectData(input);
    expect(layout(machines.a, machines.sessionId)).toEqual([
      { id: "a0", text: "D", position: 0 },
      { id: "a2", text: "D", position: 1 },
    ]);
  });

  it("turns a moved position into an update, also when rows swap places", () => {
    const machines = newerMachines([d("a0", "X"), d("a1", "Y")], [d("a1", "Y"), d("a0", "X")]);
    const input = fileOf(machines, "b", "newer-wins");

    const preview = machines.a.previewProjectDataImport(input);
    expect(preview.updates.session_decisions).toBe(2);
    expect(total(preview.conflicts)).toBe(0);
    expect(preview.replacedLocal).toEqual({});
    machines.a.importProjectData(input);
    expect(layout(machines.a, machines.sessionId)).toEqual([
      { id: "a1", text: "Y", position: 0 },
      { id: "a0", text: "X", position: 1 },
    ]);
  });

  it("keeps the local rows for the same texts under other ids", () => {
    const machines = createMachines();
    setDecisions(machines.a, machines, [d("l0", "Q", "pending")], ["Q"], OLD);
    setDecisions(machines.b, machines, [d("i0", "Q", "pending")], ["Q"], OLD);
    const input = fileOf(machines, "b", "merge");

    const preview = machines.a.previewProjectDataImport(input);
    expect(preview.keptLocal.session_decisions).toBe(1);
    expect(total(preview.conflicts) + total(preview.replacedLocal)).toBe(0);
    expect(machines.a.importProjectData(input).changed).toBe(false);
    expect(layout(machines.a, machines.sessionId).map((decision) => decision.id)).toEqual(["l0"]);
  });

  it("takes the reviewed copy over a pending one and re-points its attention preference", () => {
    const machines = createMachines();
    setDecisions(machines.a, machines, [d("l0", "D", "pending"), d("l1", "D", "pending")], ["D", "D"], OLD);
    setDecisions(machines.b, machines, [d("i0", "D"), d("i1", "D", "pending")], ["D", "D"], OLD);
    insert(
      machines.a,
      "attention_preferences",
      row("attention_preferences", {
        id: "preference-l0",
        project_id: machines.projectId,
        kind: "decision",
        source_id: "l0",
        source_revision: "r1",
        state: "hidden",
        revision: 1,
        updated_at: OLD,
      }),
    );
    const input = fileOf(machines, "b", "merge");

    const preview = machines.a.previewProjectDataImport(input);
    expect(preview.replacedLocal).toEqual({ session_decisions: 1 });
    expect(preview.additions.session_decisions).toBe(1);
    expect(preview.keptLocal.session_decisions).toBe(1);
    machines.a.importProjectData(input);

    expect(layout(machines.a, machines.sessionId).map((decision) => decision.id)).toEqual(["i0", "l1"]);
    expect(read(machines.a, "SELECT id, source_id, state FROM attention_preferences")).toEqual([
      { id: "preference-l0", source_id: "i0", state: "hidden" },
    ]);
  });

  it("keeps the Knowledge item and the review request a replaced decision cites", () => {
    const machines = createMachines();
    insert(
      machines.a,
      "knowledge",
      row("knowledge", {
        id: "knowledge-1",
        project_id: machines.projectId,
        session_id: machines.sessionId,
        idempotency_key: "knowledge-1-key",
        kind: "pattern",
        title: "Cited Knowledge",
        body: "Kept when its decision is replaced.",
        tags_json: "[]",
        references_json: "[]",
        status: "active",
        created_at: OLD,
        updated_at: OLD,
        applies_to_json: "[]",
      }),
    );
    insert(
      machines.a,
      "agent_review_requests",
      row("agent_review_requests", {
        id: "request-1",
        project_id: machines.projectId,
        idempotency_key: "request-1-key",
        status: "completed",
        requested_at: OLD,
        item_count: 1,
        omitted_count: 0,
      }),
    );
    setDecisions(
      machines.a,
      machines,
      [{ ...d("w0", "W0"), knowledgeId: "knowledge-1", reviewRequestId: "request-1" }, d("x1", "X1")],
      ["M0", "X1"],
      OLD,
    );
    setDecisions(machines.b, machines, [d("m0", "M0"), d("x1", "X1")], ["M0", "X1"], OLD);

    const result = machines.a.importProjectData(fileOf(machines, "b", "merge"));

    expect(result.replacedLocal).toEqual({ session_decisions: 1 });
    expect(read(machines.a, "SELECT id FROM knowledge")).toEqual([{ id: "knowledge-1" }]);
    expect(read(machines.a, "SELECT id FROM agent_review_requests")).toEqual([{ id: "request-1" }]);
    expect(layout(machines.a, machines.sessionId).map((decision) => decision.id)).toEqual(["m0", "x1"]);
  });

  it("deletes the attention preference of a replaced decision", () => {
    const machines = staleMachines();
    insert(
      machines.a,
      "attention_preferences",
      row("attention_preferences", {
        id: "preference-w0",
        project_id: machines.projectId,
        kind: "decision",
        source_id: "w0",
        source_revision: "r1",
        state: "hidden",
        revision: 1,
        updated_at: OLD,
      }),
    );

    machines.a.importProjectData(fileOf(machines, "b", "merge"));

    expect(read(machines.a, "SELECT id FROM attention_preferences")).toEqual([]);
  });

  it("keeps today's conflicts when neither side matches the summary, and removes nothing for an empty file set", () => {
    const neither = createMachines();
    setDecisions(neither.a, neither, staleLocal, ["M0", "M1", "S2", "S3"], OLD);
    setDecisions(neither.b, neither, rewritten, ["M0", "M1", "S2", "S3"], OLD);
    const preview = neither.a.previewProjectDataImport(fileOf(neither, "b", "merge"));
    expect(preview.conflicts.session_decisions).toBe(2);
    expect(preview.replacedLocal).toEqual({});

    const freeSlot = createMachines();
    setDecisions(freeSlot.a, freeSlot, staleLocal.slice(0, 2), ["S0", "S1", "S2", "S3"], OLD);
    setDecisions(freeSlot.b, freeSlot, [...rewritten.slice(0, 3)], ["S0", "S1", "S2", "S3"], OLD);
    const freePreview = freeSlot.a.previewProjectDataImport(fileOf(freeSlot, "b", "merge"));
    expect(freePreview.additions.session_decisions).toBe(1);
    expect(freePreview.conflicts.session_decisions).toBe(2);

    const empty = staleMachines();
    setDecisions(empty.b, empty, [], texts(rewritten), OLD);
    const emptyPreview = empty.a.previewProjectDataImport(fileOf(empty, "b", "merge"));
    expect(emptyPreview.replacedLocal).toEqual({});
    expect(empty.a.importProjectData(fileOf(empty, "b", "merge")).changed).toBe(false);
    expect(layout(empty.a, empty.sessionId)).toHaveLength(4);
  });

  it("does not replace when the imported text is redacted and the local one is not", () => {
    const machines = newerMachines([d("w0", "W0")], [d("m0", "Use ghp_abcdefghijklmnopqrstuvwxyz0123456789")]);
    const input = fileOf(machines, "b", "newer-wins");

    const preview = machines.a.previewProjectDataImport(input);
    expect(preview.replacedLocal).toEqual({});
    machines.a.importProjectData(input);
    expect(input.bundle.tables.session_decisions[0]?.text).toContain("[REDACTED:");
    expect(texts(layout(machines.a, machines.sessionId))).toEqual(["W0"]);
  });

  it("keeps a stale file's rows, shared ids included, when the sets differ in length", () => {
    const machines = createMachines();
    setDecisions(machines.a, machines, [d("w0", "W0"), d("w1", "W1"), d("x2", "X2")], ["M0", "X2"], OLD);
    setDecisions(machines.b, machines, [d("m0", "M0"), d("x2", "X2")], ["M0", "X2"], OLD);

    for (const [target, from] of [
      [machines.b, "a"],
      [machines.a, "b"],
    ] as const) {
      const preview = target.previewProjectDataImport(fileOf(machines, from, "merge"));
      expect(total(preview.conflicts)).toBe(0);
    }
    const intoB = machines.b.importProjectData(fileOf(machines, "a", "merge"));
    expect(intoB.changed).toBe(false);
    const intoA = machines.a.importProjectData(fileOf(machines, "b", "merge"));
    expect(intoA.replacedLocal).toEqual({ session_decisions: 2 });
    expect(layout(machines.a, machines.sessionId)).toEqual(layout(machines.b, machines.sessionId));
  });

  it("does not swap a pending row across a position gap", () => {
    const machines = createMachines();
    setDecisions(machines.a, machines, [d("la", "A", "pending"), d("lq", "Q", "pending")], ["A", "Q"], OLD);
    run(machines.a, "UPDATE session_decisions SET position = 2 WHERE id = 'lq'");
    setDecisions(machines.b, machines, [d("ia", "A"), d("iq", "Q")], ["A", "Q"], OLD);

    const result = machines.a.importProjectData(fileOf(machines, "b", "merge"));

    expect(result.replacedLocal).toEqual({ session_decisions: 1 });
    expect(layout(machines.a, machines.sessionId)).toEqual([
      { id: "ia", text: "A", position: 0 },
      { id: "lq", text: "Q", position: 2 },
    ]);
  });

  it("leaves the local rows alone when an imported id belongs to another Session", () => {
    const machines = newerMachines([d("w0", "W0"), d("w1", "W1")], [d("m0", "M0")]);
    const other = machines.a.finalizeSession({
      projectRoot: machines.a.listProjects()[0]?.rootPath ?? "",
      idempotencyKey: "other-session",
      title: "Other session",
      summary: "Holds the id.",
      completedAt: OLD,
    });
    if (other.outcome !== "finalized") throw new Error("The Session must be accepted.");
    insert(
      machines.a,
      "session_decisions",
      row("session_decisions", {
        id: "m0",
        session_id: other.session.id,
        project_id: machines.projectId,
        position: 0,
        text: "Elsewhere",
        origin: "agent_autonomous",
        review_status: "confirmed",
      }),
    );
    const input = fileOf(machines, "b", "newer-wins");

    const preview = machines.a.previewProjectDataImport(input);
    expect(preview.replacedLocal).toEqual({});
    machines.a.importProjectData(input);
    expect(texts(layout(machines.a, machines.sessionId))).toEqual(["W0", "W1"]);
  });

  it("behaves the same for a streamed file whose long values are spilled", () => {
    const machines = staleMachines();
    const directory = mkdtempSync(join(tmpdir(), "wi-decision-sets-spill-"));
    tempDirs.push(directory);
    const streamed = readProjectDataImportBytes(Buffer.from(JSON.stringify(fileOf(machines, "b", "merge"))), {
      envelope: "request",
      spillPath: join(directory, "import.spill"),
    });
    try {
      const preview = machines.a.previewProjectDataImport(streamed);
      expect(preview.replacedLocal).toEqual({ session_decisions: 2 });
      expect(total(preview.conflicts)).toBe(0);
      machines.a.importProjectData(streamed);
    } finally {
      streamed.dispose();
    }
    expect(layout(machines.a, machines.sessionId)).toEqual(layout(machines.b, machines.sessionId));
  });

  it("reports the same counts in the preview, the result and the audit", () => {
    const machines = staleMachines();
    const input = fileOf(machines, "b", "merge");
    const preview = machines.a.previewProjectDataImport(input);

    const result = machines.a.importProjectData(input);

    expect(result.replacedLocal).toEqual(preview.replacedLocal);
    expect(result.additions).toEqual(preview.additions);
    expect(result.skipped).toEqual(preview.skipped);
    const [audit] = read<{ remapped_paths_json: string }>(
      machines.a,
      "SELECT remapped_paths_json FROM project_data_import_audits",
    );
    expect(JSON.parse(audit?.remapped_paths_json ?? "{}")).toMatchObject({ replacedLocal: { session_decisions: 2 } });
  });

  it("replans when the data changes after the backup was taken", () => {
    const machines = staleMachines();
    const input = fileOf(machines, "b", "merge");
    const service = (machines.a as unknown as { projectDataTransfer: { backupBeforeImport(): string | undefined } })
      .projectDataTransfer;
    const backup = service.backupBeforeImport.bind(service);
    vi.spyOn(service, "backupBeforeImport").mockImplementation(() => {
      const fileName = backup();
      run(machines.a, "DELETE FROM session_decisions WHERE id = 'w1'");
      return fileName;
    });

    const result = machines.a.importProjectData(input);

    expect(result.replacedLocal).toEqual({ session_decisions: 1 });
    expect(layout(machines.a, machines.sessionId)).toEqual(layout(machines.b, machines.sessionId));
  });
});
