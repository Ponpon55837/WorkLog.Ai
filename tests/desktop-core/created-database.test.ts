import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  missingParentDirectories,
  removeCreatedDatabase,
  type DatabaseIdentity,
} from "../../packages/desktop-core/src/index.js";
import { readFileIdentity } from "../../packages/shared/src/file-identity.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "wi-created-")));
  roots.push(root);
  return root;
}

function identityOf(path: string): DatabaseIdentity {
  const located = readFileIdentity(path);
  if (!located.ok) throw new Error("synthetic file unreadable");
  return { ...located.identity, lineageId: null };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("removeCreatedDatabase", () => {
  it("removes the file, its siblings and only the directories that did not exist before", () => {
    const root = tempRoot();
    const path = join(root, "made", "deeper", "work.sqlite");
    const created = missingParentDirectories(path);
    expect(created).toEqual([join(root, "made", "deeper"), join(root, "made")]);
    mkdirSync(join(root, "made", "deeper"), { recursive: true });
    writeFileSync(path, "x");
    for (const suffix of ["-wal", "-shm", "-journal"]) writeFileSync(path + suffix, "x");
    const identity = identityOf(path);

    expect(removeCreatedDatabase(path, identity, created)).toBe(true);

    expect(existsSync(join(root, "made"))).toBe(false);
    expect(existsSync(root)).toBe(true);
  });

  it("keeps a directory that is not empty and the directories above it", () => {
    const root = tempRoot();
    const path = join(root, "made", "work.sqlite");
    const created = missingParentDirectories(path);
    mkdirSync(join(root, "made"));
    writeFileSync(path, "x");
    writeFileSync(join(root, "made", "other.txt"), "keep");
    expect(removeCreatedDatabase(path, identityOf(path), created)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(root, "made", "other.txt"))).toBe(true);
  });

  it("removes nothing when the file at the path is not the one that was created", () => {
    const root = tempRoot();
    const path = join(root, "work.sqlite");
    writeFileSync(path, "created");
    const identity = identityOf(path);
    rmSync(path);
    writeFileSync(join(root, "filler.bin"), "keeps the old inode busy");
    writeFileSync(path, "someone else's");
    const replaced = identityOf(path);
    // Same path, different file: force a different id when the file system happened to reuse the inode.
    const stale: DatabaseIdentity = {
      ...identity,
      fileId: replaced.fileId && { device: replaced.fileId.device, inode: `${replaced.fileId.inode}0` },
    };
    expect(removeCreatedDatabase(path, stale, [])).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  it("removes nothing when the file is already gone", () => {
    const root = tempRoot();
    const path = join(root, "work.sqlite");
    writeFileSync(path, "x");
    const identity = identityOf(path);
    rmSync(path);
    expect(removeCreatedDatabase(path, identity, [])).toBe(false);
  });
});
