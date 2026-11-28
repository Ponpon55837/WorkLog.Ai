import type { ProjectRecord, WorkSessionRecord } from "@work-intelligence/core";

/** The tracked project with the newest Session, or else the one ingested or changed last. */
export function latestTrackedProjectId(
  recentSessions: Array<Pick<WorkSessionRecord, "projectId">>,
  trackedProjects: Array<Pick<ProjectRecord, "id" | "lastIngestedAt" | "updatedAt">>,
): string | undefined {
  const tracked = new Set(trackedProjects.map((project) => project.id));
  const recent = recentSessions.find((session) => tracked.has(session.projectId));
  if (recent) return recent.projectId;
  const [latest] = [...trackedProjects].sort((a, b) =>
    (b.lastIngestedAt ?? b.updatedAt).localeCompare(a.lastIngestedAt ?? a.updatedAt),
  );
  return latest?.id;
}
