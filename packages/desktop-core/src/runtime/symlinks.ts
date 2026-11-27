import fs from "node:fs/promises";
import path from "node:path";
import { RuntimeError } from "./errors.js";

function isInside(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

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
