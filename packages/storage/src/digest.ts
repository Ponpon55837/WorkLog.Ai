import type { KnowledgeDigest, KnowledgeRecord, SessionDigest, WorkSessionRecord } from "@work-intelligence/core";
import { truncateText } from "@work-intelligence/shared";

// Digest limits keep a full context result within a few KB; full records stay one tool call away.
export const DIGEST_SUMMARY_LENGTH = 400;
export const DIGEST_KNOWLEDGE_LENGTH = 400;
export const DIGEST_ITEM_LENGTH = 200;
export const DIGEST_OPEN_ITEMS = 3;

export function toSessionDigest(session: WorkSessionRecord): SessionDigest {
  return {
    id: session.id,
    projectId: session.projectId,
    ...(session.projectName ? { projectName: session.projectName } : {}),
    title: session.title,
    summary: truncateText(session.summary, DIGEST_SUMMARY_LENGTH),
    completedAt: session.completedAt,
    ...(session.gitBranch ? { gitBranch: session.gitBranch } : {}),
    verificationStatus: session.verification?.status ?? "not_supplied",
    changedFilesCount: session.changedFiles.length,
    openItems: (session.workSummary?.nextSteps ?? [])
      .slice(0, DIGEST_OPEN_ITEMS)
      .map((item) => truncateText(item, DIGEST_ITEM_LENGTH)),
  };
}

export function toKnowledgeDigest(knowledge: KnowledgeRecord): KnowledgeDigest {
  return {
    id: knowledge.id,
    projectId: knowledge.projectId,
    ...(knowledge.projectName ? { projectName: knowledge.projectName } : {}),
    ...(knowledge.sessionId ? { sessionId: knowledge.sessionId } : {}),
    kind: knowledge.kind,
    title: knowledge.title,
    excerpt: truncateText(knowledge.body, DIGEST_KNOWLEDGE_LENGTH),
    tags: knowledge.tags,
    updatedAt: knowledge.updatedAt,
    ...(knowledge.possiblyStale ? { possiblyStale: true } : {}),
    ...(knowledge.review ? { needsReview: true } : {}),
  };
}
