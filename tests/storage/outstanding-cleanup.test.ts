import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutstandingCleanupRequest, WorkSessionRecord } from "../../packages/core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];
const TEST_NOW = "2026-09-22T12:00:00.000Z";
const SOURCE_TIME = "2026-09-01T12:00:00.000Z";
const EVIDENCE_TIME = "2026-09-02T12:00:00.000Z";

interface ProjectFixture {
  store: WorkIntelligenceStore;
  root: string;
  projectId: string;
}

interface FinalizeOptions {
  title?: string;
  summary?: string;
  outcomes?: string[];
  changedFiles?: string[];
  branch?: string;
  commitSha?: string;
  resolvedOutstandingItemIds?: string[];
  supersededOutstandingItemIds?: string[];
}

function addTrackedProject(store: WorkIntelligenceStore, name: string): Omit<ProjectFixture, "store"> {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-outstanding-cleanup-"));
  tempDirs.push(root);
  const project = store.addProject(name, root);
  store.updateProject(project.id, { status: "tracked" });
  return { root, projectId: project.id };
}

function createTrackedProject(name: string): ProjectFixture {
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  return { store, ...addTrackedProject(store, name) };
}

function finalize(
  store: WorkIntelligenceStore,
  root: string,
  idempotencyKey: string,
  nextSteps: string[],
  completedAt = SOURCE_TIME,
  options: FinalizeOptions = {},
): WorkSessionRecord {
  const result = finalizeAttempt(store, root, idempotencyKey, nextSteps, completedAt, options);
  if (result.outcome !== "finalized") throw new Error(`Expected finalized Session, received ${result.outcome}.`);
  return result.session;
}

function finalizeAttempt(
  store: WorkIntelligenceStore,
  root: string,
  idempotencyKey: string,
  nextSteps: string[],
  completedAt = SOURCE_TIME,
  options: FinalizeOptions = {},
): ReturnType<WorkIntelligenceStore["finalizeSession"]> {
  return store.finalizeSession({
    projectRoot: root,
    idempotencyKey,
    title: options.title ?? idempotencyKey,
    summary: options.summary ?? `Fictional evidence for ${idempotencyKey}.`,
    workSummary: {
      outcomes: options.outcomes ?? [],
      scope: [],
      decisions: [],
      verification: [],
      nextSteps,
    },
    verification: { status: "passed", summary: "Synthetic test evidence." },
    changedFiles: options.changedFiles ?? [],
    ...(options.branch || options.commitSha
      ? {
          git: {
            ...(options.branch ? { branch: options.branch } : {}),
            ...(options.commitSha ? { commitSha: options.commitSha } : {}),
          },
        }
      : {}),
    ...(options.resolvedOutstandingItemIds ? { resolvedOutstandingItemIds: options.resolvedOutstandingItemIds } : {}),
    ...(options.supersededOutstandingItemIds
      ? { supersededOutstandingItemIds: options.supersededOutstandingItemIds }
      : {}),
    completedAt,
  });
}

function pendingItems(store: WorkIntelligenceStore, projectId: string) {
  const result = store.listOutstandingItems({ projectId, status: "pending", pageSize: 0 });
  if (result.outcome !== "outstanding_items") throw new Error("Expected pending outstanding items.");
  return result.items;
}

function allPendingItems(store: WorkIntelligenceStore, projectId: string) {
  const first = store.listOutstandingItems({ projectId, status: "pending", page: 1, pageSize: 100 });
  if (first.outcome !== "outstanding_items") throw new Error("Expected pending outstanding items.");
  const items = [...first.items];
  for (let page = 2; page <= first.pageInfo.totalPages; page += 1) {
    const result = store.listOutstandingItems({ projectId, status: "pending", page, pageSize: 100 });
    if (result.outcome !== "outstanding_items") throw new Error("Expected pending outstanding items.");
    items.push(...result.items);
  }
  return items;
}

function createRequest(
  store: WorkIntelligenceStore,
  projectId: string,
  idempotencyKey: string,
): OutstandingCleanupRequest {
  const result = store.createOutstandingCleanupRequest({ projectId, idempotencyKey });
  if (result.outcome !== "outstanding_cleanup_request_created") {
    throw new Error(`Expected cleanup request, received ${result.outcome}.`);
  }
  return result.request;
}

