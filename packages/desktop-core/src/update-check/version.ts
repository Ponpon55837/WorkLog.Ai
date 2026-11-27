const NUMBER = String.raw`(0|[1-9]\d*)`;
const TAG_PATTERN = new RegExp(`^v${NUMBER}\\.${NUMBER}\\.${NUMBER}$`);
const RUNNING_PATTERN = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}(-[^+]*)?(\\+.*)?$`);

export interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export interface ParsedTag extends Semver {
  readonly tag: string;
  readonly version: string;
}

export interface RunningVersion extends Semver {
  readonly preRelease: boolean;
}

function numbers(match: RegExpExecArray): Semver | null {
  const [major, minor, patch] = [match[1], match[2], match[3]].map(Number);
  if (![major, minor, patch].every((part) => Number.isSafeInteger(part))) return null;
  return { major: major as number, minor: minor as number, patch: patch as number };
}

export function parseReleaseTag(tag: string): ParsedTag | null {
  const match = TAG_PATTERN.exec(tag);
  const parts = match ? numbers(match) : null;
  return parts ? { ...parts, tag, version: tag.slice(1) } : null;
}

export function parseRunningVersion(version: string): RunningVersion | null {
  const match = RUNNING_PATTERN.exec(version);
  const parts = match ? numbers(match) : null;
  return parts ? { ...parts, preRelease: match?.[4] !== undefined } : null;
}

export function compareSemver(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function isNewerThanRunning(release: Semver, running: RunningVersion): boolean {
  const order = compareSemver(release, running);
  return order > 0 || (order === 0 && running.preRelease);
}
