import { mkdtempSync, linkSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyStorageRisk,
  type StorageRiskDeps,
  type StorageRiskFileInfo,
  type StorageRiskResult,
} from "../../packages/desktop-core/src/db-source/storage-risk.js";
import {
  createNodeStorageRiskDeps,
  createStorageRiskClassifier,
  runCommand,
} from "../../packages/desktop-core/src/db-source/storage-risk-node.js";
import { resolveDbSource } from "../../packages/desktop-core/src/db-source/resolve.js";

interface Node {
  readonly link?: string;
  readonly file?: boolean;
  readonly dev?: number;
  readonly nlink?: number;
}

function enoent(): Error {
  return Object.assign(new Error("missing"), { code: "ENOENT" });
}

function info(node: Node): StorageRiskFileInfo {
  return {
    isSymbolicLink: () => node.link !== undefined,
    isFile: () => node.file === true,
    dev: node.dev ?? 1,
    nlink: node.nlink ?? 1,
  };
}

interface Setup {
  readonly platform: NodeJS.Platform;
  readonly nodes?: Record<string, Node>;
  readonly files?: Record<string, string>;
  readonly commands?: (command: string, args: readonly string[]) => Promise<string>;
  readonly environment?: Record<string, string | undefined>;
  readonly home?: string;
  readonly macTimeoutMs?: number;
  readonly windowsTimeoutMs?: number;
  readonly cache?: boolean;
}

function fake(setup: Setup) {
  const calls: string[] = [];
  const nodes = setup.nodes ?? {};
  const files = setup.files ?? {};
  const deps: StorageRiskDeps = {
    platform: setup.platform,
    environment: setup.environment ?? {},
    homeDirectory: setup.home ?? "/home/u",
    realpath: async (target) => {
      const node = nodes[target];
      if (!node) throw enoent();
      return node.link ?? target;
    },
    lstat: async (target) => {
      const node = nodes[target];
      if (!node) throw enoent();
      return info(node);
    },
    readFile: async (target) => {
      const text = files[target];
      if (text === undefined) throw enoent();
      return text;
    },
    run: (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      return setup.commands ? setup.commands(command, args) : Promise.reject(new Error("no command"));
    },
    ...(setup.macTimeoutMs === undefined ? {} : { macTimeoutMs: setup.macTimeoutMs }),
    ...(setup.windowsTimeoutMs === undefined ? {} : { windowsTimeoutMs: setup.windowsTimeoutMs }),
    ...(setup.cache === false ? {} : { cache: new Map<string, Promise<StorageRiskResult>>() }),
  };
  return { deps, calls };
}

const LINUX_NODES = { "/": {}, "/data": {}, "/data/wi.db": { file: true } };
const never = (): Promise<string> => new Promise(() => undefined);

