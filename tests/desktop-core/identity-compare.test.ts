import { describe, expect, it } from "vitest";
import { compareDatabaseIdentity, type DatabaseIdentity } from "../../packages/desktop-core/src/index.js";

const L1 = "a".repeat(64);
const L2 = "b".repeat(64);
const base: DatabaseIdentity = { realPath: "/data/work.db", fileId: { device: "1", inode: "10" }, lineageId: L1 };

describe("compareDatabaseIdentity truth table", () => {
  const cases: Array<[string, DatabaseIdentity, DatabaseIdentity, ReturnType<typeof compareDatabaseIdentity>]> = [
    ["identical", base, { ...base }, { same: true }],
    ["same fileId, moved path", base, { ...base, realPath: "/moved/work.db" }, { same: true }],
    [
      "different fileId",
      base,
      { ...base, fileId: { device: "1", inode: "11" } },
      { same: false, reason: "file-replaced" },
    ],
    [
      "different device",
      base,
      { ...base, fileId: { device: "2", inode: "10" } },
      { same: false, reason: "file-replaced" },
    ],
    ["fileId unknown, same path", { ...base, fileId: null }, base, { same: true }],
    [
      "fileId unknown, other path",
      { ...base, fileId: null },
      { ...base, realPath: "/x.db" },
      { same: false, reason: "path-replaced" },
    ],
    ["lineage differs", base, { ...base, lineageId: L2 }, { same: false, reason: "lineage-changed" }],
    ["lineage both null", { ...base, lineageId: null }, { ...base, lineageId: null }, { same: true }],
    ["null -> set, same file", { ...base, lineageId: null }, base, { same: true }],
    [
      "null -> set, fileId unknown",
      { ...base, fileId: null, lineageId: null },
      base,
      { same: false, reason: "lineage-changed" },
    ],
    [
      "null -> set, actual fileId unknown",
      { ...base, lineageId: null },
      { ...base, fileId: null },
      { same: false, reason: "lineage-changed" },
    ],
    ["set -> null", base, { ...base, lineageId: null }, { same: false, reason: "lineage-changed" }],
    [
      "file mismatch wins over lineage",
      base,
      { ...base, fileId: { device: "1", inode: "99" }, lineageId: L2 },
      { same: false, reason: "file-replaced" },
    ],
  ];
  it.each(cases)("%s", (_name, expected, actual, result) => {
    expect(compareDatabaseIdentity(expected, actual, "linux")).toEqual(result);
  });

  it("folds case only on win32", () => {
    const a = { ...base, fileId: null };
    const b = { ...base, fileId: null, realPath: "/DATA/Work.db" };
    expect(compareDatabaseIdentity(a, b, "linux")).toEqual({ same: false, reason: "path-replaced" });
    expect(compareDatabaseIdentity(a, b, "win32")).toEqual({ same: true });
  });

  it("defaults to the host platform", () => {
    expect(compareDatabaseIdentity(base, base)).toEqual({ same: true });
  });
});
