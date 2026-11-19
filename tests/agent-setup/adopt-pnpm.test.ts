import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyAgentSetupPlan,
  applyAgentSetupTransaction,
  commandForLauncherHook,
  inspectAgentRegistrations,
  createAgentSetupPlan,
  findCheckoutRegistrations,
  undoAgentSetupOperation,
  type AgentSetupPlanOptions,
} from "@work-intelligence/agent-setup";
import { createFixture, readJson, removeFixtures, writeJson, type SetupFixture } from "./fixture.js";

const packageRequire = createRequire(
  fileURLToPath(new URL("../../packages/agent-setup/package.json", import.meta.url)),
);
const parseToml = (packageRequire("smol-toml") as { parse: (text: string) => unknown }).parse;

const SHIM = "/opt/Work Intelligence/bin/work-intelligence-launcher";
const PLATFORM: NodeJS.Platform = process.platform === "win32" ? "win32" : "linux";
const WINDOWS_SHIM = "C:\\Users\\someone\\AppData\\Local\\Work Intelligence\\bin\\work-intelligence-launcher.cmd";

afterEach(removeFixtures);

function launcher(fixture: SetupFixture, overrides: Partial<AgentSetupPlanOptions> = {}): AgentSetupPlanOptions {
  return {
    ...fixture.options,
    target: { kind: "launcher", shimPath: SHIM, skillSourcePath: fixture.paths.skillSource },
    ...overrides,
  };
}

function touch(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "synthetic");
  return path;
}

/** The hand-written registration of the report (synthetic paths), with the other tables a real config carries. */
function codexConfig(root: string, database: string, extra = ""): string {
  return `# prefs
model = "fixture-model"

[mcp_servers.other-tool]
command = "npx"
args = ["-y", "other-tool"]
env_vars = ["OTHER_TOKEN"]

[mcp_servers.other-tool.env]
OTHER_MODE = "quiet"

[mcp_servers.work-intelligence]
command = "/Users/someone/Library/pnpm/bin/pnpm"
args = ["--dir", ${JSON.stringify(root)}, "start:mcp"]
enabled = true
${extra}
[mcp_servers.work-intelligence.env]
WORK_INTELLIGENCE_DB = ${JSON.stringify(database)}

[mcp_servers.second]
url = "https://example.invalid/mcp"

[hooks.state]
"work-intelligence@market:hooks.json:stop:0:0" = { trusted_hash = "sha256:synthetic" }
`;
}

function seed(fixture: SetupFixture, root: string, database: string, extra?: string): string {
  const text = codexConfig(root, database, extra);
  writeFileSync(fixture.paths.codexConfig, text);
  return text;
}

