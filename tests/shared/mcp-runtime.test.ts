import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeMcpBuildIdentity,
  getMcpRestartStatus,
  getMcpRuntimeDirectory,
  getMcpRuntimeStatus,
  readMcpBuildIdentity,
  registerMcpProcess,
} from "../../packages/shared/src/mcp-runtime.js";
import { createMcpRuntimeFixture, finalizeMcpRuntimeFixture } from "../helpers/mcp-runtime-fixture.js";

const { testTmpDirectory } = vi.hoisted(() => ({
  testTmpDirectory: `${process.cwd()}/.test-sandbox/runtime-${process.pid}`,
}));

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, tmpdir: () => testTmpDirectory };
});

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    opendirSync: vi.fn(original.opendirSync),
    readdirSync: vi.fn(original.readdirSync),
    unlinkSync: vi.fn(original.unlinkSync),
  };
});

const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");

const roots: string[] = [];
const cleanups: Array<() => void> = [];
const MCP_HEARTBEAT_TTL_MS = 30_000;
const MCP_LEASE_CLEANUP_GRACE_MS = 60_000;
const MCP_LEASE_CLEANUP_AGE_MS = MCP_HEARTBEAT_TTL_MS + MCP_LEASE_CLEANUP_GRACE_MS;

interface TestLease {
  instanceId: string;
  buildId: string;
  version: string;
  startedAt: string;
  heartbeatAt: string;
}

function createFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-runtime-test-"));
  roots.push(root);
  return createMcpRuntimeFixture(join(root, "install"));
}

function finalizeFixtureBuild(root: string) {
  return finalizeMcpRuntimeFixture(root);
}

function setFixtureCompatibilityId(root: string, compatibilityId: string): void {
  const entryPath = join(root, "apps/mcp/dist/index.js");
  const source = readFileSync(entryPath, "utf8");
  const updated = source.replace(
    /const MCP_BUILD_COMPATIBILITY_ID = "[a-f0-9]{64}";/,
    `const MCP_BUILD_COMPATIBILITY_ID = "${compatibilityId}";`,
  );
  if (updated === source) throw new Error("The synthetic runtime fixture has no embedded compatibility identity.");
  writeFileSync(entryPath, updated);
}

function createLease(
  directory: string,
  instanceId: string,
  options: { now: Date; heartbeatAt?: Date; mtime?: Date; contents?: string },
): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${instanceId}.json`);
  const lease: TestLease = {
    instanceId,
    buildId: "synthetic-build",
    version: "1.0.0",
    startedAt: options.now.toISOString(),
    heartbeatAt: (options.heartbeatAt ?? options.now).toISOString(),
  };
  writeFileSync(path, options.contents ?? JSON.stringify(lease));
  const mtime = options.mtime ?? options.now;
  utimesSync(path, mtime, mtime);
  return path;
}

function createTemporaryLease(directory: string, instanceId: string, mtime: Date): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${instanceId}.tmp`);
  writeFileSync(path, "incomplete lease");
  utimesSync(path, mtime, mtime);
  return path;
}

function createFreshStatusLeaseFixture() {
  const root = createFixture();
  const build = readMcpBuildIdentity(root);
  if (!build) throw new Error("The synthetic runtime has no build identity.");
  const now = new Date();
  const directory = getMcpRuntimeDirectory(root);
  const freshLease = createLease(directory, randomUUID(), { now });
  const freshTemporaryLease = createTemporaryLease(directory, randomUUID(), now);
  return { root, build, now, freshLease, freshTemporaryLease };
}

