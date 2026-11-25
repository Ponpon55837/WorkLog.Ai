import { existsSync, promises as fsPromises, realpathSync } from "node:fs";
import { dirname, posix, relative, resolve, sep, win32 } from "node:path";
import type { PolicyDecision, ProjectReader } from "@work-intelligence/core";

export interface RegisteredRootCandidate {
  name: string;
  rootPath: string;
}

const PATH_SEPARATOR = /[\\/]/;

/** Lower-cased, without a trailing separator, so spellings that differ only in case or a final slash compare equal. */
function comparablePath(path: string): string {
  return path.toLowerCase().replace(/[\\/]+$/, "");
}

function pathIsInside(path: string, ancestor: string): boolean {
  return path.length > ancestor.length && path.startsWith(ancestor) && PATH_SEPARATOR.test(path[ancestor.length]!);
}

function segments(path: string): string[] {
  return path.split(PATH_SEPARATOR);
}

/**
 * How a registered root ties to an unmatched path, or undefined when nothing does: rank 0 the path is inside the root
 * (called from a subfolder), 1 the folder name or project name equals the path's folder name, 2 the root is inside
 * the path (called from a parent folder). Case is ignored; a filesystem root path matches by containment only.
 */
function rootMatch(path: string, candidate: RegisteredRootCandidate): { rank: number; distance: number } | undefined {
  const root = comparablePath(candidate.rootPath);
  const pathSegments = segments(path);
  const rootSegments = segments(root);
  const distance = Math.abs(pathSegments.length - rootSegments.length);
  if (root.length > 0 && pathIsInside(path, root)) return { rank: 0, distance };
  if (pathSegments.length < 2) return undefined;
  const folderName = pathSegments.at(-1);
  if (rootSegments.at(-1) === folderName || candidate.name.trim().toLowerCase() === folderName) {
    return { rank: 1, distance: 0 };
  }
  return pathIsInside(root, path) ? { rank: 2, distance } : undefined;
}

/**
 * The canonical form of a project root: the stored comparison key. On Windows the file system ignores case, so
 * the key is case-folded and is NOT the spelling the user typed; anything shown to a person must keep the original
 * spelling (the platform argument exists so both spellings can be unit-tested on any host).
 */
export function canonicalizeProjectRoot(input: string, platform: NodeJS.Platform = process.platform): string {
  const pathApi = platform === "win32" ? win32 : posix;
  const normalized = pathApi.normalize(pathApi.resolve(input.trim()));
  const root = pathApi.parse(normalized).root;
  const withoutTrailingSeparator = normalized.length > root.length ? normalized.replace(/[\\/]$/, "") : normalized;
  return platform === "win32" ? withoutTrailingSeparator.toLowerCase() : withoutTrailingSeparator;
}

export function isPathWithinProject(projectRoot: string, candidatePath: string): boolean {
  const root = resolve(projectRoot);
  const candidate = resolve(root, candidatePath);
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !relativePath.startsWith("..\\") &&
      !relativePath.startsWith("../") &&
      !relativePath.includes(":\\"))
  );
}

/**
 * Registered roots an unmatched project root may have meant (a moved folder, another computer, a typo in the parent
 * path, or a call from a subfolder), most likely first and at most `limit`. One pass over the candidates; a root is
 * matched only by an equal folder or project name, or by containing or being inside the path, never by similarity.
 * Within a rank the nearest root comes first, then name and root order.
 */
export function matchRegisteredRoots<T extends RegisteredRootCandidate>(
  projectRoot: string,
  candidates: readonly T[],
  limit: number,
): T[] {
  const path = comparablePath(projectRoot);
  const matches: Array<{ candidate: T; rank: number; distance: number }> = [];
  for (const candidate of candidates) {
    const match = rootMatch(path, candidate);
    if (match) matches.push({ candidate, ...match });
  }
  return matches
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        left.distance - right.distance ||
        left.candidate.name.localeCompare(right.candidate.name) ||
        left.candidate.rootPath.localeCompare(right.candidate.rootPath),
    )
    .slice(0, limit)
    .map((match) => match.candidate);
}

export class ProjectPolicyGate {
  public constructor(private readonly reader: ProjectReader) {}

