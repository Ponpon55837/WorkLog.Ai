import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  isDefaultKnowledgePageSlug,
  type DeleteKnowledgePageResult,
  type KnowledgePageDeletionCounts,
  type PolicyDecision,
} from "@work-intelligence/core";
import { nowIso } from "@work-intelligence/shared";
import { runImmediateTransaction } from "./sqlite-transaction.js";

export type KnowledgePageDeletionErrorCode = "knowledge_page_not_found" | "knowledge_page_default";

export class KnowledgePageDeletionError extends Error {
  public constructor(public readonly code: KnowledgePageDeletionErrorCode) {
    super(code);
    this.name = "KnowledgePageDeletionError";
  }
}

type PageStateRow = { id: string; project_id: string; slug: string };

/** The content-free audit row lets a merge import report the page as deleted instead of adding it back. */
export class KnowledgePageDeletionService {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly checkProjectById: (projectId: string) => PolicyDecision,
  ) {}

  public deletePage(pageId: string): DeleteKnowledgePageResult {
    const decision = this.checkProjectById(this.assertDeletable(pageId).project_id);
    if (!decision.allowed) {
      return {
        outcome: "skipped",
        projectRoot: decision.canonicalRoot,
        projectStatus: decision.projectStatus,
        reason: decision.reason ?? "Project recording is not enabled.",
      };
    }
    return runImmediateTransaction(this.db, () => {
      const page = this.assertDeletable(pageId);
      const deletedCounts: KnowledgePageDeletionCounts = {
        knowledgePageVersions: this.count("SELECT COUNT(*) AS count FROM knowledge_page_versions WHERE page_id = ?", [
          page.id,
        ]),
        attentionPreferences: this.count(
          "SELECT COUNT(*) AS count FROM attention_preferences WHERE project_id = ? AND kind = 'knowledge_page' AND source_id = ?",
          [page.project_id, page.id],
        ),
      };
      this.db.prepare("DELETE FROM knowledge_page_versions WHERE page_id = ?").run(page.id);
      this.db.prepare("DELETE FROM knowledge_pages WHERE id = ?").run(page.id);
      const deletedAt = nowIso();
      this.db
        .prepare(
          `INSERT INTO knowledge_page_deletion_audit (id, deleted_at, page_id, project_id, deleted_counts_json)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(randomUUID(), deletedAt, page.id, page.project_id, JSON.stringify(deletedCounts));
      return {
        outcome: "knowledge_page_deleted" as const,
        pageId: page.id,
        projectId: page.project_id,
        slug: page.slug,
        deletedAt,
        deletedCounts,
      };
    });
  }

  /** Re-run inside the transaction: the page may have been deleted since the first check. */
  private assertDeletable(pageId: string): PageStateRow {
    const page = this.db.prepare("SELECT id, project_id, slug FROM knowledge_pages WHERE id = ?").get(pageId) as
      PageStateRow | undefined;
    if (!page) {
      throw new KnowledgePageDeletionError("knowledge_page_not_found");
    }
    if (isDefaultKnowledgePageSlug(page.slug)) {
      throw new KnowledgePageDeletionError("knowledge_page_default");
    }
    return page;
  }

  private count(sql: string, parameters: readonly string[]): number {
    return (this.db.prepare(sql).get(...parameters) as { count: number }).count;
  }
}