function submitOneProposal(
  store: WorkIntelligenceStore,
  requestId: string,
  idempotencyKey: string,
  itemId: string,
  evidenceSessionId: string,
  status: "completed" | "not_needed" | "acknowledged" = "completed",
) {
  return store.submitOutstandingCleanupProposals({
    requestId,
    idempotencyKey,
    examinedItemIds: [itemId],
    proposals: [
      {
        itemId,
        status,
        reason: "The cited synthetic Session verifies this specific outcome.",
        evidenceSessionIds: [evidenceSessionId],
      },
    ],
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(TEST_NOW));
});

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("outstanding cleanup requests", () => {
  it("snapshots pending items once, replays the same key, and rejects a second active key", () => {
    const { store, root, projectId } = createTrackedProject("Cleanup snapshot fixture");
    finalize(store, root, "cleanup-snapshot-source", ["Snapshot first obligation", "Snapshot second obligation"]);
    const snapshotItems = pendingItems(store, projectId);
    const created = store.createOutstandingCleanupRequest({ projectId, idempotencyKey: "cleanup-snapshot-key" });
    expect(created.outcome).toBe("outstanding_cleanup_request_created");
    if (created.outcome !== "outstanding_cleanup_request_created") throw new Error("Expected cleanup request.");
    expect(created).toMatchObject({ duplicate: false, request: { itemCount: 2, examinedCount: 0, status: "pending" } });

    const replay = store.createOutstandingCleanupRequest({ projectId, idempotencyKey: "cleanup-snapshot-key" });
    expect(replay).toMatchObject({
      outcome: "outstanding_cleanup_request_created",
      duplicate: true,
      request: { id: created.request.id },
    });
    const secondKey = store.createOutstandingCleanupRequest({ projectId, idempotencyKey: "cleanup-snapshot-alias" });
    expect(secondKey).toMatchObject({
      outcome: "rejected",
      reason: "active_request_exists",
      requestId: created.request.id,
    });
    expect(
      store.createOutstandingCleanupRequest({ projectId, idempotencyKey: "cleanup-snapshot-alias" }),
    ).toMatchObject({ outcome: "rejected", reason: "active_request_exists", requestId: created.request.id });

    finalize(store, root, "cleanup-snapshot-later-source", ["Added after the snapshot"], "2026-09-23T12:00:00.000Z");
    const context = store.getOutstandingCleanupContext({ requestId: created.request.id, itemPageSize: 50 });
    expect(context).toMatchObject({
      outcome: "outstanding_cleanup_context",
      request: { itemCount: 2 },
      itemPageInfo: { total: 2 },
    });
    if (context.outcome !== "outstanding_cleanup_context") throw new Error("Expected cleanup context.");
    expect(context.items.map((item) => item.id).sort()).toEqual(snapshotItems.map((item) => item.id).sort());
    expect(pendingItems(store, projectId).map((item) => item.text)).toContain("Added after the snapshot");
    expect(store.listOutstandingCleanupRequests({ projectId, pageSize: 10 })).toMatchObject({
      outcome: "outstanding_cleanup_requests",
      requests: [expect.objectContaining({ id: created.request.id })],
      pageInfo: { total: 1 },
    });
  });

  it("requests cleanup by project root with the same snapshot, replay, active, empty and untracked outcomes", () => {
    const { store, root, projectId } = createTrackedProject("Cleanup agent request fixture");
    expect(store.requestOutstandingCleanup({ projectRoot: root, idempotencyKey: "agent-empty" })).toEqual({
      outcome: "not_needed",
      projectId,
    });
    finalize(store, root, "agent-request-source", ["Agent first obligation", "Agent second obligation"]);
    const created = store.requestOutstandingCleanup({ projectRoot: root, idempotencyKey: "agent-request-key" });
    if (created.outcome !== "outstanding_cleanup_request_created") throw new Error("Expected cleanup request.");
    expect(created).toMatchObject({ duplicate: false, request: { itemCount: 2, status: "pending" } });
    expect(store.requestOutstandingCleanup({ projectRoot: root, idempotencyKey: "agent-request-key" })).toMatchObject({
      outcome: "outstanding_cleanup_request_created",
      duplicate: true,
      request: { id: created.request.id },
    });
    expect(store.requestOutstandingCleanup({ projectRoot: root, idempotencyKey: "agent-other-key" })).toMatchObject({
      outcome: "outstanding_cleanup_request_active",
      request: { id: created.request.id },
    });
    const context = store.getOutstandingCleanupContext({ requestId: created.request.id, itemPageSize: 5 });
    if (context.outcome !== "outstanding_cleanup_context") throw new Error("Expected cleanup context.");
    expect(context.items.map((item) => item.id).sort()).toEqual(
      pendingItems(store, projectId)
        .map((item) => item.id)
        .sort(),
    );

    const untracked = store.addProject("Cleanup agent untracked fixture", `${root}-untracked`);
    expect(
      store.requestOutstandingCleanup({ projectRoot: `${root}-untracked`, idempotencyKey: "agent-untracked" }),
    ).toMatchObject({ outcome: "skipped" });
    expect(untracked.id).not.toBe(projectId);
    expect(
      store.requestOutstandingCleanup({ projectRoot: `${root}-unknown`, idempotencyKey: "agent-unknown" }),
    ).toMatchObject({ outcome: "skipped" });
  });

  it("quietly skips untracked or paused projects, reports no work, and keeps voided snapshot rows stale", () => {
    const { store, root, projectId } = createTrackedProject("Cleanup voided source fixture");
    const source = finalize(store, root, "cleanup-voided-source", ["Retain the original snapshot"]);
    const request = createRequest(store, projectId, "cleanup-voided-request");
    expect(store.setSessionVoid({ sessionId: source.id, voided: true, reason: "Synthetic correction." }).outcome).toBe(
      "session_void_updated",
    );
    const context = store.getOutstandingCleanupContext({ requestId: request.id });
    expect(context.outcome).toBe("outstanding_cleanup_context");
    if (context.outcome !== "outstanding_cleanup_context") throw new Error("Expected snapshot context.");
    expect(context.items).toEqual([expect.objectContaining({ text: "Retain the original snapshot", stale: true })]);
    expect(context.sessions.map((session) => session.id)).not.toContain(source.id);
    store.updateProject(projectId, { status: "paused" });
    expect(store.getOutstandingCleanupContext({ requestId: request.id })).toMatchObject({
      outcome: "skipped",
      projectId,
      projectStatus: "paused",
    });
    expect(store.listOutstandingCleanupProposals({ requestId: request.id })).toMatchObject({
      outcome: "skipped",
      projectId,
    });
    expect(store.cancelOutstandingCleanupRequest(request.id)).toMatchObject({ outcome: "skipped", projectId });
    expect(
      store.submitOutstandingCleanupProposals({
        requestId: request.id,
        idempotencyKey: "cleanup-paused-submit",
        examinedItemIds: [],
        proposals: [],
      }),
    ).toMatchObject({ outcome: "skipped", projectId });
    store.updateProject(projectId, { status: "tracked" });

    const emptyProject = addTrackedProject(store, "Cleanup empty project fixture");
    expect(
      store.createOutstandingCleanupRequest({ projectId: emptyProject.projectId, idempotencyKey: "cleanup-empty" }),
    ).toMatchObject({ outcome: "not_needed", projectId: emptyProject.projectId });

    const pausedProject = addTrackedProject(store, "Cleanup paused project fixture");
    finalize(store, pausedProject.root, "cleanup-paused-source", ["Paused project obligation"]);
    store.updateProject(pausedProject.projectId, { status: "paused" });
    expect(
      store.createOutstandingCleanupRequest({ projectId: pausedProject.projectId, idempotencyKey: "cleanup-paused" }),
    ).toMatchObject({ outcome: "skipped", projectId: pausedProject.projectId, projectStatus: "paused" });
    expect(store.listOutstandingCleanupRequests({ projectId: pausedProject.projectId })).toMatchObject({
      outcome: "skipped",
      projectId: pausedProject.projectId,
    });

    const untracked = store.addProject(
      "Cleanup untracked project fixture",
      mkdtempSync(join(tmpdir(), "cleanup-untracked-")),
    );
    tempDirs.push(untracked.rootPath);
    expect(
      store.createOutstandingCleanupRequest({ projectId: untracked.id, idempotencyKey: "cleanup-untracked" }),
    ).toMatchObject({ outcome: "skipped", projectId: untracked.id });
  });

  it("bounds context pages and returns only same-project finalized Sessions later than the snapshot", () => {
    const { store, root, projectId } = createTrackedProject("Cleanup bounded context fixture");
    const sourceTitle = `Long source title ${"bounded title detail ".repeat(14)}`;
    const longItem = `Verify bounded cleanup evidence ${"supporting context ".repeat(40)}`;
    const source = finalize(
      store,
      root,
      "cleanup-context-source",
      [longItem, ...Array.from({ length: 5 }, (_, index) => `Additional snapshot obligation ${index + 1}`)],
      SOURCE_TIME,
      { title: sourceTitle },
    );
    const older = finalize(store, root, "cleanup-context-older", [], "2026-08-31T12:00:00.000Z");
    const equal = finalize(store, root, "cleanup-context-equal", [], SOURCE_TIME);
    for (let index = 0; index < 12; index += 1) {
      const session = finalize(
        store,
        root,
        `cleanup-context-evidence-${index}`,
        [],
        `2026-09-${String(index + 2).padStart(2, "0")}T12:00:00.000Z`,
        {
          title: `Bounded evidence title ${index} ${"title detail ".repeat(12)}`,
          summary: `Synthetic cleanup evidence summary ${"verified context ".repeat(90)} https://github.com/example/cleanup-fixture/pull/${index + 1}`,
          outcomes: Array.from(
            { length: 20 },
            (_, outcomeIndex) => `Verified outcome ${outcomeIndex + 1} ${"supporting outcome detail ".repeat(80)}`,
          ),
          branch: `cleanup-evidence-${index}`,
          commitSha: `${String(index + 1).repeat(7)}`,
        },
      );
      for (let pullRequest = 1; pullRequest <= 4; pullRequest += 1) {
        expect(
          store.attachEvidence({
            sessionId: session.id,
            kind: "pull_request",
            reference: `https://github.com/example/cleanup-fixture/pull/${index * 10 + pullRequest}`,
            summary: "Synthetic source-linked pull request.",
          }).outcome,
        ).toBe("evidence_attached");
      }
    }
    const postCutoff = finalize(store, root, "cleanup-context-post-cutoff", [], "2026-09-23T12:00:00.000Z");
    const request = createRequest(store, projectId, "cleanup-context-request");
    vi.setSystemTime(new Date("2026-09-22T12:01:00.000Z"));
    const insertedAfterCutoff = finalize(store, root, "cleanup-context-late-backfill", [], "2026-09-05T12:00:00.000Z");

    const context = store.getOutstandingCleanupContext({
      requestId: request.id,
      itemPage: 1,
      itemPageSize: 99,
      sessionPage: 1,
      sessionPageSize: 99,
    });
    expect(context.outcome).toBe("outstanding_cleanup_context");
    if (context.outcome !== "outstanding_cleanup_context") throw new Error("Expected bounded cleanup context.");
    expect(context.items).toHaveLength(5);
    expect(context.itemPageInfo).toMatchObject({ pageSize: 5, total: 6, hasNext: true });
    expect(context.sessions).toHaveLength(10);
    expect(context.sessionPageInfo).toMatchObject({ pageSize: 10, total: 12, hasNext: true });
    expect(context.items.every((item) => item.sourceSessionId === source.id)).toBe(true);
    const beyond = store.getOutstandingCleanupContext({ requestId: request.id, itemPage: 1, sessionPage: 9 });
    if (beyond.outcome !== "outstanding_cleanup_context") throw new Error("Expected an empty session page.");
    expect(beyond.sessions).toEqual([]);
    expect(beyond.sessionPageInfo).toMatchObject({
      page: 9,
      totalPages: 2,
      from: 0,
      to: 0,
      hasPrevious: true,
      hasNext: false,
    });
    expect(context.items[0]).toMatchObject({ sourceSessionTitleTruncated: true });
    expect(context.items.some((item) => item.textTruncated)).toBe(true);
    expect(context.sessions.some((session) => session.titleTruncated)).toBe(true);
    expect(context.sessions.some((session) => session.summaryTruncated)).toBe(true);
    expect(context.sessions.some((session) => session.outcomesTruncated)).toBe(true);
    expect(context.sessions.some((session) => session.outcomesOmitted > 0)).toBe(true);
    expect(
      context.sessions.some((session) => session.pullRequests.length === 3 && session.pullRequestsOmitted === 1),
    ).toBe(true);
    expect(context.sessions.map((session) => session.id)).not.toContain(older.id);
    expect(context.sessions.map((session) => session.id)).not.toContain(equal.id);
    expect(context.sessions.map((session) => session.id)).not.toContain(postCutoff.id);
    expect(context.sessions.map((session) => session.id)).not.toContain(insertedAfterCutoff.id);
    expect(context.truncated).toBe(true);
  });

  it("records explicit abstentions, validates a whole submission before writing, and replays payloads safely", () => {
    const { store, root, projectId } = createTrackedProject("Cleanup abstention fixture");
    finalize(store, root, "cleanup-abstention-source", ["Withhold without evidence", "Keep the second item pending"]);
    const items = pendingItems(store, projectId);
    const evidence = finalize(store, root, "cleanup-abstention-evidence", [], EVIDENCE_TIME);
    const request = createRequest(store, projectId, "cleanup-abstention-request");
    const eventsBefore = store.exportProjectData({ type: "project", projectId }).tables.outstanding_item_events;

    const invalidWholeSubmission = store.submitOutstandingCleanupProposals({
      requestId: request.id,
      idempotencyKey: "cleanup-abstention-invalid",
      examinedItemIds: [items[0]!.id],
      proposals: [
        {
          itemId: items[0]!.id,
          status: "completed",
          reason: "A validly shaped proposal with invalid evidence.",
          evidenceSessionIds: [evidence.id],
        },
        {
          itemId: items[1]!.id,
          status: "not_needed",
          reason: "This item was not part of the examined page.",
          evidenceSessionIds: [evidence.id],
        },
      ],
    });
    expect(invalidWholeSubmission).toMatchObject({ outcome: "rejected", reason: "invalid_proposals" });
    expect(store.exportProjectData({ type: "project", projectId }).tables.outstanding_item_events).toEqual(
      eventsBefore,
    );
    expect(store.getOutstandingCleanupContext({ requestId: request.id }).outcome).toBe("outstanding_cleanup_context");

    const abstention = store.submitOutstandingCleanupProposals({
      requestId: request.id,
      idempotencyKey: "cleanup-abstention-page-one",
      examinedItemIds: [items[0]!.id],
      proposals: [],
    });
    expect(abstention).toMatchObject({
      outcome: "outstanding_cleanup_proposals_submitted",
      examinedItemIds: [items[0]!.id],
      proposalIds: [],
      duplicate: false,
      request: { status: "pending", examinedCount: 1, proposalCount: 0 },
    });
    const replay = store.submitOutstandingCleanupProposals({
      requestId: request.id,
      idempotencyKey: "cleanup-abstention-page-one",
      examinedItemIds: [items[0]!.id],
      proposals: [],
    });
    expect(replay).toMatchObject({ outcome: "outstanding_cleanup_proposals_submitted", duplicate: true });
    const changedPayload = submitOneProposal(
      store,
      request.id,
      "cleanup-abstention-page-one",
      items[0]!.id,
      evidence.id,
    );
    expect(changedPayload).toMatchObject({ outcome: "rejected", reason: "idempotency_conflict" });
    expect(
      store.submitOutstandingCleanupProposals({
        requestId: request.id,
        idempotencyKey: "cleanup-abstention-second-owner",
        examinedItemIds: [items[0]!.id],
        proposals: [],
      }),
    ).toMatchObject({ outcome: "rejected", reason: "already_examined", itemIds: [items[0]!.id] });

    const finalAbstention = store.submitOutstandingCleanupProposals({
      requestId: request.id,
      idempotencyKey: "cleanup-abstention-page-two",
      examinedItemIds: [items[1]!.id],
      proposals: [],
    });
    expect(finalAbstention).toMatchObject({
      outcome: "outstanding_cleanup_proposals_submitted",
      request: { status: "completed", examinedCount: 2, proposalCount: 0 },
    });
    expect(
      pendingItems(store, projectId)
        .map((item) => item.id)
        .sort(),
    ).toEqual(items.map((item) => item.id).sort());
    expect(store.exportProjectData({ type: "project", projectId }).tables.outstanding_item_events).toEqual(
      eventsBefore,
    );
    expect(
      store.createOutstandingCleanupRequest({ projectId, idempotencyKey: "cleanup-abstention-request" }),
    ).toMatchObject({
      outcome: "outstanding_cleanup_request_created",
      duplicate: true,
      request: { id: request.id, status: "completed" },
    });
  });

  it("rejects cross-project, voided, equal-or-earlier, and post-cutoff evidence", () => {
    const { store, root, projectId } = createTrackedProject("Cleanup evidence scope fixture");
    const otherProject = addTrackedProject(store, "Cleanup evidence other project");
    const source = finalize(store, root, "cleanup-evidence-source", ["Require a strictly later citation"], SOURCE_TIME);
    const item = pendingItems(store, projectId)[0]!;
    const earlier = finalize(store, root, "cleanup-evidence-earlier", [], "2026-08-31T12:00:00.000Z");
    const equal = finalize(store, root, "cleanup-evidence-equal", [], SOURCE_TIME);
    const voided = finalize(store, root, "cleanup-evidence-voided", [], "2026-09-03T12:00:00.000Z");
    store.setSessionVoid({ sessionId: voided.id, voided: true, reason: "Synthetic evidence correction." });
    const crossProject = finalize(store, otherProject.root, "cleanup-evidence-cross-project", [], EVIDENCE_TIME);
    const validEvidence = finalize(store, root, "cleanup-evidence-valid", [], EVIDENCE_TIME);
    const request = createRequest(store, projectId, "cleanup-evidence-request");
    const future = finalize(store, root, "cleanup-evidence-after-cutoff", [], "2026-09-23T12:00:00.000Z");
    vi.setSystemTime(new Date("2026-09-22T12:01:00.000Z"));
    const insertedAfterCutoff = finalize(store, root, "cleanup-evidence-late-backfill", [], EVIDENCE_TIME);
    vi.setSystemTime(new Date(TEST_NOW));

    const invalidEvidence = [earlier, equal, voided, crossProject, future, insertedAfterCutoff];
    for (const [index, evidence] of invalidEvidence.entries()) {
      expect(
        submitOneProposal(store, request.id, `cleanup-invalid-evidence-${index}`, item.id, evidence.id),
      ).toMatchObject({ outcome: "rejected", reason: "invalid_evidence" });
    }
    expect(submitOneProposal(store, request.id, "cleanup-valid-evidence", item.id, validEvidence.id)).toMatchObject({
      outcome: "outstanding_cleanup_proposals_submitted",
      request: { examinedCount: 1, proposalCount: 1 },
    });
    expect(store.listOutstandingCleanupProposals({ requestId: request.id }).outcome).toBe(
      "outstanding_cleanup_proposals",
    );
    expect(source.id).not.toBe(validEvidence.id);
  });

  it("applies each verdict at submission, audits it as an Agent event, and records acknowledged without evidence", () => {
    const { store, root, projectId } = createTrackedProject("Cleanup direct apply fixture");
    finalize(store, root, "cleanup-direct-source", [
      "Verify completed outcome",
      "Replace an obsolete obligation",
      "未處理：Windows 版本不在本 PR 範圍",
      "Withhold without a verdict",
    ]);
    const items = pendingItems(store, projectId);
    const evidence = finalize(store, root, "cleanup-direct-evidence", [], EVIDENCE_TIME);
    const request = createRequest(store, projectId, "cleanup-direct-request");
    const submitted = store.submitOutstandingCleanupProposals({
      requestId: request.id,
      idempotencyKey: "cleanup-direct-submit",
      examinedItemIds: items.map((item) => item.id),
      proposals: [
        {
          itemId: items[0]!.id,
          status: "completed",
          reason: "The verification Session confirms the item was completed.",
          evidenceSessionIds: [evidence.id],
        },
        {
          itemId: items[1]!.id,
          status: "not_needed",
          reason: "A later implementation Session explicitly replaced the obligation.",
          evidenceSessionIds: [evidence.id],
        },
        {
          itemId: items[2]!.id,
          status: "acknowledged",
          reason: "A scope exclusion, not a task.",
          evidenceSessionIds: [],
        },
      ],
    });
    if (submitted.outcome !== "outstanding_cleanup_proposals_submitted") throw new Error("Expected applied verdicts.");
    expect(submitted).toMatchObject({
      duplicate: false,
      request: { status: "completed", examinedCount: 4, proposalCount: 3 },
    });
    expect(pendingItems(store, projectId).map((item) => item.id)).toEqual([items[3]!.id]);
    const closed = (status: "completed" | "not_needed") =>
      store.listOutstandingItems({ projectId, status, pageSize: 0 });
    expect(closed("completed")).toMatchObject({
      items: [expect.objectContaining({ id: items[0]!.id, closedBy: "cleanup_review" })],
    });
    expect(closed("not_needed")).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: items[1]!.id, closedBy: "cleanup_review" }),
        expect.objectContaining({ id: items[2]!.id, closedBy: "cleanup_review" }),
      ]),
    });

    const listed = store.listOutstandingCleanupProposals({ requestId: request.id, pageSize: 20 });
    if (listed.outcome !== "outstanding_cleanup_proposals") throw new Error("Expected proposal list.");
    const byItem = new Map(listed.proposals.map((proposal) => [proposal.itemId, proposal]));
    expect(byItem.get(items[0]!.id)).toMatchObject({
      status: "completed",
      kind: "resolution",
      reviewStatus: "accepted",
      itemStatus: "completed",
      evidenceSessionIds: [evidence.id],
    });
    expect(byItem.get(items[2]!.id)).toMatchObject({
      status: "not_needed",
      kind: "acknowledged",
      reviewStatus: "accepted",
      itemStatus: "not_needed",
      evidenceSessionIds: [],
    });

    const tables = store.exportProjectData({ type: "project", projectId }).tables;
    for (const item of items.slice(0, 3)) {
      const proposal = byItem.get(item.id)!;
      expect(tables.outstanding_item_events.filter((event) => event.item_id === item.id).at(-1)).toMatchObject({
        source: "agent",
        actor_session_id: null,
        from_status: "pending",
        to_status: proposal.status,
        cleanup_request_id: request.id,
        cleanup_proposal_id: proposal.id,
      });
    }
    expect(tables.outstanding_cleanup_proposal_evidence).toHaveLength(2);

    expect(store.updateOutstandingItemStatus(items[0]!.id, "pending", "web").outcome).toBe("outstanding_item_updated");
    const reopened = store.listOutstandingCleanupProposals({ requestId: request.id, pageSize: 20 });
    if (reopened.outcome !== "outstanding_cleanup_proposals") throw new Error("Expected proposal list.");
    expect(reopened.proposals.find((proposal) => proposal.itemId === items[0]!.id)).toMatchObject({
      reviewStatus: "accepted",
      itemStatus: "pending",
    });
  });

  it("requires evidence for completed and not_needed verdicts but not for acknowledged ones", () => {
    const { store, root, projectId } = createTrackedProject("Cleanup acknowledged validation fixture");
    finalize(store, root, "cleanup-ack-source", ["Needs evidence", "Known limitation"]);
    const items = pendingItems(store, projectId);
    const request = createRequest(store, projectId, "cleanup-ack-request");
    const submit = (key: string, status: "completed" | "not_needed" | "acknowledged", itemId: string) =>
      store.submitOutstandingCleanupProposals({
        requestId: request.id,
        idempotencyKey: key,
        examinedItemIds: [itemId],
        proposals: [{ itemId, status, reason: "A concise reason.", evidenceSessionIds: [] }],
      });
    expect(submit("cleanup-ack-completed", "completed", items[0]!.id)).toMatchObject({
      outcome: "rejected",
      reason: "invalid_proposals",
    });
    expect(submit("cleanup-ack-not-needed", "not_needed", items[0]!.id)).toMatchObject({
      outcome: "rejected",
      reason: "invalid_proposals",
    });
    expect(pendingItems(store, projectId)).toHaveLength(2);
    expect(submit("cleanup-ack-acknowledged", "acknowledged", items[1]!.id)).toMatchObject({
      outcome: "outstanding_cleanup_proposals_submitted",
      request: { proposalCount: 1 },
    });
    expect(pendingItems(store, projectId).map((item) => item.id)).toEqual([items[0]!.id]);
  });

  it.each([
    ["source edit", "stale_proposal"],
    ["item edit", "stale_proposal"],
    ["source void", "stale_proposal"],
    ["evidence void", "invalid_evidence"],
  ] as const)("rejects a submission after a %s and changes nothing", (mutation, reason) => {
    const { store, root, projectId } = createTrackedProject(`Cleanup stale ${mutation} fixture`);
    const source = finalize(store, root, `cleanup-stale-source-${mutation}`, ["Verify one stale transition"]);
    const item = pendingItems(store, projectId)[0]!;
    const evidence = finalize(store, root, `cleanup-stale-evidence-${mutation}`, [], EVIDENCE_TIME);
    const request = createRequest(store, projectId, `cleanup-stale-request-${mutation}`);

    if (mutation === "source edit") {
      store.updateSessionSummary({
        sessionId: source.id,
        idempotencyKey: `cleanup-stale-edit-${mutation}`,
        summary: "Corrected source summary without advancing the frozen clock.",
      });
    } else if (mutation === "item edit") {
      store.updateOutstandingItemStatus(item.id, "completed", "web");
    } else if (mutation === "source void") {
      store.setSessionVoid({ sessionId: source.id, voided: true, reason: "Synthetic source correction." });
    } else {
      store.setSessionVoid({ sessionId: evidence.id, voided: true, reason: "Synthetic evidence correction." });
    }

    const before = store.exportProjectData({ type: "project", projectId }).tables;
    expect(
      submitOneProposal(store, request.id, `cleanup-stale-submit-${mutation}`, item.id, evidence.id),
    ).toMatchObject({
      outcome: "rejected",
      reason,
      itemIds: [item.id],
    });
    const after = store.exportProjectData({ type: "project", projectId }).tables;
    expect(after.outstanding_item_events).toEqual(before.outstanding_item_events);
    expect(after.outstanding_cleanup_proposals).toEqual([]);
    expect(store.getOutstandingCleanupContext({ requestId: request.id })).toMatchObject({
      request: { examinedCount: 0, status: "pending" },
    });
  });

  it("rechecks eligibility atomically: one stale item rejects the whole submission, acknowledged ones included", () => {
    const { store, root, projectId } = createTrackedProject("Cleanup atomic submission fixture");
    const sources = Array.from({ length: 4 }, (_, index) =>
      finalize(store, root, `cleanup-atomic-source-${index}`, [`Atomic item ${index + 1}`]),
    );
    const snapshot = pendingItems(store, projectId);
    const items = sources.map((source) => snapshot.find((item) => item.sourceSessionId === source.id)!);
    const evidence = finalize(store, root, "cleanup-atomic-evidence", [], EVIDENCE_TIME);
    const request = createRequest(store, projectId, "cleanup-atomic-request");
    store.updateOutstandingItemStatus(items[3]!.id, "completed", "web");
    const before = store.exportProjectData({ type: "project", projectId }).tables;

    expect(
      store.submitOutstandingCleanupProposals({
        requestId: request.id,
        idempotencyKey: "cleanup-atomic-submit",
        examinedItemIds: items.map((item) => item.id),
        proposals: [
          { itemId: items[0]!.id, status: "completed", reason: "Verified.", evidenceSessionIds: [evidence.id] },
          { itemId: items[1]!.id, status: "not_needed", reason: "Replaced.", evidenceSessionIds: [evidence.id] },
          { itemId: items[2]!.id, status: "acknowledged", reason: "Known limitation.", evidenceSessionIds: [] },
          { itemId: items[3]!.id, status: "acknowledged", reason: "Known limitation.", evidenceSessionIds: [] },
        ],
      }),
    ).toMatchObject({ outcome: "rejected", reason: "stale_proposal", itemIds: [items[3]!.id] });
    const after = store.exportProjectData({ type: "project", projectId }).tables;
    expect(after.outstanding_item_events).toEqual(before.outstanding_item_events);
    expect(after.outstanding_cleanup_proposals).toEqual([]);
    expect(pendingItems(store, projectId)).toHaveLength(3);
  });

  it("applies up to 100 verdicts in one submission and rejects 101", () => {
    const { store, root, projectId } = createTrackedProject("Cleanup verdict limit fixture");
    for (let batch = 0; batch < 6; batch += 1) {
      const count = batch === 5 ? 1 : 20;
      finalize(
        store,
        root,
        `cleanup-limit-source-${batch}`,
        Array.from({ length: count }, (_, index) => `Limit obligation ${batch * 20 + index + 1}`),
      );
    }
    const itemIds = allPendingItems(store, projectId).map((item) => item.id);
    expect(itemIds).toHaveLength(101);
    const request = createRequest(store, projectId, "cleanup-limit-request");
    const verdicts = (ids: string[]) =>
      ids.map((itemId) => ({
        itemId,
        status: "acknowledged" as const,
        reason: "Known limitation.",
        evidenceSessionIds: [],
      }));
    expect(
      store.submitOutstandingCleanupProposals({
        requestId: request.id,
        idempotencyKey: "cleanup-limit-101",
        examinedItemIds: itemIds.slice(0, 100),
        proposals: verdicts(itemIds),
      }),
    ).toMatchObject({ outcome: "rejected", reason: "invalid_proposals" });
    expect(
      store.submitOutstandingCleanupProposals({
        requestId: request.id,
        idempotencyKey: "cleanup-limit-100",
        examinedItemIds: itemIds.slice(0, 100),
        proposals: verdicts(itemIds.slice(0, 100)),
      }),
    ).toMatchObject({ outcome: "outstanding_cleanup_proposals_submitted", request: { proposalCount: 100 } });
    expect(allPendingItems(store, projectId)).toHaveLength(1);
  });

  it("only lets the audit trigger record Agent events for an accepted proposal of the same item and status", () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-outstanding-cleanup-trigger-"));
    tempDirs.push(root);
    const store = new WorkIntelligenceStore(join(root, "store.sqlite"));
    stores.push(store);
    const project = store.addProject("Cleanup trigger fixture", root);
    store.updateProject(project.id, { status: "tracked" });
    finalize(store, root, "cleanup-trigger-source", ["First trigger item", "Second trigger item"]);
    const [first, second] = pendingItems(store, project.id);
    const request = createRequest(store, project.id, "cleanup-trigger-request");
    store.submitOutstandingCleanupProposals({
      requestId: request.id,
      idempotencyKey: "cleanup-trigger-submit",
      examinedItemIds: [first!.id, second!.id],
      proposals: [{ itemId: first!.id, status: "acknowledged", reason: "Known limitation.", evidenceSessionIds: [] }],
    });
    const proposals = store.listOutstandingCleanupProposals({ requestId: request.id });
    if (proposals.outcome !== "outstanding_cleanup_proposals") throw new Error("Expected proposal list.");
    const proposalId = proposals.proposals[0]!.id;
    const insert = (itemId: string, source: string, from: string | null, to: string, proposal: string | null) => {
      const database = new DatabaseSync(store.databasePath);
      try {
        database
          .prepare(
            `INSERT INTO outstanding_item_events
             (id, item_id, project_id, from_status, to_status, source, actor_session_id, created_at, cleanup_request_id, cleanup_proposal_id)
             VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
          )
          .run(`event-${Math.random()}`, itemId, project.id, from, to, source, TEST_NOW, request.id, proposal);
      } finally {
        database.close();
      }
    };

    expect(() => insert(first!.id, "agent", "pending", "completed", proposalId)).toThrow("invalid cleanup audit scope");
    expect(() => insert(second!.id, "agent", "pending", "not_needed", proposalId)).toThrow(
      "invalid cleanup audit scope",
    );
    expect(() => insert(first!.id, "agent", "completed", "not_needed", proposalId)).toThrow(
      "invalid cleanup audit scope",
    );
    expect(() => insert(first!.id, "agent", "pending", "not_needed", null)).toThrow("invalid cleanup audit scope");
    expect(() => insert(first!.id, "agent", "pending", "not_needed", proposalId)).not.toThrow();
  });

  it("keeps pending cleanup snapshot items pending when finalize requests direct transitions", () => {
    const { store, root, projectId } = createTrackedProject("Cleanup finalize guard fixture");
    finalize(store, root, "cleanup-finalize-guard-source", [
      "Keep the resolved item pending for review",
      "Keep the superseded item pending for review",
    ]);
    const items = pendingItems(store, projectId);
    const request = createRequest(store, projectId, "cleanup-finalize-guard-request");
    expect(store.getOutstandingCleanupContext({ requestId: request.id })).toMatchObject({
      outcome: "outstanding_cleanup_context",
      request: { id: request.id, status: "pending" },
    });
    const targetIds = [items[0]!.id, items[1]!.id];
    const eventsBefore = store
      .exportProjectData({ type: "project", projectId })
      .tables.outstanding_item_events.filter((event) => targetIds.includes(String(event.item_id)));

    const attempt = finalizeAttempt(
      store,
      root,
      "cleanup-finalize-guard-attempt",
      ["Unrelated follow-up from this Session"],
      TEST_NOW,
      {
        resolvedOutstandingItemIds: [items[0]!.id],
        supersededOutstandingItemIds: [items[1]!.id],
      },
    );

    expect(attempt.outcome).toBe("finalized");
    if (attempt.outcome !== "finalized") throw new Error("Expected the guard Session to finalize.");
    expect(attempt).toMatchObject({
      resolvedOutstandingItemIds: [],
      supersededOutstandingItemIds: [],
      outstandingItemWarnings: {
        unresolvedIds: [items[0]!.id],
        unsupersededIds: [items[1]!.id],
      },
    });
    const pendingAfterFinalize = pendingItems(store, projectId);
    expect(pendingAfterFinalize.map((item) => item.id)).toEqual(expect.arrayContaining(targetIds));
    expect(pendingAfterFinalize).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "Unrelated follow-up from this Session" })]),
    );
    expect(
      store
        .exportProjectData({ type: "project", projectId })
        .tables.outstanding_item_events.filter((event) => targetIds.includes(String(event.item_id))),
    ).toEqual(eventsBefore);
  });

  it("holds Agent summary removals until cancellation, then restores normal transitions and Web edits", () => {
    const { store, root, projectId } = createTrackedProject("Cleanup Agent summary guard fixture");
    const source = finalize(store, root, "cleanup-agent-summary-source", [
      "Resolve after cleanup cancellation",
      "Supersede after cleanup cancellation",
    ]);
    const items = pendingItems(store, projectId);
    const targetIds = [items[0]!.id, items[1]!.id];
    const request = createRequest(store, projectId, "cleanup-agent-summary-request");
    const eventsBefore = store
      .exportProjectData({ type: "project", projectId })
      .tables.outstanding_item_events.filter((event) => targetIds.includes(String(event.item_id)));

    const agentUpdate = store.updateSessionWorkSummary(
      {
        sessionId: source.id,
        idempotencyKey: "cleanup-agent-summary-remove-next-step",
        mode: "patch",
        workSummary: { nextSteps: [] },
      },
      "agent",
    );
    expect(agentUpdate).toMatchObject({
      outcome: "work_summary_updated",
      duplicate: false,
      appliedWorkSummary: { nextSteps: [] },
    });
    expect(pendingItems(store, projectId).map((pending) => pending.id)).toEqual(targetIds);
    expect(
      store
        .exportProjectData({ type: "project", projectId })
        .tables.outstanding_item_events.filter((event) => targetIds.includes(String(event.item_id))),
    ).toEqual(eventsBefore);
    expect(store.getOutstandingCleanupContext({ requestId: request.id })).toMatchObject({
      outcome: "outstanding_cleanup_context",
      request: { id: request.id, status: "pending" },
      items: [expect.objectContaining({ stale: true }), expect.objectContaining({ stale: true })],
    });

    expect(store.cancelOutstandingCleanupRequest(request.id)).toMatchObject({
      outcome: "outstanding_cleanup_request_cancelled",
      request: { status: "cancelled" },
    });
    const cancelledAttempt = finalizeAttempt(
      store,
      root,
      "cleanup-agent-summary-after-cancel",
      ["Unrelated post-cancellation follow-up"],
      TEST_NOW,
      {
        resolvedOutstandingItemIds: [items[0]!.id],
        supersededOutstandingItemIds: [items[1]!.id],
      },
    );
    expect(cancelledAttempt.outcome).toBe("finalized");
    if (cancelledAttempt.outcome !== "finalized") throw new Error("Expected canceled-request transitions.");
    expect(cancelledAttempt).toMatchObject({
      resolvedOutstandingItemIds: [items[0]!.id],
      supersededOutstandingItemIds: [items[1]!.id],
    });
    expect(cancelledAttempt).not.toHaveProperty("outstandingItemWarnings");
    expect(store.getOutstandingCleanupContext({ requestId: request.id })).toMatchObject({
      outcome: "outstanding_cleanup_context",
      request: { id: request.id, status: "cancelled" },
      items: [expect.objectContaining({ stale: true }), expect.objectContaining({ stale: true })],
    });
    expect(
      store
        .exportProjectData({ type: "project", projectId })
        .tables.outstanding_item_events.filter((event) => targetIds.includes(String(event.item_id))),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          item_id: items[0]!.id,
          source: "agent",
          actor_session_id: cancelledAttempt.session.id,
          to_status: "completed",
        }),
        expect.objectContaining({
          item_id: items[1]!.id,
          source: "agent",
          actor_session_id: cancelledAttempt.session.id,
          to_status: "not_needed",
        }),
      ]),
    );

    const webProject = addTrackedProject(store, "Cleanup Web summary edit fixture");
    const webSource = finalize(store, webProject.root, "cleanup-web-summary-source", ["Close by explicit Web edit"]);
    const webItem = pendingItems(store, webProject.projectId)[0]!;
    createRequest(store, webProject.projectId, "cleanup-web-summary-request");
    const webUpdate = store.updateSessionWorkSummary(
      {
        sessionId: webSource.id,
        idempotencyKey: "cleanup-web-summary-remove-next-step",
        mode: "patch",
        workSummary: { nextSteps: [] },
      },
      "web",
    );
    expect(webUpdate).toMatchObject({
      outcome: "work_summary_updated",
      duplicate: false,
      appliedWorkSummary: { nextSteps: [] },
    });
    expect(
      store.listOutstandingItems({ projectId: webProject.projectId, status: "not_needed", pageSize: 0 }),
    ).toMatchObject({
      outcome: "outstanding_items",
      items: [expect.objectContaining({ id: webItem.id, status: "not_needed" })],
    });
    expect(
      store.exportProjectData({ type: "project", projectId: webProject.projectId }).tables.outstanding_item_events,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          item_id: webItem.id,
          source: "web",
          from_status: "pending",
          to_status: "not_needed",
        }),
      ]),
    );
  });

  it("cancels the review request without changing its snapshotted outstanding items", () => {
    const { store, root, projectId } = createTrackedProject("Cleanup cancellation fixture");
    finalize(store, root, "cleanup-cancel-source", ["Keep pending after cancel", "Keep the other item pending"]);
    const beforeItems = pendingItems(store, projectId);
    const request = createRequest(store, projectId, "cleanup-cancel-request");
    expect(store.cancelOutstandingCleanupRequest(request.id)).toMatchObject({
      outcome: "outstanding_cleanup_request_cancelled",
      duplicate: false,
      request: { status: "cancelled" },
    });
    expect(store.cancelOutstandingCleanupRequest(request.id)).toMatchObject({
      outcome: "outstanding_cleanup_request_cancelled",
      duplicate: true,
    });
    expect(
      pendingItems(store, projectId)
        .map((item) => item.id)
        .sort(),
    ).toEqual(beforeItems.map((item) => item.id).sort());
    expect(store.listOutstandingCleanupRequests({ projectId, status: "cancelled" })).toMatchObject({
      outcome: "outstanding_cleanup_requests",
      requests: [expect.objectContaining({ id: request.id, status: "cancelled", examinedCount: 0 })],
    });
  });

  it("allows a later verdict for an item examined without one and still rejects a decided or re-withheld item", () => {
    const { store, root, projectId } = createTrackedProject("Cleanup later verdict fixture");
    finalize(store, root, "cleanup-later-source", ["Withheld first", "Decided in the first call", "Never examined"]);
    const items = pendingItems(store, projectId);
    const evidence = finalize(store, root, "cleanup-later-evidence", [], EVIDENCE_TIME);
    const request = createRequest(store, projectId, "cleanup-later-request");
    const [withheld, decided, third] = items;

    expect(
      store.submitOutstandingCleanupProposals({
        requestId: request.id,
        idempotencyKey: "cleanup-later-first",
        examinedItemIds: [withheld!.id, decided!.id],
        proposals: [
          {
            itemId: decided!.id,
            status: "completed",
            reason: "The cited synthetic Session verifies this item.",
            evidenceSessionIds: [evidence.id],
          },
        ],
      }),
    ).toMatchObject({ outcome: "outstanding_cleanup_proposals_submitted", request: { examinedCount: 2 } });

    expect(
      store.submitOutstandingCleanupProposals({
        requestId: request.id,
        idempotencyKey: "cleanup-later-redecide",
        examinedItemIds: [decided!.id, third!.id],
        proposals: [],
      }),
    ).toMatchObject({ outcome: "rejected", reason: "already_examined", itemIds: [decided!.id] });
    expect(
      store.submitOutstandingCleanupProposals({
        requestId: request.id,
        idempotencyKey: "cleanup-later-rewithhold",
        examinedItemIds: [withheld!.id, third!.id],
        proposals: [],
      }),
    ).toMatchObject({ outcome: "rejected", reason: "already_examined", itemIds: [withheld!.id] });
    expect(
      store.submitOutstandingCleanupProposals({
        requestId: request.id,
        idempotencyKey: "cleanup-later-bad-evidence",
        examinedItemIds: [withheld!.id, third!.id],
        proposals: [
          {
            itemId: withheld!.id,
            status: "completed",
            reason: "Evidence is not a Session of this project.",
            evidenceSessionIds: ["missing-session"],
          },
        ],
      }),
    ).toMatchObject({ outcome: "rejected", reason: "invalid_evidence", itemIds: [withheld!.id] });

    const later = store.submitOutstandingCleanupProposals({
      requestId: request.id,
      idempotencyKey: "cleanup-later-verdict",
      examinedItemIds: [withheld!.id, third!.id],
      proposals: [
        {
          itemId: withheld!.id,
          status: "not_needed",
          reason: "A later look shows the cited Session made this item moot.",
          evidenceSessionIds: [evidence.id],
        },
      ],
    });
    expect(later).toMatchObject({
      outcome: "outstanding_cleanup_proposals_submitted",
      duplicate: false,
      examinedItemIds: [withheld!.id, third!.id].sort(),
      request: { status: "completed", examinedCount: 3, proposalCount: 2 },
    });
    const replay = store.submitOutstandingCleanupProposals({
      requestId: request.id,
      idempotencyKey: "cleanup-later-verdict",
      examinedItemIds: [withheld!.id, third!.id],
      proposals: [
        {
          itemId: withheld!.id,
          status: "not_needed",
          reason: "A later look shows the cited Session made this item moot.",
          evidenceSessionIds: [evidence.id],
        },
      ],
    });
    expect(replay).toMatchObject({
      outcome: "outstanding_cleanup_proposals_submitted",
      duplicate: true,
      examinedItemIds: [withheld!.id, third!.id].sort(),
    });
    const firstReplay = store.submitOutstandingCleanupProposals({
      requestId: request.id,
      idempotencyKey: "cleanup-later-first",
      examinedItemIds: [withheld!.id, decided!.id],
      proposals: [
        {
          itemId: decided!.id,
          status: "completed",
          reason: "The cited synthetic Session verifies this item.",
          evidenceSessionIds: [evidence.id],
        },
      ],
    });
    expect(firstReplay).toMatchObject({
      outcome: "outstanding_cleanup_proposals_submitted",
      duplicate: true,
      examinedItemIds: [withheld!.id, decided!.id].sort(),
    });
    expect(pendingItems(store, projectId).map((item) => item.id)).toEqual([third!.id]);
  });

  it("rejects a later verdict once the request completed, with a hint to open a new request", () => {
    const { store, root, projectId } = createTrackedProject("Cleanup closed request fixture");
    finalize(store, root, "cleanup-closed-source", ["Withheld item"]);
    const item = pendingItems(store, projectId)[0]!;
    const evidence = finalize(store, root, "cleanup-closed-evidence", [], EVIDENCE_TIME);
    const request = createRequest(store, projectId, "cleanup-closed-request");
    expect(
      store.submitOutstandingCleanupProposals({
        requestId: request.id,
        idempotencyKey: "cleanup-closed-withhold",
        examinedItemIds: [item.id],
        proposals: [],
      }),
    ).toMatchObject({ outcome: "outstanding_cleanup_proposals_submitted", request: { status: "completed" } });

    const late = submitOneProposal(store, request.id, "cleanup-closed-late", item.id, evidence.id);
    expect(late).toMatchObject({ outcome: "rejected", reason: "request_closed" });
    expect(JSON.stringify(late)).toContain("work_request_outstanding_cleanup");

    const reopened = createRequest(store, projectId, "cleanup-closed-new-request");
    expect(submitOneProposal(store, reopened.id, "cleanup-closed-new-verdict", item.id, evidence.id)).toMatchObject({
      outcome: "outstanding_cleanup_proposals_submitted",
    });
  });

  it("resolves the context by project root to the latest open request", () => {
    const { store, root, projectId } = createTrackedProject("Cleanup context root fixture");
    expect(store.getOutstandingCleanupContext({ projectRoot: root })).toEqual({
      outcome: "no_open_request",
      projectId,
    });
    finalize(store, root, "cleanup-root-source", ["Root context item"]);
    const request = createRequest(store, projectId, "cleanup-root-request");

    const byRoot = store.getOutstandingCleanupContext({ projectRoot: root });
    expect(byRoot).toMatchObject({ outcome: "outstanding_cleanup_context", request: { id: request.id } });
    expect(store.getOutstandingCleanupContext({ requestId: request.id })).toEqual(byRoot);

    store.cancelOutstandingCleanupRequest(request.id);
    expect(store.getOutstandingCleanupContext({ projectRoot: root })).toEqual({
      outcome: "no_open_request",
      projectId,
    });

    const untracked = mkdtempSync(join(tmpdir(), "work-intelligence-outstanding-cleanup-untracked-"));
    tempDirs.push(untracked);
    expect(store.getOutstandingCleanupContext({ projectRoot: untracked })).toMatchObject({ outcome: "skipped" });
  });

  it("rolls back item, proposal, and audit changes when cleanup audit insertion fails", () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-outstanding-cleanup-rollback-"));
    tempDirs.push(root);
    const store = new WorkIntelligenceStore(join(root, "store.sqlite"));
    stores.push(store);
    const project = store.addProject("Cleanup rollback fixture", root);
    store.updateProject(project.id, { status: "tracked" });
    finalize(store, root, "cleanup-rollback-source", ["Rollback cleanup item"]);
    const item = pendingItems(store, project.id)[0]!;
    const evidence = finalize(store, root, "cleanup-rollback-evidence", [], EVIDENCE_TIME);
    const request = createRequest(store, project.id, "cleanup-rollback-request");
    const before = store.exportProjectData({ type: "project", projectId: project.id }).tables;
    const sabotage = new DatabaseSync(store.databasePath);
    try {
      sabotage.exec(
        `CREATE TRIGGER reject_cleanup_audit BEFORE INSERT ON outstanding_item_events
         WHEN NEW.cleanup_request_id IS NOT NULL
         BEGIN SELECT RAISE(ABORT, 'synthetic cleanup audit failure'); END;`,
      );
    } finally {
      sabotage.close();
    }

    expect(() => submitOneProposal(store, request.id, "cleanup-rollback-submit", item.id, evidence.id)).toThrow();
    expect(store.exportProjectData({ type: "project", projectId: project.id }).tables).toEqual(before);
    expect(pendingItems(store, project.id).map((pending) => pending.id)).toContain(item.id);
  });
});
