import { existsSync, rmSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const repositoryDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceDirectory = resolve(process.cwd());
const relativeWorkspaceDirectory = relative(repositoryDirectory, workspaceDirectory);

if (
  relativeWorkspaceDirectory === "" ||
  relativeWorkspaceDirectory === ".." ||
  relativeWorkspaceDirectory.startsWith(`..${sep}`) ||
  isAbsolute(relativeWorkspaceDirectory) ||
  !existsSync(resolve(workspaceDirectory, "package.json"))
) {
  throw new Error("The dist cleaner must run from a workspace package directory.");
}

rmSync(resolve(workspaceDirectory, "dist"), { recursive: true, force: true });
