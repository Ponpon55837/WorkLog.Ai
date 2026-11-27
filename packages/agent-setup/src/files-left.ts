import type { AgentSetupTransactionResult } from "./apply.js";

export function filesLeftByTransaction(applied: Pick<AgentSetupTransactionResult, "items">): string[] {
  const left = applied.items.filter(
    (item) =>
      item.compensation === "manual-repair" || item.compensation === "not-attempted" || item.compensation === "failed",
  );
  const modified = applied.items.filter((item) => item.status === "externally-modified");
  const named = [...new Set([...left, ...modified].map((item) => item.path))];
  if (named.length > 0) return named;
  // Never an empty list for an unfinished repair: fall back to every file that was written.
  return [...new Set(applied.items.filter((item) => item.status === "written").map((item) => item.path))];
}
