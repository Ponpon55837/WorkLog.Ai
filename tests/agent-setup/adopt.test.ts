import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyAgentSetupPlan,
  commandForAgentHook,
  createAgentSetupPlan,
  findCheckoutRegistrations,
  inspectAgentRegistrations,
  type AgentSetupPlanOptions,
} from "@work-intelligence/agent-setup";
import { createFixture, readJson, removeFixtures, writeJson, type SetupFixture } from "./fixture.js";

// smol-toml is a dependency of the package under test only, so resolve it from there.
const packageRequire = createRequire(
  fileURLToPath(new URL("../../packages/agent-setup/package.json", import.meta.url)),
);
const parseToml = (packageRequire("smol-toml") as { parse: (text: string) => unknown }).parse;

const SHIM = "/opt/Work Intelligence/bin/work-intelligence-launcher";
const WINDOWS_SHIM = "C:\\Users\\測試 使用者\\AppData\\Local\\Work Intelligence\\bin\\work-intelligence-launcher.cmd";
const WINDOWS_ROOT = "C:\\Users\\測試 使用者\\My Repo's";
const PLATFORM: NodeJS.Platform = process.platform === "win32" ? "win32" : "linux";
const HOST_SHIM = PLATFORM === "win32" ? WINDOWS_SHIM : SHIM;
const TOML_START = "# >>> Work Intelligence setup:agents >>>";
const TOML_END = "# <<< Work Intelligence setup:agents <<<";

/** A fixture whose platform matches the host, because its checkout and home are real host paths. */
function hostFixture(): SetupFixture {
  const fixture = createFixture();
  fixture.options = { ...fixture.options, platform: PLATFORM };
  return fixture;
}

/** The hook command setup writes for a launcher action on the host platform. */
function shimHook(action: string): string {
  return PLATFORM === "win32" ? `"${HOST_SHIM}" ${action}` : `'${HOST_SHIM}' ${action}`;
}

function launcherOptions(
  fixture: SetupFixture,
  roots: string[] | undefined,
  overrides: Partial<AgentSetupPlanOptions> = {},
): AgentSetupPlanOptions {
  return {
    ...fixture.options,
    target: { kind: "launcher", shimPath: HOST_SHIM, skillSourcePath: fixture.paths.skillSource },
    ...(roots ? { adopt: { repositoryRoots: roots } } : {}),
    ...overrides,
  };
}

function windowsOptions(fixture: SetupFixture, roots: string[]): AgentSetupPlanOptions {
  return {
    ...fixture.options,
    platform: "win32",
    target: { kind: "launcher", shimPath: WINDOWS_SHIM, skillSourcePath: fixture.paths.skillSource },
    adopt: { repositoryRoots: roots },
  };
}

function script(root: string, name: string, separator = "/"): string {
  return [root, "apps", "mcp", "dist", name].join(separator);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
  return value as Record<string, unknown>;
}

function claudeServer(fixture: SetupFixture): Record<string, unknown> {
  return object(object(readJson(fixture.paths.claudeJson).mcpServers)["work-intelligence"]);
}

function hookItems(file: string, event: string): Record<string, unknown>[] {
  return object(readJson(file).hooks)[event] as Record<string, unknown>[];
}

function seedClaudeMcp(fixture: SetupFixture, entry: unknown): void {
  const current = readJson(fixture.paths.claudeJson);
  writeJson(fixture.paths.claudeJson, {
    ...current,
    mcpServers: { ...object(current.mcpServers), "work-intelligence": entry },
  });
}

function seedHooks(path: string, hooks: Record<string, unknown>): void {
  writeJson(path, { theme: "dark", hooks });
}

function seedToml(fixture: SetupFixture, text: string): void {
  mkdirSync(dirname(fixture.paths.codexConfig), { recursive: true });
  writeFileSync(fixture.paths.codexConfig, text);
}

function adoptAndApply(options: AgentSetupPlanOptions) {
  const plan = createAgentSetupPlan(options);
  expect(plan.conflicts).toEqual([]);
  expect(applyAgentSetupPlan(plan).applied).toBe(true);
  return plan;
}

function expectSettled(options: AgentSetupPlanOptions): void {
  const again = createAgentSetupPlan(options);
  expect(again.conflicts).toEqual([]);
  expect(again.mutations.map((mutation) => mutation.label)).toEqual([]);
  expect(inspectAgentRegistrations(options).duplicates).toEqual([]);
}

