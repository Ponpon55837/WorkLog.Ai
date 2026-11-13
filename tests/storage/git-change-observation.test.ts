import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { observeGitChangedFileChanges, type GitRunner } from "../../packages/storage/src/git-change-observation.js";

// Fictional fixtures only.
const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fakeRunner(outputs: { mergeBase?: string | Error; diff?: string | Error; others?: string | Error }) {
  const calls: string[][] = [];
  const runner: GitRunner = async (args) => {
    calls.push(args);
    const key = args.includes("merge-base") ? "mergeBase" : args.includes("diff") ? "diff" : "others";
    const value = outputs[key] ?? "";
    if (value instanceof Error) throw value;
    return value;
  };
  return { runner, calls };
}

const request = (paths: string[], baseCommit?: string) => ({ rootPath: "/fictional/root", paths, baseCommit });

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Fictional", "-c", "user.email=fictional@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function createRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-git-observe-"));
  tempDirs.push(root);
  git(root, "init", "-q");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "keep.txt"), "keep\n");
  writeFileSync(join(root, "edit.txt"), "one\n");
  writeFileSync(join(root, "gone.txt"), "gone\n");
  writeFileSync(
    join(root, "old-name.txt"),
    "a distinctive body that is long enough to detect a rename\nline two\nline three\n",
  );
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "initial");
  return root;
}

