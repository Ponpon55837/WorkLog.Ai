import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyFileError,
  normalizePathForCompare,
  readFileIdentity,
  sameFileIdentity,
  type FileIdentity,
} from "../../packages/shared/src/file-identity.js";

const directories: string[] = [];

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "wi-file-identity-"));
  directories.push(directory);
  return directory;
}

function identityOf(path: string): FileIdentity {
  const result = readFileIdentity(path);
  if (!result.ok) throw new Error(`unexpected ${result.kind}`);
  return result.identity;
}

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("readFileIdentity", () => {
  it("gives a symlink and its target the same identity", () => {
    const directory = tempDir();
    const target = join(directory, "a.db");
    writeFileSync(target, "x");
    symlinkSync(target, join(directory, "link.db"));
    const direct = identityOf(target);
    const viaLink = identityOf(join(directory, "link.db"));
    expect(viaLink.realPath).toBe(direct.realPath);
    expect(direct.fileId).not.toBeNull();
    expect(sameFileIdentity(direct, viaLink)).toBe(true);
  });

  it("gives a hard link the same fileId but a different path", () => {
    const directory = tempDir();
    writeFileSync(join(directory, "a.db"), "x");
    linkSync(join(directory, "a.db"), join(directory, "b.db"));
    const a = identityOf(join(directory, "a.db"));
    const b = identityOf(join(directory, "b.db"));
    expect(a.realPath).not.toBe(b.realPath);
    expect(sameFileIdentity(a, b)).toBe(true);
  });

  it("gives a copy a different fileId", () => {
    const directory = tempDir();
    writeFileSync(join(directory, "a.db"), "x");
    copyFileSync(join(directory, "a.db"), join(directory, "c.db"));
    expect(sameFileIdentity(identityOf(join(directory, "a.db")), identityOf(join(directory, "c.db")))).toBe(false);
  });

  it("reports a missing file", () => {
    const result = readFileIdentity(join(tempDir(), "nope.db"));
    expect(result).toMatchObject({ ok: false, kind: "missing", code: "ENOENT" });
  });

  it("reports a path through a regular file as unreadable (missing on Windows)", () => {
    const directory = tempDir();
    writeFileSync(join(directory, "file"), "x");
    // POSIX reports ENOTDIR; Windows reports ENOENT for a path that continues through a regular file.
    const expected =
      process.platform === "win32" ? { ok: false, kind: "missing", code: "ENOENT" } : { ok: false, kind: "unreadable" };
    expect(readFileIdentity(join(directory, "file", "child"))).toMatchObject(expected);
  });

  it("reports a symlink loop as unreadable", () => {
    const directory = tempDir();
    symlinkSync(join(directory, "b"), join(directory, "a"));
    symlinkSync(join(directory, "a"), join(directory, "b"));
    expect(readFileIdentity(join(directory, "a"))).toMatchObject({ ok: false, kind: "unreadable", code: "ELOOP" });
  });

  it("uses a null fileId when the inode is zero", () => {
    const result = readFileIdentity("/x", { realpath: (p) => p, stat: () => ({ dev: 7n, ino: 0n }) });
    expect(result).toEqual({ ok: true, identity: { realPath: "/x", fileId: null } });
  });

  it("stringifies large device and inode values without losing precision", () => {
    const result = readFileIdentity("/x", {
      realpath: (p) => p,
      stat: () => ({ dev: 2n ** 63n, ino: 2n ** 64n - 1n }),
    });
    expect(result).toMatchObject({
      ok: true,
      identity: { fileId: { device: "9223372036854775808", inode: "18446744073709551615" } },
    });
  });

  it("classifies injected errors and stringifies non-Error throws", () => {
    const failing = (error: unknown) =>
      readFileIdentity("/x", {
        realpath: () => {
          throw error;
        },
        volumeRootExists: () => true,
      });
    expect(failing(errno("EACCES"))).toMatchObject({ kind: "denied" });
    expect(failing(errno("EPERM"))).toMatchObject({ kind: "denied" });
    expect(failing(errno("ESTALE"))).toMatchObject({ kind: "offline" });
    expect(failing("boom")).toMatchObject({ kind: "unreadable", code: "UNKNOWN", message: "boom" });
  });
});

describe("classifyFileError", () => {
  it("treats ENOENT on a vanished volume root as offline", () => {
    expect(classifyFileError(errno("ENOENT"), "/x", () => false)).toBe("offline");
    expect(classifyFileError(errno("ENOENT"), "/x", () => true)).toBe("missing");
  });

  it.each(["ENXIO", "ENODEV", "EIO", "ESTALE", "ENOTCONN"])("treats %s as offline", (code) => {
    expect(classifyFileError(errno(code), "/x")).toBe("offline");
  });

  it("uses the real volume root check by default", () => {
    expect(classifyFileError(errno("ENOENT"), join(tmpdir(), "definitely-missing"))).toBe("missing");
  });
});

describe("sameFileIdentity", () => {
  const withId = (device: string, inode: string): FileIdentity => ({ realPath: "/a", fileId: { device, inode } });

  it("matches only equal ids", () => {
    expect(sameFileIdentity(withId("1", "2"), withId("1", "2"))).toBe(true);
    expect(sameFileIdentity(withId("1", "2"), withId("1", "3"))).toBe(false);
    expect(sameFileIdentity(withId("1", "2"), withId("9", "2"))).toBe(false);
  });

  it("never matches when an id is unavailable", () => {
    const none: FileIdentity = { realPath: "/a", fileId: null };
    expect(sameFileIdentity(none, none)).toBe(false);
    expect(sameFileIdentity(none, withId("1", "2"))).toBe(false);
  });
});

describe("normalizePathForCompare", () => {
  it("strips trailing separators and resolves", () => {
    const directory = tempDir();
    mkdirSync(join(directory, "d"));
    expect(normalizePathForCompare(`${directory}${sep}d${sep}`, "linux")).toBe(join(directory, "d"));
    const root = parse(resolve(sep)).root; // "/" on POSIX, the current drive root (for example "D:\\") on Windows
    expect(normalizePathForCompare(sep, "linux")).toBe(root);
  });

  it("folds case only on win32", () => {
    expect(normalizePathForCompare("/Tmp/AbC", "win32")).toBe(
      normalizePathForCompare("/Tmp/AbC", "win32").toLowerCase(),
    );
    expect(normalizePathForCompare("/Tmp/AbC", "darwin")).toContain("AbC");
    expect(normalizePathForCompare("/Tmp/AbC", "linux")).toContain("AbC");
  });
});
