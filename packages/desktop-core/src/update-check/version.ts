/** A release tag is exactly `vMAJOR.MINOR.PATCH`; anything with a suffix or a different shape is not a stable release. */
const TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/;
/** The running version: the same core, optionally followed by a pre-release or build suffix (`1.6.53-dev`). */
const RUNNING_PATTERN = /^(\d+)\.(\d+)\.(\d+)([-+].*)?$/;

export interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export interface ParsedTag extends Semver {
  readonly tag: string;
  /** `X.Y.Z` as written in the tag (the installer names use it). */
  readonly version: string;
}

export interface RunningVersion extends Semver {
  /** The running build is a pre-release or development build (`x.y.z-suffix`). */
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

/** Numeric comparison of the cores: negative when `a` is older than `b`. */
export function compareSemver(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Whether `release` is newer than what runs. A pre-release or development build counts as older than the stable release
 * with the same core, so `1.6.53-dev` is offered `v1.6.53`.
 */
export function isNewerThanRunning(release: Semver, running: RunningVersion): boolean {
  const order = compareSemver(release, running);
  return order > 0 || (order === 0 && running.preRelease);
}
