import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_READ_FIELDS, type SessionProjectionResult } from "../../packages/core/src/index.js";
import { sessionDetailQuerySchema } from "../../packages/schema/src/index.js";
import { extractAgentReadRecords } from "../../packages/storage/src/agent-read-audit-service.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const cleanup: Array<() => void> = [];
function setup(disk = false) {
  const root = mkdtempSync(join(tmpdir(), "wi-projection-test-"));
  const store = new WorkIntelligenceStore(disk ? join(root, "test.sqlite") : ":memory:");
  cleanup.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const project = store.addProject("Synthetic Cedar", root);
  store.updateProject(project.id, { status: "tracked" });
  const result = store.finalizeSession({
    projectRoot: root,
    idempotencyKey: "source",
    title: "Fictional implementation",
    summary: "Automated checks complete; device check pending",
    workSummary: {
      outcomes: ["Implemented change"],
      scope: ["src/example.ts"],
      decisions: [{ text: "Retain manual zoom", origin: "agent_autonomous" }],
      verification: ["Automated checks passed"],
      nextSteps: ["Physical device check"],
    },
    changedFiles: ["src/example.ts"],
    git: { commitSha: "a".repeat(40), branch: "codex/example" },
    verification: { status: "in_progress", summary: "Device check pending" },
    handoffContent: "😀 Synthetic snapshot",
    events: [{ type: "execution", summary: "Fictional event", details: { body: "Synthetic detail" } }],
  });
  if (result.outcome !== "finalized") throw new Error("Fixture failed");
  const id = result.session.id;
  store.attachEvidence({ sessionId: id, kind: "test", reference: "synthetic:test", summary: "Fictional evidence" });
  store.attachDiagram({
    sessionId: id,
    idempotencyKey: "native",
    title: "Fictional native source",
    kind: "architecture",
    formatVersion: 1,
    source: JSON.stringify({ version: 1, nodes: [{ id: "entry", label: "Entry" }] }),
  });
  store.recordKnowledge({
    projectRoot: root,
    sessionId: id,
    idempotencyKey: "gotcha",
    kind: "gotcha",
    title: "Fictional gotcha",
    body: "Preserve source review flags",
    appliesTo: ["src/example.ts"],
  });
  const db = (store as unknown as { db: DatabaseSync }).db;
  return { store, root, project, id, db };
}
function projectRead(
  store: WorkIntelligenceStore,
  id: string,
  select?: SessionProjectionResult["projection"]["includedFields"],
  view?: "completion" | "handoff",
) {
  const result = store.getSessionDetailForAgent({ sessionId: id, ...(select ? { select } : { view }) });
  if (result.outcome !== "session_detail" || !("projection" in result)) throw new Error("Expected projection");
  return result;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const run of cleanup.splice(0).reverse()) run();
});

