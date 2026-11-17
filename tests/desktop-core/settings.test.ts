import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DATABASE_PATH_PROBLEM_MESSAGES,
  DesktopSettingsWriteError,
  createNodeSettingsWriteDeps,
  databaseIdentitySchema,
  databasePathProblem,
  isSupportedDatabasePath,
  parseDesktopSettings,
  readDesktopSettings,
  recoveryPathFor,
  writeDesktopSettingsAtomic,
  type DesktopSettingsV1,
  type SettingsFileHandle,
  type SettingsWriteDeps,
  type SettingsWriteStep,
} from "../../packages/desktop-core/src/index.js";

const identity = {
  realPath: "/data/work.db",
  fileId: { device: "64769", inode: "1234567" },
  lineageId: "a".repeat(64),
};

function makeSettings(port = 3210): DesktopSettingsV1 {
  return {
    configVersion: 1,
    installId: "install-1",
    desired: { databasePath: "/data/work.db", port, launchAtLogin: false, backupDirectory: "/data/backups" },
    active: { databaseIdentity: identity, port, runtimeVersion: "1.6.42", serviceOwner: "desktop" },
    lastKnownGood: null,
  };
}

let dir = "";
let file = "";
let counter = 0;

function deps(overrides: Partial<SettingsWriteDeps> = {}): SettingsWriteDeps {
  return { ...createNodeSettingsWriteDeps(), randomSuffix: () => `t${counter++}`, ...overrides };
}

/** Wrap the real deps so one step fails. */
function failing(step: SettingsWriteStep | "close" | "dir-open", code = "EIO"): SettingsWriteDeps {
  const real = deps();
  const boom = (): Error => Object.assign(new Error(`injected ${step}`), { code });
  const wrap = (h: SettingsFileHandle, on: "write" | "fsync" | "close" | "dir"): SettingsFileHandle => ({
    writeFile: async (d) => {
      if (on === "write" && step === "write") throw boom();
      await h.writeFile(d);
    },
    sync: async () => {
      if (on === "fsync" && step === "fsync") throw boom();
      if (on === "dir" && step === "directory-fsync") throw boom();
      await h.sync();
    },
    close: async () => {
      await h.close();
      if (on === "close" && step === "close") throw boom();
    },
  });
  return {
    ...real,
    openExclusive: async (p, m) => {
      const h = await real.openExclusive(p, m);
      return wrap(h, step === "close" ? "close" : step === "fsync" ? "fsync" : "write");
    },
    // Exercise the POSIX directory-fsync policy on every OS (win32 skips it), with a fake directory handle so the
    // test does not depend on whether this OS can open a directory.
    platform: "linux",
    openDirectory: async () => {
      if (step === "dir-open") throw boom();
      return wrap({ writeFile: async () => {}, sync: async () => {}, close: async () => {} }, "dir");
    },
    rename: async (a, b) => {
      if (step === "rename") throw boom();
      await real.rename(a, b);
    },
    readFile: async (p) => {
      if (step === "verify" && p.endsWith(".tmp")) throw boom();
      return real.readFile(p);
    },
  };
}

