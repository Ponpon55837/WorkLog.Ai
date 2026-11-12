import { describe, expect, it } from "vitest";
import {
  toSessionMetadataReceipt,
  toSessionSummaryReceipt,
  toSessionTitleReceipt,
  toSessionWorkSummaryReceipt,
} from "../../apps/mcp/src/session-update-receipt.js";
import type { WorkIntelligenceStore } from "../../packages/storage/src/index.js";

type MetadataResult = ReturnType<WorkIntelligenceStore["updateSessionMetadata"]>;
type Session = Extract<MetadataResult, { outcome: "updated" }>["session"];

const WORK_SUMMARY = {
  outcomes: ["Fictional outcome."],
  scope: ["Fictional scope."],
  decisions: ["Fictional decision."],
  verification: ["Fictional check."],
  nextSteps: [],
};

const SESSION: Session = {
  id: "session-update-receipt-1",
  projectId: "project-update-receipt",
  idempotencyKey: "update-receipt-key",
  title: "Fictional stored title",
  summary: "Fictional stored summary.",
  workSummary: WORK_SUMMARY,
  status: "finalized",
  executionStatus: "completed",
  completedAt: "2026-06-01T09:00:00.000Z",
  createdAt: "2026-06-01T09:00:00.000Z",
  updatedAt: "2026-06-02T09:00:00.000Z",
  changedFiles: ["src/ledger.ts", "src/panel.ts"],
  changedFilesProvenance: [],
  changedFileChanges: [],
  verification: { status: "failed", summary: "Fictional checks failed." },
};

const RECEIPT_SESSION = {
  id: SESSION.id,
  executionStatus: "completed",
  completedAt: SESSION.completedAt,
  updatedAt: SESSION.updatedAt,
  verificationStatus: "failed",
  changedFilesCount: 2,
};

const NO_REDACTIONS = { total: 0, byKind: {} };
const ONE_REDACTION = { total: 1, byKind: { github_token: 1 } };

describe("Session update receipts", () => {
  it("answers a metadata update with identity, counts, and warnings, and the stored list only when it differs", () => {
    const result: MetadataResult = { outcome: "updated", session: SESSION, redactions: NO_REDACTIONS };
    expect(toSessionMetadataReceipt({ changedFiles: SESSION.changedFiles }, result)).toEqual({
      outcome: "updated",
      session: RECEIPT_SESSION,
    });

    const merged = toSessionMetadataReceipt(
      { changedFiles: ["src/panel.ts"] },
      {
        ...result,
        session: { ...SESSION, startedAt: "2026-06-01T08:00:00.000Z", voided: { at: "2026-06-03", reason: "Test" } },
        redactions: ONE_REDACTION,
        timestampWarnings: ["startedAt was not applied."],
      },
    );
    expect(merged).toEqual({
      outcome: "updated",
      session: {
        ...RECEIPT_SESSION,
        startedAt: "2026-06-01T08:00:00.000Z",
        voided: { at: "2026-06-03", reason: "Test" },
      },
      changedFiles: SESSION.changedFiles,
      redactions: ONE_REDACTION,
      timestampWarnings: ["startedAt was not applied."],
    });
  });

  it("returns the stored summary only when it is not what was sent", () => {
    const updated = {
      outcome: "summary_updated" as const,
      duplicate: false,
      session: SESSION,
      idempotencyKey: "summary-key",
      mode: "replace" as const,
      previousSummary: "Fictional earlier summary.",
      appliedSummary: "Fictional stored summary.",
    };
    const plain = { outcome: "summary_updated", duplicate: false, mode: "replace", session: RECEIPT_SESSION };
    expect(toSessionSummaryReceipt({ summary: "Fictional stored summary." }, updated)).toEqual(plain);
    expect(
      toSessionSummaryReceipt(
        { summary: "Fictional follow-up." },
        { ...updated, mode: "append", appliedSummary: "Fictional earlier summary.\n\nFictional follow-up." },
      ),
    ).toEqual({ ...plain, mode: "append" });
    expect(
      toSessionSummaryReceipt(
        { summary: "Fictional summary with sk-secret." },
        { ...updated, appliedSummary: "Fictional summary with [REDACTED].", redactions: ONE_REDACTION },
      ),
    ).toEqual({ ...plain, summary: "Fictional summary with [REDACTED].", redactions: ONE_REDACTION });
    expect(
      toSessionSummaryReceipt(
        { summary: "Fictional follow-up with sk-secret." },
        {
          ...updated,
          mode: "append",
          appliedSummary: "Fictional earlier summary.\n\nFictional follow-up with [REDACTED].",
        },
      ),
    ).toMatchObject({ summary: "Fictional earlier summary.\n\nFictional follow-up with [REDACTED]." });
  });

  it("keeps the previous title and returns the stored title only when it differs", () => {
    const updated = {
      outcome: "title_updated" as const,
      duplicate: false,
      session: SESSION,
      previousTitle: "Fictional misleading title",
    };
    expect(toSessionTitleReceipt({ title: SESSION.title }, updated)).toEqual({
      outcome: "title_updated",
      duplicate: false,
      previousTitle: "Fictional misleading title",
      session: RECEIPT_SESSION,
    });
    expect(
      toSessionTitleReceipt({ title: "Fictional title with sk-secret" }, { ...updated, redactions: ONE_REDACTION }),
    ).toMatchObject({ title: SESSION.title, redactions: ONE_REDACTION });
  });

  it("returns only the stored workSummary sections that differ from the submitted ones", () => {
    const updated = {
      outcome: "work_summary_updated" as const,
      duplicate: false,
      session: SESSION,
      idempotencyKey: "work-summary-key",
      mode: "patch" as const,
      previousWorkSummary: { ...WORK_SUMMARY, outcomes: [] },
      appliedWorkSummary: WORK_SUMMARY,
    };
    expect(
      toSessionWorkSummaryReceipt(
        {
          workSummary: {
            outcomes: ["Fictional outcome."],
            decisions: [{ text: "Fictional decision." }],
          },
        },
        updated,
      ),
    ).toEqual({ outcome: "work_summary_updated", duplicate: false, mode: "patch", session: RECEIPT_SESSION });
    expect(
      toSessionWorkSummaryReceipt(
        { workSummary: { outcomes: ["Fictional outcome with sk-secret."], scope: ["Fictional scope."] } },
        { ...updated, redactions: ONE_REDACTION },
      ),
    ).toEqual({
      outcome: "work_summary_updated",
      duplicate: false,
      mode: "patch",
      session: RECEIPT_SESSION,
      workSummary: { outcomes: ["Fictional outcome."] },
      redactions: ONE_REDACTION,
    });
  });

  it("passes every other outcome through unchanged", () => {
    const skipped = {
      outcome: "skipped" as const,
      sessionId: "s",
      projectStatus: "paused" as const,
      reason: "Paused.",
    };
    const notFound = { outcome: "not_found" as const, sessionId: "s" };
    const conflict = {
      outcome: "summary_update_idempotency_conflict" as const,
      sessionId: "s",
      idempotencyKey: "k",
      reason: "Different payload.",
    };
    const workConflict = { ...conflict, outcome: "work_summary_update_idempotency_conflict" as const };
    expect(toSessionMetadataReceipt({ changedFiles: [] }, skipped)).toBe(skipped);
    expect(toSessionSummaryReceipt({ summary: "x" }, conflict)).toBe(conflict);
    expect(toSessionTitleReceipt({ title: "x" }, notFound)).toBe(notFound);
    expect(toSessionWorkSummaryReceipt({ workSummary: {} }, workConflict)).toBe(workConflict);
  });
});
