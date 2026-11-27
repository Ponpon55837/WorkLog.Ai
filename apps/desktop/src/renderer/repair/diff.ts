export function stableKey(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    const sorted: Record<string, unknown> = {};
    for (const name of Object.keys(item).sort()) sorted[name] = (item as Record<string, unknown>)[name];
    return sorted;
  });
}

export interface ChangeTracker {
  changed(name: string, input: unknown): boolean;
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
