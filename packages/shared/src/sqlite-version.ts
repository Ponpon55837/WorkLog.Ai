export interface SqliteVersion {
  major: number;
  minor: number;
  patch: number;
}

export interface SqliteWalResetAssessment {
  version: string;
  affected: boolean;
  fixedIn?: string;
  recognized: boolean;
}

const WAL_RESET_FIXES: readonly SqliteVersion[] = [
  { major: 3, minor: 44, patch: 6 },
  { major: 3, minor: 50, patch: 7 },
  { major: 3, minor: 51, patch: 3 },
];
const WAL_INTRODUCED: SqliteVersion = { major: 3, minor: 7, patch: 0 };
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:\.\d+)?$/;

function formatVersion(version: SqliteVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function compareVersions(left: SqliteVersion, right: SqliteVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

export function parseSqliteVersion(value: string): SqliteVersion | null {
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) return null;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return [major, minor, patch].every(Number.isSafeInteger) ? { major, minor, patch } : null;
}

/** Fail safe: an unparsable version, or one older than WAL (3.7.0), is reported as affected. */
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

  const fixedIn = WAL_RESET_FIXES.find((fix) => compareVersions(fix, parsed) > 0)!;
  return { version: normalized, affected: true, fixedIn: formatVersion(fixedIn), recognized: true };
}
