import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ProjectRecord, ProjectStatus } from "@work-intelligence/core";
import { nowIso } from "@work-intelligence/shared";
import { canonicalizeProjectRoot } from "@work-intelligence/project-policy";

export type ProjectRow = {
  id: string;
  name: string;
  root_path: string;
  status: ProjectStatus;
  created_at: string;
  updated_at: string;
  last_ingested_at: string | null;
};

export function toProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastIngestedAt: row.last_ingested_at ?? undefined,
  };
}

/**
 * Project Registry persistence. Policy decisions stay in ProjectPolicyGate;
 * this repository only owns registry reads and writes.
 */
export class ProjectRepository {
  public constructor(private readonly db: DatabaseSync) {}

  public getByRootPath(rootPath: string): ProjectRecord | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE root_path = ?").get(canonicalizeProjectRoot(rootPath)) as
      ProjectRow | undefined;
    return row ? toProject(row) : undefined;
  }

  public getById(projectId: string): ProjectRecord | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow | undefined;
    return row ? toProject(row) : undefined;
  }

  public list(): ProjectRecord[] {
    const rows = this.db.prepare("SELECT * FROM projects ORDER BY updated_at DESC, name ASC").all() as ProjectRow[];
    return rows.map(toProject);
  }

  public add(name: string, rootPath: string): ProjectRecord {
    const canonicalRoot = canonicalizeProjectRoot(rootPath);
    const existing = this.getByRootPath(canonicalRoot);
    if (existing) {
      return existing;
    }

    const now = nowIso();
    const project: ProjectRecord = {
      id: randomUUID(),
      name: name.trim(),
      rootPath: canonicalRoot,
      status: "unregistered",
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO projects (id, name, root_path, status, created_at, updated_at)
         VALUES (@id, @name, @rootPath, @status, @createdAt, @updatedAt)`,
      )
      .run({
        id: project.id,
        name: project.name,
        rootPath: project.rootPath,
        status: project.status,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      });
    return project;
  }

  public update(projectId: string, update: { name?: string; status?: ProjectStatus }): ProjectRecord | undefined {
    const existing = this.getById(projectId);
    if (!existing) {
      return undefined;
    }

    const next: ProjectRecord = {
      ...existing,
      name: update.name?.trim() || existing.name,
      status: update.status ?? existing.status,
      updatedAt: nowIso(),
    };

    this.db
      .prepare(
        `UPDATE projects
         SET name = @name, status = @status, updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({ id: projectId, name: next.name, status: next.status, updatedAt: next.updatedAt });
    return next;
  }
}
