export interface WindowedExcerpt {
  text: string;
  truncated: boolean;
}

const ELLIPSIS = "…";
const SENTENCE_END = /(?:[。！？!?]+|\.(?=\s|$)|\n{2,})\s*/gu;

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Start of the text after the first sentence end or, failing that, the first whitespace run in [from, to]. */
function snapStart(text: string, from: number, to: number): number {
  const slack = text.slice(from, to);
  SENTENCE_END.lastIndex = 0;
  const sentence = SENTENCE_END.exec(slack);
  if (sentence && sentence[0].length > 0) return from + sentence.index + sentence[0].length;
  const space = /\s+/u.exec(slack);
  return space ? from + space.index + space[0].length : from;
}

/** End of the text at the last sentence end or, failing that, before the last whitespace run in [from, to]. */
function snapEnd(text: string, from: number, to: number): number {
  const slack = text.slice(from, to);
  let sentenceEnd = -1;
  for (const match of slack.matchAll(SENTENCE_END)) {
    if (match[0].length > 0) sentenceEnd = match.index + match[0].trimEnd().length;
  }
  if (sentenceEnd > 0) return from + sentenceEnd;
  const space = slack.search(/\s+\S*$/u);
  return space > 0 ? from + space : to;
}

function headOf(text: string, limit: number): WindowedExcerpt {
  if (text.length <= limit) return { text, truncated: false };
  const prefix = text.slice(0, Math.max(0, limit - 1));
  SENTENCE_END.lastIndex = 0;
  let boundary = 0;
  for (const match of prefix.matchAll(SENTENCE_END)) {
    boundary = match.index + match[0].trimEnd().length;
  }
  if (boundary > 0) return { text: `${prefix.slice(0, boundary).trimEnd()}${ELLIPSIS}`, truncated: true };
  const wordBoundary = prefix.search(/\s+[^\s]*$/u);
  const safeEnd = wordBoundary > 0 ? wordBoundary : prefix.length;
  return { text: `${prefix.slice(0, safeEnd).trimEnd()}${ELLIPSIS}`, truncated: true };
}

/**
 * Cuts `text` to at most `limit` characters (ellipses included), centered on the densest cluster of the lowercase
 * `terms`. Without a match (or when lowercasing changes offsets) it keeps the start of the text.
 *
 * Complexity: one `indexOf` scan per term, O(n·T), plus a sort of the m occurrence offsets and a two-pointer sweep
 * over them: O(n·T + m log m). Cutting then looks only at the slack around the chosen window, O(limit).
 */
export function windowExcerpt(text: string, terms: readonly string[], limit: number): WindowedExcerpt {
  if (text.length <= limit) return { text, truncated: false };
  const lower = text.toLowerCase();
  if (lower.length !== text.length) return headOf(text, limit);

  const occurrences: Array<{ start: number; end: number }> = [];
  for (const term of terms) {
    if (!term) continue;
    for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + 1)) {
      occurrences.push({ start: at, end: at + term.length });
    }
  }
  if (occurrences.length === 0) return headOf(text, limit);
  occurrences.sort((left, right) => left.start - right.start || left.end - right.end);

  // Room for the text itself once both ellipses are reserved.
  const budget = Math.max(1, limit - 2 * ELLIPSIS.length);
  // Two pointers: the window [from, to] holds the occurrences whose span (first start to the end of the newest
  // occurrence) fits the budget; keep the earliest window with the most occurrences.
  let bestFrom = 0;
  let bestTo = 0;
  let from = 0;
  for (let to = 0; to < occurrences.length; to += 1) {
    while (from < to && occurrences[to]!.end - occurrences[from]!.start > budget) from += 1;
    if (to - from > bestTo - bestFrom) {
      bestFrom = from;
      bestTo = to;
    }
  }
  return cutAround(text, occurrences, bestFrom, bestTo, budget, limit);
}

function cutAround(
  text: string,
  occurrences: ReadonlyArray<{ start: number; end: number }>,
  bestFrom: number,
  bestTo: number,
  budget: number,
  limit: number,
): WindowedExcerpt {
  const firstStart = occurrences[bestFrom]!.start;
  let lastEnd = 0;
  for (let k = bestFrom; k <= bestTo; k += 1) lastEnd = Math.max(lastEnd, occurrences[k]!.end);
  lastEnd = Math.min(lastEnd, firstStart + budget);
  const span = lastEnd - firstStart;
  const centered = firstStart - Math.floor((budget - span) / 2);
  let start = Math.max(0, Math.min(centered, text.length - budget));
  if (start > firstStart) start = firstStart;
  if (start > 0) {
    start = snapStart(text, start, firstStart);
    if (isLowSurrogate(text.charCodeAt(start))) start = Math.max(0, start - 1);
  }
  let end = Math.min(text.length, start + budget);
  if (end < text.length) {
    end = snapEnd(text, Math.min(lastEnd, end), end);
    if (isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  }
  const body = text.slice(start, end).trim();
  const truncated = start > 0 || end < text.length;
  const result = `${start > 0 ? ELLIPSIS : ""}${body}${end < text.length ? ELLIPSIS : ""}`;
  return { text: result.length <= limit ? result : result.slice(0, limit), truncated };
}
