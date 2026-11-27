/** "Node 199" must never match "Node 1990"; the label is escaped because test data may hold regex metacharacters. */
export function nameStartingWith(label: string): RegExp {
  return new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`);
}
