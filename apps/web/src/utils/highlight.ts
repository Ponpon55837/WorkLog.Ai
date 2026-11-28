interface HighlightSegment {
  text: string;
  match: boolean;
}

const escapePattern = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function searchTerms(query: string): string[] {
  return [...new Set(query.split(/\s+/).filter(Boolean))].sort((a, b) => b.length - a.length);
}

export function highlightSegments(text: string, query: string): HighlightSegment[] {
  const terms = searchTerms(query);
  if (!text || terms.length === 0) return [{ text, match: false }];
  const pattern = new RegExp(`(${terms.map(escapePattern).join("|")})`, "giu");
  return text
    .split(pattern)
    .map((part, index) => ({ text: part, match: index % 2 === 1 }))
    .filter((segment) => segment.text !== "");
}

export function hasHighlight(text: string, query: string): boolean {
  return highlightSegments(text, query).some((segment) => segment.match);
}
