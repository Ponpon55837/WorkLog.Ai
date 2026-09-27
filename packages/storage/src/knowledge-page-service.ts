import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  KNOWLEDGE_PAGE_DEFAULTS,
  KNOWLEDGE_PAGE_INSUFFICIENT,
  type KnowledgePageAuthor,
  type KnowledgePageContextQuery,
  type KnowledgePageContextResult,
  type KnowledgePageContextSession,
  type KnowledgePageDigest,
  type KnowledgePageListQuery,
  type KnowledgePageListResult,
  type KnowledgePageRecord,
  type KnowledgePageSection,
  type KnowledgePageSkippedResult,
  type KnowledgePageVersionRecord,
  type KnowledgePageVersionsResult,
  type PolicyDecision,
  type RequestKnowledgePageUpdateInput,
  type RequestKnowledgePageUpdateResult,
  type SaveKnowledgePageInput,
  type SaveKnowledgePageResult,
  type UpdateKnowledgePageInput,
  type UpdateKnowledgePageResult,
} from "@work-intelligence/core";
import { nowIso, truncateText } from "@work-intelligence/shared";
import { combineRedactionSummaries, redactText, redactValue } from "./secret-redaction.js";
import { parseJson, parseWorkSummarySections } from "./session-record-codecs.js";
import { runImmediateTransaction } from "./sqlite-transaction.js";

export interface KnowledgePageDependencies {
  checkProjectRoot(projectRoot: string): PolicyDecision;
  checkProjectById(projectId: string): PolicyDecision;
}

type PageRow = {
  id: string;
  project_id: string;
  slug: string;
  title: string;
  question: string;
  sections_json: string;
  version: number;
  sourced_through: string | null;
  update_requested_at: string | null;
  last_author: KnowledgePageAuthor | null;
  created_at: string;
  updated_at: string;
};

type VersionRow = {
  id: string;
  page_id: string;
  version: number;
  title: string;
  question: string;
  sections_json: string;
  author: KnowledgePageAuthor;
  created_at: string;
};

/** Sessions an Agent gets while writing a page, newest first. */
const CONTEXT_SESSION_LIMIT = 60;
/** Character budget for those Sessions, so the context fits in one tool result. */
const CONTEXT_CHAR_BUDGET = 40_000;
/** How much of each page work_get_context includes, and of all pages together. */
const DIGEST_PAGE_CHARS = 1_500;
const DIGEST_TOTAL_CHARS = 4_500;
/** Versions shown in the Web history; older versions stay in the database and in exports. */
const VERSION_HISTORY_LIMIT = 50;

const DEFAULT_PAGES = new Map<string, { title: string; question: string }>(
  KNOWLEDGE_PAGE_DEFAULTS.map((page) => [page.slug, { title: page.title, question: page.question }]),
);

function skipped(decision: PolicyDecision): KnowledgePageSkippedResult {
  return {
    outcome: "skipped",
    projectRoot: decision.canonicalRoot,
    projectStatus: decision.projectStatus,
    reason: decision.reason ?? "Project recording is not enabled.",
  };
}

/** Index of the first element strictly greater than `value` in an ascending list (upper bound). */
function upperBound(sorted: readonly string[], value: string): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle]! > value) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}

function citedSessionIds(sections: readonly KnowledgePageSection[]): string[] {
  return [...new Set(sections.flatMap((section) => section.sourceSessionIds))];
}

function toVersion(row: VersionRow): KnowledgePageVersionRecord {
  return {
    id: row.id,
    pageId: row.page_id,
    version: row.version,
    title: row.title,
    question: row.question,
    sections: parseJson<KnowledgePageSection[]>(row.sections_json, []),
    author: row.author,
    createdAt: row.created_at,
  };
}

