import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashFile } from "../../packages/desktop-core/src/runtime/hash.js";
import {
  commitCurrent,
  RETIRED_GRACE_MS,
  collectOldRuntimes,
  ensureBundledRuntime,
  installRuntime,
  readCurrentRuntimeId,
  verifyRuntime,
  type EnsureBundledRuntimeOptions,
} from "../../packages/desktop-core/src/runtime/index.js";
import {
  FIXTURE_FILES,
  IS_WINDOWS,
  fixtureAcl,
  fixtureDefinition,
  installFixture,
  makeRoot,
  stageFixture,
} from "./runtime-helpers.js";

vi.mock("../../packages/desktop-core/src/runtime/hash.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/desktop-core/src/runtime/hash.js")>();
  return { ...actual, hashFile: vi.fn(actual.hashFile) };
});

const FILE_COUNT = Object.keys(FIXTURE_FILES).length + 1; // plus runtime-launch.txt
/** Windows verification reads ACLs through PowerShell; the fixtures vouch for them so these tests run anywhere. */
const WINDOWS_ACL = IS_WINDOWS
  ? {
      aclReader: {
        read: async (paths: readonly string[]) => ({
          currentUserSid: "S-1-5-21-1-2-3-1001",
          sddls: paths.map(() => "O:BAG:BAD:PAI(A;OICI;FA;;;BA)"),
        }),
      },
    }
  : {};

let root = "";
let bundleRoot = "";
let bundleSha = "";

async function sha256Of(file: string): Promise<string> {
  return createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
}

async function makeBundle(runtimeId: string, files = FIXTURE_FILES): Promise<string> {
  const directory = await makeRoot("desktop-bundle");
  await installFixture(directory, runtimeId, { commit: true, files });
  await fs.rm(path.join(directory, "runtimes", runtimeId, ".verified.json"));
  await fs.rm(path.join(directory, "bin"), { recursive: true });
  bundleSha = await sha256Of(path.join(directory, "runtimes", runtimeId, "runtime-manifest.json"));
  return directory;
}

function options(extra: Partial<EnsureBundledRuntimeOptions> = {}): EnsureBundledRuntimeOptions {
  return { expectedManifestSha256: bundleSha, verify: WINDOWS_ACL, ...extra };
}

const installedDirectory = (id = "bundle-1"): string => path.join(root, "runtimes", id);

beforeEach(async () => {
  root = await makeRoot("desktop-install-root");
  bundleRoot = await makeBundle("bundle-1");
  vi.mocked(hashFile).mockClear();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(bundleRoot, { recursive: true, force: true });
});

