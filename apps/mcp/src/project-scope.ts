/** The one copy of a scoped response's project: enough to name it and to scope later calls with projectRoot. */
export interface ScopeProject {
  id: string;
  name: string;
  rootPath: string;
}

/** The project that every item of a scoped list shares, named once instead of on each item. */
export interface ItemProject {
  id: string;
  name?: string;
}

type ProjectFields = { projectId: string; projectName?: string };
type WithoutProjectFields<T> = Omit<T, "projectId" | "projectName">;

export function scopeProject(project: ScopeProject): ScopeProject {
  return { id: project.id, name: project.name, rootPath: project.rootPath };
}

export function withoutProjectFields<T extends ProjectFields>(item: T): WithoutProjectFields<T> {
  const { projectId: _projectId, projectName: _projectName, ...rest } = item;
  return rest;
}

/**
 * Moves the project fields that every item of a scoped list repeats to one top-level copy. Items of more than one
 * project, or an empty list, are returned unchanged, so no item ever loses the project it belongs to.
 */
export function hoistItemProject<T extends ProjectFields>(
  items: readonly T[],
): { project?: ItemProject; items: Array<T | WithoutProjectFields<T>> } {
  const [first] = items;
  if (!first || items.some((item) => item.projectId !== first.projectId || item.projectName !== first.projectName)) {
    return { items: [...items] };
  }
  return {
    project: { id: first.projectId, ...(first.projectName ? { name: first.projectName } : {}) },
    items: items.map(withoutProjectFields),
  };
}
