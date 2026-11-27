import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWindowsAclReader,
  ensureBundledRuntime,
  type AclPrewarm,
  type EnsureBundledRuntimeOptions,
  type ExecFileLike,
  type SpawnAclLike,
  type WindowsAclReader,
} from "../../packages/desktop-core/src/runtime/index.js";
import { installFixture, makeRoot } from "./runtime-helpers.js";

const WIN = { platform: "win32" as const, uid: undefined };
const SID = "S-1-5-21-1-2-3-1001";
const TRUSTED_SDDL = "O:BAG:BAD:PAI(A;OICI;FA;;;BA)";
const env = { SystemRoot: "C:\\Windows" };

let root = "";
let bundleRoot = "";
let bundleSha = "";

async function makeBundle(runtimeId: string): Promise<string> {
  const directory = await makeRoot("desktop-bundle");
  await installFixture(directory, runtimeId, { commit: true });
  await fs.rm(path.join(directory, "runtimes", runtimeId, ".verified.json"));
  await fs.rm(path.join(directory, "bin"), { recursive: true });
  bundleSha = createHash("sha256")
    .update(await fs.readFile(path.join(directory, "runtimes", runtimeId, "runtime-manifest.json")))
    .digest("hex");
  return directory;
}

function options(
  aclReader: WindowsAclReader,
  extra: Partial<EnsureBundledRuntimeOptions> = {},
): EnsureBundledRuntimeOptions {
  return { expectedManifestSha256: bundleSha, verify: { policy: WIN, aclReader }, ...extra };
}

function recordingReader(trusted = true, observe: () => string = () => "prewarm") {
  const events: string[] = [];
  const release = vi.fn(() => {
    events.push("release");
  });
  const reader: WindowsAclReader = {
    read: async (paths) => {
      events.push("read");
      return {
        currentUserSid: SID,
        sddls: paths.map(() => (trusted ? TRUSTED_SDDL : `${TRUSTED_SDDL}(A;OICI;0x1301bf;;;BU)`)),
      };
    },
    prewarm: (): AclPrewarm => {
      events.push(observe());
      return { release };
    },
  };
  return { reader, events, release };
}

beforeEach(async () => {
  root = await makeRoot("desktop-install-root");
  bundleRoot = await makeBundle("bundle-1");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(bundleRoot, { recursive: true, force: true });
});

