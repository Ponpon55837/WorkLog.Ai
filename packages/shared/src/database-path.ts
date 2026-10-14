import { posix, win32 } from "node:path";

export interface ResolveDatabasePathOptions {
  /** Relative paths resolve against this directory (the repository root), not the process cwd. */
  baseDirectory: string;
  /** Used when the value is missing or blank. */
  fallback: string;
  /** Path rules to apply; defaults to the running platform. */
  platform?: NodeJS.Platform;
}

const DRIVE_RELATIVE_PATH = /^[A-Za-z]:(?![\\/])/;

function pathApi(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

/**
 * True for a Windows drive-relative path such as `C:Users\me\data.sqlite`. It is what a shell leaves behind when it
 * swallows the backslashes of `C:\Users\me\data.sqlite`, and it silently points at the current directory of drive C.
 */
export function isDriveRelativePath(value: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && DRIVE_RELATIVE_PATH.test(value.trim());
}

/** Throws a Traditional Chinese error when the value is a drive-relative path; otherwise does nothing. */
export function assertNotDriveRelativePath(value: string, platform: NodeJS.Platform = process.platform): void {
  if (!isDriveRelativePath(value, platform)) return;
  throw new Error(
    `WORK_INTELLIGENCE_DB 的值「${value.trim()}」是磁碟相對路徑，反斜線可能被 shell 吃掉了；請改用正斜線，或以引號包住完整絕對路徑。`,
  );
}

/**
 * Resolves WORK_INTELLIGENCE_DB the same way for every entry point: blank means the fallback, `:memory:` stays as is,
 * relative paths hang off the base directory, and a drive-relative path is rejected instead of guessed.
 */
export function resolveDatabasePath(raw: string | undefined, options: ResolveDatabasePathOptions): string {
  const platform = options.platform ?? process.platform;
  const path = pathApi(platform);
  const value = raw?.trim();
  if (!value) return options.fallback;
  if (value === ":memory:") return value;
  assertNotDriveRelativePath(value, platform);
  return path.resolve(options.baseDirectory, value);
}