async function snapshot(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const name of await fs.readdir(dir)) out[name] = (await fs.stat(path.join(dir, name))).mtimeMs;
  return out;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-settings-"));
  file = path.join(dir, "settings.json");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("parseDesktopSettings", () => {
  it("accepts valid v1 with optional active/lastKnownGood omitted", () => {
    const { active: _a, lastKnownGood: _l, ...rest } = makeSettings();
    expect(parseDesktopSettings(rest).ok).toBe(true);
  });

  it.each([
    ["UNC", "\\\\server\\share\\work.db", "unc"],
    ["slash UNC", "//server/share/work.db", "unc"],
    ["extended-length", "\\\\?\\C:\\work.db", "device"],
    ["device", "\\\\.\\C:\\work.db", "device"],
  ])("refuses a %s database path with a clear reason", (_name, databasePath, problem) => {
    expect(databasePathProblem(databasePath)).toBe(problem);
    expect(isSupportedDatabasePath(databasePath, "win32")).toBe(false);
    expect(DATABASE_PATH_PROBLEM_MESSAGES[problem as "unc" | "device"]["zh-TW"]).toContain("不支援");
    const s = makeSettings();
    s.desired.databasePath = databasePath;
    expect(parseDesktopSettings(s).ok).toBe(false);
  });

  it("shares one database path rule per platform", () => {
    expect(isSupportedDatabasePath("C:\\Users\\x\\work.db", "win32")).toBe(true);
    expect(isSupportedDatabasePath("/home/x/work.db", "win32")).toBe(false);
    expect(isSupportedDatabasePath("C:\\work.db", "linux")).toBe(false);
    expect(isSupportedDatabasePath("/home/x/work.db", "linux")).toBe(true);
    expect(databasePathProblem("")).toBe("empty");
    expect(databasePathProblem("rel/x.db")).toBe("not-absolute");
  });

  it("accepts win32 absolute paths", () => {
    const s = makeSettings();
    s.desired.databasePath = "C:\\Users\\x\\work.db";
    expect(parseDesktopSettings(s).ok).toBe(true);
  });

  it.each([
    ["relative path", (s: Record<string, any>) => (s.desired.databasePath = "rel/work.db")],
    ["port 0", (s: Record<string, any>) => (s.desired.port = 0)],
    ["port 70000", (s: Record<string, any>) => (s.desired.port = 70000)],
    ["fractional port", (s: Record<string, any>) => (s.desired.port = 80.5)],
    ["empty installId", (s: Record<string, any>) => (s.installId = "")],
    ["unknown key", (s: Record<string, any>) => (s.extra = 1)],
    ["unknown nested key", (s: Record<string, any>) => (s.desired.extra = 1)],
    ["bad owner", (s: Record<string, any>) => (s.active.serviceOwner = "cli")],
    ["bad lineage", (s: Record<string, any>) => (s.active.databaseIdentity.lineageId = "xyz")],
    ["bad inode", (s: Record<string, any>) => (s.active.databaseIdentity.fileId.inode = "1.5")],
  ])("rejects %s", (_name, mutate) => {
    const s = structuredClone(makeSettings()) as Record<string, any>;
    mutate(s);
    const result = parseDesktopSettings(s);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("invalid-schema");
  });

  it("fails closed on unsupported versions without coercion", () => {
    for (const v of [2, 0, 99]) {
      const result = parseDesktopSettings({ ...makeSettings(), configVersion: v });
      expect(result).toMatchObject({ ok: false, kind: "unsupported-version" });
    }
  });

  it("rejects non-objects and non-integer versions as invalid-schema", () => {
    for (const raw of [null, [], "x", 1, {}, { configVersion: "1" }, { configVersion: 1.5 }]) {
      expect(parseDesktopSettings(raw)).toMatchObject({ ok: false, kind: "invalid-schema" });
    }
  });

  it("identity schema allows null fileId and lineageId", () => {
    expect(databaseIdentitySchema.safeParse({ realPath: "/a", fileId: null, lineageId: null }).success).toBe(true);
  });
});

