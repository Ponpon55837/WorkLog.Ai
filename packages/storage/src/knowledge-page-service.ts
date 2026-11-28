import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  KNOWLEDGE_PAGE_DEFAULTS,
  KNOWLEDGE_PAGE_INSUFFICIENT,
  KNOWLEDGE_PAGE_MAX_CONTENT_CHARS,
  KNOWLEDGE_PAGE_MAX_SECTIONS,
  KNOWLEDGE_PAGE_SECTION_SOURCE_LIMIT,
  knowledgePageLimits,
  type KnowledgePageAuthor,
  type KnowledgePageContext,
  type KnowledgePageContextQuery,
  type KnowledgePageContextResult,
  type KnowledgePageContextSession,
  type KnowledgePageContextSessionReason,
  type KnowledgePageContextSessionStub,
  type KnowledgePageDigest,
  type KnowledgePageFocusedContext,
  type KnowledgePageListQuery,
  type KnowledgePageListResult,
  type KnowledgePageNotFoundResult,
  type MarkKnowledgePageCheckedInput,
  type MarkKnowledgePageCheckedResult,
  type KnowledgePageLimits,
  type KnowledgePageRecord,
  type KnowledgePageReviewContext,
  type KnowledgePageRetryMaterial,
  type KnowledgePageReviewReason,
  type KnowledgePageReviewSection,
  type KnowledgePageSection,
  type KnowledgePageSectionChanges,
  type KnowledgePageSectionReviewReason,
  type KnowledgePageSize,
  type KnowledgePageSkippedResult,
  type KnowledgePageVersionConflictResult,
  type KnowledgePageVersionRecord,
  type KnowledgePageVersionsResult,
  type PolicyDecision,
  type RequestKnowledgePageUpdateInput,
  type RequestKnowledgePageUpdateResult,
  type SaveKnowledgePageInput,
  type SaveKnowledgePageResult,
  type UpdateKnowledgePageInput,
  type UpdateKnowledgePageResult,
  type WorkSummarySections,
} from "@work-intelligence/core";
import { nowIso, truncateAtCodeUnitLimit } from "@work-intelligence/shared";
import { combineRedactionSummaries, redactText, redactValue } from "./secret-redaction.js";
import { parseChangedFiles, parseJson, parseWorkSummarySections } from "./session-record-codecs.js";
import { parseQueryWords, tokenize } from "./search-text.js";
import { runImmediateTransaction } from "./sqlite-transaction.js";

function focusedContext(
  page: KnowledgePageRecord,
  query: KnowledgePageContextQuery,
  reviewToken: string,
): KnowledgePageFocusedContext {
  const wanted = new Set((query.headings ?? []).map((heading) => heading.trim().toLowerCase()));
  const terms = [...new Set(parseQueryWords(query.query ?? "").flatMap((word) => word.terms))];
  const reviewHeadings = new Set((page.reviewSections ?? []).map((section) => section.heading));
  const scores = page.sections.map((section) => {
    if (terms.length === 0) return 0;
    const tokens = new Set(tokenize(`${section.heading}\n${section.content}`));
    let tokenList: string[] | undefined;
    let score = 0;
    for (const term of terms) {
      if (tokens.has(term)) {
        score += 1;
      } else if (/^[a-z0-9]{4,}$/.test(term)) {
        tokenList ??= [...tokens];
        if (tokenList.some((token) => token.startsWith(term))) score += 1;
      }
    }
    return score;
  });
  const threshold = Math.max(1, Math.ceil(Math.max(0, ...scores) / 2));
  const sections: KnowledgePageFocusedContext["sections"] = [];
  const otherSections: KnowledgePageFocusedContext["otherSections"] = [];
  page.sections.forEach((section, index) => {
    if (wanted.has(section.heading.trim().toLowerCase()) || scores[index]! >= threshold) {
      sections.push({
        heading: section.heading,
        content: section.content,
        sourceSessionIds: section.sourceSessionIds,
        ...(reviewHeadings.has(section.heading) ? { needsReview: true as const } : {}),
      });
    } else {
      otherSections.push({ heading: section.heading, chars: section.content.length });
    }
  });
  return {
    outcome: "knowledge_page_context",
    focused: true,
    match: sections.length > 0 ? "sections" : "none",
    page: pageSummary(page),
    sections,
    otherSections,
    reviewToken,
    sessionsOmitted: true,
    readFullWith: "work_get_knowledge_page_context without query and headings (also returns the Sessions)",
  };
}

function pageSummary(page: KnowledgePageRecord): KnowledgePageFocusedContext["page"] {
  return {
    slug: page.slug,
    title: page.title,
    version: page.version,
    status: page.status,
    newSessionCount: page.newSessionCount,
    updatedAt: page.updatedAt,
    ...(page.needsReview ? { needsReview: true as const } : {}),
    ...(page.updateRequestedAt ? { updateRequestedAt: page.updateRequestedAt } : {}),
  };
}

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
  checked_through_session_id: string | null;
  covered_through_completed_at: string | null;
  covered_through_session_id: string | null;
};

/** sourcedThrough: a string is that time, null is unknown, an absent key means the page's own sourced_through. */
type StoredKnowledgePageSection = KnowledgePageSection & { sourcedThrough?: string | null };

interface SectionUpdate {
  upsertSections?: readonly KnowledgePageSection[];
  removeHeadings?: readonly string[];
}

type InvalidCursorResult = { outcome: "invalid_cursor"; reason: string };

type DroppedSourceSessionIds = Array<{ heading: string; sessionIds: string[] }>;

type SectionMerge =
  { sections: StoredKnowledgePageSection[]; changes: KnowledgePageSectionChanges } | { missingHeadings: string[] };

type ContextSessionRow = {
  id: string;
  title: string;
  completed_at: string;
  work_summary_json: string | null;
};

interface ReviewSources {
  after: CoveragePoint;
  newRows: ContextSessionRow[];
  changedRows: ContextSessionRow[];
}

type ContextSessionEntry = { row: ContextSessionRow; reasons?: KnowledgePageContextSessionReason[] };

type ContextSessionItem = KnowledgePageContextSession | KnowledgePageContextSessionStub;

interface BudgetedSessions {
  sessions: ContextSessionItem[];
  shown: ContextSessionEntry[];
  stubbed: boolean;
  truncated: boolean;
}

interface ContextSessions {
  sessions: ContextSessionItem[];
  truncated: boolean;
  through: CoveragePoint;
  shownRows: ContextSessionRow[];
}

type NewSessionSections = Map<string, Map<number, Set<KnowledgePageSectionReviewReason>>>;

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

type CitedSessionRow = {
  id: string;
  project_id: string;
  title: string;
  content_updated_at: string;
  voided_at: string | null;
};

type CitedSessionVoidEventRow = {
  target_id: string;
  action: "voided" | "restored";
  occurred_at: string;
};

const CONTEXT_SESSION_LIMIT = 60;
const CONTEXT_CHAR_BUDGET = 12_000;
const UNMAPPED_SESSION_CHAR_BUDGET = 3_000;
const REVIEW_SECTION_CONTENT_BUDGET = 4_000;
const LINK_EVIDENCE_WEIGHT = 2;
const FILE_EVIDENCE_WEIGHT = 1;
const MAX_EVIDENCE_SECTIONS = 3;
const MIN_SECTION_SCORE = 0.5;
const MAX_SECTIONS_PER_NEW_SESSION = 3;
const CONTEXT_SESSION_ITEMS = 2;
const CONTEXT_SESSION_ITEM_CHARS = 100;
const DIGEST_PAGE_CHARS = 1_500;
const DIGEST_TOTAL_CHARS = 4_500;
const DIGEST_REVIEW_SOURCE_LIMIT = 8;
const DIGEST_SOURCE_SESSION_LIMIT = 8;
const REVIEW_TOKEN_PREFIX = "kpr1.";
const REVIEW_TOKEN_FIELD_LIMIT = 200;
const SESSIONS_SEEN_IN_INVALID_WARNING =
  "sessionsSeenIn was ignored: it is not a reviewToken from this project, so every Session preview is included.";
const SESSIONS_SEEN_IN_WITHOUT_WINDOW_WARNING =
  "sessionsSeenIn was ignored: that reviewToken shows no new Session previews (it came from a deduped, focused or older read). Pass the reviewToken of your first plain or reviewOnly page read.";
const SESSIONS_SEEN_IN_STALE_WARNING =
  "sessionsSeenIn was ignored: a Session that read showed has changed since, so every preview is included. Pass a reviewToken from a fresh read.";
const SESSIONS_SEEN_IN_FOCUSED_WARNING = "sessionsSeenIn was ignored: a focused read returns no Sessions.";
const MISSING_REVIEW_TOKEN_WARNING =
  "Saved without reviewToken: no check for a newer page version was made, and Sessions finished after your read still count as new. Next time pass the reviewToken from work_get_knowledge_page_context.";
const COVERAGE_NOT_ADVANCED_HINT =
  "Coverage did not advance: the new Sessions still count. Mark the page checked, or pass checkedThroughSessionId with the save.";
const CURSOR_NOT_ADVANCED_WARNING =
  "The review cursor was not advanced: checkedThroughSessionId is no longer a valid cursor. Mark the page checked with a current Session if needed.";
const NOT_IN_PROGRESS = "COALESCE(json_extract(verification_json, '$.status'), '') <> 'in_progress'";
export const KNOWLEDGE_PAGE_MAINTENANCE_SESSION_THRESHOLD = 3;
const VERSION_HISTORY_LIMIT = 50;
const NOT_FOUND_SLUG_LIMIT = 20;
const NEAR_SLUG_DISTANCE = 2;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const IDEMPOTENCY_CONFLICT_RESULT = {
  outcome: "idempotency_conflict" as const,
  reason:
    "This idempotencyKey already saved different sections for this page, so nothing was written. Use a new idempotencyKey for new content.",
};

const EMPTY_CUSTOM_PAGE_HINT =
  "This custom page holds no confirmed content. If it is no longer needed, tell the user they can delete it in the Web UI (Knowledge pages); Agents cannot delete pages.";

const DEFAULT_PAGES = new Map<string, { title: string; question: string }>(
  KNOWLEDGE_PAGE_DEFAULTS.map((page) => [page.slug, { title: page.title, question: page.question }]),
);

function previewWorkSummary(sections: WorkSummarySections | undefined): {
  workSummary: KnowledgePageContextSession["workSummary"];
  truncated: boolean;
} {
  let truncated = false;
  const preview = (items: string[] = []) => {
    if (items.length > CONTEXT_SESSION_ITEMS) truncated = true;
    return items.slice(0, CONTEXT_SESSION_ITEMS).map((item) => {
      const bounded = truncateAtCodeUnitLimit(item, CONTEXT_SESSION_ITEM_CHARS);
      if (bounded.truncated) truncated = true;
      return bounded.text;
    });
  };
  const workSummary = {
    outcomes: preview(sections?.outcomes),
    decisions: preview(sections?.decisions),
    nextSteps: preview(sections?.nextSteps),
  };
  return { workSummary, truncated };
}

