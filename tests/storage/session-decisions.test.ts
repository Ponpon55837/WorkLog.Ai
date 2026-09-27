import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Session decision provenance and review", () => {
  it("keeps legacy strings compatible, redacts text, preserves reviewed decisions, and links promotions to Knowledge", () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-session-decisions-"));
    tempDirs.push(root);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-26T12:00:00.000Z"));
    const store = new WorkIntelligenceStore(":memory:");
    stores.push(store);
    const project = store.addProject("Decision fixture", root);
    store.updateProject(project.id, { status: "tracked" });
    const fakeToken = `gho_${"A".repeat(36)}`;
    const finalized = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "session-decisions-finalize",
      title: "決策來源測試",
      summary: "測試 Agent 自主決策與舊格式相容。",
      completedAt: "2026-09-26T12:00:00.000Z",
      workSummary: {
        outcomes: [],
        scope: [],
        decisions: [
          { text: `自主選擇 ${fakeToken}`, origin: "agent_autonomous" },
          { text: "另一個自主選擇", origin: "agent_autonomous" },
          { text: "使用者要求的選擇", origin: "user_requested" },
          "舊格式決策",
        ],
        verification: [],
        nextSteps: [],
      },
    });
    expect(finalized.outcome).toBe("finalized");
    if (finalized.outcome !== "finalized") throw new Error("Expected a finalized Session.");

    const sessionId = finalized.session.id;
    const detail = store.getSessionDetail(sessionId);
    expect(detail?.session.workSummary?.decisions).toEqual([
      `自主選擇 [REDACTED:github_token]`,
      "另一個自主選擇",
      "使用者要求的選擇",
      "舊格式決策",
    ]);
    expect(detail?.decisions).toMatchObject([
      { text: "自主選擇 [REDACTED:github_token]", origin: "agent_autonomous", reviewStatus: "pending" },
      { text: "另一個自主選擇", origin: "agent_autonomous", reviewStatus: "pending" },
      { text: "使用者要求的選擇", origin: "user_requested", reviewStatus: "confirmed" },
      { text: "舊格式決策", origin: "unspecified", reviewStatus: "confirmed" },
    ]);
    expect(JSON.stringify(detail)).not.toContain(fakeToken);
    expect(finalized.session.redactionCount).toBeGreaterThan(0);
    expect(store.search("另一個自主選擇")).toEqual(
      expect.arrayContaining([expect.objectContaining({ session: expect.objectContaining({ id: sessionId }) })]),
    );

    const pending = store.listSessionDecisions({ projectRoot: root });
    expect(pending).toMatchObject({ outcome: "session_decisions", pendingCount: 2 });
    if (pending.outcome !== "session_decisions") throw new Error("Expected decision list.");
    const first = pending.items.find((item) => item.text.startsWith("自主選擇"));
    const second = pending.items.find((item) => item.text === "另一個自主選擇");
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) throw new Error("Expected both autonomous decisions.");

    expect(store.getContext(root)).toMatchObject({
      outcome: "context",
      pendingRequests: { agentDecisions: 2 },
    });
    const report = store.getReport({ period: "day", date: "2026-09-26", projectId: project.id });
    expect(report).toMatchObject({
      outcome: "report",
      agentAutonomousDecisions: {
        total: 2,
        pending: 2,
        pendingItems: [
          expect.objectContaining({ sessionId, sessionTitle: "決策來源測試" }),
          expect.objectContaining({ sessionId, sessionTitle: "決策來源測試" }),
        ],
      },
    });

    const confirmed = store.reviewSessionDecision({
      decisionId: first.id,
      projectRoot: root,
      reviewStatus: "confirmed",
    });
    expect(confirmed).toMatchObject({
      outcome: "session_decision_reviewed",
      duplicate: false,
      decision: { id: first.id, reviewStatus: "confirmed", reviewedAt: expect.any(String) },
    });
    expect(
      store.reviewSessionDecision({ decisionId: first.id, projectRoot: root, reviewStatus: "confirmed" }),
    ).toMatchObject({ outcome: "session_decision_reviewed", duplicate: true });

    const update = store.updateSessionWorkSummary({
      sessionId,
      idempotencyKey: "session-decisions-update",
      mode: "patch",
      workSummary: {
        decisions: [
          { text: "自主選擇 [REDACTED:github_token]", origin: "agent_autonomous" },
          { text: "另一個自主選擇", origin: "agent_autonomous" },
          { text: "新增自主選擇", origin: "agent_autonomous" },
        ],
      },
    });
    expect(update.outcome).toBe("work_summary_updated");
    const afterEdit = store.getSessionDetail(sessionId)?.decisions ?? [];
    expect(afterEdit).toMatchObject([
      { id: first.id, reviewStatus: "confirmed" },
      { id: second.id, reviewStatus: "pending" },
      { text: "新增自主選擇", origin: "agent_autonomous", reviewStatus: "pending" },
    ]);

    const rejected = store.reviewSessionDecision({
      decisionId: second.id,
      projectRoot: root,
      reviewStatus: "rejected",
    });
    expect(rejected).toMatchObject({ outcome: "session_decision_reviewed", decision: { reviewStatus: "rejected" } });
    const added = afterEdit.find((decision) => decision.text === "新增自主選擇");
    if (!added) throw new Error("Expected the newly added decision.");
    const knowledge = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: "session-decision-knowledge",
      kind: "decision",
      title: "自主決策 Knowledge",
      body: "保留自主選擇的背景與理由。",
      sessionId,
    });
    expect(knowledge.outcome).toBe("knowledge_recorded");
    if (knowledge.outcome !== "knowledge_recorded") throw new Error("Expected Knowledge to be recorded.");
    expect(
      store.reviewSessionDecision({
        decisionId: added.id,
        projectRoot: root,
        reviewStatus: "promoted",
        knowledgeId: knowledge.knowledge.id,
      }),
    ).toMatchObject({
      outcome: "session_decision_reviewed",
      decision: { id: added.id, reviewStatus: "promoted", knowledgeId: knowledge.knowledge.id },
    });
    expect(store.listSessionDecisions({ projectRoot: root })).toMatchObject({ pendingCount: 0, items: [] });
    expect(store.listSessionDecisions({ projectRoot: root, status: "all" })).toMatchObject({
      outcome: "session_decisions",
      items: [
        { id: first.id, reviewStatus: "confirmed" },
        { id: second.id, reviewStatus: "rejected" },
        { id: added.id, reviewStatus: "promoted", knowledgeId: knowledge.knowledge.id },
      ],
    });

    const otherProjectRoot = mkdtempSync(join(tmpdir(), "work-intelligence-other-decision-project-"));
    tempDirs.push(otherProjectRoot);
    const otherProject = store.addProject("Other decision fixture", otherProjectRoot);
    store.updateProject(otherProject.id, { status: "tracked" });
    const wrongScope = store.reviewSessionDecision({
      decisionId: first.id,
      projectRoot: otherProjectRoot,
      reviewStatus: "rejected",
    });
    expect(wrongScope).toMatchObject({ outcome: "not_found", decisionId: first.id });
  });

  it("hides decisions from paused projects and voided Sessions", () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-hidden-decisions-"));
    tempDirs.push(root);
    const store = new WorkIntelligenceStore(":memory:");
    stores.push(store);
    const project = store.addProject("Hidden decision fixture", root);
    store.updateProject(project.id, { status: "tracked" });
    const result = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "hidden-decision-session",
      title: "會作廢的決策",
      summary: "測試作廢工作紀錄不再顯示決策。",
      workSummary: {
        outcomes: [],
        scope: [],
        decisions: [{ text: "待確認決策", origin: "agent_autonomous" }],
        verification: [],
        nextSteps: [],
      },
    });
    if (result.outcome !== "finalized") throw new Error("Expected a finalized Session.");
    expect(store.listSessionDecisions({ projectRoot: root })).toMatchObject({
      outcome: "session_decisions",
      pendingCount: 1,
    });
    store.setSessionVoid({ sessionId: result.session.id, voided: true, reason: "Synthetic test record." });
    expect(store.listSessionDecisions({ projectRoot: root })).toMatchObject({
      outcome: "session_decisions",
      pendingCount: 0,
      items: [],
    });
    expect(store.getContext(root)).toMatchObject({ pendingRequests: { agentDecisions: 0 } });
    expect(store.getReport({ period: "day", projectId: project.id })).toMatchObject({
      outcome: "report",
      agentAutonomousDecisions: { total: 0, pending: 0, pendingItems: [] },
    });
    store.updateProject(project.id, { status: "paused" });
    expect(store.listSessionDecisions({ projectRoot: root })).toMatchObject({
      outcome: "skipped",
      projectStatus: "paused",
    });
  });
});