  public check(projectRoot: string): PolicyDecision {
    const canonicalRoot = canonicalizeProjectRoot(projectRoot);
    const project = this.reader.getProjectByRootPath(canonicalRoot);

    if (!project) {
      return {
        allowed: false,
        projectStatus: "unregistered",
        canonicalRoot,
        reason: "Project is not registered. No work data was read or stored.",
      };
    }

    if (project.status !== "tracked") {
      return {
        allowed: false,
        project,
        projectStatus: project.status,
        canonicalRoot,
        reason: `Project recording is ${project.status}. No work data was read or stored.`,
      };
    }

    return {
      allowed: true,
      project,
      projectStatus: project.status,
      canonicalRoot,
    };
  }
}

export interface ProjectPathResolver {
  safePath(relativeOrAbsolutePath: string): string | undefined;
  safeExistingPath(relativeOrAbsolutePath: string): string | undefined;
}

export interface AsyncProjectPathResolver {
  safePath(relativeOrAbsolutePath: string): Promise<string | undefined>;
  safeExistingPath(relativeOrAbsolutePath: string): Promise<string | undefined>;
  safePaths(relativeOrAbsolutePaths: readonly string[]): Promise<Array<string | undefined>>;
  safeExistingPaths(relativeOrAbsolutePaths: readonly string[]): Promise<Array<string | undefined>>;
}

/**
 * Creates a path resolver for one operation. The tracked root is realpath
 * resolved once, while individual paths still resolve their existing parent
 * chain so symlinks cannot escape the policy boundary.
 */
export function createProjectPathResolver(projectRoot: string): ProjectPathResolver {
  const realRoot = existsSync(projectRoot)
    ? (() => {
        try {
          return realpathSync(projectRoot);
        } catch {
          return undefined;
        }
      })()
    : undefined;
  const safePathCache = new Map<string, string | undefined>();
  const safeExistingPathCache = new Map<string, string | undefined>();
  const cacheKeyFor = (relativeOrAbsolutePath: string): string => {
    const candidate = resolve(projectRoot, relativeOrAbsolutePath);
    return process.platform === "win32" ? candidate.toLowerCase() : candidate;
  };

  const resolveCandidate = (relativeOrAbsolutePath: string): string | undefined => {
    const cacheKey = cacheKeyFor(relativeOrAbsolutePath);
    if (safePathCache.has(cacheKey)) {
      return safePathCache.get(cacheKey);
    }

    if (!isPathWithinProject(projectRoot, relativeOrAbsolutePath)) {
      safePathCache.set(cacheKey, undefined);
      return undefined;
    }

    const candidate = resolve(projectRoot, relativeOrAbsolutePath);
    if (!realRoot) {
      // A not-yet-created project root cannot be realpath-checked. Callers
      // that read from disk must use safeExistingPath, which fails closed.
      safePathCache.set(cacheKey, candidate);
      return candidate;
    }

    try {
      // Lexical traversal checks do not protect against a symlink inside the
      // tracked project that points outside its root. Resolve the existing
      // part of the path before returning the lexical path used for metadata.
      let existingPath = candidate;
      while (!existsSync(existingPath)) {
        const parent = dirname(existingPath);
        if (parent === existingPath) {
          break;
        }
        existingPath = parent;
      }

      const realExistingPath = realpathSync(existingPath);
      const safeCandidate = isPathWithinProject(realRoot, realExistingPath) ? candidate : undefined;
      safePathCache.set(cacheKey, safeCandidate);
      return safeCandidate;
    } catch {
      // An unreadable existing path fails closed instead of bypassing the
      // symlink boundary check.
      safePathCache.set(cacheKey, undefined);
      return undefined;
    }
  };

  return {
    safePath(relativeOrAbsolutePath: string): string | undefined {
      return resolveCandidate(relativeOrAbsolutePath);
    },
    safeExistingPath(relativeOrAbsolutePath: string): string | undefined {
      const cacheKey = cacheKeyFor(relativeOrAbsolutePath);
      if (safeExistingPathCache.has(cacheKey)) {
        return safeExistingPathCache.get(cacheKey);
      }

      const candidate = resolveCandidate(relativeOrAbsolutePath);
      if (!candidate || !realRoot) {
        safeExistingPathCache.set(cacheKey, undefined);
        return undefined;
      }
      try {
        const realCandidate = realpathSync(candidate);
        const safeCandidate = isPathWithinProject(realRoot, realCandidate) ? realCandidate : undefined;
        safeExistingPathCache.set(cacheKey, safeCandidate);
        return safeCandidate;
      } catch {
        safeExistingPathCache.set(cacheKey, undefined);
        return undefined;
      }
    },
  };
}

