import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configDirectory } from "../../packages/shared/src/database-location.js";
import {
  getMcpLeaseScopeId,
  getMcpRuntimeDirectory,
  getMcpRuntimeStatus,
  normalizeScopePath,
  readMcpBuildIdentity,
  registerMcpLease,
} from "../../packages/shared/src/mcp-runtime.js";
import { createMcpRuntimeFixture } from "../helpers/mcp-runtime-fixture.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, writeFileSync: vi.fn(original.writeFileSync) };
});

// Synthetic installs only; the lease is kept in the isolated config directory of the test setup, TEMP/TMP vary per case.
const roots: string[] = [];
const releases: Array<() => void> = [];
const savedEnvironment = { ...process.env };
const now = new Date("2026-11-19T10:00:00.000Z");

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "wi-lease-location-"));
  roots.push(root);
  return createMcpRuntimeFixture(join(root, "install"));
}

function build(root: string) {
  const identity = readMcpBuildIdentity(root);
  if (!identity) throw new Error("The synthetic runtime has no build identity.");
  return identity;
}

/** What an Agent that passes its own TEMP/TMP (or none) hands to the MCP it starts: `os.tmpdir()` follows it. */
function agentTemporaryDirectory(directory: string | undefined): void {
  for (const name of ["TMPDIR", "TEMP", "TMP"]) {
    if (directory === undefined) delete process.env[name];
    else process.env[name] = directory;
  }
}

beforeEach(() => {
  vi.mocked(fs.writeFileSync).mockClear();
});

afterEach(() => {
  while (releases.length > 0) releases.pop()?.();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  process.env = { ...savedEnvironment };
});

describe("the lease sits where the backend looks, whatever TEMP the Agent passes", () => {
  it("counts an MCP started with another TEMP/TMP than the backend", () => {
    const root = fixture();
    const mcpTemp = join(roots[0] as string, "temp-of-the-agent");
    mkdirSync(mcpTemp);
    const backendTemp = tmpdir();

    agentTemporaryDirectory(mcpTemp);
    expect(tmpdir()).not.toBe(backendTemp);
    releases.push(registerMcpLease(root, build(root), { now: () => now }).release);

    agentTemporaryDirectory(backendTemp);
    const status = getMcpRuntimeStatus(root, build(root), { now });
    expect(status.activeProcesses).toBe(1);
  });

  it("counts an MCP started with no TEMP/TMP at all (Node then falls back to the system directory)", () => {
    const root = fixture();
    agentTemporaryDirectory(undefined);
    releases.push(registerMcpLease(root, build(root), { now: () => now }).release);

    agentTemporaryDirectory(join(roots[0] as string, "backend-temp"));
    expect(getMcpRuntimeStatus(root, build(root), { now }).activeProcesses).toBe(1);
  });

  it("resolves the directory inside the config directory from a restricted Agent environment", () => {
    const root = fixture();
    // What a host that passes only a few variables hands over: no TEMP, no TMP, no config override.
    const restricted = { SystemRoot: "C:\\Windows", USERPROFILE: homedir() };
    const directory = getMcpRuntimeDirectory(root, restricted);
    expect(directory).toBe(getMcpRuntimeDirectory(root, {}));
    expect(directory.startsWith(join(configDirectory(), "mcp-runtime"))).toBe(true);
  });

  it("still counts a process of 1.6.59 that keeps its lease in the system temp directory", () => {
    const root = fixture();
    // The old location: <tmpdir>/work-intelligence/mcp-runtime/<hash of the JavaScript realpath of the root>.
    const legacyScope = createHash("sha256").update(realpathSync(root)).digest("hex").slice(0, 24);
    const legacyDirectory = join(tmpdir(), "work-intelligence", "mcp-runtime", legacyScope);
    mkdirSync(legacyDirectory, { recursive: true, mode: 0o700 });
    roots.push(legacyDirectory);
    const instanceId = "0b8d3f6e-4c1a-4a52-8f0e-2d9d6a1c7b34";
    const identity = build(root);
    writeFileSync(
      join(legacyDirectory, `${instanceId}.json`),
      JSON.stringify({
        instanceId,
        buildId: identity.buildId,
        compatibilityId: identity.compatibilityId,
        version: identity.version,
        startedAt: now.toISOString(),
        heartbeatAt: now.toISOString(),
      }),
    );

    expect(getMcpRuntimeStatus(root, identity, { now }).activeProcesses).toBe(1);
  });
});