describe("writeDesktopSettingsAtomic + readDesktopSettings", () => {
  it("round-trips and reports capabilities", async () => {
    const result = await writeDesktopSettingsAtomic(file, makeSettings(), deps());
    expect(result).toEqual({ recoveryWritten: false, directorySynced: process.platform !== "win32" });
    expect(await readDesktopSettings(file)).toEqual({
      kind: "ok",
      settings: makeSettings(),
      source: "primary",
      primaryDamaged: false,
    });
    expect(await fs.readdir(dir)).toEqual(["settings.json"]);
  });

  it.skipIf(process.platform === "win32")("writes with mode 0600", async () => {
    await writeDesktopSettingsAtomic(file, makeSettings());
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it("keeps a recovery copy of the previous valid file", async () => {
    await writeDesktopSettingsAtomic(file, makeSettings(3210), deps());
    const second = await writeDesktopSettingsAtomic(file, makeSettings(3211), deps());
    expect(second.recoveryWritten).toBe(true);
    const recovery = JSON.parse(await fs.readFile(recoveryPathFor(file), "utf8"));
    expect(recovery.desired.port).toBe(3210);
    expect(JSON.parse(await fs.readFile(file, "utf8")).desired.port).toBe(3211);
    expect((await fs.readdir(dir)).sort()).toEqual(["settings.json", "settings.json.recovery"]);
  });

  it("never replaces a good recovery copy with a corrupt primary", async () => {
    await writeDesktopSettingsAtomic(file, makeSettings(3210), deps());
    await writeDesktopSettingsAtomic(file, makeSettings(3211), deps());
    await fs.writeFile(file, "{ garbage");
    const result = await writeDesktopSettingsAtomic(file, makeSettings(3212), deps());
    expect(result.recoveryWritten).toBe(false);
    expect(JSON.parse(await fs.readFile(recoveryPathFor(file), "utf8")).desired.port).toBe(3210);
  });

  it("refuses invalid settings and writes nothing", async () => {
    const bad = { ...makeSettings(), installId: "" };
    await expect(writeDesktopSettingsAtomic(file, bad, deps())).rejects.toMatchObject({ step: "validate" });
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("skips directory fsync on win32 and on unsupported errors", async () => {
    expect((await writeDesktopSettingsAtomic(file, makeSettings(), deps({ platform: "win32" }))).directorySynced).toBe(
      false,
    );
    for (const code of ["EISDIR", "EPERM", "EINVAL"]) {
      const open = await writeDesktopSettingsAtomic(file, makeSettings(), failing("dir-open", code));
      expect(open.directorySynced).toBe(false);
      const sync = await writeDesktopSettingsAtomic(file, makeSettings(), failing("directory-fsync", code));
      expect(sync.directorySynced).toBe(false);
    }
  });

  it.each(["write", "fsync", "close", "verify", "rename"] as const)(
    "failure at %s leaves original intact and no temp files",
    async (step) => {
      await writeDesktopSettingsAtomic(file, makeSettings(3210), deps());
      const before = await fs.readFile(file, "utf8");
      await expect(writeDesktopSettingsAtomic(file, makeSettings(3999), failing(step))).rejects.toBeInstanceOf(
        DesktopSettingsWriteError,
      );
      expect(await fs.readFile(file, "utf8")).toBe(before);
      expect((await fs.readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
      expect((await readDesktopSettings(file)).kind).toBe("ok");
    },
  );

  it.each(["directory-fsync", "dir-open"] as const)("failure at %s reports committed", async (step) => {
    const error = await writeDesktopSettingsAtomic(file, makeSettings(3999), failing(step)).catch((e: unknown) => e);
    expect(error).toMatchObject({ step: "directory-fsync", committed: true });
    expect(JSON.parse(await fs.readFile(file, "utf8")).desired.port).toBe(3999);
  });

  it("refuses to overwrite settings written by a newer version", async () => {
    const future = `${JSON.stringify({ ...makeSettings(), configVersion: 2, newField: true })}\n`;
    await fs.writeFile(file, future);
    await expect(writeDesktopSettingsAtomic(file, makeSettings(), deps())).rejects.toMatchObject({
      step: "refuse-downgrade",
      committed: false,
    });
    expect(await fs.readFile(file, "utf8")).toBe(future);
    expect(await fs.readdir(dir)).toEqual(["settings.json"]);
  });

  it("still overwrites a damaged primary", async () => {
    await fs.writeFile(file, "{ broken");
    await writeDesktopSettingsAtomic(file, makeSettings(), deps());
    expect((await readDesktopSettings(file)).kind).toBe("ok");
  });

  it("skips the directory fsync on win32 and ENOTSUP", async () => {
    expect((await writeDesktopSettingsAtomic(file, makeSettings(), deps({ platform: "win32" }))).directorySynced).toBe(
      false,
    );
    expect(
      (await writeDesktopSettingsAtomic(file, makeSettings(), failing("dir-open", "ENOTSUP"))).directorySynced,
    ).toBe(false);
  });

  it("fails if the temp file cannot be created", async () => {
    const d = deps({
      openExclusive: async () => {
        throw new Error("EEXIST");
      },
    });
    await expect(writeDesktopSettingsAtomic(file, makeSettings(), d)).rejects.toMatchObject({ step: "write" });
  });

  it("fails verification when disk content differs", async () => {
    const real = deps();
    const d = deps({ readFile: async (p) => (p.endsWith(".tmp") ? "{}" : real.readFile(p)) });
    await expect(writeDesktopSettingsAtomic(file, makeSettings(), d)).rejects.toMatchObject({ step: "verify" });
    const d2 = deps({
      readFile: async (p) => (p.endsWith(".tmp") ? `${JSON.stringify(makeSettings())}` : real.readFile(p)),
    });
    await expect(writeDesktopSettingsAtomic(file, makeSettings(), d2)).rejects.toMatchObject({ step: "verify" });
  });

  it("failure writing the recovery copy keeps both files and removes temps", async () => {
    await writeDesktopSettingsAtomic(file, makeSettings(3210), deps());
    const real = deps();
    const d = deps({
      rename: async (a, b) => {
        if (b.endsWith(".recovery")) throw new Error("boom");
        await real.rename(a, b);
      },
    });
    await expect(writeDesktopSettingsAtomic(file, makeSettings(3211), d)).rejects.toMatchObject({ step: "recovery" });
    expect(JSON.parse(await fs.readFile(file, "utf8")).desired.port).toBe(3210);
    expect((await fs.readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("recovery staging failure aborts before touching the target", async () => {
    await writeDesktopSettingsAtomic(file, makeSettings(3210), deps());
    const real = deps();
    const d = deps({
      openExclusive: async (p, m) => {
        if (p.includes(".recovery.")) throw new Error("no space");
        return real.openExclusive(p, m);
      },
    });
    await expect(writeDesktopSettingsAtomic(file, makeSettings(3211), d)).rejects.toMatchObject({ step: "recovery" });
    expect(JSON.parse(await fs.readFile(file, "utf8")).desired.port).toBe(3210);
    expect((await fs.readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("simulated crash between temp write and rename leaves original intact and readable", async () => {
    await writeDesktopSettingsAtomic(file, makeSettings(3210), deps());
    const crash = deps({
      rename: async () => {
        throw new Error("process killed");
      },
      unlink: async () => {
        throw new Error("killed");
      },
    });
    await expect(writeDesktopSettingsAtomic(file, makeSettings(3211), crash)).rejects.toThrow();
    const read = await readDesktopSettings(file);
    expect(read).toMatchObject({ kind: "ok", source: "primary" });
    if (read.kind === "ok") expect(read.settings.desired.port).toBe(3210);
    await writeDesktopSettingsAtomic(file, makeSettings(3212), deps());
    expect((await readDesktopSettings(file)).kind).toBe("ok");
  });
});

describe("readDesktopSettings fail-closed", () => {
  it("new install only when primary and recovery are absent", async () => {
    expect(await readDesktopSettings(file)).toEqual({ kind: "new-install" });
    expect(
      await readDesktopSettings(file, { readFile: fs.readFile as never, hasOtherSources: async () => false }),
    ).toEqual({ kind: "new-install" });
  });

  it("ENOENT with other sources needs repair", async () => {
    const result = await readDesktopSettings(file, {
      readFile: (p) => fs.readFile(p, "utf8"),
      hasOtherSources: () => true,
    });
    expect(result).toMatchObject({ kind: "needs-repair", reason: "other-sources-present" });
  });

  it("hasOtherSources failure needs repair", async () => {
    const result = await readDesktopSettings(file, {
      readFile: (p) => fs.readFile(p, "utf8"),
      hasOtherSources: () => {
        throw new Error("x");
      },
    });
    expect(result).toMatchObject({ kind: "needs-repair", reason: "unreadable" });
  });

  it("missing primary with valid recovery returns recovery", async () => {
    await fs.writeFile(recoveryPathFor(file), JSON.stringify(makeSettings()));
    expect(await readDesktopSettings(file)).toMatchObject({
      kind: "ok",
      source: "recovery",
      primaryDamaged: true,
      primaryReason: "missing",
    });
  });

  it("truncated JSON without recovery needs repair, never new-install", async () => {
    await fs.writeFile(file, JSON.stringify(makeSettings()).slice(0, 40));
    expect(await readDesktopSettings(file)).toMatchObject({ kind: "needs-repair", reason: "invalid-json" });
  });

  it("truncated JSON falls back to recovery and does not repair the primary", async () => {
    await fs.writeFile(file, '{"configVersion":1,"inst');
    await fs.writeFile(recoveryPathFor(file), JSON.stringify(makeSettings()));
    expect(await readDesktopSettings(file)).toMatchObject({
      kind: "ok",
      source: "recovery",
      primaryDamaged: true,
      primaryReason: "invalid-json",
    });
    expect(await fs.readFile(file, "utf8")).toBe('{"configVersion":1,"inst');
  });

  it("zero-byte file needs repair", async () => {
    await fs.writeFile(file, "");
    expect(await readDesktopSettings(file)).toMatchObject({ kind: "needs-repair", reason: "invalid-json" });
  });

  it("invalid schema and future version are distinct", async () => {
    await fs.writeFile(file, JSON.stringify({ ...makeSettings(), installId: "" }));
    expect(await readDesktopSettings(file)).toMatchObject({ kind: "needs-repair", reason: "invalid-schema" });
    await fs.writeFile(file, JSON.stringify({ ...makeSettings(), configVersion: 2 }));
    expect(await readDesktopSettings(file)).toMatchObject({ kind: "needs-repair", reason: "unsupported-version" });
  });

  it("never falls back to the recovery copy for an unsupported-version or denied primary", async () => {
    await fs.writeFile(recoveryPathFor(file), JSON.stringify(makeSettings()));
    await fs.writeFile(file, JSON.stringify({ ...makeSettings(), configVersion: 2 }));
    expect(await readDesktopSettings(file)).toMatchObject({
      kind: "needs-repair",
      reason: "unsupported-version",
      primaryReason: "unsupported-version",
    });
    const denied = async (p: string): Promise<string> => {
      if (p === file) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return JSON.stringify(makeSettings());
    };
    expect(await readDesktopSettings(file, { readFile: denied })).toMatchObject({
      kind: "needs-repair",
      reason: "denied",
    });
  });

  it("still falls back to a valid recovery copy for an unreadable primary", async () => {
    const eio = async (p: string): Promise<string> => {
      if (p === file) throw Object.assign(new Error("io"), { code: "EIO" });
      return JSON.stringify(makeSettings());
    };
    expect(await readDesktopSettings(file, { readFile: eio })).toMatchObject({
      kind: "ok",
      source: "recovery",
      primaryReason: "unreadable",
    });
  });

  it("primary missing but recovery corrupt needs repair with recovery reason", async () => {
    await fs.writeFile(recoveryPathFor(file), "nope");
    expect(await readDesktopSettings(file)).toMatchObject({
      kind: "needs-repair",
      reason: "invalid-json",
      primaryReason: "missing",
      recoveryReason: "invalid-json",
    });
  });

  it("maps EACCES/EPERM to denied and other errors to unreadable", async () => {
    const err = (code: string) => async () => {
      throw Object.assign(new Error(code), { code });
    };
    expect(await readDesktopSettings(file, { readFile: err("EACCES") })).toMatchObject({ reason: "denied" });
    expect(await readDesktopSettings(file, { readFile: err("EPERM") })).toMatchObject({ reason: "denied" });
    expect(await readDesktopSettings(file, { readFile: err("EISDIR") })).toMatchObject({ reason: "unreadable" });
    expect(
      await readDesktopSettings(file, {
        readFile: async () => {
          throw "weird";
        },
      }),
    ).toMatchObject({ reason: "unreadable" });
  });

  it("a directory at the settings path is unreadable, not new-install", async () => {
    await fs.mkdir(file);
    expect(await readDesktopSettings(file)).toMatchObject({ kind: "needs-repair", reason: "unreadable" });
  });

  it("read never mutates the directory", async () => {
    await fs.writeFile(file, "{ broken");
    await fs.writeFile(recoveryPathFor(file), JSON.stringify(makeSettings()));
    const before = await snapshot();
    await readDesktopSettings(file);
    await readDesktopSettings(path.join(dir, "other.json"));
    expect(await snapshot()).toEqual(before);
  });
});
