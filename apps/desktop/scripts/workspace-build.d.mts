/** Types for apps/desktop/scripts/workspace-build.mjs, so TypeScript tests can import it. */
export interface SpawnResult {
  status: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
}
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { cwd: string; stdio: "inherit" },
) => SpawnResult;
export declare function runWorkspaceBuild(options: {
  repositoryRoot: string;
  skip: boolean;
  spawn?: SpawnLike;
  now?: () => number;
}): number | undefined;
