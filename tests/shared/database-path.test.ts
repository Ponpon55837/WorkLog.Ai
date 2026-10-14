import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertNotDriveRelativePath,
  isDriveRelativePath,
  resolveDatabasePath,
} from "../../packages/shared/src/database-path.js";

const posixOptions = {
  baseDirectory: "/fixture/repo",
  fallback: "/fixture/repo/data/synthetic.sqlite",
  platform: "linux" as const,
};
const win32Options = {
  baseDirectory: "C:\\fixture\\repo",
  fallback: "C:\\fixture\\repo\\data\\synthetic.sqlite",
  platform: "win32" as const,
};

describe("resolveDatabasePath", () => {
  it("falls back when the value is missing or blank", () => {
    expect(resolveDatabasePath(undefined, posixOptions)).toBe(posixOptions.fallback);
    expect(resolveDatabasePath("   ", posixOptions)).toBe(posixOptions.fallback);
  });

  it("keeps :memory: untouched", () => {
    expect(resolveDatabasePath(" :memory: ", posixOptions)).toBe(":memory:");
    expect(resolveDatabasePath(":memory:", win32Options)).toBe(":memory:");
  });

  it("resolves relative paths from the base directory", () => {
    expect(resolveDatabasePath("data/a.sqlite", posixOptions)).toBe(posix.resolve("/fixture/repo", "data/a.sqlite"));
    expect(resolveDatabasePath("..\\a.sqlite", win32Options)).toBe(win32.resolve("C:\\fixture\\repo", "..\\a.sqlite"));
  });

  it("normalizes absolute paths", () => {
    expect(resolveDatabasePath(" /other/./dir/../a.sqlite ", posixOptions)).toBe("/other/a.sqlite");
    expect(resolveDatabasePath("D:/other/dir/../a.sqlite", win32Options)).toBe("D:\\other\\a.sqlite");
    expect(resolveDatabasePath("D:\\other\\a.sqlite", win32Options)).toBe("D:\\other\\a.sqlite");
  });

  it("rejects drive-relative paths on win32 and names the original value", () => {
    expect(() => resolveDatabasePath("C:Usersfixturedata.sqlite", win32Options)).toThrow(
      /C:Usersfixturedata\.sqlite.*磁碟相對路徑.*正斜線/,
    );
    expect(() => resolveDatabasePath("c:data.sqlite", win32Options)).toThrow("磁碟相對路徑");
  });

  it("treats the same text as an ordinary relative file name on posix", () => {
    expect(resolveDatabasePath("C:data.sqlite", posixOptions)).toBe(posix.resolve("/fixture/repo", "C:data.sqlite"));
  });
});

describe("drive-relative detection", () => {
  it("only flags a drive letter that is not followed by a separator", () => {
    expect(isDriveRelativePath("C:foo", "win32")).toBe(true);
    expect(isDriveRelativePath("C:", "win32")).toBe(true);
    expect(isDriveRelativePath("C:\\foo", "win32")).toBe(false);
    expect(isDriveRelativePath("C:/foo", "win32")).toBe(false);
    expect(isDriveRelativePath("foo:bar", "win32")).toBe(false);
    expect(isDriveRelativePath("C:foo", "darwin")).toBe(false);
  });

  it("assert helper throws only for the drive-relative form", () => {
    expect(() => assertNotDriveRelativePath("C:foo", "win32")).toThrow("磁碟相對路徑");
    expect(() => assertNotDriveRelativePath("C:/foo", "win32")).not.toThrow();
  });
});
