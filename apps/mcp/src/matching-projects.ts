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
