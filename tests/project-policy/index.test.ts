import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { ProjectRecord } from "../../packages/core/src/index.js";
import {
  canonicalizeProjectRoot,
  createAsyncProjectPathResolver,
  createProjectPathResolver,
  isPathWithinProject,
  matchRegisteredRoots,
  ProjectPolicyGate,
  projectParentPath,
  safeExistingProjectPaths,
  safeProjectPath,
  safeProjectPaths,
} from "../../packages/project-policy/src/index.js";

function project(status: ProjectRecord["status"]): ProjectRecord {
  return {
    id: "project-1",
    name: "Tracked project",
    rootPath: canonicalizeProjectRoot("C:/work/tracked"),
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("canonicalizeProjectRoot platform", () => {
  it("case-folds a Windows root into a comparison key only on win32", () => {
    expect(canonicalizeProjectRoot("C:\\Users\\Dev\\Round6-Alpha\\", "win32")).toBe("c:\\users\\dev\\round6-alpha");
    expect(canonicalizeProjectRoot("C:\\", "win32")).toBe("c:\\");
    expect(canonicalizeProjectRoot("/Users/Dev/Round6-Alpha/", "linux")).toBe("/Users/Dev/Round6-Alpha");
    expect(canonicalizeProjectRoot("/Users/Dev/Round6-Alpha", "darwin")).toBe("/Users/Dev/Round6-Alpha");
  });
});

describe("ProjectPolicyGate", () => {
  it("denies unknown projects before any project data access", () => {
    const gate = new ProjectPolicyGate({ getProjectByRootPath: () => undefined });
    const decision = gate.check("C:/work/unknown");

    expect(decision.allowed).toBe(false);
    expect(decision.projectStatus).toBe("unregistered");
    expect(decision.reason).toContain("not registered");
  });

  it.each(["unregistered", "paused", "ignored"] as const)("denies %s projects", (status) => {
    const record = project(status);
    const gate = new ProjectPolicyGate({ getProjectByRootPath: () => record });

    expect(gate.check(record.rootPath)).toMatchObject({ allowed: false, projectStatus: status });
  });

  it("allows only tracked projects and keeps source paths inside the root", () => {
    const record = project("tracked");
    const gate = new ProjectPolicyGate({ getProjectByRootPath: () => record });

    expect(gate.check(record.rootPath)).toMatchObject({ allowed: true, projectStatus: "tracked" });
    expect(isPathWithinProject(record.rootPath, "handoffs/closing.md")).toBe(true);
    expect(isPathWithinProject(record.rootPath, "../secrets.txt")).toBe(false);
    expect(safeProjectPath(record.rootPath, "handoffs/closing.md")).toContain("handoffs");
    expect(safeProjectPath(record.rootPath, "../secrets.txt")).toBeUndefined();
    expect(isPathWithinProject(record.rootPath, "..\\secrets.txt")).toBe(false);
    expect(isPathWithinProject(record.rootPath, "C:\\outside\\secrets.txt")).toBe(false);
  });

  it("normalizes roots and resolves their parent directory", () => {
    const root = canonicalizeProjectRoot("  ./work/project///  ");
    expect(root.endsWith(`${join("work", "project")}`)).toBe(true);
    expect(projectParentPath(root)).toBe(dirname(root));
    const filesystemRoot = resolve("/");
    expect(canonicalizeProjectRoot(filesystemRoot)).toBe(filesystemRoot.toLowerCase());
    expect(isPathWithinProject(root, ".")).toBe(true);
    expect(isPathWithinProject(root, "..")).toBe(false);
  });

  it("covers Windows path normalization while restoring the host platform", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    const parent = mkdtempSync(join(tmpdir(), "work-intelligence-policy-platform-"));
    const root = join(parent, "MiXeD-Project");
    mkdirSync(root);
    writeFileSync(join(root, "File.ts"), "inside", "utf8");
    try {
      Object.defineProperty(process, "platform", { ...platform, value: "win32" });
      expect(canonicalizeProjectRoot("./MiXeD/Project")).toBe(canonicalizeProjectRoot("./MiXeD/Project").toLowerCase());
      const syncResolver = createProjectPathResolver(root);
      expect(syncResolver.safePath("File.ts")).toBe(syncResolver.safePath("File.ts"));
      const asyncResolver = createAsyncProjectPathResolver(root);
      await expect(asyncResolver.safePath("File.ts")).resolves.toBe(join(root, "File.ts"));
    } finally {
      if (platform) {
        Object.defineProperty(process, "platform", platform);
      }
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("caches synchronous path checks and fails closed for missing existing paths", () => {
    const parent = mkdtempSync(join(tmpdir(), "work-intelligence-policy-sync-"));
    const root = join(parent, "project");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "inside.ts"), "inside", "utf8");

    try {
      const resolver = createProjectPathResolver(root);
      const inside = resolver.safePath("src/inside.ts");
      expect(inside).toContain(join("src", "inside.ts"));
      expect(resolver.safePath("src/inside.ts")).toBe(inside);
      expect(resolver.safeExistingPath("src/inside.ts")).toContain(join("src", "inside.ts"));
      expect(resolver.safeExistingPath("src/inside.ts")).toContain(join("src", "inside.ts"));
      expect(resolver.safeExistingPath("src/missing.ts")).toBeUndefined();
      expect(resolver.safePath("../outside.ts")).toBeUndefined();
      expect(resolver.safeExistingPath("src/inside.ts")).toContain(join("src", "inside.ts"));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects existing symlink paths that resolve outside the project root", () => {
    const parent = mkdtempSync(join(tmpdir(), "work-intelligence-policy-"));
    const root = join(parent, "project");
    const outside = join(parent, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "must stay outside", "utf8");

    try {
      symlinkSync(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      rmSync(parent, { recursive: true, force: true });
      return;
    }

    try {
      expect(safeProjectPath(root, "linked/secret.txt")).toBeUndefined();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("resolves a batch asynchronously while preserving order and policy boundaries", async () => {
    const parent = mkdtempSync(join(tmpdir(), "work-intelligence-policy-"));
    const root = join(parent, "project");
    const outside = join(parent, "outside");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(root, "src", "inside.ts"), "inside", "utf8");
    writeFileSync(join(outside, "secret.txt"), "outside", "utf8");

    try {
      const resolver = createAsyncProjectPathResolver(root);
      const safePaths = await resolver.safePaths(["src/inside.ts", "src/new.ts", "../outside/secret.txt"]);
      expect(safePaths[0]).toContain(`${join("src", "inside.ts")}`);
      expect(safePaths[1]).toContain(`${join("src", "new.ts")}`);
      expect(safePaths[2]).toBeUndefined();
      await expect(resolver.safePaths(["src/inside.ts", "src/inside.ts"])).resolves.toEqual([
        safePaths[0],
        safePaths[0],
      ]);

      const existingPaths = await safeExistingProjectPaths(root, [
        "src/inside.ts",
        "src/new.ts",
        "../outside/secret.txt",
      ]);
      expect(existingPaths[0]).toContain(`${join("src", "inside.ts")}`);
      expect(existingPaths[1]).toBeUndefined();
      expect(existingPaths[2]).toBeUndefined();

      const helperPaths = await safeProjectPaths(root, ["src/inside.ts", "../outside/secret.txt"]);
      expect(helperPaths[0]).toContain(`${join("src", "inside.ts")}`);
      expect(helperPaths[1]).toBeUndefined();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects an asynchronous symlink escape", async () => {
    const parent = mkdtempSync(join(tmpdir(), "work-intelligence-policy-"));
    const root = join(parent, "project");
    const outside = join(parent, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "must stay outside", "utf8");

    try {
      symlinkSync(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      rmSync(parent, { recursive: true, force: true });
      return;
    }

    try {
      const resolver = createAsyncProjectPathResolver(root);
      await expect(resolver.safeExistingPath("linked/secret.txt")).resolves.toBeUndefined();
      await expect(resolver.safePath("linked/new.txt")).resolves.toBeUndefined();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("allows lexical paths for an async not-yet-created root but denies existing reads", async () => {
    const parent = mkdtempSync(join(tmpdir(), "work-intelligence-policy-missing-"));
    const root = join(parent, "not-created");

    try {
      const resolver = createAsyncProjectPathResolver(root);
      await expect(resolver.safePath("handoffs/new.md")).resolves.toBe(join(root, "handoffs", "new.md"));
      await expect(resolver.safeExistingPath("handoffs/new.md")).resolves.toBeUndefined();
      await expect(resolver.safeExistingPath("handoffs/new.md")).resolves.toBeUndefined();
      const syncResolver = createProjectPathResolver(root);
      expect(syncResolver.safeExistingPath("handoffs/new.md")).toBeUndefined();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("matchRegisteredRoots", () => {
  const candidate = (name: string, rootPath: string) => ({ name, rootPath });

  it("matches a moved folder by its folder name or project name, ignoring case", () => {
    const moved = candidate("Atlas", "/old/disk/atlas-app");
    const named = candidate("Atlas-App", "/elsewhere/web");
    const unrelated = candidate("Other", "/old/disk/other");

    expect(matchRegisteredRoots("/new/disk/ATLAS-APP", [unrelated, named, moved], 5)).toEqual([moved, named]);
  });

  it("ranks a root containing the path first, nearest root before a farther one", () => {
    const outer = candidate("Mono", "/work/mono");
    const inner = candidate("Mono web", "/work/mono/apps/web");
    const sameName = candidate("Src", "/other/src");

    expect(matchRegisteredRoots("/work/mono/apps/web/src", [sameName, outer, inner], 5)).toEqual([
      inner,
      outer,
      sameName,
    ]);
  });

  it("matches roots inside a parent folder last, shallowest first", () => {
    const deep = candidate("Deep", "/work/clients/a/deep");
    const shallow = candidate("Shallow", "/work/clients/shallow");

    expect(matchRegisteredRoots("/work/clients", [deep, shallow], 5)).toEqual([shallow, deep]);
  });

  it("treats a trailing separator, backslashes and case alike", () => {
    const windows = candidate("Billing", "c:\\users\\me\\billing");

    expect(matchRegisteredRoots("C:\\Users\\Me\\Billing\\api\\", [windows], 5)).toEqual([windows]);
    expect(matchRegisteredRoots("/home/me/Billing/", [windows], 5)).toEqual([windows]);
  });

  it("does not match a shared prefix, a similar name, or anything from a filesystem root", () => {
    const candidates = [candidate("Atlas", "/work/atlas"), candidate("Root", "/")];

    expect(matchRegisteredRoots("/work/atlas-v2", candidates, 5)).toEqual([]);
    expect(matchRegisteredRoots("/work/atla", candidates, 5)).toEqual([]);
    expect(matchRegisteredRoots("/", candidates, 5)).toEqual([]);
    expect(matchRegisteredRoots("c:\\", [candidate("Drive", "c:\\work\\drive")], 5)).toEqual([]);
  });

  it("orders ties by name and root, and returns at most the limit", () => {
    const candidates = [
      candidate("Beta", "/b/app"),
      candidate("Alpha", "/c/app"),
      candidate("Alpha", "/a/app"),
      candidate("Gamma", "/d/app"),
    ];

    expect(matchRegisteredRoots("/new/app", candidates, 3)).toEqual([candidates[2], candidates[1], candidates[0]]);
  });
});
