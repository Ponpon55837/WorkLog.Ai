import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyAgentSetupPlan,
  commandForAgentHook,
  createAgentSetupPlan,
  inspectAgentSkillCopies,
  inspectCodexHooksFeature,
  runAgentSetupCli,
  type AgentSetupPlanOptions,
} from "../../apps/server/src/agent-setup.js";

interface Fixture {
  temporaryRoot: string;
  options: AgentSetupPlanOptions;
  paths: {
    codexHome: string;
    claudeConfig: string;
    manifest: string;
    codexConfig: string;
    codexHooks: string;
    claudeJson: string;
    claudeSettings: string;
    codexSkill: string;
    codexLegacySkill: string;
    claudeSkill: string;
  };
  seedUserConfig(): Map<string, Buffer>;
}

const temporaryRoots: string[] = [];

function writeJson(path: string, value: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return bytes;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function skillCopyStates(fixture: Fixture): Record<string, string> {
  return Object.fromEntries(
    inspectAgentSkillCopies(fixture.options.homeDirectory, fixture.options.repositoryRoot).map((item) => [
      item.componentId,
      item.state,
    ]),
  );
}

function createFixture(repositoryDirectoryName = "repo with space's name"): Fixture {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "work-intelligence-agent-setup-test-"));
  temporaryRoots.push(temporaryRoot);
  const homeDirectory = join(temporaryRoot, "home");
  const repositoryRoot = join(temporaryRoot, repositoryDirectoryName);
  const codexHome = join(homeDirectory, ".codex");
  const claudeConfig = join(homeDirectory, ".claude");
  const paths = {
    codexHome,
    claudeConfig,
    manifest: join(homeDirectory, ".work-intelligence-agent-setup.json"),
    codexConfig: join(codexHome, "config.toml"),
    codexHooks: join(codexHome, "hooks.json"),
    claudeJson: join(homeDirectory, ".claude.json"),
    claudeSettings: join(claudeConfig, "settings.json"),
    codexSkill: join(homeDirectory, ".agents", "skills", "work-intelligence", "SKILL.md"),
    codexLegacySkill: join(codexHome, "skills", "work-intelligence", "SKILL.md"),
    claudeSkill: join(claudeConfig, "skills", "work-intelligence", "SKILL.md"),
  };
  mkdirSync(homeDirectory, { recursive: true });
  mkdirSync(join(repositoryRoot, ".agents", "skills", "work-intelligence"), { recursive: true });
  mkdirSync(join(repositoryRoot, "apps", "mcp", "dist"), { recursive: true });
  writeFileSync(
    join(repositoryRoot, ".agents", "skills", "work-intelligence", "SKILL.md"),
    "# Work Intelligence\n\nFixture skill v1.\n",
  );
  for (const filename of ["index.js", "finalize-reminder.js", "codex-finalize-reminder.js"]) {
    writeFileSync(join(repositoryRoot, "apps", "mcp", "dist", filename), `// fixture ${filename}\n`);
  }

  const options: AgentSetupPlanOptions = {
    homeDirectory,
    repositoryRoot,
    now: new Date("2026-09-28T12:34:56.000Z"),
  };

  return {
    temporaryRoot,
    options,
    paths,
    seedUserConfig() {
      const codexConfig = Buffer.from(
        '# Existing Codex preferences\nmodel = "fixture-model"\n\n[features]\nexperimental_feature = true\n',
        "utf8",
      );
      mkdirSync(codexHome, { recursive: true });
      writeFileSync(paths.codexConfig, codexConfig);
      const codexHooks = writeJson(paths.codexHooks, {
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "node user-stop.js" }] }],
          UserNotification: [{ hooks: [{ type: "command", command: "node user-notification.js" }] }],
        },
        userSetting: { keep: true },
      });
      const claudeJson = writeJson(paths.claudeJson, {
        projects: { "/fixture/project": { allowedTools: ["Read"] } },
        mcpServers: { existing: { command: "node", args: ["existing-server.js"] } },
      });
      const claudeSettings = writeJson(paths.claudeSettings, {
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "node existing-claude-stop.js" }] }],
          Notification: [{ hooks: [{ type: "command", command: "node notify.js" }] }],
        },
        userSetting: "preserve me",
      });
      return new Map([
        [paths.codexConfig, codexConfig],
        [paths.codexHooks, codexHooks],
        [paths.claudeJson, claudeJson],
        [paths.claudeSettings, claudeSettings],
      ]);
    },
  };
}

