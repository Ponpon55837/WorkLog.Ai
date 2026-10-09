export interface RelatedWorkResult {
  outcome: "related_work";
  sessionId: string;
  state: "ready" | "unavailable";
  reason?: "source_unavailable" | "files_unconfirmed" | "no_files" | "too_many_files";
  coverage: { partial: boolean; postingLimit: number; examined: number };
  items: Array<{
    id: string;
    title: string;
    completedAt: string;
    sharedCount: number;
    sharedPaths: string[];
    pathsOmitted: number;
  }>;
}
