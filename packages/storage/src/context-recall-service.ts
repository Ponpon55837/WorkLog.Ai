import type { DatabaseSync } from "node:sqlite";
import type {
  ContextOmission,
  ContextQueryResult,
  ContextResult,
  DecisionDigest,
  HotspotHint,
  KnowledgeCandidateRequest,
  KnowledgePageDigest,
  KnowledgePageRecord,
  KnowledgePageReviewSection,
  KnowledgeDigest,
  KnowledgeQuery,
  KnowledgeQueryResult,
  KnowledgeRecord,
  KnowledgeSkippedResult,
  MetadataBackfillPreviewResult,
  MetadataBackfillRequestListQueryResult,
  MetadataBackfillRequestQuery,
  PolicyDecision,
  ProjectRecord,
  RecallHit,
  DateRange,
  RecallInput,
  RecallQueryResult,
  RelevantContext,
  RelevantKnowledgePageDigest,
  ReportSynthesisRequestListQueryResult,
  ReportSynthesisRequestQuery,
  SearchQueryResult,
  SearchResult,
  SessionLinkRecord,
  SkippedResult,
  WorkSessionRecord,
} from "@work-intelligence/core";
import { serverClock } from "@work-intelligence/shared";
import {
  DIGEST_ITEM_LENGTH,
  DIGEST_KNOWLEDGE_LENGTH,
  DIGEST_SUMMARY_LENGTH,
  toKnowledgeDigest,
  toSessionDigest,
} from "./digest.js";
import type { SessionListOptions } from "./session-repository.js";
import type { SearchRepository } from "./search-repository.js";
import { limitKnowledgePageReviewSections } from "./knowledge-page-service.js";

const RECENT_DECISION_LIMIT = 12;
const RELEVANT_LIMIT = 5;
const RECALL_DEFAULT_LIMIT = 8;
const RECALL_MAX_LIMIT = 30;
const SEARCH_LIMIT = 20;
const CONTEXT_DEFAULT_BUDGET_CHARS = 19_000;
const CONTEXT_TASK_BUDGET_CHARS = 12_000;
const CONTEXT_PAGE_SECTION_LIMIT = 5;
const CONTEXT_REVIEW_SOURCE_LIMIT = 8;
const CONTEXT_SOURCE_SESSION_LIMIT = 8;
const CONTEXT_PAGE_SECTION_CHARS = 500;
const CONTEXT_EXCERPT_CHARS = 240;
const RECALL_EXCERPT_CHARS = 110;

/** What an Agent is about to work on; ranks relevant records into the context result. */
export type ContextFocus = { task?: string; paths?: string[] };

