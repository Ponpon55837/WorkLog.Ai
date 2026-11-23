import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  defaultUsageSourceDirs,
  encodeClaudeProjectDir,
  formatForAgent,
  formatTable,
  resolveProjectSources,
  summarizeFiles,
  UsageScanAbortedError,
} from "../../packages/shared/src/agent-usage/index.js";

const CANARY = "SOURCES-CANARY-7777";

let base = "";
let root = "";
let claudeDir = "";
let codexDir = "";

function rollout(day: string, id: string, lines: unknown[]): string {
  const dir = join(codexDir, "2026", "03", day);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-03-${day}T00-00-00-${id}.jsonl`);
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}

const meta = (cwd: unknown) => ({
  timestamp: "2026-03-01T00:00:00Z",
  type: "session_meta",
  payload: { cwd, instructions: CANARY },
});

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "usage-sources-"));
  root = join(base, "work", "my.project");
  claudeDir = join(base, "claude-projects");
  codexDir = join(base, "codex-sessions");
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("encodeClaudeProjectDir", () => {
  it.each([
    ["/Users/x/sideProject/WorkLog.Ai", "-Users-x-sideProject-WorkLog-Ai"],
    ["C:\\Users\\x\\a.b", "C--Users-x-a-b"],
    ["/home/x/專案", "-home-x---"],
    ["/home/x/my_project", "-home-x-my-project"],
    ["/home/x/.hidden dir", "-home-x--hidden-dir"],
  ])("encodes %s", (value, expected) => {
    expect(encodeClaudeProjectDir(value)).toBe(expected);
  });
});

describe("resolveProjectSources", () => {
  it("matches exact and worktree folders but not siblings, and compares Codex cwd with the root", async () => {
    const encoded = encodeClaudeProjectDir(root);
    for (const name of [
      encoded,
      `${encoded}--claude-worktrees-feature-a`,
      `${encoded}-other`,
      `${encoded}extra`,
      `${encoded}--claude-worktree-typo`,
      "-unrelated",
    ]) {
      mkdirSync(join(claudeDir, name), { recursive: true });
    }
    writeFileSync(join(claudeDir, `${encoded}--claude-worktrees-file`), "not a folder");
    const inside = rollout("01", "aaaaaaaa-0000-4000-8000-000000000001", [meta(join(root, "sub", "dir"))]);
    const exact = rollout("02", "aaaaaaaa-0000-4000-8000-000000000002", [meta(root)]);
    rollout("03", "aaaaaaaa-0000-4000-8000-000000000003", [meta(`${root}-sibling`)]);
    rollout("04", "aaaaaaaa-0000-4000-8000-000000000004", [meta(join(base, "elsewhere"))]);
    rollout("05", "aaaaaaaa-0000-4000-8000-000000000005", [{ type: "turn_context", payload: {} }, meta(7)]);
    writeFileSync(join(codexDir, "2026", "03", "05", "notes.txt"), "ignored");
    const [result] = await resolveProjectSources([{ id: "p1", name: "Mine", root }], {
      claudeProjectsDir: claudeDir,
      codexSessionsDir: codexDir,
    });
    expect(result?.projectId).toBe("p1");
    expect(result?.claudeFolders).toEqual([
      join(claudeDir, encoded),
      join(claudeDir, `${encoded}--claude-worktrees-feature-a`),
    ]);
    expect(result?.codexFiles).toEqual([inside, exact]);
    expect(result?.problem).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it("accepts long-name prefixes, a Codex cwd after other lines, and reports nothing found", async () => {
    const longRoot = join(base, "long", "a".repeat(220));
    const encoded = encodeClaudeProjectDir(longRoot);
    mkdirSync(join(claudeDir, `${encoded.slice(0, 200)}-abc123`), { recursive: true });
    const [long, none] = await resolveProjectSources(
      [
        { id: "long", name: "Long", root: longRoot },
        { id: "none", name: "None", root: join(base, "nothing-here") },
      ],
      { claudeProjectsDir: claudeDir, codexSessionsDir: codexDir },
    );
    expect(long?.claudeFolders).toHaveLength(1);
    expect(none).toEqual({ projectId: "none", claudeFolders: [], codexFiles: [], problem: "none-found" });
  });

  it("maps missing and unreadable directories to problem codes", async () => {
    const missing = join(base, "does-not-exist");
    const project = [{ id: "p", name: "P", root: join(base, "nothing-here") }];
    const both = await resolveProjectSources(project, { claudeProjectsDir: missing, codexSessionsDir: missing });
    expect(both[0]?.problem).toBe("claude-dir-missing");
    const codexOnly = await resolveProjectSources(project, { claudeProjectsDir: claudeDir, codexSessionsDir: missing });
    expect(codexOnly[0]?.problem).toBe("codex-dir-missing");
    // A file where a directory is expected is not readable as one.
    const asFile = join(base, "a-file");
    writeFileSync(asFile, "x");
    const odd = await resolveProjectSources(project, { claudeProjectsDir: asFile, codexSessionsDir: asFile });
    expect(odd[0]?.problem).toBe("claude-dir-missing");
    // A found source hides the missing-directory problem.
    const found = await resolveProjectSources([{ id: "p1", name: "Mine", root }], {
      claudeProjectsDir: claudeDir,
      codexSessionsDir: missing,
    });
    expect(found[0]?.problem).toBeUndefined();
    expect(JSON.stringify([both, codexOnly, odd])).not.toContain(base);
  });

  it("never creates the directories it reads and honors an aborted signal", async () => {
    const missing = join(base, "never-created");
    await resolveProjectSources([{ id: "p", name: "P", root }], {
      claudeProjectsDir: missing,
      codexSessionsDir: missing,
    });
    await expect(
      resolveProjectSources(
        [{ id: "p", name: "P", root }],
        { claudeProjectsDir: claudeDir, codexSessionsDir: codexDir },
        {
          signal: AbortSignal.abort(),
        },
      ),
    ).rejects.toBeInstanceOf(UsageScanAbortedError);
    const { existsSync } = await import("node:fs");
    expect(existsSync(missing)).toBe(false);
  });
});

describe("report text", () => {
  it.each(["en", "zh-TW"] as const)(
    "formatForAgent carries no paths, folder names, cwd or content (%s)",
    async (locale) => {
      const dir = join(base, `secret-folder-${CANARY}`);
      mkdirSync(dir, { recursive: true });
      const line = (type: string, second: number, message: unknown, extra: object = {}) =>
        JSON.stringify({
          type,
          sessionId: `sess-${CANARY}`,
          cwd: join(base, `cwd-${CANARY}`),
          gitBranch: `branch-${CANARY}`,
          timestamp: new Date(Date.UTC(2026, 2, 1, 0, 0, second)).toISOString(),
          message,
          ...extra,
        });
      const lines = [
        line("user", 0, { role: "user", content: `${CANARY} prompt` }),
        line("assistant", 1, {
          id: "m1",
          content: [
            {
              type: "tool_use",
              id: "a",
              name: "mcp__wi__work_read",
              input: { operation: "work_search_memory", q: CANARY },
            },
            { type: "tool_use", id: "b", name: "mcp__wi__work_read", input: { operation: `Bad ${CANARY}` } },
            { type: "tool_use", id: "c", name: "Bash", input: { command: CANARY } },
          ],
          usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 },
        }),
        line("user", 2, {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "a", content: "r".repeat(25) }],
        }),
      ];
      writeFileSync(join(dir, "s.jsonl"), lines.join("\n") + "\n");
      const report = await summarizeFiles([dir]);
      const text = formatForAgent(report, { projectNames: ["Work Project"], since: "2026-03-01", locale });
      for (const forbidden of [base, dir, CANARY, "secret-folder", "cwd-", "branch-", "sess-", "Bad "]) {
        expect(text).not.toContain(forbidden);
        expect(formatTable(report)).not.toContain(forbidden);
      }
      expect(text).toContain("Work Project");
      expect(text).toContain("session-1");
      expect(text).toContain("work_read/work_search_memory: 1, 25, 25");
      expect(text).toContain("work_read/(unknown): 1, 0, 0");
      expect(text).toContain("Bash: 1");
      expect(text).toContain(locale === "en" ? "estimate" : "估算");
    },
  );

  it("formats an empty report", async () => {
    const report = await summarizeFiles([]);
    expect(formatForAgent(report)).toContain("none");
    expect(formatTable(report)).toContain("total");
  });
});

describe("resolveProjectSources on Windows", () => {
  it("compares folder names and Codex cwd case-insensitively", async () => {
    const winBase = mkdtempSync(join(tmpdir(), "usage-sources-win-"));
    const winRoot = join(winBase, "Project");
    const projects = join(winBase, "claude");
    const sessions = join(winBase, "codex");
    mkdirSync(join(projects, encodeClaudeProjectDir(winRoot).toLowerCase()), { recursive: true });
    mkdirSync(join(sessions, "2026"), { recursive: true });
    const file = join(sessions, "2026", "rollout-2026-03-01T00-00-00-aaaaaaaa-0000-4000-8000-000000000009.jsonl");
    writeFileSync(file, `${JSON.stringify(meta(winRoot.toUpperCase()))}\n`);
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const [result] = await resolveProjectSources([{ id: "w", name: "Win", root: winRoot }], {
        claudeProjectsDir: projects,
        codexSessionsDir: sessions,
      });
      expect(result?.claudeFolders).toHaveLength(1);
      expect(result?.codexFiles).toEqual([file]);
    } finally {
      platform.mockRestore();
      rmSync(winBase, { recursive: true, force: true });
    }
  });
});

describe("defaultUsageSourceDirs", () => {
  it("points at the Claude Code and Codex folders under the home directory", () => {
    const dirs = defaultUsageSourceDirs();
    expect(dirs.claudeProjectsDir).toBe(join(homedir(), ".claude", "projects"));
    expect(dirs.codexSessionsDir).toBe(join(homedir(), ".codex", "sessions"));
  });
});

describe("resolveProjectSources rollout reading", () => {
  it("gives up on rollouts whose session_meta is late, huge, unreadable or missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-sources-meta-"));
    const sessions = join(dir, "codex");
    const projectRoot = join(dir, "proj");
    mkdirSync(sessions, { recursive: true });
    const write = (n: string, body: string) =>
      writeFileSync(join(sessions, `rollout-2026-03-01T00-00-00-aaaaaaaa-0000-4000-8000-00000000000${n}.jsonl`), body);
    const filler = Array.from({ length: 25 }, () => JSON.stringify({ type: "noise" })).join("\n");
    write("1", `${filler}\n${JSON.stringify(meta(projectRoot))}\n`);
    write("2", "x".repeat(1024 * 1024 + 10));
    write("3", `${JSON.stringify(meta(projectRoot))}`);
    write("4", `{"type":"session_meta","payload":{}}\n`);
    write("5", "");
    try {
      const [result] = await resolveProjectSources([{ id: "p", name: "P", root: projectRoot }], {
        claudeProjectsDir: join(dir, "missing"),
        codexSessionsDir: sessions,
      });
      expect(result?.codexFiles.map((file) => file.slice(-7))).toEqual(["3.jsonl"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
