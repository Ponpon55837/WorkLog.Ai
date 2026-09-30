import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { computeMcpBuildIdentity } from "../../packages/shared/src/mcp-runtime.js";

export const SYNTHETIC_MCP_COMPATIBILITY_ID = "a".repeat(64);

const runtimeDistDirectories = [
  "apps/mcp/dist",
  "packages/core/dist",
  "packages/project-policy/dist",
  "packages/schema/dist",
  "packages/shared/dist",
  "packages/storage/dist",
] as const;

export function createMcpRuntimeFixture(repositoryRoot: string): string {
  mkdirSync(repositoryRoot, { recursive: true });
  writeFileSync(join(repositoryRoot, "package.json"), JSON.stringify({ name: "runtime-fixture", version: "1.2.3" }));
  for (const directory of runtimeDistDirectories) {
    const entryPath = join(repositoryRoot, directory, "index.js");
    mkdirSync(dirname(entryPath), { recursive: true });
    writeFileSync(
      entryPath,
      directory === "apps/mcp/dist"
        ? `const MCP_BUILD_DIST_HASH = "__WORK_INTELLIGENCE_BUILD_HASH__";\nconst MCP_BUILD_COMPATIBILITY_ID = "${SYNTHETIC_MCP_COMPATIBILITY_ID}";\nexport const runtime = "mcp-a";\n`
        : `export const runtime = ${JSON.stringify(directory)};\n`,
    );
  }
  writeFileSync(
    join(repositoryRoot, "packages/shared/dist/mcp-runtime.js"),
    'export const runtime = "shared-mcp-runtime";\n',
  );
  finalizeMcpRuntimeFixture(repositoryRoot);
  return repositoryRoot;
}

export function finalizeMcpRuntimeFixture(repositoryRoot: string) {
  const identity = computeMcpBuildIdentity(repositoryRoot);
  if (!identity) throw new Error("The synthetic MCP runtime fixture has no build identity.");
  const entryPath = join(repositoryRoot, "apps/mcp/dist/index.js");
  const entrySource = readFileSync(entryPath, "utf8").replace(
    /const MCP_BUILD_DIST_HASH = "(?:[a-f0-9]{64}|__WORK_INTELLIGENCE_BUILD_HASH__)";/,
    `const MCP_BUILD_DIST_HASH = "${identity.distHash}";`,
  );
  writeFileSync(entryPath, entrySource);
  return identity;
}