interface ContextRecallStoreReader {
  checkProjectRoot(projectRoot: string): PolicyDecision;
  listProjects(): ProjectRecord[];
  listSessions(options: SessionListOptions): WorkSessionRecord[];
  getSessionById(sessionId: string): WorkSessionRecord | undefined;
  getProjectById(projectId: string): ProjectRecord | undefined;
  getSessionLinks(sessionId: string): SessionLinkRecord[];
  getKnowledgeWithTrust(knowledgeId: string): KnowledgeRecord | undefined;
  searchKnowledge(options: KnowledgeQuery): KnowledgeQueryResult | KnowledgeSkippedResult;
  listReportSynthesisRequests(options: ReportSynthesisRequestQuery): ReportSynthesisRequestListQueryResult;
  listMetadataBackfillRequests(options: MetadataBackfillRequestQuery): MetadataBackfillRequestListQueryResult;
  previewMetadataBackfill(options: { projectRoot?: string; limit?: number }): MetadataBackfillPreviewResult;
  openKnowledgeCandidateRequests(projectId?: string): KnowledgeCandidateRequest[];
  countPendingAgentDecisions(projectId?: string): number;
  knowledgePageDigests(projectId: string): KnowledgePageDigest[];
  knowledgePagesForContext(projectId?: string): KnowledgePageRecord[];
  pendingKnowledgePages(projectId?: string): ContextResult["pendingRequests"]["knowledgePages"];
  hotspotHints(projectId: string, paths: readonly string[]): HotspotHint[];
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function truncateAtSentenceBoundary(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const prefix = text.slice(0, Math.max(0, limit - 1));
  const sentenceEnds = /(?:[。！？!?]+|\.(?=\s|$)|\n{2,})/gu;
  let boundary = 0;
  for (const match of prefix.matchAll(sentenceEnds)) {
    boundary = (match.index ?? 0) + match[0].length;
  }
  if (boundary > 0) return { text: `${prefix.slice(0, boundary).trimEnd()}…`, truncated: true };
  const wordBoundary = prefix.search(/\s+[^\s]*$/u);
  const safeEnd = wordBoundary > 0 ? wordBoundary : prefix.length;
  return { text: `${prefix.slice(0, safeEnd).trimEnd()}…`, truncated: true };
}

function contextTerms(focus: ContextFocus): string[] {
  const text = [focus.task, ...(focus.paths ?? [])].filter(Boolean).join(" ").toLocaleLowerCase();
  const ignored = new Set(["apps", "packages", "tests", "src", "dist", "test", "spec", "the", "and", "for"]);
  return [...new Set(text.match(/[\p{L}\p{N}_-]+/gu) ?? [])].filter((term) => term.length > 1 && !ignored.has(term));
}

function matchCount(text: string, terms: readonly string[]): number {
  const normalized = text.toLocaleLowerCase();
  return terms.reduce((count, term) => count + (normalized.includes(term) ? 1 : 0), 0);
}

function hasFocus(focus: ContextFocus): boolean {
  return Boolean(focus.task?.trim() || (focus.paths ?? []).some((path) => path.trim()));
}

function addOmission(
  context: ContextResult,
  section: string,
  entry: ContextOmission["entries"][number],
  readWith: string,
): void {
  context.omitted ??= [];
  let omission = context.omitted.find((item) => item.section === section);
  if (!omission) {
    omission = { section, count: 0, entries: [], readWith };
    context.omitted.push(omission);
  }
  omission.count += 1;
  omission.entries.push(entry);
}

export class ContextRecallService {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly searchIndex: SearchRepository,
    private readonly store: ContextRecallStoreReader,
  ) {}

  public getContext(projectRoot?: string, focus: ContextFocus = {}): ContextQueryResult {
    if (projectRoot) {
      const decision = this.store.checkProjectRoot(projectRoot);
      if (!decision.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectRoot: decision.canonicalRoot,
          projectStatus: decision.projectStatus,
          reason: decision.reason ?? "Project recording is not enabled.",
        };
      }

      return this.buildContext(decision.project, focus);
    }