describe("classifyStorageRisk on Linux", () => {
  const mounts = (text: string) => ({ "/proc/mounts": text });

  it("reports a network mount, the longest mount point winning", async () => {
    const { deps } = fake({
      platform: "linux",
      nodes: LINUX_NODES,
      files: mounts("/dev/sda1 / ext4 rw 0 0\nsrv:/x /data nfs4 rw 0 0\n"),
    });
    expect(await classifyStorageRisk("/data/wi.db", deps)).toEqual({
      risk: "network",
      evidence: ["mount-type:nfs4"],
      symlinked: false,
    });
  });

  it("decodes octal escapes in a mount point and says none for a local disk", async () => {
    const { deps } = fake({
      platform: "linux",
      nodes: { "/": {}, "/my data": {}, "/my data/wi.db": { file: true } },
      files: mounts("//h/s /my\\040data cifs rw 0 0\n/dev/sda1 / ext4 rw 0 0\n"),
    });
    expect((await classifyStorageRisk("/my data/wi.db", deps)).risk).toBe("network");
    const local = fake({ platform: "linux", nodes: LINUX_NODES, files: mounts("/dev/sda1 / ext4 rw 0 0\n") });
    expect(await classifyStorageRisk("/data/wi.db", local.deps)).toEqual({
      risk: "none",
      evidence: [],
      symlinked: false,
    });
  });

  it("is unknown when the mount table is unreadable or has no matching mount", async () => {
    const unreadable = fake({ platform: "linux", nodes: LINUX_NODES });
    expect(await classifyStorageRisk("/data/wi.db", unreadable.deps)).toMatchObject({
      risk: "unknown",
      evidence: ["mounts-unreadable"],
    });
    const none = fake({ platform: "linux", nodes: LINUX_NODES, files: mounts("x /elsewhere ext4 rw 0 0\nshort\n") });
    expect(await classifyStorageRisk("/data/wi.db", none.deps)).toMatchObject({ evidence: ["mount-not-found"] });
  });

  it("classifies the nearest existing folder for a database that does not exist yet", async () => {
    const { deps } = fake({ platform: "linux", nodes: LINUX_NODES, files: mounts("a /data nfs rw 0 0\n") });
    expect((await classifyStorageRisk("/data/new/dir/wi.db", deps)).risk).toBe("network");
  });

  it("is unknown when no ancestor can be read, and when the error is not a missing path", async () => {
    const empty = fake({ platform: "linux" });
    expect(await classifyStorageRisk("/nope/x.db", empty.deps)).toEqual({
      risk: "unknown",
      evidence: ["path-unreadable"],
      symlinked: false,
    });
    const denied = fake({ platform: "linux", nodes: LINUX_NODES });
    const deps = { ...denied.deps, realpath: () => Promise.reject(Object.assign(new Error("no"), { code: "EACCES" })) };
    expect((await classifyStorageRisk("/data/wi.db", deps)).risk).toBe("unknown");
    const notDir = {
      ...denied.deps,
      realpath: (target: string) =>
        target === "/data/wi.db/x"
          ? Promise.reject(Object.assign(new Error("n"), { code: "ENOTDIR" }))
          : denied.deps.realpath(target),
    };
    expect((await classifyStorageRisk("/data/wi.db/x", notDir)).risk).toBe("unknown");
  });

  it("gives up on a path with too many missing levels", async () => {
    const { deps } = fake({ platform: "linux" });
    const deep = `/${Array.from({ length: 70 }, () => "d").join("/")}`;
    const real = { ...deps, realpath: () => Promise.reject(enoent()) };
    expect((await classifyStorageRisk(deep, real)).risk).toBe("unknown");
  });

  it("calls more than one name a hard link, and a symlinked path evidence only", async () => {
    const hard = fake({
      platform: "linux",
      nodes: { ...LINUX_NODES, "/data/wi.db": { file: true, nlink: 2 } },
      files: mounts("a / ext4 rw 0 0\n"),
    });
    expect(await classifyStorageRisk("/data/wi.db", hard.deps)).toEqual({
      risk: "hard-link",
      evidence: ["hard-link-count"],
      symlinked: false,
    });
    const linked = fake({
      platform: "linux",
      nodes: { "/": {}, "/ln": { link: "/data" }, "/data": {}, "/data/wi.db": { file: true } },
      files: mounts("a / ext4 rw 0 0\n"),
    });
    const deps = { ...linked.deps, realpath: (t: string) => Promise.resolve(t.replace("/ln", "/data")) };
    const result = await classifyStorageRisk("/ln/wi.db", deps);
    expect(result).toMatchObject({ risk: "none", symlinked: true });
    expect(result.evidence).toContain("symlink-in-path");
  });

  it("ranks network above a hard link and keeps the cache per real path", async () => {
    let reads = 0;
    const { deps } = fake({
      platform: "linux",
      nodes: { ...LINUX_NODES, "/data/wi.db": { file: true, nlink: 3 } },
      files: mounts("a /data nfs rw 0 0\n"),
    });
    const counting = { ...deps, readFile: (t: string) => ((reads += 1), deps.readFile(t)) };
    const first = await classifyStorageRisk("/data/wi.db", counting);
    const second = await classifyStorageRisk("/data/wi.db", counting);
    expect(first.risk).toBe("network");
    expect(first.evidence).toContain("hard-link-count");
    expect(second).toBe(first);
    expect(reads).toBe(1);
  });

  it("is unknown on a platform it has no adapter for, and survives an adapter that throws", async () => {
    const other = fake({ platform: "freebsd", nodes: LINUX_NODES });
    expect(await classifyStorageRisk("/data/wi.db", other.deps)).toMatchObject({ evidence: ["unsupported-platform"] });
    const { deps } = fake({ platform: "darwin", nodes: LINUX_NODES });
    const boom = {
      ...deps,
      get homeDirectory(): string {
        throw new Error("x");
      },
    };
    expect(await classifyStorageRisk("/data/wi.db", boom)).toMatchObject({
      risk: "unknown",
      evidence: ["adapter-error"],
    });
  });

  it("treats an lstat failure on a path segment as no symlink", async () => {
    const { deps } = fake({ platform: "linux", nodes: LINUX_NODES, files: mounts("a / ext4 rw 0 0\n") });
    let calls = 0;
    const flaky = {
      ...deps,
      lstat: (t: string) => {
        calls += 1;
        return calls === 1 ? deps.lstat(t) : Promise.reject(enoent());
      },
    };
    expect((await classifyStorageRisk("/data/wi.db", flaky)).symlinked).toBe(false);
  });
});

