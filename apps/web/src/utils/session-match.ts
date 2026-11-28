import type { WorkSessionRecord, WorkSummarySections } from "@work-intelligence/core";
import { matchExcerpt, searchTerms } from "./highlight";

export type MatchedField = "summary" | keyof WorkSummarySections | "changedFiles";

type SessionMatch = { kind: "excerpt"; field: MatchedField; text: string } | { kind: "events" };

const SECTION_KEYS = ["outcomes", "scope", "decisions", "verification", "nextSteps"] as const;

const includesAny = (text: string, terms: string[]): boolean => {
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term));
};

/**
 * Where a search matched when the row's own text does not show it. The server also matches events, which the list does not
 * carry, so a match found in none of the fields the list has is reported as an event match.
 */
export function findSessionMatch(
  session: WorkSessionRecord,
  query: string,
  visibleTexts: string[],
): SessionMatch | undefined {
  const terms = searchTerms(query);
  if (terms.length === 0) return undefined;
  const hidden = terms.filter((term) => !visibleTexts.some((text) => text.toLowerCase().includes(term)));
  if (hidden.length === 0) return undefined;
  const candidates: Array<[MatchedField, string]> = [
    ["summary", session.summary],
    ...SECTION_KEYS.flatMap((key): Array<[MatchedField, string]> =>
      (session.workSummary?.[key] ?? []).map((line) => [key, line]),
    ),
    ...session.changedFiles.map((file): [MatchedField, string] => ["changedFiles", file]),
  ];
  for (const [field, text] of candidates) {
    if (!includesAny(text, hidden)) continue;
    const excerpt = matchExcerpt(text, hidden);
    if (excerpt) return { kind: "excerpt", field, text: excerpt };
  }
  return { kind: "events" };
}
