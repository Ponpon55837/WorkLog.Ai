import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeMcpBuildIdentity, readMcpBuildIdentity } from "../../packages/shared/src/mcp-runtime.ts";
import { finalizeRuntimeBuild, finalizeRuntimePackageBuild } from "../../scripts/runtime-build-finalizer.mjs";

const roots = [];
const runtimeDistDirectories = [
  "apps/mcp/dist",
  "packages/core/dist",
  "packages/project-policy/dist",
  "packages/schema/dist",
  "packages/shared/dist",
  "packages/storage/dist",
];

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-finalizer-test-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
  for (const directory of runtimeDistDirectories) {
    const entry = join(root, directory, "index.js");
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(
      entry,
      directory === "apps/mcp/dist"
        ? 'const MCP_BUILD_DIST_HASH = "__WORK_INTELLIGENCE_BUILD_HASH__";\nexport const runtime = "mcp-a";\n'
        : `export const runtime = ${JSON.stringify(directory)};\n`,
    );
  }
  writeFileSync(join(root, "packages/shared/dist/mcp-runtime.js"), 'export const runtime = "shared-mcp-runtime";\n');
  return root;
}

function createPartialFixture(includeSharedDist = false) {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-partial-finalizer-test-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
  const directories = ["apps/mcp/dist", ...(includeSharedDist ? ["packages/shared/dist"] : [])];
  for (const directory of directories) {
    const entry = join(root, directory, "index.js");
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(
      entry,
      directory === "apps/mcp/dist"
        ? 'const MCP_BUILD_DIST_HASH = "__WORK_INTELLIGENCE_BUILD_HASH__";\nexport const runtime = "mcp-a";\n'
        : 'export const runtime = "shared";\n',
    );
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("MCP runtime build finalizer", () => {
  it("embeds a stable fingerprint and refreshes an existing identity after a dependency rebuild", async () => {
    const root = createFixture();
    const startupCandidate = computeMcpBuildIdentity(root);
    expect(startupCandidate).toBeDefined();

    await finalizeRuntimeBuild(root, computeMcpBuildIdentity);
    expect(readMcpBuildIdentity(root)).toEqual(startupCandidate);

    writeFileSync(join(root, "packages/storage/dist/index.js"), 'export const runtime = "storage-b";\n');
    const rebuiltCandidate = computeMcpBuildIdentity(root);
    expect(rebuiltCandidate?.distHash).not.toBe(startupCandidate?.distHash);

    await finalizeRuntimeBuild(root, computeMcpBuildIdentity);
    expect(readMcpBuildIdentity(root)).toEqual(rebuiltCandidate);
    expect(readFileSync(join(root, "apps/mcp/dist/index.js"), "utf8")).toContain(rebuiltCandidate.distHash);
  });

  it.each([false, true])(
    "allows a direct package build to finish with %s shared dist while keeping MCP identity unknown",
    async (includeSharedDist) => {
      const root = createPartialFixture(includeSharedDist);
      const marker = join(root, ".work-intelligence-build-in-progress");
      writeFileSync(marker, "direct package build");

      await expect(finalizeRuntimePackageBuild(root, marker, computeMcpBuildIdentity)).resolves.toBeUndefined();
      expect(existsSync(marker)).toBe(false);
      expect(readMcpBuildIdentity(root)).toBeUndefined();
    },
  );

  it("finalizes a complete direct package build before removing its marker", async () => {
    const root = createFixture();
    const marker = join(root, ".work-intelligence-build-in-progress");
    const candidate = computeMcpBuildIdentity(root);
    if (!candidate) throw new Error("The synthetic runtime has no build identity.");
    writeFileSync(marker, "direct package build");

    await expect(finalizeRuntimePackageBuild(root, marker, computeMcpBuildIdentity)).resolves.toEqual(candidate);
    expect(existsSync(marker)).toBe(false);
    expect(readMcpBuildIdentity(root)).toEqual(candidate);
  });

  it("treats a missing MCP entry as incomplete even when the MCP dist contains other JavaScript", async () => {
    const root = createFixture();
    const marker = join(root, ".work-intelligence-build-in-progress");
    const entryPath = join(root, "apps/mcp/dist/index.js");
    rmSync(entryPath);
    writeFileSync(join(dirname(entryPath), "other.js"), 'export const other = "mcp";\n');
    writeFileSync(marker, "direct package build");

    await expect(finalizeRuntimePackageBuild(root, marker, computeMcpBuildIdentity)).resolves.toBeUndefined();
    expect(existsSync(marker)).toBe(false);
    expect(readMcpBuildIdentity(root)).toBeUndefined();
  });

  it("treats a missing shared MCP runtime module as incomplete when its dist has other JavaScript", async () => {
    const root = createFixture();
    const marker = join(root, ".work-intelligence-build-in-progress");
    const entryPath = join(root, "packages/shared/dist/mcp-runtime.js");
    rmSync(entryPath);
    writeFileSync(join(dirname(entryPath), "other.js"), 'export const other = "shared";\n');
    writeFileSync(marker, "direct package build");

    await expect(finalizeRuntimePackageBuild(root, marker, computeMcpBuildIdentity)).resolves.toBeUndefined();
    expect(existsSync(marker)).toBe(false);
    expect(readMcpBuildIdentity(root)).toBeUndefined();
  });

  it("treats a directory at the MCP entry path as incomplete", async () => {
    const root = createFixture();
    const marker = join(root, ".work-intelligence-build-in-progress");
    const entryPath = join(root, "apps/mcp/dist/index.js");
    rmSync(entryPath);
    mkdirSync(entryPath);
    writeFileSync(join(entryPath, "nested.js"), 'export const nested = "mcp";\n');
    writeFileSync(join(dirname(entryPath), "other.js"), 'export const other = "mcp";\n');
    writeFileSync(marker, "direct package build");

    await expect(finalizeRuntimePackageBuild(root, marker, computeMcpBuildIdentity)).resolves.toBeUndefined();
    expect(existsSync(marker)).toBe(false);
    expect(readMcpBuildIdentity(root)).toBeUndefined();
  });

  it("treats a file at a required runtime dist path as incomplete", async () => {
    const root = createFixture();
    const marker = join(root, ".work-intelligence-build-in-progress");
    const distPath = join(root, "apps/mcp/dist");
    rmSync(distPath, { recursive: true, force: true });
    writeFileSync(distPath, "not a dist directory");
    writeFileSync(marker, "direct package build");

    await expect(finalizeRuntimePackageBuild(root, marker, computeMcpBuildIdentity)).resolves.toBeUndefined();
    expect(existsSync(marker)).toBe(false);
    expect(readMcpBuildIdentity(root)).toBeUndefined();
  });
});
