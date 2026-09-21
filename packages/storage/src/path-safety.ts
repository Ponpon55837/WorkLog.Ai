import { createProjectPathResolver } from "@work-intelligence/project-policy";

/**
 * Resolve an existing path immediately before a read. Returning the resolved
 * path avoids reopening the unresolved lexical path after the symlink check.
 * Non-existent paths intentionally remain the responsibility of callers that
 * only normalize metadata and do not read from disk.
 */
export function safeExistingProjectPath(projectRoot: string, relativeOrAbsolutePath: string): string | undefined {
  return createProjectPathResolver(projectRoot).safeExistingPath(relativeOrAbsolutePath);
}
