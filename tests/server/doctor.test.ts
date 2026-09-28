import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { inspectDatabaseReadOnlyMetadata, resolveBackupDirectory } from "../../apps/server/src/database-inspection.js";
import {
  collectDoctorFindings,
  inspectAgentConnections,
  inspectDatabaseReadOnly,
  inspectGlobalHooks,
} from "../../apps/server/src/doctor.js";
import { inspectAgentSkillCopies, commandForAgentHook } from "../../apps/server/src/agent-setup.js";
import {
  getMcpRuntimeDirectory,
  getMcpRuntimeStatus,
  readMcpBuildIdentity,
  registerMcpProcess,
} from "../../packages/shared/src/mcp-runtime.js";
import { createMcpRuntimeFixture, finalizeMcpRuntimeFixture } from "../helpers/mcp-runtime-fixture.js";

const temporaryDirectories: string[] = [];
const CODEX_POST_TOOL_USE_MATCHER = "^(apply_patch|.*(work_finalize_session|work_write_idempotent))$";
const LEGACY_CODEX_POST_TOOL_USE_MATCHER = "^(apply_patch|.*work_finalize_session)$";

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "work-intelligence-doctor-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("pnpm doctor read-only checks", () => {
  it("reports the shared stale MCP lease and an outdated skill from isolated fixtures", async () => {
    const directory = temporaryDirectory();
    const homeDirectory = join(directory, "home");
    const codexHome = join(homeDirectory, ".codex");
    const claudeDirectory = join(homeDirectory, ".claude");
    const repositoryRoot = createMcpRuntimeFixture(join(directory, "repository"));
    const canonicalSkill = join(repositoryRoot, ".agents/skills/work-intelligence/SKILL.md");
    const installedSkill = join(homeDirectory, ".agents/skills/work-intelligence/SKILL.md");
    mkdirSync(join(canonicalSkill, ".."), { recursive: true });
    mkdirSync(join(installedSkill, ".."), { recursive: true });
    writeFileSync(canonicalSkill, "canonical skill after A2\n");
    writeFileSync(installedSkill, "stale installed skill\n");

    const runningBuild = readMcpBuildIdentity(repositoryRoot);
    if (!runningBuild) throw new Error("The synthetic doctor runtime has no build identity.");
    const stopMcpProcess = registerMcpProcess(repositoryRoot, runningBuild);
    try {
      writeFileSync(
        join(repositoryRoot, "packages/shared/dist/index.js"),
        'export const runtime = "shared-after-start";\n',
      );
      finalizeMcpRuntimeFixture(repositoryRoot);
      const sharedStatus = getMcpRuntimeStatus(repositoryRoot);
      const findings = await collectDoctorFindings({
        homeDirectory,
        repositoryRoot,
        environment: {
          HOME: homeDirectory,
          CODEX_HOME: codexHome,
          CLAUDE_CONFIG_DIR: claudeDirectory,
          WORK_INTELLIGENCE_DB: join(homeDirectory, "synthetic.sqlite"),
          WORK_INTELLIGENCE_PORT: "65533",
        },
      });
      const mcpFinding = findings.find((finding) => finding.title === "MCP runtime");
      const staleSkillFinding = findings.find((finding) => finding.title === "Codex canonical work-intelligence skill");

      expect(sharedStatus.restartRequired).toBe(true);
      expect(mcpFinding).toMatchObject({
        severity: "warning",
        detail: expect.stringContaining(sharedStatus.message ?? "請重新連線 MCP"),
        recommendation: expect.stringContaining("重新連線"),
      });
      expect(staleSkillFinding).toMatchObject({
        severity: "warning",
        detail: expect.stringContaining("不同"),
        recommendation: expect.stringContaining("pnpm setup:agents"),
      });

      // Windows does not enforce POSIX directory write bits; the shared status test uses a portable probe seam.
      if (process.platform !== "win32") {
        const registryDirectory = getMcpRuntimeDirectory(repositoryRoot);
        chmodSync(registryDirectory, 0o500);
        try {
          const unavailableFindings = await collectDoctorFindings({
            homeDirectory,
            repositoryRoot,
            environment: {
              HOME: homeDirectory,
              CODEX_HOME: codexHome,
              CLAUDE_CONFIG_DIR: claudeDirectory,
              WORK_INTELLIGENCE_DB: join(homeDirectory, "synthetic.sqlite"),
              WORK_INTELLIGENCE_PORT: "65533",
            },
          });
          expect(unavailableFindings.find((finding) => finding.title === "MCP runtime")).toMatchObject({
            severity: "warning",
            detail: expect.stringContaining("無法確認"),
          });
        } finally {
          chmodSync(registryDirectory, 0o700);
        }
      }
    } finally {
      stopMcpProcess();
      rmSync(getMcpRuntimeDirectory(repositoryRoot), { recursive: true, force: true });
    }
  });
  it("checks database integrity and schema metadata without changing the database", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "synthetic.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec(
      "CREATE TABLE schema_migrations (version INTEGER NOT NULL, name TEXT NOT NULL, applied_at TEXT NOT NULL);" +
        "INSERT INTO schema_migrations VALUES (12, 'synthetic', '2026-09-25T00:00:00.000Z');" +
        "CREATE TABLE database_maintenance_runs (id TEXT, started_at TEXT, completed_at TEXT, status TEXT, " +
        "backup_file_name TEXT, indexed_sessions INTEGER, indexed_knowledge INTEGER, indexed_chunks INTEGER, " +
        "indexed_paths INTEGER, failure_code TEXT);" +
        "INSERT INTO database_maintenance_runs VALUES ('synthetic', '2026-09-25T01:00:00.000Z', " +
        "'2026-09-25T01:01:00.000Z', 'completed', 'synthetic-backup.sqlite', 3, 1, 8, 2, NULL);",
    );
    database.close();
    const before = createHash("sha256").update(readFileSync(databasePath)).digest("hex");

    await expect(inspectDatabaseReadOnly(databasePath)).resolves.toMatchObject({
      state: "ok",
      integrity: "ok",
      schemaVersion: 12,
      maintenance: {
        status: "completed",
        backupFileName: "synthetic-backup.sqlite",
        indexedSessions: 3,
        indexedKnowledge: 1,
      },
    });

    const after = createHash("sha256").update(readFileSync(databasePath)).digest("hex");
    expect(after).toBe(before);
  });

  it("shares metadata inspection without running the full integrity check", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "metadata-only.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec(
      "CREATE TABLE schema_migrations (version INTEGER NOT NULL, name TEXT NOT NULL, applied_at TEXT NOT NULL);" +
        "INSERT INTO schema_migrations VALUES (12, 'synthetic', '2026-09-25T00:00:00.000Z');" +
        "CREATE TABLE database_maintenance_runs (id TEXT, started_at TEXT, completed_at TEXT, status TEXT, " +
        "backup_file_name TEXT, indexed_sessions INTEGER, indexed_knowledge INTEGER, indexed_chunks INTEGER, " +
        "indexed_paths INTEGER, failure_code TEXT);",
    );
    database.close();
    const before = createHash("sha256").update(readFileSync(databasePath)).digest("hex");

    const inspection = await inspectDatabaseReadOnlyMetadata(databasePath);
    expect(inspection).toMatchObject({ state: "ok", bytes: expect.any(Number), schemaVersion: 12, maintenance: null });
    expect(inspection.integrity).toBeUndefined();
    expect(resolveBackupDirectory(join(directory, "db.sqlite"), "custom/backups")).toBe(
      join(directory, "custom/backups"),
    );

    const after = createHash("sha256").update(readFileSync(databasePath)).digest("hex");
    expect(after).toBe(before);
  });

  it("checks only global hook configuration and requires both Codex events", () => {
    const directory = temporaryDirectory();
    const homeDirectory = join(directory, "home");
    const repositoryRoot = join(directory, "repository");
    const claudeHook = resolve(repositoryRoot, "apps/mcp/dist/finalize-reminder.js");
    const codexHook = resolve(repositoryRoot, "apps/mcp/dist/codex-finalize-reminder.js");
    mkdirSync(join(homeDirectory, ".claude"), { recursive: true });
    mkdirSync(join(homeDirectory, ".codex"), { recursive: true });
    const claudeSettingsPath = join(homeDirectory, ".claude", "settings.json");
    const codexHooksPath = join(homeDirectory, ".codex", "hooks.json");
    const claudeSettings = JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "node " + JSON.stringify(claudeHook) }] }],
      },
    });
    const codexHooks = JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            matcher: LEGACY_CODEX_POST_TOOL_USE_MATCHER,
            hooks: [{ type: "command", command: "node " + JSON.stringify(codexHook) }],
          },
        ],
        Stop: [{ hooks: [{ type: "command", command: "node " + JSON.stringify(codexHook) }] }],
      },
    });
    writeFileSync(claudeSettingsPath, claudeSettings);
    writeFileSync(codexHooksPath, codexHooks);

    expect(inspectGlobalHooks(homeDirectory, repositoryRoot)).toEqual({
      claudeConfigured: true,
      codexConfigured: false,
      codexSegmentStartConfigured: false,
      codexHooksFeature: "enabled",
    });

    const dispatcherMatcherHooks = JSON.parse(codexHooks) as { hooks: Record<string, unknown> };
    const dispatcherPostToolUse = dispatcherMatcherHooks.hooks.PostToolUse as Array<Record<string, unknown>>;
    if (!dispatcherPostToolUse[0]) throw new Error("The PostToolUse hook fixture is missing.");
    dispatcherPostToolUse[0].matcher = CODEX_POST_TOOL_USE_MATCHER;
    writeFileSync(codexHooksPath, JSON.stringify(dispatcherMatcherHooks));
    expect(inspectGlobalHooks(homeDirectory, repositoryRoot).codexConfigured).toBe(true);

    const withPromptHook = JSON.parse(codexHooks) as { hooks: Record<string, unknown> };
    withPromptHook.hooks.UserPromptSubmit = [
      { hooks: [{ type: "command", command: "node " + JSON.stringify(codexHook) }] },
    ];
    (withPromptHook.hooks.PostToolUse as Array<Record<string, unknown>>)[0]!.matcher = CODEX_POST_TOOL_USE_MATCHER;
    writeFileSync(codexHooksPath, JSON.stringify(withPromptHook));
    expect(inspectGlobalHooks(homeDirectory, repositoryRoot)).toMatchObject({
      codexConfigured: true,
      codexSegmentStartConfigured: true,
    });

    writeFileSync(
      codexHooksPath,
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: CODEX_POST_TOOL_USE_MATCHER,
              hooks: [{ type: "command", command: "node " + JSON.stringify(codexHook) }],
            },
          ],
        },
      }),
    );
    expect(inspectGlobalHooks(homeDirectory, repositoryRoot).codexConfigured).toBe(false);
    expect(readFileSync(claudeSettingsPath, "utf8")).toBe(claudeSettings);
  });

  it("recognizes a Claude Stop hook written in exec form with the script in args", () => {
    const directory = temporaryDirectory();
    const homeDirectory = join(directory, "home");
    const repositoryRoot = join(directory, "repository");
    const claudeHook = resolve(repositoryRoot, "apps/mcp/dist/finalize-reminder.js");
    mkdirSync(join(homeDirectory, ".claude"), { recursive: true });
    const claudeSettingsPath = join(homeDirectory, ".claude", "settings.json");
    const settingsWith = (args: string[]) =>
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "/usr/local/bin/node", args }] }] } });

    writeFileSync(claudeSettingsPath, settingsWith([claudeHook]));
    expect(inspectGlobalHooks(homeDirectory, repositoryRoot).claudeConfigured).toBe(true);

    writeFileSync(claudeSettingsPath, settingsWith([resolve(directory, "other/finalize-reminder.js")]));
    expect(inspectGlobalHooks(homeDirectory, repositoryRoot).claudeConfigured).toBe(false);
  });

  it("recognizes platform-quoted hook commands under apostrophe paths and respects Codex config roots", () => {
    const directory = temporaryDirectory();
    const homeDirectory = join(directory, "home");
    const repositoryRoot = join(directory, "repository O'Brien");
    const codexHomeDirectory = join(directory, "codex-home");
    const claudeConfigDirectory = join(directory, "claude-config");
    const claudeHook = resolve(repositoryRoot, "apps/mcp/dist/finalize-reminder.js");
    const codexHook = resolve(repositoryRoot, "apps/mcp/dist/codex-finalize-reminder.js");
    mkdirSync(join(claudeConfigDirectory), { recursive: true });
    mkdirSync(codexHomeDirectory, { recursive: true });
    writeFileSync(
      join(claudeConfigDirectory, "settings.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: commandForAgentHook(claudeHook, process.platform) }] }],
        },
      }),
    );
    writeFileSync(
      join(codexHomeDirectory, "hooks.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: CODEX_POST_TOOL_USE_MATCHER,
              hooks: [{ type: "command", command: commandForAgentHook(codexHook, process.platform) }],
            },
          ],
          Stop: [{ hooks: [{ type: "command", command: commandForAgentHook(codexHook, process.platform) }] }],
        },
      }),
    );
    writeFileSync(join(codexHomeDirectory, "config.toml"), "[features]\ncodex_hooks = false\n");

    expect(inspectGlobalHooks(homeDirectory, repositoryRoot, codexHomeDirectory, claudeConfigDirectory)).toEqual({
      claudeConfigured: true,
      codexConfigured: true,
      codexSegmentStartConfigured: false,
      codexHooksFeature: "disabled",
    });
  });

  it("detects missing, current, and stale user-scope skill copies by raw content hash", () => {
    const directory = temporaryDirectory();
    const homeDirectory = join(directory, "home");
    const repositoryRoot = join(directory, "repository");
    const codexHomeDirectory = join(directory, "custom-codex");
    const claudeConfigDirectory = join(directory, "custom-claude");
    const sourcePath = join(repositoryRoot, ".agents", "skills", "work-intelligence", "SKILL.md");
    const source = Buffer.from("<!-- Work Intelligence skill version: 0.1.0 -->\nCanonical bytes\n", "utf8");
    mkdirSync(join(repositoryRoot, ".agents", "skills", "work-intelligence"), { recursive: true });
    writeFileSync(sourcePath, source);

    expect(
      inspectAgentSkillCopies(homeDirectory, repositoryRoot, codexHomeDirectory, claudeConfigDirectory),
    ).toMatchObject([
      { componentId: "codexSkill", state: "missing" },
      { componentId: "codexLegacySkill", state: "missing" },
      { componentId: "claudeSkill", state: "missing" },
    ]);
    const codexSkill = join(homeDirectory, ".agents", "skills", "work-intelligence", "SKILL.md");
    const codexLegacySkill = join(codexHomeDirectory, "skills", "work-intelligence", "SKILL.md");
    const claudeSkill = join(claudeConfigDirectory, "skills", "work-intelligence", "SKILL.md");
    mkdirSync(join(homeDirectory, ".agents", "skills", "work-intelligence"), { recursive: true });
    mkdirSync(join(codexHomeDirectory, "skills", "work-intelligence"), { recursive: true });
    mkdirSync(join(claudeConfigDirectory, "skills", "work-intelligence"), { recursive: true });
    writeFileSync(codexSkill, source);
    writeFileSync(codexLegacySkill, source);
    writeFileSync(claudeSkill, Buffer.from(source.toString("utf8").replace("Canonical", "Modified"), "utf8"));

    expect(
      inspectAgentSkillCopies(homeDirectory, repositoryRoot, codexHomeDirectory, claudeConfigDirectory),
    ).toMatchObject([
      { componentId: "codexSkill", state: "current" },
      { componentId: "codexLegacySkill", state: "current" },
      { componentId: "claudeSkill", state: "stale" },
    ]);
  });

  it("shares read-only Agent diagnostics without changing isolated settings", () => {
    const directory = temporaryDirectory();
    const homeDirectory = join(directory, "home");
    const repositoryRoot = join(directory, "repository");
    const codexHomeDirectory = join(homeDirectory, ".codex");
    const claudeConfigDirectory = join(homeDirectory, ".claude");
    const skill = Buffer.from("<!-- Work Intelligence skill version: 0.1.0 -->\nCanonical skill\n", "utf8");
    const skillPaths = [
      join(homeDirectory, ".agents", "skills", "work-intelligence", "SKILL.md"),
      join(codexHomeDirectory, "skills", "work-intelligence", "SKILL.md"),
      join(claudeConfigDirectory, "skills", "work-intelligence", "SKILL.md"),
    ];
    const claudeHook = resolve(repositoryRoot, "apps/mcp/dist/finalize-reminder.js");
    const codexHook = resolve(repositoryRoot, "apps/mcp/dist/codex-finalize-reminder.js");
    const configPaths = [
      join(homeDirectory, ".claude.json"),
      join(codexHomeDirectory, "config.toml"),
      join(codexHomeDirectory, "hooks.json"),
      join(claudeConfigDirectory, "settings.json"),
    ];
    mkdirSync(join(repositoryRoot, ".agents", "skills", "work-intelligence"), { recursive: true });
    mkdirSync(join(repositoryRoot, "apps/mcp/dist"), { recursive: true });
    mkdirSync(join(homeDirectory, ".agents", "skills", "work-intelligence"), { recursive: true });
    mkdirSync(join(codexHomeDirectory, "skills", "work-intelligence"), { recursive: true });
    mkdirSync(join(claudeConfigDirectory, "skills", "work-intelligence"), { recursive: true });
    writeFileSync(join(repositoryRoot, ".agents", "skills", "work-intelligence", "SKILL.md"), skill);
    for (const path of skillPaths) writeFileSync(path, skill);
    writeFileSync(claudeHook, "// fixture\n");
    writeFileSync(codexHook, "// fixture\n");
    mkdirSync(codexHomeDirectory, { recursive: true });
    mkdirSync(claudeConfigDirectory, { recursive: true });
    writeFileSync(join(homeDirectory, ".claude.json"), JSON.stringify({ mcpServers: { "work-intelligence": {} } }));
    writeFileSync(join(codexHomeDirectory, "config.toml"), "[mcp_servers.work-intelligence]\ncommand = 'node'\n");
    writeFileSync(
      join(codexHomeDirectory, "hooks.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: CODEX_POST_TOOL_USE_MATCHER,
              hooks: [{ type: "command", command: commandForAgentHook(codexHook, process.platform) }],
            },
          ],
          Stop: [{ hooks: [{ type: "command", command: commandForAgentHook(codexHook, process.platform) }] }],
        },
      }),
    );
    writeFileSync(
      join(claudeConfigDirectory, "settings.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: commandForAgentHook(claudeHook, process.platform) }] }],
        },
      }),
    );
    const before = [...configPaths, ...skillPaths].map((path) => readFileSync(path));

    expect(
      inspectAgentConnections({
        homeDirectory,
        repositoryRoot,
        environment: { HOME: homeDirectory, CODEX_HOME: codexHomeDirectory, CLAUDE_CONFIG_DIR: claudeConfigDirectory },
      }),
    ).toEqual({
      codex: {
        mcpRegistered: "registered",
        canonicalSkill: "current",
        legacySkill: "current",
        hook: "installed",
      },
      claudeCode: { mcpRegistered: "registered", skill: "current", hook: "installed" },
    });
    expect([...configPaths, ...skillPaths].map((path) => readFileSync(path))).toEqual(before);
  });

  it("distinguishes absent and unreadable Agent configs in Doctor findings without rewriting them", async () => {
    const directory = temporaryDirectory();
    const homeDirectory = join(directory, "home");
    const repositoryRoot = join(directory, "repository");
    const codexHomeDirectory = join(homeDirectory, ".codex");
    const claudeConfigDirectory = join(homeDirectory, ".claude");
    const codexConfigPath = join(codexHomeDirectory, "config.toml");
    const claudeMcpPath = join(homeDirectory, ".claude.json");
    const codexHooksPath = join(codexHomeDirectory, "hooks.json");
    const claudeSettingsPath = join(claudeConfigDirectory, "settings.json");
    mkdirSync(join(repositoryRoot, "apps/mcp/dist"), { recursive: true });
    mkdirSync(codexHomeDirectory, { recursive: true });
    mkdirSync(claudeConfigDirectory, { recursive: true });
    writeFileSync(join(repositoryRoot, "apps/mcp/dist/codex-finalize-reminder.js"), "// fixture\n");
    writeFileSync(join(repositoryRoot, "apps/mcp/dist/finalize-reminder.js"), "// fixture\n");
    const options = {
      homeDirectory,
      repositoryRoot,
      environment: { HOME: homeDirectory, CODEX_HOME: codexHomeDirectory, CLAUDE_CONFIG_DIR: claudeConfigDirectory },
    };
    const doctorOptions = {
      ...options,
      environment: {
        ...options.environment,
        WORK_INTELLIGENCE_DB: join(directory, "synthetic.sqlite"),
        WORK_INTELLIGENCE_PORT: "65533",
      },
    };

    expect(inspectAgentConnections(options)).toMatchObject({
      codex: { mcpRegistered: "missing", hook: "missing" },
      claudeCode: { mcpRegistered: "missing", hook: "missing" },
    });
    const missingFindings = await collectDoctorFindings(doctorOptions);
    expect(missingFindings.find((finding) => finding.title === "Claude MCP")?.detail).toContain("未找到");
    expect(missingFindings.find((finding) => finding.title === "Codex MCP")?.detail).toContain("未找到");
    expect(missingFindings.find((finding) => finding.title === "Claude 全域 hook")?.detail).toContain("沒有指向");
    expect(missingFindings.find((finding) => finding.title === "Codex 全域 hook")?.detail).toContain("未同時設定");

    writeFileSync(claudeMcpPath, "{ malformed json");
    mkdirSync(codexConfigPath);
    mkdirSync(codexHooksPath);
    mkdirSync(claudeSettingsPath);
    const before = readFileSync(claudeMcpPath);

    expect(inspectAgentConnections(options)).toMatchObject({
      codex: { mcpRegistered: "unknown", hook: "unknown" },
      claudeCode: { mcpRegistered: "unknown", hook: "unknown" },
    });
    const unknownFindings = await collectDoctorFindings(doctorOptions);
    expect(unknownFindings.find((finding) => finding.title === "Claude MCP")).toMatchObject({
      severity: "warning",
      detail: expect.stringContaining("無法判定"),
      recommendation: expect.stringContaining("可讀"),
    });
    expect(unknownFindings.find((finding) => finding.title === "Codex MCP")).toMatchObject({
      severity: "warning",
      detail: expect.stringContaining("無法判定"),
      recommendation: expect.stringContaining("可讀"),
    });
    expect(unknownFindings.find((finding) => finding.title === "Claude 全域 hook")).toMatchObject({
      severity: "warning",
      detail: expect.stringContaining("無法判定"),
      recommendation: expect.stringContaining("可讀"),
    });
    expect(unknownFindings.find((finding) => finding.title === "Codex 全域 hook")).toMatchObject({
      severity: "warning",
      detail: expect.stringContaining("無法判定"),
      recommendation: expect.stringContaining("可讀"),
    });

    rmSync(codexConfigPath, { recursive: true });
    writeFileSync(codexConfigPath, "[features]\nhooks = true\n");
    expect(inspectAgentConnections(options)).toMatchObject({
      codex: { mcpRegistered: "missing", hook: "unknown" },
      claudeCode: { mcpRegistered: "unknown", hook: "unknown" },
    });
    const mixedFindings = await collectDoctorFindings(doctorOptions);
    expect(mixedFindings.find((finding) => finding.title === "Codex MCP")?.detail).toContain("未找到");
    expect(mixedFindings.find((finding) => finding.title === "Codex 全域 hook")?.detail).toContain("無法判定");
    expect(readFileSync(claudeMcpPath)).toEqual(before);
    expect(readFileSync(codexConfigPath, "utf8")).toBe("[features]\nhooks = true\n");
  });

  it("reports malformed Codex TOML as unknown without changing config bytes", async () => {
    const directory = temporaryDirectory();
    const homeDirectory = join(directory, "home");
    const repositoryRoot = join(directory, "repository");
    const codexHomeDirectory = join(homeDirectory, ".codex");
    const claudeConfigDirectory = join(homeDirectory, ".claude");
    const codexConfigPath = join(codexHomeDirectory, "config.toml");
    const codexHooksPath = join(codexHomeDirectory, "hooks.json");
    const codexHookPath = join(repositoryRoot, "apps/mcp/dist/codex-finalize-reminder.js");
    mkdirSync(codexHomeDirectory, { recursive: true });
    mkdirSync(claudeConfigDirectory, { recursive: true });
    mkdirSync(join(repositoryRoot, "apps/mcp/dist"), { recursive: true });
    writeFileSync(codexHookPath, "// fixture\n");
    writeFileSync(
      codexHooksPath,
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: CODEX_POST_TOOL_USE_MATCHER,
              hooks: [{ type: "command", command: commandForAgentHook(codexHookPath, process.platform) }],
            },
          ],
          Stop: [{ hooks: [{ type: "command", command: commandForAgentHook(codexHookPath, process.platform) }] }],
        },
      }),
    );
    const hooksBefore = readFileSync(codexHooksPath);
    const options = {
      homeDirectory,
      repositoryRoot,
      environment: { HOME: homeDirectory, CODEX_HOME: codexHomeDirectory, CLAUDE_CONFIG_DIR: claudeConfigDirectory },
    };
    const doctorOptions = {
      ...options,
      environment: {
        ...options.environment,
        WORK_INTELLIGENCE_DB: join(directory, "synthetic.sqlite"),
        WORK_INTELLIGENCE_PORT: "65533",
      },
    };
    const malformedConfigs = [
      '[mcp_servers.work-intelligence]\ncommand = "unterminated',
      'setting = "unterminated\n[mcp_servers.work-intelligence]\ncommand = "node"\n',
      '[mcp_servers.work-intelligence]\ncommand = "node"\n[features]\nhooks = "unterminated',
      '[mcp_servers.work-intelligence]\nargs = ["node" # EOF comment',
    ];

    for (const configText of malformedConfigs) {
      writeFileSync(codexConfigPath, configText);
      const before = readFileSync(codexConfigPath);

      expect(inspectAgentConnections(options)).toMatchObject({
        codex: { mcpRegistered: "unknown", hook: "unknown" },
      });
      const findings = await collectDoctorFindings(doctorOptions);
      expect(findings.find((finding) => finding.title === "Codex MCP")).toMatchObject({
        severity: "warning",
        detail: expect.stringContaining("無法判定"),
        recommendation: expect.stringContaining("格式有效"),
      });
      expect(findings.find((finding) => finding.title === "Codex 全域 hook")).toMatchObject({
        severity: "warning",
        detail: expect.stringContaining("無法判定"),
      });
      expect(readFileSync(codexConfigPath)).toEqual(before);
      expect(readFileSync(codexHooksPath)).toEqual(hooksBefore);
    }
  });
});
