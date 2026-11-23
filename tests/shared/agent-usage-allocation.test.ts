import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  encodeClaudeProjectDir,
  formatForAgent,
  formatTable,
  resolveUsageSources,
  summarizeFiles,
  UsageCache,
  type UsageAllocationGroup,
  type UsageReport,
  type UsageSourceDirs,
} from "../../packages/shared/src/agent-usage/index.js";
import { ancestorsOf, normalizePath } from "../../packages/shared/src/agent-usage/paths.js";

const CANARY = "ALLOCATION-CANARY-4242";
const NOW = Date.parse("2026-03-01T12:00:00Z");
const NAMES = { a: "assistant", d: "devtools", w: "devdocs" } as const;

let base = "";
let mono = "";
let dirs: UsageSourceDirs;
let sharedFolder = "";
let counter = 0;

const projects = () => [
  { id: "a", name: NAMES.a, root: join(mono, "assistant") },
  { id: "d", name: NAMES.d, root: join(mono, "devtools") },
  { id: "w", name: NAMES.w, root: join(mono, "devdocs") },
];

interface Conversation {
  cwd?: string;
  /** Tool calls: Work Intelligence calls name `projectRoot`, file tools name a file. */
  tools?: { name: string; input: unknown }[];
  /** Extra lines that only carry a cwd (user lines). */
  cwdLines?: string[];
  input?: number;
  output?: number;
  at?: string;
}

function claudeLines(sessionId: string, conversation: Conversation): string[] {
  counter += 1;
  const at = conversation.at ?? "2026-03-01T11:00:00Z";
  const lines: unknown[] = [];
  for (const cwd of conversation.cwdLines ?? []) {
    lines.push({ type: "user", sessionId, timestamp: at, cwd, message: { role: "user", content: CANARY } });
  }
  lines.push({
    type: "assistant",
    sessionId,
    timestamp: at,
    ...(conversation.cwd ? { cwd: conversation.cwd } : {}),
    message: {
      id: `msg_${counter}`,
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: (conversation.tools ?? []).map((tool, index) => ({
        type: "tool_use",
        id: `tu_${counter}_${index}`,
        name: tool.name,
        input: tool.input,
      })),
      usage: { input_tokens: conversation.input ?? 10, output_tokens: conversation.output ?? 5 },
    },
  });
  return lines.map((line) => JSON.stringify(line));
}

function writeClaude(folder: string, sessionId: string, conversation: Conversation): string {
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `${sessionId}.jsonl`);
  writeFileSync(file, `${claudeLines(sessionId, conversation).join("\n")}\n`);
  return file;
}

const wiCall = (projectRoot: string, nested = true) => ({
  name: "mcp__wi__work_read",
  input: nested ? { operation: "work_get_context", arguments: { projectRoot } } : { operation: "work_x", projectRoot },
});
const fileCall = (name: string, path: string) => ({
  name,
  input: name === "NotebookEdit" ? { notebook_path: path } : { file_path: path },
});

function rollout(day: string, id: string, lines: unknown[]): string {
  const folder = join(dirs.codexSessionsDir, "2026", "03", day);
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `rollout-2026-03-${day}T00-00-00-${id}.jsonl`);
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return file;
}

function codexLines(cwd: string, extra: unknown[] = [], tokens = 100): unknown[] {
  return [
    { timestamp: "2026-03-01T11:00:00Z", type: "session_meta", payload: { id: "t", cwd, instructions: CANARY } },
    ...extra,
    {
      timestamp: "2026-03-01T11:00:05Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: tokens, output_tokens: 10, total_tokens: tokens + 10 } },
      },
    },
  ];
}

const turnContext = (cwd: string) => ({
  timestamp: "2026-03-01T11:00:01Z",
  type: "turn_context",
  payload: { cwd, model: "gpt-5" },
});

