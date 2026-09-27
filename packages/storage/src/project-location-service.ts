import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ProjectRecord } from "@work-intelligence/core";
import { nowIso } from "@work-intelligence/shared";
import { canonicalizeProjectRoot, isPathWithinProject } from "@work-intelligence/project-policy";
import { ProjectRepository } from "./project-repository.js";
import { remapPathPrefix } from "./project-path-remap.js";
import { runImmediateTransaction } from "./sqlite-transaction.js";

export type ProjectLocationErrorCode =
  "project_not_found" | "project_location_confirmation_required" | "project_location_conflict";

export class ProjectLocationError extends Error {
  public constructor(public readonly code: ProjectLocationErrorCode) {
    super(code);
    this.name = "ProjectLocationError";
  }
}

type SnapshotPathRow = { id: string; source_path: string | null };
type ProjectRootRow = { id: string; root_path: string };

function rootsOverlap(left: string, right: string): boolean {
  return isPathWithinProject(left, right) || isPathWithinProject(right, left);
}

/** Updates a project's local root and dependent handoff paths as one audited transaction. */
export class ProjectLocationService {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly projects: ProjectRepository,
  ) {}

  public updateLocation(projectId: string, rootPath: string, confirmedTrackedScope = false): ProjectRecord {
    const nextRoot = canonicalizeProjectRoot(rootPath);
    return runImmediateTransaction(this.db, () => {
      const current = this.projects.getById(projectId);
      if (!current) {
        throw new ProjectLocationError("project_not_found");
      }
      if (current.status === "tracked" && !confirmedTrackedScope) {
        throw new ProjectLocationError("project_location_confirmation_required");
      }
      if (nextRoot === current.rootPath) {
        return current;
      }

      const roots = this.db
        .prepare("SELECT id, root_path FROM projects WHERE id <> ? ORDER BY id")
        .all(projectId) as ProjectRootRow[];
      if (roots.some((project) => rootsOverlap(nextRoot, project.root_path))) {
        throw new ProjectLocationError("project_location_conflict");
      }

      const updatedAt = nowIso();
      let updated: ProjectRecord;
      try {
        updated = this.projects.updateRootPath(projectId, nextRoot, updatedAt);
      } catch {
        // The immediate transaction prevents concurrent writes, but retain a safe conflict response
        // for an existing exact-root uniqueness constraint or an older database invariant.
        throw new ProjectLocationError("project_location_conflict");
      }

      const updateSnapshot = this.db.prepare("UPDATE raw_snapshots SET source_path = ? WHERE id = ?");
      const snapshots = this.db
        .prepare("SELECT id, source_path FROM raw_snapshots WHERE project_id = ? ORDER BY id")
        .all(projectId) as SnapshotPathRow[];
      const mapping = { from: current.rootPath, to: nextRoot };
      for (const snapshot of snapshots) {
        if (snapshot.source_path === null) continue;
        const moved = remapPathPrefix(snapshot.source_path, mapping);
        if (moved !== snapshot.source_path) {
          updateSnapshot.run(moved, snapshot.id);
        }
      }

      this.db
        .prepare(
          `INSERT INTO project_location_audit (id, changed_at, project_id, paths_changed)
           VALUES (?, ?, ?, 1)`,
        )
        .run(randomUUID(), updatedAt, projectId);
      return updated;
    });
  }
}
