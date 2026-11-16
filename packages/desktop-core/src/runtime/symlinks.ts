import fs from "node:fs/promises";
import path from "node:path";
import { RuntimeError } from "./errors.js";

/** Whether `candidate` is `directory` itself or below it; both must already be resolved (no links, no `..`). */
function isInside(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Requires every symlink of a runtime to RESOLVE, with every link on the way followed, to a path inside the runtime
 * directory. The lexical rule in `symlinkTargetProblem` is not enough on its own: `a/b -> ../a` passes it, and then
 * `x -> a/b/b/../..` also passes it lexically, yet the OS resolves `a/b/b` to `a` first and `..` then climbs out of
 * the runtime. Asking the file system (`realpath`) is the only check that agrees with what `exec` and `import` will do.
 * A link that cannot be resolved at all (dangling, or a loop) is refused too: a runtime has no use for one.
 */
export async function assertSymlinksStayInside(
  runtimeDirectory: string,
  symlinks: readonly { readonly path: string }[],
): Promise<void> {
  if (symlinks.length === 0) return;
  const resolvedDirectory = await fs.realpath(runtimeDirectory);
  for (const link of symlinks) {
    let resolved: string;
    try {
      resolved = await fs.realpath(path.join(runtimeDirectory, link.path));
    } catch (error) {
      throw new RuntimeError(
        "RUNTIME_SYMLINK_REJECTED",
        "符號連結無法解析到 runtime 內的檔案（懸空或循環）",
        { file: link.path },
        { cause: error },
      );
    }
    if (!isInside(resolvedDirectory, resolved)) {
      throw new RuntimeError("RUNTIME_SYMLINK_REJECTED", "符號連結（含連鎖）解析後離開了 runtime 目錄", {
        file: link.path,
        actual: resolved,
      });
    }
  }
}
