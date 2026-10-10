import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttentionItem, UpdateAttentionPreference } from "../../packages/core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";
import { AttentionService, AttentionPreferenceError } from "../../packages/storage/src/attention-service.js";

const resources: Array<{ store: WorkIntelligenceStore; root: string }> = [];

function setup() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2026, 8, 7, 12));
  const root = mkdtempSync(join(tmpdir(), "wi-attention-"));
  const projectRoot = join(root, "orchard");
  const otherRoot = join(root, "apiary");
  mkdirSync(projectRoot);
  mkdirSync(otherRoot);
  const databasePath = join(root, "fictional.sqlite");
  const store = new WorkIntelligenceStore(databasePath);
  resources.push({ store, root });
  const project = store.addProject("Orchard", projectRoot);
  store.updateProject(project.id, { status: "tracked" });
  const other = store.addProject("Apiary", otherRoot);
  store.updateProject(other.id, { status: "tracked" });
  function finalize(
    key: string,
    options: {
      root?: string;
      decisions?: number;
      openItems?: string[];
      missing?: boolean;
      files?: string[];
      contradicted?: string[];
    } = {},
  ) {
    vi.setSystemTime(Date.now() + 60_000);
    const result = store.finalizeSession({
      projectRoot: options.root ?? projectRoot,
      idempotencyKey: key,
      title: `Fictional ${key}`,
      summary: "Saved fictional work.",
      workSummary: {
        outcomes: [],
        scope: [],
        decisions: Array.from({ length: options.decisions ?? 0 }, (_, i) => ({
          text: `Fictional decision ${key}-${i}`,
          origin: "agent_autonomous" as const,
        })),
        verification: [],
        nextSteps: options.openItems ?? [],
      },
      ...(!options.missing ? { changedFiles: options.files ?? [], verification: { status: "passed" as const } } : {}),
      ...(options.contradicted ? { contradictedKnowledgeIds: options.contradicted } : {}),
    });
    if (result.outcome !== "finalized") throw new Error("Expected fixture Session");
    return result.session;
  }
  return { store, projectRoot, otherRoot, project, other, databasePath, finalize };
}