describe("observeGitChangedFileChanges parsing", () => {
  it("maps name-status codes, renames, copies, and untracked files, and skips unrequested paths", async () => {
    const diff =
      [
        "A",
        "added.ts",
        "M",
        "edit.ts",
        "T",
        "type.ts",
        "D",
        "removed.ts",
        "R087",
        "before.ts",
        "after.ts",
        "C100",
        "source.ts",
        "copy.ts",
        "U",
        "conflict.ts",
        "M",
        "unrequested.ts",
      ].join("\0") + "\0";
    const { runner, calls } = fakeRunner({ diff, others: "fresh.ts\0ignored-extra.ts\0" });
    const paths = ["added.ts", "edit.ts", "type.ts", "removed.ts", "after.ts", "copy.ts", "conflict.ts", "fresh.ts"];

    const observed = await observeGitChangedFileChanges(request(paths), { runGit: runner });

    expect(observed).toEqual({
      base: "HEAD",
      changes: [
        { path: "added.ts", status: "added" },
        { path: "edit.ts", status: "modified" },
        { path: "type.ts", status: "modified" },
        { path: "removed.ts", status: "deleted" },
        { path: "after.ts", status: "renamed", previousPath: "before.ts" },
        { path: "copy.ts", status: "added" },
        { path: "fresh.ts", status: "added" },
      ],
    });
    expect(calls).toHaveLength(2);
    for (const args of calls) {
      expect(args.slice(0, 7)).toEqual([
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.quotepath=false",
        "-C",
        "/fictional/root",
      ]);
      expect(args.slice(args.indexOf("--") + 1)).toEqual(paths);
    }
  });

  it("keeps odd file names intact: spaces, a leading dash, unicode, and a newline", async () => {
    const names = ["with space.ts", "-dash.ts", "資料夾/檔案.ts", "line\nbreak.ts"];
    const diff = names.flatMap((name) => ["M", name]).join("\0") + "\0";
    const { runner, calls } = fakeRunner({ diff });

    const observed = await observeGitChangedFileChanges(request(names), { runGit: runner });

    expect(observed?.changes.map((change) => change.path)).toEqual(names);
    const args = calls[0]!;
    expect(args[args.indexOf("--") + 1]).toBe("with space.ts");
    expect(args.indexOf("-dash.ts")).toBeGreaterThan(args.indexOf("--"));
  });

  it("uses a valid base commit only while it is an ancestor of HEAD", async () => {
    const base = "a".repeat(40);
    const ok = fakeRunner({});
    expect((await observeGitChangedFileChanges(request(["x.ts"], base), { runGit: ok.runner }))?.base).toBe(base);
    expect(ok.calls).toHaveLength(3);
    expect(ok.calls[0]).toContain("--is-ancestor");
    expect(ok.calls[1]).toContain(base);

    const rewritten = fakeRunner({ mergeBase: new Error("not an ancestor") });
    expect((await observeGitChangedFileChanges(request(["x.ts"], base), { runGit: rewritten.runner }))?.base).toBe(
      "HEAD",
    );

    const invalid = fakeRunner({});
    expect(
      (await observeGitChangedFileChanges(request(["x.ts"], "--upload-pack=x"), { runGit: invalid.runner }))?.base,
    ).toBe("HEAD");
    expect(invalid.calls).toHaveLength(2);
  });

  it("returns undefined for failures, truncated output, and no paths, and never throws", async () => {
    const failing = fakeRunner({ diff: new Error("timeout") });
    expect(await observeGitChangedFileChanges(request(["x.ts"]), { runGit: failing.runner })).toBeUndefined();
    const garbage = fakeRunner({ diff: "R100\0only-one-path\0" });
    expect(await observeGitChangedFileChanges(request(["x.ts"]), { runGit: garbage.runner })).toBeUndefined();
    const nonZeroOthers = fakeRunner({ others: new Error("exit 128") });
    expect(await observeGitChangedFileChanges(request(["x.ts"]), { runGit: nonZeroOthers.runner })).toBeUndefined();
    expect(await observeGitChangedFileChanges(request([]), { runGit: fakeRunner({}).runner })).toBeUndefined();
  });

  it("caps the requested paths at 200 and runs at most three processes", async () => {
    const paths = Array.from({ length: 250 }, (_, index) => `src/file-${index}.ts`);
    const { runner, calls } = fakeRunner({});
    await observeGitChangedFileChanges(request(paths, "b".repeat(64)), { runGit: runner });
    expect(calls).toHaveLength(3);
    expect(calls[1]!.slice(calls[1]!.indexOf("--") + 1)).toHaveLength(200);
  });

  it("drops every inherited GIT_ variable so another repository cannot be targeted", async () => {
    const inherited = { GIT_DIR: "/fictional/other.git", GIT_WORK_TREE: "/fictional/other", GIT_INDEX_FILE: "/x" };
    const previous = Object.fromEntries(Object.keys(inherited).map((key) => [key, process.env[key]]));
    Object.assign(process.env, inherited, { GIT_CONFIG_COUNT: "1", FICTIONAL_KEEP: "yes" });
    try {
      let seen: Parameters<GitRunner>[1] | undefined;
      const runner: GitRunner = async (_args, options) => {
        seen = options;
        return "";
      };
      await observeGitChangedFileChanges(request(["x.ts"]), { runGit: runner });
      const gitKeys = Object.keys(seen?.env ?? {}).filter((key) => key.toUpperCase().startsWith("GIT_"));
      expect(gitKeys.sort()).toEqual(["GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT"]);
      expect(seen?.env.FICTIONAL_KEEP).toBe("yes");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      delete process.env.GIT_CONFIG_COUNT;
      delete process.env.FICTIONAL_KEEP;
    }
  });

  it("passes the timeout and the no-lock, no-prompt environment to the runner", async () => {
    let seen: Parameters<GitRunner>[1] | undefined;
    const runner: GitRunner = async (_args, options) => {
      seen = options;
      return "";
    };
    await observeGitChangedFileChanges(request(["x.ts"]), { runGit: runner, timeoutMs: 321 });
    expect(seen?.timeoutMs).toBe(321);
    expect(seen?.env.GIT_OPTIONAL_LOCKS).toBe("0");
    expect(seen?.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(seen?.maxBuffer).toBeGreaterThan(0);
  });
});

describe("observeGitChangedFileChanges with a real repository", () => {
  it("reports untracked, staged, modified, deleted, and staged-rename paths", async () => {
    const root = createRepo();
    writeFileSync(join(root, "fresh.txt"), "new\n");
    writeFileSync(join(root, "staged.txt"), "staged\n");
    git(root, "add", "staged.txt");
    writeFileSync(join(root, "edit.txt"), "two\n");
    rmSync(join(root, "gone.txt"));
    renameSync(join(root, "old-name.txt"), join(root, "new-name.txt"));
    git(root, "add", "-A", "old-name.txt", "new-name.txt");

    const observed = await observeGitChangedFileChanges({
      rootPath: root,
      paths: ["fresh.txt", "staged.txt", "edit.txt", "gone.txt", "new-name.txt", "old-name.txt", "keep.txt"],
    });

    expect(observed?.base).toBe("HEAD");
    expect(observed?.changes).toEqual(
      expect.arrayContaining([
        { path: "fresh.txt", status: "added" },
        { path: "staged.txt", status: "added" },
        { path: "edit.txt", status: "modified" },
        { path: "gone.txt", status: "deleted" },
        { path: "new-name.txt", status: "renamed", previousPath: "old-name.txt" },
      ]),
    );
    expect(observed?.changes).toHaveLength(5);
  });

  it("compares with the segment's base commit and falls back to HEAD when it is not an ancestor", async () => {
    const root = createRepo();
    const base = git(root, "rev-parse", "HEAD");
    writeFileSync(join(root, "later.txt"), "later\n");
    writeFileSync(join(root, "edit.txt"), "committed change\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "work in the segment");

    const paths = ["later.txt", "edit.txt"];
    const sinceBase = await observeGitChangedFileChanges({ rootPath: root, paths, baseCommit: base });
    expect(sinceBase?.base).toBe(base);
    expect(sinceBase?.changes).toEqual(
      expect.arrayContaining([
        { path: "later.txt", status: "added" },
        { path: "edit.txt", status: "modified" },
      ]),
    );

    git(root, "checkout", "-q", "--orphan", "other");
    git(root, "commit", "-q", "-m", "unrelated history", "--allow-empty");
    const unrelated = await observeGitChangedFileChanges({ rootPath: root, paths, baseCommit: base });
    expect(unrelated?.base).toBe("HEAD");
  });

  it("returns undefined outside a repository and for a repository with no commits", async () => {
    const plain = mkdtempSync(join(tmpdir(), "work-intelligence-git-observe-plain-"));
    tempDirs.push(plain);
    writeFileSync(join(plain, "a.txt"), "a\n");
    expect(await observeGitChangedFileChanges({ rootPath: plain, paths: ["a.txt"] })).toBeUndefined();

    const empty = mkdtempSync(join(tmpdir(), "work-intelligence-git-observe-empty-"));
    tempDirs.push(empty);
    git(empty, "init", "-q");
    writeFileSync(join(empty, "a.txt"), "a\n");
    expect(await observeGitChangedFileChanges({ rootPath: empty, paths: ["a.txt"] })).toBeUndefined();
  });

  it("reports paths relative to a project root that is a subdirectory of the repository", async () => {
    const root = createRepo();
    mkdirSync(join(root, "packages", "ledger"), { recursive: true });
    writeFileSync(join(root, "packages", "ledger", "inner.txt"), "inner\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "add package");
    writeFileSync(join(root, "packages", "ledger", "inner.txt"), "inner changed\n");
    writeFileSync(join(root, "packages", "ledger", "extra.txt"), "extra\n");
    writeFileSync(join(root, "edit.txt"), "outside the project\n");

    const observed = await observeGitChangedFileChanges({
      rootPath: join(root, "packages", "ledger"),
      paths: ["inner.txt", "extra.txt"],
    });

    expect(observed?.changes).toEqual(
      expect.arrayContaining([
        { path: "inner.txt", status: "modified" },
        { path: "extra.txt", status: "added" },
      ]),
    );
    expect(observed?.changes).toHaveLength(2);
  });

  it("treats paths literally, so a glob character never matches other files", async () => {
    const root = createRepo();
    writeFileSync(join(root, "a1.txt"), "a\n");
    const observed = await observeGitChangedFileChanges({ rootPath: root, paths: ["a*.txt"] });
    expect(observed?.changes).toEqual([]);
  });
});
