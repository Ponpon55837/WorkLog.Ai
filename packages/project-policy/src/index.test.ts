import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { ProjectRecord } from "@work-intelligence/core";
import { canonicalizeProjectRoot, isPathWithinProject, ProjectPolicyGate, safeProjectPath } from "./index.js";

function project(status: ProjectRecord["status"]): ProjectRecord {
  return {
    id: "project-1",
    name: "Tracked project",
    rootPath: canonicalizeProjectRoot("C:/work/tracked"),
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("ProjectPolicyGate", () => {
  it("denies unknown projects before any project data access", () => {
    const gate = new ProjectPolicyGate({ getProjectByRootPath: () => undefined });
    const decision = gate.check("C:/work/unknown");

    expect(decision.allowed).toBe(false);
    expect(decision.projectStatus).toBe("unregistered");
    expect(decision.reason).toContain("not registered");
  });

  it.each(["unregistered", "paused", "ignored"] as const)("denies %s projects", (status) => {
    const record = project(status);
    const gate = new ProjectPolicyGate({ getProjectByRootPath: () => record });

    expect(gate.check(record.rootPath)).toMatchObject({ allowed: false, projectStatus: status });
  });

  it("allows only tracked projects and keeps source paths inside the root", () => {
    const record = project("tracked");
    const gate = new ProjectPolicyGate({ getProjectByRootPath: () => record });

    expect(gate.check(record.rootPath)).toMatchObject({ allowed: true, projectStatus: "tracked" });
    expect(isPathWithinProject(record.rootPath, "handoffs/closing.md")).toBe(true);
    expect(isPathWithinProject(record.rootPath, "../secrets.txt")).toBe(false);
    expect(safeProjectPath(record.rootPath, "handoffs/closing.md")).toContain("handoffs");
    expect(safeProjectPath(record.rootPath, "../secrets.txt")).toBeUndefined();
  });

  it("rejects existing symlink paths that resolve outside the project root", () => {
    const parent = mkdtempSync(join(tmpdir(), "work-intelligence-policy-"));
    const root = join(parent, "project");
    const outside = join(parent, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "must stay outside", "utf8");

    try {
      symlinkSync(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      rmSync(parent, { recursive: true, force: true });
      return;
    }

    try {
      expect(safeProjectPath(root, "linked/secret.txt")).toBeUndefined();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
