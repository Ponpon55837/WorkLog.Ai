import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  UsageScanAbortedError,
  UsageScanTimeoutError,
  encodeClaudeProjectDir,
} from "../../packages/shared/src/agent-usage/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { runDatabaseCli, type DatabaseCliDependencies } from "../../apps/server/src/cli.js";
import { createApiHandler } from "../../apps/server/src/server.js";
import {
  InlineUsageOperations,
  type UsageOperations,
  type UsageScanContext,
} from "../../apps/server/src/usage-scan.js";
import { UsageWorkerClient } from "../../apps/server/src/usage-worker-client.js";

const CANARY = "FICTIONAL-CANARY-TEXT-98765";
const FAKE_CWD = "/home/fictional/elsewhere";
const SESSION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const roots: string[] = [];
const servers: Server[] = [];
const stores: WorkIntelligenceStore[] = [];

interface Fixture {
  home: string;
  projectRoot: string;
  claudeFolder: string;
  context: UsageScanContext;
  store: WorkIntelligenceStore;
  projectId: string;
}

function createFixture(): Fixture {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "usage-home-")));
  roots.push(home);
  const projectRoot = join(home, "work", "demo-app");
  mkdirSync(projectRoot, { recursive: true });
  const claudeProjectsDir = join(home, ".claude", "projects");
  const claudeFolder = join(claudeProjectsDir, encodeClaudeProjectDir(projectRoot));
  mkdirSync(claudeFolder, { recursive: true });
  const now = Date.now();
  const stamp = (offsetSeconds: number): string => new Date(now - 60_000 + offsetSeconds * 1000).toISOString();
  const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 };
  const lines = [
    {
      type: "user",
      sessionId: SESSION_ID,
      timestamp: stamp(0),
      cwd: FAKE_CWD,
      message: { role: "user", content: CANARY },
    },
    {
      type: "assistant",
      sessionId: SESSION_ID,
      timestamp: stamp(1),
      cwd: FAKE_CWD,
      gitBranch: "fictional-branch",
      message: {
        id: "msg_1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "mcp__wi__work_read",
            input: { operation: "work_search_memory", note: CANARY },
          },
          { type: "tool_use", id: "tu_2", name: "Read", input: { file_path: `${FAKE_CWD}/a.ts` } },
        ],
        usage,
      },
    },
    {
      type: "user",
      sessionId: SESSION_ID,
      timestamp: stamp(2),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "x".repeat(40) }] },
    },
  ];
  writeFileSync(join(claudeFolder, `${SESSION_ID}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Demo app", projectRoot);
  store.updateProject(project.id, { status: "tracked" });
  return {
    home,
    projectRoot,
    claudeFolder,
    context: { dirs: { claudeProjectsDir, codexSessionsDir: join(home, ".codex", "sessions") } },
    store,
    projectId: project.id,
  };
}

interface MonorepoFixture {
  home: string;
  mono: string;
  context: UsageScanContext;
  store: WorkIntelligenceStore;
  ids: { assistant: string; devtools: string; devdocs: string };
}

/** Three tracked subfolders of one monorepo; every session was opened at the monorepo root. */
function createMonorepoFixture(): MonorepoFixture {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "usage-mono-")));
  roots.push(home);
  const mono = join(home, "work", "mono-repo");
  const claudeProjectsDir = join(home, ".claude", "projects");
  const folder = join(claudeProjectsDir, encodeClaudeProjectDir(mono));
  mkdirSync(folder, { recursive: true });
  const stamp = new Date(Date.now() - 60_000).toISOString();
  const session = (id: string, input: number, tool: unknown): void => {
    const lines = [
      {
        type: "assistant",
        sessionId: id,
        timestamp: stamp,
        cwd: mono,
        message: {
          id: `msg_${id}`,
          role: "assistant",
          content: tool ? [{ type: "tool_use", id: `tu_${id}`, name: "mcp__wi__work_read", input: tool }] : [],
          usage: { input_tokens: input, output_tokens: 1 },
        },
      },
    ];
    writeFileSync(join(folder, `${id}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  };
  const named = (root: string) => ({ operation: "work_get_context", arguments: { projectRoot: root } });
  session("s-tools", 100, named(join(mono, "devtools")));
  session("s-assistant", 10, named(join(mono, "assistant")));
  session("s-nothing", 1000, undefined);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const add = (name: string): string => {
    mkdirSync(join(mono, name), { recursive: true });
    const project = store.addProject(name, join(mono, name));
    store.updateProject(project.id, { status: "tracked" });
    return project.id;
  };
  const ids = { assistant: add("assistant"), devtools: add("devtools"), devdocs: add("devdocs") };
  return {
    home,
    mono,
    context: { dirs: { claudeProjectsDir, codexSessionsDir: join(home, ".codex", "sessions") } },
    store,
    ids,
  };
}

