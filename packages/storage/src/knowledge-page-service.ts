import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  KNOWLEDGE_PAGE_DEFAULTS,
  type KnowledgePageAuthor,
  type KnowledgePageContext,
  type KnowledgePageContextQuery,
  type KnowledgePageContextResult,
  type KnowledgePageContextSession,
  type KnowledgePageContextSessionReason,
  type KnowledgePageDigest,
  type KnowledgePageFocusedContext,
  type KnowledgePageListQuery,
  type KnowledgePageListResult,
  type KnowledgePageNotFoundResult,
  type MarkKnowledgePageCheckedInput,
  type MarkKnowledgePageCheckedResult,
  type KnowledgePageRecord,
  type KnowledgePageReviewContext,
  type KnowledgePageReviewReason,
  type KnowledgePageReviewSection,
  type KnowledgePageSection,
  type KnowledgePageSectionChanges,
  type KnowledgePageSectionReviewReason,
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

/** Focused read: matching sections in full (heading, content, source ids), the rest as sizes; no Sessions. */
function focusedContext(
  page: KnowledgePageRecord,
  query: KnowledgePageContextQuery,
  reviewToken: string,
): KnowledgePageFocusedContext {
  const wanted = new Set((query.headings ?? []).map((heading) => heading.trim().toLowerCase()));
  const terms = [...new Set(parseQueryWords(query.query ?? "").flatMap((word) => word.terms))];
  const reviewHeadings = new Set((page.reviewSections ?? []).map((section) => section.heading));
  // One tokenization per section; a term matches as a whole token, or (Latin, 4+ characters) as a token prefix.
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

/** The page identity and state a focused or review-only read returns instead of the whole record. */
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

/**
 * A section as knowledge_pages.sections_json keeps it. sourcedThrough is the time its cited sources were last checked
 * when that differs from the page's sourced_through: a string is that time, null means unknown, and an absent key means
 * the page's own sourced_through. Versions and every returned record only ever hold KnowledgePageSection.
 */
type StoredKnowledgePageSection = KnowledgePageSection & { sourcedThrough?: string | null };

interface SectionUpdate {
  upsertSections?: readonly KnowledgePageSection[];
  removeHeadings?: readonly string[];
}

type SectionMerge =
  { sections: StoredKnowledgePageSection[]; changes: KnowledgePageSectionChanges } | { missingHeadings: string[] };

type ContextSessionRow = {
  id: string;
  title: string;
  completed_at: string;
  work_summary_json: string | null;
};

/** What a review of a written page reads: its coverage point, the Sessions after it and the changed cited sources. */
interface ReviewSources {
  after: CoveragePoint;
  newRows: ContextSessionRow[];
  changedRows: ContextSessionRow[];
}

type ContextSessionEntry = { row: ContextSessionRow; reasons?: KnowledgePageContextSessionReason[] };

/** For each new Session that maps to a section: the section indexes and why. */
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
  updated_at: string;
  voided_at: string | null;
};

type CitedSessionVoidEventRow = {
  target_id: string;
  action: "voided" | "restored";
  occurred_at: string;
};

/** Most Sessions an Agent gets for one page (newest first for a rewrite, oldest first for a review). */
const CONTEXT_SESSION_LIMIT = 60;
/** Character budget for those Sessions, so the context and a full current page fit in one tool result. */
const CONTEXT_CHAR_BUDGET = 12_000;
/** Character budget for the new Sessions a review-only read lists by title because they map to no section. */
const UNMAPPED_SESSION_CHAR_BUDGET = 3_000;
/**
 * Section content a review-only read returns. When the sections that need review hold more, or are more than half the
 * page's sections (and more than one), the read sends the Agent to the full read instead.
 */
const REVIEW_SECTION_CONTENT_BUDGET = 4_000;
/**
 * Evidence that a new Session changes a section: a cited Session it is linked to, or a file a cited Session also
 * changed, its weight split across the sections it points at. Evidence pointing at more than MAX_EVIDENCE_SECTIONS
 * sections (a release file, a Session every section cites) is ignored. A section needs MIN_SECTION_SCORE, and a new
 * Session keeps only its MAX_SECTIONS_PER_NEW_SESSION best sections.
 */
