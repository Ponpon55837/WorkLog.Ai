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
 * - Each word is charged before it reads a row: the byte length of the row's searched columns (from the record
 *   header, so an over-long row is never loaded). SQLite stops at the first word a row lacks, so ordinary queries pay
 *   about one pass over the text; an adversarial one pays at most one pass per word. When the call's scan budget is
 *   spent, the remaining rows are not searched and the caller is told so with a warning.
 */
export const MAX_LIST_SEARCH_TERMS = 8;
export const MAX_LIST_SEARCH_TERM_LENGTH = 200;
/**
 * Byte x term units one list search may scan. The slowest measured unit (the Knowledge list: eight 200-character
 * near-miss words over 2,000 rows of the largest allowed appliesTo, five LOWER() copies per word) is about 5.3 ns on
 * the development machine (the Sessions list with json_each 5.4 ns), so a spent budget stops after about 130 ms; the
 * Agent Knowledge search runs at most two budgets (the strict list, then the other-status counts). Ordinary text costs
 * 0.3-1 ns per unit; a real query over the real data (328 Sessions, 64 Knowledge) uses at most a few percent of it.
 */
export const LIST_SEARCH_SCAN_BUDGET = 24_000_000;
/** SQL function that charges one row for one word: CASE WHEN wi_list_search_charge(bytes) THEN <word> ELSE 0 END. */
export const LIST_SEARCH_CHARGE_FUNCTION = "wi_list_search_charge";

export interface ListSearchTerms {
  /** Lower-case terms, each at most MAX_LIST_SEARCH_TERM_LENGTH characters, at most MAX_LIST_SEARCH_TERMS. */
  terms: string[];
  /** How the query was shortened, for the caller; absent terms were never silently changed. */
  warnings: string[];
}

export interface ListSearchScan {
  /** Units per stored byte of each charge: 1 for a word, the number of fragments for an OR of them. */
  readonly termCount: number;
  remaining: number;
  exhausted: boolean;
  /** Units charged so far (debug counter for tests). */
  charged: number;
  /** Charges granted: rows times the words that read them (debug counter for tests). */
  rowsCharged: number;
  /** Stored bytes the granted charges allowed to be read (debug counter for tests). */
  bytesCharged: number;
}

/** Test instrumentation: records every scan, and may lower the budget of the next ones. */
export interface ListSearchScanProbe {
  budget?: number;
  scans: ListSearchScan[];
}

const registered = new WeakSet<DatabaseSync>();
let activeScan: ListSearchScan | undefined;
let scanProbe: ListSearchScanProbe | undefined;

function chargeRow(bytes: unknown): number {
  const scan = activeScan;
  if (!scan) return 1;
  if (scan.exhausted) return 0;
  const length = typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  // One unit per stored byte (times the fragments an OR reads), plus one for the row itself.
  const units = (length + 1) * scan.termCount;
  if (units > scan.remaining) {
    scan.remaining = 0;
    scan.exhausted = true;
    return 0;
  }
  scan.remaining -= units;
  scan.charged += units;
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

/** The warning a list search adds when its scan budget ran out. */
export function listSearchTruncatedWarning(scan: ListSearchScan): string | undefined {
  if (!scan.exhausted) return undefined;
  return `The search stopped after reading ${scan.rowsCharged} records (its text-scan limit), so older records were not searched and the results may be incomplete. Narrow it with a project, a date range, or fewer or shorter words.`;
}

/**
 * Runs `run` with a fresh scan budget; each charge costs `termCount` units per stored byte. The SQL it runs must guard
 * each word's test of a row with `CASE WHEN wi_list_search_charge(<byte length of the searched columns>) THEN …
 * ELSE 0 END`, so a row's text is read only after it was charged; once the budget is spent every later test fails. node:sqlite is
 * synchronous, so one scan is active at a time; the previous one is restored for nested calls.
 */
export function runListSearchScan<T>(
  db: DatabaseSync,
  termCount: number,
  run: (scan: ListSearchScan) => T,
  budget = LIST_SEARCH_SCAN_BUDGET,
): { value: T; scan: ListSearchScan } {
  registerListSearchFunctions(db);
  const scan: ListSearchScan = {
    termCount: Math.max(1, termCount),
    remaining: scanProbe?.budget ?? budget,
    exhausted: false,
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
