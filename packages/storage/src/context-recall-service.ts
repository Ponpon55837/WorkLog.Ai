import type { DatabaseSync } from "node:sqlite";
import type {
  ContextOmission,
  ContextOutstandingItem,
  ContextQueryResult,
  ContextResult,
  ContextSupplementIndicator,
  ContextSupplementReason,
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
  OutstandingCleanupRequestListResult,
  OutstandingCleanupRequestQuery,
  OutstandingItem,
  OutstandingItemListQueryResult,
  PolicyDecision,
  ProjectRecord,
  ProjectScopedItem,
  RecallHit,
  DateRange,
  RecallInput,
  RecallQueryResult,
  RelevantContext,
  RelatedOutstandingItems,
  ContextRelatedOutstandingItems,
  RelevantDecisionDigest,
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
import type { OutstandingItemFocus } from "./outstanding-item-service.js";
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
/** Only the three highest-ranked Session hits can seed one-hop context supplements. */
const CONTEXT_SUPPLEMENT_SOURCE_LIMIT = 3;
/** Keep one source from filling the optional indicator list with its own related records. */
const CONTEXT_SUPPLEMENT_ITEMS_PER_SOURCE = 2;
/** Bound response overhead while allowing more than one retained source to contribute. */
const CONTEXT_SUPPLEMENT_LIMIT = 4;
const RECALL_DEFAULT_LIMIT = 8;
const RECALL_MAX_LIMIT = 30;
const SEARCH_LIMIT = 20;
const CONTEXT_DEFAULT_BUDGET_CHARS = 15_800;
const CONTEXT_TASK_BUDGET_CHARS = 9_800;
/** Budget-omitted ids listed per context section; the rest are counted in `moreIds`. */
const CONTEXT_OMITTED_ID_LIMIT = 3;
/** Path-matched Knowledge left out of relevant.knowledge that keep a title and one path in the omission pointer. */
const CONTEXT_OMITTED_PATH_ENTRY_LIMIT = 5;
const CONTEXT_PATH_ENTRY_TITLE_CHARS = 60;
/** Last-resort title length once the response is still over budget after every other trim. */
const CONTEXT_PATH_ENTRY_SHORT_TITLE_CHARS = 24;
const CONTEXT_PATH_ENTRY_PATH_CHARS = 100;
/** Path-matched Knowledge is found again by path (appliesTo) or by words from its title. */
const PATH_KNOWLEDGE_READ_WITH = "work_get_file_history/work_search_knowledge";
const DEFAULT_KNOWLEDGE_READ_WITH = "work_search_knowledge";
const RANKED_BEYOND_REASON = "超出相關 Knowledge 上限";
/** Reason prefix for an item left out because the same record is already shown in another section. */
const DUPLICATE_REASON_PREFIX = "已列於";
/**
 * Without a task or paths, the newest Sessions are what an Agent starting work needs most, so this many outlast
 * older Knowledge, decisions, and page content when the budget is tight.
 */
const CONTEXT_RECENT_SESSION_FLOOR = 3;
const CONTEXT_PAGE_SECTION_LIMIT = 5;
const CONTEXT_REVIEW_SOURCE_LIMIT = 8;
const CONTEXT_SOURCE_SESSION_LIMIT = 8;
const CONTEXT_OUTSTANDING_ITEM_TEXT_LENGTH = 500;
const CONTEXT_PAGE_SECTION_CHARS = 500;
const CONTEXT_EXCERPT_CHARS = 240;
const RELATED_OUTSTANDING_HINT =
  "仍未處理：逐項讀來源核對；本次工作已直接驗證完成的，於 finalize 的 resolvedOutstandingItemIds 或 finalize 後以一次 work_resolve_outstanding_items 批次結案（本 Session 為依據）；被本次 nextSteps 取代才標記不再需要；無法確認就保留。";
const RECALL_EXCERPT_CHARS = 110;
const CONTINUED_OUTSTANDING_ITEM_LIMIT = 10;

/** What an Agent is about to work on; ranks relevant records into the context result. */
export type ContextFocus = { task?: string; paths?: string[]; linkedSessionIds?: string[] };

type MetadataBackfillTotals = Extract<MetadataBackfillPreviewResult, { outcome: "backfill_preview" }>["totals"];

/** One item a context section leaves out, before it is folded into the section's compact omission pointer. */
interface OmittedItem {
  id: string;
  reason: string;
  possiblyStale?: boolean;
  needsReview?: boolean;
  /** Path-matched Knowledge: keeps a title and one path in the pointer while the entry cap allows. */
  pathKnowledge?: Pick<PathKnowledge, "title" | "path" | "rank">;
}

/** Knowledge that matched a focus path, in recall rank order among Knowledge hits (0 is the best). */
interface PathKnowledge {
  id: string;
  title: string;
  path: string;
  rank: number;
  possiblyStale?: boolean;
  needsReview?: boolean;
}

interface ContextRecallStoreReader {
  checkProjectRoot(projectRoot: string): PolicyDecision;
  listProjects(): ProjectRecord[];
  listSessions(options: SessionListOptions): WorkSessionRecord[];
  getSessionById(sessionId: string): WorkSessionRecord | undefined;
  getProjectById(projectId: string): ProjectRecord | undefined;
  getSessionLinks(sessionId: string): SessionLinkRecord[];
  appliedKnowledgeIdsBySessions(sessionIds: readonly string[]): Map<string, string[]>;
  getKnowledgeWithTrustMany(knowledgeIds: string[]): Map<string, KnowledgeRecord>;
  searchKnowledge(options: KnowledgeQuery): KnowledgeQueryResult | KnowledgeSkippedResult;
  listReportSynthesisRequests(options: ReportSynthesisRequestQuery): ReportSynthesisRequestListQueryResult;
  listMetadataBackfillRequests(options: MetadataBackfillRequestQuery): MetadataBackfillRequestListQueryResult;
  listOutstandingCleanupRequests(options: OutstandingCleanupRequestQuery): OutstandingCleanupRequestListResult;
  previewMetadataBackfill(options: { projectRoot?: string; limit?: number }): MetadataBackfillPreviewResult;
  countMetadataBackfillFollowUps(options: { projectRoot?: string }): MetadataBackfillTotals | undefined;
  openKnowledgeCandidateRequests(projectId?: string): KnowledgeCandidateRequest[];
  knowledgeCandidateBacklog(projectId: string): { uncoveredSessions: number; highValueSessions: number } | undefined;
  countPendingAgentDecisions(projectId?: string): number;
  knowledgePageDigests(projectId: string): KnowledgePageDigest[];
  knowledgePagesForContext(projectId?: string): KnowledgePageRecord[];
  pendingKnowledgePages(projectId?: string): ContextResult["pendingRequests"]["knowledgePages"];
  listOutstandingItems(input: {
    projectId?: string;
    status: "pending";
    page: number;
    pageSize: number;
  }): OutstandingItemListQueryResult;
  pendingOutstandingItemsForSessions(sessionIds: readonly string[]): OutstandingItem[];
  hasPendingOutstandingItems(projectId: string, excludeSourceSessionId?: string): boolean;
  relatedPendingOutstandingItems(input: OutstandingItemFocus): {
    items: OutstandingItem[];
    total: number;
    truncated?: true;
  };
  hotspotHints(projectId: string, paths: readonly string[]): HotspotHint[];
  /** Runs one composite read whose parts share the page records they need (see KnowledgePageService). */
  withSharedReads<T>(read: () => T): T;
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

/** Drops the project fields that a project-scoped context names once in `project`. */
function withoutProjectFields<T extends { projectId: string; projectName?: string }>(item: T): ProjectScopedItem<T> {
  const { projectId: _projectId, projectName: _projectName, ...rest } = item;
  return rest;
}

/**
 * Every id a context left out, including those past the few listed in its pointers, so supplements never point back
 * to an omitted record. Kept beside the response because it is not part of it.
 */
const omittedIdsByContext = new WeakMap<ContextResult, Set<string>>();

/** Every path-matched Knowledge a focus recalled, kept beside the relevant block because it is not part of it. */
const pathKnowledgeByRelevant = new WeakMap<RelevantContext, PathKnowledge[]>();
/** The same records by id once a context is assembled, so budget trimming can turn a dropped record into a path entry. */
const pathKnowledgeByContext = new WeakMap<ContextResult, Map<string, PathKnowledge>>();
/** Recall rank of each path entry in an omission, so a better-ranked record can replace the worst one at the cap. */
const pathEntryRanks = new WeakMap<ContextOmission, Map<string, number>>();

/** Ids an omission lists only because they ranked beyond the relevant slots; they were never shown in full. */
const beyondLimitIds = new WeakMap<ContextOmission, Set<string>>();

function boundedPath(path: string): string {
  return path.length > CONTEXT_PATH_ENTRY_PATH_CHARS ? `…${path.slice(-(CONTEXT_PATH_ENTRY_PATH_CHARS - 1))}` : path;
}

function pathKnowledgeItem(context: ContextResult, id: string): Pick<OmittedItem, "pathKnowledge"> {
  const known = pathKnowledgeByContext.get(context)?.get(id);
  return known ? { pathKnowledge: { title: known.title, path: known.path, rank: known.rank } } : {};
}

function pathEntries(omission: ContextOmission): NonNullable<ContextOmission["entries"]> {
  return (omission.entries ?? []).filter((entry) => entry.path !== undefined);
}

/** Turns a path entry back into what the omission would hold without it: a flagged entry, or a plain id. */
function demotePathEntry(omission: ContextOmission, id: string): void {
  const entry = omission.entries?.find((candidate) => candidate.id === id);
  if (!entry) return;
  delete entry.title;
  delete entry.path;
  pathEntryRanks.get(omission)?.delete(id);
  if (!entry.possiblyStale && !entry.needsReview) {
    omission.entries = omission.entries!.filter((candidate) => candidate !== entry);
    if (omission.entries.length === 0) delete omission.entries;
    const ids = (omission.ids ??= []);
    if (ids.length < CONTEXT_OMITTED_ID_LIMIT) ids.push(id);
    else omission.moreIds = (omission.moreIds ?? 0) + 1;
  }
  if (pathEntries(omission).length === 0) omission.readWith = DEFAULT_KNOWLEDGE_READ_WITH;
}

/**
 * Lists a path-matched Knowledge with its title and one path, ahead of plain ids. At the cap the worst-ranked path
 * entry makes room for a better-ranked one; returns false when the item must fall back to the ordinary pointer.
 */
function addPathEntry(omission: ContextOmission, item: OmittedItem): boolean {
  const { title, path, rank } = item.pathKnowledge!;
  const ranks = pathEntryRanks.get(omission) ?? new Map<string, number>();
  pathEntryRanks.set(omission, ranks);
  const rankOf = (id: string) => ranks.get(id) ?? Number.POSITIVE_INFINITY;
  const existing = omission.entries?.find((entry) => entry.id === item.id);
  if (existing?.path === undefined) {
    const withPath = pathEntries(omission);
    if (withPath.length >= CONTEXT_OMITTED_PATH_ENTRY_LIMIT) {
      const worst = withPath.reduce((left, right) => (rankOf(right.id) > rankOf(left.id) ? right : left));
      if (rankOf(worst.id) <= rank) return false;
      demotePathEntry(omission, worst.id);
    }
  }
  const entries = (omission.entries ??= []);
  let entry = entries.find((candidate) => candidate.id === item.id);
  if (!entry) {
    entry = { id: item.id };
    entries.push(entry);
  }
  entry.title = title;
  entry.path = path;
  if (item.possiblyStale) entry.possiblyStale = true;
  if (item.needsReview) entry.needsReview = true;
  ranks.set(item.id, rank);
  entries.sort((left, right) => {
    const leftRank = rankOf(left.id);
    const rightRank = rankOf(right.id);
    return leftRank === rightRank ? 0 : leftRank < rightRank ? -1 : 1;
  });
  omission.ids = omission.ids?.filter((id) => id !== item.id);
  if (omission.ids?.length === 0) delete omission.ids;
  omission.readWith = PATH_KNOWLEDGE_READ_WITH;
  return true;
}

/**
 * Folds one left-out item into its section's compact pointer: duplicates are counted only, budget omissions keep a
 * few ids, and items flagged possiblyStale or needsReview keep their id and flags. Review details and cited Session
 * ids are left to `readWith`, so omission bookkeeping never crowds out content.
 */
function addOmission(context: ContextResult, section: string, item: OmittedItem, readWith: string): void {
  context.omitted ??= [];
  let omission = context.omitted.find((candidate) => candidate.section === section);
  if (!omission) {
    omission = { section, count: 0, readWith };
    context.omitted.push(omission);
  }
  omission.count += 1;
  if (item.reason === RANKED_BEYOND_REASON) {
    const beyond = beyondLimitIds.get(omission) ?? new Set<string>();
    beyondLimitIds.set(omission, beyond);
    beyond.add(item.id);
  }
  let omittedIds = omittedIdsByContext.get(context);
  if (!omittedIds) {
    omittedIds = new Set();
    omittedIdsByContext.set(context, omittedIds);
  }
  omittedIds.add(item.id);
  // A duplicate is shown elsewhere in this response together with its flags.
  if (item.reason.startsWith(DUPLICATE_REASON_PREFIX)) {
    omission.duplicates = (omission.duplicates ?? 0) + 1;
    return;
  }
  const reasons = (omission.reasons ??= []);
  if (!reasons.includes(item.reason)) reasons.push(item.reason);
  if (item.pathKnowledge && addPathEntry(omission, item)) return;
  if (item.possiblyStale || item.needsReview) {
    const entries = (omission.entries ??= []);
    let entry = entries.find((candidate) => candidate.id === item.id);
    if (!entry) {
      entry = { id: item.id };
      entries.push(entry);
    }
    if (item.possiblyStale) entry.possiblyStale = true;
    if (item.needsReview) entry.needsReview = true;
    omission.ids = omission.ids?.filter((id) => id !== item.id);
    if (omission.ids?.length === 0) delete omission.ids;
    return;
  }
  if (omission.entries?.some((entry) => entry.id === item.id)) return;
  const ids = (omission.ids ??= []);
  if (ids.includes(item.id)) return;
  if (ids.length < CONTEXT_OMITTED_ID_LIMIT) ids.push(item.id);
  else omission.moreIds = (omission.moreIds ?? 0) + 1;
}

function contextSupplementOmission(supplements: ContextSupplementIndicator[], includeIds = true): ContextOmission {
  const ids = includeIds ? supplements.map(({ id }) => id).slice(0, CONTEXT_OMITTED_ID_LIMIT) : [];
  return {
    section: "relevant.supplements",
    count: supplements.length,
    ...(ids.length > 0 ? { ids } : {}),
    ...(includeIds && supplements.length > ids.length ? { moreIds: supplements.length - ids.length } : {}),
    reasons: ["預算"],
    readWith: "work_get_session/work_search_knowledge",
  };
}

export class ContextRecallService {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly searchIndex: SearchRepository,
    private readonly store: ContextRecallStoreReader,
  ) {}

  public getContext(projectRoot?: string, focus: ContextFocus = {}): ContextQueryResult {
    // Page digests, page omissions and pending page requests all read the same projects' page records.
    return this.store.withSharedReads(() => this.readContext(projectRoot, focus));
  }

  private readContext(projectRoot: string | undefined, focus: ContextFocus): ContextQueryResult {
    if (projectRoot) {
      const decision = this.store.checkProjectRoot(projectRoot);
      if (!decision.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectRoot: decision.canonicalRoot,
          projectStatus: decision.projectStatus,
          tracked: false,
          reason: decision.reason ?? "Project recording is not enabled.",
        };
      }

      return this.buildContext(decision.project, focus);
    }

    const projects = this.store.listProjects().filter((project) => project.status === "tracked");
    const relevant = this.getRelevantContext(focus);
    const recentSessions = this.store.listSessions({ limit: 12, trackedOnly: true });
    const pendingBySession = this.groupOutstandingItems(
      this.store.pendingOutstandingItemsForSessions(recentSessions.map((session) => session.id)),
    );
    const outstandingResult = this.store.listOutstandingItems({
      status: "pending",
      page: 1,
      pageSize: 5,
    });
    const pendingOutstandingItems = outstandingResult.outcome === "outstanding_items" ? outstandingResult.items : [];
    const pendingOutstandingItemsTotal =
      outstandingResult.outcome === "outstanding_items" ? outstandingResult.pageInfo.total : 0;
    const context: ContextResult = {
      outcome: "context",
      clock: serverClock(),
      projects,
      pendingOutstandingItems: pendingOutstandingItems.map((item) => this.boundOutstandingItem(item)),
      pendingOutstandingItemsTotal,
      pendingOutstandingItemsOmitted: Math.max(0, pendingOutstandingItemsTotal - pendingOutstandingItems.length),
      pendingOutstandingItemsTruncated: pendingOutstandingItems.filter(
        (item) => item.text.length > CONTEXT_OUTSTANDING_ITEM_TEXT_LENGTH,
      ).length,
      ...(relevant ? { relevant } : {}),
      pendingRequests: this.getPendingRequests(),
      metadataFollowUps: this.getMetadataFollowUps(),
      recentSessions: recentSessions.map((session) =>
        this.contextSessionDigest(session, pendingBySession.get(session.id) ?? []),
      ),
      recentDecisions: this.getRecentDecisions(),
      recentKnowledge: this.getRecentKnowledge(),
      knowledgePages: [],
    };
    this.annotateOutstandingItemOmission(context);
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
      hits: this.withRelatedSessions(result.hits).map((hit) => this.compactRecallHit(hit)),
    };
  }

  /** Closing skips the related query when no older pending items remain. */
  public relatedOutstandingItems(
    projectId: string,
    focus: ContextFocus,
    excludeSourceSessionId?: string,
    excludeItemIds?: readonly string[],
  ): RelatedOutstandingItems {
    if (!this.store.hasPendingOutstandingItems(projectId, excludeSourceSessionId))
      return { items: [], total: 0, omitted: 0 };
    // Closing needs pending pointers, not full Session/Knowledge recall across the project history.
    // Source title/summary relevance and changed paths are scored in the same bounded item query.
    return this.outstandingItemDigest(
      this.store.relatedPendingOutstandingItems({
        projectId,
        ...focus,
        excludeSourceSessionId,
        ...(excludeItemIds?.length ? { excludeItemIds } : {}),
      }),
    );
  }

  /**
   * Pending items of the Sessions a finalize linked, at most CONTINUED_OUTSTANDING_ITEM_LIMIT, with an omitted count.
   * Links may cross projects, but only same-project items can be closed by this Session, so only those are listed.
   */
  public continuedOutstandingItems(
    projectId: string,
    linkedSessionIds: readonly string[],
  ): {
    digest: RelatedOutstandingItems;
    allIds: string[];
  } {
    const pending = this.store
      .pendingOutstandingItemsForSessions(linkedSessionIds)
      .filter((item) => item.projectId === projectId);
    return {
      digest: this.outstandingItemDigest({
        items: pending.slice(0, CONTINUED_OUTSTANDING_ITEM_LIMIT),
        total: pending.length,
      }),
      allIds: pending.map((item) => item.id),
    };
  }

  private compactRecallHit(hit: RecallHit): RecallHit {
    const bounded = truncateAtSentenceBoundary(hit.excerpt, RECALL_EXCERPT_CHARS);
    return bounded.truncated ? { ...hit, excerpt: bounded.text, truncated: true } : hit;
  }

  /** Trust for every Knowledge hit is read in one batch; per-hit lookups rescanned later Sessions once per hit. */
  private withRelatedSessions(
    hits: RecallHit[],
    trusted = this.store.getKnowledgeWithTrustMany(hits.filter((hit) => hit.type === "knowledge").map((hit) => hit.id)),
  ): RecallHit[] {
    return hits.map((hit) => this.withRelatedSessionsFor(hit, trusted));
  }

  private withRelatedSessionsFor(hit: RecallHit, trusted: Map<string, KnowledgeRecord>): RecallHit {
    if (hit.type === "knowledge") {
      const knowledge = trusted.get(hit.id);
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
    const sessions = result.hits.flatMap((hit) => {
      const record = this.store.getSessionById(hit.id);
      if (!record) {
        return [];
      }
      return [{ hit, record }];
    });
    const pendingBySession = this.groupOutstandingItems(
      this.store.pendingOutstandingItemsForSessions(sessions.map(({ record }) => record.id)),
    );
    const hits = sessions.map(({ hit, record }) => ({
      session: toSessionDigest(record, this.openItemsForSession(record, pendingBySession.get(record.id) ?? [])),
      matchedIn: hit.matchedIn[0] ?? "title",
      ...(hit.section ? { section: hit.section } : {}),
      excerpt: hit.excerpt,
    }));
    return {
      outcome: "search",
      confidence: result.confidence,
      hits,
      ...(result.termHits ? { termHits: result.termHits } : {}),
    };
  }

  private buildContext(project: ProjectRecord, focus: ContextFocus): ContextResult {
    const relevant = this.getRelevantContext(focus, project.id);
    const recentSessions = this.store.listSessions({ projectId: project.id, limit: 12, trackedOnly: true });
    const pendingBySession = this.groupOutstandingItems(
      this.store.pendingOutstandingItemsForSessions(recentSessions.map((session) => session.id)),
    );
    const outstandingResult = this.store.listOutstandingItems({
      projectId: project.id,
      status: "pending",
      page: 1,
      pageSize: 5,
    });
    const pendingOutstandingItems = outstandingResult.outcome === "outstanding_items" ? outstandingResult.items : [];
    const pendingOutstandingItemsTotal =
      outstandingResult.outcome === "outstanding_items" ? outstandingResult.pageInfo.total : 0;
    // The policy decision that admitted this call doubles as the tracking check, so no status call is needed.
    const context: ContextResult = {
      outcome: "context",
      projectStatus: "tracked",
      tracked: true,
      clock: serverClock(),
      project,
      projects: [],
      pendingOutstandingItems: pendingOutstandingItems.map((item) =>
        withoutProjectFields(this.boundOutstandingItem(item)),
      ),
      pendingOutstandingItemsTotal,
      pendingOutstandingItemsOmitted: Math.max(0, pendingOutstandingItemsTotal - pendingOutstandingItems.length),
      pendingOutstandingItemsTruncated: pendingOutstandingItems.filter(
        (item) => item.text.length > CONTEXT_OUTSTANDING_ITEM_TEXT_LENGTH,
      ).length,
      ...(relevant ? { relevant } : {}),
      pendingRequests: this.getPendingRequests(project.id),
      metadataFollowUps: this.getMetadataFollowUps(project.id),
      recentSessions: recentSessions.map((session) =>
        withoutProjectFields(this.contextSessionDigest(session, pendingBySession.get(session.id) ?? [])),
      ),
      recentDecisions: this.getRecentDecisions(project.id),
      recentKnowledge: this.getRecentKnowledge(project.id),
      knowledgePages:
        focus.task?.trim() || (focus.paths ?? []).some((path) => path.trim())
          ? []
          : this.store.knowledgePageDigests(project.id),
    };
    this.annotateOutstandingItemOmission(context);
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
    const pathKnowledge = pathKnowledgeByRelevant.get(context.relevant) ?? [];
    if (pathKnowledge.length > 0) {
      pathKnowledgeByContext.set(context, new Map(pathKnowledge.map((item) => [item.id, item])));
      // A record still shown in full (relevant or recent) needs no pointer; it becomes one only if the budget drops it.
      const shownIds = new Set([...relevantKnowledgeIds, ...context.recentKnowledge.map((knowledge) => knowledge.id)]);
      for (const item of pathKnowledge) {
        if (shownIds.has(item.id)) continue;
        addOmission(
          context,
          "relevant.knowledge",
          {
            id: item.id,
            reason: RANKED_BEYOND_REASON,
            ...(item.possiblyStale ? { possiblyStale: true } : {}),
            ...(item.needsReview ? { needsReview: true } : {}),
            pathKnowledge: { title: item.title, path: item.path, rank: item.rank },
          },
          DEFAULT_KNOWLEDGE_READ_WITH,
        );
      }
    }
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
    for (const page of this.store.knowledgePagesForContext(context.project?.id)) {
      addOmission(
        context,
        "knowledgePages",
        {
          id: page.slug,
          reason: selectedPageIds.has(page.id) ? "已列於 relevant.knowledgePages" : "本次不相關",
          ...(page.needsReview ? { needsReview: true } : {}),
        },
        "work_get_knowledge_page_context",
      );
    }
    context.knowledgePages = [];
    return context;
  }

  private fitContextBudget(context: ContextResult, focus: ContextFocus): ContextResult {
    const limit = hasFocus(focus) ? CONTEXT_TASK_BUDGET_CHARS : CONTEXT_DEFAULT_BUDGET_CHARS;
    // Measured as the MCP text block the Agent receives (compact JSON).
    const responseLength = () => JSON.stringify(context).length;
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

    const recentSessionFloor = hasFocus(focus) ? 0 : CONTEXT_RECENT_SESSION_FLOOR;
    const trimRecentSession = (floor: number): boolean => {
      if (context.recentSessions.length <= floor) return false;
      const recentSession = context.recentSessions.pop()!;
      addOmission(
        context,
        "recentSessions",
        { id: recentSession.id, reason: "預算限制：較低優先近況" },
        "work_get_session",
      );
      return true;
    };

    const trimNext = (): boolean => {
      if (trimRecentSession(recentSessionFloor)) return true;
      const recentKnowledge = context.recentKnowledge.pop();
      if (recentKnowledge) {
        // A path-matched record is counted once, in the pointer that tells which file it covers.
        const pathKnowledge = pathKnowledgeItem(context, recentKnowledge.id);
        addOmission(
          context,
          pathKnowledge.pathKnowledge ? "relevant.knowledge" : "recentKnowledge",
          {
            id: recentKnowledge.id,
            reason: "預算限制：較低優先 Knowledge",
            ...(recentKnowledge.possiblyStale ? { possiblyStale: true } : {}),
            ...(recentKnowledge.needsReview ? { needsReview: true } : {}),
            ...pathKnowledge,
          },
          DEFAULT_KNOWLEDGE_READ_WITH,
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
          { id: page.slug, reason: "預算限制：較低優先頁面", ...(page.needsReview ? { needsReview: true } : {}) },
          "work_get_knowledge_page_context",
        );
        return true;
      }
      if (trimRecentSession(0)) return true;
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
      const outstandingItem = context.pendingOutstandingItems.pop();
      if (outstandingItem) {
        if (outstandingItem.textTruncated) {
          context.pendingOutstandingItemsTruncated = Math.max(0, context.pendingOutstandingItemsTruncated - 1);
        }
        context.pendingOutstandingItemsOmitted += 1;
        addOmission(
          context,
          "pendingOutstandingItems",
          { id: outstandingItem.id, reason: "預算限制：較舊的待結項" },
          "work_list_outstanding_items",
        );
        this.annotateOutstandingItemOmission(context);
        return true;
      }
      return false;
    };

    // Relevant items are dropped only after recent activity is gone and long excerpts are shortened. Each step pops one
    // kind of item; Knowledge has its own step because path pointers change where it ranks (see the loop below).
    const trimRelevantPageSection = (): boolean => {
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
            reason: "預算限制：較低相關段落",
            ...(section.reviewSources || section.reviewOmittedSourceCount ? { needsReview: true } : {}),
          },
          "work_get_knowledge_page_context",
        );
        if (pageWithSections.sections.length === 0) relevant!.knowledgePages!.pop();
        return true;
      }
      return false;
    };
    const trimRelevantSession = (): boolean => {
      const relevant = context.relevant;
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
      return false;
    };
    const trimRelevantKnowledge = (): boolean => {
      const relevant = context.relevant;
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
            ...pathKnowledgeItem(context, relevantKnowledge.id),
          },
          DEFAULT_KNOWLEDGE_READ_WITH,
        );
        return true;
      }
      return false;
    };
    const trimRelevantDecision = (): boolean => {
      const relevant = context.relevant;
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
    const trimRelevantOutstanding = (): boolean => {
      const outstanding = context.relevant?.outstandingItems;
      const item = outstanding && outstanding.items.length > 1 ? outstanding.items.pop() : undefined;
      if (outstanding && item) {
        outstanding.omitted += 1;
        addOmission(
          context,
          "relevant.outstandingItems",
          { id: item.id, reason: "預算限制：較低相關未結項" },
          "work_list_outstanding_items",
        );
        return true;
      }
      const continued = relevant?.continuedOutstandingItems;
      const continuedItem = continued && continued.items.length > 1 ? continued.items.pop() : undefined;
      if (continued && continuedItem) {
        continued.omitted += 1;
        addOmission(
          context,
          "relevant.continuedOutstandingItems",
          { id: continuedItem.id, reason: "預算限制：較後面的延續未結項" },
          "work_list_outstanding_items",
        );
        return true;
      }
      return false;
    };
    const trimRelevant = (): boolean =>
      trimRelevantPageSection() ||
      trimRelevantSession() ||
      trimRelevantKnowledge() ||
      trimRelevantDecision() ||
      trimRelevantOutstanding();
    // With path pointers in play, full relevant Knowledge outranks everything else relevant, so the other relevant
    // sections go first.
    const trimRelevantBesidesKnowledge = (): boolean =>
      trimRelevantPageSection() || trimRelevantSession() || trimRelevantDecision() || trimRelevantOutstanding();

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
      for (const item of context.relevant?.outstandingItems?.items ?? []) {
        if (item.text.length > CONTEXT_EXCERPT_CHARS) {
          item.text = truncateAtSentenceBoundary(item.text, CONTEXT_EXCERPT_CHARS).text;
          item.textTruncated = true;
          return true;
        }
      }
      for (const item of context.relevant?.continuedOutstandingItems?.items ?? []) {
        if (item.text.length > CONTEXT_EXCERPT_CHARS) {
          item.text = truncateAtSentenceBoundary(item.text, CONTEXT_EXCERPT_CHARS).text;
          item.textTruncated = true;
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
      for (const item of context.pendingOutstandingItems) {
        if (item.text.length > CONTEXT_EXCERPT_CHARS) {
          item.text = truncateAtSentenceBoundary(item.text, CONTEXT_EXCERPT_CHARS).text;
          if (!item.textTruncated) {
            item.textTruncated = true;
            context.pendingOutstandingItemsTruncated += 1;
          }
          this.annotateOutstandingItemOmission(context);
          return true;
        }
      }
      return false;
    };

    // Priority under budget when path-matched Knowledge has pointers (most valuable last to go): full relevant.knowledge
    // records, then up to five pointers in their shortest form (id, title of at most 24 characters, path), then
    // everything lower: recent sections and the plain ids of their pointers, page content, further relevant Sessions,
    // decisions, open items, and text length. So titles shorten first, all lower-value content is trimmed next (recent
    // sections, text, recentKnowledge ids, relevant page sections, Sessions, decisions, open items), and only then is a pointer demoted
    // (back to a flagged entry or plain id, so trust flags and ids stay) before a full relevant record is popped,
    // which may itself become a pointer. Each step removes or shortens something, so the loop ends.
    const shortenPathTitles = (): boolean => {
      const omission = context.omitted?.find((candidate) => candidate.section === "relevant.knowledge");
      for (const entry of omission ? pathEntries(omission) : []) {
        if (entry.title && entry.title.length > CONTEXT_PATH_ENTRY_SHORT_TITLE_CHARS) {
          entry.title = truncateAtSentenceBoundary(entry.title, CONTEXT_PATH_ENTRY_SHORT_TITLE_CHARS).text;
          return true;
        }
      }
      return false;
    };
    // Last of the pointer reductions: forget an unflagged record that was only listed because it ranked beyond the
    // relevant slots (never shown), which restores what the response held before pointers existed.
    const forgetBeyondLimitPointer = (): boolean => {
      const omission = context.omitted?.find((candidate) => candidate.section === "relevant.knowledge");
      const beyond = omission ? beyondLimitIds.get(omission) : undefined;
      if (!omission || !beyond || beyond.size === 0) return false;
      const flagged = new Set((omission.entries ?? []).map((entry) => entry.id));
      const listed = (omission.ids ?? []).find((id) => beyond.has(id));
      const hidden = [...beyond].find((id) => !flagged.has(id) && !(omission.ids ?? []).includes(id));
      const id = listed ?? hidden;
      if (id === undefined) return false;
      if (listed !== undefined) {
        omission.ids = omission.ids!.filter((candidate) => candidate !== id);
        if (omission.ids.length === 0) delete omission.ids;
      } else if ((omission.moreIds ?? 0) > 0) {
        omission.moreIds! -= 1;
        if (omission.moreIds === 0) delete omission.moreIds;
      } else {
        return false;
      }
      beyond.delete(id);
      omission.count -= 1;
      omittedIdsByContext.get(context)?.delete(id);
      if (beyond.size === 0) omission.reasons = omission.reasons?.filter((reason) => reason !== RANKED_BEYOND_REASON);
      if (omission.count === 0) context.omitted = context.omitted!.filter((candidate) => candidate !== omission);
      if (context.omitted!.length === 0) delete context.omitted;
      return true;
    };
    const dropPathEntry = (): boolean => {
      const omission = context.omitted?.find((candidate) => candidate.section === "relevant.knowledge");
      const last = omission ? pathEntries(omission).at(-1) : undefined;
      if (!omission || !last) return false;
      demotePathEntry(omission, last.id);
      return true;
    };

    // The few plain ids a recentKnowledge pointer lists are the cheapest bookkeeping to give up: the count and the flagged
    // entries stay, and the records are one work_search_knowledge call away.
    const dropRecentKnowledgeIds = (): boolean => {
      const omission = context.omitted?.find((candidate) => candidate.section === "recentKnowledge");
      if (!omission || (!omission.ids?.length && !omission.moreIds)) return false;
      delete omission.ids;
      delete omission.moreIds;
      return true;
    };
    const hasPathPointers = pathKnowledgeByContext.has(context);
    const trimLast = (): boolean =>
      hasPathPointers
        ? dropRecentKnowledgeIds() || trimRelevantBesidesKnowledge() || dropPathEntry() || trimRelevantKnowledge()
        : trimRelevant();
    let trimmed = false;
    while (
      responseLength() > limit &&
      (shortenPathTitles() || trimNext() || shortenNext() || forgetBeyondLimitPointer() || trimLast())
    ) {
      trimmed = true;
    }

    // Fit the unmodified main response first; optional indicators cannot change any existing content selection.
    if (responseLength() <= limit && context.relevant) {
      const supplements = this.contextSupplementsFor(context);
      if (supplements.length > 0) {
        const originalOmissions = [...(context.omitted ?? [])];
        const selectedSupplements = [...supplements];
        const removedSupplements: ContextSupplementIndicator[] = [];
        const applySupplements = (): void => {
          if (selectedSupplements.length > 0) context.relevant!.supplements = [...selectedSupplements];
          else delete context.relevant!.supplements;
          context.omitted = [...originalOmissions];
          if (removedSupplements.length > 0) context.omitted.push(contextSupplementOmission(removedSupplements));
          if (context.omitted.length === 0) delete context.omitted;
        };

        applySupplements();
        while (responseLength() > limit && selectedSupplements.length > 0) {
          removedSupplements.push(selectedSupplements.pop()!);
          applySupplements();
        }
        if (responseLength() > limit) {
          context.omitted = [...originalOmissions, contextSupplementOmission(removedSupplements, false)];
        }
        if (responseLength() > limit) {
          // When even the omission pointer cannot fit, keep the baseline response byte-for-byte intact.
          delete context.relevant.supplements;
          if (originalOmissions.length > 0) context.omitted = originalOmissions;
          else delete context.omitted;
        }
      }
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
    // On a busy file the Sessions fill the page and recall reserves only a few slots for Knowledge, so the same ranking
    // pass also names the best path-matched Knowledge beyond the page (internal; work_recall never returns them).
    const recalled = this.searchIndex.recall({
      q: task,
      paths,
      projectId,
      limit: 20,
      ...(paths.length > 0 ? { extraPathKnowledge: CONTEXT_OMITTED_PATH_ENTRY_LIMIT + RELEVANT_LIMIT } : {}),
    });
    const termHits = recalled.termHits;
    const extraPathKnowledge = recalled.extraPathKnowledge ?? [];
    // One batch for the page and the extra records, so staleness is still read once.
    const trusted = this.store.getKnowledgeWithTrustMany([
      ...recalled.hits.filter((hit) => hit.type === "knowledge").map((hit) => hit.id),
      ...extraPathKnowledge.map((item) => item.id),
    ]);
    const hits = this.withRelatedSessions(recalled.hits, trusted).map((hit) => this.contextHit(hit));
    const knowledgeHits = hits.filter((hit) => hit.type === "knowledge");
    const knowledge = knowledgeHits.slice(0, RELEVANT_LIMIT);
    // Knowledge matched by a focus path, wherever it ranks: past the five relevant slots or dropped by the budget it
    // still tells an Agent which Knowledge covers which file.
    const pageEntries = knowledgeHits.flatMap((hit, rank): PathKnowledge[] => {
      const path = hit.matchedPaths?.[0];
      if (!path) return [];
      return [
        {
          id: hit.id,
          title: truncateAtSentenceBoundary(hit.title, CONTEXT_PATH_ENTRY_TITLE_CHARS).text,
          path: boundedPath(path),
          rank,
          ...(hit.possiblyStale ? { possiblyStale: true } : {}),
          ...(hit.needsReview ? { needsReview: true } : {}),
        },
      ];
    });
    // Ranked after every Knowledge hit of the page; together they stay within the entry cap plus the relevant slots.
    const extraEntries = extraPathKnowledge
      .slice(0, Math.max(0, CONTEXT_OMITTED_PATH_ENTRY_LIMIT + RELEVANT_LIMIT - pageEntries.length))
      .map((item, index): PathKnowledge => {
        const record = trusted.get(item.id);
        return {
          id: item.id,
          title: truncateAtSentenceBoundary(item.title, CONTEXT_PATH_ENTRY_TITLE_CHARS).text,
          path: boundedPath(item.matchedPath),
          rank: knowledgeHits.length + index,
          ...(record?.possiblyStale ? { possiblyStale: true } : {}),
          ...(record?.review ? { needsReview: true } : {}),
        };
      });
    const pathKnowledge = [...pageEntries, ...extraEntries];
    const sessions = hits
      .filter((hit) => hit.type === "session")
      .slice(0, RELEVANT_LIMIT)
      .flatMap((hit) => {
        const record = this.store.getSessionById(hit.id);
        return record ? [{ hit, record }] : [];
      });
    const pendingBySession = this.groupOutstandingItems(
      this.store.pendingOutstandingItemsForSessions(sessions.map(({ record }) => record.id)),
    );
    const hotspots = projectId && paths.length > 0 ? this.store.hotspotHints(projectId, paths) : [];
    const decisions = sessions
      .flatMap(({ record }) =>
        (record.workSummary?.decisions ?? [])
          .filter((text) => text.trim().length > 0)
          .map((text, index): RelevantDecisionDigest => {
            const bounded = truncateAtSentenceBoundary(text, DIGEST_ITEM_LENGTH);
            return {
              sessionId: record.id,
              // The Session's other decisions follow this one; budget trimming drops from the end, so the first stays.
              ...(index === 0 ? { sessionTitle: record.title, completedAt: record.completedAt } : {}),
              text: bounded.text,
              ...(bounded.truncated ? { truncated: true } : {}),
            };
          }),
      )
      .slice(0, RECENT_DECISION_LIMIT);
    const scoped = <T extends { projectId: string; projectName?: string }>(item: T): ProjectScopedItem<T> =>
      projectId ? withoutProjectFields(item) : item;
    // Same helper as the finalize receipt, so the Agent sees before finalize what the receipt would list after it.
    const linkedSessionIds = focus.linkedSessionIds ?? [];
    const continued =
      projectId && linkedSessionIds.length > 0
        ? this.continuedOutstandingItems(projectId, linkedSessionIds)
        : undefined;
    const relevant: RelevantContext = {
      ...(task ? { task } : {}),
      ...(paths.length > 0 ? { paths } : {}),
      confidence: recalled.confidence,
      outstandingItems: this.contextOutstandingItemDigest(
        this.store.relatedPendingOutstandingItems({
          projectId,
          task,
          paths,
          sourceSessionIds: recalled.hits.filter((hit) => hit.type === "session").map((hit) => hit.id),
          ...(continued?.allIds.length ? { excludeItemIds: continued.allIds } : {}),
        }),
      ),
      ...(continued && continued.digest.total > 0
        ? { continuedOutstandingItems: this.contextContinuedDigest(continued.digest) }
        : {}),
      knowledge: knowledge.map(scoped),
      decisions,
      sessions: sessions.map(({ hit, record }) => ({
        ...scoped(hit),
        openItems: this.openItemsForSession(record, pendingBySession.get(record.id) ?? []),
      })),
      knowledgePages: this.getRelevantKnowledgePages(focus, projectId),
      ...(termHits ? { termHits } : {}),
      ...(hotspots.length > 0 ? { hotspots } : {}),
      // One pointer, not per path: the whole history of a file is one bounded read away.
      ...(hotspots.some((hint) => hint.totalSessions > sessions.length)
        ? { fileHistoryReadWith: "work_get_file_history" as const }
        : {}),
    };
    if (pathKnowledge.length > 0) pathKnowledgeByRelevant.set(relevant, pathKnowledge);
    return relevant;
  }

  private contextHit(hit: RecallHit): RecallHit {
    const bounded = truncateAtSentenceBoundary(hit.excerpt, CONTEXT_EXCERPT_CHARS);
    return bounded.truncated ? { ...hit, excerpt: bounded.text, truncated: true } : hit;
  }

  private contextSupplementsFor(context: ContextResult): ContextSupplementIndicator[] {
    const relevant = context.relevant;
    if (!relevant) return [];

    const sources = relevant.sessions.slice(0, CONTEXT_SUPPLEMENT_SOURCE_LIMIT).flatMap((hit) => {
      const record = this.store.getSessionById(hit.id);
      return record && !record.voided ? [{ hit, record }] : [];
    });
    if (sources.length === 0) return [];

    const excludedIds = new Set([
      ...relevant.sessions.map((session) => session.id),
      ...relevant.knowledge.map((knowledge) => knowledge.id),
    ]);
    for (const id of omittedIdsByContext.get(context) ?? []) excludedIds.add(id);

    const appliedBySession = this.store.appliedKnowledgeIdsBySessions(sources.map(({ record }) => record.id));
    const appliedKnowledgeIds = [...new Set([...appliedBySession.values()].flat())];
    const appliedKnowledge = this.store.getKnowledgeWithTrustMany(appliedKnowledgeIds);
    const supplements: ContextSupplementIndicator[] = [];

    for (const source of sources) {
      if (supplements.length >= CONTEXT_SUPPLEMENT_LIMIT) break;

      const linkedSessions = (source.hit.related ?? [])
        .filter((link) => link.relation === "continues" || link.relation === "related")
        .sort((left, right) => Number(left.relation !== "continues") - Number(right.relation !== "continues"));
      const relatedCandidates: ContextSupplementIndicator[] = linkedSessions.map((link) => {
        const includedBecause: ContextSupplementReason = {
          kind: "related_session",
          sourceSessionId: source.record.id,
          relation: link.relation === "continues" ? "parent" : "related",
        };
        return { type: "session", id: link.id, title: link.title, includedBecause };
      });
      const knowledgeCandidates: ContextSupplementIndicator[] = (appliedBySession.get(source.record.id) ?? []).flatMap(
        (id) => {
          const knowledge = appliedKnowledge.get(id);
          if (!knowledge || knowledge.status !== "active" || knowledge.projectId !== source.record.projectId) return [];
          const includedBecause: ContextSupplementReason = {
            kind: "applied_knowledge",
            sourceSessionId: source.record.id,
          };
          return [
            {
              type: "knowledge" as const,
              id: knowledge.id,
              title: knowledge.title,
              includedBecause,
              ...(knowledge.possiblyStale ? { possiblyStale: true } : {}),
              ...(knowledge.review ? { needsReview: true } : {}),
            },
          ];
        },
      );
      const orderedCandidates = [
        ...relatedCandidates.filter(
          (candidate) => candidate.type === "session" && candidate.includedBecause.relation === "parent",
        ),
        ...knowledgeCandidates.slice(0, 1),
        ...relatedCandidates.filter(
          (candidate) => candidate.type === "session" && candidate.includedBecause.relation === "related",
        ),
        ...knowledgeCandidates.slice(1),
      ];
      let sourceCount = 0;
      for (const candidate of orderedCandidates) {
        if (sourceCount >= CONTEXT_SUPPLEMENT_ITEMS_PER_SOURCE || supplements.length >= CONTEXT_SUPPLEMENT_LIMIT) {
          break;
        }
        if (excludedIds.has(candidate.id)) continue;
        excludedIds.add(candidate.id);
        supplements.push(candidate);
        sourceCount += 1;
      }
    }

    return supplements;
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
          ...(projectId ? {} : { projectId: match.page.projectId }),
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
    const cleanups = this.store.listOutstandingCleanupRequests({ projectId, status: "pending", pageSize: 5 });
    const knowledgeCandidates = this.store.openKnowledgeCandidateRequests(projectId);
    // Only a project-scoped call (already admitted by the policy gate) mentions the backlog, and never beside an open request.
    const knowledgeBacklog =
      projectId && knowledgeCandidates.length === 0 ? this.store.knowledgeCandidateBacklog(projectId) : undefined;
    return {
      reportSynthesis:
        reports.outcome === "report_synthesis_requests"
          ? reports.requests
              .filter((request) => active.has(request.status) && inScope(request))
              .sort(byNewest)
              .slice(0, 5)
              .map((request) => ({
                ...request,
                sourceSessionIds: request.sourceSessionIds.slice(0, 5),
                ...(request.sourceSessionIds.length > 5
                  ? { sourceSessionIdsOmittedCount: request.sourceSessionIds.length - 5 }
                  : {}),
              }))
          : [],
      metadataBackfill:
        backfills.outcome === "metadata_backfill_requests"
          ? backfills.requests
              .filter((request) => active.has(request.status) && inScope(request))
              .sort(byNewest)
              .slice(0, 5)
          : [],
      ...(cleanups.outcome === "outstanding_cleanup_requests" && cleanups.requests.length > 0
        ? { outstandingCleanup: cleanups.requests }
        : {}),
      knowledgeCandidates,
      ...(knowledgeBacklog
        ? {
            knowledgeBacklog: {
              uncoveredSessions: knowledgeBacklog.uncoveredSessions,
              highValueSessions: knowledgeBacklog.highValueSessions,
              requestWith: "work_request_knowledge_candidates" as const,
            },
          }
        : {}),
      agentDecisions: this.store.countPendingAgentDecisions(projectId),
      knowledgePages: this.store.pendingKnowledgePages(projectId),
    };
  }

  private getMetadataFollowUps(projectId?: string): ContextResult["metadataFollowUps"] {
    const projectRoot = projectId ? this.store.getProjectById(projectId)?.rootPath : undefined;
    return (
      this.store.countMetadataBackfillFollowUps({ projectRoot }) ?? {
        needsBackfill: 0,
        changedFilesMissing: 0,
        verificationMissing: 0,
        verificationNotRun: 0,
      }
    );
  }

  private getRecentKnowledge(projectId?: string): ProjectScopedItem<KnowledgeDigest>[] {
    const result = this.store.searchKnowledge({ projectId, status: "active", limit: 12 });
    if (result.outcome !== "knowledge") return [];
    const digests = result.items.map((knowledge) => this.contextKnowledgeDigest(knowledge));
    return projectId ? digests.map(withoutProjectFields) : digests;
  }

  private contextSessionDigest(
    session: WorkSessionRecord,
    pendingItems: OutstandingItem[],
  ): ReturnType<typeof toSessionDigest> {
    const digest = toSessionDigest(session, this.openItemsForSession(session, pendingItems));
    const bounded = truncateAtSentenceBoundary(session.summary, DIGEST_SUMMARY_LENGTH);
    return {
      ...digest,
      summary: bounded.text,
      ...(bounded.truncated ? { summaryTruncated: true } : {}),
    };
  }

  private openItemsForSession(session: WorkSessionRecord, pendingItems: OutstandingItem[]): string[] {
    return pendingItems
      .filter((item) => item.sourceSessionId === session.id)
      .slice(0, 3)
      .map((item) => truncateAtSentenceBoundary(item.text, DIGEST_ITEM_LENGTH).text);
  }

  private groupOutstandingItems(items: OutstandingItem[]): Map<string, OutstandingItem[]> {
    const grouped = new Map<string, OutstandingItem[]>();
    for (const item of items) {
      const group = grouped.get(item.sourceSessionId) ?? [];
      group.push(item);
      grouped.set(item.sourceSessionId, group);
    }
    return grouped;
  }

  private outstandingItemDigest(result: {
    items: OutstandingItem[];
    total: number;
    truncated?: true;
  }): RelatedOutstandingItems {
    return {
      items: result.items.map((item) => {
        const text = truncateAtSentenceBoundary(item.text, 400);
        const title = truncateAtSentenceBoundary(item.sourceSessionTitle, 160);
        return {
          id: item.id,
          sourceSessionId: item.sourceSessionId,
          sourceSessionTitle: title.text,
          sourceSessionCompletedAt: item.sourceSessionCompletedAt,
          text: text.text,
          ...(text.truncated ? { textTruncated: true } : {}),
          ...(title.truncated ? { sourceSessionTitleTruncated: true } : {}),
        };
      }),
      total: result.total,
      omitted: Math.max(0, result.total - result.items.length),
      ...(result.truncated ? { truncated: true as const } : {}),
      ...(result.total > 0 ? { hint: RELATED_OUTSTANDING_HINT } : {}),
    };
  }

  /** Context items keep only what decides whether to read more; the source title is one read away. */
  private contextOutstandingItemDigest(result: {
    items: OutstandingItem[];
    total: number;
    truncated?: true;
  }): ContextRelatedOutstandingItems {
    return {
      items: result.items.map((item) => {
        const text = truncateAtSentenceBoundary(item.text, CONTEXT_EXCERPT_CHARS);
        return {
          id: item.id,
          sourceSessionId: item.sourceSessionId,
          text: text.text,
          ...(text.truncated ? { textTruncated: true } : {}),
        };
      }),
      total: result.total,
      omitted: Math.max(0, result.total - result.items.length),
      ...(result.truncated ? { truncated: true as const } : {}),
      ...(result.total > 0 ? { hint: RELATED_OUTSTANDING_HINT } : {}),
    };
  }

  /** The receipt digest in the compact context shape: id, source Session id and a shortened text. */
  private contextContinuedDigest(digest: RelatedOutstandingItems): ContextRelatedOutstandingItems {
    return {
      ...digest,
      items: digest.items.map((item) => {
        const text = truncateAtSentenceBoundary(item.text, CONTEXT_EXCERPT_CHARS);
        return {
          id: item.id,
          sourceSessionId: item.sourceSessionId,
          text: text.text,
          ...(text.truncated || item.textTruncated ? { textTruncated: true } : {}),
        };
      }),
    };
  }

  private boundOutstandingItem(item: OutstandingItem): ContextOutstandingItem {
    const bounded = truncateAtSentenceBoundary(item.text, CONTEXT_OUTSTANDING_ITEM_TEXT_LENGTH);
    return { ...item, text: bounded.text, ...(bounded.truncated ? { textTruncated: true } : {}) };
  }

  private annotateOutstandingItemOmission(context: ContextResult): void {
    if (context.pendingOutstandingItemsOmitted === 0 && context.pendingOutstandingItemsTruncated === 0) return;
    context.omitted ??= [];
    let omission = context.omitted.find((item) => item.section === "pendingOutstandingItems");
    if (!omission) {
      omission = { section: "pendingOutstandingItems", count: 0, readWith: "work_list_outstanding_items" };
      context.omitted.push(omission);
    }
    omission.count = context.pendingOutstandingItemsOmitted + context.pendingOutstandingItemsTruncated;
    const reason = `待結項省略 ${context.pendingOutstandingItemsOmitted} 筆，文字截短 ${context.pendingOutstandingItemsTruncated} 筆`;
    omission.reasons = (omission.reasons ?? []).filter((entry) => !entry.startsWith("待結項省略 "));
    if (!omission.reasons.includes(reason)) omission.reasons.push(reason);
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
        // CROSS JOIN walks idx_sessions_completed newest first and stops at the limit, like SessionRepository.list;
        // a plain JOIN parsed the JSON of every tracked Session and sorted them all.
        `SELECT s.id, s.title, s.completed_at, json_extract(s.work_summary_json, '$.decisions') AS decisions_json
         FROM sessions s
         CROSS JOIN projects p ON p.id = s.project_id
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
