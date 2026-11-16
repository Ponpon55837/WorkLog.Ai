import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashFile } from "../../packages/desktop-core/src/runtime/hash.js";
import {
  POSIX_SHIM_NAME,
  WINDOWS_SHIM_NAME,
  assertAllowedAction,
  buildLaunchPlan,
  buildRuntimeManifest,
  commitCurrent,
  installRuntime,
  measureRuntime,
  planLaunch,
  readCurrentRuntimeId,
  renderLaunchFile,
  renderPosixShim,
  renderWindowsShim,
  runtimeDirectoryFor,
  runtimeLayout,
  verifyRuntime,
  type RuntimeManifest,
} from "../../packages/desktop-core/src/runtime/index.js";
import {
  IS_WINDOWS,
  fixtureDefinition,
  flipFirstByte,
  installFixture,
  makeRoot,
  stageFixture,
  tick,
} from "./runtime-helpers.js";

vi.mock("../../packages/desktop-core/src/runtime/hash.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/desktop-core/src/runtime/hash.js")>();
  return { ...actual, hashFile: vi.fn(actual.hashFile) };
});

let root = "";

beforeEach(async () => {
  root = await makeRoot();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("installRuntime", () => {
  it("writes the launch file, an immutable manifest of every file, both shims, and verifies once", async () => {
    const installed = await installFixture(root, "rt-1");
    const manifest = JSON.parse(
      await fs.readFile(path.join(installed.runtimeDirectory, "runtime-manifest.json"), "utf8"),
    ) as RuntimeManifest;
    expect(manifest).toEqual(installed.manifest);
    expect(manifest.files.map((file) => file.path)).toEqual([
      "app/hook.js",
      "app/mcp.js",
      "app/serve.mjs",
      "app/web/assets/app.js",
      "app/web/index.html",
      "launcher.mjs",
      "node/bin/node",
      "runtime-launch.txt",
    ]);
    expect(manifest.files.find((file) => file.path === "launcher.mjs")).toMatchObject({ size: 12 });
    expect(await fs.readFile(path.join(installed.runtimeDirectory, "runtime-launch.txt"), "utf8")).toBe(
      renderLaunchFile("node/bin/node"),
    );
    const bin = runtimeLayout(root).binDirectory;
    expect(await fs.readFile(path.join(bin, POSIX_SHIM_NAME), "utf8")).toBe(renderPosixShim());
    expect(await fs.readFile(path.join(bin, WINDOWS_SHIM_NAME), "utf8")).toBe(renderWindowsShim());
    // Every file was hashed once, while the manifest was built; the verification accepted those hashes.
    expect(installed.verification.hashedCount).toBe(0);
    expect(installed.verification.cachedCount).toBe(8);
    expect(
      JSON.parse(await fs.readFile(path.join(installed.runtimeDirectory, ".verified.json"), "utf8")),
    ).toMatchObject({
      cacheVersion: 1,
      runtimeId: "rt-1",
    });
  });

  it.skipIf(IS_WINDOWS)("makes the POSIX shim executable by its owner", async () => {
    await installFixture(root);
    expect((await fs.stat(path.join(runtimeLayout(root).binDirectory, POSIX_SHIM_NAME))).mode & 0o100).toBe(0o100);
  });

  it("leaves a live shim alone when installing a second runtime", async () => {
    await installFixture(root, "rt-1");
    const shim = path.join(runtimeLayout(root).binDirectory, POSIX_SHIM_NAME);
    const before = await fs.stat(shim);
    await tick();
    await installFixture(root, "rt-2");
    expect((await fs.stat(shim)).ino).toBe(before.ino);
    expect((await fs.stat(shim)).mtimeMs).toBe(before.mtimeMs);
  });

  it("hashes every file a second time only when asked for a full verification", async () => {
    await stageFixture(root, "rt-1");
    const installed = await installRuntime(root, fixtureDefinition("rt-1"), { fullVerification: true });
    expect(installed.verification.hashedCount).toBe(8);
    expect(installed.verification.cachedCount).toBe(0);
  });

  it("seeds a cache whose fingerprints match the files, so commitCurrent hashes nothing; useCache false hashes all", async () => {
    await installFixture(root, "rt-1");
    expect((await commitCurrent(root, "rt-1")).hashedCount).toBe(0);
    expect((await commitCurrent(root, "rt-1", { useCache: false })).hashedCount).toBe(8);
  });

  it("does not cache a file that changed while it was being hashed", async () => {
    const directory = await stageFixture(root, "rt-1");
    const target = path.join(directory, "app/mcp.js");
    const { hashFile: realHashFile } = await vi.importActual<
      typeof import("../../packages/desktop-core/src/runtime/hash.js")
    >("../../packages/desktop-core/src/runtime/hash.js");
    // Rewrite the file right after its hash was computed, as a concurrent writer would.
    vi.mocked(hashFile).mockImplementation(async (file) => {
      const digest = await realHashFile(file);
      if (file === target) await fs.appendFile(target, "// changed during hashing\n");
      return digest;
    });
    try {
      const measured = await measureRuntime(directory, fixtureDefinition("rt-1"));
      expect(measured.cache.has("app/mcp.js")).toBe(false);
      expect(measured.cache.size).toBe(6);
    } finally {
      vi.mocked(hashFile).mockImplementation(realHashFile);
    }
  });

  it("never overwrites an installed runtime", async () => {
    await installFixture(root, "rt-1");
    await expect(installRuntime(root, fixtureDefinition("rt-1"))).rejects.toMatchObject({
      code: "RUNTIME_ALREADY_INSTALLED",
    });
  });

  it("refuses to install what its own verification would refuse", async () => {
    await stageFixture(root, "rt-1");
    await expect(
      installRuntime(root, { ...fixtureDefinition("rt-1"), executable: "node/bin/missing" }),
    ).rejects.toMatchObject({
      code: "RUNTIME_MANIFEST_INVALID",
    });
  });

  it("rejects ids outside the charset", async () => {
    await expect(installRuntime(root, fixtureDefinition("../escape"))).rejects.toMatchObject({
      code: "RUNTIME_POINTER_INVALID",
    });
  });

  it.skipIf(IS_WINDOWS)("records symlinks with their targets and refuses ones that leave the runtime", async () => {
    const directory = await stageFixture(root, "rt-1");
    await fs.symlink("mcp.js", path.join(directory, "app/alias.js"));
    const manifest = await buildRuntimeManifest(directory, fixtureDefinition("rt-1"));
    expect(manifest.symlinks).toEqual([{ path: "app/alias.js", target: "mcp.js" }]);
    await fs.symlink("../../../outside", path.join(directory, "app/escape"));
    await expect(buildRuntimeManifest(directory, fixtureDefinition("rt-1"))).rejects.toMatchObject({
      code: "RUNTIME_SYMLINK_REJECTED",
    });
  });

  it.skipIf(IS_WINDOWS)("refuses to install a directory with a FIFO in it", async () => {
    const directory = await stageFixture(root, "rt-1");
    const { execFileSync } = await import("node:child_process");
    execFileSync("mkfifo", [path.join(directory, "pipe")]);
    await expect(buildRuntimeManifest(directory, fixtureDefinition("rt-1"))).rejects.toMatchObject({
      code: "RUNTIME_FILE_UNEXPECTED",
    });
  });
});

describe("commitCurrent and the current pointer", () => {
  it("switches the pointer atomically to a verified runtime", async () => {
    await installFixture(root, "rt-1", { commit: true });
    await installFixture(root, "rt-2");
    expect(await readCurrentRuntimeId(root)).toBe("rt-1");
    const verification = await commitCurrent(root, "rt-2");
    expect(verification.runtimeId).toBe("rt-2");
    expect(await readCurrentRuntimeId(root)).toBe("rt-2");
    expect(await fs.readdir(root)).toEqual(expect.not.arrayContaining([expect.stringMatching(/\.tmp$/)]));
  });

  it("never points at a runtime that fails verification, and keeps the old pointer", async () => {
    await installFixture(root, "rt-1", { commit: true });
    const { runtimeDirectory } = await installFixture(root, "rt-2");
    await flipFirstByte(path.join(runtimeDirectory, "app/mcp.js"));
    await expect(commitCurrent(root, "rt-2")).rejects.toMatchObject({ code: "RUNTIME_FILE_TAMPERED" });
    expect(await readCurrentRuntimeId(root)).toBe("rt-1");
    await expect(commitCurrent(root, "rt-3")).rejects.toMatchObject({ code: "RUNTIME_FILE_MISSING" });
    expect(await readCurrentRuntimeId(root)).toBe("rt-1");
  });

  it("reports a missing pointer", async () => {
    await expect(readCurrentRuntimeId(root)).rejects.toMatchObject({ code: "RUNTIME_POINTER_MISSING" });
  });

  it("rejects pointers that are not one valid id", async () => {
    const pointer = path.join(root, "current");
    const bad = [
      "",
      "\n",
      "../rt-1\n",
      "rt 1\n",
      "rt-1\nrt-2\n",
      ".rt\n",
      "rt-1;rm\n",
      `${"a".repeat(129)}\n`,
      "re\u0000\n",
      "\n\nrt-1",
    ];
    for (const content of bad) {
      await fs.writeFile(pointer, content);
      await expect(readCurrentRuntimeId(root), JSON.stringify(content)).rejects.toMatchObject({
        code: "RUNTIME_POINTER_INVALID",
      });
    }
  });

  it("accepts one line with LF, CRLF or no newline", async () => {
    for (const content of ["rt-1\n", "rt-1\r\n", "rt-1"]) {
      await fs.writeFile(path.join(root, "current"), content);
      expect(await readCurrentRuntimeId(root)).toBe("rt-1");
    }
  });

  it("rejects a pointer that is a directory or far too large", async () => {
    const pointer = path.join(root, "current");
    await fs.mkdir(pointer);
    await expect(readCurrentRuntimeId(root)).rejects.toMatchObject({ code: "RUNTIME_POINTER_INVALID" });
    await fs.rm(pointer, { recursive: true });
    await fs.writeFile(pointer, "a".repeat(1000));
    await expect(readCurrentRuntimeId(root)).rejects.toMatchObject({ code: "RUNTIME_POINTER_INVALID" });
  });

  it.skipIf(IS_WINDOWS)("rejects a pointer that is a symlink", async () => {
    await fs.writeFile(path.join(root, "real"), "rt-1\n");
    await fs.symlink(path.join(root, "real"), path.join(root, "current"));
    await expect(readCurrentRuntimeId(root)).rejects.toMatchObject({ code: "RUNTIME_POINTER_INVALID" });
  });

  it.skipIf(IS_WINDOWS)("reports a pointer it cannot read", async () => {
    await fs.writeFile(path.join(root, "current"), "rt-1\n", { mode: 0o000 });
    // Root can read anything; elsewhere the read fails with EACCES, which is reported, not mistaken for "missing".
    if (process.getuid?.() === 0) return;
    await expect(readCurrentRuntimeId(root)).rejects.toMatchObject({ code: "RUNTIME_POINTER_INVALID" });
  });
});

describe("planLaunch", () => {
  it("plans an argv-array launch of the current runtime's executable", async () => {
    const { runtimeDirectory } = await installFixture(root, "rt-1", { commit: true });
    const plan = await planLaunch(root, "serve", ["--port", "65000"], { env: { KEEP: "1" } });
    expect(plan.command).toBe(path.join(runtimeDirectory, "node/bin/node"));
    expect(plan.args).toEqual([path.join(runtimeDirectory, "app/serve.mjs"), "start", "--port", "65000"]);
    expect(plan.env).toEqual({ KEEP: "1" });
  });

  it("sets ELECTRON_RUN_AS_NODE for an Electron runtime and only then", async () => {
    await installFixture(root, "rt-e", { kind: "electron-run-as-node", commit: true });
    expect((await planLaunch(root, "mcp", [], { env: { A: "1" } })).env).toEqual({
      A: "1",
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_NO_ASAR: "1",
    });
    await installFixture(root, "rt-n", { kind: "node", commit: true });
    expect((await planLaunch(root, "mcp", [], { env: { A: "1" } })).env).toEqual({ A: "1" });
  });

  it("uses the process environment by default", async () => {
    await installFixture(root, "rt-1", { commit: true });
    expect((await planLaunch(root, "mcp", [])).env.PATH).toBe(process.env.PATH);
  });

  it("does not interpret arguments: they stay separate array items", async () => {
    await installFixture(root, "rt-1", { commit: true });
    const plan = await planLaunch(root, "mcp", ["a b", "$(id)", "; rm -rf /", ""]);
    expect(plan.args.slice(1)).toEqual(["a b", "$(id)", "; rm -rf /", ""]);
  });

  it("refuses an action that is not on the fixed list before reading anything", async () => {
    await expect(planLaunch(root, "bash", [])).rejects.toMatchObject({ code: "RUNTIME_ACTION_NOT_ALLOWED" });
    expect(() => assertAllowedAction("serve")).not.toThrow();
    expect(() => assertAllowedAction("__proto__")).toThrow(/不允許/);
  });

  it("refuses a listed action the installed runtime does not provide", async () => {
    await stageFixture(root, "rt-1");
    const definition = fixtureDefinition("rt-1");
    await installRuntime(root, { ...definition, actions: { mcp: definition.actions.mcp! } });
    await commitCurrent(root, "rt-1");
    await expect(planLaunch(root, "serve", [])).rejects.toMatchObject({ code: "RUNTIME_ACTION_NOT_ALLOWED" });
    const verified = await verifyRuntime(root, "rt-1");
    expect(() => buildLaunchPlan(verified.runtimeDirectory, verified.manifest, "codex-finalize-reminder", [])).toThrow(
      /沒有提供/,
    );
  });

  it("fails when current points at a runtime that is not installed", async () => {
    await fs.writeFile(path.join(root, "current"), "rt-gone\n");
    await expect(planLaunch(root, "mcp", [])).rejects.toMatchObject({ code: "RUNTIME_FILE_MISSING" });
  });

  it("fails when there is no pointer", async () => {
    await expect(planLaunch(root, "mcp", [])).rejects.toMatchObject({ code: "RUNTIME_POINTER_MISSING" });
  });

  it("fails on a tampered runtime", async () => {
    const { runtimeDirectory } = await installFixture(root, "rt-1", { commit: true });
    await flipFirstByte(path.join(runtimeDirectory, "launcher.mjs"));
    await expect(planLaunch(root, "mcp", [])).rejects.toMatchObject({ code: "RUNTIME_FILE_TAMPERED" });
  });

  it("builds paths below a root with spaces and non-ASCII characters", async () => {
    const { runtimeDirectory } = await installFixture(root, "rt-1", { commit: true });
    expect(runtimeDirectory).toMatch(/ 測試-/);
    expect((await planLaunch(root, "mcp", [])).command.startsWith(runtimeDirectoryFor(root, "rt-1"))).toBe(true);
  });
});
