import { describe, expect, it } from "vitest";
import { toFinalizeReceipt } from "../../apps/mcp/src/finalize-receipt.js";
import type { WorkIntelligenceStore } from "../../packages/storage/src/index.js";

type FinalizeResult = ReturnType<WorkIntelligenceStore["finalizeSession"]>;
type Finalized = Extract<FinalizeResult, { outcome: "finalized" }>;

const SESSION: Finalized["session"] = {
  id: "session-receipt-1",
  projectId: "project-receipt",
  idempotencyKey: "receipt-key",
  title: "Fictional submitted title",
  summary: "Fictional submitted summary.",
  workSummary: { outcomes: ["Fictional outcome."], scope: [], decisions: [], verification: [], nextSteps: [] },
  status: "finalized",
  executionStatus: "completed",
  startedAt: "2026-06-01T08:00:00.000Z",
  completedAt: "2026-06-01T09:00:00.000Z",
  createdAt: "2026-06-01T09:00:00.000Z",
  updatedAt: "2026-06-01T09:00:00.000Z",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  gitBranch: "feature/fictional",
  changedFiles: ["src/ledger.ts"],
  changedFilesProvenance: [],
  changedFileChanges: [],
  verification: { status: "passed", summary: "Fictional checks passed." },
};

function finalized(overrides: Partial<Finalized> = {}): Finalized {
  return {
    outcome: "finalized",
    duplicate: false,
    session: SESSION,
    redactions: { total: 0, byKind: {} },
    resolvedOutstandingItemIds: [],
    supersededOutstandingItemIds: [],
    ...overrides,
  };
}

describe("finalize receipt", () => {
  it("reports identity, times, and counts without echoing the submitted record", () => {
    const receipt = toFinalizeReceipt(
      { changedFiles: ["src/ledger.ts"], startedAt: SESSION.startedAt, git: { branch: "feature/fictional" } },
      finalized(),
    );
    expect(receipt).toEqual({
      outcome: "finalized",
      duplicate: false,
      session: {
        id: SESSION.id,
        executionStatus: "completed",
        completedAt: SESSION.completedAt,
        updatedAt: SESSION.updatedAt,
        verificationStatus: "passed",
        changedFilesCount: 1,
      },
    });
  });

  it("reports what the server derived: stored files, Git metadata, start time, masking, and transitions", () => {
    const receipt = toFinalizeReceipt(
      { changedFiles: ["./src/ledger.ts", "src/baseline.ts"], resolvedOutstandingItemIds: ["item-missing"] },
      finalized({
        redactions: { total: 2, byKind: { github_token: 2 } },
        supersededOutstandingItemIds: ["item-recovered"],
        knowledgeToReview: [{ id: "knowledge-1", title: "Fictional rule", path: "src/ledger.ts" }],
        relatedOutstandingItems: {
          items: [
            {
              id: "item-1",
              sourceSessionId: "session-source",
              sourceSessionTitle: "Fictional source",
              sourceSessionCompletedAt: "2026-05-01T09:00:00.000Z",
              text: "Fictional follow-up.",
            },
          ],
          total: 1,
          omitted: 0,
        },
      }),
    );
    expect(receipt).toMatchObject({
      session: {
        startedAt: SESSION.startedAt,
        changedFiles: ["src/ledger.ts"],
        commitSha: SESSION.commitSha,
        gitBranch: SESSION.gitBranch,
      },
      redactions: { total: 2, byKind: { github_token: 2 } },
      resolvedOutstandingItemIds: [],
      supersededOutstandingItemIds: ["item-recovered"],
      knowledgeToReview: [{ id: "knowledge-1", path: "src/ledger.ts" }],
      relatedOutstandingItems: {
        items: [{ id: "item-1", sourceSessionId: "session-source", text: "Fictional follow-up." }],
        total: 1,
      },
    });
    expect(JSON.stringify(receipt)).not.toContain("Fictional submitted");
    expect(JSON.stringify(receipt)).not.toContain("sourceSessionTitle");
  });

  it("passes other outcomes through unchanged", () => {
    const skipped: FinalizeResult = {
      outcome: "skipped",
      projectRoot: "/fictional",
      projectStatus: "unregistered",
      reason: "Not tracked.",
    };
    expect(toFinalizeReceipt({}, skipped)).toBe(skipped);
  });
});
