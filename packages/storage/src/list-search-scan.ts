import type { DatabaseSync } from "node:sqlite";

/**
 * Bounds for the substring list searches (the Knowledge list, the Sessions list `q`): every word of the query must
 * appear in some stored text field, which SQLite checks row by row.
 *
 * Why these bounds (docs/architecture.md, "Bounded work over stored text", lists every such path):
 * - The words are matched with `instr()`, which compares at most a term's bytes per stored byte with memcmp (no
 *   backtracking). `LIKE '%term%'` re-matched the term from every stored position: a 500-character near-miss term
 *   took 38.6 s over 2,000 Knowledge rows. With instr, the cost per stored byte is a small constant for terms up to
 *   MAX_LIST_SEARCH_TERM_LENGTH.
 * - Real Agent and Web queries are 2-6 short words; the longest word in the 41 real Knowledge queries is a 41-character
 *   path, and the longest stored changed-file path is 81 characters. 200 characters keeps every real path whole.
 * - Each word's test of a row runs only after the row's searched bytes (from the record header, so a long row is
 *   never loaded) were checked against a per-row cap. A row above the cap is not searched (it counts as not matching)
 *   and is counted, and the caller is told how many were skipped. There is no total budget: an earlier version capped
 *   the whole scan, which on legitimate data of 20,000 Sessions cut an ordinary three-word query short. What the attack
 *   needed was amplification per row (LIKE made one row cost hundreds of times an ordinary one); with instr and the
 *   cap, a row costs at most its bytes x words x about 5.4 ns, so the scan stays linear in the stored text.
 *
 * Worst case at the caps (development machine): about 11 ms per Knowledge row (256 KiB x 8 words), 0.18 s per Session
 * row (4 MiB x 8 words), 20 us per stored path and queried path; ordinary text of the same size costs a fifth to a
 * tenth of that, and legitimate rows are far below the caps (a real Session is about 1.5 KB of searched text).
 */
export const MAX_LIST_SEARCH_TERMS = 8;
export const MAX_LIST_SEARCH_TERM_LENGTH = 200;
/**
 * Per-row caps on the bytes one word may scan. Each is above the largest row the write limits allow in UTF-8 (a
 * Knowledge row: 300 + 20,000 characters of title and body, 30 tags, 30 references and 30 appliesTo entries of up to
 * 1,000 characters, about 250 KB with three-byte characters; a Session row: a 400,000-character work summary plus
 * summary, changed files and events, about 1.5 MB; a stored path: 1,000 characters), so only a hand-written row is
 * skipped.
 */
export const KNOWLEDGE_SEARCH_ROW_BYTES = 256 * 1024;
export const SESSION_SEARCH_ROW_BYTES = 4 * 1024 * 1024;
export const PATH_SEARCH_ROW_BYTES = 4 * 1024;
/** SQL function that checks one row for one word: CASE WHEN wi_list_search_charge(bytes) THEN <word> ELSE 0 END. */
export const LIST_SEARCH_CHARGE_FUNCTION = "wi_list_search_charge";

export interface ListSearchTerms {
  /** Lower-case terms, each at most MAX_LIST_SEARCH_TERM_LENGTH characters, at most MAX_LIST_SEARCH_TERMS. */
  terms: string[];
  /** How the query was shortened, for the caller; absent terms were never silently changed. */
  warnings: string[];
}

export interface ListSearchScan {
  /** Units per stored byte of each check: 1 for a word, the number of fragments for an OR of them. */
  readonly termCount: number;
  /** Rows above this many searched bytes are not searched. */
  readonly maxRowBytes: number;
  /** Checks refused because the row was above maxRowBytes. */
  overBound: number;
  /** Units (bytes x termCount, plus one per check) the granted checks allowed to be read (debug counter for tests). */
  charged: number;
  /** Checks granted: rows times the words that read them (debug counter for tests). */
  rowsCharged: number;
  /** Stored bytes the granted checks allowed to be read (debug counter for tests). */
  bytesCharged: number;
}

/** Test instrumentation: records every scan, and may lower the row cap of the next ones. */
export interface ListSearchScanProbe {
  maxRowBytes?: number;
  scans: ListSearchScan[];
}

const registered = new WeakSet<DatabaseSync>();
let activeScan: ListSearchScan | undefined;
let scanProbe: ListSearchScanProbe | undefined;

function chargeRow(bytes: unknown): number {
  const scan = activeScan;
  if (!scan) return 1;
  const length = typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (length > scan.maxRowBytes) {
    scan.overBound += 1;
    return 0;
  }
  scan.charged += (length + 1) * scan.termCount;
  scan.rowsCharged += 1;
  scan.bytesCharged += length;
  return 1;
}