afterEach(removeFixtures);

describe("findCheckoutRegistrations", () => {
  it("lists hand-written MCP and hook registrations per Agent without needing a checkout", () => {
    const fixture = hostFixture();
    const root = fixture.options.repositoryRoot;
    seedClaudeMcp(fixture, {
      type: "stdio",
      command: "/usr/local/bin/node",
      args: [script(root, "launcher.js")],
      env: { WORK_INTELLIGENCE_DB: "data/custom.sqlite" },
    });
    seedHooks(fixture.paths.claudeSettings, {
      Stop: [
        { hooks: [{ type: "command", command: commandForAgentHook(script(root, "finalize-reminder.js"), PLATFORM) }] },
      ],
    });
    seedHooks(fixture.paths.codexHooks, {
      UserPromptSubmit: [
        {
          hooks: [
            { type: "command", command: commandForAgentHook(script(root, "codex-finalize-reminder.js"), PLATFORM) },
          ],
        },
      ],
    });
    seedToml(
      fixture,
      `[mcp_servers.work-intelligence]\ncommand = "node"\nargs = [${JSON.stringify(script(root, "index.js"))}]\n`,
    );

    const found = findCheckoutRegistrations({
      ...fixture.options,
      repositoryRoot: join(fixture.temporaryRoot, "none"),
    });

    expect(found.map((item) => `${item.agent}:${item.kind}:${item.componentId}`)).toEqual([
      "codex:mcp:codexMcp",
      "codex:hook:codexUserPromptSubmitHook",
      "claude-code:mcp:claudeMcp",
      "claude-code:hook:claudeStopHook",
    ]);
    for (const item of found) {
      expect(item).toMatchObject({ repositoryRoot: root, rootExists: true, owned: false, recognised: true });
    }
    const [codexMcp, , claudeMcp] = found;
    expect(codexMcp?.location).toBe(fixture.paths.codexConfig);
    expect(codexMcp?.effectiveDatabase).toBe(join(root, "data", "work-intelligence.sqlite"));
    expect(claudeMcp?.location).toBe(fixture.paths.claudeJson);
    expect(claudeMcp?.effectiveDatabase).toBe(join(root, "data", "custom.sqlite"));
  });

  it("marks setup-owned checkout entries as owned and reports a root that no longer exists", () => {
    const fixture = hostFixture();
    expect(applyAgentSetupPlan(createAgentSetupPlan(fixture.options)).applied).toBe(true);
    const owned = findCheckoutRegistrations(fixture.options);
    expect(owned.length).toBeGreaterThanOrEqual(4);
    expect(owned.every((item) => item.owned && item.recognised)).toBe(true);

    writeFileSync(fixture.paths.manifest, JSON.stringify({ version: 2, components: [] }));
    expect(findCheckoutRegistrations(fixture.options).every((item) => !item.owned)).toBe(true);

    const missing = join(fixture.temporaryRoot, "gone repo");
    seedClaudeMcp(fixture, { type: "stdio", command: "node", args: [script(missing, "launcher.js")] });
    const [gone] = findCheckoutRegistrations(fixture.options).filter((item) => item.componentId === "claudeMcp");
    expect(gone).toMatchObject({ repositoryRoot: missing, rootExists: false, recognised: true });
  });

  it.each([
    ["pnpm start", { command: "pnpm", args: ["--dir", "/x/repo", "start:mcp"] }, "node"],
    ["extra args", { command: "node", args: ["/x/repo/apps/mcp/dist/launcher.js", "--verbose"] }, "單一"],
    ["another script", { command: "node", args: ["/x/repo/apps/mcp/dist/other.js"] }, "apps/mcp/dist"],
    ["a relative script", { command: "node", args: ["apps/mcp/dist/launcher.js"] }, "絕對"],
    [
      "an in-memory database",
      { command: "node", args: ["/x/repo/apps/mcp/dist/index.js"], env: { WORK_INTELLIGENCE_DB: ":memory:" } },
      "WORK_INTELLIGENCE_DB",
    ],
  ])("does not recognise %s", (_name, entry, reason) => {
    const fixture = createFixture();
    seedClaudeMcp(fixture, entry);
    const [item] = findCheckoutRegistrations(fixture.options);
    expect(item).toMatchObject({ componentId: "claudeMcp", recognised: false });
    expect(item?.reason).toContain(reason);
  });

  it("does not recognise hooks with unknown scripts, quoting, event or duplicates", () => {
    const fixture = hostFixture();
    const root = fixture.options.repositoryRoot;
    const good = commandForAgentHook(script(root, "finalize-reminder.js"), PLATFORM);
    seedHooks(fixture.paths.claudeSettings, {
      Stop: [{ hooks: [{ type: "command", command: `${good} --flag` }] }],
      PreCompact: [{ hooks: [{ type: "command", command: `node ${script(root, "finalize-reminder.js")}` }] }],
      Notification: [{ hooks: [{ type: "command", command: good }] }],
      SessionStart: [
        { matcher: "compact", hooks: [{ type: "command", command: good }] },
        { hooks: [{ type: "command", command: good }] },
      ],
      PreToolUse: [
        {
          hooks: [
            { type: "command", command: commandForAgentHook(script(root, "codex-finalize-reminder.js"), PLATFORM) },
          ],
        },
      ],
    });
    const found = findCheckoutRegistrations(fixture.options);
    expect(found.length).toBe(6);
    expect(found.every((item) => !item.recognised && item.reason)).toBe(true);
    expect(found.find((item) => item.componentId === undefined)?.reason).toContain("Notification");
  });
});

