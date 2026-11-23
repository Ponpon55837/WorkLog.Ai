import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { checkScanLimits } from "./errors.js";
import { isRecord } from "./metrics.js";

export interface UsageProjectInput {
  id: string;
  name: string;
  root: string;
}

export interface UsageSourceDirs {
  claudeProjectsDir: string;
  codexSessionsDir: string;
}

export type UsageSourceProblem = "claude-dir-missing" | "codex-dir-missing" | "permission-denied" | "none-found";

export interface UsageProjectSources {
  projectId: string;
  /** Absolute folders under the Claude projects directory; for scanning only, never shown to users. */
  claudeFolders: string[];
  /** Absolute Codex rollout files whose first session_meta cwd lies in the project root. */
  codexFiles: string[];
  problem?: UsageSourceProblem;
}

const WORKTREE_MARKER = "--claude-worktrees-";
/** Claude Code shortens longer folder names to this many characters and appends a hash. */
const CLAUDE_NAME_LIMIT = 200;
const ROLLOUT_NAME = /^rollout-.*\.jsonl$/;
const META_MAX_BYTES = 1024 * 1024;
const META_MAX_LINES = 20;
const READ_CONCURRENCY = 16;

type DirState = "ok" | "missing" | "denied";

/** Claude Code's rule for a project folder name: every character that is not [A-Za-z0-9] becomes "-". */
export function encodeClaudeProjectDir(root: string): string {
  return root.replace(/[^A-Za-z0-9]/g, "-");
}

/** Default locations of the Claude Code and Codex logs under the current user's home directory. */
export function defaultUsageSourceDirs(): UsageSourceDirs {
  return {
    claudeProjectsDir: join(homedir(), ".claude", "projects"),
    codexSessionsDir: join(homedir(), ".codex", "sessions"),
  };
}

function folderMatches(name: string, encoded: string): boolean {
  const fold = process.platform === "win32" ? (value: string) => value.toLowerCase() : (value: string) => value;
  const folded = fold(name);
  const base = fold(encoded);
  if (folded === base || folded.startsWith(base + WORKTREE_MARKER)) return true;
  return encoded.length > CLAUDE_NAME_LIMIT && folded.startsWith(base.slice(0, CLAUDE_NAME_LIMIT));
}

function isInside(root: string, candidate: string): boolean {
  const fold = process.platform === "win32" ? (value: string) => value.toLowerCase() : (value: string) => value;
  const path = relative(fold(resolve(root)), fold(resolve(candidate)));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function stateOf(error: unknown): DirState {
  const code = isRecord(error) ? error.code : undefined;
  return code === "EACCES" || code === "EPERM" ? "denied" : "missing";
}

/** Reads only the first session_meta line of a rollout, stopping early; returns its cwd or null. */
async function readRolloutCwd(path: string): Promise<string | null> {
  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 64 * 1024 });
  let buffered = "";
  let bytes = 0;
  let lines = 0;
  try {
    for await (const chunk of stream as AsyncIterable<string>) {
      buffered += chunk;
      bytes += chunk.length;
      for (let newline = buffered.indexOf("\n"); newline !== -1; newline = buffered.indexOf("\n")) {
        const cwd = cwdOfMetaLine(buffered.slice(0, newline));
        if (cwd !== undefined) return cwd;
        buffered = buffered.slice(newline + 1);
        lines += 1;
        if (lines >= META_MAX_LINES) return null;
      }
      if (bytes > META_MAX_BYTES) return null;
    }
    return cwdOfMetaLine(buffered) ?? null;
  } catch {
    return null;
  } finally {
    stream.destroy();
  }
}

/** The cwd of a session_meta line (null when it has none), or undefined when the line is not a session_meta. */
function cwdOfMetaLine(text: string): string | null | undefined {
  if (text.trim() === "") return undefined;
  try {
    const line: unknown = JSON.parse(text);
    if (!isRecord(line) || line.type !== "session_meta") return undefined;
    return isRecord(line.payload) && typeof line.payload.cwd === "string" ? line.payload.cwd : null;
  } catch {
    return undefined;
  }
}

async function listRollouts(
  dir: string,
  signal: AbortSignal | undefined,
): Promise<{ state: DirState; files: string[] }> {
  const files: string[] = [];
  async function visit(path: string): Promise<DirState> {
    checkScanLimits(signal, undefined);
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      return stateOf(error);
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      if (entry.isDirectory()) await visit(join(path, entry.name));
      else if (entry.isFile() && ROLLOUT_NAME.test(entry.name)) files.push(join(path, entry.name));
    }
    return "ok";
  }
  return { state: await visit(dir), files };
}

async function readCwds(files: string[], signal: AbortSignal | undefined): Promise<Map<string, string | null>> {
  const cwds = new Map<string, string | null>();
  for (let index = 0; index < files.length; index += READ_CONCURRENCY) {
    checkScanLimits(signal, undefined);
    await Promise.all(
      files.slice(index, index + READ_CONCURRENCY).map(async (file) => {
        cwds.set(file, await readRolloutCwd(file));
      }),
    );
  }
  return cwds;
}

function problemFor(claude: DirState, codex: DirState): UsageSourceProblem {
  if (claude === "denied" || codex === "denied") return "permission-denied";
  if (claude === "missing") return "claude-dir-missing";
  if (codex === "missing") return "codex-dir-missing";
  return "none-found";
}

/**
 * Finds the Claude Code folders and Codex rollouts that belong to each project root. Read-only: nothing is created,
 * Codex cwd values are compared and never returned, and a missing or unreadable directory becomes a `problem` code
 * (reported only when a project has no source at all) instead of an error that could embed a path.
 */
export async function resolveProjectSources(
  projects: UsageProjectInput[],
  dirs: UsageSourceDirs = defaultUsageSourceDirs(),
  options: { signal?: AbortSignal } = {},
): Promise<UsageProjectSources[]> {
  const { signal } = options;
  let claudeState: DirState = "ok";
  let claudeNames: string[] = [];
  try {
    const entries = await readdir(dirs.claudeProjectsDir, { withFileTypes: true });
    claudeNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    claudeState = stateOf(error);
  }
  checkScanLimits(signal, undefined);
  const codex = await listRollouts(dirs.codexSessionsDir, signal);
  const cwds = projects.length > 0 && codex.files.length > 0 ? await readCwds(codex.files, signal) : new Map();
  return projects.map((project) => {
    const encoded = encodeClaudeProjectDir(project.root);
    const claudeFolders = claudeNames
      .filter((name) => folderMatches(name, encoded))
      .sort()
      .map((name) => join(dirs.claudeProjectsDir, name));
    const codexFiles = codex.files.filter((file) => {
      const cwd = cwds.get(file);
      return typeof cwd === "string" && isInside(project.root, cwd);
    });
    const found = claudeFolders.length > 0 || codexFiles.length > 0;
    return {
      projectId: project.id,
      claudeFolders,
      codexFiles,
      ...(found ? {} : { problem: problemFor(claudeState, codex.state) }),
    };
  });
}