const LINK_EVIDENCE_WEIGHT = 2;
const FILE_EVIDENCE_WEIGHT = 1;
const MAX_EVIDENCE_SECTIONS = 3;
const MIN_SECTION_SCORE = 0.5;
const MAX_SECTIONS_PER_NEW_SESSION = 3;
/** Each context Session keeps its first outcomes, decisions and open items, shortened; the rest is in work_get_session. */
const CONTEXT_SESSION_ITEMS = 2;
const CONTEXT_SESSION_ITEM_CHARS = 100;
/** How much of each page work_get_context includes, and of all pages together. */
const DIGEST_PAGE_CHARS = 1_500;
const DIGEST_TOTAL_CHARS = 4_500;
const DIGEST_REVIEW_SOURCE_LIMIT = 8;
const DIGEST_SOURCE_SESSION_LIMIT = 8;
/** Version prefix of reviewToken, so a later token format can be told apart. */
const REVIEW_TOKEN_PREFIX = "kpr1.";
/** Longest stored completion time or Session id a token may carry; real values are far shorter. */
const REVIEW_TOKEN_FIELD_LIMIT = 200;
const MISSING_REVIEW_TOKEN_WARNING =
  "Saved without reviewToken: the save was not checked against a newer page version, and every Session finished before it counts as covered. Pass the reviewToken from work_get_knowledge_page_context next time.";
/** Prompt for review after a small batch, while keeping single-session updates out of pending context. */
export const KNOWLEDGE_PAGE_MAINTENANCE_SESSION_THRESHOLD = 3;
/** Versions shown in the Web history; older versions stay in the database and in exports. */
const VERSION_HISTORY_LIMIT = 50;
/** Slugs a not_found page lookup lists, so a project with many custom pages still gets a bounded answer. */
const NOT_FOUND_SLUG_LIMIT = 20;
/** Largest edit distance at which a slug is offered as the one the Agent probably meant. */
const NEAR_SLUG_DISTANCE = 2;
/** The shape of a page, Session, or Knowledge id; a slug never looks like this. */
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The page limits the schema checks for a whole page; a section update is checked against them once merged. */
const MAX_PAGE_SECTIONS = 12;
const MAX_PAGE_CONTENT_CHARS = 8_000;
const IDEMPOTENCY_CONFLICT_RESULT = {
  outcome: "idempotency_conflict" as const,
  reason:
    "This idempotencyKey already saved different sections for this page, so nothing was written. Use a new idempotencyKey for new content.",
};

const DEFAULT_PAGES = new Map<string, { title: string; question: string }>(
  KNOWLEDGE_PAGE_DEFAULTS.map((page) => [page.slug, { title: page.title, question: page.question }]),
);

/** The first items of the sections a page answer is built from, each shortened and marked with an ellipsis. */
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

function skipped(decision: PolicyDecision): KnowledgePageSkippedResult {
  return {
    outcome: "skipped",
    projectRoot: decision.canonicalRoot,
    projectStatus: decision.projectStatus,
    reason: decision.reason ?? "Project recording is not enabled.",
  };
}

/**
 * Levenshtein distance, or `limit + 1` as soon as it must exceed `limit`. Slugs are at most 40 characters, so one
 * two-row pass per candidate is cheap.
 */
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

/** The closest candidate within NEAR_SLUG_DISTANCE edits (the first in order on a tie), if any. */
function nearestSlug(slug: string, candidates: readonly string[]): string | undefined {
  let best: { slug: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = boundedEditDistance(slug, candidate, NEAR_SLUG_DISTANCE);
    // A distance as large as the candidate itself means the strings share almost nothing.
    if (distance > NEAR_SLUG_DISTANCE || distance >= candidate.length) continue;
    if (!best || distance < best.distance) best = { slug: candidate, distance };
  }
  return best?.slug;
}

interface CompletedSessionCursor {
  id: string;
  completedAt: string;
}