function sessionPreview(
  row: ContextSessionRow,
  reasons: KnowledgePageContextSessionReason[] | undefined,
): KnowledgePageContextSession {
  const preview = previewWorkSummary(parseWorkSummarySections(row.work_summary_json));
  return {
    id: row.id,
    title: row.title,
    completedAt: row.completed_at,
    workSummary: preview.workSummary,
    ...(preview.truncated ? { truncated: true } : {}),
    ...(reasons ? { reasons } : {}),
  };
}

function previewOrStub(
  row: ContextSessionRow,
  reasons: KnowledgePageContextSessionReason[] | undefined,
  seen: ReadonlySet<string>,
): ContextSessionItem {
  if (reasons?.length === 1 && reasons[0] === "new" && seen.has(row.id)) {
    return { id: row.id, title: row.title, reasons, previewSeen: true };
  }
  return sessionPreview(row, reasons);
}

function previewsDigest(rows: readonly ContextSessionRow[]): string {
  const hash = createHash("sha256");
  for (const row of rows) hash.update(`${JSON.stringify(sessionPreview(row, undefined))}\n`);
  return hash.digest("hex").slice(0, 16);
}

function skipped(decision: PolicyDecision): KnowledgePageSkippedResult {
  return {
    outcome: "skipped",
    projectRoot: decision.canonicalRoot,
    projectStatus: decision.projectStatus,
    reason: decision.reason ?? "Project recording is not enabled.",
  };
}

function boundedEditDistance(left: string, right: string, limit: number): number {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    let rowMinimum = row;
    for (let column = 1; column <= right.length; column += 1) {
      const substitution = previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1);
      const value = Math.min(previous[column]! + 1, current[column - 1]! + 1, substitution);
      current.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > limit) return limit + 1;
    previous = current;
  }
  return previous[right.length]!;
}

function nearestSlug(slug: string, candidates: readonly string[]): string | undefined {
  let best: { slug: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = boundedEditDistance(slug, candidate, NEAR_SLUG_DISTANCE);
    if (distance > NEAR_SLUG_DISTANCE || distance >= candidate.length) continue;
    if (!best || distance < best.distance) best = { slug: candidate, distance };
  }
  return best?.slug;
}

interface CompletedSessionCursor {
  id: string;
  completedAt: string;
}

/** Without an id, Sessions finished strictly after completedAt are new (pages saved before schema 34). */
interface CoveragePoint {
  completedAt: string;
  id?: string;
}

type WrittenVersion<Refusal> = { redactions: ReturnType<typeof combineRedactionSummaries> } | { refusal: Refusal };

interface ShownWindow {
  fromId: string;
  count: number;
  mask: string;
  digest: string;
}

interface ReviewTokenContent {
  pageId: string;
  version: number;
  through: CoveragePoint;
  window?: ShownWindow;
}

function sessionCoverage(row: PageRow): CoveragePoint | undefined {
  if (row.covered_through_completed_at !== null) {
    return {
      completedAt: row.covered_through_completed_at,
      ...(row.covered_through_session_id !== null ? { id: row.covered_through_session_id } : {}),
    };
  }
  return row.sourced_through ? { completedAt: row.sourced_through } : undefined;
}

function reviewedThrough(coverage: CoveragePoint, checked: CompletedSessionCursor | undefined): CoveragePoint {
  if (!checked) return coverage;
  const ahead =
    coverage.id === undefined
      ? checked.completedAt >= coverage.completedAt
      : compareCursor(checked, { completedAt: coverage.completedAt, id: coverage.id }) >= 0;
  return ahead ? { completedAt: checked.completedAt, id: checked.id } : coverage;
}

function laterCoverage(first: CoveragePoint, second: CoveragePoint): CoveragePoint {
  if (first.id === undefined || second.id === undefined) {
    return second.completedAt > first.completedAt ? second : first;
  }
  return compareCursor(second as CompletedSessionCursor, first as CompletedSessionCursor) > 0 ? second : first;
}

function sameCoverage(first: CoveragePoint, second: CoveragePoint): boolean {
  return first.completedAt === second.completedAt && first.id === second.id;
}

function encodeReviewToken(content: ReviewTokenContent): string {
  const payload = {
    p: content.pageId,
    v: content.version,
    at: content.through.completedAt,
    ...(content.through.id !== undefined ? { id: content.through.id } : {}),
    ...(content.window
      ? {
          fi: content.window.fromId,
          n: content.window.count,
          m: content.window.mask,
          d: content.window.digest,
        }
      : {}),
  };
  return REVIEW_TOKEN_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function pageContext(
  row: PageRow,
  page: KnowledgePageRecord,
  mode: KnowledgePageContext["mode"],
  { sessions, truncated, through }: ContextSessions,
  window?: ShownWindow,
): KnowledgePageContext {
  return {
    outcome: "knowledge_page_context",
    page,
    mode,
    sessions,
    omittedSessionFields: ["summary", "workSummary.scope", "workSummary.verification"],
    sessionReadWith: "work_get_session",
    truncated,
    reviewToken: encodeReviewToken({ pageId: row.id, version: row.version, through, ...(window ? { window } : {}) }),
  };
}

function decodeReviewToken(token: string): ReviewTokenContent | undefined {
  if (!token.startsWith(REVIEW_TOKEN_PREFIX)) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(token.slice(REVIEW_TOKEN_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null) return undefined;
  const { p, v, at, id, fi, n, m, d } = payload as Record<string, unknown>;
  const boundedText = (value: unknown): value is string =>
    typeof value === "string" && value.length <= REVIEW_TOKEN_FIELD_LIMIT;
  if (!boundedText(p) || p.length === 0 || !boundedText(at)) return undefined;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) return undefined;
  if (id !== undefined && (!boundedText(id) || id.length === 0)) return undefined;
  const window: ShownWindow | undefined =
    boundedText(fi) &&
    fi.length > 0 &&
    typeof n === "number" &&
    Number.isInteger(n) &&
    n >= 1 &&
    n <= CONTEXT_SESSION_LIMIT &&
    typeof m === "string" &&
    /^[0-9a-f]{1,16}$/.test(m) &&
    typeof d === "string" &&
    /^[0-9a-f]{16}$/.test(d)
      ? { fromId: fi, count: n, mask: m, digest: d }
      : undefined;
  return {
    pageId: p,
    version: v,
    through: { completedAt: at, ...(id !== undefined ? { id } : {}) },
    ...(window ? { window } : {}),
  };
}

function compareCursor(left: CompletedSessionCursor, right: CompletedSessionCursor): number {
  return left.completedAt.localeCompare(right.completedAt) || left.id.localeCompare(right.id);
}

function upperBoundCursor(sorted: readonly CompletedSessionCursor[], cursor: CompletedSessionCursor): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareCursor(sorted[middle]!, cursor) > 0) high = middle;
    else low = middle + 1;
  }
  return low;
}

function firstCompletedAfter(sorted: readonly CompletedSessionCursor[], completedAt: string): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle]!.completedAt > completedAt) high = middle;
    else low = middle + 1;
  }
  return low;
}

function storedSections(sections: readonly KnowledgePageSection[]) {
  return redactValue(
    sections.map((section) => ({
      heading: section.heading,
      content: section.content,
      sourceSessionIds: [...new Set(section.sourceSessionIds)],
    })),
  );
}

function parseStoredSections(json: string): StoredKnowledgePageSection[] {
  return parseJson<StoredKnowledgePageSection[]>(json, []);
}

function publicSection(section: StoredKnowledgePageSection): KnowledgePageSection {
  return { heading: section.heading, content: section.content, sourceSessionIds: section.sourceSessionIds };
}

function baselineOf(section: StoredKnowledgePageSection, pageSourcedThrough: string | null): string | null {
  return "sourcedThrough" in section ? (section.sourcedThrough ?? null) : pageSourcedThrough;
}

function serializeStoredSections(
  sections: readonly KnowledgePageSection[],
  baselines: readonly StoredKnowledgePageSection[],
): string {
  return JSON.stringify(
    sections.map((section, index) =>
      "sourcedThrough" in baselines[index]!
        ? { ...section, sourcedThrough: baselines[index]!.sourcedThrough }
        : section,
    ),
  );
}

function headingKey(heading: string): string {
  return heading.trim().toLowerCase();
}

/** Only the first section with a heading is matched. */
function mergeSections(
  current: readonly StoredKnowledgePageSection[],
  update: SectionUpdate,
  keep: (section: StoredKnowledgePageSection) => StoredKnowledgePageSection,
): SectionMerge {
  const upserts = new Map((update.upsertSections ?? []).map((section) => [headingKey(section.heading), section]));
  const removals = new Set((update.removeHeadings ?? []).map(headingKey));
  const matched = new Set<string>();
  const changes: KnowledgePageSectionChanges = { replaced: [], added: [], removed: [] };
  const sections: StoredKnowledgePageSection[] = [];
  for (const section of current) {
    const key = headingKey(section.heading);
    const firstMatch = !matched.has(key);
    const upsert = firstMatch ? upserts.get(key) : undefined;
    if (firstMatch && removals.has(key)) {
      matched.add(key);
      changes.removed.push(section.heading);
    } else if (upsert) {
      matched.add(key);
      sections.push(upsert);
      changes.replaced.push(upsert.heading);
    } else {
      sections.push(keep(section));
    }
  }
  const missingHeadings = (update.removeHeadings ?? []).filter((heading) => !matched.has(headingKey(heading)));
  if (missingHeadings.length > 0) return { missingHeadings };
  for (const [key, section] of upserts) {
    if (matched.has(key)) continue;
    sections.push(section);
    changes.added.push(section.heading);
  }
  return { sections, changes };
}

function emptyPageHint(row: PageRow, sections: readonly KnowledgePageSection[]): { emptyPageHint?: string } {
  if (DEFAULT_PAGES.has(row.slug) || row.update_requested_at) return {};
  if (sections.some((section) => section.content !== KNOWLEDGE_PAGE_INSUFFICIENT)) return {};
  return { emptyPageHint: EMPTY_CUSTOM_PAGE_HINT };
}

function nearLimitFields({ size, splitSuggestion }: KnowledgePageLimits) {
  return splitSuggestion ? { size, splitSuggestion } : {};
}