function cutTerm(term: string): string {
  return Array.from(term).slice(0, MAX_LIST_SEARCH_TERM_LENGTH).join("");
}

/**
 * Splits a list-search query into lowercase terms: words separated by spaces, or a "quoted phrase" kept whole. List
 * searches require every term (in any field), so "report timezone" finds a record that mentions both words apart,
 * while the list keeps its time order and pagination. A term longer than MAX_LIST_SEARCH_TERM_LENGTH is cut to its
 * prefix (a record containing the whole term contains the prefix, so nothing that matched is lost), and terms after
 * MAX_LIST_SEARCH_TERMS are ignored; both are reported in `warnings`.
 */
export function parseListSearchTerms(query: string): ListSearchTerms {
  const terms: string[] = [];
  const warnings: string[] = [];
  let ignored = 0;
  for (const match of query.toLowerCase().matchAll(/"([^"]+)"|(\S+)/g)) {
    // Stray quotes (an empty pair, or one left unclosed) are not part of the word.
    const whole = (match[1] ?? match[2] ?? "").replace(/"/g, "").trim();
    if (!whole) continue;
    const term = Array.from(whole).length > MAX_LIST_SEARCH_TERM_LENGTH ? cutTerm(whole) : whole;
    if (terms.includes(term)) continue;
    if (terms.length === MAX_LIST_SEARCH_TERMS) {
      ignored += 1;
      continue;
    }
    if (term !== whole) {
      warnings.push(
        `Search word ${terms.length + 1} is longer than ${MAX_LIST_SEARCH_TERM_LENGTH} characters; only its first ${MAX_LIST_SEARCH_TERM_LENGTH} were matched.`,
      );
    }
    terms.push(term);
  }
  if (ignored > 0) {
    warnings.push(
      `Only the first ${MAX_LIST_SEARCH_TERMS} search words were used; ${ignored} more ${ignored === 1 ? "was" : "were"} ignored.`,
    );
  }
  return { terms, warnings };
}

/**
 * Defines the charge function on a connection, once. WorkIntelligenceStore calls it when it opens the database,
 * because SQLite refuses to define a function while any statement of the connection is active.
 */
export function registerListSearchFunctions(db: DatabaseSync): void {
  if (registered.has(db)) return;
  db.function(LIST_SEARCH_CHARGE_FUNCTION, { deterministic: false }, chargeRow);
  registered.add(db);
}

/** Test instrumentation only: records the scans of later calls into `probe` until called again. */
export function setListSearchScanProbe(probe: ListSearchScanProbe | undefined): void {
  scanProbe = probe;
}

/** The terms of {@link parseListSearchTerms} without the warnings. */
export function splitSearchTerms(query: string): string[] {
  return parseListSearchTerms(query).terms;
}

/** The warning a list search adds when it skipped rows above the per-row cap. */
export function listSearchOverBoundWarning(scan: ListSearchScan): string | undefined {
  if (scan.overBound === 0) return undefined;
  return `${scan.overBound} ${scan.overBound === 1 ? "record is" : "records are"} longer than the ${Math.round(scan.maxRowBytes / 1024)} KB a search reads per record and ${scan.overBound === 1 ? "was" : "were"} not searched, so the results may be incomplete.`;
}

/**
 * Runs `run` with a fresh scan; `termCount` is the units per stored byte of each check (debug counters only). The
 * SQL it runs must guard each word's test of a row with `CASE WHEN wi_list_search_charge(<byte length of the searched
 * columns>) THEN … ELSE 0 END`, so a row's text is read only when it is within `maxRowBytes`. node:sqlite is
 * synchronous, so one scan is active at a time; the previous one is restored for nested calls.
 */
export function runListSearchScan<T>(
  db: DatabaseSync,
  termCount: number,
  run: (scan: ListSearchScan) => T,
  maxRowBytes: number,
): { value: T; scan: ListSearchScan } {
  registerListSearchFunctions(db);
  const scan: ListSearchScan = {
    termCount: Math.max(1, termCount),
    maxRowBytes: scanProbe?.maxRowBytes ?? maxRowBytes,
    overBound: 0,
    charged: 0,
    rowsCharged: 0,
    bytesCharged: 0,
  };
  scanProbe?.scans.push(scan);
  const previous = activeScan;
  activeScan = scan;
  try {
    return { value: run(scan), scan };
  } finally {
    activeScan = previous;
  }
}
