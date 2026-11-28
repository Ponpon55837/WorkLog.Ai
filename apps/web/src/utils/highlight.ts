import { parseListSearchTerms } from "@work-intelligence/core";

interface HighlightSegment {
  text: string;
  match: boolean;
}

const escapePattern = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The words the server matches for this query: quoted phrases kept together, lowercased, capped. */
export function searchTerms(query: string): string[] {
  return parseListSearchTerms(query).terms;
}

function termPattern(terms: string[]): RegExp {
  const longestFirst = [...terms].sort((a, b) => b.length - a.length);
  return new RegExp(`(${longestFirst.map(escapePattern).join("|")})`, "giu");
}

export function highlightSegments(text: string, query: string): HighlightSegment[] {
  const terms = searchTerms(query);
  if (!text || terms.length === 0) return [{ text, match: false }];
  return text
    .split(termPattern(terms))
    .map((part, index) => ({ text: part, match: index % 2 === 1 }))
    .filter((segment) => segment.text !== "");
}

/** One line around the first match, with ellipses where the text was cut. */
export function matchExcerpt(text: string, terms: string[], before = 24, after = 56): string | undefined {
  const flat = text.replace(/\s+/g, " ").trim();
  const found = terms.length > 0 ? termPattern(terms).exec(flat) : null;
  if (!found) return undefined;
  const start = Math.max(0, found.index - before);
  const end = Math.min(flat.length, found.index + found[0].length + after);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}
