import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    realpathSync: vi.fn(actual.realpathSync),
    promises: {
      ...actual.promises,
      lstat: vi.fn(actual.promises.lstat),
      realpath: vi.fn(actual.promises.realpath),
    },
  };
});

import { createAsyncProjectPathResolver, createProjectPathResolver } from "../../packages/project-policy/src/index.js";

const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");

function createProject(): { parent: string; root: string; file: string; outside: string } {
  const parent = mkdtempSync(join(tmpdir(), "work-intelligence-policy-failure-"));
  const root = join(parent, "project");
  mkdirSync(root);
  const file = join(root, "inside.txt");
  writeFileSync(file, "inside", "utf8");
  return { parent, root, file, outside: join(parent, "outside.txt") };
}

function restoreFileSystemMocks(): void {
  vi.mocked(fs.existsSync).mockReset().mockImplementation(actualFs.existsSync);
  vi.mocked(fs.realpathSync).mockReset().mockImplementation(actualFs.realpathSync);
  vi.mocked(fs.promises.lstat).mockReset().mockImplementation(actualFs.promises.lstat);
  vi.mocked(fs.promises.realpath).mockReset().mockImplementation(actualFs.promises.realpath);
}

afterEach(() => {
  restoreFileSystemMocks();
});

describe("project path resolver filesystem failures", () => {
  it("fails closed when the root or a synchronous path cannot be realpathed", () => {
    const { parent, root } = createProject();
    try {
      vi.mocked(fs.realpathSync).mockImplementation((path) => {
        if (resolve(String(path)) === resolve(root)) {
          throw new Error("unreadable root");
        }
        return actualFs.realpathSync(path as Parameters<typeof actualFs.realpathSync>[0]);
      });
      const unresolvedRoot = createProjectPathResolver(root);
      expect(unresolvedRoot.safePath("new.txt")).toBe(join(root, "new.txt"));

      restoreFileSystemMocks();
      let calls = 0;
      vi.mocked(fs.realpathSync).mockImplementation((path) => {
        calls += 1;
        if (calls === 2) {
          throw new Error("unreadable existing parent");
        }
        return actualFs.realpathSync(path as Parameters<typeof actualFs.realpathSync>[0]);
      });
      const resolver = createProjectPathResolver(root);
      expect(resolver.safePath("missing.txt")).toBeUndefined();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("fails closed for sync existing paths that vanish or resolve outside after validation", () => {
    const { parent, root, outside } = createProject();
    try {
      const resolver = createProjectPathResolver(root);
      let calls = 0;
      vi.mocked(fs.realpathSync).mockImplementation((path) => {
        calls += 1;
        if (calls === 2) {
          return outside;
        }
        return actualFs.realpathSync(path as Parameters<typeof actualFs.realpathSync>[0]);
      });
      expect(resolver.safeExistingPath("inside.txt")).toBeUndefined();

      restoreFileSystemMocks();
      const secondResolver = createProjectPathResolver(root);
      calls = 0;
      vi.mocked(fs.realpathSync).mockImplementation((path) => {
        calls += 1;
        if (calls === 2) {
          throw new Error("file vanished");
        }
        return actualFs.realpathSync(path as Parameters<typeof actualFs.realpathSync>[0]);
      });
      expect(secondResolver.safeExistingPath("inside.txt")).toBeUndefined();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("stops synchronous parent traversal at the filesystem root", () => {
    const { parent, root } = createProject();
    try {
      const resolver = createProjectPathResolver(root);
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(resolver.safePath("missing.txt")).toBeUndefined();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("handles non-ENOENT errors and missing ancestors in async traversal", async () => {
    const { parent, root } = createProject();
    try {
      const resolver = createAsyncProjectPathResolver(root);
      vi.mocked(fs.promises.lstat).mockRejectedValue(new Error("permission denied"));
      await expect(resolver.safePath("inside.txt")).resolves.toBeUndefined();

      const missingAncestorResolver = createAsyncProjectPathResolver(root);
      vi.mocked(fs.promises.lstat).mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
      await expect(missingAncestorResolver.safePath("inside.txt")).resolves.toBeUndefined();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("handles async realpath errors and paths that escape after validation", async () => {
    const { parent, root, outside } = createProject();
    try {
      let calls = 0;
      vi.mocked(fs.promises.realpath).mockImplementation(async (path) => {
        calls += 1;
        if (calls === 2) {
          throw new Error("realpath failed");
        }
        return actualFs.promises.realpath(path as Parameters<typeof actualFs.promises.realpath>[0]);
      });
      const failingResolver = createAsyncProjectPathResolver(root);
      await expect(failingResolver.safePath("inside.txt")).resolves.toBeUndefined();

      restoreFileSystemMocks();
      calls = 0;
      vi.mocked(fs.promises.realpath).mockImplementation(async (path) => {
        calls += 1;
        if (calls === 3) {
          return outside;
        }
        return actualFs.promises.realpath(path as Parameters<typeof actualFs.promises.realpath>[0]);
      });
      const escapingResolver = createAsyncProjectPathResolver(root);
      await expect(escapingResolver.safeExistingPath("inside.txt")).resolves.toBeUndefined();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
