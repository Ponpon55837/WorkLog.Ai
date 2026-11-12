import type { DatabaseSync } from "node:sqlite";
import type {
  FileHistoryEntry,
  FileHistoryQuery,
  FileHistoryResult,
  FileHistorySessionDigest,
  FileHistoryTotals,
  PolicyDecision,
  ReportVerificationStatus,
  SkippedResult,
} from "@work-intelligence/core";
import { decodeFileHistoryCursor, encodeFileHistoryCursor, type FileHistoryCursor } from "@work-intelligence/schema";
import { truncateText } from "@work-intelligence/shared";
import { skippedByRoot } from "./policy-helper.js";
import { parseJson, parseWorkSummarySections } from "./session-record-codecs.js";
import { appliesToStrength, normalizePath, pathBasename, type PathContext } from "./search-text.js";

export interface FileHistoryServiceDependencies {
  checkProjectRoot(projectRoot: string): PolicyDecision;
  /** Brings search_paths up to date with the latest Session writes before it is read. */
  syncIndex(): void;
}

/** Light per-Session facts for every Session of one path; text is read only for the digests shown. */
interface TouchRow {
  id: string;
  completed_at: string;
  status: ReportVerificationStatus;
  has_decisions: number;
  broad: number;
}

interface PendingRow {
  source_session_id: string;
  id: string;
  text: string;
}

interface SessionTextRow {
  id: string;
  title: string;
  work_summary_json: string | null;
}

interface TextLevel {
  title: number;
  decision: number;
  decisions: number;
  item: number;
  items: number;
}

/** One requested path before its digests are rendered at a text level. */
interface PathHistory {
  path: string;
  totals: FileHistoryTotals;
  recent: TouchRow[];
  attention: TouchRow[];
  /** Sessions older than the window, and failed or not-run ones among them. */
  olderThanWindow: number;
  attentionCandidates: number;
}

const DEFAULT_SESSION_LIMIT = 5;
const ATTENTION_LIMIT = 3;
const ATTENTION_STATUSES = new Set<ReportVerificationStatus>(["failed", "not_run"]);
const KNOWLEDGE_LIMIT = 5;
const KNOWLEDGE_TITLE_CHARS = 80;
const PENDING_TEXT_READ_CHARS = 200;
/** The serialized answer for one path; each further path may add this much more. */
const FIRST_PATH_BUDGET = 4_000;
const EXTRA_PATH_BUDGET = 3_000;
/** Text shortening steps tried before whole digests are dropped; the last keeps identifiers and counts only. */
const TEXT_LEVELS: readonly TextLevel[] = [
  { title: 100, decision: 120, decisions: 2, item: 80, items: 2 },
  { title: 80, decision: 72, decisions: 1, item: 56, items: 1 },
  { title: 56, decision: 0, decisions: 0, item: 0, items: 0 },
];

/*
 * search_paths holds each Session's changed files normalized to lower-case project-relative paths (the same rule as
 * hotspots and work_recall), indexed by basename; the path, Session type and project filters run on those few index
 * hits. Every Session that recorded the path is a confirmed relation, including broad ones (weight < 1).
 */
const TOUCH_SQL = `SELECT s.id, s.completed_at,
    COALESCE(json_extract(s.verification_json, '$.status'), 'not_supplied') AS status,
    CASE WHEN json_valid(s.work_summary_json)
      THEN COALESCE(json_array_length(s.work_summary_json, '$.decisions'), 0) > 0 ELSE 0 END AS has_decisions,
    MIN(sp.weight) < 1 AS broad
  FROM search_paths sp
  CROSS JOIN sessions s ON s.id = sp.doc_id
  WHERE sp.basename = ? AND sp.path = ? AND sp.doc_type = 'session' AND sp.project_id = ?
    AND s.project_id = sp.project_id AND s.voided_at IS NULL
  GROUP BY s.id
  ORDER BY s.completed_at DESC, s.id DESC`;

function isBefore(row: TouchRow, cursor: FileHistoryCursor): boolean {
  return row.completed_at < cursor.completedAt || (row.completed_at === cursor.completedAt && row.id < cursor.id);
}

function totalsOf(rows: readonly TouchRow[], pendingItems: number): FileHistoryTotals {
  const verification: Partial<Record<ReportVerificationStatus, number>> = {};
  let withDecisions = 0;
  let broadChanges = 0;
  for (const row of rows) {
    verification[row.status] = (verification[row.status] ?? 0) + 1;
    withDecisions += row.has_decisions ? 1 : 0;
    broadChanges += row.broad ? 1 : 0;
  }
  return {
    sessions: rows.length,
    // Rows arrive newest first.
    ...(rows.length > 0 ? { firstAt: rows[rows.length - 1]!.completed_at, lastAt: rows[0]!.completed_at } : {}),
    verification,
    withDecisions,
    pendingItems,
    broadChanges,
  };
}

