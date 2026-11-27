import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { buildSync } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GC_STATE_FILE_NAME,
  RETIRED_GRACE_MS,
  collectOldRuntimes,
  ensureBundledRuntime,
  leaseDirectoryFor,
  readCurrentRuntimeId,
  type RuntimeCollectionDeps,
} from "../../packages/desktop-core/src/runtime/index.js";
import { FIXTURE_FILES, IS_WINDOWS, fixtureAcl, installFixture, makeRoot } from "./runtime-helpers.js";

// Real child processes against the real file system; the clock is only injected where the test must wait out a heartbeat.

const LEASE_SOURCE = path.resolve(import.meta.dirname, "../../packages/desktop-core/src/runtime/lease.ts");
/** Windows verification reads ACLs through PowerShell; the fixtures vouch for them so these tests run anywhere. */
const ACL = fixtureAcl;

let root = "";
let scratch = "";
const children: ChildProcessWithoutNullStreams[] = [];

beforeEach(async () => {
  root = await makeRoot("desktop-gc-live");
  scratch = await makeRoot("desktop-gc-live-scratch");
});

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(scratch, { recursive: true, force: true });
});

function firstLine(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    child.stdout.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      const line = text.split(/\r?\n/)[0];
      if (text.includes("\n") && line !== undefined) resolve(line);
    });
    child.once("error", reject);
    child.once("exit", () => reject(new Error(`child exited before it answered: ${text}`)));
  });
}

function exited(child: ChildProcessWithoutNullStreams): Promise<void> {
  return child.exitCode !== null ? Promise.resolve() : new Promise((resolve) => child.once("exit", () => resolve()));
}

async function seedRetired(names: readonly string[]): Promise<void> {
  const retiredAt = Object.fromEntries(
    names.map((name) => [name, new Date(Date.now() - RETIRED_GRACE_MS - 60_000).toISOString()]),
  );
  await fs.writeFile(
    path.join(root, "leases", GC_STATE_FILE_NAME),
    JSON.stringify({ version: 1, retiredAt, kept: [] }),
  );
}

async function startLeaseHolder(runtimeId: string): Promise<ChildProcessWithoutNullStreams> {
  const script = path.join(scratch, "lease-holder.mjs");
  buildSync({
    stdin: {
      contents: `
        import { createLease } from ${JSON.stringify(LEASE_SOURCE)};
        const lease = createLease(${JSON.stringify(root)}, ${JSON.stringify(runtimeId)}, "mcp");
        setInterval(() => lease.refresh(), 20);
        process.stdout.write("ready\\n");
        process.stdin.on("end", () => { lease.remove(); process.exit(0); });
        process.stdin.resume();`,
      resolveDir: scratch,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: script,
    logLevel: "silent",
  });
  const child = spawn(process.execPath, [script], { stdio: "pipe" });
  children.push(child);
  expect(await firstLine(child)).toBe("ready");
  return child;
}

describe.skipIf(IS_WINDOWS)("collectOldRuntimes with a live process (macOS and Linux)", () => {
  beforeEach(async () => {
    await installFixture(root, "old-1");
    await installFixture(root, "cur-1", { commit: true });
    await seedRetired(["old-1"]);
  });

  it("defers while a process refreshes its lease, and removes the runtime after the process dies and its lease goes stale", async () => {
    const holder = await startLeaseHolder("old-1");
    expect(await collectOldRuntimes(root, {})).toEqual({
      removed: [],
      deferred: [{ name: "old-1", reason: "live-lease" }],
      failed: [],
    });
    // A killed process cannot remove its lease: the file stays and only its age tells.
    holder.kill("SIGKILL");
    await exited(holder);
    expect((await fs.readdir(leaseDirectoryFor(root, "old-1"))).length).toBe(1);
    let advanced = 0;
    const deps: Partial<RuntimeCollectionDeps> = {
      now: () => Date.now() + advanced,
      monotonic: () => performance.now() + advanced,
      sleep: async (milliseconds) => void (advanced += milliseconds),
    };
    advanced = 10 * 60_000;
    expect(await collectOldRuntimes(root, { deps })).toEqual({ removed: ["old-1"], deferred: [], failed: [] });
    expect(await fs.readdir(path.join(root, "runtimes"))).toEqual(["cur-1"]);
    await expect(fs.access(leaseDirectoryFor(root, "old-1"))).rejects.toThrow();
  });

  it("removes the runtime at once when the process exits cleanly and takes its lease with it", async () => {
    const holder = await startLeaseHolder("old-1");
    holder.stdin.end();
    await exited(holder);
    expect(await collectOldRuntimes(root, {})).toEqual({ removed: ["old-1"], deferred: [], failed: [] });
  });
});

describe.runIf(IS_WINDOWS)("collectOldRuntimes with a locked file (Windows)", () => {
  let bundleRoot = "";
  let bundleSha = "";

  beforeEach(async () => {
    bundleRoot = await makeRoot("desktop-gc-bundle");
    await installFixture(bundleRoot, "bundle-1", { commit: true });
    await fs.rm(path.join(bundleRoot, "runtimes", "bundle-1", ".verified.json"));
    bundleSha = createHash("sha256")
      .update(await fs.readFile(path.join(bundleRoot, "runtimes", "bundle-1", "runtime-manifest.json")))
      .digest("hex");
    await installFixture(root, "old-1", { commit: true, files: { ...FIXTURE_FILES, "app/old-only.js": "// old\n" } });
  });

  afterEach(async () => {
    await fs.rm(bundleRoot, { recursive: true, force: true });
  });

  it("installs over it, defers it as locked, and removes it once the handle is closed", async () => {
    const locked = path.join(root, "runtimes", "old-1", "app", "old-only.js").replaceAll("'", "''");
    const child = spawn(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `$file = [System.IO.File]::Open('${locked}', 'Open', 'Read', 'None'); [Console]::Out.WriteLine('locked'); [Console]::In.ReadLine() | Out-Null; $file.Close()`,
      ],
      { stdio: "pipe" },
    );
    children.push(child);
    expect(await firstLine(child)).toBe("locked");

    const ensured = await ensureBundledRuntime(root, bundleRoot, { expectedManifestSha256: bundleSha, verify: ACL });
    expect(ensured).toMatchObject({ status: "installed", runtimeId: "bundle-1", previousRuntimeId: "old-1" });
    expect(await readCurrentRuntimeId(root)).toBe("bundle-1");

    await seedRetired(["old-1"]);
    expect(await collectOldRuntimes(root, {})).toEqual({
      removed: [],
      deferred: [{ name: "old-1", reason: "locked" }],
      failed: [],
    });
    await expect(fs.access(path.join(root, "runtimes", "old-1", "app", "old-only.js"))).resolves.toBeUndefined();

    child.stdin.end("\n");
    await exited(child);
    expect(await collectOldRuntimes(root, {})).toEqual({ removed: ["old-1"], deferred: [], failed: [] });
    expect(await fs.readdir(path.join(root, "runtimes"))).toEqual(["bundle-1"]);
  });
});