describe("ensureBundledRuntime: install", () => {
  it("copies the bundle, hashes every file once, writes the shims and cache, and points current at it", async () => {
    const result = await ensureBundledRuntime(root, bundleRoot, options());
    expect(result).toMatchObject({ status: "installed", runtimeId: "bundle-1", hashedCount: FILE_COUNT });
    expect(result.bytesCopied).toBeGreaterThan(0);
    expect(vi.mocked(hashFile)).toHaveBeenCalledTimes(FILE_COUNT);
    expect(await readCurrentRuntimeId(root)).toBe("bundle-1");
    await expect(fs.access(path.join(root, "bin", "work-intelligence-launcher"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(root, "bin", "work-intelligence-launcher.cmd"))).resolves.toBeUndefined();
    const verified = await verifyRuntime(root, "bundle-1", { ...WINDOWS_ACL });
    expect(verified.hashedCount).toBe(0);
    expect(await fs.readdir(path.join(root, "runtimes"))).toEqual(["bundle-1"]);
  });

  it("installs the bundle's manifest bytes unchanged", async () => {
    await ensureBundledRuntime(root, bundleRoot, options());
    expect(await sha256Of(path.join(installedDirectory(), "runtime-manifest.json"))).toBe(bundleSha);
  });

  it.skipIf(IS_WINDOWS)("keeps the executable bit and strips group and other write", async () => {
    await fs.chmod(path.join(bundleRoot, "runtimes/bundle-1/app/mcp.js"), 0o666);
    await ensureBundledRuntime(root, bundleRoot, options());
    expect((await fs.stat(path.join(installedDirectory(), "node/bin/node"))).mode & 0o777).toBe(0o755);
    expect((await fs.stat(path.join(installedDirectory(), "app/mcp.js"))).mode & 0o777).toBe(0o644);
  });

  it.skipIf(IS_WINDOWS)("copies a symlink as a link with the listed target", async () => {
    const directory = await makeRoot("desktop-bundle-link");
    const staged = await stageFixture(directory, "bundle-1");
    await fs.symlink("serve.mjs", path.join(staged, "app/serve-link.mjs"));
    await installRuntime(directory, fixtureDefinition("bundle-1"), fixtureAcl);
    await commitCurrent(directory, "bundle-1", fixtureAcl);
    await fs.rm(path.join(staged, ".verified.json"));
    bundleSha = await sha256Of(path.join(staged, "runtime-manifest.json"));
    try {
      await ensureBundledRuntime(root, directory, options());
      expect(await fs.readlink(path.join(installedDirectory(), "app/serve-link.mjs"))).toBe("serve.mjs");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a bundle whose manifest is not the one baked into the App, and installs nothing", async () => {
    await expect(
      ensureBundledRuntime(root, bundleRoot, options({ expectedManifestSha256: "0".repeat(64) })),
    ).rejects.toMatchObject({
      code: "RUNTIME_BUNDLE_INVALID",
    });
    await expect(fs.access(path.join(root, "runtimes"))).rejects.toThrow();
    await expect(fs.access(path.join(root, "current"))).rejects.toThrow();
  });

  it("refuses a malformed expected hash", async () => {
    await expect(
      ensureBundledRuntime(root, bundleRoot, options({ expectedManifestSha256: "abc" })),
    ).rejects.toMatchObject({
      code: "RUNTIME_BUNDLE_INVALID",
    });
  });

  it("refuses a bundle with a file the manifest does not list, a missing file, or a tampered file", async () => {
    const directory = path.join(bundleRoot, "runtimes/bundle-1");
    await fs.writeFile(path.join(directory, "app/extra.js"), "x");
    await expect(ensureBundledRuntime(root, bundleRoot, options())).rejects.toMatchObject({
      code: "RUNTIME_BUNDLE_INVALID",
    });
    await fs.rm(path.join(directory, "app/extra.js"));
    await fs.writeFile(path.join(directory, "app/mcp.js"), "// mcp\n".replace("mcp", "mXp"));
    await expect(ensureBundledRuntime(root, bundleRoot, options())).rejects.toMatchObject({
      code: "RUNTIME_FILE_TAMPERED",
    });
    // Nothing half-installed is left where a later start could trust it.
    expect(await fs.readdir(path.join(root, "runtimes")).catch(() => [])).not.toContain("bundle-1");
    await fs.rm(path.join(directory, "app/mcp.js"));
    await expect(ensureBundledRuntime(root, bundleRoot, options())).rejects.toMatchObject({
      code: "RUNTIME_BUNDLE_INVALID",
    });
  });

  it("refuses a runtime kind the caller does not allow", async () => {
    await expect(
      ensureBundledRuntime(root, bundleRoot, options({ requiredRuntimeKind: "electron-run-as-node" })),
    ).rejects.toMatchObject({ code: "RUNTIME_KIND_NOT_ALLOWED" });
  });
});

describe("ensureBundledRuntime: later starts", () => {
  it("is idempotent: the second call neither hashes nor copies", async () => {
    await ensureBundledRuntime(root, bundleRoot, options());
    vi.mocked(hashFile).mockClear();
    const started = performance.now();
    const again = await ensureBundledRuntime(root, bundleRoot, options());
    const elapsed = performance.now() - started;
    expect(again).toMatchObject({ status: "already-current", bytesCopied: 0, hashedCount: 0 });
    expect(vi.mocked(hashFile)).not.toHaveBeenCalled();
    expect(elapsed).toBeLessThan(250);
  });

  it("switches when the runtime is installed but current names another one", async () => {
    await ensureBundledRuntime(root, bundleRoot, options());
    await installFixture(root, "older", { commit: true });
    expect(await readCurrentRuntimeId(root)).toBe("older");
    vi.mocked(hashFile).mockClear();
    const result = await ensureBundledRuntime(root, bundleRoot, options());
    expect(result).toMatchObject({ status: "switched", bytesCopied: 0, hashedCount: 0 });
    expect(await readCurrentRuntimeId(root)).toBe("bundle-1");
  });

  it("verifies instead of trusting the fast path when asked, and reinstalls a corrupt runtime", async () => {
    await ensureBundledRuntime(root, bundleRoot, options());
    const file = path.join(installedDirectory(), "app/mcp.js");
    await fs.writeFile(file, "// tampered, same size...\n");
    expect((await ensureBundledRuntime(root, bundleRoot, options())).status).toBe("already-current");
    const repaired = await ensureBundledRuntime(root, bundleRoot, options({ verifyInstalled: true }));
    expect(repaired.status).toBe("reinstalled");
    expect(await fs.readFile(file, "utf8")).toBe(FIXTURE_FILES["app/mcp.js"]);
    // The damaged directory was set aside, not deleted... until the next slow path cleans it.
    expect((await fs.readdir(path.join(root, "runtimes"))).sort()).toEqual(
      ["bundle-1", expect.stringMatching(/^\.quarantine-bundle-1-/)].sort(),
    );
    await verifyRuntime(root, "bundle-1", { ...WINDOWS_ACL });
  });

  it("reinstalls a runtime directory that exists with a different manifest", async () => {
    await installFixture(root, "bundle-1", { commit: true, files: { ...FIXTURE_FILES, "app/other.js": "// other\n" } });
    const result = await ensureBundledRuntime(root, bundleRoot, options());
    expect(result.status).toBe("reinstalled");
    expect(await sha256Of(path.join(installedDirectory(), "runtime-manifest.json"))).toBe(bundleSha);
    await expect(fs.access(path.join(installedDirectory(), "app/other.js"))).rejects.toThrow();
  });

  it("reinstalls a directory with no manifest at all", async () => {
    await fs.mkdir(installedDirectory(), { recursive: true });
    await fs.writeFile(path.join(installedDirectory(), "junk"), "x");
    expect((await ensureBundledRuntime(root, bundleRoot, options())).status).toBe("reinstalled");
  });

  it("removes a staging directory a crashed attempt left", async () => {
    const leftover = path.join(root, "runtimes", ".staging-bundle-1-deadbeef");
    await fs.mkdir(path.join(leftover, "app"), { recursive: true });
    await fs.writeFile(path.join(leftover, "app/partial.js"), "x");
    const result = await ensureBundledRuntime(root, bundleRoot, options());
    expect(result.status).toBe("installed");
    expect(await fs.readdir(path.join(root, "runtimes"))).toEqual(["bundle-1"]);
  });
});

describe("ensureBundledRuntime: rename retry", () => {
  function busy(code: string, times: number) {
    let failures = times;
    const rename = vi.fn(async (from: string, to: string) => {
      if (failures > 0) {
        failures -= 1;
        throw Object.assign(new Error(`${code}: busy`), { code });
      }
      await fs.rename(from, to);
    });
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    return { rename, sleep };
  }

  it("installs with the real rename, clock and sleep when no dependencies are given", async () => {
    const result = await ensureBundledRuntime(root, bundleRoot, options());
    expect(result.status).toBe("installed");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("really waits (default sleep) before retrying a busy rename", async () => {
    const { rename } = busy("EBUSY", 1);
    const result = await ensureBundledRuntime(root, bundleRoot, options({ deps: { rename } }));
    expect(result.status).toBe("installed");
    expect(rename).toHaveBeenCalledTimes(2);
  });

  it.each(["EBUSY", "EPERM", "EACCES"])("retries a %s rename with a backoff and then succeeds", async (code) => {
    const deps = busy(code, 3);
    const result = await ensureBundledRuntime(root, bundleRoot, options({ deps }));
    expect(result.status).toBe("installed");
    expect(deps.rename).toHaveBeenCalledTimes(4);
    expect(deps.sleep.mock.calls.map(([ms]) => ms)).toEqual([50, 100, 200]);
  });

  it("gives up after a bounded number of tries and leaves no staging directory", async () => {
    const deps = busy("EBUSY", 1000);
    await expect(ensureBundledRuntime(root, bundleRoot, options({ deps }))).rejects.toMatchObject({
      code: "RUNTIME_INSTALL_FAILED",
    });
    expect(deps.rename).toHaveBeenCalledTimes(9);
    expect(await fs.readdir(path.join(root, "runtimes"))).toEqual([]);
  });

  it("does not retry an error that waiting cannot fix", async () => {
    const deps = busy("ENOSPC", 1);
    await expect(ensureBundledRuntime(root, bundleRoot, options({ deps }))).rejects.toMatchObject({
      code: "RUNTIME_INSTALL_FAILED",
    });
    expect(deps.sleep).not.toHaveBeenCalled();
  });
});

describe("ensureBundledRuntime: permissions are not a reason to reinstall", () => {
  const WIN = { platform: "win32" as const, uid: undefined };
  const unsafe = {
    read: async (paths: readonly string[]) => ({
      currentUserSid: "S-1-5-21-1-2-3-1001",
      sddls: paths.map(() => "O:BAG:BAD:PAI(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;BU)"),
    }),
  };
  const unreadable = { read: async () => Promise.reject(new Error("blocked")) };

  it("propagates unsafe permissions of an installed runtime without touching it", async () => {
    await ensureBundledRuntime(root, bundleRoot, options());
    const before = await fs.readdir(path.join(root, "runtimes"));
    await expect(
      ensureBundledRuntime(
        root,
        bundleRoot,
        options({ verifyInstalled: true, verify: { policy: WIN, aclReader: unsafe } }),
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_UNSAFE_PERMISSIONS" });
    expect(await fs.readdir(path.join(root, "runtimes"))).toEqual(before);
  });

  it("propagates an unreadable ACL the same way", async () => {
    await ensureBundledRuntime(root, bundleRoot, options());
    await expect(
      ensureBundledRuntime(
        root,
        bundleRoot,
        options({ verifyInstalled: true, verify: { policy: WIN, aclReader: unreadable } }),
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_ACL_UNREADABLE" });
    expect((await fs.readdir(path.join(root, "runtimes"))).every((name) => !name.startsWith(".quarantine"))).toBe(true);
  });

  it("does not switch current or quarantine anything when a fresh install fails the permission check", async () => {
    await installFixture(root, "older", { commit: true });
    await expect(
      ensureBundledRuntime(root, bundleRoot, options({ verify: { policy: WIN, aclReader: unsafe } })),
    ).rejects.toMatchObject({ code: "RUNTIME_UNSAFE_PERMISSIONS" });
    expect(await readCurrentRuntimeId(root)).toBe("older");
    expect((await fs.readdir(path.join(root, "runtimes"))).sort()).toEqual(["bundle-1", "older"]);
  });
});

describe("ensureBundledRuntime: shims, previous runtime and rollback", () => {
  it("rewrites a missing or changed shim on the fast path, and leaves a good one alone", async () => {
    await ensureBundledRuntime(root, bundleRoot, options());
    const shim = path.join(root, "bin", "work-intelligence-launcher");
    const good = await fs.readFile(shim, "utf8");
    const before = (await fs.stat(shim)).mtimeMs;
    expect((await ensureBundledRuntime(root, bundleRoot, options())).status).toBe("already-current");
    expect((await fs.stat(shim)).mtimeMs).toBe(before);
    await fs.rm(shim);
    await ensureBundledRuntime(root, bundleRoot, options());
    expect(await fs.readFile(shim, "utf8")).toBe(good);
  });

  it("reports the runtime that was current before", async () => {
    await installFixture(root, "older", { commit: true });
    expect((await ensureBundledRuntime(root, bundleRoot, options())).previousRuntimeId).toBe("older");
    expect((await ensureBundledRuntime(root, bundleRoot, options())).previousRuntimeId).toBeUndefined();
  });

  it("puts a runtime back when its reinstall fails, so current never names a missing directory", async () => {
    await installFixture(root, "bundle-1", { commit: true, files: { ...FIXTURE_FILES, "app/other.js": "// other\n" } });
    let calls = 0;
    const rename = vi.fn(async (from: string, to: string) => {
      calls += 1;
      // The first rename sets the old directory aside; the second is the staging directory going into place.
      if (calls === 2) throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
      await fs.rename(from, to);
    });
    await expect(ensureBundledRuntime(root, bundleRoot, options({ deps: { rename } }))).rejects.toMatchObject({
      code: "RUNTIME_INSTALL_FAILED",
    });
    expect(await readCurrentRuntimeId(root)).toBe("bundle-1");
    await expect(fs.access(path.join(installedDirectory(), "app/other.js"))).resolves.toBeUndefined();
    expect(await fs.readdir(path.join(root, "runtimes"))).toEqual(["bundle-1"]);
  });

  it("reports a directory it cannot move aside as an install failure and changes nothing", async () => {
    await installFixture(root, "bundle-1", { commit: true, files: { ...FIXTURE_FILES, "app/other.js": "// other\n" } });
    const rename = vi.fn(async () => Promise.reject(Object.assign(new Error("in use"), { code: "EBUSY" })));
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    await expect(ensureBundledRuntime(root, bundleRoot, options({ deps: { rename, sleep } }))).rejects.toMatchObject({
      code: "RUNTIME_INSTALL_FAILED",
    });
    expect(await readCurrentRuntimeId(root)).toBe("bundle-1");
    expect(await fs.readdir(path.join(root, "runtimes"))).toEqual(["bundle-1"]);
  });
});

describe("collectOldRuntimes", () => {
  /**
   * Two collections: the first records when each old runtime was seen retired, the second runs after the grace period.
   * Returns what both did together (a leftover is removed by the first, an old runtime by the second).
   */
  async function collectAged(options: Parameters<typeof collectOldRuntimes>[1]): ReturnType<typeof collectOldRuntimes> {
    const first = await collectOldRuntimes(root, options);
    const second = await collectOldRuntimes(root, {
      ...options,
      deps: { now: () => Date.now() + RETIRED_GRACE_MS + 1_000 },
    });
    return {
      removed: [...first.removed, ...second.removed],
      deferred: second.deferred,
      failed: [...first.failed, ...second.failed],
    };
  }

  async function layout(): Promise<void> {
    await installFixture(root, "old-1");
    await installFixture(root, "old-2");
    await installFixture(root, "previous");
    await installFixture(root, "current-id", { commit: true });
    await fs.mkdir(path.join(root, "runtimes", ".quarantine-old-1-aa"), { recursive: true });
    await fs.mkdir(path.join(root, "runtimes", ".staging-x-bb"), { recursive: true });
  }

  it("removes old runtimes and quarantined directories, keeping current, the previous one and any staging directory", async () => {
    await layout();
    const result = await collectAged({ keep: ["previous"] });
    expect([...result.removed].sort()).toEqual([".quarantine-old-1-aa", "old-1", "old-2"]);
    expect(result.failed).toEqual([]);
    expect((await fs.readdir(path.join(root, "runtimes"))).sort()).toEqual([".staging-x-bb", "current-id", "previous"]);
    expect(await readCurrentRuntimeId(root)).toBe("current-id");
  });

  it("never removes the current runtime, even when it is not listed to keep", async () => {
    await layout();
    await collectAged({});
    await expect(fs.access(path.join(root, "runtimes", "current-id"))).resolves.toBeUndefined();
  });

  it("removes only leftovers when asked", async () => {
    await layout();
    const result = await collectOldRuntimes(root, { onlyLeftovers: true });
    expect(result.removed).toEqual([".quarantine-old-1-aa"]);
    expect(await fs.readdir(path.join(root, "runtimes"))).toContain("old-1");
  });

  it("removes nothing but leftovers when current cannot be read", async () => {
    await layout();
    await fs.rm(path.join(root, "current"));
    const result = await collectOldRuntimes(root, {});
    expect(result.removed).toEqual([".quarantine-old-1-aa"]);
  });

  it("leaves a directory that cannot be removed and reports it, without failing", async () => {
    await layout();
    const remove = vi.fn(async (directory: string) => {
      // old-1 is renamed aside before it is removed; the quarantined directory the layout already holds is a different one.
      const name = path.basename(directory);
      if (name.startsWith(".quarantine-old-1-") && name !== ".quarantine-old-1-aa")
        throw Object.assign(new Error("in use"), { code: "EBUSY" });
      await fs.rm(directory, { recursive: true, force: true });
    });
    const result = await collectAged({ keep: ["previous"], remove });
    expect(result.failed).toEqual(["old-1"]);
    expect(result.removed).toContain("old-2");
    const left = await fs.readdir(path.join(root, "runtimes"));
    expect(left.some((name) => name.startsWith(".quarantine-old-1-") && name !== ".quarantine-old-1-aa")).toBe(true);
  });

  it("copes with a root that has no runtimes directory", async () => {
    expect(await collectOldRuntimes(root, {})).toEqual({ removed: [], deferred: [], failed: [] });
  });
});

describe("ensureBundledRuntime: failures around the install", () => {
  async function breakBin(): Promise<void> {
    await fs.rm(path.join(root, "bin"), { recursive: true });
    await fs.writeFile(path.join(root, "bin"), "not a directory");
  }

  it("reports shims that cannot be written on the fast path", async () => {
    await ensureBundledRuntime(root, bundleRoot, options());
    await breakBin();
    await expect(ensureBundledRuntime(root, bundleRoot, options())).rejects.toMatchObject({
      code: "RUNTIME_INSTALL_FAILED",
    });
  });

  it("reports shims that cannot be written after a verification", async () => {
    await ensureBundledRuntime(root, bundleRoot, options());
    await breakBin();
    await expect(ensureBundledRuntime(root, bundleRoot, options({ verifyInstalled: true }))).rejects.toMatchObject({
      code: "RUNTIME_INSTALL_FAILED",
    });
  });

  it("still reports the wrong content when the damaged directory cannot be set aside", async () => {
    const actual = await vi.importActual<typeof import("../../packages/desktop-core/src/runtime/hash.js")>(
      "../../packages/desktop-core/src/runtime/hash.js",
    );
    vi.mocked(hashFile).mockImplementation(async (file) => {
      const digest = await actual.hashFile(file);
      return file.startsWith(installedDirectory()) ? { ...digest, sha256: "0".repeat(64) } : digest;
    });
    const rename = vi.fn(async (from: string, to: string) => {
      if (path.basename(to).startsWith(".quarantine")) {
        throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
      }
      await fs.rename(from, to);
    });
    try {
      await expect(ensureBundledRuntime(root, bundleRoot, options({ deps: { rename } }))).rejects.toMatchObject({
        code: "RUNTIME_FILE_TAMPERED",
      });
    } finally {
      vi.mocked(hashFile).mockImplementation(actual.hashFile);
    }
  });

  it("leaves a directory that appeared during a failed install, and survives a failed restore", async () => {
    await installFixture(root, "bundle-1", { commit: true, files: { ...FIXTURE_FILES, "app/other.js": "// other\n" } });
    let calls = 0;
    const taken = vi.fn(async (from: string, to: string) => {
      calls += 1;
      if (calls === 1) return fs.rename(from, to);
      if (calls === 2) {
        await fs.mkdir(to, { recursive: true });
      }
      throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    });
    await expect(ensureBundledRuntime(root, bundleRoot, options({ deps: { rename: taken } }))).rejects.toMatchObject({
      code: "RUNTIME_INSTALL_FAILED",
    });
    let both = 0;
    const failing = vi.fn(async (from: string, to: string) => {
      both += 1;
      if (both === 1) return fs.rename(from, to);
      throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    });
    await fs.rm(path.join(root, "runtimes", "bundle-1"), { recursive: true, force: true });
    await installFixture(root, "bundle-1", { commit: true, files: { ...FIXTURE_FILES, "app/other.js": "// other\n" } });
    await expect(ensureBundledRuntime(root, bundleRoot, options({ deps: { rename: failing } }))).rejects.toMatchObject({
      code: "RUNTIME_INSTALL_FAILED",
    });
  });
});