async function scan(
  selected: string[],
  options: { cache?: UsageCache; groupIndex?: number } = {},
): Promise<{ report: UsageReport; group: UsageAllocationGroup }> {
  const all = projects();
  const sources = await resolveUsageSources(all, dirs);
  const own = sources.projects.filter((entry) => selected.includes(entry.projectId));
  const groups = sources.groups
    .filter((group) => group.projectIds.some((id) => selected.includes(id)))
    .map((group) => ({
      projects: group.projectIds.map((id) => ({
        id,
        root: all.find((project) => project.id === id)?.root ?? "",
        selected: selected.includes(id),
      })),
      paths: [...group.claudeFolders, ...group.codexFiles],
    }));
  const report = await summarizeFiles(
    own.flatMap((entry) => [...entry.claudeFolders, ...entry.codexFiles]),
    {
      now: NOW,
      ...(groups.length > 0 ? { allocation: { groups } } : {}),
      ...(options.cache ? { cache: options.cache } : {}),
    },
  );
  const group = report.allocation.groups[options.groupIndex ?? 0];
  if (!group) throw new Error("no group");
  return { report, group };
}

function allocatedOf(group: UsageAllocationGroup, id: string) {
  const entry = group.allocated.find((item) => item.projectId === id);
  if (!entry) throw new Error(`no project ${id}`);
  return entry;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "usage-alloc-"));
  mono = join(base, "work", "mono-repo");
  dirs = { claudeProjectsDir: join(base, "claude"), codexSessionsDir: join(base, "codex") };
  sharedFolder = join(dirs.claudeProjectsDir, encodeClaudeProjectDir(mono));
  mkdirSync(dirs.claudeProjectsDir, { recursive: true });
  counter = 0;
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("path helpers", () => {
  it("normalises both separators and lists strict ancestors, nearest first", () => {
    expect(normalizePath("C:\\Work\\.\\Mono\\..\\Mono\\Assistant\\")).toBe("C:/Work/Mono/Assistant");
    expect(normalizePath("//srv/share/x")).toBe("/srv/share/x");
    expect(normalizePath("relative/path")).toBeNull();
    expect(ancestorsOf("C:\\Work\\Mono\\Assistant")).toEqual(["C:/Work/Mono", "C:/Work", "C:"]);
    expect(ancestorsOf("/a/b/c")).toEqual(["/a/b", "/a", "/"]);
    expect(ancestorsOf("rel")).toEqual([]);
  });
});

describe("resolveUsageSources", () => {
  it("groups the projects below a Claude folder (worktrees too) and a Codex cwd, and leaves own sources alone", async () => {
    mkdirSync(sharedFolder, { recursive: true });
    mkdirSync(`${sharedFolder}--claude-worktrees-feature`, { recursive: true });
    mkdirSync(`${sharedFolder}-other`, { recursive: true });
    mkdirSync(join(dirs.claudeProjectsDir, encodeClaudeProjectDir(join(mono, "assistant"))), { recursive: true });
    const atRoot = rollout("01", "aaaaaaaa-0000-4000-8000-000000000001", codexLines(mono));
    rollout("02", "aaaaaaaa-0000-4000-8000-000000000002", codexLines(join(mono, "assistant", "src")));
    rollout("03", "aaaaaaaa-0000-4000-8000-000000000003", codexLines(join(base, "elsewhere")));

    const result = await resolveUsageSources(projects(), dirs);

    expect(result.groups).toHaveLength(1);
    const [group] = result.groups;
    expect(group?.projectIds).toEqual(["a", "d", "w"]);
    expect(group?.claudeFolders).toEqual([sharedFolder, `${sharedFolder}--claude-worktrees-feature`]);
    expect(group?.codexFiles).toEqual([atRoot]);
    // The project's own folder and rollout stay its own; nothing is reported as a problem for a grouped project.
    expect(result.projects[0]?.claudeFolders).toHaveLength(1);
    expect(result.projects[0]?.codexFiles).toHaveLength(1);
    expect(result.projects[1]?.problem).toBeUndefined();
  });

  it("does not treat the root of a tracked project as a shared source", async () => {
    mkdirSync(join(dirs.claudeProjectsDir, encodeClaudeProjectDir(mono)), { recursive: true });
    const all = [...projects(), { id: "m", name: "mono", root: mono }];

    const result = await resolveUsageSources(all, dirs);

    expect(result.groups).toEqual([]);
    expect(result.projects.find((entry) => entry.projectId === "m")?.claudeFolders).toHaveLength(1);
  });

  it("matches Windows-style roots with backslashes and, on Windows, any case", async () => {
    const roots = [
      { id: "a", name: "A", root: "C:\\Work\\Mono\\Assistant" },
      { id: "d", name: "D", root: "C:/Work/Mono/Devtools/" },
    ];
    mkdirSync(join(dirs.claudeProjectsDir, "C--Work-Mono"));
    mkdirSync(join(dirs.claudeProjectsDir, "c--work-mono--claude-worktrees-x"));
    const rolloutFile = rollout("04", "aaaaaaaa-0000-4000-8000-000000000004", codexLines("C:\\Work\\Mono"));
    const lower = rollout("05", "aaaaaaaa-0000-4000-8000-000000000005", codexLines("c:/work/MONO/"));

    const posix = await resolveUsageSources(roots, dirs, { platform: "linux" });
    expect(posix.groups[0]?.claudeFolders.map((folder) => folder.slice(dirs.claudeProjectsDir.length + 1))).toEqual([
      "C--Work-Mono",
    ]);
    expect(posix.groups[0]?.codexFiles).toEqual([rolloutFile]);

    const windows = await resolveUsageSources(roots, dirs, { platform: "win32" });
    expect(windows.groups[0]?.claudeFolders).toHaveLength(2);
    expect(windows.groups[0]?.codexFiles).toEqual([rolloutFile, lower]);
  });
});