describe("adopting a hand-written pnpm start:mcp registration", () => {
  it("reproduces both conflicts without adopt, then adopts the Codex table and undoes completely", () => {
    const fixture = createFixture();
    const root = fixture.options.repositoryRoot;
    const database = touch(join(root, "data", "work-intelligence.sqlite"));
    const before = seed(fixture, root, database);
    writeJson(fixture.paths.claudeJson, {
      mcpServers: { "work-intelligence": { type: "stdio", command: "pnpm", args: ["--dir", root, "start:mcp"] } },
    });
    const claudeBefore = readFileSync(fixture.paths.claudeJson);

    const refused = createAgentSetupPlan(launcher(fixture));
    expect(refused.conflicts.join("\n")).toContain("未支援的 mcp_servers 結構");
    expect(refused.conflicts.join("\n")).toContain("已有不同設定");

    const found = findCheckoutRegistrations(fixture.options, { appDatabase: database });
    expect(found.filter((item) => item.kind === "mcp")).toMatchObject([
      { agent: "codex", recognised: true, repositoryRoot: root, sameAsAppDatabase: true },
      { agent: "claude-code", recognised: true, repositoryRoot: root, sameAsAppDatabase: true },
    ]);

    const plan = createAgentSetupPlan(
      launcher(fixture, { adopt: { repositoryRoots: [root], databasePath: database } }),
    );
    expect(plan.conflicts).toEqual([]);
    expect(applyAgentSetupTransaction(plan, { journalPath: fixture.paths.journal }).outcome).toBe("committed");

    const after = readFileSync(fixture.paths.codexConfig, "utf8");
    const parsed = parseToml(after) as Record<string, any>;
    expect(parsed.mcp_servers["work-intelligence"]).toEqual({
      command: SHIM,
      args: ["mcp"],
      enabled: true,
      env: { WORK_INTELLIGENCE_DB: database },
    });
    expect(parsed.mcp_servers["other-tool"]).toEqual({
      command: "npx",
      args: ["-y", "other-tool"],
      env_vars: ["OTHER_TOKEN"],
      env: { OTHER_MODE: "quiet" },
    });
    expect(parsed.hooks.state).toEqual({
      "work-intelligence@market:hooks.json:stop:0:0": { trusted_hash: "sha256:synthetic" },
    });
    expect(readJson(fixture.paths.claudeJson).mcpServers).toMatchObject({
      "work-intelligence": { type: "stdio", command: SHIM, args: ["mcp"] },
    });

    const undone = undoAgentSetupOperation(fixture.paths.journal, { homeDirectory: fixture.options.homeDirectory });
    expect(undone.status).toBe("undone");
    expect(readFileSync(fixture.paths.codexConfig, "utf8")).toBe(before);
    expect(readFileSync(fixture.paths.claudeJson)).toEqual(claudeBefore);
  });

  it.each([
    ["--dir", (root: string) => ({ command: "pnpm", args: ["--dir", root, "start:mcp"] })],
    ["-C", (root: string) => ({ command: "/usr/local/bin/pnpm", args: ["-C", root, "run", "start:mcp"] })],
    ["--dir=", (root: string) => ({ command: "pnpm", args: [`--dir=${root}`, "start:mcp"] })],
    ["cwd", (root: string) => ({ command: "pnpm", args: ["start:mcp"], cwd: root })],
    ["relative --dir with cwd", (root: string) => ({ command: "pnpm", args: ["--dir", "."], cwd: root })],
  ])("adopts the Claude %s form, keeps custom keys, and drops a cwd that only named the checkout", (name, build) => {
    const fixture = createFixture();
    const root = fixture.options.repositoryRoot;
    const database = touch(join(root, "data", "work-intelligence.sqlite"));
    const entry = { type: "stdio", ...build(root), env: { WORK_INTELLIGENCE_DB: database, KEEP: "1" }, note: "mine" };
    if (name === "relative --dir with cwd") entry.args = ["--dir", ".", "start:mcp"];
    writeJson(fixture.paths.claudeJson, { mcpServers: { "work-intelligence": entry }, other: 1 });

    const plan = createAgentSetupPlan(
      launcher(fixture, { adopt: { repositoryRoots: [root], databasePath: database } }),
    );
    expect(plan.conflicts, name).toEqual([]);
    expect(applyAgentSetupPlan(plan).applied).toBe(true);
    expect(readJson(fixture.paths.claudeJson)).toMatchObject({
      other: 1,
      mcpServers: {
        "work-intelligence": {
          type: "stdio",
          command: SHIM,
          args: ["mcp"],
          env: { WORK_INTELLIGENCE_DB: database, KEEP: "1" },
          note: "mine",
        },
      },
    });
    const server = (readJson(fixture.paths.claudeJson).mcpServers as Record<string, Record<string, unknown>>)[
      "work-intelligence"
    ];
    expect(server).not.toHaveProperty("cwd");
  });

  it("keeps a cwd that names some other folder, in JSON and in TOML", () => {
    const fixture = createFixture();
    const root = fixture.options.repositoryRoot;
    const database = touch(join(root, "data", "work-intelligence.sqlite"));
    const elsewhere = join(fixture.temporaryRoot, "elsewhere");
    writeJson(fixture.paths.claudeJson, {
      mcpServers: { "work-intelligence": { command: "pnpm", args: ["--dir", root, "start:mcp"], cwd: elsewhere } },
    });
    seed(fixture, root, database, `cwd = ${JSON.stringify(elsewhere)}\n`);
    const plan = createAgentSetupPlan(
      launcher(fixture, { adopt: { repositoryRoots: [root], databasePath: database } }),
    );
    expect(plan.conflicts).toEqual([]);
    expect(applyAgentSetupPlan(plan).applied).toBe(true);
    const server = (readJson(fixture.paths.claudeJson).mcpServers as Record<string, Record<string, unknown>>)[
      "work-intelligence"
    ];
    expect(server?.cwd).toBe(elsewhere);
    const toml = parseToml(readFileSync(fixture.paths.codexConfig, "utf8")) as Record<string, any>;
    expect(toml.mcp_servers["work-intelligence"].cwd).toBe(elsewhere);
  });

  it("removes a TOML cwd that named the checkout", () => {
    const fixture = createFixture();
    const root = fixture.options.repositoryRoot;
    const database = touch(join(root, "data", "work-intelligence.sqlite"));
    const before = seed(fixture, root, database, `cwd = ${JSON.stringify(root)}\n`);
    const plan = createAgentSetupPlan(
      launcher(fixture, { adopt: { repositoryRoots: [root], databasePath: database } }),
    );
    expect(plan.conflicts).toEqual([]);
    expect(applyAgentSetupTransaction(plan, { journalPath: fixture.paths.journal }).outcome).toBe("committed");
    const toml = parseToml(readFileSync(fixture.paths.codexConfig, "utf8")) as Record<string, any>;
    expect(toml.mcp_servers["work-intelligence"]).not.toHaveProperty("cwd");
    expect(
      undoAgentSetupOperation(fixture.paths.journal, { homeDirectory: fixture.options.homeDirectory }).status,
    ).toBe("undone");
    expect(readFileSync(fixture.paths.codexConfig, "utf8")).toBe(before);
  });

  it("never swaps in the App's database: another file is refused with both paths named by the finder", () => {
    const fixture = createFixture();
    const root = fixture.options.repositoryRoot;
    const checkoutDatabase = touch(join(root, "data", "work-intelligence.sqlite"));
    const appDatabase = touch(join(fixture.temporaryRoot, "app", "work-intelligence.sqlite"));
    const before = seed(fixture, root, checkoutDatabase);
    const options = launcher(fixture, { adopt: { repositoryRoots: [root], databasePath: appDatabase } });

    const [item] = findCheckoutRegistrations(fixture.options, { appDatabase });
    expect(item).toMatchObject({ recognised: true, sameAsAppDatabase: false, effectiveDatabase: checkoutDatabase });
    const plan = createAgentSetupPlan(options);
    expect(plan.conflicts.join("\n")).toContain("不是 App 目前的資料庫");
    expect(applyAgentSetupPlan(plan).applied).toBe(false);
    expect(readFileSync(fixture.paths.codexConfig, "utf8")).toBe(before);
  });

  it("writes the checkout default database explicitly when the entry names none, so the launcher cannot pick another", () => {
    const fixture = createFixture();
    const root = fixture.options.repositoryRoot;
    const database = touch(join(root, "data", "work-intelligence.sqlite"));
    writeJson(fixture.paths.claudeJson, {
      mcpServers: { "work-intelligence": { command: "pnpm", args: ["--dir", root, "start:mcp"] } },
    });
    const plan = createAgentSetupPlan(
      launcher(fixture, { adopt: { repositoryRoots: [root], databasePath: database } }),
    );
    expect(plan.conflicts).toEqual([]);
    expect(applyAgentSetupPlan(plan).applied).toBe(true);
    expect(readJson(fixture.paths.claudeJson).mcpServers).toMatchObject({
      "work-intelligence": { env: { WORK_INTELLIGENCE_DB: database } },
    });
  });

  it("refuses pnpm forms it cannot trace to one checkout and leaves the files alone", () => {
    for (const entry of [
      { command: "pnpm", args: ["start:mcp"] },
      { command: "pnpm", args: ["--dir", "relative", "start:mcp"] },
      { command: "pnpm", args: ["--filter", "@work-intelligence/mcp", "start"] },
      { command: "pnpm", args: ["--dir", "/x", "--dir", "/y", "start:mcp"] },
      { command: "pnpm", args: ["start:mcp", "--dir", "/other"], cwd: "/repo" },
      { command: "pnpm", args: ["start:mcp", "-C", "/other"], cwd: "/repo" },
      { command: "pnpm", args: ["start:mcp", "--dir=/other"], cwd: "/repo" },
    ]) {
      const fixture = createFixture();
      const root = fixture.options.repositoryRoot;
      writeJson(fixture.paths.claudeJson, { mcpServers: { "work-intelligence": entry } });
      const bytes = readFileSync(fixture.paths.claudeJson);
      const plan = createAgentSetupPlan(
        launcher(fixture, { adopt: { repositoryRoots: [root], databasePath: join(root, "data", "x.sqlite") } }),
      );
      expect(plan.conflicts.join("\n")).toContain("無法安全改寫");
      expect(plan.adopted).toEqual([]);
      expect(applyAgentSetupPlan(plan).applied).toBe(false);
      expect(readFileSync(fixture.paths.claudeJson)).toEqual(bytes);
    }
  });

  describe("on Windows", () => {
    const WINDOWS_ROOT = "C:\\Users\\someone\\src\\WorkLog.Ai";

    function windows(fixture: SetupFixture, _databasePath: string): AgentSetupPlanOptions {
      return {
        ...fixture.options,
        platform: "win32",
        target: { kind: "launcher", shimPath: WINDOWS_SHIM, skillSourcePath: fixture.paths.skillSource },
        adopt: { repositoryRoots: [WINDOWS_ROOT.toLowerCase()] },
      };
    }

    it.each([
      ["pnpm.cmd with --dir", { command: "pnpm.cmd", args: ["--dir", WINDOWS_ROOT, "start:mcp"] }],
      [
        "a pnpm.cmd path with backslashes",
        { command: "C:\\Users\\someone\\AppData\\Roaming\\npm\\pnpm.cmd", args: ["-C", WINDOWS_ROOT, "start:mcp"] },
      ],
      ["cmd /c pnpm.cmd", { command: "cmd", args: ["/c", "pnpm.cmd", "--dir", WINDOWS_ROOT, "start:mcp"] }],
      ["pnpm.exe with cwd", { command: "pnpm.exe", args: ["start:mcp"], cwd: `${WINDOWS_ROOT}\\` }],
    ])("adopts %s and tells root casing and separators apart from the list", (_name, entry) => {
      const fixture = createFixture();
      const database = `${WINDOWS_ROOT}\\data\\work-intelligence.sqlite`;
      writeJson(fixture.paths.claudeJson, {
        mcpServers: { "work-intelligence": { ...entry, env: { WORK_INTELLIGENCE_DB: database } } },
      });
      // The files do not exist on this host, so the identity check falls back to the paths themselves.
      const plan = createAgentSetupPlan(windows(fixture, database));
      expect(plan.conflicts).toEqual([]);
      expect(plan.adopted?.[0]).toMatchObject({ repositoryRoot: WINDOWS_ROOT.replace(/\\$/, "") });
      expect(applyAgentSetupPlan(plan).applied).toBe(true);
      expect(readJson(fixture.paths.claudeJson).mcpServers).toMatchObject({
        "work-intelligence": { command: WINDOWS_SHIM, args: ["mcp"], env: { WORK_INTELLIGENCE_DB: database } },
      });
    });

    it("adopts a Codex table written with backslash paths", () => {
      const fixture = createFixture();
      const database = `${WINDOWS_ROOT}\\data\\work-intelligence.sqlite`;
      writeFileSync(
        fixture.paths.codexConfig,
        `[mcp_servers.work-intelligence]\ncommand = 'C:\\Users\\someone\\AppData\\Roaming\\npm\\pnpm.cmd'\nargs = ['--dir', 'C:\\Users\\someone\\src\\WorkLog.Ai', 'start:mcp']\nenabled = true\n\n[mcp_servers.work-intelligence.env]\nWORK_INTELLIGENCE_DB = 'C:\\Users\\someone\\src\\WorkLog.Ai\\data\\work-intelligence.sqlite'\n`,
      );
      const plan = createAgentSetupPlan(windows(fixture, database));
      expect(plan.conflicts).toEqual([]);
      expect(applyAgentSetupPlan(plan).applied).toBe(true);
      const toml = parseToml(readFileSync(fixture.paths.codexConfig, "utf8")) as Record<string, any>;
      expect(toml.mcp_servers["work-intelligence"]).toMatchObject({
        command: WINDOWS_SHIM,
        args: ["mcp"],
        enabled: true,
      });
    });
  });
});

