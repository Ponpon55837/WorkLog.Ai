import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { checkScanLimits } from "./errors.js";
import { isRecord } from "./metrics.js";
import { ancestorsOf, foldPath, nativeSpelling, normalizePath } from "./paths.js";

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
  claudeFolders: string[];
  codexFiles: string[];
  problem?: UsageSourceProblem;
}

export interface UsageSourceGroup {
  projectIds: string[];
  claudeFolders: string[];
  codexFiles: string[];
}

export interface UsageSources {
  projects: UsageProjectSources[];
  groups: UsageSourceGroup[];
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

export function defaultUsageSourceDirs(): UsageSourceDirs {
  return {
    claudeProjectsDir: join(homedir(), ".claude", "projects"),
    codexSessionsDir: join(homedir(), ".codex", "sessions"),
  };
}

/**
 * `truncated` allows the shortened-name rule for roots over Claude Code's limit. Shared folders must not use it: a
 * shortened ancestor name is also a prefix of its descendants' folders.
 */
function folderMatches(name: string, encoded: string, platform: NodeJS.Platform, truncated = true): boolean {
  const folded = foldPath(name, platform);
  const base = foldPath(encoded, platform);
  if (folded === base || folded.startsWith(base + WORKTREE_MARKER)) return true;
  return truncated && encoded.length > CLAUDE_NAME_LIMIT && folded.startsWith(base.slice(0, CLAUDE_NAME_LIMIT));
}

function isInside(root: string, candidate: string, platform: NodeJS.Platform): boolean {
  const fold = (value: string): string => foldPath(value, platform);
  const path = relative(fold(resolve(root)), fold(resolve(candidate)));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function stateOf(error: unknown): DirState {
  const code = isRecord(error) ? error.code : undefined;
  return code === "EACCES" || code === "EPERM" ? "denied" : "missing";
}

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

export async function resolveProjectSources(
  projects: UsageProjectInput[],
  dirs: UsageSourceDirs = defaultUsageSourceDirs(),
  options: { signal?: AbortSignal } = {},
): Promise<UsageProjectSources[]> {
  return (await resolveUsageSources(projects, dirs, options)).projects;
}

export async function resolveUsageSources(
  projects: UsageProjectInput[],
  dirs: UsageSourceDirs = defaultUsageSourceDirs(),
  options: { signal?: AbortSignal; platform?: NodeJS.Platform } = {},
): Promise<UsageSources> {
  const { signal } = options;
  const platform = options.platform ?? process.platform;
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
  const own = projects.map((project) => {
    const encoded = encodeClaudeProjectDir(project.root);
    const claudeFolders = claudeNames
      .filter((name) => folderMatches(name, encoded, platform))
      .sort()
      .map((name) => join(dirs.claudeProjectsDir, name));
    const codexFiles = codex.files.filter((file) => {
      const cwd = cwds.get(file);
      return typeof cwd === "string" && isInside(project.root, cwd, platform);
    });
    return { projectId: project.id, claudeFolders, codexFiles };
  });
  const groups = sharedGroups(projects, own, claudeNames, codex.files, cwds, dirs, platform);
  const shared = new Set(groups.flatMap((group) => group.projectIds));
  return {
    groups,
    projects: own.map((entry) => ({
      ...entry,
      ...(entry.claudeFolders.length > 0 || entry.codexFiles.length > 0 || shared.has(entry.projectId)
        ? {}
        : { problem: problemFor(claudeState, codex.state) }),
    })),
  };
}

function sharedGroups(
  projects: UsageProjectInput[],
  own: { claudeFolders: string[]; codexFiles: string[] }[],
  claudeNames: string[],
  codexFiles: string[],
  cwds: Map<string, string | null>,
  dirs: UsageSourceDirs,
  platform: NodeJS.Platform,
): UsageSourceGroup[] {
  const trackedRoots = new Set(projects.flatMap((project) => normalizedKey(project.root, platform)));
  const ancestors = new Map<string, { path: string; ids: string[] }>();
  for (const project of projects) {
    for (const path of ancestorsOf(project.root)) {
      const key = foldPath(path, platform);
      if (trackedRoots.has(key)) continue;
      const entry = ancestors.get(key) ?? { path, ids: [] };
      entry.ids.push(project.id);
      ancestors.set(key, entry);
    }
  }
  if (ancestors.size === 0) return [];
  const ownSources = new Set(own.flatMap((entry) => [...entry.claudeFolders, ...entry.codexFiles]));
  const filesByCwd = new Map<string, string[]>();
  for (const file of codexFiles) {
    const cwd = cwds.get(file);
    const key = typeof cwd === "string" ? normalizedKey(cwd, platform)[0] : undefined;
    if (key !== undefined) filesByCwd.set(key, [...(filesByCwd.get(key) ?? []), file]);
  }
  const groups = new Map<string, UsageSourceGroup>();
  for (const [key, ancestor] of ancestors) {
    const encoded = encodeClaudeProjectDir(nativeSpelling(ancestor.path));
    const claudeFolders = claudeNames
      .filter((name) => folderMatches(name, encoded, platform, false))
      .map((name) => join(dirs.claudeProjectsDir, name))
      .filter((folder) => !ownSources.has(folder));
    const rollouts = (filesByCwd.get(key) ?? []).filter((file) => !ownSources.has(file));
    if (claudeFolders.length === 0 && rollouts.length === 0) continue;
    const id = ancestor.ids.join("\0");
    const group = groups.get(id) ?? { projectIds: ancestor.ids, claudeFolders: [], codexFiles: [] };
    group.claudeFolders.push(...claudeFolders);
    group.codexFiles.push(...rollouts);
    groups.set(id, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    claudeFolders: group.claudeFolders.sort(),
    codexFiles: group.codexFiles.sort(),
  }));
}

function normalizedKey(path: string, platform: NodeJS.Platform): string[] {
  const normalized = normalizePath(path);
  return normalized === null ? [] : [foldPath(normalized, platform)];
}
