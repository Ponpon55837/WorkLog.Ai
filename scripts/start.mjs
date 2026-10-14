import { existsSync } from "node:fs";
import { error, warn } from "node:console";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";

const repositoryDirectory = dirname(fileURLToPath(import.meta.url));
const webDirectory = resolve(repositoryDirectory, "../apps/web/dist");
const serverEntry = resolve(repositoryDirectory, "../apps/server/dist/index.js");

if (!existsSync(resolve(webDirectory, "index.html")) || !existsSync(serverEntry)) {
  error("找不到正式版檔案，請先在專案根目錄執行 pnpm build。");
  process.exitCode = 1;
} else {
  process.env.WORK_INTELLIGENCE_WEB_DIST = webDirectory;
  try {
    // Quiet unless a local Agent skill or hook is out of date; never blocks or fails startup.
    const { collectStartupHints } = await import(
      pathToFileURL(resolve(repositoryDirectory, "../apps/server/dist/startup-check.js")).href
    );
    const hints = collectStartupHints();
    if (hints.length > 0) {
      for (const hint of hints) warn(hint);
      warn("詳細結果請執行 pnpm check");
    }
  } catch {
    // The check is advisory.
  }
  await import(pathToFileURL(serverEntry).href);
}
