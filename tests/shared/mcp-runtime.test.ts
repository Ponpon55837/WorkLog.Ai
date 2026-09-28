import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeMcpBuildIdentity,
  getMcpRestartStatus,
  getMcpRuntimeDirectory,
  getMcpRuntimeStatus,
  readMcpBuildIdentity,
  registerMcpProcess,
} from "../../packages/shared/src/mcp-runtime.js";
import { createMcpRuntimeFixture } from "../helpers/mcp-runtime-fixture.js";

const roots: string[] = [];
const cleanups: Array<() => void> = [];

function createFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-runtime-test-"));
  roots.push(root);
  return createMcpRuntimeFixture(join(root, "install"));
}

function finalizeFixtureBuild(root: string) {
  const candidate = computeMcpBuildIdentity(root);
  if (!candidate) throw new Error("The synthetic runtime has no candidate build identity.");
  const entryPath = join(root, "apps/mcp/dist/index.js");
  const source = readFileSync(entryPath, "utf8").replace(
    /const MCP_BUILD_DIST_HASH = "(?:[a-f0-9]{64}|__WORK_INTELLIGENCE_BUILD_HASH__)";/,
    `const MCP_BUILD_DIST_HASH = "${candidate.distHash}";`,
  );
  writeFileSync(entryPath, source);
  const finalized = readMcpBuildIdentity(root);
  if (!finalized) throw new Error("The synthetic runtime could not read its finalized identity.");
  return finalized;
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  for (const root of roots.splice(0)) {
    rmSync(getMcpRuntimeDirectory(join(root, "install")), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

describe("MCP runtime build identity and process leases", () => {
  it("changes identity for MCP and workspace dependency dist updates and compares fingerprints by equality", () => {
    const root = createFixture();
    const startupBuild = readMcpBuildIdentity(root);
    expect(startupBuild).toBeDefined();

    writeFileSync(
      join(root, "apps/mcp/dist/index.js"),
      'const MCP_BUILD_DIST_HASH = "__WORK_INTELLIGENCE_BUILD_HASH__";\nexport const runtime = "mcp-b";\n',
    );
    const afterMcpUpdate = finalizeFixtureBuild(root);
    expect(afterMcpUpdate?.distHash).not.toBe(startupBuild?.distHash);
    expect(getMcpRestartStatus(root, startupBuild)).toMatchObject({
      restartRequired: true,
      monitoringAvailable: true,
      message: expect.stringContaining("請重新連線 MCP"),
    });

    writeFileSync(join(root, "packages/storage/dist/index.js"), 'export const runtime = "storage-b";\n');
    const afterDependencyUpdate = finalizeFixtureBuild(root);
    expect(afterDependencyUpdate?.distHash).not.toBe(afterMcpUpdate?.distHash);
    expect(getMcpRestartStatus(root, afterMcpUpdate)).toMatchObject({ restartRequired: true });
    expect(getMcpRestartStatus(root, afterDependencyUpdate)).toMatchObject({
      restartRequired: false,
      monitoringAvailable: true,
    });
  });

  it("keeps the candidate identity stable after the build hash is embedded in the MCP entry", () => {
    const root = createFixture();
    const candidateBuild = computeMcpBuildIdentity(root);
    if (!candidateBuild) throw new Error("The synthetic runtime has no candidate build identity.");

    const entryPath = join(root, "apps/mcp/dist/index.js");
    const entry = 'const MCP_BUILD_DIST_HASH = "__WORK_INTELLIGENCE_BUILD_HASH__";\nexport const runtime = "mcp-a";\n';
    writeFileSync(entryPath, entry.replace("__WORK_INTELLIGENCE_BUILD_HASH__", candidateBuild.distHash));
    expect(readMcpBuildIdentity(root)).toEqual(candidateBuild);
  });

  it("keeps build identity unknown when install package metadata cannot provide semver", () => {
    const root = createFixture();
    const packagePath = join(root, "package.json");

    writeFileSync(packagePath, "{");
    expect(computeMcpBuildIdentity(root)).toBeUndefined();

    writeFileSync(packagePath, JSON.stringify({ name: "synthetic-install" }));
    expect(computeMcpBuildIdentity(root)).toBeUndefined();

    writeFileSync(packagePath, JSON.stringify({ version: "not-a-version" }));
    expect(computeMcpBuildIdentity(root)).toBeUndefined();
  });

  it("reports unknown when a complete runtime has a missing or stale embedded entry hash", () => {
    const root = createFixture();
    const entryPath = join(root, "apps/mcp/dist/index.js");
    const finalizedSource = readFileSync(entryPath, "utf8");

    writeFileSync(
      entryPath,
      finalizedSource.replace(
        /const MCP_BUILD_DIST_HASH = "[a-f0-9]{64}";/,
        'const MCP_BUILD_DIST_HASH = "__WORK_INTELLIGENCE_BUILD_HASH__";',
      ),
    );
    expect(readMcpBuildIdentity(root)).toBeUndefined();

    const staleSource = finalizedSource.replace(
      /const MCP_BUILD_DIST_HASH = "[a-f0-9]{64}";/,
      `const MCP_BUILD_DIST_HASH = "${"0".repeat(64)}";`,
    );
    writeFileSync(entryPath, staleSource);
    expect(readMcpBuildIdentity(root)).toBeUndefined();
  });

  it("reports unknown during a build or when a required dist is missing or incomplete", () => {
    const root = createFixture();
    const build = readMcpBuildIdentity(root);
    const marker = join(root, ".work-intelligence-build-in-progress");
    writeFileSync(marker, "building");

    expect(readMcpBuildIdentity(root)).toBeUndefined();
    expect(computeMcpBuildIdentity(root)).toBeDefined();
    expect(getMcpRestartStatus(root, build)).toMatchObject({ restartRequired: false, monitoringAvailable: false });
    expect(getMcpRuntimeStatus(root)).toMatchObject({ restartRequired: false, monitoringAvailable: false });

    rmSync(marker);
    rmSync(join(root, "packages/schema/dist/index.js"));
    expect(readMcpBuildIdentity(root)).toBeUndefined();

    writeFileSync(join(root, "packages/schema/dist/index.js"), 'export const runtime = "schema";\n');
    writeFileSync(join(root, "apps/mcp/dist/index.js"), 'const MCP_BUILD_DIST_HASH = "partial";\n');
    expect(readMcpBuildIdentity(root)).toBeUndefined();
  });

  it("aggregates multiple active processes, ignores expired and corrupt leases, and cleans only its own lease", () => {
    const root = createFixture();
    const now = new Date("2026-09-28T12:00:00.000Z");
    const firstBuild = readMcpBuildIdentity(root);
    if (!firstBuild) throw new Error("The synthetic runtime has no build identity.");
    const stopOldProcess = registerMcpProcess(root, firstBuild, { now: () => now });

    writeFileSync(join(root, "packages/core/dist/index.js"), 'export const runtime = "core-after-update";\n');
    const currentBuild = finalizeFixtureBuild(root);
    if (!currentBuild) throw new Error("The updated synthetic runtime has no build identity.");
    const stopCurrentProcess = registerMcpProcess(root, currentBuild, { now: () => now });
    cleanups.push(stopOldProcess, stopCurrentProcess);

    const registryDirectory = getMcpRuntimeDirectory(root);
    const expiredId = randomUUID();
    writeFileSync(
      join(registryDirectory, `${expiredId}.json`),
      JSON.stringify({
        instanceId: expiredId,
        buildId: firstBuild.buildId,
        version: firstBuild.version,
        startedAt: now.toISOString(),
        heartbeatAt: new Date(now.getTime() - 60_000).toISOString(),
      }),
    );
    writeFileSync(join(registryDirectory, "corrupt.json"), "{");
    writeFileSync(join(registryDirectory, "incomplete.tmp"), "not a lease");

    expect(getMcpRuntimeStatus(root, currentBuild, { now })).toMatchObject({
      activeProcesses: 2,
      outdatedProcesses: 1,
      restartRequired: true,
      monitoringAvailable: true,
      message: expect.stringContaining("請重新連線 MCP"),
    });

    stopOldProcess();
    expect(getMcpRuntimeStatus(root, currentBuild, { now })).toMatchObject({
      activeProcesses: 1,
      outdatedProcesses: 0,
      restartRequired: false,
    });
    stopCurrentProcess();
    cleanups.length = 0;
  });

  it("keeps runtime status unknown and does not crash when the lease registry is unreadable", () => {
    const root = createFixture();
    const build = readMcpBuildIdentity(root);
    const registryDirectory = getMcpRuntimeDirectory(root);
    mkdirSync(dirname(registryDirectory), { recursive: true });
    writeFileSync(registryDirectory, "registry path is blocked");

    const cleanup = registerMcpProcess(root, build);
    expect(() => cleanup()).not.toThrow();
    expect(
      getMcpRuntimeStatus(root, build, {
        probeRegistryWritable: (directory) => {
          expect(directory).toBe(registryDirectory);
          return true;
        },
      }),
    ).toMatchObject({
      activeProcesses: 0,
      restartRequired: false,
      monitoringAvailable: false,
      message: expect.stringContaining("無法確認"),
    });
    expect(getMcpRuntimeStatus(root, build)).toMatchObject({
      activeProcesses: 0,
      restartRequired: false,
      monitoringAvailable: false,
      message: expect.stringContaining("無法確認"),
    });
  });

  it("reports unknown when a readable lease registry fails the write probe", () => {
    const root = createFixture();
    const build = readMcpBuildIdentity(root);
    const registryDirectory = getMcpRuntimeDirectory(root);
    mkdirSync(registryDirectory, { recursive: true });

    expect(readdirSync(registryDirectory)).toEqual([]);
    expect(
      getMcpRuntimeStatus(root, build, {
        probeRegistryWritable: (directory) => {
          expect(directory).toBe(registryDirectory);
          return false;
        },
      }),
    ).toMatchObject({
      activeProcesses: 0,
      restartRequired: false,
      monitoringAvailable: false,
      message: expect.stringContaining("無法確認"),
    });
  });

  it("keeps unknown-startup MCP instances stale after the build becomes readable", () => {
    const root = createFixture();
    const marker = join(root, ".work-intelligence-build-in-progress");
    writeFileSync(marker, "building");
    const stopUnknownProcess = registerMcpProcess(root, undefined);
    cleanups.push(stopUnknownProcess);

    expect(getMcpRuntimeStatus(root)).toMatchObject({ restartRequired: false, monitoringAvailable: false });
    rmSync(marker);
    expect(getMcpRuntimeStatus(root)).toMatchObject({
      activeProcesses: 1,
      outdatedProcesses: 1,
      restartRequired: true,
      monitoringAvailable: true,
    });
  });
});