describe("classifyStorageRisk on macOS", () => {
  const DB = "/Volumes/X/wi.db";
  const nodes = { "/": {}, "/Volumes": {}, "/Volumes/X": {}, [DB]: { file: true } };
  const mountText = (type: string) =>
    `/dev/disk3s1 on / (apfs, local)\n/dev/disk9s1 on /Volumes/X (${type}, local, nodev)\nnoise line\n`;

  it("recognises a cloud root, with the home resolved through a symlink", async () => {
    const { deps } = fake({
      platform: "darwin",
      home: "/Users/u",
      nodes: {
        "/": {},
        "/Users": {},
        "/Users/u": {},
        "/Users/u/Dropbox": {},
        "/Users/u/Dropbox/wi.db": { file: true },
      },
    });
    expect(await classifyStorageRisk("/Users/u/Dropbox/wi.db", deps)).toEqual({
      risk: "cloud-sync",
      evidence: ["cloud-root:dropbox"],
      symlinked: false,
    });
    const aliased = fake({ platform: "darwin", home: "/Users/u", nodes: { "/": {}, "/Users/u": { link: "/real/u" } } });
    const withReal = {
      ...aliased.deps,
      realpath: (t: string) => Promise.resolve(t.replace("/Users/u", "/real/u")),
      lstat: () => Promise.resolve(info({ file: true })),
    };
    expect((await classifyStorageRisk("/real/u/Library/CloudStorage/x/wi.db", withReal)).evidence).toEqual([
      "cloud-root:cloud-storage",
    ]);
  });

  it("takes the startup volume without a second command", async () => {
    const { deps, calls } = fake({
      platform: "darwin",
      nodes: { "/": {}, "/a": {}, "/a/wi.db": { file: true } },
      commands: async () => "/dev/disk1 on / (apfs, local)\n",
    });
    expect(await classifyStorageRisk("/a/wi.db", deps)).toMatchObject({
      risk: "none",
      evidence: ["fast-path:startup-volume"],
    });
    expect(calls).toHaveLength(1);
  });

  it("reports a network mount type and an external or ejectable disk", async () => {
    const net = fake({ platform: "darwin", nodes, commands: async () => mountText("smbfs") });
    expect(await classifyStorageRisk(DB, net.deps)).toMatchObject({ risk: "network", evidence: ["mount-type:smbfs"] });
    const external = fake({
      platform: "darwin",
      nodes,
      commands: async (command) =>
        command === "/sbin/mount" ? mountText("apfs") : "<key>Internal</key>\n<false/>\n<key>Ejectable</key><true/>",
    });
    expect(await classifyStorageRisk(DB, external.deps)).toMatchObject({ risk: "removable" });
    const internal = fake({
      platform: "darwin",
      nodes,
      commands: async (command) =>
        command === "/sbin/mount" ? mountText("apfs") : "<key>Internal</key><true/><key>RemovableMedia</key><false/>",
    });
    expect(await classifyStorageRisk(DB, internal.deps)).toMatchObject({ risk: "none", evidence: [] });
  });

  it("is unknown when mount, diskutil or its answer fail, or nothing matches", async () => {
    const noMount = fake({ platform: "darwin", nodes });
    expect(await classifyStorageRisk(DB, noMount.deps)).toMatchObject({ evidence: ["mount-probe-failed"] });
    const lost = fake({ platform: "darwin", nodes, commands: async () => "/dev/d on /other (apfs)\n" });
    expect(await classifyStorageRisk(DB, lost.deps)).toMatchObject({ evidence: ["mount-not-found"] });
    const noDiskutil = fake({
      platform: "darwin",
      nodes,
      commands: async (command) => (command === "/sbin/mount" ? mountText("apfs") : Promise.reject(new Error("x"))),
    });
    expect(await classifyStorageRisk(DB, noDiskutil.deps)).toMatchObject({ evidence: ["diskutil-failed"] });
    const noAnswer = fake({
      platform: "darwin",
      nodes,
      commands: async (command) => (command === "/sbin/mount" ? mountText("apfs") : "<plist/>"),
    });
    expect(await classifyStorageRisk(DB, noAnswer.deps)).toMatchObject({ evidence: ["diskutil-no-answer"] });
  });

  it("gives up on a hung probe after its timeout", async () => {
    const { deps } = fake({ platform: "darwin", nodes, macTimeoutMs: 20, commands: never });
    expect(await classifyStorageRisk(DB, deps)).toMatchObject({ risk: "unknown", evidence: ["mount-probe-failed"] });
  });
});

