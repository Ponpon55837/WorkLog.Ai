import { execFile, execFileSync } from "node:child_process";
import type { ChangedFileChange } from "@work-intelligence/core";
import { changedFileIdentity, isCommitSha } from "./session-record-codecs.js";

export type GitRunnerOptions = {
  timeoutMs: number;
  maxBuffer: number;
  env: NodeJS.ProcessEnv;
};

/** Runs git with the full argument list and resolves with stdout; rejects on a non-zero exit, timeout, or spawn error. */
export type GitRunner = (args: string[], options: GitRunnerOptions) => Promise<string>;

export type GitObservationRequest = {
  rootPath: string;
  /** Project-relative, "/"-separated paths whose status is wanted. */
  paths: string[];
  /** The HEAD commit at the start of the segment; used only when it is still an ancestor of HEAD. */
  baseCommit?: string;
};

export type GitObservedChanges = {
  /** The commit the working tree was compared with: a full sha, or "HEAD". */
  base: string;
  changes: ChangedFileChange[];
};

export type GitObservationDependencies = {
  runGit?: GitRunner;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 1_500;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
/** Matches the changedFileChanges schema maximum. */
const MAX_OBSERVED_PATHS = 200;

/** The inherited environment without any GIT_* variable, so a hook's GIT_DIR or GIT_INDEX_FILE cannot redirect git. */
function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const name = process.platform === "win32" ? key.toUpperCase() : key;
    if (!name.startsWith("GIT_")) env[key] = value;
  }
  return { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
}

/** Global arguments: literal pathspecs, no fsmonitor daemon, raw (unquoted) paths, rooted at the project. */
function baseArguments(rootPath: string): string[] {
  return ["--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "-C", rootPath];
}

const runGitProcess: GitRunner = (args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
        env: options.env,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

export type GitHead = { branch?: string; commitSha?: string };

/** Runs one git query synchronously; undefined on a non-zero exit, timeout, missing git, or empty output. */
function runGitSync(rootPath: string, args: string[], timeoutMs: number): string | undefined {
  try {
    const output = execFileSync("git", [...baseArguments(rootPath), ...args], {
      encoding: "utf8",
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER_BYTES,
      env: gitEnvironment(),
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Asks Git itself for the checked-out branch and HEAD commit. Used when the loose files under `.git` cannot answer:
 * a linked worktree (`.git` is a file), a packed ref, or another ref storage format. A detached HEAD has no branch
 * and an unborn branch has no commit; undefined when Git reports neither.
 */
export function readGitHeadWithGit(rootPath: string, timeoutMs = DEFAULT_TIMEOUT_MS): GitHead | undefined {
  const branch = runGitSync(rootPath, ["symbolic-ref", "--short", "-q", "HEAD"], timeoutMs);
  const commit = runGitSync(rootPath, ["rev-parse", "--verify", "-q", "HEAD^{commit}"], timeoutMs);
  const commitSha = commit && isCommitSha(commit) ? commit.toLowerCase() : undefined;
  return branch || commitSha ? { branch, commitSha } : undefined;
}

/** Parses `git diff --name-status -z`; throws on a truncated record so the caller drops the whole observation. */
function parseNameStatus(output: string, allowed: Set<string>): ChangedFileChange[] {
  const tokens = output.split("\0");
  if (tokens[tokens.length - 1] === "") tokens.pop();
  const changes: ChangedFileChange[] = [];
  let index = 0;
  const next = (): string => {
    const token = tokens[index++];
    if (token === undefined || token === "") throw new Error("Malformed git name-status output.");
    return token;
  };
  while (index < tokens.length) {
    const code = next()[0];
    if (code === "R" || code === "C") {
      const from = next();
      const to = next();
      if (!allowed.has(changedFileIdentity(to))) continue;
      changes.push(code === "R" ? { path: to, status: "renamed", previousPath: from } : { path: to, status: "added" });
      continue;
    }
    const path = next();
    const status =
      code === "A" ? "added" : code === "M" || code === "T" ? "modified" : code === "D" ? "deleted" : undefined;
    if (status && allowed.has(changedFileIdentity(path))) changes.push({ path, status });
  }
  return changes;
}

function parseNulList(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

/**
 * Observes what Git itself reports for the given paths: the working tree compared with the segment's base commit
 * (tracked files, staged or not) plus untracked files. It never guesses: a path Git does not report gets no status.
 * At most three git processes run, never one per file, and every failure (no git, not a repository, timeout, bad
 * output) resolves to undefined. Callers must only pass paths of a project that policy already allows.
 */
export async function observeGitChangedFileChanges(
  request: GitObservationRequest,
  dependencies: GitObservationDependencies = {},
): Promise<GitObservedChanges | undefined> {
  const runGit = dependencies.runGit ?? runGitProcess;
  const options: GitRunnerOptions = {
    timeoutMs: dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
    env: gitEnvironment(),
  };
  const paths = [...new Set(request.paths)].slice(0, MAX_OBSERVED_PATHS);
  if (paths.length === 0) return undefined;
  const allowed = new Set(paths.map(changedFileIdentity));
  const prefix = baseArguments(request.rootPath);

  try {
    let base = "HEAD";
    if (request.baseCommit && isCommitSha(request.baseCommit)) {
      try {
        await runGit([...prefix, "merge-base", "--is-ancestor", request.baseCommit, "HEAD"], options);
        base = request.baseCommit.toLowerCase();
      } catch {
        base = "HEAD";
      }
    }
    const [tracked, untracked] = await Promise.all([
      runGit(
        [
          ...prefix,
          "diff",
          "--no-ext-diff",
          "--no-color",
          "--relative",
          "-M",
          "--name-status",
          "-z",
          base,
          "--",
          ...paths,
        ],
        options,
      ),
      runGit([...prefix, "ls-files", "--others", "--exclude-standard", "-z", "--", ...paths], options),
    ]);
    const changes = parseNameStatus(tracked, allowed);
    const seen = new Set(changes.map((change) => changedFileIdentity(change.path)));
    for (const path of parseNulList(untracked)) {
      const identity = changedFileIdentity(path);
      if (allowed.has(identity) && !seen.has(identity)) {
        seen.add(identity);
        changes.push({ path, status: "added" });
      }
    }
    return { base, changes };
  } catch {
    return undefined;
  }
}
