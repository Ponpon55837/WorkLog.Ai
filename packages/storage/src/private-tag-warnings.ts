import type { FinalizeSessionInput, PrivateTagWarnings } from "@work-intelligence/core";
import { countUnclosedPrivateTags } from "./secret-redaction.js";

const MAX_LISTED_FIELDS = 10;
const PRIVATE_TAG_WARNING_MESSAGE =
  "An opening <private> tag has no closing tag, so the text was saved as written. Resend it with the closing tag if it holds private content.";

type TextFields = Pick<
  FinalizeSessionInput,
  "title" | "summary" | "workSummary" | "verification" | "events" | "handoffContent" | "diagrams"
>;

function collectUnclosed(value: unknown, path: string, found: Array<{ path: string; count: number }>): void {
  if (typeof value === "string") {
    const count = countUnclosedPrivateTags(value);
    if (count > 0) found.push({ path, count });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => collectUnclosed(item, `${path}[${index}]`, found));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) collectUnclosed(item, path ? `${path}.${key}` : key, found);
  }
}

/** Names the finalize text fields with an unclosed `<private>` tag; never repeats their content. */
export function findUnclosedPrivateTags(input: TextFields): PrivateTagWarnings | undefined {
  const found: Array<{ path: string; count: number }> = [];
  const { title, summary, workSummary, verification, events, handoffContent, diagrams } = input;
  collectUnclosed({ title, summary, workSummary, verification, events, handoffContent, diagrams }, "", found);
  if (found.length === 0) return undefined;
  return {
    fields: found.slice(0, MAX_LISTED_FIELDS).map(({ path }) => path),
    unclosed: found.reduce((total, { count }) => total + count, 0),
    message: PRIVATE_TAG_WARNING_MESSAGE,
  };
}
