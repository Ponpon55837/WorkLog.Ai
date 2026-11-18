/** A number of a version core: no leading zeros (`053` is not a version), as semver says. */
const NUMBER = String.raw`(0|[1-9]\d*)`;
/** A release tag is exactly `vMAJOR.MINOR.PATCH`; anything with a suffix or a different shape is not a stable release. */
const TAG_PATTERN = new RegExp(`^v${NUMBER}\\.${NUMBER}\\.${NUMBER}$`);
/**
 * The running version: the same core, optionally followed by a pre-release part (`-dev`) and build metadata (`+build`).
 * Capture 4 is the pre-release part. Build metadata does not make a build older, so `1.6.53+x` is the release itself.
 */
const RUNNING_PATTERN = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}(-[^+]*)?(\\+.*)?$`);

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
  /** The running build is a pre-release or development build (`x.y.z-suffix`); build metadata (`+x`) is not. */
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
 * with the same core, so `1.6.53-dev` is offered `v1.6.53`; a build of the release itself (`1.6.53+x`) is not.
 */
export function isNewerThanRunning(release: Semver, running: RunningVersion): boolean {
  const order = compareSemver(release, running);
  return order > 0 || (order === 0 && running.preRelease);
}
