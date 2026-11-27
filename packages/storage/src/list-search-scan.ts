import type { DatabaseSync } from "node:sqlite";

/** @internal test-only */
export const MAX_LIST_SEARCH_TERMS = 8;
/** @internal test-only */
export const MAX_LIST_SEARCH_TERM_LENGTH = 200;
/** Each cap is above the largest row the write limits allow in UTF-8, so only a hand-written row is skipped. */
export const KNOWLEDGE_SEARCH_ROW_BYTES = 256 * 1024;
export const SESSION_SEARCH_ROW_BYTES = 4 * 1024 * 1024;
export const PATH_SEARCH_ROW_BYTES = 4 * 1024;
export const LIST_SEARCH_CHARGE_FUNCTION = "wi_list_search_charge";
const LIST_SEARCH_MORE_FUNCTION = "wi_list_search_more";
const LIST_SEARCH_MORE_AGAIN_FUNCTION = "wi_list_search_more_again";
const LIST_SEARCH_REFUSED_FUNCTION = "wi_list_search_refused";

export interface ListSearchTerms {
  terms: string[];
  warnings: string[];
}

export interface ListSearchScan {
  readonly termCount: number;
  readonly maxRowBytes: number;
  overBound: number;
  charged: number;
  rowsCharged: number;
  bytesCharged: number;
  rowsMeasured: number;
}

/** @internal test-only */
export interface ListSearchScanProbe {
  maxRowBytes?: number;
  scans: ListSearchScan[];
}

const registered = new WeakSet<DatabaseSync>();
let activeScan: ListSearchScan | undefined;
let scanProbe: ListSearchScanProbe | undefined;

/** One scan is active at a time; runListSearchScan saves and restores this with the scan. */
let lastKey: unknown;
let lastLength = 0;
let lastMore: number | undefined;
let lastRefused = false;
function grant(scan: ListSearchScan, length: number, checks: number): void {
  scan.charged += (length + checks) * scan.termCount;
  scan.rowsCharged += checks;
  scan.bytesCharged += length;
}

function chargeRow(bytes: unknown, key?: unknown): number {
  const scan = activeScan;
  if (!scan) return 1;
  const length = typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (key !== undefined && key !== null) {
    lastKey = key;
    lastLength = length;
    lastMore = undefined;
    lastRefused = length > scan.maxRowBytes;
  }
  if (length > scan.maxRowBytes) {
    scan.overBound += 1;
    return 0;
  }
  grant(scan, length, 1);
  return 1;
}

function checkMore(scan: ListSearchScan, more: number): number {
  if (lastLength + more > scan.maxRowBytes) {
    scan.overBound += 1;
    return 0;
  }
  grant(scan, more, 0);
  return 1;
}

function chargeMore(bytes: unknown, key: unknown): number {
  const scan = activeScan;
  if (!scan) return 1;
  const more = typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  scan.rowsMeasured += 1;
  // Only reachable after chargeRow granted this row; without its record the row is refused rather than guessed.
  if (key === null || key === undefined || lastKey !== key) {
    scan.overBound += 1;
    return 0;
  }
  lastMore = more;
  return checkMore(scan, more);
}

function countRefused(key: unknown): number {
  const scan = activeScan;
  if (!scan) return 0;
  if (lastKey !== key || !lastRefused) {
    lastKey = key;
    lastMore = undefined;
    lastRefused = true;
    scan.overBound += 1;
  }
  return 0;
}

function chargeMoreAgain(key: unknown): number | null {
  const scan = activeScan;
  if (!scan) return 1;
  if (lastMore === undefined || key === null || lastKey !== key) return null;
  return checkMore(scan, lastMore);
}

function cutTerm(term: string): string {
  return Array.from(term).slice(0, MAX_LIST_SEARCH_TERM_LENGTH).join("");
}

export function parseListSearchTerms(query: string): ListSearchTerms {
  const terms: string[] = [];
  const warnings: string[] = [];
  let ignored = 0;
  for (const match of query.toLowerCase().matchAll(/"([^"]+)"|(\S+)/g)) {
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

/** Called when the store opens the database: SQLite refuses to define a function while a statement is active. */
export function registerListSearchFunctions(db: DatabaseSync): void {
  if (registered.has(db)) return;
  db.function(LIST_SEARCH_CHARGE_FUNCTION, { deterministic: false, varargs: true }, chargeRow);
  db.function(LIST_SEARCH_MORE_FUNCTION, { deterministic: false }, chargeMore);
  db.function(LIST_SEARCH_MORE_AGAIN_FUNCTION, { deterministic: false }, chargeMoreAgain);
  db.function(LIST_SEARCH_REFUSED_FUNCTION, { deterministic: false }, countRefused);
  registered.add(db);
}

export function listSearchRowGuard(keySql: string, cheapBytesSql: string, index: number, maxRowBytes: number): string {
  if (index === 0) return `${LIST_SEARCH_CHARGE_FUNCTION}(${cheapBytesSql}, ${keySql})`;
  return `((${cheapBytesSql}) <= ${Math.floor(maxRowBytes)} OR ${LIST_SEARCH_REFUSED_FUNCTION}(${keySql}))`;
}

export function listSearchRowCap(maxRowBytes: number): number {
  return scanProbe?.maxRowBytes ?? maxRowBytes;
}

/** COALESCE evaluates its second argument only when the first is NULL, so later words reuse the recorded sum. */
export function listSearchMoreGuard(keySql: string, moreBytesSql: string): string {
  return `COALESCE(${LIST_SEARCH_MORE_AGAIN_FUNCTION}(${keySql}), ${LIST_SEARCH_MORE_FUNCTION}(${moreBytesSql}, ${keySql}))`;
}

/** @internal test-only */
export function setListSearchScanProbe(probe: ListSearchScanProbe | undefined): void {
  scanProbe = probe;
}

/** @internal test-only */
export function splitSearchTerms(query: string): string[] {
  return parseListSearchTerms(query).terms;
}

export function listSearchOverBoundWarning(scan: ListSearchScan): string | undefined {
  if (scan.overBound === 0) return undefined;
  return `${scan.overBound} ${scan.overBound === 1 ? "record is" : "records are"} longer than the ${Math.round(scan.maxRowBytes / 1024)} KB a search reads per record and ${scan.overBound === 1 ? "was" : "were"} not searched, so the results may be incomplete.`;
}

/** The SQL must guard each word's test with `CASE WHEN wi_list_search_charge(<bytes>) THEN … ELSE 0 END`. */
export function runListSearchScan<T>(
  db: DatabaseSync,
  termCount: number,
  run: (scan: ListSearchScan) => T,
  maxRowBytes: number,
): { value: T; scan: ListSearchScan } {
  registerListSearchFunctions(db);
  const scan: ListSearchScan = {
    termCount: Math.max(1, termCount),
    maxRowBytes: listSearchRowCap(maxRowBytes),
    overBound: 0,
    charged: 0,
    rowsCharged: 0,
    bytesCharged: 0,
    rowsMeasured: 0,
  };
  scanProbe?.scans.push(scan);
  const previous = { scan: activeScan, key: lastKey, length: lastLength, more: lastMore, refused: lastRefused };
  activeScan = scan;
  lastKey = undefined;
  lastMore = undefined;
  lastRefused = false;
  try {
    return { value: run(scan), scan };
  } finally {
    activeScan = previous.scan;
    lastKey = previous.key;
    lastLength = previous.length;
    lastMore = previous.more;
    lastRefused = previous.refused;
  }
}