/**
 * Async counterpart for operations that already use promise based filesystem
 * APIs. It resolves shared parent paths concurrently and keeps the same
 * fail-closed symlink boundary as the synchronous resolver. The batch methods
 * preserve input order so callers can map the result back without doing their
 * own path bookkeeping.
 */
export function createAsyncProjectPathResolver(projectRoot: string): AsyncProjectPathResolver {
  const realRootPromise = fsPromises.realpath(projectRoot).catch(() => undefined);
  const safePathCache = new Map<string, Promise<string | undefined>>();
  const safeExistingPathCache = new Map<string, Promise<string | undefined>>();
  const existingPathCache = new Map<string, Promise<string | undefined>>();
  const cacheKeyFor = (relativeOrAbsolutePath: string): string => {
    const candidate = resolve(projectRoot, relativeOrAbsolutePath);
    return process.platform === "win32" ? candidate.toLowerCase() : candidate;
  };

  const findExistingPath = (candidate: string): Promise<string | undefined> => {
    const key = process.platform === "win32" ? candidate.toLowerCase() : candidate;
    const cached = existingPathCache.get(key);
    if (cached) {
      return cached;
    }

    const pending = (async (): Promise<string | undefined> => {
      let current = candidate;
      while (true) {
        try {
          await fsPromises.lstat(current);
          return current;
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
          if (code !== "ENOENT") {
            return undefined;
          }
          const parent = dirname(current);
          if (parent === current) {
            return undefined;
          }
          current = parent;
        }
      }
    })();
    existingPathCache.set(key, pending);
    return pending;
  };

  const resolveCandidate = (relativeOrAbsolutePath: string): Promise<string | undefined> => {
    const cacheKey = cacheKeyFor(relativeOrAbsolutePath);
    const cached = safePathCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const pending = (async (): Promise<string | undefined> => {
      if (!isPathWithinProject(projectRoot, relativeOrAbsolutePath)) {
        return undefined;
      }

      const candidate = resolve(projectRoot, relativeOrAbsolutePath);
      const realRoot = await realRootPromise;
      if (!realRoot) {
        return candidate;
      }

      const existingPath = await findExistingPath(candidate);
      if (!existingPath) {
        return undefined;
      }
      try {
        const realExistingPath = await fsPromises.realpath(existingPath);
        return isPathWithinProject(realRoot, realExistingPath) ? candidate : undefined;
      } catch {
        return undefined;
      }
    })();
    safePathCache.set(cacheKey, pending);
    return pending;
  };

  const resolveExistingCandidate = (relativeOrAbsolutePath: string): Promise<string | undefined> => {
    const cacheKey = cacheKeyFor(relativeOrAbsolutePath);
    const cached = safeExistingPathCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const pending = (async (): Promise<string | undefined> => {
      const candidate = await resolveCandidate(relativeOrAbsolutePath);
      const realRoot = await realRootPromise;
      if (!candidate || !realRoot) {
        return undefined;
      }
      try {
        const realCandidate = await fsPromises.realpath(candidate);
        return isPathWithinProject(realRoot, realCandidate) ? realCandidate : undefined;
      } catch {
        return undefined;
      }
    })();
    safeExistingPathCache.set(cacheKey, pending);
    return pending;
  };

  return {
    safePath: resolveCandidate,
    safeExistingPath: resolveExistingCandidate,
    safePaths: (relativeOrAbsolutePaths) => Promise.all(relativeOrAbsolutePaths.map(resolveCandidate)),
    safeExistingPaths: (relativeOrAbsolutePaths) => Promise.all(relativeOrAbsolutePaths.map(resolveExistingCandidate)),
  };
}

export async function safeProjectPaths(
  projectRoot: string,
  relativeOrAbsolutePaths: readonly string[],
): Promise<Array<string | undefined>> {
  return createAsyncProjectPathResolver(projectRoot).safePaths(relativeOrAbsolutePaths);
}

export async function safeExistingProjectPaths(
  projectRoot: string,
  relativeOrAbsolutePaths: readonly string[],
): Promise<Array<string | undefined>> {
  return createAsyncProjectPathResolver(projectRoot).safeExistingPaths(relativeOrAbsolutePaths);
}

export function safeProjectPath(projectRoot: string, relativeOrAbsolutePath: string): string | undefined {
  return createProjectPathResolver(projectRoot).safePath(relativeOrAbsolutePath);
}

export function projectParentPath(projectRoot: string): string {
  return dirname(canonicalizeProjectRoot(projectRoot));
}
