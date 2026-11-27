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
import { windowExcerpt } from "./excerpt-window.js";
import { parseQueryWords } from "./search-text.js";
import { staleFlags, type StaleFlags } from "./stale-flags.js";
import { weighTaskPaths, type InferredPathSource } from "./inferred-task-paths.js";
import { limitKnowledgePageReviewSections } from "./knowledge-page-service.js";

const RECENT_DECISION_LIMIT = 12;
const RECENT_KNOWLEDGE_LIMIT = 12;
const RELEVANT_LIMIT = 5;
// Chinese tasks have no word breaks, so pages match on character pairs; one shared pair is common wording.
const PAGE_PAIR_MATCH_MINIMUM = 2;
const KNOWLEDGE_HINT_TASK_ONLY =
  "No Knowledge text matched this task; pass `paths` (the files you will change) or `projectRoot` to look up Knowledge by file scope. This does not mean no Knowledge applies.";
const KNOWLEDGE_HINT_TASK_ONLY_SCOPED =
  "No Knowledge text matched this task; pass `paths` (the files you will change) to look up Knowledge by file scope. This does not mean no Knowledge applies.";
const KNOWLEDGE_HINT_PATHS =
  "No Knowledge has appliesTo or references covering these paths, and none matched the task text. Knowledge recorded without appliesTo can still apply: read recentKnowledge or search with work_search_knowledge.";
const CONTEXT_SUPPLEMENT_SOURCE_LIMIT = 3;
const CONTEXT_SUPPLEMENT_ITEMS_PER_SOURCE = 2;
const CONTEXT_SUPPLEMENT_LIMIT = 4;
const RECALL_DEFAULT_LIMIT = 8;
const RECALL_MAX_LIMIT = 30;
const SEARCH_LIMIT = 20;
const CONTEXT_DEFAULT_BUDGET_CHARS = 15_800;
const CONTEXT_TASK_BUDGET_CHARS = 9_800;
const CONTEXT_OMITTED_ID_LIMIT = 3;
const CONTEXT_OMITTED_PATH_ENTRY_LIMIT = 5;
const CONTEXT_PATH_ENTRY_TITLE_CHARS = 60;
const CONTEXT_PATH_ENTRY_SHORT_TITLE_CHARS = 24;
const CONTEXT_CONVENTIONS_READ_WITH = "work_get_knowledge_history";
const CONTEXT_CONVENTIONS_BLOCK_CHARS = 700;
const CONTEXT_CONVENTION_ID_CHARS = 64;
const CONTEXT_PATH_ENTRY_PATH_CHARS = 100;
const PATH_KNOWLEDGE_READ_WITH = "work_get_file_history/work_search_knowledge";
const DEFAULT_KNOWLEDGE_READ_WITH = "work_search_knowledge";
const RANKED_BEYOND_REASON = "超出相關 Knowledge 上限";
const DUPLICATE_REASON_PREFIX = "已列於";
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

export type ContextFocus = { task?: string; paths?: string[]; linkedSessionIds?: string[] };

type MetadataBackfillTotals = Extract<MetadataBackfillPreviewResult, { outcome: "backfill_preview" }>["totals"];

interface OmittedItem {
  id: string;
  reason: string;
  possiblyStale?: boolean;
  staleReason?: StaleFlags["staleReason"];
  broadChangesSince?: number;
  needsReview?: boolean;
  pathKnowledge?: Pick<PathKnowledge, "title" | "path" | "rank">;
}

interface PathKnowledge {
  id: string;
  title: string;
  path: string;
  rank: number;
  possiblyStale?: boolean;
  staleReason?: StaleFlags["staleReason"];
  broadChangesSince?: number;
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
  projectConventions(projectId: string): Array<{ id: string; title: string }>;
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

function shortenTitle(title: string, limit: number): string {
  const points = Array.from(title);
  return points.length <= limit
    ? title
    : `${points
        .slice(0, limit - 1)
        .join("")
        .trimEnd()}…`;
}

function contextTerms(focus: ContextFocus): string[] {
  const text = [focus.task, ...(focus.paths ?? [])].filter(Boolean).join(" ").toLocaleLowerCase();
  const ignored = new Set(["apps", "packages", "tests", "src", "dist", "test", "spec", "the", "and", "for"]);
  return [...new Set(text.match(/[\p{L}\p{N}_-]+/gu) ?? [])].filter((term) => term.length > 1 && !ignored.has(term));
}

function taskPairTerms(focus: ContextFocus, exact: readonly string[]): string[] {
  const known = new Set(exact);
  return [
    ...new Set(
      parseQueryWords(focus.task ?? "").flatMap((word) =>
        word.terms.filter((term) =>
          /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2}$/u.test(term),
        ),
      ),
    ),
  ].filter((term) => !known.has(term));
}

