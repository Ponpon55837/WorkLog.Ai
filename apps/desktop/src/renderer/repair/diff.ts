/**
 * What the periodic poll uses to redraw only what changed: a key made of just the inputs a section draws from, compared
 * with the key of its last draw. The key is stable, so the order of an object's fields never makes a difference.
 */
export function stableKey(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    const sorted: Record<string, unknown> = {};
    for (const name of Object.keys(item).sort()) sorted[name] = (item as Record<string, unknown>)[name];
    return sorted;
  });
}

export interface ChangeTracker {
  /** True when `input` differs from the one last recorded under `name` (always true the first time); records it. */
  changed(name: string, input: unknown): boolean;
  /** Forgets `name`, so its next `changed` answers true (the section was taken out of the page). */
  forget(name: string): void;
}

export function createChangeTracker(): ChangeTracker {
  const keys = new Map<string, string>();
  return {
    changed(name, input) {
      const key = stableKey(input);
      if (keys.get(name) === key) return false;
      keys.set(name, key);
      return true;
    },
    forget(name) {
      keys.delete(name);
    },
  };
}