function budgetFor(pathCount: number): number {
  return FIRST_PATH_BUDGET + EXTRA_PATH_BUDGET * Math.max(pathCount - 1, 0);
}

/**
 * What happened to a file before: every non-voided Session whose recorded changed files contain it, as whole-history
 * totals, the newest few as digests, older failed or not-run ones, and the active Knowledge that applies to it. Reads
 * stored records only, never the worktree, and stays within a fixed character budget.
 */
export class FileHistoryService {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly dependencies: FileHistoryServiceDependencies,
  ) {}

  public get(query: FileHistoryQuery): FileHistoryResult | SkippedResult {
    const decision = this.dependencies.checkProjectRoot(query.projectRoot);
    if (!decision.allowed || !decision.project) {
      return skippedByRoot(decision);
    }
    const project = decision.project;
    const contexts: PathContext[] = [{ name: project.name, rootPath: project.rootPath }];
    this.dependencies.syncIndex();

    const requested = new Map<string, string>();
    for (const path of query.paths) {
      const key = normalizePath(path, contexts);
      if (!requested.has(key)) requested.set(key, path.trim());
    }
    const cursor = query.cursor ? decodeFileHistoryCursor(query.cursor) : undefined;
    const limit = query.limit ?? DEFAULT_SESSION_LIMIT;
    const histories = [...requested].map(([key, path]) => this.pathHistory(project.id, key, path, limit, cursor));
    const knowledge = this.applicableKnowledge(project.id, contexts, [...requested.keys()].filter(Boolean));
    const texts = this.sessionTexts(histories.flatMap((history) => [...history.recent, ...history.attention]));
    const pending = this.pendingItems(
      project.id,
      histories.flatMap((history) => [...history.recent, ...history.attention].map((row) => row.id)),
    );

    const render = (level: TextLevel): FileHistoryResult => ({
      outcome: "file_history",
      project: { id: project.id, name: project.name },
      relation: "changed_files",
      files: histories.map((history) => this.entry(history, level, texts, pending)),
      knowledge: knowledge.items,
      ...(knowledge.omitted > 0 ? { knowledgeOmitted: knowledge.omitted } : {}),
      readWith: "work_get_session",
    });
    const budget = budgetFor(histories.length);
    const fits = (result: FileHistoryResult): boolean => JSON.stringify(result).length <= budget;
    for (const [index, level] of TEXT_LEVELS.entries()) {
      const result = render(level);
      if (fits(result)) return index === 0 ? result : { ...result, budgetTrimmed: true };
    }
    // Still too large with identifiers only: drop the oldest digests, attention first, keeping one recent per path.
    const level = TEXT_LEVELS[TEXT_LEVELS.length - 1]!;
    for (;;) {
      const largest = [...histories].sort(
        (left, right) => right.attention.length + right.recent.length - (left.attention.length + left.recent.length),
      )[0]!;
      if (largest.attention.length > 0) largest.attention.pop();
      else if (largest.recent.length > 1) {
        largest.recent.pop();
        largest.olderThanWindow += 1;
      } else return { ...render(level), budgetTrimmed: true };
      const result = render(level);
      if (fits(result)) return { ...result, budgetTrimmed: true };
    }
  }

  /** Every Session of one path from the index, newest first; then the window after the cursor and older failures. */
  private pathHistory(
    projectId: string,
    key: string,
    path: string,
    limit: number,
    cursor: FileHistoryCursor | undefined,
  ): PathHistory {
    const rows = key
      ? (this.db.prepare(TOUCH_SQL).all(pathBasename(key), key, projectId) as unknown as TouchRow[])
      : [];
    const pendingCount = this.countPending(
      projectId,
      rows.map((row) => row.id),
    );
    let start = 0;
    if (cursor) {
      while (start < rows.length && !isBefore(rows[start]!, cursor)) start += 1;
    }
    const recent = rows.slice(start, start + limit);
    const older = rows.slice(start + recent.length);
    const failures = older.filter((row) => ATTENTION_STATUSES.has(row.status));
    return {
      path,
      totals: totalsOf(rows, pendingCount),
      recent,
      attention: failures.slice(0, ATTENTION_LIMIT),
      olderThanWindow: older.length,
      attentionCandidates: failures.length,
    };
  }

  private entry(
    history: PathHistory,
    level: TextLevel,
    texts: Map<string, SessionTextRow>,
    pending: Map<string, PendingRow[]>,
  ): FileHistoryEntry {
    const digest = (row: TouchRow): FileHistorySessionDigest => this.digest(row, level, texts, pending);
    const last = history.recent[history.recent.length - 1];
    return {
      path: history.path,
      totals: history.totals,
      recent: history.recent.map(digest),
      attention: history.attention.map(digest),
      omitted: {
        older: history.olderThanWindow,
        attention: history.attentionCandidates - history.attention.length,
      },
      ...(last && history.olderThanWindow > 0
        ? { nextCursor: encodeFileHistoryCursor({ completedAt: last.completed_at, id: last.id }) }
        : {}),
    };
  }

  private digest(
    row: TouchRow,
    level: TextLevel,
    texts: Map<string, SessionTextRow>,
    pending: Map<string, PendingRow[]>,
  ): FileHistorySessionDigest {
    const text = texts.get(row.id);
    const title = text?.title ?? "";
    const decisions = (parseWorkSummarySections(text?.work_summary_json ?? null)?.decisions ?? [])
      .map((value) => value.trim())
      .filter(Boolean);
    const items = pending.get(row.id) ?? [];
    const shownDecisions = decisions.slice(0, level.decisions);
    const shownItems = items.slice(0, level.items);
    const truncated =
      title.length > level.title ||
      shownDecisions.some((value) => value.length > level.decision) ||
      shownItems.some((item) => item.text.length > level.item);
    return {
      id: row.id,
      completedAt: row.completed_at,
      title: truncateText(title, level.title),
      verificationStatus: row.status,
      ...(shownDecisions.length > 0
        ? { decisions: shownDecisions.map((value) => truncateText(value, level.decision)) }
        : {}),
      ...(decisions.length > shownDecisions.length
        ? { decisionsOmitted: decisions.length - shownDecisions.length }
        : {}),
      ...(shownItems.length > 0
        ? { pendingItems: shownItems.map((item) => ({ id: item.id, text: truncateText(item.text, level.item) })) }
        : {}),
      ...(items.length > shownItems.length ? { pendingItemsOmitted: items.length - shownItems.length } : {}),
      ...(truncated ? { truncated: true as const } : {}),
    };
  }

  private countPending(projectId: string, sessionIds: string[]): number {
    if (sessionIds.length === 0) return 0;
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM outstanding_items
         WHERE project_id = ? AND status = 'pending' AND source_session_id IN (SELECT value FROM json_each(?))`,
      )
      .get(projectId, JSON.stringify(sessionIds)) as { count: number };
    return row.count;
  }

  /** Pending items of the shown Sessions only, in their recorded order, with text cut before it leaves SQLite. */
  private pendingItems(projectId: string, sessionIds: string[]): Map<string, PendingRow[]> {
    const bySession = new Map<string, PendingRow[]>();
    if (sessionIds.length === 0) return bySession;
    const rows = this.db
      .prepare(
        `SELECT source_session_id, id, substr(text, 1, ?) AS text FROM outstanding_items
         WHERE project_id = ? AND status = 'pending' AND source_session_id IN (SELECT value FROM json_each(?))
         ORDER BY source_session_id, position, id`,
      )
      .all(PENDING_TEXT_READ_CHARS, projectId, JSON.stringify([...new Set(sessionIds)])) as unknown as PendingRow[];
    for (const row of rows) {
      const list = bySession.get(row.source_session_id);
      if (list) list.push(row);
      else bySession.set(row.source_session_id, [row]);
    }
    return bySession;
  }

  private sessionTexts(rows: readonly TouchRow[]): Map<string, SessionTextRow> {
    if (rows.length === 0) return new Map();
    const texts = this.db
      .prepare(`SELECT id, title, work_summary_json FROM sessions WHERE id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify([...new Set(rows.map((row) => row.id))])) as unknown as SessionTextRow[];
    return new Map(texts.map((row) => [row.id, row]));
  }

  /** Active Knowledge of the project whose appliesTo covers a requested path, by the work_recall matching rule. */
  private applicableKnowledge(
    projectId: string,
    contexts: PathContext[],
    keys: string[],
  ): { items: FileHistoryResult["knowledge"]; omitted: number } {
    if (keys.length === 0) return { items: [], omitted: 0 };
    const rows = this.db
      .prepare(
        `SELECT id, title, applies_to_json, updated_at FROM knowledge
         WHERE project_id = ? AND status = 'active' AND applies_to_json <> '[]'`,
      )
      .all(projectId) as Array<{ id: string; title: string; applies_to_json: string; updated_at: string }>;
    const matched = rows.flatMap((row) => {
      let strength = 0;
      for (const raw of parseJson<unknown[]>(row.applies_to_json, [])) {
        if (typeof raw !== "string") continue;
        const pattern = normalizePath(raw, contexts);
        if (!pattern) continue;
        for (const key of keys) strength = Math.max(strength, appliesToStrength(pattern, key));
      }
      return strength > 0 ? [{ row, strength }] : [];
    });
    matched.sort(
      (left, right) =>
        right.strength - left.strength ||
        right.row.updated_at.localeCompare(left.row.updated_at) ||
        left.row.id.localeCompare(right.row.id),
    );
    return {
      items: matched.slice(0, KNOWLEDGE_LIMIT).map(({ row }) => ({
        type: "knowledge" as const,
        id: row.id,
        title: truncateText(row.title, KNOWLEDGE_TITLE_CHARS),
      })),
      omitted: Math.max(matched.length - KNOWLEDGE_LIMIT, 0),
    };
  }
}