describe("Agent Session projection", () => {
  it("preserves every selected family value and the old full result", () => {
    const { store, id } = setup();
    const full = store.getSessionDetailForAgent({ sessionId: id });
    if (full.outcome !== "session_detail") throw new Error("Expected full");
    expect(full).not.toHaveProperty("projection");
    expect(full).toHaveProperty("project");
    const result = projectRead(store, id, [...SESSION_READ_FIELDS]);
    expect(result.session).toMatchObject({
      summary: full.session.summary,
      workSummary: full.session.workSummary,
      changedFiles: full.session.changedFiles,
      changedFilesProvenance: full.session.changedFilesProvenance,
      changedFileChanges: full.session.changedFileChanges,
      verification: full.session.verification,
      commitSha: full.session.commitSha,
      gitBranch: full.session.gitBranch,
    });
    for (const field of [
      "decisions",
      "links",
      "verificationHistory",
      "voidHistory",
      "events",
      "evidence",
      "knowledge",
      "diagrams",
      "rawSnapshots",
    ] as const)
      expect(result[field]).toEqual(full[field]);
    expect(result.projection.unavailableFields).toEqual([]);
    expect(result).not.toHaveProperty("project");
    expect(store.getSessionDetailForAgent({ sessionId: id })).toEqual(full);
  });
  it("expands safety dependencies in canonical order, independent of input order", () => {
    const { store, id } = setup();
    const fields = ["session.workSummary.decisions", "session.verification"] as const;
    const result = projectRead(store, id, [...fields]);
    expect(result.projection.includedFields).toEqual([
      "session.workSummary.decisions",
      "session.verification",
      "decisions",
      "verificationHistory",
    ]);
    expect(projectRead(store, id, [...fields].reverse())).toEqual(result);
    expect(result.decisions?.[0]).toMatchObject({ origin: "agent_autonomous", reviewStatus: "pending" });
    expect(result.session.workSummary).toEqual({ decisions: ["Retain manual zoom"] });
    expect(result).not.toHaveProperty("events");
    expect(result.session).not.toHaveProperty("changedFiles");
  });
  it("performs zero queries and JSON parsing for unselected heavy families", () => {
    const { store, id, db } = setup();
    const prepared = vi.spyOn(db, "prepare");
    projectRead(store, id, ["session.summary"]);
    const sql = prepared.mock.calls.map(([text]) => text).join("\n");
    expect(sql).not.toMatch(
      /work_events|raw_snapshots|evidence|session_diagrams|session_decisions|session_links|verification_updates|void_audit|FROM knowledge/i,
    );
    expect(sql).not.toMatch(/work_summary_json|changed_files_json|verification_json|SELECT s\.\*/);
  });
  it("gates project policy before reading content or any heavy family", () => {
    const { store, id, db, project } = setup();
    store.updateProject(project.id, { status: "paused" });
    const prepared = vi.spyOn(db, "prepare");
    expect(store.getSessionDetailForAgent({ sessionId: id, view: "handoff" })).toMatchObject({
      outcome: "skipped",
      projectStatus: "paused",
    });
    expect(prepared.mock.calls.map(([sql]) => sql).join("\n")).not.toMatch(
      /summary|work_events|raw_snapshots|session_links|session_diagrams/,
    );
    expect(store.getSessionDetailForAgent({ sessionId: "missing", view: "completion" })).toEqual({
      outcome: "not_found",
      sessionId: "missing",
      reason: "Session does not exist.",
    });
  });
  it("preserves historical missing fields separately from selected empty relations", () => {
    const { store, id, db } = setup();
    db.prepare(
      "UPDATE sessions SET work_summary_json = ?, verification_json = NULL, commit_sha = NULL, git_branch = NULL WHERE id = ?",
    ).run(JSON.stringify({ outcomes: [] }), id);
    const result = projectRead(store, id, [
      "session.workSummary.outcomes",
      "session.workSummary.nextSteps",
      "session.verification",
      "session.git",
      "links",
    ]);
    expect(result.session.workSummary).toEqual({ outcomes: [] });
    expect(result.session).not.toHaveProperty("verification");
    expect(result.links).toEqual([]);
    expect(result.projection.unavailableFields).toEqual([
      "session.workSummary.nextSteps",
      "session.verification",
      "session.git",
    ]);
  });
  it("does not turn historical unconfirmed file metadata into known no-change work", () => {
    const { store, id, db } = setup();
    db.prepare("UPDATE sessions SET changed_files_json = '[]', changed_files_confirmed = 0 WHERE id = ?").run(id);
    const unknown = projectRead(store, id, ["session.changedFiles"]);
    expect(unknown.session).not.toHaveProperty("changedFiles");
    expect(unknown.projection.unavailableFields).toEqual(["session.changedFiles"]);
    db.prepare("UPDATE sessions SET changed_files_confirmed = 1 WHERE id = ?").run(id);
    const confirmed = projectRead(store, id, ["session.changedFiles"]);
    expect(confirmed.session.changedFiles).toEqual([]);
    expect(confirmed.projection.unavailableFields).toEqual([]);
  });
  it("preserves corrected verification, rejected decisions and voided sources", () => {
    const { store, id, root } = setup();
    store.updateSessionVerification(id, { status: "failed", summary: "A real failure" });
    const full = store.getSessionDetail(id)!;
    store.reviewSessionDecision({ decisionId: full.decisions[0]!.id, projectRoot: root, reviewStatus: "rejected" });
    store.setEvidenceVoid({ evidenceId: full.evidence[0]!.id, voided: true, reason: "Synthetic obsolete evidence" });
    store.setDiagramVoid({ diagramId: full.diagrams[0]!.id, voided: true, reason: "Synthetic obsolete source" });
    store.setSessionVoid({ sessionId: id, voided: true, reason: "Fictional fixture source" });
    const result = projectRead(store, id, [
      "session.workSummary.decisions",
      "session.verification",
      "evidence",
      "diagrams",
      "knowledge",
    ]);
    expect(result.session.voided?.reason).toBe("Fictional fixture source");
    expect(result.session.verification?.status).toBe("failed");
    expect(result.verificationHistory?.[0]?.resulting.status).toBe("failed");
    expect(result.decisions?.[0]?.reviewStatus).toBe("rejected");
    expect(result.evidence?.[0]?.voided).toBeDefined();
    expect(result.diagrams?.[0]?.voided).toBeDefined();
    expect(result.knowledge).toEqual(store.getSessionDetail(id)!.knowledge);
  });
  it("preserves UTF-16 snapshot lengths and explicitly opts into raw content", () => {
    const { store, id } = setup();
    const summary = projectRead(store, id, ["rawSnapshots"]);
    expect(summary.rawSnapshots?.[0]).toMatchObject({ contentLength: "😀 Synthetic snapshot".length });
    expect(summary.rawSnapshots?.[0]).not.toHaveProperty("content");
    const raw = store.getSessionDetailForAgent({ sessionId: id, select: ["rawSnapshots"], includeRawSnapshots: true });
    expect(raw).toMatchObject({ rawSnapshots: [{ content: "😀 Synthetic snapshot" }] });
  });
  it("records the returned Session identity even when summary is omitted", () => {
    const { store, id } = setup();
    const result = projectRead(store, id, ["session.changedFiles"]);
    expect(extractAgentReadRecords(result).sessionIds).toEqual([id]);
    expect(extractAgentReadRecords(result).knowledgeIds).toEqual([]);
    expect(extractAgentReadRecords(projectRead(store, id, ["knowledge"])).knowledgeIds).toHaveLength(1);
  });
  it("uses one deferred read snapshot without blocking another WAL writer", () => {
    const { store, id, db } = setup(true);
    const writer = new DatabaseSync(store.databasePath);
    const original = db.prepare.bind(db);
    let raced = false;
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (!raced && sql.startsWith("SELECT id, project_id")) {
        raced = true;
        writer
          .prepare("UPDATE sessions SET summary = ?, verification_json = ? WHERE id = ?")
          .run("Later summary", JSON.stringify({ status: "failed" }), id);
      }
      return original(sql);
    });
    try {
      const result = projectRead(store, id, ["session.summary", "session.verification"]);
      expect(raced).toBe(true);
      expect(result.session.summary).toBe("Automated checks complete; device check pending");
      expect(result.session.verification?.status).toBe("in_progress");
    } finally {
      writer.close();
    }
    expect(projectRead(store, id, ["session.summary"]).session.summary).toBe("Later summary");
  });
  it("preserves linked void state and stale Knowledge without per-row reads", () => {
    const { store, root, id, db } = setup();
    const later = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "later",
      title: "Synthetic later source",
      summary: "Synthetic later files changed",
      changedFiles: ["src/example.ts"],
      verification: { status: "passed" },
    });
    if (later.outcome !== "finalized") throw new Error("Fixture failed");
    store.linkSessions({ sessionId: id, relatedSessionId: later.session.id, relation: "related", linked: true });
    const originalKnowledge = store.getSessionDetail(id)!.knowledge[0]!;
    db.prepare("UPDATE knowledge SET created_at = ?, updated_at = ?, last_confirmed_at = NULL WHERE id = ?").run(
      "2025-01-01T00:00:00.000Z",
      "2025-01-01T00:00:00.000Z",
      originalKnowledge.id,
    );
    const first = projectRead(store, id, ["knowledge"]);
    expect(first.knowledge?.[0]?.possiblyStale).toBeDefined();
    const prepared = vi.spyOn(db, "prepare");
    projectRead(store, id, ["knowledge"]);
    const oneCount = prepared.mock.calls.length;
    prepared.mockClear();
    for (let index = 0; index < 9; index++)
      store.recordKnowledge({
        projectRoot: root,
        sessionId: id,
        idempotencyKey: `batch-${index}`,
        kind: "gotcha",
        title: `Fictional gotcha ${index}`,
        body: "Synthetic batch detail",
        appliesTo: ["src/example.ts"],
      });
    prepared.mockClear();
    const many = projectRead(store, id, ["knowledge"]);
    expect(many.knowledge).toHaveLength(10);
    expect(prepared.mock.calls.length).toBe(oneCount);
    store.setSessionVoid({ sessionId: later.session.id, voided: true, reason: "Fictional stale link" });
    const links = projectRead(store, id, ["links"]);
    expect(links.links?.[0]).toMatchObject({ sessionId: later.session.id, voided: true });
  });
  it("rejects invalid field selection and ambiguous raw options", () => {
    for (const options of [
      { select: [] },
      { select: ["session"] },
      { select: ["*"] },
      { select: ["events", "events"] },
      { view: "completion", select: ["events"] },
      { view: "completion", includeRawSnapshots: true },
      { select: ["events"], includeRawSnapshots: true },
      { view: "unknown" },
    ])
      expect(sessionDetailQuerySchema.safeParse({ sessionId: "synthetic", ...options }).success).toBe(false);
    expect(
      sessionDetailQuerySchema.safeParse({
        sessionId: "synthetic",
        select: ["rawSnapshots"],
        includeRawSnapshots: true,
      }).success,
    ).toBe(true);
    expect(sessionDetailQuerySchema.safeParse({ sessionId: "synthetic", includeRawSnapshots: true }).success).toBe(
      true,
    );
  });
});