    const projects = this.store.listProjects().filter((project) => project.status === "tracked");
    const relevant = this.getRelevantContext(focus);
    const context: ContextResult = {
      outcome: "context",
      clock: serverClock(),
      projects,
      ...(relevant ? { relevant } : {}),
      pendingRequests: this.getPendingRequests(),
      metadataFollowUps: this.getMetadataFollowUps(),
      recentSessions: this.store
        .listSessions({ limit: 12, trackedOnly: true })
        .map((session) => this.contextSessionDigest(session)),
      recentDecisions: this.getRecentDecisions(),
      recentKnowledge: this.getRecentKnowledge(),
      knowledgePages: [],
    };
    return this.fitContextBudget(this.deduplicateContext(context, focus), focus);
  }

  /**
   * Ranked retrieval across Sessions (including raw handoff sections) and active Knowledge of tracked
   * projects. Returns compact hits; read full records with getSessionDetailForAgent or searchKnowledge.
   */
  public recall(input: RecallInput): RecallQueryResult {
    let project: ProjectRecord | undefined;
    if (input.projectRoot) {
      const decision = this.store.checkProjectRoot(input.projectRoot);
      if (!decision.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectRoot: decision.canonicalRoot,
          projectStatus: decision.projectStatus,
          reason: decision.reason ?? "Project recording is not enabled.",
        };
      }
      project = decision.project;
    }
    const result = this.searchIndex.recall({
      q: input.q,
      paths: input.paths,
      projectId: project?.id,
      from: input.from,
      to: input.to,
      limit: Math.min(Math.max(input.limit ?? RECALL_DEFAULT_LIMIT, 1), RECALL_MAX_LIMIT),
    });
    return {
      outcome: "recall",
      ...(project ? { project } : {}),
      ...result,
      hits: result.hits.map((hit) => this.compactRecallHit(this.withRelatedSessions(hit))),
    };
  }

  private compactRecallHit(hit: RecallHit): RecallHit {
    const bounded = truncateAtSentenceBoundary(hit.excerpt, RECALL_EXCERPT_CHARS);
    return bounded.truncated ? { ...hit, excerpt: bounded.text, truncated: true } : hit;
  }

  private withRelatedSessions(hit: RecallHit): RecallHit {
    if (hit.type === "knowledge") {
      const knowledge = this.store.getKnowledgeWithTrust(hit.id);
      return {
        ...hit,
        ...(knowledge?.possiblyStale ? { possiblyStale: true } : {}),
        ...(knowledge?.review ? { needsReview: true } : {}),
        ...(knowledge?.evidence
          ? { evidence: { confirmed: knowledge.evidence.confirmed, contradicted: knowledge.evidence.contradicted } }
          : {}),
      };
    }
    const related = this.store
      .getSessionLinks(hit.id)
      .filter((link) => !link.voided)
      .map((link) => ({ id: link.sessionId, title: link.title, relation: link.relation }));
    return related.length > 0 ? { ...hit, related } : hit;
  }

  public search(query: string, projectRoot?: string, range: DateRange = {}): SearchResult[] | SkippedResult {
    const result = this.searchForAgent(query, projectRoot, range);
    return result.outcome === "skipped" ? result : result.hits;
  }

  /** Ranked, confidence-bearing search result for Agent tools; REST keeps the existing hit-array shape. */
  public searchForAgent(query: string, projectRoot?: string, range: DateRange = {}): SearchQueryResult | SkippedResult {
    let projectId: string | undefined;
    if (projectRoot) {
      const decision = this.store.checkProjectRoot(projectRoot);
      if (!decision.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectRoot: decision.canonicalRoot,
          projectStatus: decision.projectStatus,
          reason: decision.reason ?? "Project recording is not enabled.",
        };
      }
      projectId = decision.project.id;
    }

    const result = this.searchIndex.recall({
      q: query,
      projectId,
      types: ["session"],
      from: range.from,
      to: range.to,
      limit: SEARCH_LIMIT,
    });
    const hits = result.hits.flatMap((hit) => {
      const record = this.store.getSessionById(hit.id);
      if (!record) {
        return [];
      }
      return [
        {
          session: toSessionDigest(record),
          matchedIn: hit.matchedIn[0] ?? "title",
          ...(hit.section ? { section: hit.section } : {}),
          excerpt: hit.excerpt,
        },
      ];
    });
    return {
      outcome: "search",
      confidence: result.confidence,
      hits,
      ...(result.termHits ? { termHits: result.termHits } : {}),
    };
  }

  private buildContext(project: ProjectRecord, focus: ContextFocus): ContextResult {
    const relevant = this.getRelevantContext(focus, project.id);
    const context: ContextResult = {
      outcome: "context",
      clock: serverClock(),
      project,
      projects: hasFocus(focus) ? [] : [project],
      ...(relevant ? { relevant } : {}),
      pendingRequests: this.getPendingRequests(project.id),
      metadataFollowUps: this.getMetadataFollowUps(project.id),
      recentSessions: this.store
        .listSessions({ projectId: project.id, limit: 12, trackedOnly: true })
        .map((session) => this.contextSessionDigest(session)),
      recentDecisions: this.getRecentDecisions(project.id),
      recentKnowledge: this.getRecentKnowledge(project.id),
      knowledgePages:
        focus.task?.trim() || (focus.paths ?? []).some((path) => path.trim())
          ? []
          : this.store.knowledgePageDigests(project.id),
    };
    return this.fitContextBudget(this.deduplicateContext(context, focus), focus);
  }

  private deduplicateContext(context: ContextResult, focus: ContextFocus): ContextResult {
    if (!hasFocus(focus) || !context.relevant) return context;
    const relevantSessionIds = new Set(context.relevant.sessions.map((session) => session.id));
    const relevantKnowledgeIds = new Set(context.relevant.knowledge.map((knowledge) => knowledge.id));
    const relevantDecisionKeys = new Set(
      context.relevant.decisions.map((decision) => `${decision.sessionId}\u0000${decision.text}`),
    );

    context.recentSessions = context.recentSessions.filter((session) => {
      if (!relevantSessionIds.has(session.id)) return true;
      addOmission(
        context,
        "recentSessions",
        { id: session.id, reason: "已列於 relevant.sessions" },
        "work_get_session",
      );
      return false;
    });
    context.recentKnowledge = context.recentKnowledge.filter((knowledge) => {
      if (!relevantKnowledgeIds.has(knowledge.id)) return true;
      addOmission(
        context,
        "recentKnowledge",
        {
          id: knowledge.id,
          reason: "已列於 relevant.knowledge",
          ...(knowledge.possiblyStale ? { possiblyStale: true } : {}),
          ...(knowledge.needsReview ? { needsReview: true } : {}),
        },
        "work_search_knowledge",
      );
      return false;
    });
    context.recentDecisions = context.recentDecisions.filter((decision) => {
      if (!relevantDecisionKeys.has(`${decision.sessionId}\u0000${decision.text}`)) return true;
      addOmission(
        context,
        "recentDecisions",
        { id: decision.sessionId, reason: "已列於 relevant.decisions" },
        "work_get_session",
      );
      return false;
    });

    const selectedPageIds = new Set((context.relevant.knowledgePages ?? []).map((page) => page.id));
    let remainingReviewSources = CONTEXT_REVIEW_SOURCE_LIMIT;
    for (const page of this.store.knowledgePagesForContext(context.project?.id)) {
      const selected = selectedPageIds.has(page.id);
      const reviewSections =
        page.needsReview && !selected
          ? limitKnowledgePageReviewSections(page.reviewSections ?? [], remainingReviewSources)
          : undefined;
      remainingReviewSources -= reviewSections?.reduce((count, section) => count + section.sources.length, 0) ?? 0;
      addOmission(
        context,
        "knowledgePages",
        {
          id: page.slug,
          reason: selected ? "已列於 relevant.knowledgePages" : "本次不相關",
          ...(page.needsReview
            ? {
                needsReview: true,
                ...(reviewSections ? { reviewSections } : {}),
              }
            : {}),
        },
        "work_get_knowledge_page_context",
      );
    }
    context.knowledgePages = [];
    return context;
  }

  private fitContextBudget(context: ContextResult, focus: ContextFocus): ContextResult {
    const limit = hasFocus(focus) ? CONTEXT_TASK_BUDGET_CHARS : CONTEXT_DEFAULT_BUDGET_CHARS;
    const responseLength = () => JSON.stringify(context, null, 2).length;
    let remainingReviewSources = CONTEXT_REVIEW_SOURCE_LIMIT;
    let remainingSourceIds = CONTEXT_SOURCE_SESSION_LIMIT;
    const sourceIdOrder = [
      ...context.knowledgePages.filter((page) => page.needsReview),
      ...context.knowledgePages.filter((page) => !page.needsReview),
    ];
    const sourceIdsByPage = new Map<KnowledgePageDigest, { ids: string[]; omittedCount: number }>();
    for (const page of sourceIdOrder) {
      const ids = page.sourceSessionIds.slice(0, remainingSourceIds);
      remainingSourceIds -= ids.length;
      sourceIdsByPage.set(page, {
        ids,
        omittedCount: (page.sourceSessionIdsOmittedCount ?? 0) + page.sourceSessionIds.length - ids.length,
      });
    }
    context.knowledgePages = context.knowledgePages.map((page) => {
      const sourceIds = sourceIdsByPage.get(page)!;
      const sourceSessionIds = sourceIds.ids;
      const sourceSessionIdsOmittedCount = sourceIds.omittedCount;
      if (!page.needsReview) {
        return {
          ...page,
          sourceSessionIds,
          ...(sourceSessionIdsOmittedCount > 0 ? { sourceSessionIdsOmittedCount } : {}),
        };
      }
      const reviewSections = limitKnowledgePageReviewSections(page.reviewSections ?? [], remainingReviewSources);
      remainingReviewSources -= reviewSections.reduce((count, section) => count + section.sources.length, 0);
      return {
        ...page,
        sourceSessionIds,
        ...(sourceSessionIdsOmittedCount > 0 ? { sourceSessionIdsOmittedCount } : {}),
        reviewSections,
      };
    });

    const trimNext = (): boolean => {
      const recentSession = context.recentSessions.pop();
      if (recentSession) {
        addOmission(
          context,
          "recentSessions",
          { id: recentSession.id, reason: "預算限制：較低優先近況" },
          "work_get_session",
        );
        return true;
      }
      const recentKnowledge = context.recentKnowledge.pop();
      if (recentKnowledge) {
        addOmission(
          context,
          "recentKnowledge",
          {
            id: recentKnowledge.id,
            reason: "預算限制：較低優先 Knowledge",
            ...(recentKnowledge.possiblyStale ? { possiblyStale: true } : {}),
            ...(recentKnowledge.needsReview ? { needsReview: true } : {}),
          },
          "work_search_knowledge",
        );
        return true;
      }
      const recentDecision = context.recentDecisions.pop();
      if (recentDecision) {
        addOmission(
          context,
          "recentDecisions",
          { id: recentDecision.sessionId, reason: "預算限制：較低優先決策" },
          "work_get_session",
        );
        return true;
      }
      const page = context.knowledgePages.pop();
      if (page) {
        addOmission(
          context,
          "knowledgePages",
          {
            id: page.slug,
            reason: "預算限制：較低優先頁面",
            sourceSessionIds: page.sourceSessionIds,
            ...(page.sourceSessionIdsOmittedCount
              ? { sourceSessionIdsOmittedCount: page.sourceSessionIdsOmittedCount }
              : {}),
            ...(page.needsReview ? { needsReview: true, reviewSections: page.reviewSections } : {}),
          },
          "work_get_knowledge_page_context",
        );
        return true;
      }
      const project = context.projects.length > 1 ? context.projects.pop() : undefined;
      if (project) {
        addOmission(
          context,
          "projects",
          { id: project.id, reason: "預算限制：較低優先專案摘要" },
          "work_get_project_status",
        );
        return true;
      }
      const relevant = context.relevant;
      const pageWithSections = relevant?.knowledgePages?.at(-1);
      const pageSectionCount = relevant?.knowledgePages?.reduce((count, page) => count + page.sections.length, 0) ?? 0;
      const section = pageSectionCount > 1 ? pageWithSections?.sections.pop() : undefined;
      if (pageWithSections && section) {
        addOmission(
          context,
          "relevant.knowledgePages",
          {
            id: pageWithSections.slug,
            reason: `預算限制：較低相關段落（${section.heading}）`,
            sourceSessionIds: section.sourceSessionIds,
            ...(section.sourceSessionIdsOmittedCount
              ? { sourceSessionIdsOmittedCount: section.sourceSessionIdsOmittedCount }
              : {}),
            ...(section.reviewSources || section.reviewOmittedSourceCount
              ? {
                  needsReview: true,
                  reviewSections: [
                    {
                      heading: section.heading,
                      sources: section.reviewSources ?? [],
                      ...(section.reviewOmittedSourceCount
                        ? {
                            omittedSourceCount: section.reviewOmittedSourceCount,
                            reasons: section.reviewReasons,
                          }
                        : {}),
                    },
                  ],
                }
              : {}),
          },
          "work_get_knowledge_page_context",
        );
        if (pageWithSections.sections.length === 0) relevant!.knowledgePages!.pop();
        return true;
      }
      const relevantSession = relevant && relevant.sessions.length > 1 ? relevant.sessions.pop() : undefined;
      if (relevantSession) {
        addOmission(
          context,
          "relevant.sessions",
          { id: relevantSession.id, reason: "預算限制：較低排名 Session" },
          "work_get_session",
        );
        return true;
      }
      const relevantKnowledge = relevant && relevant.knowledge.length > 1 ? relevant.knowledge.pop() : undefined;
      if (relevantKnowledge) {
        addOmission(
          context,
          "relevant.knowledge",
          {
            id: relevantKnowledge.id,
            reason: "預算限制：較低排名 Knowledge",
            ...(relevantKnowledge.possiblyStale ? { possiblyStale: true } : {}),
            ...(relevantKnowledge.needsReview ? { needsReview: true } : {}),
          },
          "work_search_knowledge",
        );
        return true;
      }
      const relevantDecision = relevant && relevant.decisions.length > 1 ? relevant.decisions.pop() : undefined;
      if (relevantDecision) {
        addOmission(
          context,
          "relevant.decisions",
          { id: relevantDecision.sessionId, reason: "預算限制：較低優先決策" },
          "work_get_session",
        );
        return true;
      }
      return false;
    };

    const shortenNext = (): boolean => {
      for (const session of context.recentSessions) {
        if (session.summary.length > CONTEXT_EXCERPT_CHARS) {
          session.summary = truncateAtSentenceBoundary(session.summary, CONTEXT_EXCERPT_CHARS).text;
          session.summaryTruncated = true;
          return true;
        }
      }
      for (const knowledge of context.recentKnowledge) {
        if (knowledge.excerpt.length > CONTEXT_EXCERPT_CHARS) {
          knowledge.excerpt = truncateAtSentenceBoundary(knowledge.excerpt, CONTEXT_EXCERPT_CHARS).text;
          knowledge.excerptTruncated = true;
          return true;
        }
      }
      for (const decision of context.relevant?.decisions ?? []) {
        if (decision.text.length > CONTEXT_EXCERPT_CHARS) {
          decision.text = truncateAtSentenceBoundary(decision.text, CONTEXT_EXCERPT_CHARS).text;
          decision.truncated = true;
          return true;
        }
      }
      for (const hit of [...(context.relevant?.sessions ?? []), ...(context.relevant?.knowledge ?? [])]) {
        if (hit.excerpt.length > CONTEXT_EXCERPT_CHARS) {
          hit.excerpt = truncateAtSentenceBoundary(hit.excerpt, CONTEXT_EXCERPT_CHARS).text;
          hit.truncated = true;
          return true;
        }
      }
      for (const page of context.relevant?.knowledgePages ?? []) {
        for (const pageSection of page.sections) {
          if (pageSection.content.length > CONTEXT_EXCERPT_CHARS) {
            pageSection.content = truncateAtSentenceBoundary(pageSection.content, CONTEXT_EXCERPT_CHARS).text;
            pageSection.truncated = true;
            return true;
          }
        }
      }
      return false;
    };

    let trimmed = false;
    while (responseLength() > limit) {
      if (trimNext()) {
        trimmed = true;
        continue;
      }
      if (shortenNext()) {
        trimmed = true;
        continue;
      }
      break;
    }
    if (responseLength() > limit) {
      addOmission(
        context,
        "budget",
        { id: "critical-metadata", reason: "必要的來源、可信度標記或待處理請求本身超出整份回應預算，因此完整保留" },
        "work_get_context",
      );
    } else if (!trimmed && !context.omitted?.length) {
      delete context.omitted;
    }
    return context;
  }

  /** Records ranked for the task and paths an Agent is about to work on; undefined without a focus. */
  private getRelevantContext(focus: ContextFocus, projectId?: string): RelevantContext | undefined {
    const task = focus.task?.trim();
    const paths = (focus.paths ?? []).map((path) => path.trim()).filter(Boolean);
    if (!task && paths.length === 0) {
      return undefined;
    }
    const recalled = this.searchIndex.recall({ q: task, paths, projectId, limit: 20 });
    const termHits = recalled.termHits;
    const hits = recalled.hits.map((hit) => this.contextHit(this.withRelatedSessions(hit)));
    const knowledge = hits.filter((hit) => hit.type === "knowledge").slice(0, RELEVANT_LIMIT);
    const sessions = hits
      .filter((hit) => hit.type === "session")
      .slice(0, RELEVANT_LIMIT)
      .flatMap((hit) => {
        const record = this.store.getSessionById(hit.id);
        return record ? [{ hit, record }] : [];
      });
    const hotspots = projectId && paths.length > 0 ? this.store.hotspotHints(projectId, paths) : [];
    const decisions = sessions
      .flatMap(({ record }) =>
        (record.workSummary?.decisions ?? [])
          .filter((text) => text.trim().length > 0)
          .map((text) => {
            const bounded = truncateAtSentenceBoundary(text, DIGEST_ITEM_LENGTH);
            return {
              sessionId: record.id,
              sessionTitle: record.title,
              completedAt: record.completedAt,
              text: bounded.text,
              ...(bounded.truncated ? { truncated: true } : {}),
            };
          }),
      )
      .slice(0, RECENT_DECISION_LIMIT);
    return {
      ...(task ? { task } : {}),
      ...(paths.length > 0 ? { paths } : {}),
      confidence: recalled.confidence,
      knowledge,
      decisions,
      sessions: sessions.map(({ hit, record }) => ({ ...hit, openItems: toSessionDigest(record).openItems })),
      knowledgePages: this.getRelevantKnowledgePages(focus, projectId),
      ...(termHits ? { termHits } : {}),
      ...(hotspots.length > 0 ? { hotspots } : {}),
    };
  }

  private contextHit(hit: RecallHit): RecallHit {
    const bounded = truncateAtSentenceBoundary(hit.excerpt, CONTEXT_EXCERPT_CHARS);
    return bounded.truncated ? { ...hit, excerpt: bounded.text, truncated: true } : hit;
  }

  private getRelevantKnowledgePages(focus: ContextFocus, projectId?: string): RelevantKnowledgePageDigest[] {
    const terms = contextTerms(focus);
    if (terms.length === 0) return [];
    const pages = this.store.knowledgePagesForContext(projectId);
    const matches = pages
      .flatMap((page) =>
        page.sections.flatMap((section) => {
          const score = matchCount(`${page.title} ${page.question} ${section.heading} ${section.content}`, terms);
          return score > 0 ? [{ page, section, score }] : [];
        }),
      )
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.page.updatedAt.localeCompare(left.page.updatedAt) ||
          left.page.slug.localeCompare(right.page.slug) ||
          left.section.heading.localeCompare(right.section.heading),
      );
    const uniqueMatches: typeof matches = [];
    const sectionKeys = new Set<string>();
    for (const match of matches) {
      const key = `${match.section.heading}\u0000${match.section.content}\u0000${[...match.section.sourceSessionIds].sort().join("\u0000")}`;
      if (sectionKeys.has(key)) continue;
      sectionKeys.add(key);
      uniqueMatches.push(match);
      if (uniqueMatches.length >= CONTEXT_PAGE_SECTION_LIMIT) break;
    }
    const matchedPageIds = new Set(uniqueMatches.map((match) => match.page.id));
    for (const page of pages) {
      if (!matchedPageIds.has(page.id) || !page.needsReview) continue;
      for (const reviewSection of page.reviewSections ?? []) {
        const section = page.sections.find((item) => item.heading === reviewSection.heading);
        if (!section) continue;
        const key = `${section.heading}\u0000${section.content}\u0000${[...section.sourceSessionIds].sort().join("\u0000")}`;
        if (sectionKeys.has(key)) continue;
        sectionKeys.add(key);
        uniqueMatches.push({ page, section, score: 0 });
      }
    }
    const reviewSectionsByPage = new Map<string, KnowledgePageReviewSection[]>();
    let remainingReviewSources = CONTEXT_REVIEW_SOURCE_LIMIT;
    for (const page of pages) {
      if (!matchedPageIds.has(page.id) || !page.needsReview) continue;
      const reviewSections = limitKnowledgePageReviewSections(page.reviewSections ?? [], remainingReviewSources);
      remainingReviewSources -= reviewSections.reduce((count, section) => count + section.sources.length, 0);
      reviewSectionsByPage.set(page.id, reviewSections);
    }
    const pageDigests = new Map<string, RelevantKnowledgePageDigest>();
    let remainingSourceIds = CONTEXT_SOURCE_SESSION_LIMIT;
    for (const match of uniqueMatches) {
      let digest = pageDigests.get(match.page.id);
      if (!digest) {
        digest = {
          id: match.page.id,
          projectId: match.page.projectId,
          slug: match.page.slug,
          title: match.page.title,
          status: match.page.status,
          newSessionCount: match.page.newSessionCount,
          ...(match.page.needsReview ? { needsReview: true } : {}),
          sections: [],
        };
        pageDigests.set(match.page.id, digest);
      }
      const bounded = truncateAtSentenceBoundary(match.section.content, CONTEXT_PAGE_SECTION_CHARS);
      const reviewSection = reviewSectionsByPage
        .get(match.page.id)
        ?.find((item) => item.heading === match.section.heading);
      const sourceSessionIds = match.section.sourceSessionIds.slice(0, remainingSourceIds);
      remainingSourceIds -= sourceSessionIds.length;
      digest.sections.push({
        heading: match.section.heading,
        content: bounded.text,
        sourceSessionIds,
        ...(match.section.sourceSessionIds.length > sourceSessionIds.length
          ? { sourceSessionIdsOmittedCount: match.section.sourceSessionIds.length - sourceSessionIds.length }
          : {}),
        truncated: bounded.truncated,
        ...(reviewSection
          ? {
              reviewSources: reviewSection.sources,
              ...(reviewSection.omittedSourceCount
                ? { reviewOmittedSourceCount: reviewSection.omittedSourceCount }
                : {}),
              ...(reviewSection.reasons ? { reviewReasons: reviewSection.reasons } : {}),
            }
          : {}),
      });
    }
    return [...pageDigests.values()];
  }

  /** Pending/processing requests an Agent could pick up; a project scope also includes its "all projects" requests. */
  private getPendingRequests(projectId?: string): ContextResult["pendingRequests"] {
    const active = new Set(["pending", "processing"]);
    const inScope = (request: { projectId?: string }) =>
      !projectId || !request.projectId || request.projectId === projectId;
    const byNewest = (left: { requestedAt: string }, right: { requestedAt: string }) =>
      right.requestedAt.localeCompare(left.requestedAt);
    const reports = this.store.listReportSynthesisRequests({ limit: 100 });
    const backfills = this.store.listMetadataBackfillRequests({ limit: 100 });
    return {
      reportSynthesis:
        reports.outcome === "report_synthesis_requests"
          ? reports.requests
              .filter((request) => active.has(request.status) && inScope(request))
              .sort(byNewest)
              .slice(0, 5)
          : [],
      metadataBackfill:
        backfills.outcome === "metadata_backfill_requests"
          ? backfills.requests
              .filter((request) => active.has(request.status) && inScope(request))
              .sort(byNewest)
              .slice(0, 5)
          : [],
      knowledgeCandidates: this.store.openKnowledgeCandidateRequests(projectId),
      agentDecisions: this.store.countPendingAgentDecisions(projectId),
      knowledgePages: this.store.pendingKnowledgePages(projectId),
    };
  }

  private getMetadataFollowUps(projectId?: string): ContextResult["metadataFollowUps"] {
    const projectRoot = projectId ? this.store.getProjectById(projectId)?.rootPath : undefined;
    const preview = this.store.previewMetadataBackfill({ projectRoot, limit: 1 });
    return preview.outcome === "backfill_preview"
      ? preview.totals
      : { needsBackfill: 0, changedFilesMissing: 0, verificationMissing: 0, verificationNotRun: 0 };
  }

  private getRecentKnowledge(projectId?: string): KnowledgeDigest[] {
    const result = this.store.searchKnowledge({ projectId, status: "active", limit: 12 });
    return result.outcome === "knowledge"
      ? result.items.map((knowledge) => this.contextKnowledgeDigest(knowledge))
      : [];
  }

  private contextSessionDigest(session: WorkSessionRecord): ReturnType<typeof toSessionDigest> {
    const digest = toSessionDigest(session);
    const bounded = truncateAtSentenceBoundary(session.summary, DIGEST_SUMMARY_LENGTH);
    return {
      ...digest,
      summary: bounded.text,
      ...(bounded.truncated ? { summaryTruncated: true } : {}),
    };
  }

  private contextKnowledgeDigest(knowledge: KnowledgeRecord): KnowledgeDigest {
    const digest = toKnowledgeDigest(knowledge);
    const bounded = truncateAtSentenceBoundary(knowledge.body, DIGEST_KNOWLEDGE_LENGTH);
    return {
      ...digest,
      excerpt: bounded.text,
      ...(bounded.truncated ? { excerptTruncated: true } : {}),
    };
  }

  /*
   * Decisions come from workSummary.decisions, the confirmed technical decisions an Agent wrote at
   * finalize. note/closing events are not used: they mostly record process state (commits,
   * worktree status), not decisions.
   */
  private getRecentDecisions(projectId?: string): DecisionDigest[] {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.title, s.completed_at, json_extract(s.work_summary_json, '$.decisions') AS decisions_json
         FROM sessions s
         JOIN projects p ON p.id = s.project_id
         WHERE p.status = 'tracked'
           AND s.voided_at IS NULL
           ${projectId ? "AND p.id = ?" : ""}
           AND json_valid(s.work_summary_json)
           AND json_type(s.work_summary_json, '$.decisions') = 'array'
           AND json_array_length(s.work_summary_json, '$.decisions') > 0
         ORDER BY s.completed_at DESC, s.id DESC
         LIMIT ${RECENT_DECISION_LIMIT}`,
      )
      .all(...(projectId ? [projectId] : [])) as Array<{
      id: string;
      title: string;
      completed_at: string;
      decisions_json: string;
    }>;
    return rows
      .flatMap((row) =>
        parseJson<unknown[]>(row.decisions_json, [])
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          .map((text) => {
            const bounded = truncateAtSentenceBoundary(text, DIGEST_ITEM_LENGTH);
            return {
              sessionId: row.id,
              sessionTitle: row.title,
              completedAt: row.completed_at,
              text: bounded.text,
              ...(bounded.truncated ? { truncated: true } : {}),
            };
          }),
      )
      .slice(0, RECENT_DECISION_LIMIT);
  }
}