function matchCount(text: string, terms: readonly string[]): number {
  const normalized = text.toLocaleLowerCase();
  return terms.reduce((count, term) => count + (normalized.includes(term) ? 1 : 0), 0);
}

function hasFocus(focus: ContextFocus): boolean {
  return Boolean(focus.task?.trim() || (focus.paths ?? []).some((path) => path.trim()));
}

function withoutProjectFields<T extends { projectId: string; projectName?: string }>(item: T): ProjectScopedItem<T> {
  const { projectId: _projectId, projectName: _projectName, ...rest } = item;
  return rest;
}

const CONVENTION_POINTER_SECTIONS: ReadonlySet<string> = new Set([
  "recentKnowledge",
  "relevant.knowledge",
  "relevant.supplements",
]);

const omittedIdsByContext = new WeakMap<ContextResult, Set<string>>();

const pathKnowledgeByRelevant = new WeakMap<RelevantContext, PathKnowledge[]>();
interface InferredKnowledge {
  id: string;
  title: string;
  path: string;
  sourceSessionIds: string[];
  possiblyStale?: boolean;
  staleReason?: StaleFlags["staleReason"];
  broadChangesSince?: number;
  needsReview?: boolean;
}

interface InferredMatches {
  items: InferredKnowledge[];
  matchedIds: Set<string>;
}

const inferredKnowledgeByRelevant = new WeakMap<RelevantContext, InferredMatches>();

/** Frozen from the real-data replay in docs/experiments/task-path-replay.md; one supporting Session is often a coincidence. */
const INFERRED_POINTER_LIMIT = 3;
const INFERRED_MIN_SESSIONS = 2;
const EXCERPT_TRUNCATED_MARK = ',"excerptTruncated":true';

const budgetOmittedRecentByContext = new WeakMap<ContextResult, Set<string>>();
const pathKnowledgeByContext = new WeakMap<ContextResult, Map<string, PathKnowledge>>();
const pathEntryRanks = new WeakMap<ContextOmission, Map<string, number>>();

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
  if (item.possiblyStale) Object.assign(entry, staleFlags(item));
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
    if (item.possiblyStale) Object.assign(entry, staleFlags(item));
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

/**
 * The conventions block is added after the context was fitted as if there were none, so what Agents get for everything
 * else never depends on it. Its Knowledge is then taken out of the recent list, the supplements and the pointers that
 * name it, which only shrinks the response. A pointer is changed only where the final omission really lists the id; an
 * id that is merely counted (duplicates, moreIds) stays counted.
 */