describe("classifyStorageRisk on Windows", () => {
  const env = { SystemDrive: "C:", USERPROFILE: "C:\\Users\\u" };
  const node = (real: string) => ({ [real]: { file: true } });
  const parents = { "C:\\": {}, "D:\\": {}, "\\\\srv\\share": {}, "C:\\Users": {}, "C:\\Users\\u": {} };

  it("treats a UNC path as a network drive", async () => {
    const { deps } = fake({
      platform: "win32",
      environment: env,
      nodes: { ...parents, ...node("\\\\srv\\share\\wi.db") },
    });
    expect(await classifyStorageRisk("\\\\srv\\share\\wi.db", deps)).toMatchObject({
      risk: "network",
      evidence: ["unc-path"],
    });
    const long = {
      ...deps,
      realpath: (t: string) => Promise.resolve(`\\\\?\\UNC\\${t.slice(2)}`),
      lstat: () => Promise.resolve(info({ file: true })),
    };
    expect((await classifyStorageRisk("\\\\srv\\share\\wi.db", long)).risk).toBe("network");
  });

  it("is unknown for a path with no drive letter", async () => {
    const { deps } = fake({ platform: "win32", environment: env });
    const odd = {
      ...deps,
      realpath: () => Promise.resolve("\\weird\\wi.db"),
      lstat: () => Promise.resolve(info({ file: true })),
    };
    expect(await classifyStorageRisk("C:\\x\\wi.db", odd)).toMatchObject({ evidence: ["no-drive-letter"] });
  });

  it("recognises OneDrive, iCloud Drive and Dropbox roots, and the system drive fast path", async () => {
    const roots = {
      ...parents,
      "C:\\Users\\u\\OneDrive": {},
      "C:\\Users\\u\\OneDrive\\wi.db": { file: true },
      "C:\\Users\\u\\iCloudDrive": {},
      "C:\\Users\\u\\iCloudDrive\\wi.db": { file: true },
      "C:\\Users\\u\\Dropbox": {},
      "C:\\Users\\u\\Dropbox\\wi.db": { file: true },
      "C:\\Users\\u\\plain": {},
      "C:\\Users\\u\\plain\\wi.db": { file: true },
    };
    const { deps } = fake({
      platform: "win32",
      nodes: roots,
      environment: { ...env, OneDrive: "C:\\Users\\u\\OneDrive", APPDATA: "C:\\A", LOCALAPPDATA: "C:\\L" },
      files: {
        "C:\\A\\Dropbox\\info.json": JSON.stringify({
          personal: { path: "C:\\Users\\u\\Dropbox" },
          odd: 1,
          empty: { path: "" },
        }),
      },
    });
    expect((await classifyStorageRisk("C:\\Users\\u\\OneDrive\\wi.db", deps)).evidence).toEqual([
      "cloud-root:onedrive",
    ]);
    expect((await classifyStorageRisk("C:\\Users\\u\\iCloudDrive\\wi.db", deps)).evidence).toEqual([
      "cloud-root:icloud",
    ]);
    expect((await classifyStorageRisk("C:\\Users\\u\\Dropbox\\wi.db", deps)).evidence).toEqual(["cloud-root:dropbox"]);
    expect(await classifyStorageRisk("C:\\Users\\u\\plain\\wi.db", deps)).toMatchObject({
      risk: "none",
      evidence: ["fast-path:system-drive"],
    });
  });

  it("falls back to the home folder and drive C when the environment is bare", async () => {
    const { deps } = fake({ platform: "win32", home: "C:\\Users\\h", nodes: { "C:\\": {}, ...node("C:\\wi.db") } });
    expect((await classifyStorageRisk("C:\\wi.db", deps)).evidence).toEqual(["fast-path:system-drive"]);
  });

  it("asks PowerShell about another drive", async () => {
    const nodes = { ...parents, ...node("D:\\wi.db") };
    const answer = (text: string | Error) =>
      fake({
        platform: "win32",
        environment: env,
        nodes,
        commands: async () => (text instanceof Error ? Promise.reject(text) : text),
      });
    expect(await classifyStorageRisk("D:\\wi.db", answer("Network\r\n").deps)).toMatchObject({ risk: "network" });
    expect(await classifyStorageRisk("D:\\wi.db", answer("Removable").deps)).toMatchObject({ risk: "removable" });
    expect(await classifyStorageRisk("D:\\wi.db", answer("Fixed").deps)).toMatchObject({ risk: "none", evidence: [] });
    expect(await classifyStorageRisk("D:\\wi.db", answer("???").deps)).toMatchObject({
      evidence: ["drive-probe-no-answer"],
    });
    expect(await classifyStorageRisk("D:\\wi.db", answer(new Error("x")).deps)).toMatchObject({
      risk: "unknown",
      evidence: ["drive-probe-failed"],
    });
    const hung = fake({ platform: "win32", environment: env, nodes, windowsTimeoutMs: 20, commands: never });
    expect(await classifyStorageRisk("D:\\wi.db", hung.deps)).toMatchObject({ evidence: ["drive-probe-failed"] });
  });
});