function install(fixture: Fixture): ReturnType<typeof applyAgentSetupPlan> {
  const plan = createAgentSetupPlan(fixture.options);
  expect(plan.conflicts).toEqual([]);
  const result = applyAgentSetupPlan(plan);
  expect(result.applied).toBe(true);
  return result;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object in the setup fixture.");
  }
  return value as Record<string, unknown>;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Agent setup", () => {
  it("keeps preview and a declined confirmation read-only", async () => {
    const fixture = createFixture();
    const { homeDirectory } = fixture.options;
    const plan = createAgentSetupPlan(fixture.options);

    expect(plan.conflicts).toEqual([]);
    expect(plan.mutations.length).toBeGreaterThan(0);
    expect(readdirSync(homeDirectory)).toEqual([]);
    expect(existsSync(fixture.paths.codexHome)).toBe(false);
    expect(existsSync(fixture.paths.claudeConfig)).toBe(false);
    expect(existsSync(join(homeDirectory, ".agents"))).toBe(false);
    expect(existsSync(fixture.paths.manifest)).toBe(false);

    const printed: string[] = [];
    let confirmationCount = 0;
    const exitCode = await runAgentSetupCli([], {
      ...fixture.options,
      print: (message) => printed.push(message),
      confirm: async () => {
        confirmationCount += 1;
        return false;
      },
    });

    expect(exitCode).toBe(0);
    expect(confirmationCount).toBe(1);
    expect(printed.some((message) => message.includes("已取消"))).toBe(true);
    expect(readdirSync(homeDirectory)).toEqual([]);
    expect(existsSync(fixture.paths.codexHome)).toBe(false);
    expect(existsSync(fixture.paths.claudeConfig)).toBe(false);
    expect(existsSync(join(homeDirectory, ".agents"))).toBe(false);
  });

  it("backs up exact originals, preserves unrelated client settings, and becomes idempotent", () => {
    const fixture = createFixture();
    const originalFiles = fixture.seedUserConfig();
    const plan = createAgentSetupPlan(fixture.options);

    expect(plan.conflicts).toEqual([]);
    const result = applyAgentSetupPlan(plan);
    expect(result.applied).toBe(true);
    for (const mutation of plan.mutations) {
      if (!mutation.backupPath) continue;
      expect(readFileSync(mutation.backupPath)).toEqual(originalFiles.get(mutation.path));
    }

    const codexConfig = readFileSync(fixture.paths.codexConfig, "utf8");
    const originalCodexConfig = originalFiles.get(fixture.paths.codexConfig);
    if (!originalCodexConfig) throw new Error("The original Codex config fixture is missing.");
    expect(codexConfig.startsWith(originalCodexConfig.toString("utf8"))).toBe(true);
    expect(codexConfig).toContain("[mcp_servers.work-intelligence]");
    const claudeConfig = readJson(fixture.paths.claudeJson);
    expect(object(claudeConfig.projects)).toEqual({ "/fixture/project": { allowedTools: ["Read"] } });
    expect(object(claudeConfig.mcpServers).existing).toEqual({ command: "node", args: ["existing-server.js"] });
    expect(object(claudeConfig.mcpServers)["work-intelligence"]).toBeDefined();

    const claudeSettings = readJson(fixture.paths.claudeSettings);
    expect(object(claudeSettings).userSetting).toBe("preserve me");
    expect(object(claudeSettings.hooks).Stop as unknown[]).toHaveLength(2);
    expect(object(claudeSettings.hooks).Notification as unknown[]).toHaveLength(1);

    const codexHooks = readJson(fixture.paths.codexHooks);
    expect(object(codexHooks).userSetting).toEqual({ keep: true });
    expect(object(codexHooks.hooks).Stop as unknown[]).toHaveLength(2);
    expect(object(codexHooks.hooks).PostToolUse as unknown[]).toHaveLength(1);
    expect(object(codexHooks.hooks).UserPromptSubmit as unknown[]).toHaveLength(1);
    expect(object(codexHooks.hooks).UserNotification as unknown[]).toHaveLength(1);

    const manifest = readJson(fixture.paths.manifest);
    const componentIds = (manifest.components as Array<{ id: string }>).map((component) => component.id);
    expect(componentIds).toContain("codexSkill");
    expect(componentIds).toContain("codexLegacySkill");
    expect(componentIds).toContain("claudeSkill");

    const secondPlan = createAgentSetupPlan(fixture.options);
    expect(secondPlan.conflicts).toEqual([]);
    expect(secondPlan.mutations).toEqual([]);
  });

  it("keeps skill copies current by content hash and reports source drift as stale", () => {
    const fixture = createFixture();
    expect(skillCopyStates(fixture)).toEqual({
      codexSkill: "missing",
      codexLegacySkill: "missing",
      claudeSkill: "missing",
    });

    install(fixture);
    expect(skillCopyStates(fixture)).toEqual({
      codexSkill: "current",
      codexLegacySkill: "current",
      claudeSkill: "current",
    });
    const initialSkillCopies = new Map(
      [fixture.paths.codexSkill, fixture.paths.codexLegacySkill, fixture.paths.claudeSkill].map((path) => [
        path,
        readFileSync(path),
      ]),
    );

    writeFileSync(
      join(fixture.options.repositoryRoot, ".agents", "skills", "work-intelligence", "SKILL.md"),
      "# Work Intelligence\n\nFixture skill v2.\n",
    );
    expect(skillCopyStates(fixture)).toEqual({ codexSkill: "stale", codexLegacySkill: "stale", claudeSkill: "stale" });

    const updatePlan = createAgentSetupPlan(fixture.options);
    expect(updatePlan.conflicts).toEqual([]);
    const skillPaths = [fixture.paths.codexSkill, fixture.paths.codexLegacySkill, fixture.paths.claudeSkill].sort();
    const skillBackups = updatePlan.mutations.filter(
      (mutation) => skillPaths.includes(mutation.path) && mutation.backupPath,
    );
    expect(skillBackups.map((mutation) => mutation.path).sort()).toEqual(skillPaths);
    expect(applyAgentSetupPlan(updatePlan).applied).toBe(true);
    for (const mutation of skillBackups) {
      if (!mutation.backupPath) continue;
      expect(readFileSync(mutation.backupPath)).toEqual(initialSkillCopies.get(mutation.path));
    }
    expect(skillCopyStates(fixture)).toEqual({
      codexSkill: "current",
      codexLegacySkill: "current",
      claudeSkill: "current",
    });
  });

  it("refuses to register paths when any required build output is missing", () => {
    const fixture = createFixture();
    rmSync(join(fixture.options.repositoryRoot, "apps", "mcp", "dist", "codex-finalize-reminder.js"));

    const plan = createAgentSetupPlan(fixture.options);
    expect(plan.conflicts.some((conflict) => conflict.includes("pnpm build"))).toBe(true);
    expect(applyAgentSetupPlan(plan).applied).toBe(false);
    expect(readdirSync(fixture.options.homeDirectory)).toEqual([]);
    expect(existsSync(fixture.paths.codexHome)).toBe(false);
    expect(existsSync(fixture.paths.claudeConfig)).toBe(false);
  });

  it.each([
    ["quoted table keys", '["mcp_servers"."work-intelligence"]\ncommand = "node"\n'],
    ["quoted parent and child keys", '["mcp_servers"]\n"work-intelligence" = { command = "node" }\n'],
    ["quoted inline-table root key", '"mcp_servers" = { "work-intelligence" = { command = "node" } }\n'],
    [
      "a prior unsupported Unicode-escaped header followed by a target table",
      '[user."\\U00000041"]\nvalue = 1\n\n[mcp_servers."work-intelligence"]\ncommand = "node"\n',
    ],
  ])("refuses an existing Codex MCP entry written with %s", (_description, toml) => {
    const fixture = createFixture();
    mkdirSync(dirname(fixture.paths.codexConfig), { recursive: true });
    writeFileSync(fixture.paths.codexConfig, toml);

    const plan = createAgentSetupPlan(fixture.options);
    expect(plan.conflicts.some((conflict) => conflict.includes("mcp_servers"))).toBe(true);
    expect(applyAgentSetupPlan(plan).applied).toBe(false);
    expect(readFileSync(fixture.paths.codexConfig, "utf8")).toBe(toml);
    expect(existsSync(fixture.paths.manifest)).toBe(false);
  });

  it.each([
    ["features table", "[features]\nhooks = false\n"],
    ["quoted features table", '["features"]\nhooks = false\n'],
    ["dotted key", "features.hooks = false\n"],
    ["quoted feature key", '[features]\n"hooks" = false\n'],
    ["deprecated alias", "[features]\ncodex_hooks = false\n"],
  ])("does not install Codex hooks when %s disables them", (_description, toml) => {
    const fixture = createFixture();
    mkdirSync(dirname(fixture.paths.codexConfig), { recursive: true });
    writeFileSync(fixture.paths.codexConfig, toml);

    expect(inspectCodexHooksFeature(fixture.options.homeDirectory, fixture.paths.codexHome)).toBe("disabled");
    const plan = createAgentSetupPlan(fixture.options);
    expect(plan.conflicts).toEqual([]);
    expect(applyAgentSetupPlan(plan).applied).toBe(true);
    expect(existsSync(fixture.paths.codexHooks)).toBe(false);
    const manifest = readJson(fixture.paths.manifest);
    const componentIds = (manifest.components as Array<{ id: string }>).map((component) => component.id);
    expect(componentIds).not.toContain("codexStopHook");
    expect(componentIds).not.toContain("codexPostToolUseHook");
    expect(componentIds).not.toContain("codexUserPromptSubmitHook");
  });

  it("keeps canonical Codex skill in home with custom legacy Codex and Claude config roots", () => {
    const fixture = createFixture();
    const codexHomeDirectory = join(fixture.temporaryRoot, "custom-codex-root");
    const claudeConfigDirectory = join(fixture.temporaryRoot, "custom-claude-root");
    const options = { ...fixture.options, codexHomeDirectory, claudeConfigDirectory };
    const plan = createAgentSetupPlan(options);

    expect(plan.conflicts).toEqual([]);
    expect(applyAgentSetupPlan(plan).applied).toBe(true);
    expect(existsSync(join(codexHomeDirectory, "config.toml"))).toBe(true);
    expect(existsSync(join(codexHomeDirectory, "skills", "work-intelligence", "SKILL.md"))).toBe(true);
    expect(existsSync(fixture.paths.codexSkill)).toBe(true);
    expect(existsSync(fixture.paths.codexLegacySkill)).toBe(false);
    expect(existsSync(join(claudeConfigDirectory, "settings.json"))).toBe(true);
    expect(existsSync(join(claudeConfigDirectory, "skills", "work-intelligence", "SKILL.md"))).toBe(true);
    expect(existsSync(fixture.paths.claudeJson)).toBe(true);
    expect(existsSync(join(fixture.options.homeDirectory, ".codex"))).toBe(false);
    expect(existsSync(join(fixture.options.homeDirectory, ".claude"))).toBe(false);
    expect(
      inspectAgentSkillCopies(
        fixture.options.homeDirectory,
        fixture.options.repositoryRoot,
        codexHomeDirectory,
        claudeConfigDirectory,
      ).map((item) => [item.componentId, item.state]),
    ).toEqual([
      ["codexSkill", "current"],
      ["codexLegacySkill", "current"],
      ["claudeSkill", "current"],
    ]);
  });

  it("refuses to reinstall under different config roots recorded by the manifest", () => {
    const fixture = createFixture();
    const codexHomeDirectory = join(fixture.temporaryRoot, "original-codex-root");
    const claudeConfigDirectory = join(fixture.temporaryRoot, "original-claude-root");
    const originalOptions = { ...fixture.options, codexHomeDirectory, claudeConfigDirectory };
    const originalPlan = createAgentSetupPlan(originalOptions);
    expect(originalPlan.conflicts).toEqual([]);
    expect(applyAgentSetupPlan(originalPlan).applied).toBe(true);
    const manifestBytes = readFileSync(fixture.paths.manifest);

    const changedOptions = {
      ...fixture.options,
      codexHomeDirectory: join(fixture.temporaryRoot, "changed-codex-root"),
      claudeConfigDirectory: join(fixture.temporaryRoot, "changed-claude-root"),
    };
    const changedPlan = createAgentSetupPlan(changedOptions);

    expect(changedPlan.conflicts.some((conflict) => conflict.includes("CODEX_HOME 或 CLAUDE_CONFIG_DIR 已變更"))).toBe(
      true,
    );
    expect(applyAgentSetupPlan(changedPlan).applied).toBe(false);
    expect(readFileSync(fixture.paths.manifest)).toEqual(manifestBytes);
    expect(existsSync(join(changedOptions.codexHomeDirectory, "config.toml"))).toBe(false);
    expect(existsSync(join(changedOptions.claudeConfigDirectory, "settings.json"))).toBe(false);
  });

  it("uninstalls custom-root settings from their recorded locations when invoked with default roots", () => {
    const fixture = createFixture();
    const codexHomeDirectory = join(fixture.temporaryRoot, "recorded-codex-root");
    const claudeConfigDirectory = join(fixture.temporaryRoot, "recorded-claude-root");
    const installPlan = createAgentSetupPlan({ ...fixture.options, codexHomeDirectory, claudeConfigDirectory });
    expect(installPlan.conflicts).toEqual([]);
    expect(applyAgentSetupPlan(installPlan).applied).toBe(true);

    const uninstallPlan = createAgentSetupPlan(fixture.options, "uninstall");
    expect(uninstallPlan.conflicts).toEqual([]);
    expect(uninstallPlan.mutations.map((mutation) => mutation.path)).toContain(join(codexHomeDirectory, "config.toml"));
    expect(uninstallPlan.mutations.map((mutation) => mutation.path)).toContain(join(codexHomeDirectory, "hooks.json"));
    expect(uninstallPlan.mutations.map((mutation) => mutation.path)).toContain(
      join(codexHomeDirectory, "skills", "work-intelligence", "SKILL.md"),
    );
    expect(uninstallPlan.mutations.map((mutation) => mutation.path)).toContain(
      join(claudeConfigDirectory, "settings.json"),
    );
    expect(uninstallPlan.mutations.map((mutation) => mutation.path)).toContain(
      join(claudeConfigDirectory, "skills", "work-intelligence", "SKILL.md"),
    );
    expect(applyAgentSetupPlan(uninstallPlan).applied).toBe(true);
    expect(readFileSync(join(codexHomeDirectory, "config.toml"), "utf8")).not.toContain(
      "mcp_servers.work-intelligence",
    );
    expect(readFileSync(join(codexHomeDirectory, "hooks.json"), "utf8")).not.toContain("codex-finalize-reminder.js");
    expect(existsSync(join(codexHomeDirectory, "skills", "work-intelligence", "SKILL.md"))).toBe(false);
    expect(readFileSync(join(claudeConfigDirectory, "settings.json"), "utf8")).not.toContain("finalize-reminder.js");
    expect(existsSync(join(claudeConfigDirectory, "skills", "work-intelligence", "SKILL.md"))).toBe(false);
    expect(existsSync(join(fixture.options.homeDirectory, ".codex"))).toBe(false);
    expect(existsSync(join(fixture.options.homeDirectory, ".claude"))).toBe(false);
    expect(existsSync(fixture.paths.manifest)).toBe(false);
  });

  it("rejects a plan if a target changed after preview before creating backups", () => {
    const fixture = createFixture();
    const plan = createAgentSetupPlan(fixture.options);
    const changedTarget = plan.mutations[0]?.path;
    if (!changedTarget) throw new Error("The preview did not stage the skill copy.");
    mkdirSync(dirname(changedTarget), { recursive: true });
    writeFileSync(changedTarget, "created after preview\n");

    const result = applyAgentSetupPlan(plan);
    expect(result.applied).toBe(false);
    expect(result.conflicts.join(" ")).toContain("預覽後已變更");
    expect(readFileSync(changedTarget, "utf8")).toBe("created after preview\n");
    expect(plan.mutations.every((mutation) => !mutation.backupPath || !existsSync(mutation.backupPath))).toBe(true);
    expect(existsSync(fixture.paths.manifest)).toBe(false);
    expect(existsSync(fixture.paths.codexConfig)).toBe(false);
  });

  it("rolls back a failed install to the original bytes and succeeds on a fresh retry", () => {
    const fixture = createFixture();
    const originalFiles = fixture.seedUserConfig();
    const firstPlan = createAgentSetupPlan(fixture.options);
    const failingPath = fixture.paths.codexHooks;
    expect(firstPlan.mutations.some((mutation) => mutation.path === failingPath)).toBe(true);

    const failed = applyAgentSetupPlan(firstPlan, {
      beforeWrite: (mutation) => {
        if (mutation.path === failingPath) throw new Error("injected setup write failure");
      },
    });
    expect(failed.applied).toBe(false);
    expect(failed.error).toContain("injected setup write failure");
    for (const [path, original] of originalFiles) expect(readFileSync(path)).toEqual(original);
    expect(existsSync(fixture.paths.codexSkill)).toBe(false);
    expect(existsSync(fixture.paths.codexLegacySkill)).toBe(false);
    expect(existsSync(fixture.paths.claudeSkill)).toBe(false);
    expect(existsSync(fixture.paths.manifest)).toBe(false);
    for (const mutation of firstPlan.mutations) {
      if (!mutation.backupPath) continue;
      expect(existsSync(mutation.backupPath)).toBe(false);
    }

    const retryPlan = createAgentSetupPlan(fixture.options);
    expect(retryPlan.conflicts).toEqual([]);
    expect(applyAgentSetupPlan(retryPlan).applied).toBe(true);
    expect(existsSync(fixture.paths.manifest)).toBe(true);
  });

  it("preserves later user settings through uninstall and retry after an injected failure", () => {
    const fixture = createFixture();
    fixture.seedUserConfig();
    install(fixture);

    const claudeJson = readJson(fixture.paths.claudeJson);
    object(claudeJson.mcpServers).added_later = { command: "node", args: ["later-server.js"] };
    writeJson(fixture.paths.claudeJson, claudeJson);
    const claudeSettings = readJson(fixture.paths.claudeSettings);
    object(claudeSettings.hooks).AddedLater = [{ hooks: [{ type: "command", command: "node later-claude.js" }] }];
    writeJson(fixture.paths.claudeSettings, claudeSettings);
    const codexHooks = readJson(fixture.paths.codexHooks);
    object(codexHooks.hooks).AddedLater = [{ hooks: [{ type: "command", command: "node later-codex.js" }] }];
    writeJson(fixture.paths.codexHooks, codexHooks);
    writeFileSync(
      fixture.paths.codexConfig,
      readFileSync(fixture.paths.codexConfig, "utf8") + '\n[ui]\ntheme = "dark"\n',
    );

    const installedSnapshot = new Map(
      [
        fixture.paths.codexConfig,
        fixture.paths.codexHooks,
        fixture.paths.claudeJson,
        fixture.paths.claudeSettings,
        fixture.paths.manifest,
      ].map((path) => [path, readFileSync(path)]),
    );
    const uninstallPlan = createAgentSetupPlan(fixture.options, "uninstall");
    expect(uninstallPlan.conflicts).toEqual([]);
    const failed = applyAgentSetupPlan(uninstallPlan, {
      beforeWrite: (mutation) => {
        if (mutation.path === fixture.paths.manifest) throw new Error("injected uninstall write failure");
      },
    });
    expect(failed.applied).toBe(false);
    expect(failed.error).toContain("injected uninstall write failure");
    for (const [path, bytes] of installedSnapshot) expect(readFileSync(path)).toEqual(bytes);

    const retryPlan = createAgentSetupPlan(fixture.options, "uninstall");
    expect(retryPlan.conflicts).toEqual([]);
    expect(applyAgentSetupPlan(retryPlan).applied).toBe(true);
    expect(existsSync(fixture.paths.manifest)).toBe(false);
    expect(existsSync(fixture.paths.codexSkill)).toBe(false);
    expect(existsSync(fixture.paths.codexLegacySkill)).toBe(false);
    expect(existsSync(fixture.paths.claudeSkill)).toBe(false);
    expect(readFileSync(fixture.paths.codexConfig, "utf8")).toContain('[ui]\ntheme = "dark"');
    expect(readFileSync(fixture.paths.codexConfig, "utf8")).not.toContain("[mcp_servers.work-intelligence]");

    const finalClaudeJson = readJson(fixture.paths.claudeJson);
    expect(object(finalClaudeJson.mcpServers).existing).toBeDefined();
    expect(object(finalClaudeJson.mcpServers).added_later).toEqual({ command: "node", args: ["later-server.js"] });
    expect(object(finalClaudeJson.mcpServers)["work-intelligence"]).toBeUndefined();
    const finalClaudeSettings = readJson(fixture.paths.claudeSettings);
    expect(object(finalClaudeSettings.hooks).Stop as unknown[]).toHaveLength(1);
    expect(object(finalClaudeSettings.hooks).AddedLater).toBeDefined();
    const finalCodexHooks = readJson(fixture.paths.codexHooks);
    expect(object(finalCodexHooks.hooks).Stop as unknown[]).toHaveLength(1);
    expect(object(finalCodexHooks.hooks).AddedLater).toBeDefined();

    const reinstallPlan = createAgentSetupPlan(fixture.options);
    expect(reinstallPlan.conflicts).toEqual([]);
    expect(applyAgentSetupPlan(reinstallPlan).applied).toBe(true);
    expect(existsSync(fixture.paths.manifest)).toBe(true);
    expect(object(readJson(fixture.paths.claudeJson).mcpServers)["work-intelligence"]).toBeDefined();
    expect(object(readJson(fixture.paths.claudeJson).mcpServers).added_later).toBeDefined();
    expect(object(readJson(fixture.paths.codexHooks).hooks).AddedLater).toBeDefined();
  });

  it("maps a version-one Codex skill ownership record to the legacy path during uninstall", () => {
    const fixture = createFixture();
    const sourceSkill = readFileSync(
      join(fixture.options.repositoryRoot, ".agents", "skills", "work-intelligence", "SKILL.md"),
    );
    const canonicalUserSkill = Buffer.from("# A separately managed canonical skill\n", "utf8");
    mkdirSync(dirname(fixture.paths.codexLegacySkill), { recursive: true });
    mkdirSync(dirname(fixture.paths.codexSkill), { recursive: true });
    writeFileSync(fixture.paths.codexLegacySkill, sourceSkill);
    writeFileSync(fixture.paths.codexSkill, canonicalUserSkill);
    writeJson(fixture.paths.manifest, {
      version: 1,
      codexHomeDirectory: fixture.paths.codexHome,
      claudeConfigDirectory: fixture.paths.claudeConfig,
      components: [{ id: "codexSkill", kind: "file", expected: sha256(sourceSkill) }],
    });

    const plan = createAgentSetupPlan(fixture.options, "uninstall");
    expect(plan.conflicts).toEqual([]);
    expect(plan.mutations.map((mutation) => mutation.path)).toContain(fixture.paths.codexLegacySkill);
    expect(plan.mutations.map((mutation) => mutation.path)).not.toContain(fixture.paths.codexSkill);
    expect(applyAgentSetupPlan(plan).applied).toBe(true);
    expect(existsSync(fixture.paths.codexLegacySkill)).toBe(false);
    expect(readFileSync(fixture.paths.codexSkill)).toEqual(canonicalUserSkill);
    expect(existsSync(fixture.paths.manifest)).toBe(false);
  });

  it("refuses to uninstall a modified managed hook under an apostrophe repo path", () => {
    const fixture = createFixture();
    install(fixture);
    const codexHooks = readJson(fixture.paths.codexHooks);
    const stopHooks = object(codexHooks.hooks).Stop as Array<Record<string, unknown>>;
    const workIntelligenceHook = stopHooks.find((entry) =>
      JSON.stringify(entry).includes("codex-finalize-reminder.js"),
    );
    if (!workIntelligenceHook) throw new Error("The installed Codex Stop hook is missing.");
    workIntelligenceHook.timeout = 1;
    writeJson(fixture.paths.codexHooks, codexHooks);
    const changedBytes = readFileSync(fixture.paths.codexHooks);
    const manifestBytes = readFileSync(fixture.paths.manifest);

    const plan = createAgentSetupPlan(fixture.options, "uninstall");
    expect(plan.conflicts.some((conflict) => conflict.includes("修改"))).toBe(true);
    expect(applyAgentSetupPlan(plan).applied).toBe(false);
    expect(readFileSync(fixture.paths.codexHooks)).toEqual(changedBytes);
    expect(readFileSync(fixture.paths.manifest)).toEqual(manifestBytes);
  });

  it("refuses to uninstall a modified managed hook under an ordinary spaced repo path", () => {
    const fixture = createFixture("repo with spaces");
    install(fixture);
    const codexHooks = readJson(fixture.paths.codexHooks);
    const stopHooks = object(codexHooks.hooks).Stop as Array<Record<string, unknown>>;
    const workIntelligenceHook = stopHooks.find((entry) =>
      JSON.stringify(entry).includes("codex-finalize-reminder.js"),
    );
    if (!workIntelligenceHook) throw new Error("The installed Codex Stop hook is missing.");
    workIntelligenceHook.timeout = 1;
    writeJson(fixture.paths.codexHooks, codexHooks);
    const changedBytes = readFileSync(fixture.paths.codexHooks);
    const manifestBytes = readFileSync(fixture.paths.manifest);

    const plan = createAgentSetupPlan(fixture.options, "uninstall");
    expect(plan.conflicts.some((conflict) => conflict.includes("修改"))).toBe(true);
    expect(applyAgentSetupPlan(plan).applied).toBe(false);
    expect(readFileSync(fixture.paths.codexHooks)).toEqual(changedBytes);
    expect(readFileSync(fixture.paths.manifest)).toEqual(manifestBytes);
  });

  it("does not duplicate a changed hook after the repository moves", () => {
    const fixture = createFixture("original repo");
    install(fixture);
    const hooks = readJson(fixture.paths.codexHooks);
    const stopHooks = object(hooks.hooks).Stop as Array<Record<string, unknown>>;
    const workIntelligenceHook = stopHooks.find((entry) =>
      JSON.stringify(entry).includes("codex-finalize-reminder.js"),
    );
    if (!workIntelligenceHook) throw new Error("The installed Codex Stop hook is missing.");
    workIntelligenceHook.timeout = 1;
    writeJson(fixture.paths.codexHooks, hooks);

    const movedRepository = join(fixture.temporaryRoot, "moved repo");
    mkdirSync(join(movedRepository, ".agents", "skills", "work-intelligence"), { recursive: true });
    mkdirSync(join(movedRepository, "apps", "mcp", "dist"), { recursive: true });
    writeFileSync(
      join(movedRepository, ".agents", "skills", "work-intelligence", "SKILL.md"),
      readFileSync(join(fixture.options.repositoryRoot, ".agents", "skills", "work-intelligence", "SKILL.md")),
    );
    for (const filename of ["index.js", "finalize-reminder.js", "codex-finalize-reminder.js"]) {
      writeFileSync(
        join(movedRepository, "apps", "mcp", "dist", filename),
        readFileSync(join(fixture.options.repositoryRoot, "apps", "mcp", "dist", filename)),
      );
    }
    const changedHooks = readFileSync(fixture.paths.codexHooks);
    const manifest = readFileSync(fixture.paths.manifest);
    const movedPlan = createAgentSetupPlan({ ...fixture.options, repositoryRoot: movedRepository });

    expect(movedPlan.conflicts.length).toBeGreaterThan(0);
    expect(applyAgentSetupPlan(movedPlan).applied).toBe(false);
    expect(readFileSync(fixture.paths.codexHooks)).toEqual(changedHooks);
    expect(readFileSync(fixture.paths.manifest)).toEqual(manifest);
  });

  it("quotes POSIX paths with spaces and apostrophes and Windows paths with spaces", () => {
    const posixPath = "/tmp/Work Log O'Brien/apps/mcp/dist/finalize-reminder.js";
    expect(commandForAgentHook(posixPath, "linux")).toBe(
      "node '/tmp/Work Log O'\\''Brien/apps/mcp/dist/finalize-reminder.js'",
    );

    const windowsPath = "C:\\Users\\Dev User\\Work Log.Ai\\apps\\mcp\\dist\\codex-finalize-reminder.js";
    expect(commandForAgentHook(windowsPath, "win32")).toBe(`node "${windowsPath}"`);
  });

  it("executes only the generated command against a harmless stub script with special path characters", () => {
    const fixture = createFixture();
    const scriptPath = join(fixture.options.repositoryRoot, "apps", "mcp", "dist", "finalize-reminder.js");
    writeFileSync(scriptPath, 'process.stdout.write("agent setup fixture marker");\n');
    const command = commandForAgentHook(scriptPath, process.platform);
    const result =
      process.platform === "win32"
        ? spawnSync("cmd.exe", ["/d", "/s", "/c", command], {
            cwd: tmpdir(),
            encoding: "utf8",
            timeout: 15_000,
            windowsVerbatimArguments: true,
          })
        : spawnSync("/bin/sh", ["-c", command], {
            cwd: tmpdir(),
            encoding: "utf8",
            timeout: 15_000,
          });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("agent setup fixture marker");
  });
});