async function listen(store: WorkIntelligenceStore, usage: UsageOperations): Promise<string> {
  const server = createServer(createApiHandler(store, { usage }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return `http://127.0.0.1:${address.port}`;
}

function post(
  base: string,
  body: unknown,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${base}/api/usage/scan`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("GET /api/usage/projects", () => {
  it("lists tracked projects with the detected source counts", async () => {
    const fixture = createFixture();
    const untracked = fixture.store.addProject("Paused app", join(fixture.home, "work", "paused"));
    fixture.store.updateProject(untracked.id, { status: "paused" });
    const base = await listen(fixture.store, new InlineUsageOperations(fixture.context));

    const response = await fetch(`${base}/api/usage/projects`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items).toEqual([
      { id: fixture.projectId, name: "Demo app", current: false, sources: { claudeFolders: 1, codexFiles: 0 } },
    ]);
    const text = JSON.stringify(body);
    expect(text).not.toContain(fixture.home);
    expect(text).not.toContain(encodeClaudeProjectDir(fixture.projectRoot));
  });

  it("explains a missing log directory with a problem code", async () => {
    const fixture = createFixture();
    const base = await listen(
      fixture.store,
      new InlineUsageOperations({
        dirs: { claudeProjectsDir: join(fixture.home, "none"), codexSessionsDir: join(fixture.home, "none2") },
      }),
    );

    const body = (await (await fetch(`${base}/api/usage/projects`)).json()) as {
      items: Array<Record<string, unknown>>;
    };

    expect(body.items[0]).toMatchObject({
      sources: { claudeFolders: 0, codexFiles: 0 },
      problem: "claude-dir-missing",
    });
  });
});

describe("POST /api/usage/scan", () => {
  it("answers with counts only, including the Work Intelligence operations", async () => {
    const fixture = createFixture();
    const base = await listen(fixture.store, new InlineUsageOperations(fixture.context));

    const response = await post(base, { projectIds: [fixture.projectId], range: "7d" });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.totals).toMatchObject({
      sessions: 1,
      turns: 1,
      toolCalls: 2,
      workIntelligenceCalls: 1,
      workIntelligenceShare: 0.5,
    });
    expect(body.tokens).toEqual({
      input: 10,
      output: 20,
      cacheRead: 100,
      cacheCreation: 5,
      primary: 30,
      cacheReadShare: 100 / 115,
    });
    expect(body.operations).toEqual([{ key: "work_read/work_search_memory", calls: 1, resultChars: 40, avgChars: 40 }]);
    expect(body.otherTools).toEqual([{ name: "Read", calls: 1 }]);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].label).toBe("session-1");
    expect(body.sessions[0].primary).toBe(30);
    expect(body.models).toEqual([
      {
        agent: "claude-code",
        model: "",
        tokens: { input: 10, output: 20, cacheRead: 100, cacheCreation: 5 },
        primary: 30,
        responses: 1,
      },
    ]);
    expect(body.daily).toHaveLength(1);
    expect(body.blocks).toEqual(expect.any(Array));
    for (const removed of ["costShares", "costMultipliers", "estimatedCostUnits"]) {
      expect(JSON.stringify(body)).not.toContain(removed);
    }
    expect(body.cache).toEqual({ reused: 0, appended: 0, parsed: 1 });
    expect(body.forAgentText).toContain("work_read/work_search_memory");
    expect(body.forAgentText).toContain("Demo app");
    expect(body.range.since).toEqual(expect.any(String));
    expect(body.problems).toEqual([]);
  });

  it("returns the active block only while the range reaches the present", async () => {
    const fixture = createFixture();
    const base = await listen(fixture.store, new InlineUsageOperations(fixture.context));

    const open = (await (await post(base, { all: true, range: "7d" })).json()) as Record<string, any>;
    expect(open.blocks).toHaveLength(1);
    expect(open.blocks[0]).toMatchObject({ agent: "claude-code", primary: 30, tokens: { cacheRead: 100 } });
    expect(open.blocks[0].remainingMs).toBeGreaterThan(0);

    const past = (await (
      await post(base, {
        all: true,
        range: "custom",
        since: new Date(Date.now() - 3_600_000).toISOString(),
        until: new Date(Date.now() - 1000).toISOString(),
      })
    ).json()) as Record<string, any>;
    expect(past.blocks).toEqual([]);
    expect(past.tokens.primary).toBe(30);
  });

  it("reuses the cache on a second scan with the same file", async () => {
    const fixture = createFixture();
    const cacheFile = join(fixture.home, "cache", "agent-usage-cache.json");
    const base = await listen(fixture.store, new InlineUsageOperations({ ...fixture.context, cacheFile }));

    await post(base, { all: true, range: "30d" });
    const second = (await (await post(base, { all: true, range: "30d" })).json()) as { cache: unknown };

    expect(second.cache).toEqual({ reused: 1, appended: 0, parsed: 0 });
  });

  it("never returns a path, folder name, cwd, branch or message text", async () => {
    const fixture = createFixture();
    const manual = join(fixture.home, "manual-logs");
    mkdirSync(manual);
    writeFileSync(
      join(manual, "x.jsonl"),
      `${JSON.stringify({ type: "user", sessionId: "s2", timestamp: new Date().toISOString(), cwd: FAKE_CWD, message: { role: "user", content: CANARY } })}\n`,
    );
    const base = await listen(fixture.store, new InlineUsageOperations(fixture.context));

    const response = await post(base, { all: true, manualFolders: [manual], range: "7d" });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text).totals.sessions).toBe(2);
    for (const secret of [
      fixture.home,
      "manual-logs",
      encodeClaudeProjectDir(fixture.projectRoot),
      FAKE_CWD,
      "fictional-branch",
      CANARY,
      SESSION_ID,
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("answers the Agent text in Traditional Chinese for a zh Accept-Language", async () => {
    const fixture = createFixture();
    const base = await listen(fixture.store, new InlineUsageOperations(fixture.context));

    const body = (await (
      await post(base, { all: true, range: "7d" }, { "accept-language": "zh-TW,zh;q=0.9" })
    ).json()) as { forAgentText: string };

    expect(body.forAgentText).toContain("用量報告");
  });

  it.each([
    ["an unknown field", { all: true, range: "7d", extra: 1 }],
    ["a missing range", { all: true }],
    ["a relative manual folder", { all: true, range: "7d", manualFolders: ["relative/dir"] }],
    [
      "too many manual folders",
      { all: true, range: "7d", manualFolders: Array.from({ length: 21 }, (_, i) => `/tmp/f${i}`) },
    ],
    ["nothing selected", { range: "7d" }],
    [
      "a reversed custom range",
      { all: true, range: "custom", since: "2026-02-01T00:00:00Z", until: "2026-01-01T00:00:00Z" },
    ],
  ])("rejects %s with 400", async (_name, body) => {
    const fixture = createFixture();
    const base = await listen(fixture.store, new InlineUsageOperations(fixture.context));

    const response = await post(base, body);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_input" });
  });

  it("skips untracked project ids quietly", async () => {
    const fixture = createFixture();
    const base = await listen(fixture.store, new InlineUsageOperations(fixture.context));

    expect((await post(base, { projectIds: ["no-such-project"], range: "7d" })).status).toBe(400);
  });

  it("maps a timeout to usage_timeout and other failures to a masked usage_failed", async () => {
    const fixture = createFixture();
    let failure: unknown = new UsageScanTimeoutError();
    const base = await listen(fixture.store, {
      sources: async () => ({ projects: [], groups: [] }),
      scan: async () => {
        throw failure;
      },
    });

    const timeout = await post(base, { all: true, range: "7d" });
    expect(timeout.status).toBe(504);
    expect(await timeout.json()).toMatchObject({ code: "usage_timeout" });

    failure = new Error(`EACCES: permission denied, open '${fixture.home}/secret'`);
    const failed = await post(base, { all: true, range: "7d" });
    const text = await failed.text();
    expect(failed.status).toBe(500);
    expect(JSON.parse(text)).toMatchObject({ code: "usage_failed" });
    expect(text).not.toContain(fixture.home);
  });

  it("aborts the scan when the client closes the request", async () => {
    const fixture = createFixture();
    let observed: AbortSignal | undefined;
    const started = new Promise<void>((resolve) => {
      void listen(fixture.store, {
        sources: async () => ({ projects: [], groups: [] }),
        scan: (_input, signal) => {
          observed = signal;
          resolve();
          return new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new UsageScanAbortedError()));
          });
        },
      }).then(async (base) => {
        const controller = new AbortController();
        const request = post(base, { all: true, range: "7d" }, {}, controller.signal).catch(() => undefined);
        await started;
        controller.abort();
        await request;
      });
    });

    await started;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(observed?.aborted).toBe(true);
  });
});

describe("shared monorepo sources", () => {
  const forbidden = (fixture: MonorepoFixture): string[] => [
    fixture.home,
    "mono-repo",
    encodeClaudeProjectDir(fixture.mono),
    "s-tools",
  ];

  it("lists the group of projects that share a folder without naming it", async () => {
    const fixture = createMonorepoFixture();
    const base = await listen(fixture.store, new InlineUsageOperations(fixture.context));

    const body = (await (await fetch(`${base}/api/usage/projects`)).json()) as {
      items: Array<{ id: string; problem?: string }>;
      groups: unknown[];
    };

    expect(body.groups).toEqual([
      { projects: expect.arrayContaining(Object.values(fixture.ids)), claudeFolders: 1, codexFiles: 0 },
    ]);
    expect(body.items.every((item) => item.problem === undefined)).toBe(true);
    for (const secret of forbidden(fixture)) expect(JSON.stringify(body)).not.toContain(secret);
  });

  it("credits a selected project with its own conversations and the whole group with the rest", async () => {
    const fixture = createMonorepoFixture();
    const base = await listen(fixture.store, new InlineUsageOperations(fixture.context));

    const subset = (await (await post(base, { projectIds: [fixture.ids.devtools], range: "7d" })).json()) as Record<
      string,
      any
    >;
    const whole = (await (await post(base, { projectIds: Object.values(fixture.ids), range: "7d" })).json()) as Record<
      string,
      any
    >;

    expect(subset.tokens.input).toBe(100);
    expect(subset.totals.sessions).toBe(1);
    expect(subset.allocation.groups[0].unallocated).toMatchObject({ included: false, conversations: 1, primary: 1001 });
    const devtools = subset.allocation.groups[0].allocated.find((item: any) => item.projectId === fixture.ids.devtools);
    expect(devtools).toMatchObject({
      included: true,
      conversations: 1,
      byBasis: { projectRoot: 1, filePaths: 0, cwd: 0 },
    });
    expect(whole.tokens.input).toBe(1110);
    expect(whole.allocation.groups[0].unallocated.included).toBe(true);
    for (const body of [subset, whole]) {
      for (const secret of forbidden(fixture)) expect(JSON.stringify(body)).not.toContain(secret);
    }
    expect(whole.forAgentText).toMatch(/(assistant|devtools|devdocs), .* - shared \(unallocated\): 1 conversations/);
    expect(subset.forAgentText).toContain("not in the totals above");
  });

  it("prints the allocation with --json and --for-agent and never a path", async () => {
    const fixture = createMonorepoFixture();
    const messages = { log: [] as string[], error: [] as string[] };
    const dependencies: DatabaseCliDependencies = {
      withStore: <T>(task: (store: WorkIntelligenceStore) => T) => task(fixture.store),
      log: (message) => messages.log.push(message),
      error: (message) => messages.error.push(message),
      invocationDirectory: tmpdir(),
      usage: fixture.context,
      usageLocale: "en",
    };

    expect(await runDatabaseCli(["usage", "--json", "--project", "devtools"], dependencies)).toBe(0);
    expect(await runDatabaseCli(["usage", "--for-agent", "--all"], dependencies)).toBe(0);

    const json = JSON.parse(messages.log[0] ?? "{}");
    expect(json.tokens.input).toBe(100);
    expect(json.allocation.groups[0].allocated).toHaveLength(3);
    const text = messages.log.join("\n");
    expect(messages.log[1]).toContain("shared (unallocated)");
    for (const secret of forbidden(fixture)) expect(text).not.toContain(secret);
  });
});

describe("UsageWorkerClient", () => {
  it("scans in a child process and answers like the in-process scanner", async () => {
    const fixture = createFixture();
    const client = new UsageWorkerClient(fixture.context);
    const input = {
      projects: [{ id: fixture.projectId, name: "Demo app", root: fixture.projectRoot }],
      manualFolders: [],
    };

    const found = await client.sources(input.projects);
    const outcome = await client.scan(input);

    expect(found.projects).toEqual([{ projectId: fixture.projectId, claudeFolders: 1, codexFiles: 0 }]);
    expect(found.groups).toEqual([]);
    expect(outcome.report.total.toolCalls).toBe(2);
  }, 30_000);

  it("kills a scan that runs past the timeout", async () => {
    const fixture = createFixture();
    const client = new UsageWorkerClient(fixture.context, { timeoutMs: 1 });

    await expect(client.scan({ projects: [], manualFolders: [fixture.home] })).rejects.toBeInstanceOf(
      UsageScanTimeoutError,
    );
  });

  it("cancels the running scan when a new one starts or the signal aborts", async () => {
    const fixture = createFixture();
    const client = new UsageWorkerClient(fixture.context);
    const input = { projects: [], manualFolders: [fixture.home] };

    const first = client.scan(input);
    const second = client.scan(input);
    await expect(first).rejects.toBeInstanceOf(UsageScanAbortedError);

    const controller = new AbortController();
    const third = client.scan(input, controller.signal);
    controller.abort();
    await expect(third).rejects.toBeInstanceOf(UsageScanAbortedError);
    // The third scan replaced the second one.
    await expect(second).rejects.toBeInstanceOf(UsageScanAbortedError);
  }, 30_000);
});

describe("db usage (pnpm usage:report)", () => {
  function setup(fixture: Fixture, invocationDirectory: string) {
    const messages = { log: [] as string[], error: [] as string[] };
    const dependencies: DatabaseCliDependencies = {
      withStore: <T>(task: (store: WorkIntelligenceStore) => T) => task(fixture.store),
      log: (message) => messages.log.push(message),
      error: (message) => messages.error.push(message),
      invocationDirectory,
      usage: fixture.context,
      usageLocale: "en",
    };
    return { messages, dependencies };
  }

  it("prints a plain-text report for an Agent for the project containing the current folder", async () => {
    const fixture = createFixture();
    const { messages, dependencies } = setup(fixture, join(fixture.projectRoot, "src"));

    expect(await runDatabaseCli(["usage", "--for-agent"], dependencies)).toBe(0);

    const output = messages.log.join("\n");
    expect(output).toContain("Agent usage report");
    expect(output).toContain("Demo app");
    expect(output).toContain("work_read/work_search_memory");
    for (const secret of [fixture.home, CANARY, FAKE_CWD, "fictional-branch"]) expect(output).not.toContain(secret);
  });

  it("prints the same JSON fields as the Dashboard with --json", async () => {
    const fixture = createFixture();
    const { messages, dependencies } = setup(fixture, tmpdir());

    expect(await runDatabaseCli(["usage", "--json", "--project", "Demo app"], dependencies)).toBe(0);

    const body = JSON.parse(messages.log.join("\n"));
    expect(body.totals.toolCalls).toBe(2);
    expect(body.operations[0].key).toBe("work_read/work_search_memory");
    expect(JSON.stringify(body)).not.toContain(fixture.home);
  });

  it("selects by root, scans all outside any project, and refuses unknown projects and options", async () => {
    const fixture = createFixture();
    const { messages, dependencies } = setup(fixture, tmpdir());

    expect(await runDatabaseCli(["usage", "--json", "--project", fixture.projectRoot], dependencies)).toBe(0);
    expect(await runDatabaseCli(["usage", "--json"], dependencies)).toBe(0);
    expect(await runDatabaseCli(["usage", "--project", "nope"], dependencies)).toBe(1);
    expect(await runDatabaseCli(["usage", "--since", "yesterday-ish"], dependencies)).toBe(2);
    expect(await runDatabaseCli(["usage", "--json", "--for-agent"], dependencies)).toBe(2);
    expect(messages.error.join("\n")).toContain("找不到記錄中的專案");
  });
});