describe("allocation of shared conversations", () => {
  it("allocates by the projectRoot of Work Intelligence calls, nested or direct, most frequent first", async () => {
    writeClaude(sharedFolder, "s-root", {
      tools: [
        wiCall(join(mono, "devtools", "src")),
        wiCall(join(mono, "devtools")),
        wiCall(join(mono, "assistant"), false),
      ],
    });

    const { group } = await scan(["a", "d", "w"]);

    expect(allocatedOf(group, "d")).toMatchObject({
      conversations: 1,
      byBasis: { projectRoot: 1, filePaths: 0, cwd: 0 },
    });
    expect(allocatedOf(group, "a").conversations).toBe(0);
    expect(group.unallocated.conversations).toBe(0);
  });

  it("allocates by file-tool paths when the project hits exceed half of all hits and reach three", async () => {
    const inDev = (name: string) => join(mono, "devdocs", "guide", name);
    writeClaude(sharedFolder, "s-files", {
      tools: [
        fileCall("Read", inDev("a.md")),
        fileCall("Edit", inDev("b.md")),
        fileCall("Write", inDev("c.md")),
        fileCall("MultiEdit", join(mono, "assistant", "x.ts")),
        fileCall("NotebookEdit", join(mono, "devdocs", "n.ipynb")),
        fileCall("Read", join(base, "outside", "ignored.ts")),
      ],
    });
    writeClaude(sharedFolder, "s-few", { tools: [fileCall("Read", inDev("a.md")), fileCall("Read", inDev("b.md"))] });
    writeClaude(sharedFolder, "s-split", {
      tools: [
        fileCall("Read", inDev("a.md")),
        fileCall("Read", inDev("b.md")),
        fileCall("Read", inDev("c.md")),
        fileCall("Read", join(mono, "assistant", "1.ts")),
        fileCall("Read", join(mono, "assistant", "2.ts")),
        fileCall("Read", join(mono, "assistant", "3.ts")),
      ],
    });

    const { group } = await scan(["a", "d", "w"]);

    expect(allocatedOf(group, "w")).toMatchObject({
      conversations: 1,
      byBasis: { projectRoot: 0, filePaths: 1, cwd: 0 },
    });
    // Two hits are too few, and an even split has no project above half: both stay unallocated.
    expect(group.unallocated.conversations).toBe(2);
  });

  it("allocates by cwd lines, a conversation's cwd may change", async () => {
    writeClaude(sharedFolder, "s-cwd", {
      cwd: join(mono, "assistant", "src"),
      cwdLines: [mono, join(mono, "assistant"), join(mono, "assistant", "docs"), join(mono, "devtools")],
    });
    writeClaude(sharedFolder, "s-at-root", { cwd: mono, cwdLines: [mono, mono, mono] });

    const { group } = await scan(["a", "d", "w"]);

    expect(allocatedOf(group, "a")).toMatchObject({
      conversations: 1,
      byBasis: { projectRoot: 0, filePaths: 0, cwd: 1 },
    });
    expect(group.unallocated.conversations).toBe(1);
  });

  it("lets projectRoot beat file paths and file paths beat cwd", async () => {
    const files = [1, 2, 3, 4].map((n) => fileCall("Read", join(mono, "devtools", `f${n}.ts`)));
    writeClaude(sharedFolder, "s-1", { tools: [wiCall(join(mono, "assistant")), ...files] });
    writeClaude(sharedFolder, "s-2", {
      tools: files,
      cwd: join(mono, "devdocs"),
      cwdLines: [join(mono, "devdocs"), join(mono, "devdocs"), join(mono, "devdocs")],
    });

    const { group } = await scan(["a", "d", "w"]);

    expect(allocatedOf(group, "a").byBasis).toEqual({ projectRoot: 1, filePaths: 0, cwd: 0 });
    expect(allocatedOf(group, "d").byBasis).toEqual({ projectRoot: 0, filePaths: 1, cwd: 0 });
    expect(allocatedOf(group, "w").conversations).toBe(0);
  });

  it("falls through a tie between projectRoot values and leaves a conversation without evidence unallocated", async () => {
    writeClaude(sharedFolder, "s-tie", {
      tools: [wiCall(join(mono, "assistant")), wiCall(join(mono, "devtools"))],
    });
    writeClaude(sharedFolder, "s-none", {});

    const { group } = await scan(["a", "d", "w"]);

    expect(group.unallocated.conversations).toBe(2);
    expect(group.allocated.every((entry) => entry.conversations === 0)).toBe(true);
  });

  it("allocates Codex rollouts by projectRoot arguments, then by session_meta and turn_context cwd", async () => {
    const call = (callId: string, root: string) => ({
      timestamp: "2026-03-01T11:00:02Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "work_read",
        namespace: "mcp__wi__",
        call_id: callId,
        arguments: JSON.stringify({ operation: "work_get_context", arguments: { projectRoot: root } }),
      },
    });
    rollout("01", "aaaaaaaa-0000-4000-8000-000000000011", codexLines(mono, [call("c1", join(mono, "devtools"))]));
    rollout(
      "02",
      "aaaaaaaa-0000-4000-8000-000000000012",
      codexLines(mono, [
        turnContext(join(mono, "devdocs")),
        turnContext(join(mono, "devdocs", "x")),
        turnContext(join(mono, "devdocs")),
      ]),
    );
    rollout("03", "aaaaaaaa-0000-4000-8000-000000000013", codexLines(mono, [turnContext(join(mono, "devdocs"))]));

    const { group } = await scan(["a", "d", "w"]);

    expect(allocatedOf(group, "d").byBasis).toEqual({ projectRoot: 1, filePaths: 0, cwd: 0 });
    expect(allocatedOf(group, "w").byBasis).toEqual({ projectRoot: 0, filePaths: 0, cwd: 1 });
    expect(group.unallocated.conversations).toBe(1);
  });
});

