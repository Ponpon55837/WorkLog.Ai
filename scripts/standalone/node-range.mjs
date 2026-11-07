/**
 * Node.js built-ins only: the `work-intelligence` command checks the version before it loads the bundled CLI, which
 * needs node:sqlite with FTS5. Copied next to bin/work-intelligence.mjs by scripts/build-standalone.mjs.
 */

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/**
 * True when `version` satisfies a range made of `||`-separated sets of `>=x.y.z` / `<x[.y[.z]]` comparators, the form
 * packages/shared's SUPPORTED_NODE_RANGE uses. A range in any other form is treated as satisfied rather than blocking,
 * and so is an unparsable version.
 */
export function satisfiesNodeRange(range, version) {
  const actual = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim());
  if (!actual) return true;
  const current = actual.slice(1, 4).map(Number);
  let understood = true;
  const matches = range.split("||").map((set) =>
    set
      .trim()
      .split(/\s+/)
      .every((comparator) => {
        const match = /^(>=|<)(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(comparator);
        if (!match) {
          understood = false;
          return false;
        }
        const bound = [match[2], match[3] ?? 0, match[4] ?? 0].map(Number);
        const order = compareVersions(current, bound);
        return match[1] === ">=" ? order >= 0 : order < 0;
      }),
  );
  return !understood || matches.some(Boolean);
}
