import type { PolicyDecision, ProjectRecord } from "../../packages/core/src/index.js";
import { describe, expect, it, vi } from "vitest";
import {
  checkTrackedProjectById,
  checkTrackedProjectByRoot,
  skippedByProjectId,
  skippedByRoot,
  trackedProject,
} from "../../packages/storage/src/policy-helper.js";

// Fictional fixtures only: the gate and reader are stubs, no filesystem is touched.
const project = { id: "project-1", name: "Apiary", rootPath: "/fictional/apiary" } as ProjectRecord;
const denied: PolicyDecision = {
  allowed: false,
  projectStatus: "paused",
  canonicalRoot: "/fictional/apiary",
  reason: "Project recording is paused.",
};

type ProjectPolicyGate = Parameters<typeof checkTrackedProjectByRoot>[0];

function gateReturning(decision: PolicyDecision) {
  const check = vi.fn(() => decision);
  return { gate: { check } as unknown as ProjectPolicyGate, check };
}

describe("storage policy helpers", () => {
  it("delegates root lookups to the gate unchanged", () => {
    const { gate, check } = gateReturning(denied);
    expect(checkTrackedProjectByRoot(gate, "/fictional/apiary")).toBe(denied);
    expect(check).toHaveBeenCalledWith("/fictional/apiary");
  });

  it("checks a known project by its stored root and never asks the gate for an unknown id", () => {
    const { gate, check } = gateReturning(denied);
    const reader = { getProjectById: (id: string) => (id === project.id ? project : undefined) };

    expect(checkTrackedProjectById(gate, reader as never, project.id)).toBe(denied);
    expect(check).toHaveBeenCalledWith(project.rootPath);

    check.mockClear();
    expect(checkTrackedProjectById(gate, reader as never, "missing")).toEqual({
      allowed: false,
      projectStatus: "unregistered",
      canonicalRoot: "",
      reason: "Project is not registered.",
    });
    expect(check).not.toHaveBeenCalled();
  });

  it("builds quiet skipped results with a default reason when the gate gave none", () => {
    expect(skippedByRoot(denied)).toEqual({
      outcome: "skipped",
      projectRoot: "/fictional/apiary",
      projectStatus: "paused",
      reason: "Project recording is paused.",
    });
    expect(skippedByRoot({ ...denied, reason: undefined }).reason).toBe("Project recording is not enabled.");
    expect(skippedByProjectId("project-1", denied)).toEqual({
      outcome: "skipped",
      projectId: "project-1",
      projectStatus: "paused",
      reason: "Project recording is paused.",
    });
    expect(skippedByProjectId("project-2")).toEqual({
      outcome: "skipped",
      projectId: "project-2",
      projectStatus: "unregistered",
      reason: "Project recording is not enabled.",
    });
  });

  it("returns a project only for an allowed decision", () => {
    expect(trackedProject(undefined)).toBeUndefined();
    expect(trackedProject(denied)).toBeUndefined();
    expect(trackedProject({ allowed: true, projectStatus: "tracked", canonicalRoot: project.rootPath, project })).toBe(
      project,
    );
  });
});