describe("ensureBundledRuntime: ACL reader prewarm", () => {
  it("starts the prewarm once, before the files are copied, and releases it after the verification read", async () => {
    const target = path.join(root, "runtimes", "bundle-1");
    const { reader, events } = recordingReader(true, () => `prewarm (installed: ${existsSync(target)})`);
    const result = await ensureBundledRuntime(root, bundleRoot, options(reader));
    expect(result.status).toBe("installed");
    expect(events).toEqual(["prewarm (installed: false)", "read", "release"]);
    expect(result.aclReads).toBe(1);
  });

  it("never starts PowerShell on the fast path (runtime already installed and current)", async () => {
    const first = recordingReader();
    await ensureBundledRuntime(root, bundleRoot, options(first.reader));
    const second = recordingReader();
    const result = await ensureBundledRuntime(root, bundleRoot, options(second.reader));
    expect(result.status).toBe("already-current");
    expect(second.events).toEqual([]);
  });

  it("does not spawn on the fast path with the real reader either", async () => {
    await ensureBundledRuntime(root, bundleRoot, options(recordingReader().reader));
    const exec = vi.fn<ExecFileLike>();
    const spawn = vi.fn<SpawnAclLike>();
    const reader = createWindowsAclReader(exec, env, spawn);
    const result = await ensureBundledRuntime(root, bundleRoot, options(reader));
    expect(result.status).toBe("already-current");
    expect(exec).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not prewarm when the verified runtime is only re-checked (the ACL read is not certain)", async () => {
    await ensureBundledRuntime(root, bundleRoot, options(recordingReader().reader));
    const again = recordingReader();
    const result = await ensureBundledRuntime(root, bundleRoot, options(again.reader, { verifyInstalled: true }));
    expect(result.status).toBe("already-current");
    expect(again.events).not.toContain("prewarm");
  });

  it("starts nothing where the policy is not Windows", async () => {
    const { reader, events } = recordingReader();
    const install = ensureBundledRuntime(root, bundleRoot, {
      expectedManifestSha256: bundleSha,
      verify: { policy: { platform: "linux", uid: process.getuid?.() }, aclReader: reader },
    });
    // The POSIX policy checks the real mode bits, and a Windows runner reports every file as 0o666 (world-writable), so
    // the same install is refused there. What this case pins is the same on both hosts: nothing was prewarmed.
    if (process.platform === "win32") {
      await expect(install).rejects.toMatchObject({ code: "RUNTIME_UNSAFE_PERMISSIONS" });
    } else {
      await expect(install).resolves.toMatchObject({ status: "installed" });
    }
    expect(events).toEqual([]);
  });

  it("releases the prewarm when the permission check refuses the runtime", async () => {
    const { reader, release } = recordingReader(false);
    await expect(ensureBundledRuntime(root, bundleRoot, options(reader))).rejects.toMatchObject({
      code: "RUNTIME_UNSAFE_PERMISSIONS",
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases the prewarm when the copy fails", async () => {
    const { reader, events, release } = recordingReader();
    const rename = vi.fn(async () => {
      throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
    });
    await expect(ensureBundledRuntime(root, bundleRoot, options(reader, { deps: { rename } }))).rejects.toMatchObject({
      code: "RUNTIME_INSTALL_FAILED",
    });
    expect(events).toEqual(["prewarm", "release"]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("starts no prewarm for a bundle that is refused before any copy", async () => {
    const { reader, events } = recordingReader();
    await fs.writeFile(path.join(bundleRoot, "runtimes", "bundle-1", "stray.txt"), "x");
    await expect(ensureBundledRuntime(root, bundleRoot, options(reader))).rejects.toMatchObject({
      code: "RUNTIME_BUNDLE_INVALID",
    });
    expect(events).toEqual([]);
  });

  it("works with a reader that has no prewarm", async () => {
    const reader: WindowsAclReader = {
      read: async (paths) => ({ currentUserSid: SID, sddls: paths.map(() => TRUSTED_SDDL) }),
    };
    await expect(ensureBundledRuntime(root, bundleRoot, options(reader))).resolves.toMatchObject({
      status: "installed",
      aclReads: 1,
    });
  });
});

describe("ensureBundledRuntime: one tier-1 spawn per install with the real reader", () => {
  function spawner(startupMs: number) {
    const sent: string[][] = [];
    const killed: boolean[] = [];
    const spawn: SpawnAclLike = () => {
      let resolveExit: (value: { stdout: string }) => void = () => undefined;
      const exited = new Promise<{ stdout: string }>((resolve) => {
        resolveExit = resolve;
      });
      const started = new Promise<void>((resolve) => setTimeout(resolve, startupMs));
      const index = killed.push(false) - 1;
      return {
        exited,
        ready: started,
        send: (input) => {
          const paths = input
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => Buffer.from(line, "base64").toString("utf8"));
          sent.push(paths);
          void started.then(() => resolveExit({ stdout: [SID, ...paths.map(() => TRUSTED_SDDL)].join("\r\n") }));
        },
        kill: () => {
          killed[index] = true;
        },
      };
    };
    return { spawn, sent, killed };
  }

  it("spawns tier one once, hands it the existing runtime paths, runs no one-shot PowerShell, and reports the prewarm", async () => {
    const exec = vi.fn<ExecFileLike>();
    const { spawn, sent, killed } = spawner(30);
    const result = await ensureBundledRuntime(root, bundleRoot, options(createWindowsAclReader(exec, env, spawn)));
    expect(result.status).toBe("installed");
    expect(exec).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(root);
    expect(sent[0]).toContain(path.join(root, "runtimes", "bundle-1", "runtime-manifest.json"));
    expect(killed).toEqual([true]);
    expect(result.aclReads).toBe(1);
    expect(result.aclReport).toMatchObject({ tier: "dotnet", attempts: [{ tier: "dotnet", ok: true }] });
    expect(result.aclReport?.prewarmMs).toBeGreaterThanOrEqual(20);
  });

  it("the wait for the answer does not include a start-up that overlapped a slow copy", async () => {
    const exec = vi.fn<ExecFileLike>();
    const { spawn } = spawner(150);
    const rename = vi.fn(async (from: string, to: string) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await fs.rename(from, to);
    });
    const result = await ensureBundledRuntime(
      root,
      bundleRoot,
      options(createWindowsAclReader(exec, env, spawn), { deps: { rename } }),
    );
    const attempt = result.aclReport?.attempts[0];
    expect(attempt?.ms).toBeLessThan(100);
    expect(result.aclReport?.prewarmMs).toBeGreaterThanOrEqual(100);
  });
});
