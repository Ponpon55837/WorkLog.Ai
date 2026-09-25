import { existsSync } from "node:fs";
import { error } from "node:console";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const repositoryDirectory = dirname(fileURLToPath(import.meta.url));
const webDirectory = resolve(repositoryDirectory, "../apps/web/dist");
const serverEntry = resolve(repositoryDirectory, "../apps/server/dist/index.js");

if (!existsSync(resolve(webDirectory, "index.html")) || !existsSync(serverEntry)) {
  error("找不到正式版檔案，請先在專案根目錄執行 pnpm build。");
  process.exitCode = 1;
} else {
  process.env.WORK_INTELLIGENCE_WEB_DIST = webDirectory;
  await import(serverEntry);
}