function firstItem(store: WorkIntelligenceStore, projectId: string, kind: AttentionItem["kind"], view?: "suppressed") {
  const result = store.getAttention({ projectId, kind, view });
  if (result.outcome !== "attention" || !result.items[0]) throw new Error("Expected a fictional pointer");
  return result.items[0];
}
function intent(item: AttentionItem, action: UpdateAttentionPreference["action"]): UpdateAttentionPreference {
  if (!item.projectId || !item.preference) throw new Error("Expected single-project preference");
  return {
    projectId: item.projectId,
    kind: item.kind,
    sourceId: item.sourceId,
    sourceRevision: item.sourceRevision,
    expectedRevision: item.preference.revision,
    action,
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const { store, root } of resources.splice(0)) {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

describe("attention aggregate", () => {
  it("combines stored reminders while leaving source statuses unchanged", () => {
    const { store, projectRoot, project, finalize } = setup();
    const knowledge = store.recordKnowledge({
      projectRoot,
      idempotencyKey: "rule",
      kind: "gotcha",
      title: "Fictional rule",
      body: "Check source metadata.",
      appliesTo: ["src/api.ts"],
    });
    if (knowledge.outcome !== "knowledge_recorded") throw new Error("Expected knowledge");
    finalize("changes", {
      decisions: 2,
      openItems: ["First unresolved item", "Second unresolved item"],
      files: ["src/api.ts"],
      contradicted: [knowledge.knowledge.id],
    });
    finalize("legacy", { missing: true });
    store.requestKnowledgePageUpdate({ projectRoot, slug: "architecture" });
    store.createReportSynthesisRequest({
      period: "day",
      date: "2026-09-07",
      projectId: project.id,
      idempotencyKey: "report",
    });
    store.createMetadataBackfillRequest({ projectId: project.id });
    const result = store.getAttention({ projectId: project.id, pageSize: 50 });
    expect(result.outcome).toBe("attention");
    if (result.outcome !== "attention") return;
    expect(result.groups.every((group) => group.state === "complete")).toBe(true);
    expect(new Set(result.items.map((item) => item.kind))).toEqual(
      new Set(["synthesis", "backfill", "decision", "knowledge", "knowledge_page", "outstanding", "metadata"]),
    );
    expect(result.items.find((item) => item.kind === "outstanding")?.count).toBe(2);
    expect(result.items.find((item) => item.kind === "knowledge")).toMatchObject({
      reason: "review",
      sourceId: knowledge.knowledge.id,
    });
    expect(store.listSessionDecisions().outcome === "session_decisions" && store.listSessionDecisions()).toMatchObject({
      pendingCount: 2,
    });
    expect(store.listOutstandingItems({ projectId: project.id })).toMatchObject({ pageInfo: { total: 2 } });
    expect(store.getAttention({ projectId: project.id, pageSize: 50 })).toEqual(result);
    expect(result.items.every((item) => !JSON.stringify(item).includes(projectRoot))).toBe(true);
  });

  it("re-gates global request sources and hides paused, unknown and voided data", () => {
    const { store, projectRoot, project, other, otherRoot, finalize } = setup();
    const source = finalize("visible", { decisions: 1 });
    finalize("other", { root: otherRoot, decisions: 1 });
    store.createReportSynthesisRequest({ period: "day", date: "2026-09-07", idempotencyKey: "global" });
    store.updateProject(other.id, { status: "paused" });
    const result = store.getAttention();
    expect(result.outcome).toBe("attention");
    if (result.outcome !== "attention") return;
    expect(result.items.every((item) => item.projectId !== other.id)).toBe(true);
    expect(result.items.some((item) => item.kind === "synthesis")).toBe(false);
    expect(store.getAttention({ projectId: other.id })).toMatchObject({ outcome: "skipped", projectStatus: "paused" });
    expect(store.getAttention({ projectId: "absent" })).toMatchObject({
      outcome: "skipped",
      projectStatus: "unregistered",
    });
    store.setSessionVoid({ sessionId: source.id, voided: true, reason: "Fictional duplicate" });
    expect(store.getAttention({ projectId: project.id, kind: "decision" })).toMatchObject({ items: [], total: 0 });
    expect(store.listKnowledgePages({ projectRoot }).outcome).toBe("knowledge_pages");
  });

  it("keeps only the latest request per scope even if an older pending row remains", () => {
    const { store, project, databasePath, finalize } = setup();
    finalize("source");
    const first = store.createReportSynthesisRequest({
      period: "day",
      date: "2026-09-07",
      projectId: project.id,
      idempotencyKey: "old",
    });
    if (first.outcome !== "report_synthesis_request") throw new Error("Expected request");
    store.cancelReportSynthesisRequest(first.request.id);
    vi.setSystemTime(Date.now() + 60_000);
    const second = store.createReportSynthesisRequest({
      period: "day",
      date: "2026-09-07",
      projectId: project.id,
      idempotencyKey: "new",
    });
    if (second.outcome !== "report_synthesis_request") throw new Error("Expected second request");
    const db = new DatabaseSync(databasePath);
    try {
      db.prepare("UPDATE report_synthesis_requests SET status = 'pending' WHERE id = ?").run(first.request.id);
      db.prepare("UPDATE report_synthesis_requests SET status = 'completed' WHERE id = ?").run(second.request.id);
    } finally {
      db.close();
    }
    expect(store.getAttention({ kind: "synthesis" })).toMatchObject({ items: [], total: 0 });
  });

  it("returns exact matching counts separately from the bounded decision window", () => {
    const { store, finalize } = setup();
    for (let i = 0; i < 11; i++) finalize(`many-${i}`, { decisions: 20 });
    const result = store.getAttention({ kind: "decision", page: 99, pageSize: 50 });
    expect(result.outcome).toBe("attention");
    if (result.outcome !== "attention") return;
    expect(result).toMatchObject({ total: 220, minimumTotal: 220, pageInfo: { total: 200, page: 4, pageSize: 50 } });
    expect(result.groups[0]).toMatchObject({ state: "partial", total: 220, examined: 200, available: 220 });
    expect(result.items).toHaveLength(50);
    expect(new Set(result.items.map((item) => item.id)).size).toBe(50);
  });

  it("reports unknown Knowledge coverage instead of asserting a healthy empty queue", () => {
    const { store, projectRoot } = setup();
    for (let i = 0; i < 201; i++)
      store.recordKnowledge({
        projectRoot,
        idempotencyKey: `rule-${i}`,
        kind: "pattern",
        title: `Rule ${i}`,
        body: "Fictional source.",
      });
    expect(store.getAttention({ kind: "knowledge" })).toMatchObject({
      items: [],
      total: null,
      minimumTotal: 0,
      groups: [{ state: "partial", total: null, examined: 200, available: 201 }],
    });
  });

  it("masks a failed source and continues to report the known coverage", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const service = new AttentionService(db, {
        checkProjectById: () => ({ allowed: false, projectStatus: "paused", canonicalRoot: "/fictional" }),
        refreshRequests: () => {},
        pages: () => ({ items: [], total: 0 }),
        knowledge: () => {
          throw new Error("private SQL body secret");
        },
      });
      const result = service.list({ kind: "knowledge" });
      expect(result).toMatchObject({
        outcome: "attention",
        total: null,
        groups: [{ kind: "knowledge", state: "failed" }],
      });
      expect(JSON.stringify(result)).not.toContain("secret");
    } finally {
      db.close();
    }
  });
});

