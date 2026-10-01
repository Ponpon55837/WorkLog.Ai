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
const STALE_MUTATIONS = ["source edit", "item edit", "evidence edit", "source void", "evidence void"] as const;

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
  const result = store.finalizeSession({
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
    completedAt,
  });
  if (result.outcome !== "finalized") throw new Error(`Expected finalized Session, received ${result.outcome}.`);
  return result.session;
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
  status: "completed" | "not_needed" = "completed",
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

  it("accepts and rejects proposals individually, links accepted audit to immutable evidence, and avoids duplicate audits", () => {
    const { store, root, projectId } = createTrackedProject("Cleanup review fixture");
    const source = finalize(store, root, "cleanup-review-source", [
      "Verify accepted completion",
      "Keep rejected proposal pending",
      "Accept an explicit replacement",
    ]);
    const items = pendingItems(store, projectId);
    const evidence = finalize(store, root, "cleanup-review-evidence", [], EVIDENCE_TIME);
    const request = createRequest(store, projectId, "cleanup-review-request");
    const submitted = store.submitOutstandingCleanupProposals({
      requestId: request.id,
      idempotencyKey: "cleanup-review-submit",
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
          status: "not_needed",
          reason: "The verified replacement makes this old obligation unnecessary.",
          evidenceSessionIds: [evidence.id],
        },
      ],
    });
    expect(submitted.outcome).toBe("outstanding_cleanup_proposals_submitted");
    if (submitted.outcome !== "outstanding_cleanup_proposals_submitted") throw new Error("Expected proposals.");
    const listed = store.listOutstandingCleanupProposals({ requestId: request.id, pageSize: 20 });
    expect(listed.outcome).toBe("outstanding_cleanup_proposals");
    if (listed.outcome !== "outstanding_cleanup_proposals") throw new Error("Expected proposal list.");
    const completion = listed.proposals.find((proposal) => proposal.itemId === items[0]!.id);
    const replacement = listed.proposals.find((proposal) => proposal.itemId === items[1]!.id);
    const acceptedReplacement = listed.proposals.find((proposal) => proposal.itemId === items[2]!.id);
    if (!completion || !replacement || !acceptedReplacement) throw new Error("Expected each proposal row.");
    const beforeDecisions = store.exportProjectData({ type: "project", projectId }).tables.outstanding_item_events;

    expect(
      store.decideOutstandingCleanupProposals({
        requestId: request.id,
        proposalIds: [replacement.id],
        decision: "reject",
      }),
    ).toMatchObject({ outcome: "outstanding_cleanup_proposals_decided", decision: "reject", duplicate: false });
    expect(pendingItems(store, projectId).map((item) => item.id)).toContain(items[1]!.id);
    expect(store.exportProjectData({ type: "project", projectId }).tables.outstanding_item_events).toHaveLength(
      beforeDecisions.length,
    );

    expect(
      store.decideOutstandingCleanupProposals({
        requestId: request.id,
        proposalIds: [completion.id],
        decision: "accept",
      }),
    ).toMatchObject({ outcome: "outstanding_cleanup_proposals_decided", decision: "accept", duplicate: false });
    expect(
      store.decideOutstandingCleanupProposals({
        requestId: request.id,
        proposalIds: [acceptedReplacement.id],
        decision: "accept",
      }),
    ).toMatchObject({ outcome: "outstanding_cleanup_proposals_decided", decision: "accept", duplicate: false });
    const afterAccept = store.exportProjectData({ type: "project", projectId }).tables;
    const retry = store.decideOutstandingCleanupProposals({
      requestId: request.id,
      proposalIds: [completion.id],
      decision: "accept",
    });
    expect(retry).toMatchObject({ outcome: "outstanding_cleanup_proposals_decided", duplicate: true });
    expect(store.exportProjectData({ type: "project", projectId }).tables.outstanding_item_events).toEqual(
      afterAccept.outstanding_item_events,
    );
    expect(store.listOutstandingItems({ projectId, status: "completed", pageSize: 0 })).toMatchObject({
      outcome: "outstanding_items",
      items: expect.arrayContaining([expect.objectContaining({ id: items[0]!.id, status: "completed" })]),
    });
    expect(store.listOutstandingItems({ projectId, status: "not_needed", pageSize: 0 })).toMatchObject({
      outcome: "outstanding_items",
      items: expect.arrayContaining([expect.objectContaining({ id: items[2]!.id, status: "not_needed" })]),
    });

    const acceptedEvent = afterAccept.outstanding_item_events.find(
      (event) => event.item_id === items[0]!.id && event.cleanup_proposal_id === completion.id,
    );
    expect(acceptedEvent).toMatchObject({
      cleanup_request_id: request.id,
      cleanup_proposal_id: completion.id,
      source: "web",
      from_status: "pending",
      to_status: "completed",
    });
    const replacementEvent = afterAccept.outstanding_item_events.find(
      (event) => event.item_id === items[2]!.id && event.cleanup_proposal_id === acceptedReplacement.id,
    );
    expect(replacementEvent).toMatchObject({
      cleanup_request_id: request.id,
      cleanup_proposal_id: acceptedReplacement.id,
      source: "web",
      from_status: "pending",
      to_status: "not_needed",
    });
    expect(afterAccept.outstanding_cleanup_proposals).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: completion.id, review_status: "accepted" })]),
    );
    expect(afterAccept.outstanding_cleanup_proposal_evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ proposal_id: completion.id, session_id: evidence.id, project_id: projectId }),
        expect.objectContaining({
          proposal_id: acceptedReplacement.id,
          session_id: evidence.id,
          project_id: projectId,
        }),
      ]),
    );
    expect(source.id).not.toBe(evidence.id);
  });

  it.each(STALE_MUTATIONS)("rejects a proposal after a %s and preserves its pending review state", (mutation) => {
    const { store, root, projectId } = createTrackedProject(`Cleanup stale ${mutation} fixture`);
    const source = finalize(store, root, `cleanup-single-stale-source-${mutation}`, ["Verify one stale transition"]);
    const item = pendingItems(store, projectId)[0]!;
    const evidence = finalize(store, root, `cleanup-single-stale-evidence-${mutation}`, [], EVIDENCE_TIME);
    const request = createRequest(store, projectId, `cleanup-single-stale-request-${mutation}`);
    const submitted = submitOneProposal(
      store,
      request.id,
      `cleanup-single-stale-submit-${mutation}`,
      item.id,
      evidence.id,
    );
    expect(submitted.outcome).toBe("outstanding_cleanup_proposals_submitted");
    if (submitted.outcome !== "outstanding_cleanup_proposals_submitted") throw new Error("Expected one proposal.");

    if (mutation === "source edit") {
      const edited = store.updateSessionSummary({
        sessionId: source.id,
        idempotencyKey: `cleanup-single-stale-edit-source-${mutation}`,
        summary: "Corrected source summary without advancing the frozen clock.",
      });
      expect(edited.outcome).toBe("summary_updated");
      if (edited.outcome !== "summary_updated") throw new Error("Expected source edit.");
      expect(edited.session.updatedAt).toBe(source.updatedAt);
    } else if (mutation === "item edit") {
      expect(store.updateOutstandingItemStatus(item.id, "completed", "web").outcome).toBe("outstanding_item_updated");
    } else if (mutation === "evidence edit") {
      const edited = store.updateSessionSummary({
        sessionId: evidence.id,
        idempotencyKey: `cleanup-single-stale-edit-evidence-${mutation}`,
        summary: "Corrected evidence summary without advancing the frozen clock.",
      });
      expect(edited.outcome).toBe("summary_updated");
      if (edited.outcome !== "summary_updated") throw new Error("Expected evidence edit.");
      expect(edited.session.updatedAt).toBe(evidence.updatedAt);
    } else if (mutation === "source void") {
      expect(
        store.setSessionVoid({ sessionId: source.id, voided: true, reason: "Synthetic source correction." }).outcome,
      ).toBe("session_void_updated");
    } else {
      expect(
        store.setSessionVoid({ sessionId: evidence.id, voided: true, reason: "Synthetic evidence correction." })
          .outcome,
      ).toBe("session_void_updated");
    }

    const beforeDecision = store.exportProjectData({ type: "project", projectId }).tables;
    expect(
      store.decideOutstandingCleanupProposals({
        requestId: request.id,
        proposalIds: submitted.proposalIds,
        decision: "accept",
      }),
    ).toMatchObject({ outcome: "rejected", reason: "stale_proposal" });
    const afterDecision = store.exportProjectData({ type: "project", projectId }).tables;
    expect(afterDecision.outstanding_item_events).toEqual(beforeDecision.outstanding_item_events);
    expect(afterDecision.outstanding_cleanup_proposals).toEqual(beforeDecision.outstanding_cleanup_proposals);
    const proposals = store.listOutstandingCleanupProposals({ requestId: request.id, reviewStatus: "pending" });
    expect(proposals).toMatchObject({
      outcome: "outstanding_cleanup_proposals",
      proposals: [expect.objectContaining({ id: submitted.proposalIds[0], reviewStatus: "pending", stale: true })],
    });
  });

  it("rejects a stale batch without partially deciding proposals, including same-millisecond edits", () => {
    const { store, root, projectId } = createTrackedProject("Cleanup stale batch fixture");
    const sourceRows = Array.from({ length: 5 }, (_, index) =>
      finalize(store, root, `cleanup-stale-source-${index}`, [`Stale batch item ${index + 1}`]),
    );
    const snapshotItems = pendingItems(store, projectId);
    const itemsBySource = sourceRows.map((source) => {
      const item = snapshotItems.find((candidate) => candidate.sourceSessionId === source.id);
      if (!item) throw new Error("Expected the cleanup item for each source Session.");
      return item;
    });
    const evidenceRows = Array.from({ length: 5 }, (_, index) =>
      finalize(store, root, `cleanup-stale-evidence-${index}`, [], EVIDENCE_TIME),
    );
    const request = createRequest(store, projectId, "cleanup-stale-request");
    const submitted = store.submitOutstandingCleanupProposals({
      requestId: request.id,
      idempotencyKey: "cleanup-stale-submit",
      examinedItemIds: itemsBySource.map((item) => item.id),
      proposals: itemsBySource.map((item, index) => ({
        itemId: item.id,
        status: "completed" as const,
        reason: `Synthetic evidence ${index + 1} directly verifies the obligation.`,
        evidenceSessionIds: [evidenceRows[index]!.id],
      })),
    });
    expect(submitted.outcome).toBe("outstanding_cleanup_proposals_submitted");
    if (submitted.outcome !== "outstanding_cleanup_proposals_submitted") throw new Error("Expected stale proposals.");
    const originalUpdate = sourceRows[0]!.updatedAt;
    const sourceEdit = store.updateSessionSummary({
      sessionId: sourceRows[0]!.id,
      idempotencyKey: "cleanup-stale-source-same-millisecond",
      summary: "Semantically corrected source in the same frozen millisecond.",
    });
    expect(sourceEdit.outcome).toBe("summary_updated");
    if (sourceEdit.outcome !== "summary_updated") throw new Error("Expected source summary update.");
    expect(sourceEdit.session.updatedAt).toBe(originalUpdate);
    expect(store.updateOutstandingItemStatus(itemsBySource[1]!.id, "completed", "web").outcome).toBe(
      "outstanding_item_updated",
    );
    const evidenceEdit = store.updateSessionSummary({
      sessionId: evidenceRows[2]!.id,
      idempotencyKey: "cleanup-stale-evidence-same-millisecond",
      summary: "Semantically corrected evidence in the same frozen millisecond.",
    });
    expect(evidenceEdit.outcome).toBe("summary_updated");
    if (evidenceEdit.outcome !== "summary_updated") throw new Error("Expected evidence summary update.");
    expect(evidenceEdit.session.updatedAt).toBe(evidenceRows[2]!.updatedAt);
    store.setSessionVoid({ sessionId: evidenceRows[3]!.id, voided: true, reason: "Synthetic evidence void." });
    store.setSessionVoid({ sessionId: sourceRows[4]!.id, voided: true, reason: "Synthetic source void." });

    const beforeDecision = store.exportProjectData({ type: "project", projectId }).tables;
    expect(
      store.decideOutstandingCleanupProposals({
        requestId: request.id,
        proposalIds: submitted.proposalIds,
        decision: "accept",
      }),
    ).toMatchObject({ outcome: "rejected", reason: "stale_proposal" });
    const afterDecision = store.exportProjectData({ type: "project", projectId }).tables;
    expect(afterDecision.outstanding_item_events).toEqual(beforeDecision.outstanding_item_events);
    expect(afterDecision.outstanding_cleanup_proposals).toEqual(beforeDecision.outstanding_cleanup_proposals);
    expect(
      store.listOutstandingCleanupProposals({ requestId: request.id, reviewStatus: "pending", pageSize: 0 }),
    ).toMatchObject({ outcome: "outstanding_cleanup_proposals", pageInfo: { total: 5 } });
    const pendingIds = pendingItems(store, projectId).map((item) => item.id);
    expect(pendingIds).toContain(itemsBySource[0]!.id);
    expect(pendingIds).toContain(itemsBySource[2]!.id);
    expect(pendingIds).toContain(itemsBySource[3]!.id);
    expect(pendingIds).not.toContain(itemsBySource[1]!.id);
    expect(pendingIds).not.toContain(itemsBySource[4]!.id);
  });

  it("limits decisions to 100, accepts a 100-item batch atomically, and rejects 101 without changes", () => {
    const { store, root, projectId } = createTrackedProject("Cleanup decision batch fixture");
    const allItems: string[] = [];
    for (let batch = 0; batch < 11; batch += 1) {
      const count = batch === 10 ? 1 : 20;
      finalize(
        store,
        root,
        `cleanup-batch-source-${batch}`,
        Array.from({ length: count }, (_, index) => `Batch decision obligation ${batch * 20 + index + 1}`),
      );
    }
    allItems.push(...allPendingItems(store, projectId).map((item) => item.id));
    const evidence = finalize(store, root, "cleanup-batch-evidence", [], EVIDENCE_TIME);
    const request = createRequest(store, projectId, "cleanup-batch-request");
    const proposalIds: string[] = [];
    for (let offset = 0; offset < allItems.length; offset += 5) {
      const examinedItemIds = allItems.slice(offset, offset + 5);
      const submitted = store.submitOutstandingCleanupProposals({
        requestId: request.id,
        idempotencyKey: `cleanup-batch-submit-${offset}`,
        examinedItemIds,
        proposals: examinedItemIds.map((itemId) => ({
          itemId,
          status: "completed" as const,
          reason: "The shared later Session verifies this synthetic item.",
          evidenceSessionIds: [evidence.id],
        })),
      });
      expect(submitted.outcome).toBe("outstanding_cleanup_proposals_submitted");
      if (submitted.outcome !== "outstanding_cleanup_proposals_submitted") throw new Error("Expected batch proposals.");
      proposalIds.push(...submitted.proposalIds);
    }
    expect(proposalIds).toHaveLength(201);
    const before = store.exportProjectData({ type: "project", projectId }).tables;
    expect(
      store.decideOutstandingCleanupProposals({
        requestId: request.id,
        proposalIds,
        decision: "accept",
      }),
    ).toMatchObject({ outcome: "rejected", reason: "invalid_proposals" });
    expect(store.exportProjectData({ type: "project", projectId }).tables.outstanding_item_events).toEqual(
      before.outstanding_item_events,
    );
    expect(store.exportProjectData({ type: "project", projectId }).tables.outstanding_cleanup_proposals).toEqual(
      before.outstanding_cleanup_proposals,
    );

    const acceptedIds = proposalIds.slice(0, 100);
    const rejectedIds = proposalIds.slice(100, 200);
    expect(
      store.decideOutstandingCleanupProposals({ requestId: request.id, proposalIds: acceptedIds, decision: "accept" }),
    ).toMatchObject({ outcome: "outstanding_cleanup_proposals_decided", decision: "accept", duplicate: false });
    const afterAccept = store.exportProjectData({ type: "project", projectId }).tables.outstanding_item_events;
    expect(afterAccept.length - before.outstanding_item_events.length).toBe(100);
    expect(
      store.decideOutstandingCleanupProposals({ requestId: request.id, proposalIds: rejectedIds, decision: "reject" }),
    ).toMatchObject({ outcome: "outstanding_cleanup_proposals_decided", decision: "reject", duplicate: false });
    expect(store.exportProjectData({ type: "project", projectId }).tables.outstanding_item_events).toEqual(afterAccept);
    expect(
      store.listOutstandingCleanupProposals({ requestId: request.id, reviewStatus: "rejected", pageSize: 0 }),
    ).toMatchObject({ outcome: "outstanding_cleanup_proposals", pageInfo: { total: 100 } });
    expect(
      store.decideOutstandingCleanupProposals({ requestId: request.id, proposalIds: acceptedIds, decision: "accept" }),
    ).toMatchObject({ outcome: "outstanding_cleanup_proposals_decided", duplicate: true });
    expect(
      store.decideOutstandingCleanupProposals({ requestId: request.id, proposalIds: rejectedIds, decision: "reject" }),
    ).toMatchObject({ outcome: "outstanding_cleanup_proposals_decided", duplicate: true });
    expect(store.exportProjectData({ type: "project", projectId }).tables.outstanding_item_events).toEqual(afterAccept);
    expect(allPendingItems(store, projectId)).toHaveLength(101);
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

  it("rolls back item, proposal, and audit changes when cleanup audit insertion fails", () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-outstanding-cleanup-rollback-"));
    tempDirs.push(root);
    const store = new WorkIntelligenceStore(join(root, "store.sqlite"));
    stores.push(store);
    const project = store.addProject("Cleanup rollback fixture", root);
    store.updateProject(project.id, { status: "tracked" });
    const source = finalize(store, root, "cleanup-rollback-source", ["Rollback accepted cleanup item"]);
    const item = pendingItems(store, project.id)[0]!;
    const evidence = finalize(store, root, "cleanup-rollback-evidence", [], EVIDENCE_TIME);
    const request = createRequest(store, project.id, "cleanup-rollback-request");
    const submitted = submitOneProposal(store, request.id, "cleanup-rollback-submit", item.id, evidence.id);
    expect(submitted.outcome).toBe("outstanding_cleanup_proposals_submitted");
    if (submitted.outcome !== "outstanding_cleanup_proposals_submitted") throw new Error("Expected rollback proposal.");
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

    expect(() =>
      store.decideOutstandingCleanupProposals({
        requestId: request.id,
        proposalIds: submitted.proposalIds,
        decision: "accept",
      }),
    ).toThrow();
    const after = store.exportProjectData({ type: "project", projectId: project.id }).tables;
    expect(after).toEqual(before);
    expect(pendingItems(store, project.id).map((pending) => pending.id)).toContain(item.id);
    expect(source.id).not.toBe(evidence.id);
  });
});