function attachConventions(context: ContextResult, conventions: NonNullable<ContextResult["conventions"]>): void {
  context.conventions = conventions;
  const conventionIds = new Set(conventions.items.map((item) => item.id));
  context.recentKnowledge = context.recentKnowledge.filter((knowledge) => !conventionIds.has(knowledge.id));
  const supplements = context.relevant?.supplements;
  if (context.relevant && supplements) {
    const kept = supplements.filter((supplement) => !conventionIds.has(supplement.id));
    if (kept.length === 0) delete context.relevant.supplements;
    else context.relevant.supplements = kept;
  }
  if (!context.omitted) return;
  for (const omission of context.omitted) {
    if (!CONVENTION_POINTER_SECTIONS.has(omission.section)) continue;
    for (const id of conventionIds) {
      if (omission.ids?.includes(id)) {
        omission.ids = omission.ids.filter((candidate) => candidate !== id);
        if (omission.ids.length === 0) delete omission.ids;
        omission.count -= 1;
      } else if (omission.entries?.some((entry) => entry.id === id)) {
        omission.entries = omission.entries.filter((entry) => entry.id !== id);
        if (omission.entries.length === 0) delete omission.entries;
        omission.count -= 1;
      }
    }
  }
  context.omitted = context.omitted.filter((omission) => omission.count > 0);
  if (context.omitted.length === 0) delete context.omitted;
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
  /** Always true in the product; docs/experiments/task-path-replay.mjs and tests turn it off. */
  private inferTaskPaths = true;

  public constructor(
    private readonly db: DatabaseSync,
    private readonly searchIndex: SearchRepository,
    private readonly store: ContextRecallStoreReader,
  ) {}

  public getContext(projectRoot?: string, focus: ContextFocus = {}): ContextQueryResult {
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

  public relatedOutstandingItems(
    projectId: string,
    focus: ContextFocus,
    excludeSourceSessionId?: string,
    excludeItemIds?: readonly string[],
  ): RelatedOutstandingItems {
    if (!this.store.hasPendingOutstandingItems(projectId, excludeSourceSessionId))
      return { items: [], total: 0, omitted: 0 };
    return this.outstandingItemDigest(
      this.store.relatedPendingOutstandingItems({
        projectId,
        ...focus,
        excludeSourceSessionId,
        ...(excludeItemIds?.length ? { excludeItemIds } : {}),
      }),
    );
  }

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
        ...staleFlags(knowledge ?? {}),
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
      // Filling in "title" for a hit without a named field would claim a match that did not happen.
      ...(hit.matchedIn[0] ? { matchedIn: hit.matchedIn[0] } : {}),
      ...(hit.matchedVia ? { matchedVia: hit.matchedVia } : {}),
      ...(hit.section ? { section: hit.section } : {}),
      excerpt: hit.excerpt,
    }));
    return {
      outcome: "search",
      confidence: result.confidence,
      hits,
      ...(result.termHits ? { termHits: result.termHits } : {}),
      ...(result.termHitsTruncated ? { termHitsTruncated: true as const } : {}),
    };
  }

  private buildContext(project: ProjectRecord, focus: ContextFocus): ContextResult {
    const relevant = this.getRelevantContext(focus, project.id);
    const conventions = this.getConventions(project.id);
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
    // The policy decision that admitted this call doubles as the tracking check.
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
    const fitted = this.fitContextBudget(this.deduplicateContext(context, focus), focus);
    if (conventions) attachConventions(fitted, conventions);
    return fitted;
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
          ...staleFlags(knowledge),
          ...(knowledge.needsReview ? { needsReview: true } : {}),
        },
        "work_search_knowledge",
      );
      return false;
    });
    const pathKnowledge = pathKnowledgeByRelevant.get(context.relevant) ?? [];
    if (pathKnowledge.length > 0) {
      pathKnowledgeByContext.set(context, new Map(pathKnowledge.map((item) => [item.id, item])));
      const shownIds = new Set([...relevantKnowledgeIds, ...context.recentKnowledge.map((knowledge) => knowledge.id)]);
      for (const item of pathKnowledge) {
        if (shownIds.has(item.id)) continue;
        addOmission(
          context,
          "relevant.knowledge",
          {
            id: item.id,
            reason: RANKED_BEYOND_REASON,
            ...staleFlags(item),
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
        const pathKnowledge = pathKnowledgeItem(context, recentKnowledge.id);
        addOmission(
          context,
          pathKnowledge.pathKnowledge ? "relevant.knowledge" : "recentKnowledge",
          {
            id: recentKnowledge.id,
            reason: "預算限制：較低優先 Knowledge",
            ...staleFlags(recentKnowledge),
            ...(recentKnowledge.needsReview ? { needsReview: true } : {}),
            ...pathKnowledge,
          },
          DEFAULT_KNOWLEDGE_READ_WITH,
        );
        if (!pathKnowledge.pathKnowledge && !recentKnowledge.possiblyStale && !recentKnowledge.needsReview) {
          const budgetOmitted = budgetOmittedRecentByContext.get(context) ?? new Set<string>();
          budgetOmittedRecentByContext.set(context, budgetOmitted);
          budgetOmitted.add(recentKnowledge.id);
        }
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
            ...staleFlags(relevantKnowledge),
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
      const continued = context.relevant?.continuedOutstandingItems;
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
    const trimRelevantBesidesKnowledge = (): boolean =>
      trimRelevantPageSection() || trimRelevantSession() || trimRelevantDecision() || trimRelevantOutstanding();

    let focusTerms: string[] | undefined;
    const shortenTerms = (): string[] => (focusTerms ??= contextTerms(focus));
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
            pageSection.content = windowExcerpt(pageSection.content, shortenTerms(), CONTEXT_EXCERPT_CHARS).text;
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

    // Trim order matters: titles shorten, lower-value content goes, then pointers are demoted, and only then is a full
    // relevant record popped. Each step removes or shortens something, so the loop ends.
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

    // The unmodified main response is fitted first; optional indicators never change its selection.
    if (responseLength() <= limit && context.relevant) {
      const supplements = this.contextSupplementsFor(context);
      if (supplements.length > 0) this.fitSupplements(context, supplements, limit);
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

  private getRelevantContext(focus: ContextFocus, projectId?: string): RelevantContext | undefined {
    const task = focus.task?.trim();
    const paths = (focus.paths ?? []).map((path) => path.trim()).filter(Boolean);
    if (!task && paths.length === 0) {
      return undefined;
    }
    const recalled = this.searchIndex.recall({
      q: task,
      paths,
      projectId,
      limit: 20,
      knowledgeConfidenceLimit: RELEVANT_LIMIT,
      ...(paths.length > 0 ? { extraPathKnowledge: CONTEXT_OMITTED_PATH_ENTRY_LIMIT + RELEVANT_LIMIT } : {}),
    });
    const termHits = recalled.termHits;
    const extraPathKnowledge = recalled.extraPathKnowledge ?? [];
    const trusted = this.store.getKnowledgeWithTrustMany([
      ...recalled.hits.filter((hit) => hit.type === "knowledge").map((hit) => hit.id),
      ...extraPathKnowledge.map((item) => item.id),
    ]);
    const hits = this.withRelatedSessions(recalled.hits, trusted).map((hit) => this.contextHit(hit));
    const knowledgeHits = hits.filter((hit) => hit.type === "knowledge");
    const knowledge = knowledgeHits.slice(0, RELEVANT_LIMIT);
    const pageEntries = knowledgeHits.flatMap((hit, rank): PathKnowledge[] => {
      const path = hit.matchedPaths?.[0];
      if (!path) return [];
      return [
        {
          id: hit.id,
          title: truncateAtSentenceBoundary(hit.title, CONTEXT_PATH_ENTRY_TITLE_CHARS).text,
          path: boundedPath(path),
          rank,
          ...staleFlags(hit),
          ...(hit.needsReview ? { needsReview: true } : {}),
        },
      ];
    });
    const extraEntries = extraPathKnowledge
      .slice(0, Math.max(0, CONTEXT_OMITTED_PATH_ENTRY_LIMIT + RELEVANT_LIMIT - pageEntries.length))
      .map((item, index): PathKnowledge => {
        const record = trusted.get(item.id);
        return {
          id: item.id,
          title: truncateAtSentenceBoundary(item.title, CONTEXT_PATH_ENTRY_TITLE_CHARS).text,
          path: boundedPath(item.matchedPath),
          rank: knowledgeHits.length + index,
          ...staleFlags(record ?? {}),
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
              // Trimming drops from the end, so the first decision of a Session, which carries its title, stays.
              ...(index === 0 ? { sessionTitle: record.title, completedAt: record.completedAt } : {}),
              text: bounded.text,
              ...(bounded.truncated ? { truncated: true } : {}),
            };
          }),
      )
      .slice(0, RECENT_DECISION_LIMIT);
    const scoped = <T extends { projectId: string; projectName?: string }>(item: T): ProjectScopedItem<T> =>
      projectId ? withoutProjectFields(item) : item;
    const linkedSessionIds = focus.linkedSessionIds ?? [];
    const continued =
      projectId && linkedSessionIds.length > 0
        ? this.continuedOutstandingItems(projectId, linkedSessionIds)
        : undefined;
    const knowledgeHint =
      knowledgeHits.length === 0 && pathKnowledge.length === 0
        ? paths.length > 0
          ? KNOWLEDGE_HINT_PATHS
          : projectId
            ? KNOWLEDGE_HINT_TASK_ONLY_SCOPED
            : KNOWLEDGE_HINT_TASK_ONLY
        : undefined;
    const relevant: RelevantContext = {
      ...(task ? { task } : {}),
      ...(paths.length > 0 ? { paths } : {}),
      confidence: recalled.confidence,
      knowledgeConfidence: recalled.knowledgeConfidence,
      ...(knowledgeHint ? { knowledgeHint } : {}),
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
      ...(recalled.termHitsTruncated ? { termHitsTruncated: true as const } : {}),
      ...(hotspots.length > 0 ? { hotspots } : {}),
      ...(hotspots.some((hint) => hint.totalSessions > sessions.length)
        ? { fileHistoryReadWith: "work_get_file_history" as const }
        : {}),
    };
    if (pathKnowledge.length > 0) pathKnowledgeByRelevant.set(relevant, pathKnowledge);
    if (task && paths.length === 0 && projectId && this.inferTaskPaths) {
      const inferred = this.inferredKnowledge(
        sessions.map(({ hit, record }) => ({ id: record.id, score: hit.score, changedFiles: record.changedFiles })),
        projectId,
        new Set(knowledgeHits.map((hit) => hit.id)),
      );
      if (inferred.matchedIds.size > 0) inferredKnowledgeByRelevant.set(relevant, inferred);
    }
    return relevant;
  }

  /** Never changes first-round content (relevant.*); when nothing fits, the response stays exactly as it was. */
  private fitSupplements(context: ContextResult, supplements: ContextSupplementIndicator[], limit: number): void {
    const relevant = context.relevant!;
    const baseOmitted = context.omitted;
    const baseRecent = context.recentKnowledge;
    const isInferred = (item: ContextSupplementIndicator): boolean => item.includedBecause.kind === "inferred_path";
    const inferredMatches = inferredKnowledgeByRelevant.get(relevant);
    const matchedIds = new Set([
      ...(inferredMatches?.matchedIds ?? []),
      ...(inferredMatches?.items ?? []).map((item) => item.id),
    ]);
    const budgetOmitted = budgetOmittedRecentByContext.get(context) ?? new Set<string>();
    const poppable = baseRecent.filter((item) => !matchedIds.has(item.id)).reverse();
    const shortenable = poppable.filter(
      (item) => item.excerpt.length > (item.excerptTruncated ? 0 : EXCERPT_TRUNCATED_MARK.length),
    );

    const apply = (selectedCount: number, shortenCount: number, popCount: number, listRemovedIds = true): void => {
      const selected = supplements.slice(0, selectedCount);
      const removed = supplements.slice(selectedCount);
      const inferredIds = new Set(selected.filter(isInferred).map(({ id }) => id));
      const popped = new Set(poppable.slice(0, popCount).map(({ id }) => id));
      const shortened = new Set(shortenable.slice(0, shortenCount).map(({ id }) => id));
      context.omitted = baseOmitted ? structuredClone(baseOmitted) : undefined;
      context.recentKnowledge = baseRecent
        .filter(({ id }) => !inferredIds.has(id) && !popped.has(id))
        .map((item) => (shortened.has(item.id) ? { ...item, excerpt: "", excerptTruncated: true } : item));
      for (const item of poppable.slice(0, popCount)) {
        const pathKnowledge = pathKnowledgeItem(context, item.id);
        addOmission(
          context,
          pathKnowledge.pathKnowledge ? "relevant.knowledge" : "recentKnowledge",
          {
            id: item.id,
            reason: "預算限制：較低優先 Knowledge",
            ...staleFlags(item),
            ...(item.needsReview ? { needsReview: true } : {}),
            ...pathKnowledge,
          },
          DEFAULT_KNOWLEDGE_READ_WITH,
        );
      }
      for (const id of inferredIds) if (budgetOmitted.has(id)) this.forgetOmittedRecent(context, id);
      if (selected.length > 0) relevant.supplements = [...selected];
      else delete relevant.supplements;
      if (removed.length > 0) (context.omitted ??= []).push(contextSupplementOmission(removed, listRemovedIds));
      if (context.omitted?.length === 0) delete context.omitted;
    };
    const fits = (selectedCount: number, shortenCount: number, popCount: number): boolean => {
      apply(selectedCount, shortenCount, popCount);
      return JSON.stringify(context).length <= limit;
    };

    for (let selectedCount = supplements.length; selectedCount >= 0; selectedCount -= 1) {
      if (fits(selectedCount, 0, 0)) return;
      if (poppable.length === 0 || !supplements.slice(0, selectedCount).some(isInferred)) continue;
      if (!fits(selectedCount, shortenable.length, poppable.length)) continue;
      for (let shortenCount = 1; shortenCount <= shortenable.length; shortenCount += 1) {
        if (fits(selectedCount, shortenCount, 0)) return;
      }
      let popCount = 1;
      while (popCount < poppable.length && !fits(selectedCount, shortenable.length, popCount)) popCount += 1;
      apply(selectedCount, shortenable.length, popCount);
      return;
    }
    apply(0, 0, 0, false);
    if (JSON.stringify(context).length <= limit) return;
    // Keeps the baseline response byte-for-byte intact.
    delete relevant.supplements;
    context.recentKnowledge = baseRecent;
    if (baseOmitted) context.omitted = baseOmitted;
    else delete context.omitted;
  }

  private forgetOmittedRecent(context: ContextResult, id: string): void {
    const omission = context.omitted?.find((candidate) => candidate.section === "recentKnowledge");
    if (!omission) return;
    omission.count -= 1;
    if (omission.ids?.includes(id)) {
      omission.ids = omission.ids.filter((candidate) => candidate !== id);
      if (omission.ids.length === 0) delete omission.ids;
    } else if (omission.moreIds) {
      omission.moreIds -= 1;
      if (omission.moreIds === 0) delete omission.moreIds;
    }
    if (omission.count > 0) return;
    context.omitted = context.omitted!.filter((candidate) => candidate !== omission);
    if (context.omitted.length === 0) delete context.omitted;
  }

  private inferredKnowledge(
    sources: InferredPathSource[],
    projectId: string,
    firstRoundIds: ReadonlySet<string>,
  ): InferredMatches {
    const none: InferredMatches = { items: [], matchedIds: new Set() };
    const weights = weighTaskPaths(sources);
    if (weights.size === 0) return none;
    const wanted = INFERRED_POINTER_LIMIT + RECENT_KNOWLEDGE_LIMIT + firstRoundIds.size;
    const matchedIds = new Set<string>();
    const ranked = this.searchIndex.knowledgeForWeightedPaths(
      new Map([...weights].map(([path, { weight }]) => [path, weight])),
      projectId,
      wanted,
      matchedIds,
    );
    for (const id of firstRoundIds) matchedIds.delete(id);
    const matched = ranked
      .filter((item) => !firstRoundIds.has(item.id))
      .filter(
        (item) =>
          new Set(item.files.flatMap((file) => weights.get(file)?.sessionIds ?? [])).size >= INFERRED_MIN_SESSIONS,
      )
      .slice(0, INFERRED_POINTER_LIMIT + RECENT_KNOWLEDGE_LIMIT);
    if (matched.length === 0) return { items: [], matchedIds };
    const trusted = this.store.getKnowledgeWithTrustMany(matched.map((item) => item.id));
    const items = matched.flatMap((item): InferredKnowledge[] => {
      const record = trusted.get(item.id);
      if (!record || record.status !== "active" || record.projectId !== projectId) return [];
      const source = weights.get(item.matchedPath);
      return [
        {
          id: item.id,
          title: item.title,
          path: boundedPath(item.matchedPath),
          sourceSessionIds: source?.sourceSessionIds ?? [],
          ...staleFlags(record),
          ...(record.review ? { needsReview: true } : {}),
        },
      ];
    });
    return { items, matchedIds };
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

    const excludedIds = new Set([
      ...relevant.sessions.map((session) => session.id),
      ...relevant.knowledge.map((knowledge) => knowledge.id),
    ]);
    for (const id of omittedIdsByContext.get(context) ?? []) excludedIds.add(id);

    const supplements: ContextSupplementIndicator[] = [];
    const appliedBySession =
      sources.length > 0
        ? this.store.appliedKnowledgeIdsBySessions(sources.map(({ record }) => record.id))
        : new Map<string, string[]>();
    const appliedKnowledge = this.store.getKnowledgeWithTrustMany([...new Set([...appliedBySession.values()].flat())]);

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
              ...staleFlags(knowledge),
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

    // Appended last, so the fitting loop drops them first.
    const budgetOmitted = budgetOmittedRecentByContext.get(context);
    let inferredCount = 0;
    for (const item of inferredKnowledgeByRelevant.get(relevant)?.items ?? []) {
      if (inferredCount >= INFERRED_POINTER_LIMIT) break;
      if (supplements.some(({ id }) => id === item.id)) continue;
      if (excludedIds.has(item.id) && !budgetOmitted?.has(item.id)) continue;
      excludedIds.add(item.id);
      supplements.push({
        type: "knowledge",
        id: item.id,
        title: item.title,
        includedBecause: { kind: "inferred_path", path: item.path, sourceSessionIds: item.sourceSessionIds },
        ...staleFlags(item),
        ...(item.needsReview ? { needsReview: true } : {}),
      });
      inferredCount += 1;
    }

    return supplements;
  }

  private getRelevantKnowledgePages(focus: ContextFocus, projectId?: string): RelevantKnowledgePageDigest[] {
    const exactTerms = contextTerms(focus);
    const pairTerms = taskPairTerms(focus, exactTerms);
    const terms = [...exactTerms, ...pairTerms];
    if (terms.length === 0) return [];
    const pages = this.store.knowledgePagesForContext(projectId);
    const matches = pages
      .flatMap((page) =>
        page.sections.flatMap((section) => {
          const text = `${page.title} ${page.question} ${section.heading} ${section.content}`;
          const exact = matchCount(text, exactTerms);
          const pairs = matchCount(text, pairTerms);
          return exact > 0 || pairs >= PAGE_PAIR_MATCH_MINIMUM ? [{ page, section, score: exact + pairs }] : [];
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
      const bounded = windowExcerpt(match.section.content, terms, CONTEXT_PAGE_SECTION_CHARS);
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

  private getConventions(projectId: string): ContextResult["conventions"] {
    const items = this.store
      .projectConventions(projectId)
      .filter(({ id }) => JSON.stringify(id).length - 2 <= CONTEXT_CONVENTION_ID_CHARS)
      .map(({ id, title }) => ({
        id,
        title: shortenTitle(title.replace(/\s+/gu, " ").trim(), CONTEXT_PATH_ENTRY_TITLE_CHARS),
      }));
    if (items.length === 0) return undefined;
    const conventions = { readWith: CONTEXT_CONVENTIONS_READ_WITH, items } as const;
    while (JSON.stringify(conventions).length > CONTEXT_CONVENTIONS_BLOCK_CHARS) {
      const longest = items.reduce((widest, item) =>
        Array.from(item.title).length > Array.from(widest.title).length ? item : widest,
      );
      const points = Array.from(longest.title);
      if (points.length > 2) {
        longest.title = `${points
          .slice(0, Math.max(1, points.length - 5))
          .join("")
          .trimEnd()}…`;
      } else if (items.length > 1) {
        items.pop();
      } else {
        return undefined;
      }
    }
    return conventions;
  }

  private getRecentKnowledge(projectId?: string): ProjectScopedItem<KnowledgeDigest>[] {
    const result = this.store.searchKnowledge({ projectId, status: "active", limit: RECENT_KNOWLEDGE_LIMIT });
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

  /** From workSummary.decisions only: note/closing events mostly record process state, not decisions. */
  private getRecentDecisions(projectId?: string): DecisionDigest[] {
    const rows = this.db
      .prepare(
        // CROSS JOIN walks idx_sessions_completed newest first and stops at the limit; a plain JOIN sorted every Session.
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