describe("the node adapters", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("runs a command and rejects on failure, a missing program, and the timeout", async () => {
    expect((await runCommand(process.execPath, ["-e", "process.stdout.write('hi')"], 5000)).trim()).toBe("hi");
    await expect(runCommand(process.execPath, ["-e", "process.exit(3)"], 5000)).rejects.toBeDefined();
    await expect(runCommand("/definitely/not/here", [], 1000)).rejects.toBeDefined();
    await expect(runCommand(process.execPath, ["-e", "setTimeout(()=>{},10000)"], 100)).rejects.toBeDefined();
    await expect(runCommand("powershell.exe", [], 500, { SystemRoot: "/nope" })).rejects.toBeDefined();
  });

  it("classifies real files: a plain one, a hard link and a symlinked folder", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wi-risk-"));
    dirs.push(root);
    mkdirSync(path.join(root, "real"));
    const plain = path.join(root, "real", "wi.db");
    writeFileSync(plain, "x");
    const classify = createStorageRiskClassifier();
    expect(["none", "unknown", "network", "removable"]).toContain((await classify(plain)).risk);
    linkSync(plain, path.join(root, "real", "alias.db"));
    expect((await createStorageRiskClassifier()(plain)).risk).toBe("hard-link");
    symlinkSync(path.join(root, "real"), path.join(root, "ln"));
    const viaLink = await createStorageRiskClassifier()(path.join(root, "ln", "only.db"));
    expect(viaLink.symlinked).toBe(true);
    expect(["none", "unknown"]).toContain(viaLink.risk);
  });

  it("builds deps from the process by default and from options when given", () => {
    const defaults = createNodeStorageRiskDeps();
    expect(defaults.platform).toBe(process.platform);
    const custom = createNodeStorageRiskDeps({ platform: "win32", environment: {}, homeDirectory: "/h" });
    expect([custom.platform, custom.homeDirectory]).toEqual(["win32", "/h"]);
  });

  it("reads and runs through the real deps", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wi-risk-"));
    dirs.push(root);
    const file = path.join(root, "f.txt");
    writeFileSync(file, "abc");
    const deps = createNodeStorageRiskDeps();
    expect(await deps.readFile(file)).toBe("abc");
    expect(await deps.realpath(file)).toBeTruthy();
    expect((await deps.lstat(file)).isFile()).toBe(true);
    expect((await deps.run(process.execPath, ["-e", "process.stdout.write('1')"], 5000)).trim()).toBe("1");
  });
});

describe("resolveDbSource with a storage classifier", () => {
  it("attaches a verdict to every existing group, and unknown when the classifier throws", async () => {
    const candidates = [
      { absolutePath: "/a/one.db", kind: "default-location", label: "x" },
      { absolutePath: "/a/two.db", kind: "default-location", label: "y" },
    ] as never;
    const resolution = await resolveDbSource({
      candidates,
      platform: "linux",
      probe: async () => ({ status: "ok" }) as never,
      classifyStorage: async (p) => {
        if (p.endsWith("two.db")) throw new Error("boom");
        return { risk: "removable", evidence: [], symlinked: false };
      },
    });
    const byPath = Object.fromEntries(resolution.groups.map((g) => [g.absolutePath, g.storageRisk?.risk]));
    expect(byPath).toEqual({ "/a/one.db": "removable", "/a/two.db": "unknown" });
  });
});