afterEach(() => {
  vi.mocked(fs.opendirSync).mockReset().mockImplementation(actualFs.opendirSync);
  vi.mocked(fs.readdirSync).mockReset().mockImplementation(actualFs.readdirSync);
  vi.mocked(fs.unlinkSync).mockReset().mockImplementation(actualFs.unlinkSync);
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  for (const root of roots.splice(0)) {
    rmSync(getMcpRuntimeDirectory(join(root, "install")), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

beforeEach(() => {
  mkdirSync(tmpdir(), { recursive: true });
});

afterAll(() => {
  rmSync(tmpdir(), { recursive: true, force: true });
});

describe("MCP runtime build identity and process leases", () => {
  it("allows implementation-only rebuilds and marks a compatible update as available", () => {
    const root = createFixture();
    const startupBuild = readMcpBuildIdentity(root);
    if (!startupBuild) throw new Error("The synthetic runtime has no startup build identity.");

    writeFileSync(join(root, "apps/mcp/dist/implementation.js"), 'export const runtime = "mcp-b";\n');
    const afterMcpUpdate = finalizeFixtureBuild(root);
    expect(afterMcpUpdate.distHash).not.toBe(startupBuild.distHash);
    expect(afterMcpUpdate.compatibilityId).toBe(startupBuild.compatibilityId);
    expect(getMcpRestartStatus(root, startupBuild)).toMatchObject({
      restartRequired: false,
      updateAvailable: true,
      monitoringAvailable: true,
      message: expect.stringContaining("有新版可用"),
    });

    writeFileSync(join(root, "packages/storage/dist/index.js"), 'export const runtime = "storage-b";\n');
    const afterDependencyUpdate = finalizeFixtureBuild(root);
    expect(afterDependencyUpdate.distHash).not.toBe(afterMcpUpdate.distHash);
    expect(afterDependencyUpdate.compatibilityId).toBe(afterMcpUpdate.compatibilityId);
    expect(getMcpRestartStatus(root, afterMcpUpdate)).toMatchObject({
      restartRequired: false,
      updateAvailable: true,
      monitoringAvailable: true,
    });
    expect(getMcpRestartStatus(root, afterDependencyUpdate)).toMatchObject({
      restartRequired: false,
      updateAvailable: false,
      monitoringAvailable: true,
    });
  });

  it.each(["schema version", "operation contract"])(
    "requires reconnect when the %s compatibility identity changes",
    (changeKind) => {
      const root = createFixture();
      const startupBuild = readMcpBuildIdentity(root);
      if (!startupBuild) throw new Error("The synthetic runtime has no startup build identity.");

      setFixtureCompatibilityId(root, changeKind === "schema version" ? "b".repeat(64) : "c".repeat(64));
      const changedBuild = finalizeFixtureBuild(root);

      expect(changedBuild.distHash).not.toBe(startupBuild.distHash);
      expect(changedBuild.compatibilityId).not.toBe(startupBuild.compatibilityId);
      expect(getMcpRestartStatus(root, startupBuild)).toMatchObject({
        restartRequired: true,
        updateAvailable: false,
        monitoringAvailable: true,
        message: expect.stringContaining("請重新連線 MCP"),
      });
    },
  );

  it("fails closed when either build has no compatibility identity", () => {
    const root = createFixture();
    const startupBuild = readMcpBuildIdentity(root);
    if (!startupBuild) throw new Error("The synthetic runtime has no startup build identity.");

    const entryPath = join(root, "apps/mcp/dist/index.js");
    const source = readFileSync(entryPath, "utf8");
    const withoutCompatibility = source.replace(/const MCP_BUILD_COMPATIBILITY_ID = "[a-f0-9]{64}";\n/, "");
    if (withoutCompatibility === source) throw new Error("The fixture compatibility identity was not found.");
    writeFileSync(entryPath, withoutCompatibility);
    const currentWithoutCompatibility = finalizeFixtureBuild(root);

    expect(currentWithoutCompatibility.compatibilityId).toBeUndefined();
    expect(getMcpRuntimeStatus(root, currentWithoutCompatibility)).toMatchObject({
      restartRequired: true,
      monitoringAvailable: false,
      activeProcesses: 0,
    });
    expect(getMcpRestartStatus(root, startupBuild)).toMatchObject({
      restartRequired: true,
      updateAvailable: false,
      monitoringAvailable: true,
    });

    const legacyRoot = createFixture();
    const currentBuild = readMcpBuildIdentity(legacyRoot);
    if (!currentBuild) throw new Error("The synthetic runtime has no current build identity.");
    const legacyRunningBuild = { ...currentBuild, compatibilityId: undefined };
    writeFileSync(
      join(legacyRoot, "packages/core/dist/index.js"),
      'export const runtime = "implementation-after-legacy-start";\n',
    );
    finalizeFixtureBuild(legacyRoot);
    expect(getMcpRestartStatus(legacyRoot, legacyRunningBuild)).toMatchObject({
      restartRequired: true,
      updateAvailable: false,
      monitoringAvailable: true,
    });
  });

  it("reuses a cached identity only while every runtime file is unchanged", () => {
    const root = createFixture();
    const first = readMcpBuildIdentity(root);
    expect(first).toBeDefined();
    expect(readMcpBuildIdentity(root)).toEqual(first);

    // A rebuild rewrites a dependency dist file; the stat signature changes and the hash is recomputed.
    writeFileSync(join(root, "packages/storage/dist/index.js"), 'export const runtime = "storage-rebuilt";\n');
    expect(readMcpBuildIdentity(root)).toBeUndefined();
    const rebuilt = finalizeFixtureBuild(root);
    expect(rebuilt.buildId).not.toBe(first?.buildId);
    expect(readMcpBuildIdentity(root)).toEqual(rebuilt);

    // A new runtime file also invalidates the cache.
    writeFileSync(join(root, "apps/mcp/dist/extra.js"), "export const extra = true;\n");
    expect(readMcpBuildIdentity(root)).toBeUndefined();
  });

  it("keeps the candidate identity stable after the build hash is embedded in the MCP entry", () => {
    const root = createFixture();
    const candidateBuild = computeMcpBuildIdentity(root);
    if (!candidateBuild) throw new Error("The synthetic runtime has no candidate build identity.");

    const entryPath = join(root, "apps/mcp/dist/index.js");
    const entry = `const MCP_BUILD_DIST_HASH = "__WORK_INTELLIGENCE_BUILD_HASH__";\nconst MCP_BUILD_COMPATIBILITY_ID = "${candidateBuild.compatibilityId}";\nexport const runtime = "mcp-a";\n`;
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
    expect(getMcpRestartStatus(root, build)).toMatchObject({ restartRequired: true, monitoringAvailable: false });
    expect(getMcpRuntimeStatus(root)).toMatchObject({ restartRequired: true, monitoringAvailable: false });

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
    const incompatibleId = randomUUID();
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
    writeFileSync(
      join(registryDirectory, `${incompatibleId}.json`),
      JSON.stringify({
        instanceId: incompatibleId,
        buildId: "old-contract-build",
        compatibilityId: "b".repeat(64),
        version: firstBuild.version,
        startedAt: now.toISOString(),
        heartbeatAt: now.toISOString(),
      }),
    );
    writeFileSync(join(registryDirectory, "corrupt.json"), "{");
    writeFileSync(join(registryDirectory, "incomplete.tmp"), "not a lease");

    expect(getMcpRuntimeStatus(root, currentBuild, { now })).toMatchObject({
      activeProcesses: 3,
      outdatedProcesses: 1,
      updateAvailableProcesses: 1,
      restartRequired: true,
      updateAvailable: true,
      monitoringAvailable: true,
      message: expect.stringContaining("請重新連線 MCP"),
    });

    stopOldProcess();
    expect(getMcpRuntimeStatus(root, currentBuild, { now })).toMatchObject({
      activeProcesses: 2,
      outdatedProcesses: 1,
      updateAvailableProcesses: 0,
      restartRequired: true,
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
      outdatedProcesses: 0,
      updateAvailableProcesses: 0,
      restartRequired: true,
      monitoringAvailable: false,
      message: expect.stringContaining("無法確認"),
    });
    expect(getMcpRuntimeStatus(root, build)).toMatchObject({
      activeProcesses: 0,
      outdatedProcesses: 0,
      updateAvailableProcesses: 0,
      restartRequired: true,
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
      outdatedProcesses: 0,
      updateAvailableProcesses: 0,
      restartRequired: true,
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

    expect(getMcpRuntimeStatus(root)).toMatchObject({ restartRequired: true, monitoringAvailable: false });
    rmSync(marker);
    expect(getMcpRuntimeStatus(root)).toMatchObject({
      activeProcesses: 1,
      outdatedProcesses: 1,
      restartRequired: true,
      monitoringAvailable: true,
    });
  });
});

describe("MCP process lease cleanup", () => {
  it("cleans stale files during registration while respecting heartbeat and mtime thresholds", () => {
    const root = createFixture();
    const otherRoot = createFixture();
    const build = readMcpBuildIdentity(root);
    if (!build) throw new Error("The synthetic runtime has no build identity.");
    const now = new Date("2026-09-28T12:00:00.000Z");
    const registryDirectory = getMcpRuntimeDirectory(root);
    const otherRegistryDirectory = getMcpRuntimeDirectory(otherRoot);
    const staleAt = new Date(now.getTime() - MCP_LEASE_CLEANUP_AGE_MS - 1_000);
    const justTtlExpiredAt = new Date(now.getTime() - MCP_HEARTBEAT_TTL_MS - 1);
    const boundaryAt = new Date(now.getTime() - MCP_LEASE_CLEANUP_AGE_MS);

    const staleLease = createLease(registryDirectory, randomUUID(), {
      now,
      heartbeatAt: staleAt,
      mtime: staleAt,
    });
    const staleTemporaryLease = createTemporaryLease(registryDirectory, randomUUID(), staleAt);
    const freshTemporaryLease = createTemporaryLease(registryDirectory, randomUUID(), now);
    const heartbeatExpiredButRecentlyWritten = createLease(registryDirectory, randomUUID(), {
      now,
      heartbeatAt: staleAt,
      mtime: now,
    });
    const heartbeatFreshButOldFile = createLease(registryDirectory, randomUUID(), {
      now,
      heartbeatAt: now,
      mtime: staleAt,
    });
    const justTtlExpiredLease = createLease(registryDirectory, randomUUID(), {
      now,
      heartbeatAt: justTtlExpiredAt,
      mtime: justTtlExpiredAt,
    });
    const thresholdBoundaryLease = createLease(registryDirectory, randomUUID(), {
      now,
      heartbeatAt: boundaryAt,
      mtime: staleAt,
    });
    const malformedStaleLease = join(registryDirectory, `${randomUUID()}.json`);
    writeFileSync(malformedStaleLease, "{");
    utimesSync(malformedStaleLease, staleAt, staleAt);
    const malformedFreshLease = join(registryDirectory, `${randomUUID()}.json`);
    writeFileSync(malformedFreshLease, "{");
    utimesSync(malformedFreshLease, now, now);

    const invalidUuidLease = join(registryDirectory, "11111111-1111-1111-8111-111111111111.json");
    writeFileSync(invalidUuidLease, "{}");
    utimesSync(invalidUuidLease, staleAt, staleAt);
    const invalidNameLease = join(registryDirectory, "not-a-uuid.json");
    writeFileSync(invalidNameLease, "{}");
    utimesSync(invalidNameLease, staleAt, staleAt);
    const otherExtension = join(registryDirectory, `${randomUUID()}.txt`);
    writeFileSync(otherExtension, "{}");
    utimesSync(otherExtension, staleAt, staleAt);

    const directoryLease = join(registryDirectory, `${randomUUID()}.json`);
    mkdirSync(directoryLease);
    const nestedDirectory = join(registryDirectory, "nested");
    mkdirSync(nestedDirectory);
    const nestedLease = createTemporaryLease(nestedDirectory, randomUUID(), staleAt);

    const symlinkTarget = join(root, "stale-target.txt");
    writeFileSync(symlinkTarget, "outside the registry");
    utimesSync(symlinkTarget, staleAt, staleAt);
    const symlinkLease = join(registryDirectory, `${randomUUID()}.tmp`);
    let symlinkCreated = false;
    try {
      symlinkSync(symlinkTarget, symlinkLease, "file");
      lutimesSync(symlinkLease, staleAt, staleAt);
      symlinkCreated = true;
    } catch {
      rmSync(symlinkLease, { force: true });
      const symlinkTargetDirectory = join(root, "stale-target-directory");
      mkdirSync(symlinkTargetDirectory);
      try {
        symlinkSync(symlinkTargetDirectory, symlinkLease, "junction");
        symlinkCreated = true;
      } catch {
        // Some Windows environments disable links entirely; regular-file cleanup remains covered below.
      }
    }

    const otherScopeLease = createTemporaryLease(otherRegistryDirectory, randomUUID(), staleAt);

    const stopProcess = registerMcpProcess(root, build, { now: () => now });
    cleanups.push(stopProcess);

    expect(existsSync(staleLease)).toBe(false);
    expect(existsSync(staleTemporaryLease)).toBe(false);
    expect(existsSync(freshTemporaryLease)).toBe(true);
    expect(existsSync(malformedStaleLease)).toBe(false);
    expect(existsSync(heartbeatExpiredButRecentlyWritten)).toBe(true);
    expect(existsSync(heartbeatFreshButOldFile)).toBe(true);
    expect(existsSync(justTtlExpiredLease)).toBe(true);
    expect(existsSync(thresholdBoundaryLease)).toBe(true);
    expect(existsSync(malformedFreshLease)).toBe(true);
    expect(existsSync(invalidUuidLease)).toBe(true);
    expect(existsSync(invalidNameLease)).toBe(true);
    expect(existsSync(otherExtension)).toBe(true);
    expect(existsSync(directoryLease)).toBe(true);
    expect(existsSync(nestedLease)).toBe(true);
    if (symlinkCreated) expect(lstatSync(symlinkLease).isSymbolicLink()).toBe(true);
    expect(existsSync(otherScopeLease)).toBe(true);
  });

  it("cleans stale leases during status reads without starting a second directory scan", () => {
    const root = createFixture();
    const build = readMcpBuildIdentity(root);
    if (!build) throw new Error("The synthetic runtime has no build identity.");
    const now = new Date("2026-09-28T12:00:00.000Z");
    const registryDirectory = getMcpRuntimeDirectory(root);
    const staleAt = new Date(now.getTime() - MCP_LEASE_CLEANUP_AGE_MS - 1_000);
    const staleLease = createLease(registryDirectory, randomUUID(), {
      now,
      heartbeatAt: staleAt,
      mtime: staleAt,
    });
    const staleTemporaryLease = createTemporaryLease(registryDirectory, randomUUID(), staleAt);
    const freshLease = createLease(registryDirectory, randomUUID(), { now });

    const directoryReads = vi.mocked(fs.readdirSync);
    directoryReads.mockClear();
    const status = getMcpRuntimeStatus(root, build, {
      now,
      probeRegistryWritable: () => true,
    });

    expect(status).toMatchObject({ activeProcesses: 1, monitoringAvailable: true });
    expect(existsSync(staleLease)).toBe(false);
    expect(existsSync(staleTemporaryLease)).toBe(false);
    expect(existsSync(freshLease)).toBe(true);
    expect(directoryReads).toHaveBeenCalledTimes(1);
    directoryReads.mockRestore();
  });

  it("preserves fresh lease files when the status time is invalid", () => {
    const fixture = createFreshStatusLeaseFixture();

    const status = getMcpRuntimeStatus(fixture.root, fixture.build, {
      now: new Date(Number.NaN),
      probeRegistryWritable: () => true,
    });

    expect(status).toMatchObject({ activeProcesses: 1, monitoringAvailable: true });
    expect(existsSync(fixture.freshLease)).toBe(true);
    expect(existsSync(fixture.freshTemporaryLease)).toBe(true);
  });

  it("preserves fresh lease files when the status heartbeat TTL is NaN", () => {
    const fixture = createFreshStatusLeaseFixture();

    const status = getMcpRuntimeStatus(fixture.root, fixture.build, {
      now: fixture.now,
      heartbeatTtlMs: Number.NaN,
      probeRegistryWritable: () => true,
    });

    expect(status).toMatchObject({ activeProcesses: 1, monitoringAvailable: true });
    expect(existsSync(fixture.freshLease)).toBe(true);
    expect(existsSync(fixture.freshTemporaryLease)).toBe(true);
  });

  it("limits registration and status cleanup to 64 deletions per pass", () => {
    const root = createFixture();
    const build = readMcpBuildIdentity(root);
    if (!build) throw new Error("The synthetic runtime has no build identity.");
    const now = new Date("2026-09-28T12:00:00.000Z");
    const registryDirectory = getMcpRuntimeDirectory(root);
    const staleAt = new Date(now.getTime() - MCP_LEASE_CLEANUP_AGE_MS - 1_000);
    const temporaryLeases = Array.from({ length: 70 }, () =>
      createTemporaryLease(registryDirectory, randomUUID(), staleAt),
    );

    const firstStop = registerMcpProcess(root, build, { now: () => now });
    cleanups.push(firstStop);
    expect(temporaryLeases.filter((path) => existsSync(path))).toHaveLength(6);

    const secondStop = registerMcpProcess(root, build, { now: () => now });
    cleanups.push(secondStop);
    expect(temporaryLeases.filter((path) => existsSync(path))).toHaveLength(0);

    const statusRoot = createFixture();
    const statusBuild = readMcpBuildIdentity(statusRoot);
    if (!statusBuild) throw new Error("The synthetic status runtime has no build identity.");
    const statusDirectory = getMcpRuntimeDirectory(statusRoot);
    const expiredLeases = Array.from({ length: 70 }, () =>
      createLease(statusDirectory, randomUUID(), {
        now,
        heartbeatAt: staleAt,
        mtime: staleAt,
      }),
    );

    const statusOptions = { now, probeRegistryWritable: () => true };
    getMcpRuntimeStatus(statusRoot, statusBuild, statusOptions);
    expect(expiredLeases.filter((path) => existsSync(path))).toHaveLength(6);

    getMcpRuntimeStatus(statusRoot, statusBuild, statusOptions);
    expect(expiredLeases.filter((path) => existsSync(path))).toHaveLength(0);
  });

  it("checks no more than 512 registration directory entries", () => {
    const root = createFixture();
    const build = readMcpBuildIdentity(root);
    if (!build) throw new Error("The synthetic runtime has no build identity.");
    const now = new Date("2026-09-28T12:00:00.000Z");
    const registryDirectory = getMcpRuntimeDirectory(root);
    mkdirSync(registryDirectory, { recursive: true });
    for (let index = 0; index < 512; index += 1) {
      writeFileSync(join(registryDirectory, `.skip-${index.toString().padStart(3, "0")}`), "keep");
    }
    const staleTemporaryLease = createTemporaryLease(
      registryDirectory,
      randomUUID(),
      new Date(now.getTime() - MCP_LEASE_CLEANUP_AGE_MS - 1_000),
    );

    const entries = actualFs
      .readdirSync(registryDirectory, { withFileTypes: true })
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    let readIndex = 0;
    const fakeDirectory = {
      readSync: vi.fn(() => entries[readIndex++] ?? null),
      closeSync: vi.fn(),
    } as unknown as fs.Dir;
    const openedDirectories = vi.mocked(fs.opendirSync);
    openedDirectories.mockClear().mockReturnValue(fakeDirectory);

    const stopProcess = registerMcpProcess(root, build, { now: () => now });
    cleanups.push(stopProcess);

    expect(fakeDirectory.readSync).toHaveBeenCalledTimes(512);
    expect(fakeDirectory.closeSync).toHaveBeenCalledTimes(1);
    expect(existsSync(staleTemporaryLease)).toBe(true);
  });

  it("silently leaves a stale lease when unlinking it fails", () => {
    const root = createFixture();
    const build = readMcpBuildIdentity(root);
    if (!build) throw new Error("The synthetic runtime has no build identity.");
    const now = new Date("2026-09-28T12:00:00.000Z");
    const registryDirectory = getMcpRuntimeDirectory(root);
    const staleAt = new Date(now.getTime() - MCP_LEASE_CLEANUP_AGE_MS - 1_000);
    const staleTemporaryLease = createTemporaryLease(registryDirectory, randomUUID(), staleAt);
    const originalUnlinkSync = actualFs.unlinkSync;
    const unlink = vi.mocked(fs.unlinkSync).mockImplementation((path) => {
      if (String(path) === staleTemporaryLease) throw new Error("Synthetic unlink failure.");
      return originalUnlinkSync(path);
    });

    let stopProcess: (() => void) | undefined;
    try {
      expect(() => {
        stopProcess = registerMcpProcess(root, build, { now: () => now });
      }).not.toThrow();
      expect(unlink).toHaveBeenCalledWith(staleTemporaryLease);
      expect(existsSync(staleTemporaryLease)).toBe(true);
    } finally {
      unlink.mockReset().mockImplementation(originalUnlinkSync);
    }
    if (stopProcess) cleanups.push(stopProcess);
  });

  it("stops after 64 unlink attempts even when every stale-file deletion fails", () => {
    const root = createFixture();
    const build = readMcpBuildIdentity(root);
    if (!build) throw new Error("The synthetic runtime has no build identity.");
    const now = new Date("2026-09-28T12:00:00.000Z");
    const registryDirectory = getMcpRuntimeDirectory(root);
    const staleAt = new Date(now.getTime() - MCP_LEASE_CLEANUP_AGE_MS - 1_000);
    const staleTemporaryLeases = Array.from({ length: 70 }, () =>
      createTemporaryLease(registryDirectory, randomUUID(), staleAt),
    );
    const staleLeasePaths = new Set(staleTemporaryLeases);
    const originalUnlinkSync = actualFs.unlinkSync;
    const unlink = vi.mocked(fs.unlinkSync).mockImplementation((path) => {
      if (staleLeasePaths.has(String(path))) throw new Error("Synthetic unlink failure.");
      return originalUnlinkSync(path);
    });

    const stopProcess = registerMcpProcess(root, build, { now: () => now });
    cleanups.push(stopProcess);

    expect(unlink).toHaveBeenCalledTimes(64);
    expect(staleTemporaryLeases.every((path) => existsSync(path))).toBe(true);
  });
});