/**
 * Where a page's Session coverage ends. With an id, Sessions after that (completed_at, id) position are new; without
 * one, Sessions that finished strictly after completedAt are (the rule for pages saved before schema 34). An empty
 * completedAt means the save covered no Session, so every Session is new.
 */
interface CoveragePoint {
  completedAt: string;
  id?: string;
}

interface ReviewTokenContent {
  pageId: string;
  version: number;
  through: CoveragePoint;
}

/** The saved coverage of a written page: the Session position its last save recorded, else its save time. */
function sessionCoverage(row: PageRow): CoveragePoint | undefined {
  if (row.covered_through_completed_at !== null) {
    return {
      completedAt: row.covered_through_completed_at,
      ...(row.covered_through_session_id !== null ? { id: row.covered_through_session_id } : {}),
    };
  }
  return row.sourced_through ? { completedAt: row.sourced_through } : undefined;
}

/** The later of the saved coverage and the review cursor; a cursor before the saved coverage changes nothing. */
function reviewedThrough(coverage: CoveragePoint, checked: CompletedSessionCursor | undefined): CoveragePoint {
  if (!checked) return coverage;
  const ahead =
    coverage.id === undefined
      ? checked.completedAt >= coverage.completedAt
      : compareCursor(checked, { completedAt: coverage.completedAt, id: coverage.id }) >= 0;
  return ahead ? { completedAt: checked.completedAt, id: checked.id } : coverage;
}