function posixQuote(value: string): string {
  return PLATFORM === "win32" ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`;
}

/** A fixture whose platform matches the host, because its checkout and home are real host paths. */
function hostFixture(): SetupFixture {
  const fixture = createFixture();
  fixture.options = { ...fixture.options, platform: PLATFORM };
  return fixture;
}

function hostShim(): string {
  return PLATFORM === "win32" ? WINDOWS_SHIM : SHIM;
}

function hostTarget(fixture: SetupFixture): AgentSetupPlanOptions["target"] {
  return { kind: "launcher", shimPath: hostShim(), skillSourcePath: fixture.paths.skillSource };
}

describe("an old checkout hook beside the App's own hook", () => {
  const ACTION = "codex-finalize-reminder";
  const THIRD_PARTY = "'/usr/local/bin/node' '/Users/someone/.desktop-pet/agent-hook.mjs' codex";

  function oldCommand(root: string): string {
    return `/usr/local/bin/node "${root}/apps/mcp/dist/codex-finalize-reminder.js"`;
  }

  /** The reported shape: both hooks in three events, groups with timeout/statusMessage/matcher, and a third-party hook. */
  function seedHooks(fixture: SetupFixture, oldHook: string): string {
    const root = fixture.options.repositoryRoot;
    const launcherHook = { type: "command", command: commandForLauncherHook(hostShim(), ACTION, PLATFORM) };
    const old = { type: "command", command: oldHook };
    writeJson(fixture.paths.codexHooks, {
      hooks: {
        UserPromptSubmit: [
          { hooks: [launcherHook] },
          { hooks: [old], timeout: 3 },
          { hooks: [{ type: "command", command: THIRD_PARTY }] },
        ],
        PostToolUse: [
          { matcher: "^(apply_patch|.*(work_finalize_session|work_write_idempotent))$", hooks: [launcherHook] },
          { matcher: "apply_patch", hooks: [old], timeout: 3, statusMessage: "Saving" },
        ],
        Stop: [{ hooks: [launcherHook] }, { hooks: [old, { type: "command", command: THIRD_PARTY }], timeout: 3 }],
      },
    });
    void root;
    return readFileSync(fixture.paths.codexHooks, "utf8");
  }

  function adoptOptions(fixture: SetupFixture): AgentSetupPlanOptions {
    return launcher(fixture, {
      target: hostTarget(fixture),
      adopt: { repositoryRoots: [fixture.options.repositoryRoot] },
    });
  }

  it("is a conflict today and is removed on adopt, leaving the third-party hook and the App's hooks alone, undoable", () => {
    const fixture = hostFixture();
    const root = fixture.options.repositoryRoot;
    const before = seedHooks(fixture, oldCommand(root));
    expect(inspectAgentRegistrations(launcher(fixture, { target: hostTarget(fixture) })).duplicates).toMatchObject([
      { agent: "codex", kind: "hook", sources: ["desktop-managed", "manual"] },
    ]);

    const found = findCheckoutRegistrations(fixture.options).filter((item) => item.kind === "hook");
    expect(found).toHaveLength(3);
    for (const item of found) {
      expect(item).toMatchObject({ recognised: true, duplicateOfLauncher: true, repositoryRoot: root });
      expect(item.effectiveDatabase).toBeUndefined();
    }

    const plan = createAgentSetupPlan(adoptOptions(fixture));
    expect(plan.conflicts).toEqual([]);
    expect(plan.actions.filter((line) => line.includes("移除重複的舊"))).toHaveLength(3);
    expect(applyAgentSetupTransaction(plan, { journalPath: fixture.paths.journal }).outcome).toBe("committed");

    const after = readFileSync(fixture.paths.codexHooks, "utf8");
    expect(after).not.toContain("codex-finalize-reminder.js");
    expect(after.split(THIRD_PARTY).length - 1).toBe(2);
    expect(after.split(ACTION).length - 1).toBeGreaterThanOrEqual(3);
    const hooks = readJson(fixture.paths.codexHooks).hooks as Record<string, Array<Record<string, unknown>>>;
    // The group that held only the old hook is gone; the one that also held the third-party hook keeps it.
    expect(hooks.Stop).toHaveLength(2);
    expect(hooks.Stop?.[1]).toMatchObject({ timeout: 3, hooks: [{ command: THIRD_PARTY }] });
    expect(inspectAgentRegistrations(launcher(fixture, { target: hostTarget(fixture) })).duplicates).toEqual([]);

    const undone = undoAgentSetupOperation(fixture.paths.journal, { homeDirectory: fixture.options.homeDirectory });
    expect(undone.status).toBe("undone");
    expect(readFileSync(fixture.paths.codexHooks, "utf8")).toBe(before);
  });

  it.each([
    [
      "an absolute node with flags",
      (root: string) => `/usr/local/bin/node --no-warnings "${root}/apps/mcp/dist/codex-finalize-reminder.js"`,
    ],
    [
      "node on PATH, unquoted",
      (root: string) =>
        PLATFORM === "win32"
          ? `node "${root}\\apps\\mcp\\dist\\codex-finalize-reminder.js"`
          : `node ${root.replaceAll(" ", "\\ ").replaceAll("'", "\\'")}/apps/mcp/dist/codex-finalize-reminder.js`,
    ],
    [
      "pnpm exec node with --dir",
      (root: string) => `pnpm --dir "${root}" exec node apps/mcp/dist/codex-finalize-reminder.js`,
    ],
    [
      "pnpm -C node with a relative script",
      (root: string) => `/usr/local/bin/pnpm -C ${posixQuote(root)} node apps/mcp/dist/codex-finalize-reminder.js`,
    ],
  ])("recognises %s", (_name, build) => {
    const fixture = hostFixture();
    seedHooks(fixture, build(fixture.options.repositoryRoot));
    const plan = createAgentSetupPlan(adoptOptions(fixture));
    expect(plan.conflicts).toEqual([]);
    expect(applyAgentSetupPlan(plan).applied).toBe(true);
    expect(readFileSync(fixture.paths.codexHooks, "utf8")).not.toContain("codex-finalize-reminder.js");
  });

  it("never treats the third-party hook, a node that loads code, or a different script as ours", () => {
    const fixture = hostFixture();
    const root = fixture.options.repositoryRoot;
    seedHooks(fixture, `node --require ./evil.js "${root}/apps/mcp/dist/codex-finalize-reminder.js"`);
    const found = findCheckoutRegistrations(fixture.options).filter((item) => item.kind === "hook");
    expect(found.every((item) => !item.recognised)).toBe(true);
    expect(found.some((item) => item.reason?.includes("agent-hook"))).toBe(false);
    const plan = createAgentSetupPlan(adoptOptions(fixture));
    expect(plan.conflicts.join("\n")).toContain("無法安全改寫");
  });

  it("rewrites (instead of removing) an old hook when the App has none for that event", () => {
    const fixture = hostFixture();
    const root = fixture.options.repositoryRoot;
    writeJson(fixture.paths.codexHooks, {
      hooks: { Stop: [{ hooks: [{ type: "command", command: oldCommand(root) }], timeout: 3 }] },
    });
    const [item] = findCheckoutRegistrations(fixture.options).filter((entry) => entry.kind === "hook");
    expect(item?.duplicateOfLauncher).toBeUndefined();
    expect(item?.effectiveDatabase).toBeDefined();
  });

  it("reads Windows hooks with a node.exe path and backslashes", () => {
    const fixture = hostFixture();
    const windowsRoot = "C:\\Users\\someone\\src\\WorkLog.Ai";
    const launcherHook = { type: "command", command: commandForLauncherHook(WINDOWS_SHIM, ACTION, "win32") };
    writeJson(fixture.paths.codexHooks, {
      hooks: {
        Stop: [
          { hooks: [launcherHook] },
          {
            hooks: [
              {
                type: "command",
                command: `"C:\\Program Files\\nodejs\\node.exe" "${windowsRoot}\\apps\\mcp\\dist\\codex-finalize-reminder.js"`,
              },
            ],
          },
        ],
      },
    });
    const hooks = findCheckoutRegistrations({ ...fixture.options, platform: "win32" }).filter(
      (item) => item.kind === "hook",
    );
    expect(hooks).toMatchObject([{ recognised: true, duplicateOfLauncher: true, repositoryRoot: windowsRoot }]);
  });
});