describe("attention display preferences", () => {
  it("hides, lists and restores without resolving source state, and rejects another window's stale write", () => {
    const { store, project, finalize } = setup();
    finalize("source", { decisions: 1 });
    const item = firstItem(store, project.id, "decision");
    expect(store.updateAttentionPreference(intent(item, "hide"))).toMatchObject({
      preference: { state: "hidden", revision: 1 },
    });
    expect(store.getAttention({ projectId: project.id, kind: "decision" })).toMatchObject({
      items: [],
      total: 1,
      minimumTotal: 1,
      suppressedCount: 1,
      pageInfo: { total: 0 },
    });
    expect(store.listSessionDecisions()).toMatchObject({ pendingCount: 1 });
    expect(() => store.updateAttentionPreference(intent(item, "snooze"))).toThrow(AttentionPreferenceError);
    const hidden = firstItem(store, project.id, "decision", "suppressed");
    expect(hidden.id).toBe(item.id);
    store.updateAttentionPreference(intent(hidden, "restore"));
    expect(firstItem(store, project.id, "decision").preference).toEqual({ state: "visible", revision: 2 });
  });
  it("uses server time for seven days and resurfaces a new issue even when count and latest source time match", () => {
    const { store, project, databasePath, finalize } = setup();
    finalize("source", { openItems: ["Fictional old issue"] });
    const item = firstItem(store, project.id, "outstanding");
    const saved = store.updateAttentionPreference(intent(item, "snooze"));
    expect(saved).toMatchObject({ preference: { snoozedUntil: new Date(Date.now() + 7 * 86400000).toISOString() } });
    vi.setSystemTime(Date.now() + 7 * 86400000);
    expect(firstItem(store, project.id, "outstanding").preference?.state).toBe("visible");
    const current = firstItem(store, project.id, "outstanding");
    store.updateAttentionPreference(intent(current, "hide"));
    const db = new DatabaseSync(databasePath);
    try {
      db.exec(`INSERT INTO outstanding_items (id,source_session_id,project_id,position,text,status,created_at,updated_at)
        SELECT 'replacement',source_session_id,project_id,position,'Fictional new issue','pending',created_at,updated_at FROM outstanding_items LIMIT 1;
        UPDATE outstanding_items SET status='completed' WHERE id!='replacement';`);
    } finally {
      db.close();
    }
    const changed = firstItem(store, project.id, "outstanding");
    expect(changed.count).toBe(item.count);
    expect(changed.updatedAt).toBe(item.updatedAt);
    expect(changed.sourceRevision).not.toBe(item.sourceRevision);
    expect(changed.preference).toEqual({ revision: 2, state: "visible" });
    expect(() =>
      store.updateAttentionPreference({ ...intent(changed, "hide"), sourceRevision: item.sourceRevision }),
    ).toThrow(AttentionPreferenceError);
  });
  it("rechecks policy, source ownership and void state, and never offers preferences for a global request", () => {
    const { store, project, other, finalize } = setup();
    const source = finalize("source", { decisions: 1 });
    const item = firstItem(store, project.id, "decision");
    expect(() => store.updateAttentionPreference({ ...intent(item, "hide"), projectId: other.id })).toThrow(
      AttentionPreferenceError,
    );
    store.createReportSynthesisRequest({ period: "day", date: "2026-09-07", idempotencyKey: "global" });
    const global = store.getAttention({ kind: "synthesis" });
    if (global.outcome !== "attention") throw new Error("Expected aggregate");
    expect(global.items[0]?.preference).toBeUndefined();
    store.updateProject(project.id, { status: "paused" });
    expect(store.updateAttentionPreference(intent(item, "hide"))).toMatchObject({ outcome: "skipped" });
    store.updateProject(project.id, { status: "tracked" });
    store.setSessionVoid({ sessionId: source.id, voided: true, reason: "Fictional void" });
    expect(() => store.updateAttentionPreference(intent(item, "hide"))).toThrow(AttentionPreferenceError);
  });
  it("exports intents, restores display on import, accepts old bundles, and removes preferences on permanent deletion", () => {
    const { store, project, finalize } = setup();
    const source = finalize("source", { decisions: 1 });
    store.updateAttentionPreference(intent(firstItem(store, project.id, "decision"), "hide"));
    const bundle = store.exportProjectData({ type: "project", projectId: project.id });
    expect(bundle.tables.attention_preferences).toHaveLength(1);
    const target = new WorkIntelligenceStore(":memory:");
    const legacyTarget = new WorkIntelligenceStore(":memory:");
    try {
      expect(Object.values(target.importProjectData({ bundle }).conflicts).every((count) => count === 0)).toBe(true);
      target.updateProject(project.id, { status: "tracked" });
      expect(firstItem(target, project.id, "decision").preference).toEqual({ state: "visible", revision: 1 });
      const legacy = structuredClone(bundle);
      Reflect.deleteProperty(legacy.tables, "attention_preferences");
      expect(
        Object.values(legacyTarget.importProjectData({ bundle: legacy }).conflicts).every((count) => count === 0),
      ).toBe(true);
      store.setSessionVoid({ sessionId: source.id, voided: true, reason: "Fictional void" });
      store.deleteSession(source.id);
      expect(store.exportProjectData({ type: "project", projectId: project.id }).tables.attention_preferences).toEqual(
        [],
      );
      finalize("second", { decisions: 1 });
      store.updateAttentionPreference(intent(firstItem(store, project.id, "decision"), "hide"));
      expect(store.deleteProject(project.id, project.name).deletedCounts.attentionPreferences).toBe(1);
    } finally {
      target.close();
      legacyTarget.close();
    }
  });
});
