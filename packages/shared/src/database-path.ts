import { posix, win32 } from "node:path";

export interface ResolveDatabasePathOptions {
  baseDirectory: string;
  fallback: string;
  platform?: NodeJS.Platform;
}

const DRIVE_RELATIVE_PATH = /^[A-Za-z]:(?![\\/])/;

function pathApi(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

/**
 * A Windows drive-relative path such as `C:Users\me\data.sqlite`: what a shell leaves after swallowing backslashes; it
 * silently points at the current directory of drive C.
 */
export function isDriveRelativePath(value: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && DRIVE_RELATIVE_PATH.test(value.trim());
}

export function assertNotDriveRelativePath(value: string, platform: NodeJS.Platform = process.platform): void {
  if (!isDriveRelativePath(value, platform)) return;
  throw new Error(
    `WORK_INTELLIGENCE_DB 的值「${value.trim()}」是磁碟相對路徑，反斜線可能被 shell 吃掉了；請改用正斜線，或以引號包住完整絕對路徑。`,
  );
}

export function resolveDatabasePath(raw: string | undefined, options: ResolveDatabasePathOptions): string {
  const platform = options.platform ?? process.platform;
  const path = pathApi(platform);
  const value = raw?.trim();
  if (!value) return options.fallback;
  if (value === ":memory:") return value;
  assertNotDriveRelativePath(value, platform);
  return path.resolve(options.baseDirectory, value);
}