function encodeReviewToken(content: ReviewTokenContent): string {
  const payload = {
    p: content.pageId,
    v: content.version,
    at: content.through.completedAt,
    ...(content.through.id !== undefined ? { id: content.through.id } : {}),
  };
  return REVIEW_TOKEN_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** The token's content, or undefined when it is not one this server wrote. */
function pageContext(
  row: PageRow,
  page: KnowledgePageRecord,
  mode: KnowledgePageContext["mode"],
  {
    sessions,
    truncated,
    through,
  }: { sessions: KnowledgePageContextSession[]; truncated: boolean; through: CoveragePoint },
): KnowledgePageContext {
  return {
    outcome: "knowledge_page_context",
    page,
    mode,
    sessions,
    omittedSessionFields: ["summary", "workSummary.scope", "workSummary.verification"],
    sessionReadWith: "work_get_session",
    truncated,
    reviewToken: encodeReviewToken({ pageId: row.id, version: row.version, through }),
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
  const { p, v, at, id } = payload as Record<string, unknown>;
  const boundedText = (value: unknown): value is string =>
    typeof value === "string" && value.length <= REVIEW_TOKEN_FIELD_LIMIT;
  if (!boundedText(p) || p.length === 0 || !boundedText(at)) return undefined;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) return undefined;
  if (id !== undefined && (!boundedText(id) || id.length === 0)) return undefined;
  return { pageId: p, version: v, through: { completedAt: at, ...(id !== undefined ? { id } : {}) } };
}

function compareCursor(left: CompletedSessionCursor, right: CompletedSessionCursor): number {
  return left.completedAt.localeCompare(right.completedAt) || left.id.localeCompare(right.id);
}

/** First completion tuple strictly after the supplied cursor. */
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

/** Sections as a version stores them: duplicate sources removed, sensitive values masked. */
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

/** The time a section's cited sources are compared with: its own baseline, else the page's. */
function baselineOf(section: StoredKnowledgePageSection, pageSourcedThrough: string | null): string | null {
  return "sourcedThrough" in section ? (section.sourcedThrough ?? null) : pageSourcedThrough;
}

/** knowledge_pages.sections_json: the redacted sections, each with the baseline of the stored section at its index. */
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

/**
 * Replaces the sections named in upsertSections in place, drops those in removeHeadings, and appends the rest of
 * upsertSections. Only the first section with a heading is matched. keep maps each untouched section to what the
 * merged page stores for it.
 */
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

function pageLimitExceeded(sections: readonly KnowledgePageSection[]): SaveKnowledgePageResult | undefined {
  const contentChars = sections.reduce((total, section) => total + section.content.length, 0);
  if (sections.length >= 1 && sections.length <= MAX_PAGE_SECTIONS && contentChars <= MAX_PAGE_CONTENT_CHARS) {
    return undefined;
  }
  const problem =
    sections.length === 0
      ? "no sections"
      : sections.length > MAX_PAGE_SECTIONS
        ? `${sections.length} sections (at most ${MAX_PAGE_SECTIONS})`
        : `${contentChars} characters of section content (at most ${MAX_PAGE_CONTENT_CHARS})`;
  return {
    outcome: "page_limit_exceeded",
    reason: `The page after this update would have ${problem}, so nothing was written. Send fewer or shorter sections, or save the whole page with sections.`,
    sectionCount: sections.length,
    maxSections: MAX_PAGE_SECTIONS,
    contentChars,
    maxContentChars: MAX_PAGE_CONTENT_CHARS,
  };
}

function versionConflict(baseVersion: number, currentVersion: number): KnowledgePageVersionConflictResult {
  return {
    outcome: "version_conflict",
    reason:
      "The page was saved again after this edit started, so nothing was written. Read the current version and apply the change to it.",
    baseVersion,
    currentVersion,
  };
}

function citedSessionIds(sections: readonly KnowledgePageSection[]): string[] {
  return [...new Set(sections.flatMap((section) => section.sourceSessionIds))];
}

/** Keep review pointers compact in aggregate context; the page-context tool still returns every affected source. */
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

/** Renders a page's sections as Markdown with the cited Session ids after each section. */
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

/** Owns standing Knowledge pages: Agent update requests, their context, saving versions, and staleness. */
export class KnowledgePageService {
  // Page records shared by the reads of one withSharedReads call; undefined outside such a call.
  private sharedRecords: Map<string, KnowledgePageRecord[]> | undefined;

  public constructor(
    private readonly db: DatabaseSync,
    private readonly dependencies: KnowledgePageDependencies,
  ) {}

  /**
   * Runs one read-only composite read (work_get_context) whose parts each need the same projects' page records:
   * they are built once and shared until `read` returns. Nothing is kept afterwards, so a later call always sees
   * the current pages. `read` must not write pages; callers only filter or copy the shared records.
   */
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

  /** Bounded page window for attention; trust is still derived by this authoritative service. */
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
    if (query.reviewOnly) return this.reviewOnlyContext(row, page);
    if (query.query !== undefined || query.headings !== undefined) {
      const through = this.reviewedPoint(row);
      return focusedContext(page, query, encodeReviewToken({ pageId: row.id, version: row.version, through }));
    }
    if (row.version === 0 || row.update_requested_at) {
      return pageContext(row, page, "full", this.contextSessions(decision.project.id));
    }
    return pageContext(row, page, "review", this.reviewSessions(this.reviewSources(row, page)));
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
      .prepare("SELECT version, sections_json FROM knowledge_page_versions WHERE page_id = ? AND idempotency_key = ?")
      .get(row.id, input.idempotencyKey) as { version: number; sections_json: string } | undefined;
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
    if (input.sections === undefined) return this.saveSectionUpdate(row, input, token!);
    const written = this.writeVersion(row, row.title, input.sections, "agent", {
      idempotencyKey: input.idempotencyKey,
      ...(token ? { baseVersion: token.version, coverage: token.through } : {}),
    });
    if ("conflict" in written) return written.conflict;
    return {
      outcome: "knowledge_page_saved",
      duplicate: false,
      page: this.recordFor(this.findPageById(row.id)!),
      ...(written.redactions.total > 0 ? { redactions: written.redactions } : {}),
      ...(token ? {} : { warnings: [MISSING_REVIEW_TOKEN_WARNING] }),
    };
  }

  /** Record an Agent's review cursor without changing page content, version, or C1 source-review state. */
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

    const result = runImmediateTransaction(this.db, () => {
      const row = this.findPageById(initial.id)!;
      const cursor = this.db
        .prepare("SELECT id, project_id, completed_at, voided_at FROM sessions WHERE id = ?")
        .get(input.throughSessionId) as
        { id: string; project_id: string; completed_at: string; voided_at: string | null } | undefined;
      if (!cursor || cursor.project_id !== decision.project!.id || cursor.voided_at) {
        return {
          outcome: "invalid_cursor" as const,
          reason: "throughSessionId must identify a non-voided Session in this project.",
        };
      }

      if (row.checked_through_session_id && row.checked_through_session_id !== cursor.id) {
        const previous = this.db
          .prepare("SELECT id, completed_at FROM sessions WHERE id = ?")
          .get(row.checked_through_session_id) as { id: string; completed_at: string } | undefined;
        if (
          previous &&
          compareCursor(
            { id: cursor.id, completedAt: cursor.completed_at },
            { id: previous.id, completedAt: previous.completed_at },
          ) < 0
        ) {
          return { outcome: "invalid_cursor" as const, reason: "The review cursor cannot move backwards." };
        }
      }

      this.db.prepare("UPDATE knowledge_pages SET checked_through_session_id = ? WHERE id = ?").run(cursor.id, row.id);
      return { outcome: "knowledge_page_checked" as const, pageId: row.id };
    });
    if (result.outcome === "invalid_cursor") return result;
    return { outcome: "knowledge_page_checked", page: this.recordFor(this.findPageById(result.pageId)!) };
  }

  /**
   * The Session that saved or checked a page should not make that page show new data. Runs inside the finalize
   * transaction: for each named page, when the new Session is the first unreviewed one after the page's coverage
   * point (its sourced-through time or checked cursor), the checked cursor moves to it. When other Sessions
   * finished in between, nothing moves, so they are never hidden. Returns the slugs that moved.
   */
  public acknowledgeMaintenance(projectId: string, sessionId: string, slugs: readonly string[]): string[] {
    const acknowledged: string[] = [];
    const firstAfter = this.db.prepare(
      `SELECT id, completed_at FROM sessions
       WHERE project_id = ? AND voided_at IS NULL AND (completed_at > ? OR (completed_at = ? AND id > ?))
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
    const written = this.writeVersion(row, input.title ?? row.title, input.sections, "web", {
      ...(input.baseVersion !== undefined ? { baseVersion: input.baseVersion } : {}),
    });
    if ("conflict" in written) return written.conflict;
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

  /** Pages an Agent should inspect: explicit requests, cited sources needing review, or a batch of new Sessions. */
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

  /** Written pages of a project whose cited sections include any of the Sessions. */
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

  /** A single-line finalize reminder derived from the same ordered queue as work_get_context. */
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

  /**
   * Explains a missed page lookup with what the Agent can retry: the project's slugs, the page whose id was passed
   * as a slug, or the nearest slug. Only pages of the already policy-checked project are read.
   */
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

  /** Pages of several projects, ordered defaults first, with staleness computed in one pass per project. */
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

  /**
   * Counts the Sessions newer than each page. One query per project reads the completion times after the
   * oldest page's cutoff (ascending); each page's count is then a binary search, not a query per page.
   */
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
       WHERE project_id = ? AND voided_at IS NULL AND completed_at >= ?
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
          `SELECT id, project_id, title, updated_at, voided_at FROM sessions
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
            } else if (source.updated_at > baseline) {
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

  /** The answer to a save whose idempotencyKey a version already holds: a replay of the same content, or a conflict. */
  private replayedSave(
    row: PageRow,
    saved: { version: number; sections_json: string },
    input: SaveKnowledgePageInput,
  ): SaveKnowledgePageResult {
    const replay = (sectionChanges?: KnowledgePageSectionChanges): SaveKnowledgePageResult => ({
      outcome: "knowledge_page_saved",
      duplicate: true,
      page: this.recordFor(this.findPageById(row.id)!),
      ...(sectionChanges ? { sectionChanges } : {}),
    });
    if (input.sections) {
      // A retry carries the same sections; reusing the key for other content would silently drop that content.
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

  /** Applies a section update to the page as it is inside the write transaction; nothing is written on a refusal. */
  private saveSectionUpdate(
    row: PageRow,
    update: SectionUpdate & { idempotencyKey: string },
    token: ReviewTokenContent,
  ) {
    const now = nowIso();
    const written = runImmediateTransaction(this.db, () => {
      const current = this.findPageById(row.id)!;
      if (current.version !== token.version) return versionConflict(token.version, current.version);
      // A section left as it is keeps the time its sources were last checked, which moves on for the rest of the page.
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
      // Coverage stays where it was; a page saved before schema 34 gets its sourced_through as an explicit time.
      const coverage = sessionCoverage(current) ?? { completedAt: "" };
      this.db
        .prepare(
          `UPDATE knowledge_pages
           SET sections_json = ?, version = ?, sourced_through = ?, last_author = 'agent', updated_at = ?,
               covered_through_completed_at = ?, covered_through_session_id = ?
           WHERE id = ?`,
        )
        .run(
          serializeStoredSections(redacted.value, merged.sections),
          version,
          now,
          now,
          coverage.completedAt,
          coverage.id ?? null,
          current.id,
        );
      return { changes: merged.changes, redactions: redacted.redactions };
    });
    if ("outcome" in written) return written;
    return {
      outcome: "knowledge_page_saved" as const,
      duplicate: false,
      page: this.recordFor(this.findPageById(row.id)!),
      sectionChanges: written.changes,
      ...(written.redactions.total > 0 ? { redactions: written.redactions } : {}),
    };
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

  /** The point a read of this page has already reviewed: its saved coverage, or the checked cursor when that is later. */
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

  /**
   * Saves a new version. With baseVersion, a page saved since that version is left as it is and the conflict is
   * returned. coverage is the last Session the writer was shown; without it every Session finished before this
   * save counts as covered (Web edits, and Agent saves without reviewToken).
   */
  private writeVersion(
    row: PageRow,
    title: string,
    sections: readonly KnowledgePageSection[],
    author: KnowledgePageAuthor,
    options: { idempotencyKey?: string; baseVersion?: number; coverage?: CoveragePoint },
  ): { redactions: ReturnType<typeof combineRedactionSummaries> } | { conflict: KnowledgePageVersionConflictResult } {
    const redactedTitle = redactText(title);
    const redactedSections = storedSections(sections);
    const now = nowIso();
    const conflict = runImmediateTransaction(this.db, (): KnowledgePageVersionConflictResult | undefined => {
      const current = this.findPageById(row.id)!;
      if (options.baseVersion !== undefined && current.version !== options.baseVersion) {
        return versionConflict(options.baseVersion, current.version);
      }
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
          options.coverage?.completedAt ?? null,
          options.coverage?.id ?? null,
          row.id,
        );
      return undefined;
    });
    if (conflict) return { conflict };
    return { redactions: combineRedactionSummaries(redactedTitle.redactions, redactedSections.redactions) };
  }

  /** Recent Sessions, newest first, for a full rewrite of an empty page or an explicitly requested update. */
  private contextSessions(projectId: string): {
    sessions: KnowledgePageContextSession[];
    truncated: boolean;
    through: CoveragePoint;
  } {
    const rows = this.db
      .prepare(
        `SELECT id, title, completed_at, work_summary_json FROM sessions
         WHERE project_id = ? AND voided_at IS NULL
         ORDER BY completed_at DESC, id DESC
         LIMIT ?`,
      )
      .all(projectId, CONTEXT_SESSION_LIMIT + 1) as ContextSessionRow[];
    const budgeted = this.budgetSessions(
      rows.slice(0, CONTEXT_SESSION_LIMIT).map((row) => ({ row })),
      rows.length > CONTEXT_SESSION_LIMIT,
    );
    // Newest first, so the first Session shown is the coverage; an empty list covers nothing.
    const newest = budgeted.sessions[0];
    return { ...budgeted, through: newest ? { completedAt: newest.completedAt, id: newest.id } : { completedAt: "" } };
  }

  /** Converts rows in order until CONTEXT_CHAR_BUDGET is spent; the rest are left out and flagged. */
  private budgetSessions(
    entries: readonly ContextSessionEntry[],
    alreadyTruncated: boolean,
  ): { sessions: KnowledgePageContextSession[]; truncated: boolean } {
    let truncated = alreadyTruncated;
    let budget = CONTEXT_CHAR_BUDGET;
    const sessions: KnowledgePageContextSession[] = [];
    for (const { row, reasons } of entries) {
      const session = sessionPreview(row, reasons);
      const size = JSON.stringify(session).length;
      if (size > budget) {
        truncated = true;
        break;
      }
      budget -= size;
      sessions.push(session);
    }
    return { sessions, truncated };
  }

  /**
   * Sessions an Agent must read to review a written page: those finished after its coverage point (sourced-through
   * time or checked cursor), oldest first, and the cited sources that changed since it was saved. A Session that is
   * both is listed once, among the new ones, with both reasons.
   */
  private reviewSessions({ after, newRows, changedRows }: ReviewSources): {
    sessions: KnowledgePageContextSession[];
    truncated: boolean;
    through: CoveragePoint;
  } {
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
    );
    // New Sessions come last, oldest first, and the budget keeps a prefix, so the last one shown is the coverage.
    // When none fit, the coverage stays where it was.
    let lastNew: KnowledgePageContextSession | undefined;
    for (const session of budgeted.sessions) if (session.reasons?.includes("new")) lastNew = session;
    return { ...budgeted, through: lastNew ? { completedAt: lastNew.completedAt, id: lastNew.id } : after };
  }

  /**
   * Review-only read: the sections whose cited sources changed or to which a new Session maps (see
   * newSessionSections), in full with their reasons, previews of the Sessions behind them, and the new Sessions that
   * map to no section by title. New Sessions are handled oldest first, each previewed or listed until a budget runs
   * out, so checkedThroughCandidate never skips one. The reviewToken keeps the page's coverage. When the sections
   * exceed REVIEW_SECTION_CONTENT_BUDGET or half the page, or the answer is no smaller than the review read built from
   * the same rows, it returns use_full_read without sections or Sessions.
   */
  private reviewOnlyContext(row: PageRow, page: KnowledgePageRecord): KnowledgePageReviewContext {
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
      size: {
        sectionCount: page.sections.length,
        maxSections: MAX_PAGE_SECTIONS,
        contentChars: page.sections.reduce((total, section) => total + section.content.length, 0),
        maxContentChars: MAX_PAGE_CONTENT_CHARS,
      },
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
    const sessions: KnowledgePageContextSession[] = [];
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
          const preview = sessionPreview(session, changedIds.has(session.id) ? ["new", "source_changed"] : ["new"]);
          const size = JSON.stringify(preview).length;
          if (size > budget) break;
          budget -= size;
          sessions.push(preview);
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
        JSON.stringify(pageContext(row, page, "review", this.reviewSessions(sources))).length;
    if (!useFullRead) return result;
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

  /** Non-voided Sessions finished after a coverage point, oldest first, one past CONTEXT_SESSION_LIMIT. */
  private newSessionRows(projectId: string, after: CoveragePoint): ContextSessionRow[] {
    return this.db
      .prepare(
        `SELECT id, title, completed_at, work_summary_json FROM sessions
         WHERE project_id = ? AND voided_at IS NULL AND (completed_at > ? OR (completed_at = ? AND id > ?))
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

  /** The cited Sessions behind the page's review warnings that still exist in its project, oldest first. */
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

  /**
   * Maps each new Session to the sections it most likely changes. Evidence is a Session link (either direction) to a
   * Session a section cites, or a file such a Session also changed; each piece is split across the sections it points
   * at and ignored when it points at more than MAX_EVIDENCE_SECTIONS. A section needs MIN_SECTION_SCORE, the best
   * MAX_SECTIONS_PER_NEW_SESSION are kept, and a section that already cites the new Session is never one of them. Two
   * queries for the whole page; a Session with no section that scores is absent.
   */
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
    // For each file a cited Session changed: the sections citing such a Session, with those Sessions.
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
