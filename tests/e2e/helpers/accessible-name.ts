/**
 * Matcher for an accessible name that is computed from visible content: the name must start with `label` and then
 * end or continue after whitespace, so "Node 199" never matches "Node 1990". The label is escaped because test data
 * may contain regex metacharacters (the malicious architecture label does).
 */
export function nameStartingWith(label: string): RegExp {
  return new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`);
}