describe("selection and conservation", () => {
  async function seed(): Promise<void> {
    writeClaude(sharedFolder, "s-a", { tools: [wiCall(join(mono, "assistant"))], input: 100, output: 1 });
    writeClaude(`${sharedFolder}--claude-worktrees-x`, "s-d", {
      tools: [wiCall(join(mono, "devtools"))],
      input: 200,
      output: 2,
    });
    writeClaude(sharedFolder, "s-u", { input: 400, output: 4 });
    rollout("01", "aaaaaaaa-0000-4000-8000-000000000021", codexLines(mono, [], 800));
  }

  it("counts every shared conversation once: allocated plus unallocated equals the source total", async () => {
    await seed();
    const plain = await summarizeFiles(
      [
        sharedFolder,
        `${sharedFolder}--claude-worktrees-x`,
        ...(await resolveUsageSources(projects(), dirs)).groups[0]!.codexFiles,
      ],
      { now: NOW },
    );

    const { report, group } = await scan(["a", "d", "w"]);

    const sum = group.allocated.reduce((total, entry) => total + entry.primary, group.unallocated.primary);
    const conversations = group.allocated.reduce(
      (total, entry) => total + entry.conversations,
      group.unallocated.conversations,
    );
    expect(sum).toBe(plain.total.tokens.input + plain.total.tokens.output);
    expect(conversations).toBe(plain.total.sessions);
    expect(report.total.tokens).toEqual(plain.total.tokens);
    expect(report.total.sessions).toBe(4);
    expect(group.unallocated).toMatchObject({ included: true, conversations: 2 });
  });

  it("credits a selected subset only with its own conversations, blocks included", async () => {
    await seed();

    const { report, group } = await scan(["d"]);

    expect(report.total.sessions).toBe(1);
    expect(report.total.tokens.input).toBe(200);
    expect(report.blocks.map((block) => block.primary)).toEqual([202]);
    expect(group.unallocated.included).toBe(false);
    expect(allocatedOf(group, "a")).toMatchObject({ included: false, conversations: 1 });
    expect(allocatedOf(group, "d")).toMatchObject({ included: true, conversations: 1 });
    // The statistics still describe the whole source.
    expect(group.unallocated.conversations).toBe(2);
    const two = await scan(["a", "d"]);
    expect(two.report.total.tokens.input).toBe(300);
    expect(two.group.unallocated.included).toBe(false);
  });
});

