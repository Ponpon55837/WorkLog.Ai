/**
 * SQLite announced a WAL-reset database corruption bug (March 2026), present since WAL mode arrived in 3.7.0. It is
 * fixed in 3.51.3 and was backported to 3.50.7 and 3.44.6; every release from 3.7.0 up to the fix on its own line is
 * affected. Versions below 3.7.0 predate WAL, but are ancient and unsupported by node:sqlite, so they are reported as
 * affected too (a deliberate simplification: this check exists to reject old SQLite builds, not to prove safety).
 */
export interface SqliteVersion {
  major: number;
  minor: number;
  patch: number;
}

export interface SqliteWalResetAssessment {
  /** The normalized `major.minor.patch` string, or the trimmed input when it could not be parsed. */
  version: string;
  /** True when the version may corrupt a WAL database, or cannot be recognized (fail safe). */
  affected: boolean;
  /** The first fixed release on the version's line; omitted when the version is already fixed or unparsable. */
  fixedIn?: string;
  /** False for a version string that is not `major.minor.patch`; such input is treated as affected. */
  recognized: boolean;
}

/** Fixed releases, oldest first. A version is patched at or above the newest fix, or at or above the fix of its own minor line. */
const WAL_RESET_FIXES: readonly SqliteVersion[] = [
  { major: 3, minor: 44, patch: 6 },
  { major: 3, minor: 50, patch: 7 },
  { major: 3, minor: 51, patch: 3 },
];
/** The first release with WAL mode, where the bug was introduced. */
const WAL_INTRODUCED: SqliteVersion = { major: 3, minor: 7, patch: 0 };
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:\.\d+)?$/;

function formatVersion(version: SqliteVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function compareVersions(left: SqliteVersion, right: SqliteVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

/** Parses `3.51.3` (an optional fourth component such as `3.45.1.1` is ignored); returns null for anything else. */
export function parseSqliteVersion(value: string): SqliteVersion | null {
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) return null;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return [major, minor, patch].every(Number.isSafeInteger) ? { major, minor, patch } : null;
}

/**
 * Whether a SQLite version carries the WAL-reset corruption bug. Unparsable input is reported as affected with
 * `recognized: false` so a check never passes on a version it cannot read.
 */
export function assessSqliteWalResetFix(version: string): SqliteWalResetAssessment {
  const parsed = parseSqliteVersion(version);
  if (!parsed) return { version: version.trim(), affected: true, recognized: false };

  const normalized = formatVersion(parsed);
  if (compareVersions(parsed, WAL_INTRODUCED) < 0) return { version: normalized, affected: true, recognized: true };

  const patched = WAL_RESET_FIXES.some(
    (fix, index) =>
      compareVersions(parsed, fix) >= 0 &&
      (index === WAL_RESET_FIXES.length - 1 || (parsed.major === fix.major && parsed.minor === fix.minor)),
  );
  if (patched) return { version: normalized, affected: false, recognized: true };

  // The smallest fixed release above this version is the nearest safe upgrade (3.45 to 3.50 have no backport).
  const fixedIn = WAL_RESET_FIXES.find((fix) => compareVersions(fix, parsed) > 0)!;
  return { version: normalized, affected: true, fixedIn: formatVersion(fixedIn), recognized: true };
}
