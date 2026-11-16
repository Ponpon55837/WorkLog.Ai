import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AtomicFileError,
  createNodeAtomicFileDeps,
  writeFileAtomic,
  type AtomicFileDeps,
} from "../../packages/desktop-core/src/internal/atomic-file.js";

let dir = "";

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-atomic-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function deps(overrides: Partial<AtomicFileDeps> = {}): AtomicFileDeps {
  return { ...createNodeAtomicFileDeps(), ...overrides };
}

const codeError = (code: string): Error => Object.assign(new Error(code), { code });

describe("writeFileAtomic", () => {
  it("replaces the file, creates parent directories and reports the directory sync", async () => {
    const target = path.join(dir, "nested", "file.json");
    expect(await writeFileAtomic(target, "one")).toEqual({ directorySynced: process.platform !== "win32" });
    await writeFileAtomic(target, "two", { mode: 0o600 });
    expect(await fs.readFile(target, "utf8")).toBe("two");
    expect(await fs.readdir(path.dirname(target))).toEqual(["file.json"]);
  });

  it("skips the directory fsync on win32 and unsupported errors, reports others as committed", async () => {
    const target = path.join(dir, "f");
    expect(await writeFileAtomic(target, "x", { deps: deps({ platform: "win32" }) })).toEqual({
      directorySynced: false,
    });
    for (const code of ["EISDIR", "EPERM", "EINVAL", "ENOTSUP"]) {
      const open = deps({
        openDirectory: async () => {
          throw codeError(code);
        },
      });
      expect(await writeFileAtomic(target, "x", { deps: open })).toEqual({ directorySynced: false });
      const real = deps();
      const sync = deps({
        openDirectory: async (p) => {
          const handle = await real.openDirectory(p);
          return {
            writeFile: (d) => handle.writeFile(d),
            close: () => handle.close(),
            sync: async () => {
              throw codeError(code);
            },
          };
        },
      });
      expect(await writeFileAtomic(target, "x", { deps: sync })).toEqual({ directorySynced: false });
    }
    const failing = deps({
      openDirectory: async () => {
        throw codeError("EIO");
      },
    });
    await expect(writeFileAtomic(target, "y", { deps: failing })).rejects.toMatchObject({
      name: "AtomicFileError",
      step: "directory-fsync",
      committed: true,
    });
    expect(await fs.readFile(target, "utf8")).toBe("y");
  });

  it("removes the temp file and keeps the target when the rename fails", async () => {
    const target = path.join(dir, "f");
    await fs.writeFile(target, "old");
    const failing = deps({
      rename: async () => {
        throw codeError("EIO");
      },
    });
    const error = await writeFileAtomic(target, "new", { deps: failing }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AtomicFileError);
    expect(error).toMatchObject({ step: "rename", committed: false });
    expect(await fs.readFile(target, "utf8")).toBe("old");
    expect(await fs.readdir(dir)).toEqual(["f"]);
  });
});