describe("incremental reads", () => {
  it("keeps the allocation evidence across an append and a persisted cache", async () => {
    const file = writeClaude(sharedFolder, "s-grow", {
      cwd: join(mono, "devtools"),
      tools: [fileCall("Read", join(mono, "devtools", "a.ts")), fileCall("Read", join(mono, "devtools", "b.ts"))],
    });
    const cacheFile = join(base, "cache", "usage.json");
    const first = new UsageCache({ file: cacheFile });
    const before = await scan(["a", "d", "w"], { cache: first });
    await first.save();
    expect(before.group.unallocated.conversations).toBe(1);

    appendFileSync(
      file,
      `${claudeLines("s-grow", { cwd: join(mono, "devtools"), tools: [fileCall("Edit", join(mono, "devtools", "c.ts"))] }).join("\n")}\n`,
    );
    const second = new UsageCache({ file: cacheFile });
    await second.load();
    const after = await scan(["a", "d", "w"], { cache: second });

    expect(after.report.cache).toMatchObject({ appended: 1, parsed: 0 });
    expect(allocatedOf(after.group, "d")).toMatchObject({
      conversations: 1,
      byBasis: { filePaths: 1, cwd: 0, projectRoot: 0 },
    });
    expect(after.group.unallocated.conversations).toBe(0);
    expect(JSON.parse(readFileSync(cacheFile, "utf8")).entries[file].evidence).toBe(true);
  });

  it("reads a cached file again when it becomes a shared source", async () => {
    writeClaude(sharedFolder, "s-late", { tools: [wiCall(join(mono, "devdocs"))] });
    const cache = new UsageCache();
    const plain = await summarizeFiles([sharedFolder], { cache, now: NOW });
    expect(plain.cache.parsed).toBe(1);

    const { report, group } = await scan(["a", "d", "w"], { cache });

    expect(report.cache.parsed).toBe(1);
    expect(allocatedOf(group, "w").byBasis.projectRoot).toBe(1);
  });
});

describe("what leaves the scan", () => {
  it("never puts a path, folder name or tool input in the report or the texts", async () => {
    writeClaude(sharedFolder, "s-1", {
      cwd: join(mono, "devtools"),
      tools: [wiCall(join(mono, "devtools")), fileCall("Read", join(mono, "devtools", "secret-name.ts"))],
    });
    writeClaude(sharedFolder, "s-2", {});
    const { report } = await scan(["a", "d", "w"]);
    const names = { a: NAMES.a, d: NAMES.d, w: NAMES.w };

    const text = [
      JSON.stringify(report),
      formatForAgent(report, { projectNames: Object.values(names), projectNamesById: names, locale: "en" }),
      formatForAgent(report, { projectNames: Object.values(names), projectNamesById: names, locale: "zh-TW" }),
      formatTable(report),
    ].join("\n");

    for (const secret of [base, "mono-repo", encodeClaudeProjectDir(mono), "secret-name", CANARY, "claude-worktrees"]) {
      expect(text).not.toContain(secret);
    }
    const english = formatForAgent(report, { projectNames: Object.values(names), projectNamesById: names });
    expect(english).toContain("assistant, devtools, devdocs - shared (unallocated): 1 conversations");
    expect(english).toContain("devtools: 1 conversations");
    expect(english).toContain("projectRoot 1");
    expect(formatForAgent(report, { projectNamesById: names, locale: "zh-TW" })).toContain("共用（未分配）");
  });
});
