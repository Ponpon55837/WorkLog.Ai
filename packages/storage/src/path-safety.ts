import { createProjectPathResolver } from "@work-intelligence/project-policy";

/** Returns the resolved path so the caller does not reopen the unresolved lexical path after the symlink check. */
export function safeExistingProjectPath(projectRoot: string, relativeOrAbsolutePath: string): string | undefined {
  return createProjectPathResolver(projectRoot).safeExistingPath(relativeOrAbsolutePath);
}
