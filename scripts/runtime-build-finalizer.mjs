import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const EMBEDDED_IDENTITY_PATTERN = /const MCP_BUILD_DIST_HASH = "(?:[a-f0-9]{64}|__WORK_INTELLIGENCE_BUILD_HASH__)";/g;
const RUNTIME_DIST_DIRECTORIES = [
  "apps/mcp/dist",
  "packages/core/dist",
  "packages/project-policy/dist",
  "packages/schema/dist",
  "packages/shared/dist",
  "packages/storage/dist",
];

function runtimeDirectoryHasJavaScript(directory) {
  return readdirSync(directory, { withFileTypes: true }).some((child) => {
    const childPath = resolve(directory, child.name);
    return child.isDirectory()
      ? runtimeDirectoryHasJavaScript(childPath)
      : child.isFile() && child.name.endsWith(".js");
  });
}

function runtimeDistIsIncomplete(root) {
  for (const directory of RUNTIME_DIST_DIRECTORIES) {
    const distPath = resolve(root, directory);
    try {
      if (!statSync(distPath).isDirectory()) return true;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return true;
      throw error;
    }
    if (!runtimeDirectoryHasJavaScript(distPath)) return true;
  }

  for (const entry of ["apps/mcp/dist/index.js", "packages/shared/dist/mcp-runtime.js"]) {
    try {
      if (!statSync(resolve(root, entry)).isFile()) return true;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return true;
      throw error;
    }
  }

  return false;
}

export async function finalizeRuntimeBuild(repositoryRoot, computeIdentityOverride, options = {}) {
  const root = resolve(repositoryRoot);
  if (options.allowIncompleteRuntime && runtimeDistIsIncomplete(root)) return undefined;
  const computeIdentity =
    computeIdentityOverride ??
    (await import(pathToFileURL(resolve(root, "packages/shared/dist/mcp-runtime.js")).href)).computeMcpBuildIdentity;
  const identity = computeIdentity(root);
  if (!identity)
    throw new Error("Work Intelligence MCP build identity is unavailable; the in-progress marker was preserved.");

  const entryPath = resolve(root, "apps/mcp/dist/index.js");
  const entrySource = readFileSync(entryPath, "utf8");
  if (entrySource.match(EMBEDDED_IDENTITY_PATTERN)?.length !== 1) {
    throw new Error("Work Intelligence MCP entry point is missing its unique build identity constant.");
  }
  writeFileSync(
    entryPath,
    entrySource.replace(EMBEDDED_IDENTITY_PATTERN, `const MCP_BUILD_DIST_HASH = "${identity.distHash}";`),
  );
  return identity;
}

export async function finalizeRuntimePackageBuild(repositoryRoot, markerPath, computeIdentityOverride) {
  const identity = await finalizeRuntimeBuild(repositoryRoot, computeIdentityOverride, {
    allowIncompleteRuntime: true,
  });
  if (!identity) {
    process.stderr.write(
      "Runtime package built successfully, but other MCP runtime dist files are still missing; MCP status remains unknown until the full runtime is built.\n",
    );
  }
  rmSync(markerPath, { force: true });
  return identity;
}