describe("adopt option", () => {
  it("is a conflict without a launcher target, on install and uninstall", () => {
    const fixture = createFixture();
    const options = { ...fixture.options, adopt: { repositoryRoots: [fixture.options.repositoryRoot] } };
    expect(createAgentSetupPlan(options).conflicts.join(" ")).toContain("adopt-requires-launcher");
    expect(createAgentSetupPlan(options, "uninstall").conflicts.join(" ")).toContain("adopt-requires-launcher");
    expect(applyAgentSetupPlan(createAgentSetupPlan(options)).applied).toBe(false);
  });

  it("keeps refusing hand-written checkout registrations without it", () => {
    const fixture = hostFixture();
    seedClaudeMcp(fixture, {
      type: "stdio",
      command: "node",
      args: [script(fixture.options.repositoryRoot, "launcher.js")],
    });
    const plan = createAgentSetupPlan(launcherOptions(fixture, undefined));
    expect(plan.conflicts.length).toBeGreaterThan(0);
    expect(plan.adopted).toBeUndefined();
  });

  it("rewrites Claude JSON MCP and hooks in place, keeping every other field, and records ownership", () => {
    const fixture = hostFixture();
    const root = fixture.options.repositoryRoot;
    seedClaudeMcp(fixture, {
      type: "stdio",
      command: "/usr/local/bin/node",
      args: [script(root, "index.js")],
      env: { WORK_INTELLIGENCE_DB: "data/custom.sqlite", KEEP: "1" },
      timeout: 30,
    });
    seedHooks(fixture.paths.claudeSettings, {
      Stop: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: commandForAgentHook(script(root, "finalize-reminder.js"), PLATFORM),
              timeout: 5,
            },
          ],
        },
      ],
      Other: [{ hooks: [{ type: "command", command: "echo hi" }] }],
    });
    seedHooks(fixture.paths.codexHooks, {
      Stop: [
        {
          hooks: [
            { type: "command", command: commandForAgentHook(script(root, "codex-finalize-reminder.js"), PLATFORM) },
          ],
        },
      ],
    });
    const options = launcherOptions(fixture, [root]);

    const plan = adoptAndApply(options);

    const server = claudeServer(fixture);
    expect(Object.keys(server)).toEqual(["type", "command", "args", "env", "timeout"]);
    expect(server).toEqual({
      type: "stdio",
      command: HOST_SHIM,
      args: ["mcp"],
      env: { WORK_INTELLIGENCE_DB: join(root, "data", "custom.sqlite"), KEEP: "1" },
      timeout: 30,
    });
    expect(object(readJson(fixture.paths.claudeJson).mcpServers).existing).toBeDefined();
    const stop = hookItems(fixture.paths.claudeSettings, "Stop");
    expect(stop).toEqual([
      { matcher: "*", hooks: [{ type: "command", command: shimHook("claude-finalize-reminder"), timeout: 5 }] },
    ]);
    expect(hookItems(fixture.paths.claudeSettings, "Other")).toEqual([
      { hooks: [{ type: "command", command: "echo hi" }] },
    ]);
    expect(readJson(fixture.paths.claudeSettings).theme).toBe("dark");
    expect(hookItems(fixture.paths.codexHooks, "Stop")[0]).toEqual({
      hooks: [{ type: "command", command: shimHook("codex-finalize-reminder") }],
    });

    expect(plan.adopted?.map((item) => `${item.agent}:${item.componentId}`).sort()).toEqual([
      "claude-code:claudeMcp",
      "claude-code:claudeStopHook",
      "codex:codexStopHook",
    ]);
    expect(plan.adopted?.find((item) => item.componentId === "claudeMcp")).toMatchObject({
      repositoryRoot: root,
      effectiveDatabase: join(root, "data", "custom.sqlite"),
    });
    expect(plan.actions.join("\n")).toContain("相對路徑「data/custom.sqlite」");
    const manifest = readJson(fixture.paths.manifest);
    const adopted = (manifest.components as { id: string; adopted?: boolean }[]).filter((entry) => entry.adopted);
    expect(adopted.map((entry) => entry.id).sort()).toEqual(["claudeMcp", "claudeStopHook", "codexStopHook"]);
    expectSettled(options);
    expect(
      findCheckoutRegistrations(options).filter((item) => item.kind === "mcp" || item.componentId === "claudeStopHook"),
    ).toEqual([]);
  });

  it("rewrites a Codex TOML table without markers in place, wrapping it and keeping everything else", () => {
    const fixture = hostFixture();
    const root = fixture.options.repositoryRoot;
    const original = [
      "# prefs",
      'model = "fixture-model"',
      "",
      "[mcp_servers.other]",
      'command = "other"',
      "",
      "# my notes about the server",
      "[mcp_servers.work-intelligence]",
      'command = "node"   # the runtime',
      `args = [\n  ${JSON.stringify(script(root, "launcher.js"))}, # entry\n]`,
      "startup_timeout_sec = 30",
      "",
      "[mcp_servers.work-intelligence.env]",
      'WORK_INTELLIGENCE_DB = "data/mine.sqlite"',
      'EXTRA = "x"',
      "",
      "[features]",
      "foo = true",
      "",
    ].join("\n");
    seedToml(fixture, original);
    const options = launcherOptions(fixture, [root]);

    const plan = adoptAndApply(options);

    expect(readFileSync(fixture.paths.codexConfig, "utf8")).toBe(
      [
        "# prefs",
        'model = "fixture-model"',
        "",
        "[mcp_servers.other]",
        'command = "other"',
        "",
        "# my notes about the server",
        TOML_START,
        "[mcp_servers.work-intelligence]",
        `command = ${JSON.stringify(HOST_SHIM)}   # the runtime`,
        'args = ["mcp"]',
        "startup_timeout_sec = 30",
        "",
        "[mcp_servers.work-intelligence.env]",
        `WORK_INTELLIGENCE_DB = ${JSON.stringify(join(root, "data", "mine.sqlite"))}`,
        'EXTRA = "x"',
        TOML_END,
        "",
        "[features]",
        "foo = true",
        "",
      ].join("\n"),
    );
    expect(plan.adopted?.[0]).toMatchObject({
      componentId: "codexMcp",
      effectiveDatabase: join(root, "data", "mine.sqlite"),
    });
    expectSettled(options);
    // Uninstall takes the env sub-table with the block: no work-intelligence key is left, and the file still parses.
    const removal = createAgentSetupPlan(fixture.options, "uninstall");
    expect(removal.conflicts).toEqual([]);
    expect(applyAgentSetupPlan(removal).applied).toBe(true);
    const remaining = readFileSync(fixture.paths.codexConfig, "utf8");
    expect(remaining).not.toContain("work-intelligence");
    expect(remaining).not.toContain("EXTRA");
    expect(parseToml(remaining)).toEqual({
      model: "fixture-model",
      mcp_servers: { other: { command: "other" } },
      features: { foo: true },
    });
  });

  it("keeps the manifest entry of an adopted block that covers its env sub-table", () => {
    const fixture = hostFixture();
    const root = fixture.options.repositoryRoot;
    seedToml(
      fixture,
      [
        "[mcp_servers.work-intelligence]",
        'command = "node"',
        `args = [${JSON.stringify(script(root, "launcher.js"))}]`,
        "[mcp_servers.work-intelligence.env]",
        'WORK_INTELLIGENCE_DB = "data/mine.sqlite"',
        "",
      ].join("\n"),
    );
    const options = launcherOptions(fixture, [root]);
    adoptAndApply(options);
    const owned = (
      readJson(fixture.paths.manifest).components as { id: string; expected: string; adopted?: boolean }[]
    ).find((entry) => entry.id === "codexMcp");
    expect(owned).toMatchObject({ id: "codexMcp", adopted: true });
    expect(owned?.expected.startsWith(TOML_START)).toBe(true);
    expect(owned?.expected.trimEnd().endsWith(TOML_END)).toBe(true);
    expect(owned?.expected).toContain("[mcp_servers.work-intelligence.env]");
  });

  it("keeps CRLF line endings and extra keys when the table already carries the setup block markers", () => {
    const fixture = hostFixture();
    const root = join(fixture.temporaryRoot, "plain root");
    const original = [
      "# prefs",
      TOML_START,
      "[mcp_servers.work-intelligence]",
      'command = "node"',
      `args = ['${script(root, "launcher.js")}']`,
      'env = { WORK_INTELLIGENCE_DB = "rel/db.sqlite", KEEP = "1" }',
      "# custom comment",
      TOML_END,
      "[features]",
      "foo = true",
      "",
    ].join("\r\n");
    seedToml(fixture, original);
    const options = launcherOptions(fixture, [root]);

    adoptAndApply(options);

    const text = readFileSync(fixture.paths.codexConfig, "utf8");
    expect(text).toBe(
      [
        "# prefs",
        TOML_START,
        "[mcp_servers.work-intelligence]",
        `command = ${JSON.stringify(HOST_SHIM)}`,
        'args = ["mcp"]',
        `env = { WORK_INTELLIGENCE_DB = ${JSON.stringify(join(root, "rel/db.sqlite"))}, KEEP = "1" }`,
        "# custom comment",
        TOML_END,
        "[features]",
        "foo = true",
        "",
      ].join("\r\n"),
    );
    expect(text.replaceAll("\r\n", "")).not.toContain("\n");
    expectSettled(options);
  });

  it("wraps a table at the end of a file without a trailing newline using the file's line endings", () => {
    const fixture = hostFixture();
    const root = fixture.options.repositoryRoot;
    seedToml(
      fixture,
      `[mcp_servers.work-intelligence]\r\ncommand = "node"\r\nargs = [${JSON.stringify(script(root, "launcher.js"))}]`,
    );
    adoptAndApply(launcherOptions(fixture, [root]));
    expect(readFileSync(fixture.paths.codexConfig, "utf8")).toBe(
      `${TOML_START}\r\n[mcp_servers.work-intelligence]\r\ncommand = ${JSON.stringify(HOST_SHIM)}\r\nargs = ["mcp"]\r\nenv = { WORK_INTELLIGENCE_DB = ${JSON.stringify(join(root, "data", "work-intelligence.sqlite"))} }\r\n${TOML_END}\r\n`,
    );
  });

  it("adopts Windows drive paths with spaces and non-ASCII, resolving a relative database with Windows rules", () => {
    const fixture = createFixture();
    const options = windowsOptions(fixture, ["c:/users/測試 使用者/my repo's/"]);
    const backslash = (name: string) => script(WINDOWS_ROOT, name, "\\");
    seedClaudeMcp(fixture, {
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: [backslash("launcher.js")],
      env: { WORK_INTELLIGENCE_DB: "data\\mine.sqlite" },
    });
    seedHooks(fixture.paths.claudeSettings, {
      Stop: [
        { hooks: [{ type: "command", command: commandForAgentHook(backslash("finalize-reminder.js"), "win32") }] },
      ],
    });
    seedHooks(fixture.paths.codexHooks, {
      Stop: [
        {
          hooks: [{ type: "command", command: commandForAgentHook(backslash("codex-finalize-reminder.js"), "win32") }],
        },
      ],
    });
    seedToml(
      fixture,
      `[mcp_servers.work-intelligence]\ncommand = "node.exe"\nargs = [${JSON.stringify(backslash("index.js"))}]\n`,
    );

    const plan = adoptAndApply(options);

    expect(claudeServer(fixture)).toEqual({
      command: WINDOWS_SHIM,
      args: ["mcp"],
      env: { WORK_INTELLIGENCE_DB: `${WINDOWS_ROOT}\\data\\mine.sqlite` },
    });
    expect(hookItems(fixture.paths.claudeSettings, "Stop")[0]).toEqual({
      hooks: [{ type: "command", command: `"${WINDOWS_SHIM}" claude-finalize-reminder` }],
    });
    expect(hookItems(fixture.paths.codexHooks, "Stop")[0]).toEqual({
      hooks: [{ type: "command", command: `"${WINDOWS_SHIM}" codex-finalize-reminder` }],
    });
    expect(readFileSync(fixture.paths.codexConfig, "utf8")).toContain(`command = ${JSON.stringify(WINDOWS_SHIM)}`);
    expect(plan.adopted?.every((item) => item.repositoryRoot === WINDOWS_ROOT)).toBe(true);
    expect(plan.adopted?.find((item) => item.componentId === "codexMcp")?.effectiveDatabase).toBe(
      `${WINDOWS_ROOT}\\data\\work-intelligence.sqlite`,
    );
    expectSettled(options);
  });

  it("adopts an entry whose checkout root is missing, and reports the missing root while finding it", () => {
    const fixture = hostFixture();
    const gone = join(fixture.temporaryRoot, "moved away");
    seedClaudeMcp(fixture, { type: "stdio", command: "node", args: [script(gone, "launcher.js")] });
    const [found] = findCheckoutRegistrations(fixture.options);
    expect(found).toMatchObject({ rootExists: false, recognised: true, repositoryRoot: gone });
    const options = launcherOptions(fixture, [gone]);
    const plan = adoptAndApply(options);
    expect(claudeServer(fixture)).toMatchObject({ command: HOST_SHIM, args: ["mcp"] });
    expect(plan.adopted?.[0]?.repositoryRoot).toBe(gone);
  });

  it("never touches unrecognised or unlisted entries and reports each as a conflict", () => {
    const fixture = hostFixture();
    const root = fixture.options.repositoryRoot;
    const other = join(fixture.temporaryRoot, "other checkout");
    seedClaudeMcp(fixture, { type: "stdio", command: "pnpm", args: ["--dir", root, "start:mcp"] });
    seedHooks(fixture.paths.claudeSettings, {
      Stop: [
        { hooks: [{ type: "command", command: commandForAgentHook(script(other, "finalize-reminder.js"), PLATFORM) }] },
      ],
    });
    seedToml(
      fixture,
      `mcp_servers.work-intelligence = { command = "node", args = [${JSON.stringify(script(root, "launcher.js"))}] }\n`,
    );
    const claudeBefore = readFileSync(fixture.paths.claudeJson);
    const settingsBefore = readFileSync(fixture.paths.claudeSettings);
    const tomlBefore = readFileSync(fixture.paths.codexConfig);

    const plan = createAgentSetupPlan(launcherOptions(fixture, [root]));

    const conflicts = plan.conflicts.join("\n");
    expect(conflicts).toContain("無法安全改寫");
    expect(conflicts).toContain("不在改由桌面 App 管理的清單內");
    expect(plan.adopted).toEqual([]);
    expect(applyAgentSetupPlan(plan).applied).toBe(false);
    expect(readFileSync(fixture.paths.claudeJson)).toEqual(claudeBefore);
    expect(readFileSync(fixture.paths.claudeSettings)).toEqual(settingsBefore);
    expect(readFileSync(fixture.paths.codexConfig)).toEqual(tomlBefore);
  });

  it("leaves an Agent whose plugin is enabled untouched", () => {
    const fixture = hostFixture();
    const root = fixture.options.repositoryRoot;
    seedClaudeMcp(fixture, { type: "stdio", command: "node", args: [script(root, "launcher.js")] });
    writeJson(fixture.paths.claudeSettings, {
      enabledPlugins: { "work-intelligence@fixture": true },
      hooks: {
        Stop: [
          {
            hooks: [{ type: "command", command: commandForAgentHook(script(root, "finalize-reminder.js"), PLATFORM) }],
          },
        ],
      },
    });
    seedToml(
      fixture,
      `[plugins."work-intelligence@fixture"]\nenabled = true\n\n[mcp_servers.work-intelligence]\ncommand = "node"\nargs = [${JSON.stringify(script(root, "launcher.js"))}]\n`,
    );
    const claudeBefore = readFileSync(fixture.paths.claudeJson);
    const settingsBefore = readFileSync(fixture.paths.claudeSettings);
    const tomlBefore = readFileSync(fixture.paths.codexConfig);

    const plan = createAgentSetupPlan(launcherOptions(fixture, [root]));

    expect(plan.conflicts).toEqual([]);
    expect(plan.adopted).toEqual([]);
    expect(plan.mutations.map((mutation) => mutation.path)).not.toContain(fixture.paths.claudeJson);
    expect(plan.mutations.map((mutation) => mutation.path)).not.toContain(fixture.paths.claudeSettings);
    expect(plan.mutations.map((mutation) => mutation.path)).not.toContain(fixture.paths.codexConfig);
    expect(applyAgentSetupPlan(plan).applied).toBe(true);
    expect(readFileSync(fixture.paths.claudeJson)).toEqual(claudeBefore);
    expect(readFileSync(fixture.paths.claudeSettings)).toEqual(settingsBefore);
    expect(readFileSync(fixture.paths.codexConfig)).toEqual(tomlBefore);
  });

  it("treats the adopted entries as desktop-managed: uninstall removes them and the manifest", () => {
    const fixture = hostFixture();
    const root = fixture.options.repositoryRoot;
    seedClaudeMcp(fixture, {
      type: "stdio",
      command: "node",
      args: [script(root, "launcher.js")],
      env: { KEEP: "1" },
    });
    seedHooks(fixture.paths.claudeSettings, {
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: commandForAgentHook(script(root, "finalize-reminder.js"), PLATFORM),
              timeout: 3,
            },
          ],
        },
      ],
    });
    seedToml(
      fixture,
      `# top\n[mcp_servers.work-intelligence]\ncommand = "node"\nargs = [${JSON.stringify(script(root, "launcher.js"))}]\nenv = { KEEP = "1" }\n`,
    );
    const options = launcherOptions(fixture, [root]);
    adoptAndApply(options);
    const inspection = inspectAgentRegistrations(options);
    expect(inspection.registrations.every((item) => item.source === "desktop-managed")).toBe(true);

    const removal = createAgentSetupPlan(fixture.options, "uninstall");
    expect(removal.conflicts).toEqual([]);
    expect(applyAgentSetupPlan(removal).applied).toBe(true);

    expect(object(readJson(fixture.paths.claudeJson).mcpServers)["work-intelligence"]).toBeUndefined();
    expect(object(readJson(fixture.paths.claudeJson).mcpServers).existing).toBeDefined();
    expect(hookItems(fixture.paths.claudeSettings, "Stop")).toEqual([]);
    expect(readFileSync(fixture.paths.codexConfig, "utf8")).toBe("# top\n");
    expect(existsSync(fixture.paths.manifest)).toBe(false);
  });

  it("adopts only its own hook out of a group with sibling hooks, and uninstall keeps the siblings", () => {
    const fixture = hostFixture();
    const root = fixture.options.repositoryRoot;
    const sibling = { type: "command", command: "my-notify.sh", timeout: 5 };
    const lone = { type: "command", command: commandForAgentHook(script(root, "finalize-reminder.js"), PLATFORM) };
    seedHooks(fixture.paths.claudeSettings, {
      Stop: [
        { matcher: "", hooks: [lone, sibling] },
        { matcher: "other", hooks: [sibling] },
      ],
    });
    const options = launcherOptions(fixture, [root]);
    adoptAndApply(options);
    expect(hookItems(fixture.paths.claudeSettings, "Stop")[0]).toEqual({
      matcher: "",
      hooks: [{ type: "command", command: shimHook("claude-finalize-reminder") }, sibling],
    });
    expectSettled(options);

    const removal = createAgentSetupPlan(fixture.options, "uninstall");
    expect(removal.conflicts).toEqual([]);
    expect(applyAgentSetupPlan(removal).applied).toBe(true);

    expect(hookItems(fixture.paths.claudeSettings, "Stop")).toEqual([
      { matcher: "", hooks: [sibling] },
      { matcher: "other", hooks: [sibling] },
    ]);
    expect(existsSync(fixture.paths.manifest)).toBe(false);
  });

  describe("an entry without WORK_INTELLIGENCE_DB keeps using its checkout database", () => {
    /** What the launcher would use: an explicit variable always wins over the App's own database. */
    const resolvedDatabase = (env: unknown): string => {
      const value = env && typeof env === "object" ? (env as Record<string, unknown>).WORK_INTELLIGENCE_DB : undefined;
      return typeof value === "string" ? value : "APP-DATABASE";
    };
    const tomlEnv = (fixture: SetupFixture): unknown => {
      const parsed = parseToml(readFileSync(fixture.paths.codexConfig, "utf8")) as {
        mcp_servers: Record<string, { env?: unknown }>;
      };
      return parsed.mcp_servers["work-intelligence"]?.env;
    };

    // One adoption per case, so each case has its own time budget on a slow runner.
    it.each([
      ["no env", undefined],
      ["an env without it", { KEEP: "1" }],
    ] as const)("writes the checkout database into a Claude entry with %s", (_name, env) => {
      const fixture = hostFixture();
      const root = fixture.options.repositoryRoot;
      const expected = join(root, "data", "work-intelligence.sqlite");
      seedClaudeMcp(fixture, {
        type: "stdio",
        command: "node",
        args: [script(root, "launcher.js")],
        ...(env ? { env } : {}),
      });
      const plan = adoptAndApply(launcherOptions(fixture, [root]));
      expect(resolvedDatabase(claudeServer(fixture).env)).toBe(expected);
      expect(plan.adopted?.[0]?.effectiveDatabase).toBe(expected);
      expect(plan.actions.join("\n")).toContain(expected);
      if (env) expect(object(claudeServer(fixture).env).KEEP).toBe("1");
    });

    it.each([
      ["none", ""],
      ["own table", '[mcp_servers.work-intelligence.env]\nKEEP = "1"\n'],
      ["inline", 'env = { KEEP = "1" }\n'],
      ["empty inline", "env = {}\n"],
      ["dotted", 'env.KEEP = "1"\n'],
    ] as const)(
      "writes the checkout database into a Codex table whose env shape is %s, and uninstall leaves no trace",
      (name, extra) => {
        const fixture = hostFixture();
        const root = fixture.options.repositoryRoot;
        const expected = join(root, "data", "work-intelligence.sqlite");
        const head = `[mcp_servers.work-intelligence]\ncommand = "node"\nargs = [${JSON.stringify(script(root, "launcher.js"))}]\n`;
        seedToml(fixture, name === "own table" ? `${head}${extra}` : `${head}${extra}\n[features]\nfoo = true\n`);
        const plan = adoptAndApply(launcherOptions(fixture, [root]));
        expect(resolvedDatabase(tomlEnv(fixture)), name).toBe(expected);
        expect(plan.adopted?.[0]?.effectiveDatabase, name).toBe(expected);
        if (extra && name !== "empty inline") expect(object(tomlEnv(fixture)).KEEP, name).toBe("1");
        const removal = createAgentSetupPlan(fixture.options, "uninstall");
        expect(removal.conflicts).toEqual([]);
        expect(applyAgentSetupPlan(removal).applied).toBe(true);
        expect(readFileSync(fixture.paths.codexConfig, "utf8"), name).not.toContain("work-intelligence");
      },
    );
  });

  it("migrates setup-owned checkout entries as before while adopting a hand-written one beside them", () => {
    const fixture = hostFixture();
    expect(applyAgentSetupPlan(createAgentSetupPlan(fixture.options)).applied).toBe(true);
    const root = fixture.options.repositoryRoot;
    const current = readJson(fixture.paths.claudeJson);
    const servers = object(current.mcpServers);
    writeJson(fixture.paths.claudeJson, {
      ...current,
      mcpServers: {
        ...servers,
        "work-intelligence": { type: "stdio", command: "node", args: [script(root, "launcher.js")], env: { A: "1" } },
      },
    });
    const options = launcherOptions(fixture, [root]);
    adoptAndApply(options);
    expect(claudeServer(fixture)).toMatchObject({ command: HOST_SHIM, env: { A: "1" } });
    expect(hookItems(fixture.paths.claudeSettings, "Stop")).toHaveLength(1);
    expectSettled(options);
  });
});