describe("the scope of one install is one id however the path is spelled", () => {
  it("gives the 8.3 short name and the long name the same scope when the OS resolves both to one path", () => {
    const root = fixture();
    const long = "C:\\Program Files\\Work Intelligence\\runtimes\\rt-1";
    const resolveNative = (path: string): string =>
      path.toLowerCase().includes("progra~1") ? long : path.replace(/^[A-Za-z]:/, (drive) => drive);
    const short = getMcpLeaseScopeId(root, { WORK_INTELLIGENCE_APP_LEASE_SCOPE: "C:\\PROGRA~1\\WORK~1" }, "win32", () =>
      resolveNative("C:\\PROGRA~1\\WORK~1"),
    );
    const longName = getMcpLeaseScopeId(root, { WORK_INTELLIGENCE_APP_LEASE_SCOPE: long }, "win32", () => long);
    expect(short).toBe(longName);
    expect(short).toMatch(/^[a-f0-9]{24}$/);
  });

  it("ignores case, separators, a long-path prefix and a trailing separator on Windows only", () => {
    expect(normalizeScopePath("\\\\?\\C:\\Users\\Me\\App\\", "win32")).toBe("c:/users/me/app");
    expect(normalizeScopePath("C:/USERS/me/App", "win32")).toBe("c:/users/me/app");
    expect(normalizeScopePath("C:\\", "win32")).toBe("c:/");
    expect(normalizeScopePath("/Users/Me/App", "linux")).toBe("/Users/Me/App");
    expect(normalizeScopePath("/Users/Me/App", "darwin")).not.toBe("/users/me/app");
  });

  it("asks the OS for the real path (the native implementation expands 8.3 names)", () => {
    const root = fixture();
    const asked: string[] = [];
    getMcpLeaseScopeId(root, {}, "linux", (path) => {
      asked.push(path);
      return path;
    });
    expect(asked).toHaveLength(1);
    // The default is realpathSync.native, not the JavaScript walk that leaves a short name as it is.
    expect(getMcpLeaseScopeId(root, {}, "linux")).toBe(getMcpLeaseScopeId(root, {}, "linux", realpathSync.native));
  });
});

describe("a lease that cannot be kept is reported, not swallowed", () => {
  it("says the directory is unavailable, with the system code and the scope id", () => {
    const root = fixture();
    const blocker = join(roots[0] as string, "not-a-directory");
    writeFileSync(blocker, "x");
    const environment = { WORK_INTELLIGENCE_CONFIG_DIR: join(blocker, "config") };

    const registration = registerMcpLease(root, build(root), { now: () => now, environment });
    releases.push(registration.release);

    expect(registration.registration()).toMatchObject({
      scopeId: getMcpLeaseScopeId(root, environment),
      directoryWritable: false,
      failure: "directory_unavailable",
    });
    expect(registration.registration().errorCode).toMatch(/^[A-Z][A-Z0-9_]+$/);
    // The report holds no path.
    expect(JSON.stringify(registration.registration())).not.toContain(blocker);
  });

  it("says a write failed, then recovers when the next heartbeat succeeds", () => {
    const root = fixture();
    const environment = { WORK_INTELLIGENCE_CONFIG_DIR: join(roots[0] as string, "config") };
    const original = vi.mocked(fs.writeFileSync).getMockImplementation() as typeof fs.writeFileSync;
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });

    vi.useFakeTimers();
    try {
      const registration = registerMcpLease(root, build(root), {
        now: () => now,
        environment,
        heartbeatIntervalMs: 1_000,
      });
      releases.push(registration.release);
      expect(registration.registration()).toMatchObject({
        directoryWritable: false,
        failure: "write_failed",
        errorCode: "EACCES",
      });

      vi.mocked(fs.writeFileSync).mockImplementation(original);
      vi.advanceTimersByTime(1_000);
      expect(registration.registration()).toEqual({
        scopeId: getMcpLeaseScopeId(root, environment),
        directoryWritable: true,
      });
    } finally {
      vi.useRealTimers();
    }
    expect(readdirSync(getMcpRuntimeDirectory(root, environment)).some((name) => name.endsWith(".json"))).toBe(true);
    expect(existsSync(join(roots[0] as string, "config", "mcp-runtime"))).toBe(true);
  });
});
