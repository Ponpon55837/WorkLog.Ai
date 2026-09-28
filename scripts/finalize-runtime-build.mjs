import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { finalizeRuntimeBuild } from "./runtime-build-finalizer.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
try {
  await finalizeRuntimeBuild(repositoryRoot);
} catch (error) {
  const message = error instanceof Error ? error.message : "Work Intelligence MCP build finalization failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
