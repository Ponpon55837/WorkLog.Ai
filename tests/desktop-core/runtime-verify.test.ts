import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RuntimeError,
  installRuntime,
  runtimeDirectoryFor,
  verifyRuntime,
  type RuntimeErrorCode,
} from "../../packages/desktop-core/src/runtime/index.js";
import { forEachLimited } from "../../packages/desktop-core/src/runtime/concurrency.js";
import { permissionProblem } from "../../packages/desktop-core/src/runtime/permissions.js";
import {
  IS_WINDOWS,
  fixtureDefinition,
  flipFirstByte,
  installFixture,
  makeRoot,
  stageFixture,
  tick,
} from "./runtime-helpers.js";

/** The fixture files plus runtime-launch.txt, which the installer adds. */
const FILE_COUNT = 8;

let root = "";
let runtimeDirectory = "";

beforeEach(async () => {
  root = await makeRoot();
  runtimeDirectory = (await installFixture(root, "rt-1")).runtimeDirectory;
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** The error `verifyRuntime` rejects with, for assertions on code and detail. */
async function refusal(options?: Parameters<typeof verifyRuntime>[2]): Promise<RuntimeError> {
  try {
    await verifyRuntime(root, "rt-1", options);
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeError);
    return error as RuntimeError;
  }
  throw new Error("verification passed");
}

async function expectRefusal(code: RuntimeErrorCode, file?: string): Promise<RuntimeError> {
  const error = await refusal();
  expect(error.code).toBe(code);
  if (file !== undefined) expect(error.detail.file).toBe(file);
  expect(error.message).toContain(code);
  expect(error.message).toContain("請從 App 重新安裝 runtime");
  return error;
}

const manifestPath = (): string => path.join(runtimeDirectory, "runtime-manifest.json");
const cachePath = (): string => path.join(runtimeDirectory, ".verified.json");

describe("verifyRuntime: a good install", () => {
  it("passes, counts every file and accepts them all from the cache after the install's own full pass", async () => {
    const result = await verifyRuntime(root, "rt-1");
    expect(result.fileCount).toBe(FILE_COUNT);
    expect(result.hashedCount).toBe(0);
    expect(result.cachedCount).toBe(FILE_COUNT);
    expect(result.runtimeDirectory).toBe(runtimeDirectory);
    expect(result.acl).toBe("checked");
  });

  it("hashes every file once when there is no cache, then writes one", async () => {
    await fs.rm(cachePath());
    expect((await verifyRuntime(root, "rt-1")).hashedCount).toBe(FILE_COUNT);
    expect((await verifyRuntime(root, "rt-1")).hashedCount).toBe(0);
  });

  it("does not use or write the cache when asked not to", async () => {
    await fs.rm(cachePath());
    expect((await verifyRuntime(root, "rt-1", { useCache: false, concurrency: 1 })).hashedCount).toBe(FILE_COUNT);
    await expect(fs.access(cachePath())).rejects.toThrow();
  });

  it("ignores a cache write in progress by another launcher, but not other stray files", async () => {
    await fs.writeFile(path.join(runtimeDirectory, ".verified.json.0a1b2c.tmp"), "{}");
    await verifyRuntime(root, "rt-1");
    await fs.writeFile(path.join(runtimeDirectory, ".verified.json.evil"), "{}");
    await expectRefusal("RUNTIME_FILE_UNEXPECTED", ".verified.json.evil");
  });
});

describe("verifyRuntime: damaged contents", () => {
  it("detects one changed byte even when the mtime is put back and the cache says the file is fine", async () => {
    const target = path.join(runtimeDirectory, "app/mcp.js");
    const before = await fs.stat(target);
    await tick();
    await flipFirstByte(target);
    await fs.utimes(target, before.atimeMs / 1000, before.mtimeMs / 1000);
    // utimes works in fractional seconds, so the restored mtime is within a microsecond of the original.
    expect(Math.abs((await fs.stat(target)).mtimeMs - before.mtimeMs)).toBeLessThan(1);

    const error = await expectRefusal("RUNTIME_FILE_TAMPERED", "app/mcp.js");
    expect(error.detail.expected).toMatch(/^[0-9a-f]{64}$/);
    expect(error.detail.actual).toMatch(/^[0-9a-f]{64}$/);
    expect(error.detail.actual).not.toBe(error.detail.expected);
  });

  it("detects the change without a cache too", async () => {
    await flipFirstByte(path.join(runtimeDirectory, "launcher.mjs"));
    await fs.rm(cachePath());
    await expectRefusal("RUNTIME_FILE_TAMPERED", "launcher.mjs");
  });

  it("refuses a changed size before hashing anything", async () => {
    await fs.appendFile(path.join(runtimeDirectory, "app/serve.mjs"), "x");
    const error = await expectRefusal("RUNTIME_FILE_TAMPERED", "app/serve.mjs");
    expect(error.detail.expected).toBe("9 bytes");
    expect(error.detail.actual).toBe("10 bytes");
  });

  it("does not let a failed verification refresh the cache", async () => {
    const before = await fs.readFile(cachePath(), "utf8");
    await flipFirstByte(path.join(runtimeDirectory, "app/mcp.js"));
    await refusal();
    expect(await fs.readFile(cachePath(), "utf8")).toBe(before);
  });

  it("re-hashes only the file whose fingerprint changed and accepts it when the content is restored", async () => {
    const target = path.join(runtimeDirectory, "app/hook.js");
    const original = await fs.readFile(target);
    await tick();
    await flipFirstByte(target);
    await refusal();
    await tick();
    await fs.writeFile(target, original);
    const result = await verifyRuntime(root, "rt-1");
    expect(result.hashedCount).toBe(1);
    expect(result.cachedCount).toBe(FILE_COUNT - 1);
  });

  it("re-hashes a file that was merely touched", async () => {
    await tick();
    const target = path.join(runtimeDirectory, "app/web/index.html");
    await fs.utimes(target, new Date(), new Date(Date.now() + 1000));
    expect((await verifyRuntime(root, "rt-1")).hashedCount).toBe(1);
  });
});

describe("verifyRuntime: a damaged or forged cache can only cost time", () => {
  it("ignores unparsable, wrong-shape and foreign caches and verifies everything", async () => {
    const good = await fs.readFile(cachePath(), "utf8");
    const parsed = JSON.parse(good) as { files: Record<string, Record<string, string>> };
    const wrongField = structuredClone(parsed);
    wrongField.files["app/mcp.js"]!.ino = "not a number";
    const unknownFile = structuredClone(parsed);
    const firstFile = Object.keys(unknownFile.files)[0] as string;
    unknownFile.files[firstFile]!.sha256 = "short";
    const damaged = [
      "{ not json",
      "[]",
      "null",
      JSON.stringify({ cacheVersion: 2, runtimeId: "rt-1", files: {} }),
      JSON.stringify({ ...parsed, runtimeId: "other" }),
      JSON.stringify({ ...parsed, files: [] }),
      JSON.stringify({ ...parsed, files: null }),
      JSON.stringify(wrongField),
      JSON.stringify(unknownFile),
      JSON.stringify({ ...parsed, files: { x: null } }),
    ];
    for (const text of damaged) {
      await fs.writeFile(cachePath(), text);
      expect((await verifyRuntime(root, "rt-1")).hashedCount).toBe(FILE_COUNT);
    }
  });

  it("ignores a cache that is far too large", async () => {
    await fs.rm(cachePath());
    await fs.writeFile(cachePath(), Buffer.alloc(9 * 1024 * 1024, 0x20));
    expect((await verifyRuntime(root, "rt-1")).hashedCount).toBe(FILE_COUNT);
  });

  it("does not trust a cached hash that differs from the manifest's", async () => {
    const cache = JSON.parse(await fs.readFile(cachePath(), "utf8")) as { files: Record<string, { sha256: string }> };
    cache.files["app/mcp.js"]!.sha256 = "b".repeat(64);
    await fs.writeFile(cachePath(), JSON.stringify(cache));
    expect((await verifyRuntime(root, "rt-1")).hashedCount).toBe(1);
  });

  it("drops cache entries of files that are no longer part of the runtime", async () => {
    const cache = JSON.parse(await fs.readFile(cachePath(), "utf8")) as { files: Record<string, unknown> };
    cache.files["gone.js"] = cache.files["app/mcp.js"];
    await fs.writeFile(cachePath(), JSON.stringify(cache));
    expect((await verifyRuntime(root, "rt-1")).hashedCount).toBe(0);
    expect(Object.keys((JSON.parse(await fs.readFile(cachePath(), "utf8")) as { files: object }).files)).toHaveLength(
      FILE_COUNT,
    );
  });

  it.skipIf(IS_WINDOWS || process.getuid?.() === 0)("still verifies when the cache cannot be written", async () => {
    await fs.rm(cachePath());
    await fs.chmod(runtimeDirectory, 0o555);
    try {
      expect((await verifyRuntime(root, "rt-1")).fileCount).toBe(FILE_COUNT);
    } finally {
      await fs.chmod(runtimeDirectory, 0o755);
    }
  });
});

describe("verifyRuntime: structure", () => {
  it("refuses a file the manifest does not list, at any depth", async () => {
    await fs.writeFile(path.join(runtimeDirectory, "planted.js"), "evil");
    await expectRefusal("RUNTIME_FILE_UNEXPECTED", "planted.js");
    await fs.rm(path.join(runtimeDirectory, "planted.js"));
    await fs.writeFile(path.join(runtimeDirectory, "app/web/assets/planted.js"), "evil");
    await expectRefusal("RUNTIME_FILE_UNEXPECTED", "app/web/assets/planted.js");
  });

  it("refuses a missing file", async () => {
    await fs.rm(path.join(runtimeDirectory, "app/web/index.html"));
    await expectRefusal("RUNTIME_FILE_MISSING", "app/web/index.html");
  });

  it("refuses a listed file replaced by a directory", async () => {
    const target = path.join(runtimeDirectory, "app/mcp.js");
    await fs.rm(target);
    await fs.mkdir(target);
    await expectRefusal("RUNTIME_FILE_MISSING", "app/mcp.js");
  });

  it.skipIf(IS_WINDOWS)(
    "refuses a symlink the manifest does not list, even one that points inside the runtime",
    async () => {
      await fs.symlink("mcp.js", path.join(runtimeDirectory, "app/alias.js"));
      const error = await expectRefusal("RUNTIME_SYMLINK_REJECTED", "app/alias.js");
      expect(error.detail.actual).toBe("mcp.js");
    },
  );

  it.skipIf(IS_WINDOWS)("refuses a listed file that was swapped for a symlink to the same content", async () => {
    const target = path.join(runtimeDirectory, "app/mcp.js");
    await fs.rename(target, path.join(root, "outside.js"));
    await fs.symlink(path.join(root, "outside.js"), target);
    await expectRefusal("RUNTIME_SYMLINK_REJECTED", "app/mcp.js");
  });

  it.skipIf(IS_WINDOWS)("refuses a runtime directory that is itself a symlink", async () => {
    const link = runtimeDirectoryFor(root, "rt-link");
    await fs.symlink(runtimeDirectory, link);
    await expect(verifyRuntime(root, "rt-link")).rejects.toMatchObject({ code: "RUNTIME_SYMLINK_REJECTED" });
  });

  it.skipIf(IS_WINDOWS)("refuses sockets, FIFOs and devices", async () => {
    execFileSync("mkfifo", [path.join(runtimeDirectory, "app/pipe")]);
    await expectRefusal("RUNTIME_FILE_UNEXPECTED", "app/pipe");
  });

  it("refuses a runtime directory that does not exist", async () => {
    await expect(verifyRuntime(root, "rt-missing")).rejects.toMatchObject({ code: "RUNTIME_FILE_MISSING" });
  });

  it("refuses ids outside the charset before touching the file system", async () => {
    for (const id of ["", "../rt-1", "rt/1", "rt 1", ".hidden", "a".repeat(129)]) {
      await expect(verifyRuntime(root, id)).rejects.toMatchObject({ code: "RUNTIME_POINTER_INVALID" });
    }
  });
});

describe("verifyRuntime: symlinks the manifest lists", () => {
  it.skipIf(IS_WINDOWS)("accepts them, notices a retargeted link and a missing one", async () => {
    await stageFixture(root, "rt-links");
    const directory = runtimeDirectoryFor(root, "rt-links");
    await fs.mkdir(path.join(directory, "Frameworks/Versions/A"), { recursive: true });
    await fs.writeFile(path.join(directory, "Frameworks/Versions/A/Lib"), "lib");
    await fs.symlink("A", path.join(directory, "Frameworks/Versions/Current"));
    await fs.symlink("Versions/Current/Lib", path.join(directory, "Frameworks/Lib"));
    const installed = await installRuntime(root, fixtureDefinition("rt-links"));
    expect(installed.manifest.symlinks).toEqual([
      { path: "Frameworks/Lib", target: "Versions/Current/Lib" },
      { path: "Frameworks/Versions/Current", target: "A" },
    ]);

    await fs.rm(path.join(directory, "Frameworks/Versions/Current"));
    await fs.symlink("B", path.join(directory, "Frameworks/Versions/Current"));
    await expect(verifyRuntime(root, "rt-links")).rejects.toMatchObject({ code: "RUNTIME_FILE_TAMPERED" });

    await fs.rm(path.join(directory, "Frameworks/Versions/Current"));
    await expect(verifyRuntime(root, "rt-links")).rejects.toMatchObject({ code: "RUNTIME_FILE_MISSING" });

    await fs.symlink("A", path.join(directory, "Frameworks/Versions/Current"));
    expect((await verifyRuntime(root, "rt-links")).fileCount).toBe(FILE_COUNT + 1);
  });
});

describe("verifyRuntime: bookkeeping names are for plain files only", () => {
  it.each([".verified.json", "runtime-manifest.json", ".verified.json.0a1b2c.tmp"])(
    "refuses a directory named %s at the runtime root",
    async (name) => {
      const manifest = await fs.readFile(manifestPath());
      await fs.rm(path.join(runtimeDirectory, name), { force: true });
      if (name === "runtime-manifest.json") await fs.writeFile(path.join(root, "manifest-copy"), manifest);
      await fs.mkdir(path.join(runtimeDirectory, name, "evil"), { recursive: true });
      await fs.writeFile(path.join(runtimeDirectory, name, "evil", "payload.js"), "evil");
      // For the manifest name the manifest itself is gone, so the failure is the manifest; the others fail on structure.
      const error = await refusal();
      expect(["RUNTIME_FILE_UNEXPECTED", "RUNTIME_MANIFEST_INVALID"]).toContain(error.code);
    },
  );

  it.skipIf(IS_WINDOWS).each([".verified.json", ".verified.json.0a1b2c.tmp"])(
    "refuses a symlink named %s at the runtime root",
    async (name) => {
      await fs.rm(path.join(runtimeDirectory, name), { force: true });
      await fs.symlink("app", path.join(runtimeDirectory, name));
      await expectRefusal("RUNTIME_FILE_UNEXPECTED", name);
    },
  );

  it("refuses an empty directory using the cache's name, which the scan would otherwise skip", async () => {
    await fs.rm(cachePath());
    await fs.mkdir(cachePath());
    await expectRefusal("RUNTIME_FILE_UNEXPECTED", ".verified.json");
  });

  it("matches the cache's temporary name exactly: the dot is a dot, not any character", async () => {
    await fs.writeFile(path.join(runtimeDirectory, ".verifiedXjson.ab.tmp"), "{}");
    await expectRefusal("RUNTIME_FILE_UNEXPECTED", ".verifiedXjson.ab.tmp");
    await fs.rm(path.join(runtimeDirectory, ".verifiedXjson.ab.tmp"));
    await fs.writeFile(path.join(runtimeDirectory, ".verified.json.abXtmp"), "{}");
    await expectRefusal("RUNTIME_FILE_UNEXPECTED", ".verified.json.abXtmp");
    await fs.rm(path.join(runtimeDirectory, ".verified.json.abXtmp"));
    await fs.writeFile(path.join(runtimeDirectory, ".verified.json.zz.tmp"), "{}");
    await expectRefusal("RUNTIME_FILE_UNEXPECTED", ".verified.json.zz.tmp");
  });
});

describe("verifyRuntime: symlink chains cannot leave the runtime", () => {
  /** Writes a manifest that lists the given links by hand, bypassing the installer's own refusal. */
  async function manifestListing(links: { path: string; target: string }[]): Promise<void> {
    const manifest = JSON.parse(await fs.readFile(manifestPath(), "utf8")) as { symlinks: unknown[] };
    manifest.symlinks = links;
    await fs.writeFile(manifestPath(), `${JSON.stringify(manifest)}\n`);
    await fs.rm(cachePath(), { force: true });
  }

  it.skipIf(IS_WINDOWS)(
    "refuses a -> ../a chain whose lexical result escapes (a/b -> ../a, x -> a/b/b/../..)",
    async () => {
      await fs.symlink("../app", path.join(runtimeDirectory, "app/b"));
      await fs.symlink("app/b/b/../..", path.join(runtimeDirectory, "x"));
      await manifestListing([
        { path: "app/b", target: "../app" },
        { path: "x", target: "app/b/b/../.." },
      ]);
      const error = await expectRefusal("RUNTIME_SYMLINK_REJECTED");
      expect(error.detail.file).toBe("x");
    },
  );

  it.skipIf(IS_WINDOWS)("refuses a self-referencing link used to climb out from a deeper directory", async () => {
    await fs.symlink("../web", path.join(runtimeDirectory, "app/web/l"));
    await fs.symlink("app/web/l/l/../../..", path.join(runtimeDirectory, "y"));
    await manifestListing([
      { path: "app/web/l", target: "../web" },
      { path: "y", target: "app/web/l/l/../../.." },
    ]);
    const error = await expectRefusal("RUNTIME_SYMLINK_REJECTED");
    expect(error.detail.file).toBe("y");
  });

  it.skipIf(IS_WINDOWS)("refuses a dangling link and a link loop", async () => {
    await fs.symlink("nowhere", path.join(runtimeDirectory, "dangling"));
    await manifestListing([{ path: "dangling", target: "nowhere" }]);
    await expectRefusal("RUNTIME_SYMLINK_REJECTED", "dangling");
    await fs.rm(path.join(runtimeDirectory, "dangling"));
    await fs.symlink("loop2", path.join(runtimeDirectory, "loop1"));
    await fs.symlink("loop1", path.join(runtimeDirectory, "loop2"));
    await manifestListing([
      { path: "loop1", target: "loop2" },
      { path: "loop2", target: "loop1" },
    ]);
    await expectRefusal("RUNTIME_SYMLINK_REJECTED");
  });

  it.skipIf(IS_WINDOWS)("refuses to install the same chain", async () => {
    const directory = await stageFixture(root, "rt-chain");
    await fs.symlink("../app", path.join(directory, "app/b"));
    await fs.symlink("app/b/b/../..", path.join(directory, "x"));
    await expect(installRuntime(root, fixtureDefinition("rt-chain"))).rejects.toMatchObject({
      code: "RUNTIME_SYMLINK_REJECTED",
    });
    await expect(fs.access(path.join(directory, "runtime-manifest.json"))).rejects.toThrow();
  });
});

describe("verifyRuntime: the manifest", () => {
  it("refuses a missing, unreadable-as-JSON, wrong-shape or oversized manifest", async () => {
    const original = await fs.readFile(manifestPath(), "utf8");
    await fs.rm(manifestPath());
    await expectRefusal("RUNTIME_MANIFEST_INVALID", manifestPath());

    await fs.writeFile(manifestPath(), '{ "manifestVersion": 1,');
    await expectRefusal("RUNTIME_MANIFEST_INVALID", manifestPath());

    await fs.writeFile(manifestPath(), JSON.stringify({ ...JSON.parse(original), manifestVersion: 2 }));
    await expectRefusal("RUNTIME_MANIFEST_INVALID");

    await fs.writeFile(manifestPath(), Buffer.alloc(5 * 1024 * 1024, 0x20));
    await expectRefusal("RUNTIME_MANIFEST_INVALID", manifestPath());

    await fs.rm(manifestPath());
    await fs.mkdir(manifestPath());
    await expectRefusal("RUNTIME_MANIFEST_INVALID", manifestPath());
  });

  it("refuses a manifest whose runtimeId is not the directory's", async () => {
    const manifest = JSON.parse(await fs.readFile(manifestPath(), "utf8")) as Record<string, unknown>;
    await fs.writeFile(manifestPath(), JSON.stringify({ ...manifest, runtimeId: "rt-2" }));
    const error = await expectRefusal("RUNTIME_MANIFEST_INVALID");
    expect(error.detail).toMatchObject({ expected: "rt-1", actual: "rt-2" });
  });

  it("refuses a manifest that lists a traversal path", async () => {
    const manifest = JSON.parse(await fs.readFile(manifestPath(), "utf8")) as { files: { path: string }[] };
    manifest.files[0]!.path = "../escape";
    await fs.writeFile(manifestPath(), JSON.stringify(manifest));
    const error = await expectRefusal("RUNTIME_MANIFEST_INVALID");
    expect(error.detail.actual).toContain("dot segment");
  });

  it.skipIf(IS_WINDOWS)("refuses a manifest that is a symlink", async () => {
    await fs.rename(manifestPath(), path.join(root, "manifest.json"));
    await fs.symlink(path.join(root, "manifest.json"), manifestPath());
    await expectRefusal("RUNTIME_MANIFEST_INVALID", manifestPath());
  });
});

describe("verifyRuntime: permissions", () => {
  const worldWritable = (target: string): Promise<void> => fs.chmod(target, 0o757);

  it.skipIf(IS_WINDOWS)(
    "refuses a world-writable launcher root, runtimes folder, runtime directory, manifest or file",
    async () => {
      for (const relative of [
        "",
        "runtimes",
        "runtimes/rt-1",
        "runtimes/rt-1/runtime-manifest.json",
        "runtimes/rt-1/app/mcp.js",
        "runtimes/rt-1/app",
      ]) {
        const target = path.join(root, relative);
        const before = (await fs.stat(target)).mode & 0o7777;
        await worldWritable(target);
        const error = await expectRefusal("RUNTIME_UNSAFE_PERMISSIONS");
        expect(error.detail.actual).toContain("任何使用者");
        await fs.chmod(target, before);
      }
      expect((await verifyRuntime(root, "rt-1")).fileCount).toBe(FILE_COUNT);
    },
  );

  it.skipIf(IS_WINDOWS)("refuses a world-writable bin folder and current pointer", async () => {
    await fs.writeFile(path.join(root, "current"), "rt-1\n");
    for (const relative of ["bin", "current"]) {
      const target = path.join(root, relative);
      const before = (await fs.stat(target)).mode & 0o7777;
      await worldWritable(target);
      await expectRefusal("RUNTIME_UNSAFE_PERMISSIONS");
      await fs.chmod(target, before);
    }
  });

  it.skipIf(IS_WINDOWS)(
    "refuses bin, runtimes and current when they are symlinks, whatever they point at",
    async () => {
      await fs.writeFile(path.join(root, "current"), "rt-1\n");
      for (const name of ["bin", "runtimes", "current"]) {
        const target = path.join(root, name);
        const moved = path.join(root, `${name}-real`);
        await fs.rename(target, moved);
        await fs.symlink(moved, target);
        await expectRefusal("RUNTIME_SYMLINK_REJECTED", target);
        await fs.rm(target);
        await fs.rename(moved, target);
      }
      expect((await verifyRuntime(root, "rt-1")).fileCount).toBe(FILE_COUNT);
    },
  );

  it.skipIf(IS_WINDOWS)("follows a symlinked launcher root but checks the directory it points at", async () => {
    const link = `${root}-link`;
    await fs.symlink(root, link);
    try {
      expect((await verifyRuntime(link, "rt-1")).fileCount).toBe(FILE_COUNT);
      await fs.chmod(root, 0o757);
      await expect(verifyRuntime(link, "rt-1")).rejects.toMatchObject({ code: "RUNTIME_UNSAFE_PERMISSIONS" });
    } finally {
      await fs.chmod(root, 0o755);
      await fs.rm(link);
    }
  });

  // Real stat: on Windows every entry reports mode 666, so the POSIX policy stops at world-writable first. The injected-stat
  // cases in "permissionProblem" below cover the same rules on every platform.
  it.skipIf(IS_WINDOWS)("refuses entries owned by someone other than the current user", async () => {
    const uid = process.getuid?.() ?? 1000;
    const error = await refusal({ policy: { platform: "linux", uid: uid + 1 } });
    expect(error.code).toBe("RUNTIME_UNSAFE_PERMISSIONS");
    expect(error.detail.actual).toContain(`uid ${uid + 1}`);
  });

  describe("Windows ACLs", () => {
    const WIN = { platform: "win32" as const, uid: undefined };
    const GOOD = "O:BAG:BAD:PAI(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;OICI;FA;;;S-1-5-21-1-2-3-1001)";
    const BAD = "O:BAG:BAD:PAI(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;BU)";

    function fixtureReader(sddl: string) {
      const read = vi.fn(async (paths: readonly string[]) => ({
        currentUserSid: "S-1-5-21-1-2-3-1001",
        sddls: paths.map(() => sddl),
      }));
      return { read };
    }

    it("reads the ACLs of the root, bin, runtimes and the runtime's own files, and says so", async () => {
      const aclReader = fixtureReader(GOOD);
      const result = await verifyRuntime(root, "rt-1", { policy: WIN, aclReader, useCache: false });
      expect(result).toMatchObject({ acl: "checked", aclRead: true, aclReport: { tier: "dotnet" } });
      const paths = aclReader.read.mock.calls[0]?.[0] ?? [];
      expect(paths).toEqual(
        expect.arrayContaining([root, path.join(root, "bin"), path.join(root, "runtimes"), runtimeDirectory]),
      );
    });

    it("refuses a runtime a stranger can write, before hashing anything", async () => {
      await expect(
        verifyRuntime(root, "rt-1", { policy: WIN, aclReader: fixtureReader(BAD), useCache: false }),
      ).rejects.toMatchObject({ code: "RUNTIME_UNSAFE_PERMISSIONS" });
    });

    it("ignores the POSIX mode bits Windows reports for every entry", async () => {
      await fs.chmod(path.join(root, "runtimes/rt-1/app"), 0o777).catch(() => undefined);
      await expect(verifyRuntime(root, "rt-1", { policy: WIN, aclReader: fixtureReader(GOOD) })).resolves.toMatchObject(
        {
          acl: "checked",
        },
      );
    });

    it("reads the ACLs once, then trusts the stamp until an object it covers changes", async () => {
      const aclReader = fixtureReader(GOOD);
      // Start from no stamp: on Windows the fixture install already wrote one (from its own ACL read), which would make
      // the first verification below a stamp hit.
      await fs.rm(cachePath());
      expect((await verifyRuntime(root, "rt-1", { policy: WIN, aclReader })).aclRead).toBe(true);
      expect(await fs.readFile(cachePath(), "utf8")).toContain('"acl"');
      aclReader.read.mockClear();
      expect((await verifyRuntime(root, "rt-1", { policy: WIN, aclReader })).aclRead).toBe(false);
      expect(aclReader.read).not.toHaveBeenCalled();
      // A shim is covered by the stamp: touching it (a new change time) reads the ACLs again, once.
      await tick();
      const shim = path.join(root, "bin", "work-intelligence-launcher");
      await fs.utimes(shim, new Date(), new Date());
      expect((await verifyRuntime(root, "rt-1", { policy: WIN, aclReader })).aclRead).toBe(true);
      expect((await verifyRuntime(root, "rt-1", { policy: WIN, aclReader })).aclRead).toBe(false);
    });

    it.each([
      ["an install or switch", { alwaysCheckAcl: true }],
      ["a full pass", { useCache: false }],
    ])("reads the ACLs for %s even when the stamp matches", async (_name, extra) => {
      const aclReader = fixtureReader(GOOD);
      await verifyRuntime(root, "rt-1", { policy: WIN, aclReader });
      expect((await verifyRuntime(root, "rt-1", { policy: WIN, aclReader, ...extra })).aclRead).toBe(true);
    });

    it("reads the ACLs again when a file misses the cache or the cache is gone", async () => {
      const aclReader = fixtureReader(GOOD);
      await verifyRuntime(root, "rt-1", { policy: WIN, aclReader });
      await fs.rm(cachePath());
      expect((await verifyRuntime(root, "rt-1", { policy: WIN, aclReader })).aclRead).toBe(true);
      await tick();
      await fs.utimes(path.join(runtimeDirectory, "app/mcp.js"), new Date(), new Date());
      expect((await verifyRuntime(root, "rt-1", { policy: WIN, aclReader })).aclRead).toBe(true);
    });

    it("skips the ACLs for a content-only verification and says so", async () => {
      const aclReader = fixtureReader(BAD);
      const result = await verifyRuntime(root, "rt-1", { policy: WIN, aclReader, checkAcl: false });
      expect(result).toMatchObject({ acl: "skipped", aclRead: false });
      expect(result).not.toHaveProperty("aclReport");
      expect(aclReader.read).not.toHaveBeenCalled();
    });

    it("covers launcher.mjs, both shims and the manifest in the paths it reads", async () => {
      const aclReader = fixtureReader(GOOD);
      await verifyRuntime(root, "rt-1", { policy: WIN, aclReader, useCache: false });
      const paths = aclReader.read.mock.calls[0]?.[0] ?? [];
      expect(paths).toEqual(
        expect.arrayContaining([
          path.join(root, "bin", "work-intelligence-launcher"),
          path.join(root, "bin", "work-intelligence-launcher.cmd"),
          path.join(runtimeDirectory, "launcher.mjs"),
          path.join(runtimeDirectory, "runtime-manifest.json"),
        ]),
      );
    });

    it("still verifies file contents", async () => {
      await flipFirstByte(path.join(runtimeDirectory, "app/mcp.js"));
      await fs.rm(cachePath());
      await expect(verifyRuntime(root, "rt-1", { policy: WIN, aclReader: fixtureReader(GOOD) })).rejects.toMatchObject({
        code: "RUNTIME_FILE_TAMPERED",
      });
    });
  });

  it.skipIf(IS_WINDOWS)("does not require an owner when the platform has no uid", async () => {
    const result = await verifyRuntime(root, "rt-1", { policy: { platform: "linux", uid: undefined } });
    expect(result.acl).toBe("checked");
  });
});

describe("permissionProblem", () => {
  const linux = { platform: "linux" as const, uid: 1000 };

  it.each([
    ["a private file", { mode: 0o100644, uid: 1000 }, linux, undefined],
    ["a private directory", { mode: 0o040755, uid: 1000 }, linux, undefined],
    ["a group-writable file", { mode: 0o100664, uid: 1000 }, linux, undefined],
    ["a world-writable file", { mode: 0o100666, uid: 1000 }, linux, "mode 666"],
    ["a world-writable directory", { mode: 0o040777, uid: 1000 }, linux, "mode 777"],
    ["another owner", { mode: 0o100644, uid: 1001 }, linux, "uid 1001"],
    ["world-writable and another owner", { mode: 0o100666, uid: 1001 }, linux, "mode 666"],
    [
      "no uid on the platform",
      { mode: 0o100644, uid: 1001 },
      { platform: "linux" as const, uid: undefined },
      undefined,
    ],
    ["macOS like Linux", { mode: 0o100646, uid: 501 }, { platform: "darwin" as const, uid: 501 }, "mode 646"],
    // What Node reports for every entry on Windows: mode 666 and uid 0. the ACL check (windows-acl.ts) replaces the mode bits.
    ["a Windows entry", { mode: 0o100666, uid: 0 }, { platform: "win32" as const, uid: undefined }, undefined],
  ])("%s", (_name, entry, policy, problem) => {
    const found = permissionProblem(entry, policy);
    if (problem === undefined) expect(found).toBeUndefined();
    else expect(found).toContain(problem);
  });
});

describe("forEachLimited limits", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "throws for a limit of %s instead of skipping the work",
    async (limit) => {
      let ran = false;
      await expect(
        forEachLimited([1], limit, async () => {
          ran = true;
        }),
      ).rejects.toThrow(RangeError);
      expect(ran).toBe(false);
    },
  );

  it.each([0, -3, Number.NaN])(
    "verifyRuntime rejects concurrency %s rather than passing without hashing",
    async (concurrency) => {
      await fs.rm(cachePath());
      await flipFirstByte(path.join(runtimeDirectory, "app/mcp.js"));
      await expect(verifyRuntime(root, "rt-1", { concurrency, useCache: false })).rejects.toThrow(RangeError);
    },
  );
});

describe("forEachLimited", () => {
  it("never runs more than the limit at once and visits every item", async () => {
    let active = 0;
    let peak = 0;
    const seen: number[] = [];
    await forEachLimited([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await tick(2);
      seen.push(item);
      active -= 1;
    });
    expect(peak).toBe(3);
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("starts nothing new after a failure and throws the first one", async () => {
    const started: number[] = [];
    await expect(
      forEachLimited([1, 2, 3, 4, 5, 6], 2, async (item) => {
        started.push(item);
        await tick(2);
        throw new Error(`failed ${item}`);
      }),
    ).rejects.toThrow("failed 1");
    expect(started).toHaveLength(2);
  });

  it("handles an empty list", async () => {
    await forEachLimited([], 4, async () => {
      throw new Error("never");
    });
  });
});