function pageLimitExceeded(sections: readonly KnowledgePageSection[]): SaveKnowledgePageResult | undefined {
  const { size, splitSuggestion } = knowledgePageLimits(sections);
  const { sectionCount, contentChars } = size;
  if (
    sectionCount >= 1 &&
    sectionCount <= KNOWLEDGE_PAGE_MAX_SECTIONS &&
    contentChars <= KNOWLEDGE_PAGE_MAX_CONTENT_CHARS
  ) {
    return undefined;
  }
  if (sectionCount === 0) {
    return {
      outcome: "page_limit_exceeded",
      reason: "The page after this update would have no sections, so nothing was written. Keep at least one section.",
      ...size,
    };
  }
  const problem =
    sectionCount > KNOWLEDGE_PAGE_MAX_SECTIONS
      ? `${sectionCount} sections (at most ${KNOWLEDGE_PAGE_MAX_SECTIONS})`
      : `${contentChars} characters of section content (at most ${KNOWLEDGE_PAGE_MAX_CONTENT_CHARS})`;
  return {
    outcome: "page_limit_exceeded",
    reason: `The page after this update would have ${problem}, so nothing was written. First remove what no longer answers the page question (finished items, facts later work overturned); if it still does not fit, ask the user to move sections to a custom page (splitSuggestion). Never shorten still-true text.`,
    ...size,
    ...(splitSuggestion ? { splitSuggestion } : {}),
  };
}

function versionConflict(
  baseVersion: number,
  currentVersion: number,
  retry?: KnowledgePageRetryMaterial,
): KnowledgePageVersionConflictResult {
  return {
    outcome: "version_conflict",
    reason:
      "The page was saved again after this edit started, so nothing was written. Read the current version and apply the change to it.",
    baseVersion,
    currentVersion,
    ...retry,
  };
}

const UNREAD_REVIEW_POINT_RESULT = {
  outcome: "invalid_review_token" as const,
  reason: "reviewToken does not point at a Session position this page can have been read at, so nothing was written.",
  fix: "Read the page again with work_get_knowledge_page_context and save with the reviewToken it returns, unchanged.",
};

function changedSectionHeadings(
  before: readonly KnowledgePageSection[],
  after: readonly KnowledgePageSection[],
): string[] {
  const firstByHeading = (sections: readonly KnowledgePageSection[]) => {
    const map = new Map<string, KnowledgePageSection>();
    for (const section of sections)
      if (!map.has(headingKey(section.heading))) map.set(headingKey(section.heading), section);
    return map;
  };
  const previous = firstByHeading(before);
  const current = firstByHeading(after);
  const fingerprint = (section: KnowledgePageSection) => JSON.stringify([section.content, section.sourceSessionIds]);
  const changed = [...current].filter(([key, section]) => {
    const old = previous.get(key);
    return !old || fingerprint(old) !== fingerprint(section);
  });
  const removed = [...previous].filter(([key]) => !current.has(key));
  return [...changed, ...removed].map(([, section]) => section.heading);
}

function droppedSourceWarnings(dropped: DroppedSourceSessionIds): string[] {
  if (dropped.length === 0) return [];
  return [
    `Kept the newest ${KNOWLEDGE_PAGE_SECTION_SOURCE_LIMIT} sourceSessionIds in ${dropped.length} section(s); the others are in droppedSourceSessionIds. Cite fewer, or move sources into another section.`,
  ];
}

function citedSessionIds(sections: readonly KnowledgePageSection[]): string[] {
  return [...new Set(sections.flatMap((section) => section.sourceSessionIds))];
}