/** Renders a page's sections as Markdown with the cited Session ids after each section. */
export function renderKnowledgePage(sections: readonly KnowledgePageSection[]): string {
  return sections
    .map((section) => {
      const sources = section.sourceSessionIds.length > 0 ? `\n\n來源：${section.sourceSessionIds.join("、")}` : "";
      return `## ${section.heading}\n\n${section.content}${sources}`;
    })
    .join("\n\n");
}

/** Owns standing Knowledge pages: Agent update requests, their context, saving versions, and staleness. */
export class KnowledgePageService {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly dependencies: KnowledgePageDependencies,
  ) {}

  public listPages(query: KnowledgePageListQuery = {}): KnowledgePageListResult {
    if (query.projectRoot || query.projectId) {
      const decision = query.projectRoot
        ? this.dependencies.checkProjectRoot(query.projectRoot)
        : this.dependencies.checkProjectById(query.projectId!);
      if (!decision.allowed || !decision.project) {
        return skipped(decision);
      }
      return { outcome: "knowledge_pages", items: this.pagesForProjects([decision.project.id]) };
    }
    return { outcome: "knowledge_pages", items: this.pagesForProjects(this.trackedProjectIds()) };
  }

  public requestUpdate(input: RequestKnowledgePageUpdateInput): RequestKnowledgePageUpdateResult {
    const decision = this.dependencies.checkProjectRoot(input.projectRoot);
    if (!decision.allowed || !decision.project) {
      return skipped(decision);
    }
    const projectId = decision.project.id;
    const existing = this.findPage(projectId, input.slug);
    const fallback = DEFAULT_PAGES.get(input.slug);
    const title = input.title ?? existing?.title ?? fallback?.title;
    const question = input.question ?? existing?.question ?? fallback?.question;
    if (!title || !question) {
      return {
        outcome: "invalid_page",
        reason: "A page that is not one of the defaults needs a title and a question.",
      };
    }
    const now = nowIso();
    runImmediateTransaction(this.db, () => {
      if (existing) {
        this.db
          .prepare(
            "UPDATE knowledge_pages SET title = ?, question = ?, update_requested_at = ?, updated_at = ? WHERE id = ?",
          )
          .run(title, question, now, now, existing.id);
      } else {
        this.db
          .prepare(
            `INSERT INTO knowledge_pages (id, project_id, slug, title, question, update_requested_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(randomUUID(), projectId, input.slug, title, question, now, now, now);
      }
    });
    return { outcome: "knowledge_page_update_requested", page: this.recordFor(this.findPage(projectId, input.slug)!) };
  }

  public getContext(query: KnowledgePageContextQuery): KnowledgePageContextResult {
    const decision = this.dependencies.checkProjectRoot(query.projectRoot);
    if (!decision.allowed || !decision.project) {
      return skipped(decision);
    }
    const row = this.findPage(decision.project.id, query.slug);
    if (!row) {
      return {
        outcome: "not_found",
        slug: query.slug,
        reason: "Request the page with work_request_knowledge_page_update first.",
      };
    }
    const { sessions, truncated } = this.contextSessions(decision.project.id);
    return {
      outcome: "knowledge_page_context",
      page: this.recordFor(row),
      instructions:
        `Answer the page question for this project from these Sessions only. Rewrite the whole page as sections; ` +
        `every section cites the Session ids it is based on in sourceSessionIds. When the Sessions do not answer ` +
        `part of the question, write a section whose content is exactly "${KNOWLEDGE_PAGE_INSUFFICIENT}" instead of ` +
        `guessing. Keep facts current: drop what later Sessions contradict. Save with work_save_knowledge_page.`,
      sessions,
      truncated,
    };
  }

  public savePage(input: SaveKnowledgePageInput): SaveKnowledgePageResult {
    const decision = this.dependencies.checkProjectRoot(input.projectRoot);
    if (!decision.allowed || !decision.project) {
      return skipped(decision);
    }
    const row = this.findPage(decision.project.id, input.slug);
    if (!row) {
      return {
        outcome: "not_found",
        slug: input.slug,
        reason: "Request the page with work_request_knowledge_page_update first.",
      };
    }
    const duplicate = this.db
      .prepare("SELECT 1 AS found FROM knowledge_page_versions WHERE page_id = ? AND idempotency_key = ?")
      .get(row.id, input.idempotencyKey);
    if (duplicate) {
      return { outcome: "knowledge_page_saved", duplicate: true, page: this.recordFor(this.findPageById(row.id)!) };
    }
    const invalid = this.invalidSources(decision.project.id, input.sections);
    if (invalid.length > 0) {
      return {
        outcome: "invalid_sources",
        reason: "Every cited Session must belong to this project and must not be voided.",
        sessionIds: invalid,
      };
    }
    const { redactions } = this.writeVersion(row, row.title, input.sections, "agent", input.idempotencyKey);
    return {
      outcome: "knowledge_page_saved",
      duplicate: false,
      page: this.recordFor(this.findPageById(row.id)!),
      ...(redactions.total > 0 ? { redactions } : {}),
    };
  }

  /** A manual edit from the Web UI; it is kept as a version like an Agent update. */
  public updatePage(input: UpdateKnowledgePageInput): UpdateKnowledgePageResult {
    const row = this.findPageById(input.pageId);
    if (!row) {
      return { outcome: "not_found", pageId: input.pageId, reason: "Knowledge page does not exist." };
    }
    const decision = this.dependencies.checkProjectById(row.project_id);
    if (!decision.allowed) {
      return skipped(decision);
    }
    const invalid = this.invalidSources(row.project_id, input.sections);
    if (invalid.length > 0) {
      return {
        outcome: "invalid_sources",
        reason: "Every cited Session must belong to this project and must not be voided.",
        sessionIds: invalid,
      };
    }
    const { redactions } = this.writeVersion(row, input.title ?? row.title, input.sections, "web");
    return {
      outcome: "knowledge_page_updated",
      page: this.recordFor(this.findPageById(row.id)!),
      ...(redactions.total > 0 ? { redactions } : {}),
    };
  }

  public listVersions(pageId: string): KnowledgePageVersionsResult {
    const row = this.findPageById(pageId);
    if (!row) {
      return { outcome: "not_found", pageId, reason: "Knowledge page does not exist." };
    }
    const decision = this.dependencies.checkProjectById(row.project_id);
    if (!decision.allowed) {
      return skipped(decision);
    }
    const versions = (
      this.db
        .prepare(
          `SELECT id, page_id, version, title, question, sections_json, author, created_at
           FROM knowledge_page_versions WHERE page_id = ? ORDER BY version DESC LIMIT ?`,
        )
        .all(pageId, VERSION_HISTORY_LIMIT) as VersionRow[]
    ).map(toVersion);
    const page = this.recordFor(row);
    const cited = citedSessionIds([...page.sections, ...versions.flatMap((version) => version.sections)]);
    const sources =
      cited.length === 0
        ? []
        : (this.db
            .prepare(
              `SELECT id, title FROM sessions
               WHERE id IN (SELECT value FROM json_each(?)) AND voided_at IS NULL ORDER BY completed_at DESC`,
            )
            .all(JSON.stringify(cited)) as Array<{ id: string; title: string }>);
    return { outcome: "knowledge_page_versions", page, versions, sources };
  }

  /** Pages for work_get_context: written pages first, each cut to a fixed length within a total budget. */
  public digestsForProject(projectId: string): KnowledgePageDigest[] {
    let remaining = DIGEST_TOTAL_CHARS;
    const digests: KnowledgePageDigest[] = [];
    for (const page of this.pagesForProjects([projectId]).filter((item) => item.version > 0)) {
      if (remaining <= 0) {
        break;
      }
      const rendered = renderKnowledgePage(page.sections);
      const limit = Math.min(DIGEST_PAGE_CHARS, remaining);
      const content = truncateText(rendered, limit);
      remaining -= content.length;
      digests.push({
        slug: page.slug,
        title: page.title,
        status: page.status,
        updatedAt: page.updatedAt,
        content,
        truncated: content.length < rendered.length,
      });
    }
    return digests;
  }

  /** Pages an Agent should (re)write: an update was requested, or newer Sessions exist (all tracked projects without an id). */
  public pendingForProject(projectId?: string): Array<{
    slug: string;
    title: string;
    status: KnowledgePageRecord["status"];
    updateRequested: boolean;
  }> {
    return this.pagesForProjects(projectId ? [projectId] : this.trackedProjectIds())
      .filter((page) => page.status === "needs_update" || page.updateRequestedAt)
      .map((page) => ({
        slug: page.slug,
        title: page.title,
        status: page.status,
        updateRequested: Boolean(page.updateRequestedAt),
      }));
  }

  private trackedProjectIds(): string[] {
    return (
      this.db.prepare("SELECT id FROM projects WHERE status = 'tracked' ORDER BY name ASC").all() as Array<{
        id: string;
      }>
    ).map((row) => row.id);
  }

  private findPage(projectId: string, slug: string): PageRow | undefined {
    return this.db.prepare("SELECT * FROM knowledge_pages WHERE project_id = ? AND slug = ?").get(projectId, slug) as
      PageRow | undefined;
  }

  private findPageById(pageId: string): PageRow | undefined {
    return this.db.prepare("SELECT * FROM knowledge_pages WHERE id = ?").get(pageId) as PageRow | undefined;
  }

  private recordFor(row: PageRow): KnowledgePageRecord {
    return this.toRecords([row])[0]!;
  }

  /** Pages of several projects, ordered defaults first, with staleness computed in one pass per project. */
  private pagesForProjects(projectIds: readonly string[]): KnowledgePageRecord[] {
    if (projectIds.length === 0) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM knowledge_pages WHERE project_id IN (SELECT value FROM json_each(?))
         ORDER BY project_id, created_at ASC, slug ASC`,
      )
      .all(JSON.stringify(projectIds)) as PageRow[];
    const defaultOrder = new Map(KNOWLEDGE_PAGE_DEFAULTS.map((page, index) => [page.slug as string, index]));
    return this.toRecords(rows).sort(
      (left, right) =>
        left.projectId.localeCompare(right.projectId) ||
        (defaultOrder.get(left.slug) ?? defaultOrder.size) - (defaultOrder.get(right.slug) ?? defaultOrder.size),
    );
  }

  /**
   * Counts the Sessions newer than each page. One query per project reads the completion times after the
   * oldest page's cutoff (ascending); each page's count is then a binary search, not a query per page.
   */
  private toRecords(rows: readonly PageRow[]): KnowledgePageRecord[] {
    const cutoffsByProject = new Map<string, string>();
    for (const row of rows) {
      if (!row.sourced_through) continue;
      const current = cutoffsByProject.get(row.project_id);
      if (!current || row.sourced_through < current) {
        cutoffsByProject.set(row.project_id, row.sourced_through);
      }
    }
    const completionsByProject = new Map<string, string[]>();
    const statement = this.db.prepare(
      `SELECT completed_at FROM sessions
       WHERE project_id = ? AND voided_at IS NULL AND completed_at > ?
       ORDER BY completed_at ASC`,
    );
    for (const [projectId, cutoff] of cutoffsByProject) {
      completionsByProject.set(
        projectId,
        (statement.all(projectId, cutoff) as Array<{ completed_at: string }>).map((row) => row.completed_at),
      );
    }
    return rows.map((row) => {
      const completions = completionsByProject.get(row.project_id) ?? [];
      const newSessionCount = row.sourced_through
        ? completions.length - upperBound(completions, row.sourced_through)
        : 0;
      return {
        id: row.id,
        projectId: row.project_id,
        slug: row.slug,
        title: row.title,
        question: row.question,
        sections: parseJson<KnowledgePageSection[]>(row.sections_json, []),
        version: row.version,
        status: row.version === 0 ? "empty" : newSessionCount > 0 ? "needs_update" : "fresh",
        newSessionCount,
        ...(row.last_author ? { lastAuthor: row.last_author } : {}),
        ...(row.sourced_through ? { sourcedThrough: row.sourced_through } : {}),
        ...(row.update_requested_at ? { updateRequestedAt: row.update_requested_at } : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }

  /** Cited Session ids that are missing, voided, or from another project (one query for all sections). */
  private invalidSources(projectId: string, sections: readonly KnowledgePageSection[]): string[] {
    const cited = citedSessionIds(sections);
    if (cited.length === 0) {
      return [];
    }
    const valid = new Set(
      (
        this.db
          .prepare(
            `SELECT id FROM sessions
             WHERE id IN (SELECT value FROM json_each(?)) AND project_id = ? AND voided_at IS NULL`,
          )
          .all(JSON.stringify(cited), projectId) as Array<{ id: string }>
      ).map((row) => row.id),
    );
    return cited.filter((id) => !valid.has(id));
  }

  private writeVersion(
    row: PageRow,
    title: string,
    sections: readonly KnowledgePageSection[],
    author: KnowledgePageAuthor,
    idempotencyKey?: string,
  ): { redactions: ReturnType<typeof combineRedactionSummaries> } {
    const redactedTitle = redactText(title);
    const redactedSections = redactValue(
      sections.map((section) => ({
        heading: section.heading,
        content: section.content,
        sourceSessionIds: [...new Set(section.sourceSessionIds)],
      })),
    );
    const now = nowIso();
    runImmediateTransaction(this.db, () => {
      const current = this.findPageById(row.id)!;
      const version = current.version + 1;
      const sectionsJson = JSON.stringify(redactedSections.value);
      this.db
        .prepare(
          `INSERT INTO knowledge_page_versions
             (id, page_id, project_id, version, title, question, sections_json, author, idempotency_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          row.id,
          row.project_id,
          version,
          redactedTitle.value,
          current.question,
          sectionsJson,
          author,
          idempotencyKey ?? null,
          now,
        );
      this.db
        .prepare(
          `UPDATE knowledge_pages
           SET title = ?, sections_json = ?, version = ?, sourced_through = ?, update_requested_at = NULL,
               last_author = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(redactedTitle.value, sectionsJson, version, now, author, now, row.id);
    });
    return { redactions: combineRedactionSummaries(redactedTitle.redactions, redactedSections.redactions) };
  }

  private contextSessions(projectId: string): { sessions: KnowledgePageContextSession[]; truncated: boolean } {
    const rows = this.db
      .prepare(
        `SELECT id, title, completed_at, summary, work_summary_json FROM sessions
         WHERE project_id = ? AND voided_at IS NULL
         ORDER BY completed_at DESC, id DESC
         LIMIT ?`,
      )
      .all(projectId, CONTEXT_SESSION_LIMIT + 1) as Array<{
      id: string;
      title: string;
      completed_at: string;
      summary: string;
      work_summary_json: string | null;
    }>;
    let truncated = rows.length > CONTEXT_SESSION_LIMIT;
    let budget = CONTEXT_CHAR_BUDGET;
    const sessions: KnowledgePageContextSession[] = [];
    for (const row of rows.slice(0, CONTEXT_SESSION_LIMIT)) {
      const workSummary = parseWorkSummarySections(row.work_summary_json) ?? {
        outcomes: [],
        scope: [],
        decisions: [],
        verification: [],
        nextSteps: [],
      };
      const size = row.title.length + row.summary.length + JSON.stringify(workSummary).length;
      if (size > budget) {
        truncated = true;
        break;
      }
      budget -= size;
      sessions.push({ id: row.id, title: row.title, completedAt: row.completed_at, summary: row.summary, workSummary });
    }
    return { sessions, truncated };
  }
}
