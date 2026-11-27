/** Node.js built-ins only: the version check runs before the bundled CLI loads, which needs node:sqlite with FTS5. */

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/** A range in a form other than `||`-separated comparators, or an unparsable version, counts as satisfied rather than blocking. */
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
