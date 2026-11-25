import type { WorkIntelligenceStore } from "@work-intelligence/storage";

type MatchingProject = ReturnType<WorkIntelligenceStore["matchingProjects"]>[number];

const MATCHING_PROJECTS_REASON =
  " matchingProjects lists registered projects whose folder or name matches this path, or that contain it or sit " +
  "inside it: ask the user whether one is meant. Never switch to one yourself.";

function isUnregisteredAnswer(value: unknown): value is Record<string, unknown> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { projectStatus?: unknown }).projectStatus === "unregistered"
  );
}

/**
 * An answer refused because the Agent's projectRoot is not registered gains the registered projects it may have meant
 * (a moved folder, another computer, a mistyped path, a call from a subfolder): registry name, root and status only.
 * Nothing else changes, so an answer without a match keeps its exact size, and the lookup runs only after a refusal.
 */
export function withMatchingProjects(
  result: unknown,
  projectRoot: string | undefined,
  lookup: (projectRoot: string) => MatchingProject[],
): unknown {
  if (!projectRoot || !isUnregisteredAnswer(result)) return result;
  const matchingProjects = lookup(projectRoot);
  if (matchingProjects.length === 0) return result;
  return {
    ...result,
    ...(typeof result.reason === "string" ? { reason: result.reason + MATCHING_PROJECTS_REASON } : {}),
    matchingProjects,
  };
}