export function limitKnowledgePageReviewSections(
  sections: readonly KnowledgePageReviewSection[],
  sourceLimit: number,
): KnowledgePageReviewSection[] {
  let remaining = Math.max(0, sourceLimit);
  const keptBySection = sections.map(() => 0);
  for (let index = 0; index < sections.length && remaining > 0; index += 1) {
    if (sections[index]!.sources.length > 0) {
      keptBySection[index] = 1;
      remaining -= 1;
    }
  }
  while (remaining > 0) {
    let added = false;
    for (let index = 0; index < sections.length && remaining > 0; index += 1) {
      if (keptBySection[index]! < sections[index]!.sources.length) {
        keptBySection[index] = keptBySection[index]! + 1;
        remaining -= 1;
        added = true;
      }
    }
    if (!added) break;
  }
  return sections.map((section, index) => {
    const sources = section.sources.slice(0, keptBySection[index]);
    const omittedSourceCount = (section.omittedSourceCount ?? 0) + section.sources.length - sources.length;
    const reasons = [...new Set([...(section.reasons ?? []), ...section.sources.flatMap((source) => source.reasons)])];
    return {
      heading: section.heading,
      sources,
      ...(omittedSourceCount > 0 ? { omittedSourceCount, reasons } : {}),
    };
  });
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

export function renderKnowledgePage(sections: readonly KnowledgePageSection[], includeSourceIds = true): string {
  return sections
    .map((section) => {
      const sources =
        includeSourceIds && section.sourceSessionIds.length > 0
          ? `\n\n來源：${section.sourceSessionIds.join("、")}`
          : "";
      return `## ${section.heading}\n\n${section.content}${sources}`;
    })
    .join("\n\n");
}

export class KnowledgePageService {
  private sharedRecords: Map<string, KnowledgePageRecord[]> | undefined;

  public constructor(
    private readonly db: DatabaseSync,
    private readonly dependencies: KnowledgePageDependencies,
  ) {}

  /** `read` must not write pages: the records are shared until it returns. */
  public withSharedReads<T>(read: () => T): T {
    if (this.sharedRecords) {
      return read();
    }
    this.sharedRecords = new Map();
    try {
      return read();
    } finally {
      this.sharedRecords = undefined;
    }
  }

  public attentionPages(projectId?: string): { items: KnowledgePageRecord[]; total: number } {
    const scope = projectId ? "AND p.id = ?" : "";
    const args = projectId ? [projectId] : [];
    const total = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM knowledge_pages k JOIN projects p ON p.id = k.project_id WHERE p.status = 'tracked' ${scope}`,
        )
        .get(...args) as { count: number }
    ).count;
    const rows = this.db
      .prepare(
        `SELECT k.* FROM knowledge_pages k JOIN projects p ON p.id = k.project_id WHERE p.status = 'tracked' ${scope} ORDER BY k.updated_at DESC, k.id DESC LIMIT 200`,
      )
      .all(...args) as PageRow[];
    return { items: this.toRecords(rows), total };
  }

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
    const rawTitle = input.title ?? existing?.title ?? fallback?.title;
    const rawQuestion = input.question ?? existing?.question ?? fallback?.question;
    if (!rawTitle || !rawQuestion) {
      return {
        outcome: "invalid_page",
        reason: "A page that is not one of the defaults needs a title and a question.",
      };
    }
    const redactedTitle = redactText(rawTitle);
    const redactedQuestion = redactText(rawQuestion);
    const title = redactedTitle.value;
    const question = redactedQuestion.value;
    const redactions = combineRedactionSummaries(redactedTitle.redactions, redactedQuestion.redactions);
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
    return {
      outcome: "knowledge_page_update_requested",
      page: this.recordFor(this.findPage(projectId, input.slug)!),
      ...(redactions.total > 0 ? { redactions } : {}),
    };
  }

  public getContext(query: KnowledgePageContextQuery): KnowledgePageContextResult {
    const decision = this.dependencies.checkProjectRoot(query.projectRoot);
    if (!decision.allowed || !decision.project) {
      return skipped(decision);
    }
    const row = this.findPage(decision.project.id, query.slug);
    if (!row) return this.pageNotFound(decision.project.id, query.slug);
    const page = this.recordFor(row);
    const limits = knowledgePageLimits(page.sections);
    const hint = emptyPageHint(row, page.sections);
    if (query.reviewOnly) {
      const seen = this.seenSessions(row, query.sessionsSeenIn, true);
      const context = this.reviewOnlyContext(row, page, limits.size, seen.ids);
      return {
        ...context,
        ...(seen.warning ? { warnings: [seen.warning] } : {}),
        ...(limits.splitSuggestion ? { splitSuggestion: limits.splitSuggestion } : {}),
        ...hint,
      };
    }
    if (query.query !== undefined || query.headings !== undefined) {
      const through = this.reviewedPoint(row);
      return {
        ...focusedContext(page, query, encodeReviewToken({ pageId: row.id, version: row.version, through })),
        ...(query.sessionsSeenIn !== undefined ? { warnings: [SESSIONS_SEEN_IN_FOCUSED_WARNING] } : {}),
        ...nearLimitFields(limits),
        ...hint,
      };
    }
    if (row.version === 0 || row.update_requested_at) {
      const sessions = this.contextSessions(decision.project.id);
      const seen = this.seenSessions(row, query.sessionsSeenIn, false);
      return {
        ...pageContext(row, page, "full", sessions, this.shownWindow(row.project_id, sessions.shownRows)),
        ...(seen.warning ? { warnings: [seen.warning] } : {}),
        ...nearLimitFields(limits),
        ...hint,
      };
    }
    const sources = this.reviewSources(row, page);
    const seen = this.seenSessions(row, query.sessionsSeenIn, true);
    const sessions = this.reviewSessions(sources, seen.ids);
    return {
      ...pageContext(row, page, "review", sessions, this.shownWindow(row.project_id, sessions.shownRows)),
      ...(seen.warning ? { warnings: [seen.warning] } : {}),
      ...nearLimitFields(limits),
      ...hint,
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
      .prepare(
        "SELECT version, sections_json, created_at FROM knowledge_page_versions WHERE page_id = ? AND idempotency_key = ?",
      )
      .get(row.id, input.idempotencyKey) as { version: number; sections_json: string; created_at: string } | undefined;
    if (duplicate) return this.replayedSave(row, duplicate, input);
    const token = input.reviewToken === undefined ? undefined : decodeReviewToken(input.reviewToken);
    if ((input.reviewToken !== undefined || input.sections === undefined) && token?.pageId !== row.id) {
      return {
        outcome: "invalid_review_token",
        reason:
          "reviewToken must be passed unchanged from work_get_knowledge_page_context for this page. Read the page again and save with its reviewToken.",
      };
    }
    const invalid = this.invalidSources(decision.project.id, input.sections ?? input.upsertSections ?? []);
    if (invalid.length > 0) {
      return {
        outcome: "invalid_sources",
        reason: "Every cited Session must belong to this project and must not be voided.",
        sessionIds: invalid,
      };
    }
    const limited = this.limitSourceIds(input);
    const trimmed = limited.input;
    if (trimmed.sections === undefined) return this.saveSectionUpdate(row, trimmed, token!, limited.dropped);
    const written = this.writeVersion(row, row.title, trimmed.sections, "agent", {
      idempotencyKey: input.idempotencyKey,
      ...(token ? { baseVersion: token.version, coverage: token.through } : { keepReviewedPoint: true }),
    });
    if ("refusal" in written) return written.refusal;
    const page = this.recordFor(this.findPageById(row.id)!);
    const warnings = [...(token ? [] : [MISSING_REVIEW_TOKEN_WARNING]), ...droppedSourceWarnings(limited.dropped)];
    return {
      outcome: "knowledge_page_saved",
      duplicate: false,
      page,
      ...(written.redactions.total > 0 ? { redactions: written.redactions } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(limited.dropped.length > 0 ? { droppedSourceSessionIds: limited.dropped } : {}),
      ...nearLimitFields(knowledgePageLimits(page.sections)),
    };
  }

  public markChecked(input: MarkKnowledgePageCheckedInput): MarkKnowledgePageCheckedResult {
    const decision = this.dependencies.checkProjectRoot(input.projectRoot);
    if (!decision.allowed || !decision.project) return skipped(decision);
    const initial = this.findPage(decision.project.id, input.slug);
    if (!initial) {
      return {
        outcome: "not_found",
        slug: input.slug,
        reason: "Request the page with work_request_knowledge_page_update first.",
      };
    }

    const refusal = runImmediateTransaction(this.db, () =>
      this.advanceChecked(initial.id, decision.project!.id, input.throughSessionId),
    );
    if (refusal) return refusal;
    return { outcome: "knowledge_page_checked", page: this.recordFor(this.findPageById(initial.id)!) };
  }

  /** Runs inside the finalize transaction. When other Sessions finished in between, nothing moves, so none is hidden. */
  public acknowledgeMaintenance(projectId: string, sessionId: string, slugs: readonly string[]): string[] {
    const acknowledged: string[] = [];
    const firstAfter = this.db.prepare(
      `SELECT id, completed_at FROM sessions
       WHERE project_id = ? AND voided_at IS NULL AND ${NOT_IN_PROGRESS}
         AND (completed_at > ? OR (completed_at = ? AND id > ?))
       ORDER BY completed_at ASC, id ASC LIMIT 1`,
    );
    const cursorOf = this.db.prepare("SELECT id, completed_at FROM sessions WHERE id = ?");
    const moveCursor = this.db.prepare("UPDATE knowledge_pages SET checked_through_session_id = ? WHERE id = ?");
    for (const slug of new Set(slugs)) {
      const row = this.findPage(projectId, slug);
      const coverage = row && row.version > 0 ? sessionCoverage(row) : undefined;
      if (!row || !coverage) continue;
      const checked = row.checked_through_session_id
        ? (cursorOf.get(row.checked_through_session_id) as { id: string; completed_at: string } | undefined)
        : undefined;
      const after = reviewedThrough(coverage, checked && { id: checked.id, completedAt: checked.completed_at });
      // A null id compares as unknown, so a coverage without a Session position keeps the strict time rule.
      const next = firstAfter.get(projectId, after.completedAt, after.completedAt, after.id ?? null) as
        { id: string } | undefined;
      if (next?.id !== sessionId) continue;
      moveCursor.run(sessionId, row.id);
      acknowledged.push(slug);
    }
    return acknowledged;
  }

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
    const written = this.writeVersion(row, input.title ?? row.title, input.sections, "web", {
      ...(input.baseVersion !== undefined ? { baseVersion: input.baseVersion } : {}),
    });
    if ("refusal" in written) return written.refusal;
    return {
      outcome: "knowledge_page_updated",
      page: this.recordFor(this.findPageById(row.id)!),
      ...(written.redactions.total > 0 ? { redactions: written.redactions } : {}),
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
    const versionCount = (
      this.db.prepare("SELECT COUNT(*) AS count FROM knowledge_page_versions WHERE page_id = ?").get(pageId) as {
        count: number;
      }
    ).count;
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
    return { outcome: "knowledge_page_versions", page, versions, versionCount, sources };
  }

  public digestsForProject(projectId: string): KnowledgePageDigest[] {
    let remaining = DIGEST_TOTAL_CHARS;
    let remainingReviewSources = DIGEST_REVIEW_SOURCE_LIMIT;
    const digests: KnowledgePageDigest[] = [];
    const pages = this.pagesForProjects([projectId]).filter((item) => item.version > 0);
    const sourceIdsByPage = new Map<string, { sourceSessionIds: string[]; omittedCount: number }>();
    let remainingSourceIds = DIGEST_SOURCE_SESSION_LIMIT;
    const sourceIdOrder = [...pages.filter((page) => page.needsReview), ...pages.filter((page) => !page.needsReview)];
    for (const page of sourceIdOrder) {
      const sourceSessionIds = citedSessionIds(page.sections);
      const included = sourceSessionIds.slice(0, remainingSourceIds);
      remainingSourceIds -= included.length;
      sourceIdsByPage.set(page.id, {
        sourceSessionIds: included,
        omittedCount: sourceSessionIds.length - included.length,
      });
    }
    for (const page of pages) {
      if (remaining <= 0) {
        break;
      }
      const rendered = renderKnowledgePage(page.sections, false);
      const limit = Math.min(DIGEST_PAGE_CHARS, remaining);
      const bounded = truncateAtSentenceBoundary(rendered, limit);
      const content = bounded.text;
      remaining -= content.length;
      const reviewSections = page.needsReview
        ? limitKnowledgePageReviewSections(page.reviewSections ?? [], remainingReviewSources)
        : undefined;
      remainingReviewSources -= reviewSections?.reduce((count, section) => count + section.sources.length, 0) ?? 0;
      const sourceIds = sourceIdsByPage.get(page.id)!;
      digests.push({
        slug: page.slug,
        title: page.title,
        status: page.status,
        newSessionCount: page.newSessionCount,
        updatedAt: page.updatedAt,
        content,
        sourceSessionIds: sourceIds.sourceSessionIds,
        ...(sourceIds.omittedCount > 0 ? { sourceSessionIdsOmittedCount: sourceIds.omittedCount } : {}),
        truncated: bounded.truncated,
        ...(page.needsReview ? { needsReview: true, reviewSections } : {}),
      });
    }
    return digests;
  }

  public pendingForProject(projectId?: string): Array<{
    slug: string;
    title: string;
    status: KnowledgePageRecord["status"];
    newSessionCount: number;
    updateRequested: boolean;
    needsReview?: boolean;
  }> {
    return this.pagesForProjects(projectId ? [projectId] : this.trackedProjectIds())
      .filter(
        (page) =>
          page.updateRequestedAt ||
          page.needsReview ||
          page.newSessionCount >= KNOWLEDGE_PAGE_MAINTENANCE_SESSION_THRESHOLD,
      )
      .sort((left, right) => {
        const priority = (page: KnowledgePageRecord) => (page.needsReview ? 0 : page.updateRequestedAt ? 1 : 2);
        return (
          priority(left) - priority(right) ||
          right.newSessionCount - left.newSessionCount ||
          left.slug.localeCompare(right.slug)
        );
      })
      .map((page) => ({
        slug: page.slug,
        title: page.title,
        status: page.status,
        newSessionCount: page.newSessionCount,
        updateRequested: Boolean(page.updateRequestedAt),
        ...(page.needsReview ? { needsReview: true } : {}),
      }));
  }

  public pagesCitingSessions(
    projectId: string,
    sessionIds: ReadonlySet<string>,
  ): Array<{ slug: string; title: string }> {
    if (sessionIds.size === 0) return [];
    const rows = this.db
      .prepare(
        "SELECT slug, title, sections_json FROM knowledge_pages WHERE project_id = ? AND version > 0 ORDER BY slug ASC",
      )
      .all(projectId) as Array<{ slug: string; title: string; sections_json: string }>;
    return rows
      .filter((row) => citedSessionIds(parseStoredSections(row.sections_json)).some((id) => sessionIds.has(id)))
      .map(({ slug, title }) => ({ slug, title }));
  }

  public maintenanceHintForProject(projectId: string): string | undefined {
    const pages = this.pendingForProject(projectId);
    if (pages.length === 0) return undefined;

    const entries = pages.map((page) => {
      const reasons = [
        ...(page.needsReview ? ["來源需要核對"] : []),
        ...(page.updateRequested ? ["已有更新請求"] : []),
        ...(page.newSessionCount >= KNOWLEDGE_PAGE_MAINTENANCE_SESSION_THRESHOLD
          ? [`${page.newSessionCount} 筆新 Session`]
          : []),
      ];
      return `${page.title.replace(/\s+/g, " ").trim()}（${reasons.join("、")}）`;
    });
    return `知識頁維護提示：請檢查${entries.join("、")}。`;
  }

  private trackedProjectIds(): string[] {
    return (
      this.db.prepare("SELECT id FROM projects WHERE status = 'tracked' ORDER BY name ASC").all() as Array<{
        id: string;
      }>
    ).map((row) => row.id);
  }

  private pageNotFound(projectId: string, slug: string): KnowledgePageNotFoundResult {
    const pages = this.db
      .prepare("SELECT id, slug FROM knowledge_pages WHERE project_id = ? ORDER BY slug")
      .all(projectId) as Array<{ id: string; slug: string }>;
    const listed = {
      existingSlugs: pages.slice(0, NOT_FOUND_SLUG_LIMIT).map((page) => page.slug),
      ...(pages.length > NOT_FOUND_SLUG_LIMIT
        ? { existingSlugsOmittedCount: pages.length - NOT_FOUND_SLUG_LIMIT }
        : {}),
    };
    if (ID_PATTERN.test(slug)) {
      const page = pages.find((candidate) => candidate.id === slug);
      return page
        ? {
            outcome: "not_found",
            slug,
            reasonCode: "page_id_as_slug",
            reason: `This is the id of page "${page.slug}", not a slug. Call again with slug "${page.slug}".`,
            suggestedSlug: page.slug,
            ...listed,
          }
        : {
            outcome: "not_found",
            slug,
            reasonCode: "slug_looks_like_id",
            reason: "This looks like an id, not a page slug. Call again with one of existingSlugs.",
            ...listed,
          };
    }
    const existing = new Set(pages.map((page) => page.slug));
    const requestFirst = "Request it with work_request_knowledge_page_update first.";
    if (DEFAULT_PAGES.has(slug)) {
      return {
        outcome: "not_found",
        slug,
        reasonCode: "page_not_requested",
        reason: `The default page "${slug}" has not been requested in this project yet. ${requestFirst}`,
        ...listed,
      };
    }
    const suggestedSlug = nearestSlug(slug, [
      ...pages.map((page) => page.slug),
      ...[...DEFAULT_PAGES.keys()].filter((candidate) => !existing.has(candidate)),
    ]);
    if (suggestedSlug) {
      return {
        outcome: "not_found",
        slug,
        reasonCode: "slug_near_match",
        reason: existing.has(suggestedSlug)
          ? `No page "${slug}" in this project. Did you mean "${suggestedSlug}"? Call again with that slug.`
          : `No page "${slug}" in this project. Did you mean the default page "${suggestedSlug}"? ${requestFirst}`,
        suggestedSlug,
        ...listed,
      };
    }
    return {
      outcome: "not_found",
      slug,
      reasonCode: "page_unknown",
      reason:
        "No page with this slug in this project. Call again with one of existingSlugs; request a new custom page " +
        "(slug, title, and question) only when the user asks for one.",
      ...listed,
    };
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

  private pagesForProjects(projectIds: readonly string[]): KnowledgePageRecord[] {
    if (projectIds.length === 0) {
      return [];
    }
    const key = JSON.stringify(projectIds);
    const shared = this.sharedRecords?.get(key);
    if (shared) {
      return shared;
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM knowledge_pages WHERE project_id IN (SELECT value FROM json_each(?))
         ORDER BY project_id, created_at ASC, slug ASC`,
      )
      .all(JSON.stringify(projectIds)) as PageRow[];
    const defaultOrder = new Map(KNOWLEDGE_PAGE_DEFAULTS.map((page, index) => [page.slug as string, index]));
    const records = this.toRecords(rows).sort(
      (left, right) =>
        left.projectId.localeCompare(right.projectId) ||
        (defaultOrder.get(left.slug) ?? defaultOrder.size) - (defaultOrder.get(right.slug) ?? defaultOrder.size),
    );
    this.sharedRecords?.set(key, records);
    return records;
  }

  private toRecords(rows: readonly PageRow[]): KnowledgePageRecord[] {
    const coverageByPage = new Map(rows.map((row) => [row.id, sessionCoverage(row)]));
    const cutoffsByProject = new Map<string, string>();
    for (const row of rows) {
      const coverage = coverageByPage.get(row.id);
      if (!coverage) continue;
      const current = cutoffsByProject.get(row.project_id);
      if (current === undefined || coverage.completedAt < current) {
        cutoffsByProject.set(row.project_id, coverage.completedAt);
      }
    }
    const completionsByProject = new Map<string, CompletedSessionCursor[]>();
    // Inclusive: a Session position covers only the ids up to its own among Sessions finished at the same time.
    const statement = this.db.prepare(
      `SELECT id, completed_at FROM sessions
       WHERE project_id = ? AND voided_at IS NULL AND ${NOT_IN_PROGRESS} AND completed_at >= ?
       ORDER BY completed_at ASC, id ASC`,
    );
    for (const [projectId, cutoff] of cutoffsByProject) {
      completionsByProject.set(
        projectId,
        (statement.all(projectId, cutoff) as Array<{ id: string; completed_at: string }>).map((row) => ({
          id: row.id,
          completedAt: row.completed_at,
        })),
      );
    }
    const checkedIds = [
      ...new Set(rows.flatMap((row) => (row.checked_through_session_id ? [row.checked_through_session_id] : []))),
    ];
    const checkedSessions = new Map<string, CompletedSessionCursor & { projectId: string }>();
    if (checkedIds.length > 0) {
      for (const session of this.db
        .prepare("SELECT id, project_id, completed_at FROM sessions WHERE id IN (SELECT value FROM json_each(?))")
        .all(JSON.stringify(checkedIds)) as Array<{ id: string; project_id: string; completed_at: string }>) {
        checkedSessions.set(session.id, {
          id: session.id,
          projectId: session.project_id,
          completedAt: session.completed_at,
        });
      }
    }
    const sectionsByPage = new Map(rows.map((row) => [row.id, parseStoredSections(row.sections_json)]));
    const citedIds = [...new Set([...sectionsByPage.values()].flatMap(citedSessionIds))];
    const citedSessions = new Map<string, CitedSessionRow>();
    const voidEvents = new Map<string, CitedSessionVoidEventRow[]>();
    if (citedIds.length > 0) {
      for (const source of this.db
        .prepare(
          `SELECT id, project_id, title, COALESCE(content_updated_at, updated_at) AS content_updated_at, voided_at FROM sessions
           WHERE id IN (SELECT value FROM json_each(?))`,
        )
        .all(JSON.stringify(citedIds)) as CitedSessionRow[]) {
        citedSessions.set(source.id, source);
      }
      for (const event of this.db
        .prepare(
          `SELECT target_id, action, occurred_at FROM void_audit
           WHERE target_type = 'session' AND target_id IN (SELECT value FROM json_each(?))
           ORDER BY occurred_at ASC, rowid ASC`,
        )
        .all(JSON.stringify(citedIds)) as CitedSessionVoidEventRow[]) {
        const events = voidEvents.get(event.target_id) ?? [];
        events.push(event);
        voidEvents.set(event.target_id, events);
      }
    }
    return rows.map((row) => {
      const completions = completionsByProject.get(row.project_id) ?? [];
      const coverage = coverageByPage.get(row.id);
      const sourceStart = !coverage
        ? completions.length
        : coverage.id === undefined
          ? firstCompletedAfter(completions, coverage.completedAt)
          : upperBoundCursor(completions, { completedAt: coverage.completedAt, id: coverage.id });
      const checked = row.checked_through_session_id ? checkedSessions.get(row.checked_through_session_id) : undefined;
      const checkedThrough = checked?.projectId === row.project_id ? checked : undefined;
      const checkedStart = checkedThrough ? upperBoundCursor(completions, checkedThrough) : 0;
      const newSessionCount = coverage ? Math.max(0, completions.length - Math.max(sourceStart, checkedStart)) : 0;
      const sections = sectionsByPage.get(row.id) ?? [];
      const reviewSections: KnowledgePageReviewSection[] = [];
      for (const section of sections) {
        const baseline = baselineOf(section, row.sourced_through);
        const sources = [...new Set(section.sourceSessionIds)].flatMap((sourceSessionId) => {
          const source = citedSessions.get(sourceSessionId);
          const reasons = new Set<KnowledgePageReviewReason>();
          if (!source || source.project_id !== row.project_id) {
            reasons.add("source_missing");
          } else {
            if (!baseline) {
              reasons.add("source_state_unknown");
            } else if (source.content_updated_at > baseline) {
              reasons.add("source_updated_after_save");
            }
            for (const event of voidEvents.get(sourceSessionId) ?? []) {
              if (!baseline || event.occurred_at > baseline) {
                reasons.add(event.action === "voided" ? "source_voided_after_save" : "source_restored_after_save");
              }
            }
            if (source.voided_at && (!baseline || source.voided_at > baseline)) {
              reasons.add("source_voided_after_save");
            }
          }
          return reasons.size > 0
            ? [
                {
                  sourceSessionId,
                  title: source?.project_id === row.project_id ? source.title : "來源無法存取",
                  reasons: [...reasons],
                },
              ]
            : [];
        });
        if (sources.length > 0) reviewSections.push({ heading: section.heading, sources });
      }
      const needsReview = reviewSections.length > 0;
      return {
        id: row.id,
        projectId: row.project_id,
        slug: row.slug,
        title: row.title,
        question: row.question,
        sections: sections.map(publicSection),
        version: row.version,
        status: row.version === 0 ? "empty" : newSessionCount > 0 ? "has_new_data" : "fresh",
        newSessionCount,
        ...(checkedThrough
          ? { checkedThrough: { sessionId: checkedThrough.id, completedAt: checkedThrough.completedAt } }
          : {}),
        ...(needsReview ? { needsReview: true, reviewSections } : {}),
        ...(row.last_author ? { lastAuthor: row.last_author } : {}),
        ...(row.sourced_through ? { sourcedThrough: row.sourced_through } : {}),
        ...(row.update_requested_at ? { updateRequestedAt: row.update_requested_at } : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }

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

  private replayedSave(
    row: PageRow,
    saved: { version: number; sections_json: string; created_at: string },
    saveInput: SaveKnowledgePageInput,
  ): SaveKnowledgePageResult {
    const { input, dropped } = this.reconcileSourceIds(
      saveInput,
      parseJson<KnowledgePageSection[]>(saved.sections_json, []),
      saved.created_at,
    );
    const replay = (sectionChanges?: KnowledgePageSectionChanges): SaveKnowledgePageResult => {
      const cursorKept =
        !sectionChanges ||
        input.checkedThroughSessionId === undefined ||
        this.replayChecked(row.id, row.project_id, input.checkedThroughSessionId);
      const page = this.recordFor(this.findPageById(row.id)!);
      const warnings = [
        ...(sectionChanges && input.checkedThroughSessionId === undefined && page.newSessionCount > 0
          ? [COVERAGE_NOT_ADVANCED_HINT]
          : []),
        ...(cursorKept ? [] : [CURSOR_NOT_ADVANCED_WARNING]),
        ...droppedSourceWarnings(dropped),
      ];
      return {
        outcome: "knowledge_page_saved",
        duplicate: true,
        page,
        ...(sectionChanges ? { sectionChanges } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(dropped.length > 0 ? { droppedSourceSessionIds: dropped } : {}),
        ...nearLimitFields(knowledgePageLimits(page.sections)),
      };
    };
    if (input.sections) {
      // Reusing the key for other content would silently drop that content.
      return saved.sections_json === JSON.stringify(storedSections(input.sections).value)
        ? replay()
        : IDEMPOTENCY_CONFLICT_RESULT;
    }
    const previous = this.db
      .prepare("SELECT sections_json FROM knowledge_page_versions WHERE page_id = ? AND version = ?")
      .get(row.id, saved.version - 1) as { sections_json: string } | undefined;
    const merged = mergeSections(
      parseJson<KnowledgePageSection[]>(previous?.sections_json ?? "[]", []),
      input,
      publicSection,
    );
    if ("missingHeadings" in merged || saved.sections_json !== JSON.stringify(storedSections(merged.sections).value)) {
      return IDEMPOTENCY_CONFLICT_RESULT;
    }
    return replay(merged.changes);
  }

  private saveSectionUpdate(
    row: PageRow,
    update: SectionUpdate & { idempotencyKey: string; checkedThroughSessionId?: string },
    token: ReviewTokenContent,
    dropped: DroppedSourceSessionIds,
  ) {
    const now = nowIso();
    const written = runImmediateTransaction(this.db, () => {
      const current = this.findPageById(row.id)!;
      if (current.version !== token.version) {
        return versionConflict(token.version, current.version, this.retryMaterial(current, token.version));
      }
      if (!this.isReadPoint(current, token.through)) return UNREAD_REVIEW_POINT_RESULT;
      const merged = mergeSections(parseStoredSections(current.sections_json), update, (section) => {
        const baseline = baselineOf(section, current.sourced_through);
        return baseline === now ? publicSection(section) : { ...publicSection(section), sourcedThrough: baseline };
      });
      if ("missingHeadings" in merged) {
        return {
          outcome: "section_not_found" as const,
          reason:
            "The page has no section with these headings, so nothing was written. Read the page and use its headings.",
          headings: merged.missingHeadings,
        };
      }
      const exceeded = pageLimitExceeded(merged.sections);
      if (exceeded) return exceeded;
      let checkedThroughId = current.checked_through_session_id;
      if (update.checkedThroughSessionId !== undefined) {
        const cursor = this.checkedCursor(current, current.project_id, update.checkedThroughSessionId);
        if ("outcome" in cursor) return cursor;
        checkedThroughId = cursor.id;
      }
      const redacted = storedSections(merged.sections);
      const version = current.version + 1;
      this.insertVersion(
        current,
        version,
        current.title,
        JSON.stringify(redacted.value),
        "agent",
        update.idempotencyKey,
        now,
      );
      const coverage = sessionCoverage(current) ?? { completedAt: "" };
      this.db
        .prepare(
          `UPDATE knowledge_pages
           SET sections_json = ?, version = ?, sourced_through = ?, last_author = 'agent', updated_at = ?,
               covered_through_completed_at = ?, covered_through_session_id = ?, checked_through_session_id = ?
           WHERE id = ?`,
        )
        .run(
          serializeStoredSections(redacted.value, merged.sections),
          version,
          now,
          now,
          coverage.completedAt,
          coverage.id ?? null,
          checkedThroughId,
          current.id,
        );
      return { changes: merged.changes, redactions: redacted.redactions };
    });
    if ("outcome" in written) return written;
    const page = this.recordFor(this.findPageById(row.id)!);
    const warnings = [
      ...(update.checkedThroughSessionId === undefined && page.newSessionCount > 0 ? [COVERAGE_NOT_ADVANCED_HINT] : []),
      ...droppedSourceWarnings(dropped),
    ];
    return {
      outcome: "knowledge_page_saved" as const,
      duplicate: false,
      page,
      sectionChanges: written.changes,
      ...(written.redactions.total > 0 ? { redactions: written.redactions } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(dropped.length > 0 ? { droppedSourceSessionIds: dropped } : {}),
      ...nearLimitFields(knowledgePageLimits(page.sections)),
    };
  }

  private replayChecked(pageId: string, projectId: string, throughSessionId: string): boolean {
    return runImmediateTransaction(this.db, () => {
      const position = this.db.prepare("SELECT id, completed_at FROM sessions WHERE id = ?");
      const held = this.findPageById(pageId)!.checked_through_session_id;
      const heldRow = held ? (position.get(held) as { id: string; completed_at: string } | undefined) : undefined;
      const target = position.get(throughSessionId) as { id: string; completed_at: string } | undefined;
      if (
        heldRow &&
        target &&
        compareCursor(
          { id: heldRow.id, completedAt: heldRow.completed_at },
          { id: target.id, completedAt: target.completed_at },
        ) >= 0
      ) {
        return true;
      }
      return this.advanceChecked(pageId, projectId, throughSessionId) === undefined;
    });
  }

  private advanceChecked(pageId: string, projectId: string, throughSessionId: string): InvalidCursorResult | undefined {
    const cursor = this.checkedCursor(this.findPageById(pageId)!, projectId, throughSessionId);
    if ("outcome" in cursor) return cursor;
    this.db.prepare("UPDATE knowledge_pages SET checked_through_session_id = ? WHERE id = ?").run(cursor.id, pageId);
    return undefined;
  }

  private checkedCursor(
    row: PageRow,
    projectId: string,
    throughSessionId: string,
  ): CompletedSessionCursor | InvalidCursorResult {
    const cursor = this.db
      .prepare(
        `SELECT id, completed_at FROM sessions WHERE id = ? AND project_id = ? AND voided_at IS NULL AND ${NOT_IN_PROGRESS}`,
      )
      .get(throughSessionId, projectId) as { id: string; completed_at: string } | undefined;
    if (!cursor) {
      return {
        outcome: "invalid_cursor",
        reason: "throughSessionId must identify a non-voided, finished Session in this project.",
      };
    }
    const next = { id: cursor.id, completedAt: cursor.completed_at };
    if (row.checked_through_session_id && row.checked_through_session_id !== cursor.id) {
      const previous = this.db
        .prepare("SELECT id, completed_at FROM sessions WHERE id = ?")
        .get(row.checked_through_session_id) as { id: string; completed_at: string } | undefined;
      if (previous && compareCursor(next, { id: previous.id, completedAt: previous.completed_at }) < 0) {
        return { outcome: "invalid_cursor", reason: "The review cursor cannot move backwards." };
      }
    }
    return next;
  }

  private limitSourceIds<T extends { sections?: KnowledgePageSection[]; upsertSections?: KnowledgePageSection[] }>(
    input: T,
  ): { input: T; dropped: DroppedSourceSessionIds } {
    const oversized = [...(input.sections ?? []), ...(input.upsertSections ?? [])].flatMap((section) => [
      ...new Set(section.sourceSessionIds.length > KNOWLEDGE_PAGE_SECTION_SOURCE_LIMIT ? section.sourceSessionIds : []),
    ]);
    if (oversized.length === 0) return { input, dropped: [] };
    const compareAge = this.sourceRanking(oversized);
    const dropped: DroppedSourceSessionIds = [];
    const limit = (sections: KnowledgePageSection[] | undefined) =>
      sections?.map((section) => {
        const unique = [...new Set(section.sourceSessionIds)];
        if (unique.length <= KNOWLEDGE_PAGE_SECTION_SOURCE_LIMIT) return section;
        const newest = new Set(
          [...unique].sort((left, right) => compareAge(right, left)).slice(0, KNOWLEDGE_PAGE_SECTION_SOURCE_LIMIT),
        );
        dropped.push({ heading: section.heading, sessionIds: unique.filter((id) => !newest.has(id)) });
        return { ...section, sourceSessionIds: unique.filter((id) => newest.has(id)) };
      });
    const sections = limit(input.sections);
    const upsertSections = limit(input.upsertSections);
    return {
      input: { ...input, ...(sections ? { sections } : {}), ...(upsertSections ? { upsertSections } : {}) },
      dropped,
    };
  }

  private sourceRanking(ids: readonly string[], savedAt?: string): (left: string, right: string) => number {
    const completedAt = new Map(
      (
        this.db
          .prepare(
            `SELECT id, completed_at, created_at, NOT (${NOT_IN_PROGRESS}) AS in_progress FROM sessions
             WHERE id IN (SELECT value FROM json_each(?))`,
          )
          .all(JSON.stringify(ids)) as Array<{
          id: string;
          completed_at: string;
          created_at: string;
          in_progress: number;
        }>
      ).map((session) => {
        const finishedAfterSave =
          savedAt !== undefined && session.created_at <= savedAt && session.completed_at > savedAt;
        return [session.id, session.in_progress || finishedAfterSave ? "" : session.completed_at];
      }),
    );
    return (left, right) =>
      (completedAt.get(left) ?? "").localeCompare(completedAt.get(right) ?? "") || left.localeCompare(right);
  }

  private reconcileSourceIds<T extends { sections?: KnowledgePageSection[]; upsertSections?: KnowledgePageSection[] }>(
    input: T,
    stored: readonly KnowledgePageSection[],
    savedAt: string,
  ): { input: T; dropped: DroppedSourceSessionIds } {
    const keptByHeading = new Map<string, readonly string[]>();
    for (const section of stored) {
      if (!keptByHeading.has(headingKey(section.heading))) {
        keptByHeading.set(headingKey(section.heading), section.sourceSessionIds);
      }
    }
    const all = [...(input.sections ?? []), ...(input.upsertSections ?? [])].flatMap(
      (section) => section.sourceSessionIds,
    );
    const compareAge = this.sourceRanking([...new Set(all)], savedAt);
    const dropped: DroppedSourceSessionIds = [];
    const reconcile = (sections: KnowledgePageSection[] | undefined) =>
      sections?.map((section) => {
        const unique = [...new Set(section.sourceSessionIds)];
        if (unique.length <= KNOWLEDGE_PAGE_SECTION_SOURCE_LIMIT) return section;
        const kept = new Set(keptByHeading.get(headingKey(section.heading)));
        const extras = unique.filter((id) => !kept.has(id));
        const oldestKept = [...kept].sort(compareAge)[0];
        const unchanged =
          kept.size === KNOWLEDGE_PAGE_SECTION_SOURCE_LIMIT &&
          [...kept].every((id) => unique.includes(id)) &&
          extras.every((id) => compareAge(id, oldestKept!) < 0);
        if (!unchanged) return { ...section, sourceSessionIds: unique };
        dropped.push({ heading: section.heading, sessionIds: extras });
        return { ...section, sourceSessionIds: unique.filter((id) => kept.has(id)) };
      });
    const sections = reconcile(input.sections);
    const upsertSections = reconcile(input.upsertSections);
    return {
      input: { ...input, ...(sections ? { sections } : {}), ...(upsertSections ? { upsertSections } : {}) },
      dropped,
    };
  }

  private retryMaterial(current: PageRow, staleVersion: number): KnowledgePageRetryMaterial {
    const reviewToken = encodeReviewToken({
      pageId: current.id,
      version: current.version,
      through: this.reviewedPoint(current),
    });
    const changedHeadings =
      staleVersion < current.version ? this.headingsChangedSince(current, staleVersion) : undefined;
    return { reviewToken, ...(changedHeadings ? { changedHeadings } : {}) };
  }

  private headingsChangedSince(current: PageRow, version: number): string[] | undefined {
    const earlier =
      version === 0
        ? "[]"
        : (
            this.db
              .prepare("SELECT sections_json FROM knowledge_page_versions WHERE page_id = ? AND version = ?")
              .get(current.id, version) as { sections_json: string } | undefined
          )?.sections_json;
    if (earlier === undefined) return undefined;
    return changedSectionHeadings(
      parseJson<KnowledgePageSection[]>(earlier, []),
      parseStoredSections(current.sections_json).map(publicSection),
    );
  }

  private insertVersion(
    page: PageRow,
    version: number,
    title: string,
    sectionsJson: string,
    author: KnowledgePageAuthor,
    idempotencyKey: string | undefined,
    createdAt: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO knowledge_page_versions
           (id, page_id, project_id, version, title, question, sections_json, author, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        page.id,
        page.project_id,
        version,
        title,
        page.question,
        sectionsJson,
        author,
        idempotencyKey ?? null,
        createdAt,
      );
  }

  /** Call it in the write transaction, after the version check. */
  private isReadPoint(row: PageRow, through: CoveragePoint): boolean {
    if (through.completedAt === "" && through.id === undefined) return true;
    const saved = sessionCoverage(row);
    if (saved && sameCoverage(saved, through)) return true;
    if (through.id === undefined) return false;
    return (
      this.db
        .prepare("SELECT 1 FROM sessions WHERE id = ? AND project_id = ? AND completed_at = ? AND voided_at IS NULL")
        .get(through.id, row.project_id, through.completedAt) !== undefined
    );
  }

  private reviewedPoint(row: PageRow): CoveragePoint {
    const checked = row.checked_through_session_id
      ? (this.db.prepare("SELECT id, completed_at FROM sessions WHERE id = ?").get(row.checked_through_session_id) as
          { id: string; completed_at: string } | undefined)
      : undefined;
    return reviewedThrough(
      sessionCoverage(row) ?? { completedAt: "" },
      checked && { id: checked.id, completedAt: checked.completed_at },
    );
  }

  private writeVersion(
    row: PageRow,
    title: string,
    sections: readonly KnowledgePageSection[],
    author: KnowledgePageAuthor,
    options: { idempotencyKey?: string; baseVersion?: number; coverage?: undefined; keepReviewedPoint?: undefined },
  ): WrittenVersion<KnowledgePageVersionConflictResult>;
  private writeVersion(
    row: PageRow,
    title: string,
    sections: readonly KnowledgePageSection[],
    author: KnowledgePageAuthor,
    options: { idempotencyKey?: string; baseVersion?: number; coverage?: CoveragePoint; keepReviewedPoint?: boolean },
  ): WrittenVersion<KnowledgePageVersionConflictResult | typeof UNREAD_REVIEW_POINT_RESULT>;
  private writeVersion(
    row: PageRow,
    title: string,
    sections: readonly KnowledgePageSection[],
    author: KnowledgePageAuthor,
    options: { idempotencyKey?: string; baseVersion?: number; coverage?: CoveragePoint; keepReviewedPoint?: boolean },
  ): WrittenVersion<KnowledgePageVersionConflictResult | typeof UNREAD_REVIEW_POINT_RESULT> {
    const redactedTitle = redactText(title);
    const redactedSections = storedSections(sections);
    const now = nowIso();
    const refusal = runImmediateTransaction(
      this.db,
      (): KnowledgePageVersionConflictResult | typeof UNREAD_REVIEW_POINT_RESULT | undefined => {
        const current = this.findPageById(row.id)!;
        if (options.baseVersion !== undefined && current.version !== options.baseVersion) {
          return versionConflict(
            options.baseVersion,
            current.version,
            options.coverage ? this.retryMaterial(current, options.baseVersion) : undefined,
          );
        }
        if (options.coverage && !this.isReadPoint(current, options.coverage)) return UNREAD_REVIEW_POINT_RESULT;
        const reviewed = options.coverage || options.keepReviewedPoint ? this.reviewedPoint(current) : undefined;
        const coverage = options.coverage && reviewed ? laterCoverage(options.coverage, reviewed) : reviewed;
        const version = current.version + 1;
        const sectionsJson = JSON.stringify(redactedSections.value);
        this.insertVersion(current, version, redactedTitle.value, sectionsJson, author, options.idempotencyKey, now);
        // sourced_through stays the save time: cited sources changed after it still need review.
        this.db
          .prepare(
            `UPDATE knowledge_pages
           SET title = ?, sections_json = ?, version = ?, sourced_through = ?, update_requested_at = NULL,
               last_author = ?, updated_at = ?, checked_through_session_id = NULL,
               covered_through_completed_at = ?, covered_through_session_id = ?
           WHERE id = ?`,
          )
          .run(
            redactedTitle.value,
            sectionsJson,
            version,
            now,
            author,
            now,
            coverage?.completedAt ?? null,
            coverage?.id ?? null,
            row.id,
          );
        return undefined;
      },
    );
    if (refusal) return { refusal };
    return { redactions: combineRedactionSummaries(redactedTitle.redactions, redactedSections.redactions) };
  }

  private seenSessions(
    row: PageRow,
    token: string | undefined,
    stubbing: boolean,
  ): { ids: ReadonlySet<string>; warning?: string } {
    const none = new Set<string>();
    if (token === undefined) return { ids: none };
    const content = decodeReviewToken(token);
    if (!content || this.findPageById(content.pageId)?.project_id !== row.project_id) {
      return { ids: none, warning: SESSIONS_SEEN_IN_INVALID_WARNING };
    }
    if (!stubbing) return { ids: none };
    const { window } = content;
    if (!window) return { ids: none, warning: SESSIONS_SEEN_IN_WITHOUT_WINDOW_WARNING };
    const rows = this.windowRows(row.project_id, window.fromId, window.count);
    const seen = rows.filter((_, index) => (BigInt(`0x${window.mask}`) >> BigInt(index)) & 1n);
    if (rows[0]?.id !== window.fromId || rows.length !== window.count || previewsDigest(seen) !== window.digest) {
      return { ids: none, warning: SESSIONS_SEEN_IN_STALE_WARNING };
    }
    return { ids: new Set(seen.map((session) => session.id)) };
  }

  private windowRows(projectId: string, fromId: string, limit: number): ContextSessionRow[] {
    const from = this.db
      .prepare("SELECT completed_at FROM sessions WHERE id = ? AND project_id = ?")
      .get(fromId, projectId) as { completed_at: string } | undefined;
    if (!from) return [];
    return this.db
      .prepare(
        `SELECT id, title, completed_at, work_summary_json FROM sessions
         WHERE project_id = ? AND voided_at IS NULL AND ${NOT_IN_PROGRESS}
           AND (completed_at > ? OR (completed_at = ? AND id >= ?))
         ORDER BY completed_at ASC, id ASC
         LIMIT ?`,
      )
      .all(projectId, from.completed_at, from.completed_at, fromId, limit) as ContextSessionRow[];
  }

  /** `shown` is the Sessions whose previews the read returned, oldest first. */
  private shownWindow(projectId: string, shown: readonly ContextSessionRow[]): ShownWindow | undefined {
    const first = shown[0];
    const last = shown.at(-1);
    if (!first || !last) return undefined;
    const rows = this.windowRows(projectId, first.id, CONTEXT_SESSION_LIMIT);
    const count = rows.findIndex((session) => session.id === last.id) + 1;
    if (count === 0 || rows[0]?.id !== first.id) return undefined;
    const shownIds = new Set(shown.map((session) => session.id));
    const flags = rows.slice(0, count).map((session) => shownIds.has(session.id));
    if (flags.filter(Boolean).length !== shownIds.size) return undefined;
    const mask = flags.reduce((bits, flag, index) => (flag ? bits | (1n << BigInt(index)) : bits), 0n);
    return {
      fromId: first.id,
      count,
      mask: mask.toString(16),
      digest: previewsDigest(rows.filter((_, index) => flags[index])),
    };
  }

  private contextSessions(projectId: string): ContextSessions {
    const rows = this.db
      .prepare(
        `SELECT id, title, completed_at, work_summary_json FROM sessions
         WHERE project_id = ? AND voided_at IS NULL AND ${NOT_IN_PROGRESS}
         ORDER BY completed_at DESC, id DESC
         LIMIT ?`,
      )
      .all(projectId, CONTEXT_SESSION_LIMIT + 1) as ContextSessionRow[];
    const budgeted = this.budgetSessions(
      rows.slice(0, CONTEXT_SESSION_LIMIT).map((row) => ({ row })),
      rows.length > CONTEXT_SESSION_LIMIT,
    );
    const newest = budgeted.shown[0]?.row;
    return {
      sessions: budgeted.sessions,
      truncated: budgeted.truncated,
      through: newest ? { completedAt: newest.completed_at, id: newest.id } : { completedAt: "" },
      shownRows: budgeted.shown.map(({ row }) => row).reverse(),
    };
  }

  private budgetSessions(
    entries: readonly ContextSessionEntry[],
    alreadyTruncated: boolean,
    seen: ReadonlySet<string> = new Set(),
  ): BudgetedSessions {
    let truncated = alreadyTruncated;
    let stubbed = false;
    let budget = CONTEXT_CHAR_BUDGET;
    const sessions: ContextSessionItem[] = [];
    const shown: ContextSessionEntry[] = [];
    for (const entry of entries) {
      const { row, reasons } = entry;
      const session = previewOrStub(row, reasons, seen);
      const isStub = "previewSeen" in session;
      const size = JSON.stringify(session).length;
      if (size > budget) {
        truncated = true;
        break;
      }
      budget -= size;
      sessions.push(session);
      shown.push(entry);
      stubbed ||= isStub;
    }
    return { sessions, shown, stubbed, truncated };
  }

  private reviewSessions({ after, newRows, changedRows }: ReviewSources, seen?: ReadonlySet<string>): ContextSessions {
    const shownNew = newRows.slice(0, CONTEXT_SESSION_LIMIT);
    const shownNewIds = new Set(shownNew.map((session) => session.id));
    const changedIds = new Set(changedRows.map((session) => session.id));
    const budgeted = this.budgetSessions(
      [
        ...changedRows
          .filter((session) => !shownNewIds.has(session.id))
          .map((session): ContextSessionEntry => ({ row: session, reasons: ["source_changed"] })),
        ...shownNew.map((session): ContextSessionEntry => ({
          row: session,
          reasons: changedIds.has(session.id) ? ["new", "source_changed"] : ["new"],
        })),
      ],
      newRows.length > CONTEXT_SESSION_LIMIT,
      seen,
    );
    // New Sessions come last, oldest first, and the budget keeps a prefix, so the last one shown is the coverage.
    const budgetedNew = budgeted.shown.filter(({ reasons }) => reasons?.includes("new")).map(({ row }) => row);
    const last = budgetedNew.at(-1);
    return {
      sessions: budgeted.sessions,
      truncated: budgeted.truncated,
      through: last ? { completedAt: last.completed_at, id: last.id } : after,
      shownRows: budgeted.stubbed ? [] : budgetedNew,
    };
  }

  private reviewOnlyContext(
    row: PageRow,
    page: KnowledgePageRecord,
    size: KnowledgePageSize,
    seen: ReadonlySet<string>,
  ): KnowledgePageReviewContext {
    const sources = this.reviewSources(row, page);
    const { after, newRows, changedRows } = sources;
    const base: Pick<
      KnowledgePageReviewContext,
      | "outcome"
      | "reviewOnly"
      | "page"
      | "size"
      | "omittedSessionFields"
      | "sessionReadWith"
      | "reviewToken"
      | "readFullWith"
    > = {
      outcome: "knowledge_page_context",
      reviewOnly: true,
      page: pageSummary(page),
      size,
      omittedSessionFields: ["summary", "workSummary.scope", "workSummary.verification"],
      sessionReadWith: "work_get_session",
      reviewToken: encodeReviewToken({ pageId: row.id, version: row.version, through: after }),
      readFullWith: "work_get_knowledge_page_context without reviewOnly (the whole page and every new Session)",
    };
    const layout = page.sections.map((section) => ({ heading: section.heading, chars: section.content.length }));
    if (row.version === 0 || row.update_requested_at) {
      return {
        ...base,
        review: "full_rewrite",
        sections: [],
        otherSections: layout,
        sessions: [],
        unmappedSessions: [],
        truncated: false,
      };
    }
    const changedByHeading = new Map((page.reviewSections ?? []).map((section) => [section.heading, section]));
    const consideredNew = newRows.slice(0, CONTEXT_SESSION_LIMIT);
    const consideredNewIds = new Set(consideredNew.map((session) => session.id));
    const changedIds = new Set(changedRows.map((session) => session.id));
    const mapped = this.newSessionSections(row.project_id, page.sections, consideredNew);

    let truncated = false;
    let budget = CONTEXT_CHAR_BUDGET;
    let unmappedBudget = UNMAPPED_SESSION_CHAR_BUDGET;
    const sessions: ContextSessionItem[] = [];
    const shownNewRows: ContextSessionRow[] = [];
    let stubbed = false;
    const unmappedSessions: KnowledgePageReviewContext["unmappedSessions"] = [];
    for (const session of changedRows) {
      if (consideredNewIds.has(session.id)) continue;
      const preview = sessionPreview(session, ["source_changed"]);
      const size = JSON.stringify(preview).length;
      if (size > budget) {
        truncated = true;
        break;
      }
      budget -= size;
      sessions.push(preview);
    }
    const accountedNew: ContextSessionRow[] = [];
    if (!truncated) {
      for (const session of consideredNew) {
        if (mapped.has(session.id) || changedIds.has(session.id)) {
          const preview = previewOrStub(
            session,
            changedIds.has(session.id) ? ["new", "source_changed"] : ["new"],
            seen,
          );
          const size = JSON.stringify(preview).length;
          if (size > budget) break;
          budget -= size;
          sessions.push(preview);
          if ("previewSeen" in preview) stubbed = true;
          else shownNewRows.push(session);
        } else {
          const listed = { id: session.id, title: session.title, completedAt: session.completed_at };
          const size = JSON.stringify(listed).length;
          if (size > unmappedBudget) break;
          unmappedBudget -= size;
          unmappedSessions.push(listed);
        }
        accountedNew.push(session);
      }
      truncated = accountedNew.length < newRows.length;
    }

    const newBySection = new Map<number, { ids: string[]; reasons: Set<KnowledgePageSectionReviewReason> }>();
    for (const session of accountedNew) {
      for (const [index, reasons] of mapped.get(session.id) ?? []) {
        const entry = newBySection.get(index) ?? { ids: [], reasons: new Set() };
        entry.ids.push(session.id);
        for (const reason of reasons) entry.reasons.add(reason);
        newBySection.set(index, entry);
      }
    }
    const sections: KnowledgePageReviewContext["sections"] = [];
    const otherSections: KnowledgePageReviewContext["otherSections"] = [];
    page.sections.forEach((section, index) => {
      const changed = changedByHeading.get(section.heading);
      const mappedNew = newBySection.get(index);
      if (!changed && !mappedNew) {
        otherSections.push(layout[index]!);
        return;
      }
      const reasons = new Set<KnowledgePageSectionReviewReason>(changed?.sources.flatMap((source) => source.reasons));
      for (const reason of mappedNew?.reasons ?? []) reasons.add(reason);
      sections.push({
        heading: section.heading,
        content: section.content,
        sourceSessionIds: section.sourceSessionIds,
        reasons: [...reasons],
        ...(changed
          ? {
              changedSources: changed.sources.map((source) => ({
                sourceSessionId: source.sourceSessionId,
                reasons: source.reasons,
              })),
            }
          : {}),
        ...(mappedNew ? { newSessionIds: mappedNew.ids } : {}),
      });
    });
    const lastAccounted = accountedNew.at(-1);
    const result: KnowledgePageReviewContext = {
      ...base,
      review: sections.length > 0 ? "sections" : unmappedSessions.length > 0 ? "new_sessions" : "none",
      sections,
      otherSections,
      sessions,
      unmappedSessions,
      ...(lastAccounted ? { checkedThroughCandidate: lastAccounted.id } : {}),
      truncated,
    };
    const sectionChars = sections.reduce((total, section) => total + section.content.length, 0);
    const useFullRead =
      sections.length > Math.max(1, page.sections.length / 2) ||
      sectionChars > REVIEW_SECTION_CONTENT_BUDGET ||
      JSON.stringify(result).length >=
        JSON.stringify(pageContext(row, page, "review", this.reviewSessions(sources, seen))).length;
    if (!useFullRead) {
      const window = stubbed ? undefined : this.shownWindow(row.project_id, shownNewRows);
      if (!window) return result;
      return {
        ...result,
        reviewToken: encodeReviewToken({ pageId: row.id, version: row.version, through: after, window }),
      };
    }
    return {
      ...base,
      review: "use_full_read",
      sections: [],
      otherSections: layout,
      sessions: [],
      unmappedSessions: [],
      truncated: false,
    };
  }

  private reviewSources(row: PageRow, page: KnowledgePageRecord): ReviewSources {
    const after = this.reviewedPoint(row);
    return {
      after,
      newRows: this.newSessionRows(row.project_id, after),
      changedRows: this.changedSourceRows(row.project_id, page),
    };
  }

  private newSessionRows(projectId: string, after: CoveragePoint): ContextSessionRow[] {
    return this.db
      .prepare(
        `SELECT id, title, completed_at, work_summary_json FROM sessions
         WHERE project_id = ? AND voided_at IS NULL AND ${NOT_IN_PROGRESS}
           AND (completed_at > ? OR (completed_at = ? AND id > ?))
         ORDER BY completed_at ASC, id ASC
         LIMIT ?`,
      )
      .all(
        projectId,
        after.completedAt,
        after.completedAt,
        // A null id compares as unknown, so a coverage without a Session position keeps the strict time rule.
        after.id ?? null,
        CONTEXT_SESSION_LIMIT + 1,
      ) as ContextSessionRow[];
  }

  private changedSourceRows(projectId: string, page: KnowledgePageRecord): ContextSessionRow[] {
    const changedIds = [
      ...new Set(
        (page.reviewSections ?? []).flatMap((section) => section.sources.map((source) => source.sourceSessionId)),
      ),
    ];
    if (changedIds.length === 0) return [];
    return this.db
      .prepare(
        `SELECT id, title, completed_at, work_summary_json FROM sessions
         WHERE project_id = ? AND id IN (SELECT value FROM json_each(?))
         ORDER BY completed_at ASC, id ASC`,
      )
      .all(projectId, JSON.stringify(changedIds)) as ContextSessionRow[];
  }

  private newSessionSections(
    projectId: string,
    sections: readonly KnowledgePageSection[],
    newRows: readonly ContextSessionRow[],
  ): NewSessionSections {
    const result: NewSessionSections = new Map();
    const sectionsByCited = new Map<string, number[]>();
    sections.forEach((section, index) => {
      for (const id of new Set(section.sourceSessionIds)) {
        const indexes = sectionsByCited.get(id) ?? [];
        indexes.push(index);
        sectionsByCited.set(id, indexes);
      }
    });
    if (sectionsByCited.size === 0 || newRows.length === 0) return result;
    const newIds = JSON.stringify(newRows.map((session) => session.id));
    const citedIds = JSON.stringify([...sectionsByCited.keys()]);
    const linksByNew = new Map<string, string[]>();
    for (const link of this.db
      .prepare(
        `SELECT session_id AS new_id, related_session_id AS cited_id FROM session_links
         WHERE session_id IN (SELECT value FROM json_each(?)) AND related_session_id IN (SELECT value FROM json_each(?))
         UNION
         SELECT related_session_id, session_id FROM session_links
         WHERE related_session_id IN (SELECT value FROM json_each(?)) AND session_id IN (SELECT value FROM json_each(?))`,
      )
      .all(newIds, citedIds, newIds, citedIds) as Array<{ new_id: string; cited_id: string }>) {
      const linked = linksByNew.get(link.new_id) ?? [];
      linked.push(link.cited_id);
      linksByNew.set(link.new_id, linked);
    }
    const files = this.db
      .prepare(
        `SELECT id, changed_files_json FROM sessions
         WHERE project_id = ? AND id IN (SELECT value FROM json_each(?) UNION SELECT value FROM json_each(?))`,
      )
      .all(projectId, newIds, citedIds) as Array<{ id: string; changed_files_json: string }>;
    const filesById = new Map(
      files.map((session) => [session.id, new Set(parseChangedFiles(session.changed_files_json))]),
    );
    const sectionsByFile = new Map<string, Map<number, string[]>>();
    for (const [citedId, indexes] of sectionsByCited) {
      for (const file of filesById.get(citedId) ?? []) {
        const bySection = sectionsByFile.get(file) ?? new Map<number, string[]>();
        for (const index of indexes) {
          const citing = bySection.get(index);
          if (citing) citing.push(citedId);
          else bySection.set(index, [citedId]);
        }
        sectionsByFile.set(file, bySection);
      }
    }
    for (const session of newRows) {
      const own = new Set(sectionsByCited.get(session.id));
      const scores = new Map<number, { score: number; reasons: Set<KnowledgePageSectionReviewReason> }>();
      const credit = (indexes: readonly number[], weight: number, reason: KnowledgePageSectionReviewReason) => {
        if (indexes.length === 0 || indexes.length > MAX_EVIDENCE_SECTIONS) return;
        for (const index of indexes) {
          const entry = scores.get(index) ?? { score: 0, reasons: new Set() };
          entry.score += weight / indexes.length;
          entry.reasons.add(reason);
          scores.set(index, entry);
        }
      };
      for (const citedId of linksByNew.get(session.id) ?? []) {
        credit(sectionsByCited.get(citedId) ?? [], LINK_EVIDENCE_WEIGHT, "new_session_linked");
      }
      for (const file of filesById.get(session.id) ?? []) {
        const bySection = sectionsByFile.get(file);
        if (!bySection) continue;
        const indexes: number[] = [];
        for (const [index, citing] of bySection) if (citing.some((id) => id !== session.id)) indexes.push(index);
        credit(indexes, FILE_EVIDENCE_WEIGHT, "new_session_shared_files");
      }
      const best = [...scores]
        .filter(([index, entry]) => entry.score >= MIN_SECTION_SCORE && !own.has(index))
        .sort(([leftIndex, left], [rightIndex, right]) => right.score - left.score || leftIndex - rightIndex)
        .slice(0, MAX_SECTIONS_PER_NEW_SESSION);
      if (best.length > 0) result.set(session.id, new Map(best.map(([index, entry]) => [index, entry.reasons])));
    }
    return result;
  }
}
