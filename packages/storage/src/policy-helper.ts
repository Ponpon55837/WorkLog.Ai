import type { PolicyDecision, ProjectIdSkippedResult, ProjectReader, ProjectRecord, SkippedResult } from "@work-intelligence/core";
import type { ProjectPolicyGate } from "@work-intelligence/project-policy";

export interface ProjectByIdReader extends ProjectReader {
  getProjectById(projectId: string): ProjectRecord | undefined;
}

/** Keep all storage policy lookups on one path so repositories cannot drift. */
export function checkTrackedProjectByRoot(gate: ProjectPolicyGate, projectRoot: string): PolicyDecision {
  return gate.check(projectRoot);
}

export function checkTrackedProjectById(
  gate: ProjectPolicyGate,
  reader: ProjectByIdReader,
  projectId: string
): PolicyDecision {
  const project = reader.getProjectById(projectId);
  return project
    ? gate.check(project.rootPath)
    : {
        allowed: false,
        projectStatus: "unregistered",
        canonicalRoot: "",
        reason: "Project is not registered."
      };
}

export function skippedByRoot(decision: PolicyDecision): SkippedResult {
  return {
    outcome: "skipped",
    projectRoot: decision.canonicalRoot,
    projectStatus: decision.projectStatus,
    reason: decision.reason ?? "Project recording is not enabled."
  };
}

export function skippedByProjectId(projectId: string, decision?: PolicyDecision): ProjectIdSkippedResult {
  return {
    outcome: "skipped",
    projectId,
    projectStatus: decision?.projectStatus ?? "unregistered",
    reason: decision?.reason ?? "Project recording is not enabled."
  };
}

export function trackedProject(decision: PolicyDecision | undefined): ProjectRecord | undefined {
  return decision?.allowed ? decision.project : undefined;
}
