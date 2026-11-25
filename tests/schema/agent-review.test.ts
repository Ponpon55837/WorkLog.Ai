import { describe, expect, it } from "vitest";
import {
  agentReviewContextQuerySchema,
  agentReviewRequestQuerySchema,
  createAgentReviewRequestInputSchema,
  overturnAgentReviewInputSchema,
  requestAgentReviewInputSchema,
  sessionDecisionListQuerySchema,
  knowledgeCandidateListQuerySchema,
  submitAgentReviewVerdictsInputSchema,
} from "../../packages/schema/src/index.js";

// Fictional ids only.
const decisionVerdict = { itemKind: "decision", itemId: "decision-1", verdict: "confirm", reason: "Matches the diff." };
const candidateVerdict = { itemKind: "candidate", itemId: "candidate-1", verdict: "accept", reason: "Quotes the fix." };
const submission = (verdicts: unknown[], extra: Record<string, unknown> = {}) => ({
  requestId: "request-1",
  idempotencyKey: "submit-1",
  verdicts,
  ...extra,
});

describe("Agent review inputs", () => {
  it("accepts decision and candidate verdicts and trims the reason", () => {
    const parsed = submitAgentReviewVerdictsInputSchema.safeParse(
      submission([{ ...decisionVerdict, reason: "  Matches the diff.  " }, candidateVerdict]),
    );
    expect(parsed.success).toBe(true);
    expect(parsed.data?.verdicts[0]?.reason).toBe("Matches the diff.");
  });

  it("requires knowledge to promote, and only then", () => {
    const knowledge = { title: "Pin the base image", body: "Builds drift without a pin." };
    expect(
      submitAgentReviewVerdictsInputSchema.safeParse(submission([{ ...decisionVerdict, verdict: "promote" }])).success,
    ).toBe(false);
    expect(
      submitAgentReviewVerdictsInputSchema.safeParse(
        submission([{ ...decisionVerdict, verdict: "promote", knowledge }]),
      ).success,
    ).toBe(true);
    expect(
      submitAgentReviewVerdictsInputSchema.safeParse(submission([{ ...decisionVerdict, knowledge }])).success,
    ).toBe(false);
  });

  it("allows edits only when accepting a candidate", () => {
    const edits = { title: "A sharper title" };
    expect(submitAgentReviewVerdictsInputSchema.safeParse(submission([{ ...candidateVerdict, edits }])).success).toBe(
      true,
    );
    expect(
      submitAgentReviewVerdictsInputSchema.safeParse(submission([{ ...candidateVerdict, verdict: "reject", edits }]))
        .success,
    ).toBe(false);
  });

  it("rejects verdicts that mix kinds, unknown keys, missing reasons and repeated items", () => {
    for (const invalid of [
      submission([{ ...decisionVerdict, verdict: "accept" }]),
      submission([{ ...candidateVerdict, verdict: "promote" }]),
      submission([{ ...decisionVerdict, extra: true }]),
      submission([{ ...decisionVerdict, reason: "   " }]),
      submission([decisionVerdict, decisionVerdict]),
      submission([decisionVerdict], { surprise: true }),
      submission(Array.from({ length: 51 }, (_, index) => ({ ...decisionVerdict, itemId: `decision-${index}` }))),
    ]) {
      expect(submitAgentReviewVerdictsInputSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("accepts the same id once per kind and an empty list only when completing", () => {
    expect(
      submitAgentReviewVerdictsInputSchema.safeParse(
        submission([decisionVerdict, { ...candidateVerdict, itemId: decisionVerdict.itemId }]),
      ).success,
    ).toBe(true);
    expect(submitAgentReviewVerdictsInputSchema.safeParse(submission([])).success).toBe(false);
    expect(submitAgentReviewVerdictsInputSchema.safeParse(submission([], { complete: true })).success).toBe(true);
  });

  it("validates the request, context, list and overturn inputs", () => {
    expect(requestAgentReviewInputSchema.safeParse({ projectRoot: "/tmp/orchard", idempotencyKey: "k" }).success).toBe(
      true,
    );
    expect(requestAgentReviewInputSchema.safeParse({ projectRoot: "", idempotencyKey: "k" }).success).toBe(false);
    expect(createAgentReviewRequestInputSchema.safeParse({ projectId: "project-1", idempotencyKey: "k" }).success).toBe(
      true,
    );
    expect(agentReviewContextQuerySchema.safeParse({}).success).toBe(false);
    expect(agentReviewContextQuerySchema.parse({ requestId: "request-1" })).toMatchObject({ page: 1, pageSize: 10 });
    expect(agentReviewContextQuerySchema.safeParse({ requestId: "request-1", pageSize: 11 }).success).toBe(false);
    expect(agentReviewRequestQuerySchema.parse({})).toMatchObject({ pageSize: 5 });
    expect(agentReviewRequestQuerySchema.safeParse({ status: "unknown" }).success).toBe(false);
    expect(
      overturnAgentReviewInputSchema.safeParse({ projectRoot: "/tmp/orchard", itemKind: "decision", itemId: "d-1" })
        .success,
    ).toBe(true);
    expect(
      overturnAgentReviewInputSchema.safeParse({ projectRoot: "/tmp/orchard", itemKind: "report", itemId: "d-1" })
        .success,
    ).toBe(false);
  });

  it("lists Agent-reviewed decisions and candidates", () => {
    expect(sessionDecisionListQuerySchema.safeParse({ status: "agent_reviewed" }).success).toBe(true);
    expect(knowledgeCandidateListQuerySchema.safeParse({ reviewedBy: "agent" }).success).toBe(true);
    expect(knowledgeCandidateListQuerySchema.safeParse({ reviewedBy: "user" }).success).toBe(false);
  });
});
