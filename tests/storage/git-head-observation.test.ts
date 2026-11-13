import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readGitHeadWithGit } from "../../packages/storage/src/git-change-observation.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only.
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Fictional", "-c", "user.email=fictional@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function tempDir(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "work-intelligence-git-head-")));
  tempDirs.push(root);
  return root;
}

function createRepo(): string {
  const root = tempDir();
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "a.txt"), "a\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "initial");
  return root;
}

function trackedStore(root: string): WorkIntelligenceStore {
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Git head", root);
  store.updateProject(project.id, { status: "tracked" });
  return store;
}

describe("HEAD observation", () => {
  it("reads a loose ref without asking git", () => {
    const root = createRepo();
    expect(trackedStore(root).observeHeadCommit(root)).toBe(git(root, "rev-parse", "HEAD"));
  });

  it("resolves a packed ref", () => {
    const root = createRepo();
    const head = git(root, "rev-parse", "HEAD");
    git(root, "pack-refs", "--all", "--prune");
    expect(trackedStore(root).observeHeadCommit(root)).toBe(head);
    expect(readGitHeadWithGit(root)).toEqual({ branch: "main", commitSha: head });
  });

  it("resolves a linked worktree, whose .git is a file", () => {
    const root = createRepo();
    const worktree = join(tempDir(), "linked");
    git(root, "worktree", "add", "-q", "-b", "feature/linked", worktree);
    writeFileSync(join(worktree, "b.txt"), "b\n");
    git(worktree, "add", ".");
    git(worktree, "commit", "-q", "-m", "linked");
    const head = git(worktree, "rev-parse", "HEAD");
    expect(head).not.toBe(git(root, "rev-parse", "HEAD"));
    expect(trackedStore(worktree).observeHeadCommit(worktree)).toBe(head);
    expect(readGitHeadWithGit(worktree)).toEqual({ branch: "feature/linked", commitSha: head });
  });

  it("reports a detached HEAD without a branch and an unborn branch without a commit", () => {
    const root = createRepo();
    const head = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "-q", "--detach");
    git(root, "pack-refs", "--all", "--prune");
    expect(readGitHeadWithGit(root)).toEqual({ branch: undefined, commitSha: head });

    const unborn = tempDir();
    git(unborn, "init", "-q", "-b", "main");
    expect(readGitHeadWithGit(unborn)).toEqual({ branch: "main", commitSha: undefined });
    expect(trackedStore(unborn).observeHeadCommit(unborn)).toBeUndefined();
  });

  it("never reads a parent repository for a plain folder", () => {
    const root = createRepo();
    const nested = join(root, "nested");
    mkdirSync(nested);
    expect(trackedStore(nested).observeHeadCommit(nested)).toBeUndefined();
  });
});
