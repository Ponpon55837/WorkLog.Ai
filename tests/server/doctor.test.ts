import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { UserServiceManager, UserServiceStatus } from "../../packages/core/src/index.js";
import { inspectDatabaseReadOnlyMetadata, resolveBackupDirectory } from "../../apps/server/src/database-inspection.js";
import {
  collectDoctorFindings as collectDoctorFindingsFromHost,
  inspectAgentConnections,
  inspectDatabaseReadOnly,
  inspectGlobalHooks,
  pnpmRequirementSatisfied,
  wideDatabasePermissions,
  shouldSuggestReclaim,
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

function isolatedUserServiceStatus(directory: string): UserServiceStatus {
  const manager: UserServiceManager | null =
    process.platform === "darwin"
      ? "LaunchAgent"
      : process.platform === "linux"
        ? "systemd --user"
        : process.platform === "win32"
          ? "Task Scheduler"
          : null;
  return {
    supported: manager !== null,
    state: manager ? "not_installed" : "unsupported",
    manager,
    enabled: false,
    running: false,
    configPath: join(directory, "service", "work-intelligence.conf"),
    databasePath: join(directory, "data", "work-intelligence.sqlite"),
    backupDirectory: join(directory, "data", "backups"),
    logPath: join(directory, "logs", "server.log"),
  };
}

function collectDoctorFindings(options: Parameters<typeof collectDoctorFindingsFromHost>[0] = {}) {
  const directory = options.repositoryRoot ?? options.homeDirectory ?? temporaryDirectory();
  return collectDoctorFindingsFromHost({
    ...options,
    userServiceStatus: options.userServiceStatus ?? isolatedUserServiceStatus(directory),
  });
}

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
  it("warns about top-level SQLite files in the repository root without reading or removing them", async () => {
    const directory = temporaryDirectory();
    const repositoryRoot = join(directory, "repository");
    mkdirSync(repositoryRoot, { recursive: true });
    writeFileSync(join(repositoryRoot, "stray-synthetic.sqlite"), "not a database");
    writeFileSync(join(repositoryRoot, "stray-synthetic.sqlite-wal"), "");
    mkdirSync(join(repositoryRoot, "nested"));
    writeFileSync(join(repositoryRoot, "nested", "ignored.sqlite"), "");

    const findings = await collectDoctorFindings({
      repositoryRoot,
      homeDirectory: join(directory, "home"),
      environment: { HOME: join(directory, "home"), WORK_INTELLIGENCE_DB: join(directory, "synthetic.sqlite") },
    });

    const finding = findings.find((item) => item.title === "repo 根目錄的資料庫檔");
    expect(finding).toMatchObject({ severity: "warning", recommendation: expect.stringContaining("自行搬移或刪除") });
    expect(finding?.detail).toContain("stray-synthetic.sqlite");
    expect(finding?.detail).toContain("stray-synthetic.sqlite-wal");
    expect(finding?.detail).not.toContain("ignored.sqlite");
    expect(readFileSync(join(repositoryRoot, "stray-synthetic.sqlite"), "utf8")).toBe("not a database");
  });

  it("stays quiet about the repository root when it holds no SQLite files", async () => {
    const directory = temporaryDirectory();
    const repositoryRoot = join(directory, "repository");
    mkdirSync(repositoryRoot, { recursive: true });
    const findings = await collectDoctorFindings({
      repositoryRoot,
      homeDirectory: join(directory, "home"),
      environment: { HOME: join(directory, "home"), WORK_INTELLIGENCE_DB: join(directory, "synthetic.sqlite") },
    });
    expect(findings.some((item) => item.title === "repo 根目錄的資料庫檔")).toBe(false);
  });

  it("reports a relative database path as ok with the absolute path resolved from the repository root", async () => {
    const directory = temporaryDirectory();
    const repositoryRoot = join(directory, "repository");
    mkdirSync(repositoryRoot, { recursive: true });
    const findings = await collectDoctorFindings({
      repositoryRoot,
      homeDirectory: join(directory, "home"),
      environment: { HOME: join(directory, "home"), WORK_INTELLIGENCE_DB: "relative/synthetic.sqlite" },
    });
    expect(findings.find((item) => item.title === "資料庫路徑")).toMatchObject({
      severity: "ok",
      detail: expect.stringContaining(resolve(repositoryRoot, "relative", "synthetic.sqlite")),
    });
  });

  it.skipIf(process.platform !== "win32")(
    "reports a drive-relative database path as an error instead of aborting",
    async () => {
      const directory = temporaryDirectory();
      const repositoryRoot = join(directory, "repository");
      mkdirSync(repositoryRoot, { recursive: true });
      const findings = await collectDoctorFindings({
        repositoryRoot,
        homeDirectory: join(directory, "home"),
        environment: { HOME: join(directory, "home"), WORK_INTELLIGENCE_DB: "C:fixture\\synthetic.sqlite" },
      });
      expect(findings.find((item) => item.title === "資料庫路徑")).toMatchObject({
        severity: "error",
        recommendation: expect.stringContaining("正斜線"),
      });
    },
  );

  it("warns when the login service is running but disabled for future logins", async () => {
    const directory = temporaryDirectory();
    const status = isolatedUserServiceStatus(directory);
    status.state = "running";
    status.enabled = false;
    status.running = true;

    const findings = await collectDoctorFindings({
      homeDirectory: join(directory, "home"),
      repositoryRoot: join(directory, "repository"),
      environment: {
        HOME: join(directory, "home"),
        WORK_INTELLIGENCE_DB: join(directory, "synthetic.sqlite"),
        WORK_INTELLIGENCE_PORT: "65533",
      },
      userServiceStatus: status,
    });

    expect(findings.find((finding) => finding.title === "登入自動啟動服務")).toMatchObject({
      severity: "warning",
      detail: expect.stringContaining("正在執行"),
      recommendation: expect.stringContaining("pnpm service:status"),
    });
  });

  it("does not recommend reconnecting a healthy registered MCP runtime", async () => {
    const directory = temporaryDirectory();
    const repositoryRoot = createMcpRuntimeFixture(join(directory, "repository"));
    const identity = readMcpBuildIdentity(repositoryRoot);
    if (!identity) throw new Error("Missing fixture identity");
    const stop = registerMcpProcess(repositoryRoot, identity);
    try {
      const findings = await collectDoctorFindings({
        repositoryRoot,
        homeDirectory: join(directory, "home"),
        environment: {
          HOME: join(directory, "home"),
          WORK_INTELLIGENCE_DB: join(directory, "fixture.sqlite"),
          WORK_INTELLIGENCE_PORT: "65533",
        },
      });
      expect(findings.find((item) => item.title === "MCP runtime")).toMatchObject({
        severity: "ok",
        recommendation: undefined,
      });
    } finally {
      stop();
    }
  });

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
      const entryPath = join(repositoryRoot, "apps/mcp/dist/index.js");
      writeFileSync(
        entryPath,
        readFileSync(entryPath, "utf8").replace(
          /const MCP_BUILD_COMPATIBILITY_ID = "[a-f0-9]{64}";/,
          `const MCP_BUILD_COMPATIBILITY_ID = "${"b".repeat(64)}";`,
        ),
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

      const registryDirectory = getMcpRuntimeDirectory(repositoryRoot);
      // A file where the registry directory belongs makes the write probe fail on every platform, also for root,
      // which ignores permission bits.
      rmSync(registryDirectory, { recursive: true, force: true });
      writeFileSync(registryDirectory, "");
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
        rmSync(registryDirectory, { force: true });
        mkdirSync(registryDirectory, { recursive: true, mode: 0o700 });
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

  it.skipIf(process.platform === "win32")("reports a database file or folder that other users can access", () => {
    const directory = temporaryDirectory();
    const dataDirectory = join(directory, "data");
    mkdirSync(dataDirectory);
    const databasePath = join(dataDirectory, "synthetic.sqlite");
    writeFileSync(databasePath, "");
    chmodSync(dataDirectory, 0o755);
    chmodSync(databasePath, 0o644);
    expect(wideDatabasePermissions(databasePath)).toEqual([
      { path: databasePath, mode: "644" },
      { path: dataDirectory, mode: "755" },
    ]);
    chmodSync(dataDirectory, 0o700);
    chmodSync(databasePath, 0o600);
    expect(wideDatabasePermissions(databasePath)).toEqual([]);
    expect(wideDatabasePermissions(join(dataDirectory, "missing.sqlite"))).toEqual([]);
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

  it("reports free pages as reclaimable space without changing the database", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "reclaimable.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec(
      "CREATE TABLE schema_migrations (version INTEGER NOT NULL, name TEXT NOT NULL, applied_at TEXT NOT NULL);" +
        "INSERT INTO schema_migrations VALUES (30, 'synthetic', '2026-10-16T00:00:00.000Z');" +
        "CREATE TABLE filler (body BLOB);",
    );
    const insert = database.prepare("INSERT INTO filler VALUES (zeroblob(65536))");
    for (let index = 0; index < 40; index += 1) insert.run();
    database.exec("DROP TABLE filler;");
    database.close();
    const before = createHash("sha256").update(readFileSync(databasePath)).digest("hex");

    const inspection = await inspectDatabaseReadOnlyMetadata(databasePath);
    expect(inspection.state).toBe("ok");
    expect(inspection.reclaimableBytes).toBeGreaterThanOrEqual(40 * 65536);
    expect(shouldSuggestReclaim(inspection.reclaimableBytes ?? 0, inspection.bytes ?? 0)).toBe(true);

    const after = createHash("sha256").update(readFileSync(databasePath)).digest("hex");
    expect(after).toBe(before);
  });

  it("suggests db:maintain only above the reclaimable-space thresholds", () => {
    const mebibyte = 1024 * 1024;
    expect(shouldSuggestReclaim(0, 20 * mebibyte)).toBe(false);
    // Under 1 MiB is never worth it, whatever the share.
    expect(shouldSuggestReclaim(mebibyte - 1, 2 * mebibyte)).toBe(false);
    // 5 MiB is enough on its own.
    expect(shouldSuggestReclaim(5 * mebibyte, 500 * mebibyte)).toBe(true);
    expect(shouldSuggestReclaim(4 * mebibyte, 100 * mebibyte)).toBe(false);
    // 20% of the file is enough once past 1 MiB.
    expect(shouldSuggestReclaim(2 * mebibyte, 10 * mebibyte)).toBe(true);
    expect(shouldSuggestReclaim(2 * mebibyte, 11 * mebibyte)).toBe(false);
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
      codexLegacyMatcher: true,
      codexSegmentStartConfigured: false,
      claudeCompactionConfigured: false,
      codexCompactionConfigured: false,
      claudeStartGuardConfigured: false,
      codexStartGuardConfigured: false,
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

    // The compaction hooks count only with a matcher that selects `compact` (or none).
    const withCompactionHooks = JSON.parse(JSON.stringify(withPromptHook)) as { hooks: Record<string, unknown> };
    withCompactionHooks.hooks.SessionStart = [
      { matcher: "startup", hooks: [{ type: "command", command: "node " + JSON.stringify(codexHook) }] },
    ];
    writeFileSync(codexHooksPath, JSON.stringify(withCompactionHooks));
    expect(inspectGlobalHooks(homeDirectory, repositoryRoot).codexCompactionConfigured).toBe(false);
    for (const matcher of ["compact", "startup|compact", "^(resume|compact)$", undefined]) {
      withCompactionHooks.hooks.SessionStart = [
        {
          ...(matcher === undefined ? {} : { matcher }),
          hooks: [{ type: "command", command: "node " + JSON.stringify(codexHook) }],
        },
      ];
      writeFileSync(codexHooksPath, JSON.stringify(withCompactionHooks));
      expect(inspectGlobalHooks(homeDirectory, repositoryRoot).codexCompactionConfigured).toBe(true);
    }

    // Claude needs both: PreCompact feeds the summary, SessionStart (compact) restores the reminder afterwards.
    const claudeHandler = [{ type: "command", command: "node " + JSON.stringify(claudeHook) }];
    const claudeWithPreCompact = JSON.parse(claudeSettings) as { hooks: Record<string, unknown> };
    claudeWithPreCompact.hooks.PreCompact = [{ hooks: claudeHandler }];
    writeFileSync(claudeSettingsPath, JSON.stringify(claudeWithPreCompact));
    expect(inspectGlobalHooks(homeDirectory, repositoryRoot).claudeCompactionConfigured).toBe(false);
    claudeWithPreCompact.hooks.SessionStart = [{ matcher: "compact", hooks: claudeHandler }];
    writeFileSync(claudeSettingsPath, JSON.stringify(claudeWithPreCompact));
    expect(inspectGlobalHooks(homeDirectory, repositoryRoot).claudeCompactionConfigured).toBe(true);
    // The start guard counts only with a PreToolUse matcher that selects the finalize dispatcher.
    claudeWithPreCompact.hooks.PreToolUse = [{ matcher: "^Bash$", hooks: claudeHandler }];
    writeFileSync(claudeSettingsPath, JSON.stringify(claudeWithPreCompact));
    expect(inspectGlobalHooks(homeDirectory, repositoryRoot).claudeStartGuardConfigured).toBe(false);
    claudeWithPreCompact.hooks.PreToolUse = [
      { matcher: "^mcp__.*(work_finalize_session|work_write_idempotent)$", hooks: claudeHandler },
    ];
    writeFileSync(claudeSettingsPath, JSON.stringify(claudeWithPreCompact));
    expect(inspectGlobalHooks(homeDirectory, repositoryRoot).claudeStartGuardConfigured).toBe(true);
    writeFileSync(claudeSettingsPath, claudeSettings);

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
      codexLegacyMatcher: false,
      codexSegmentStartConfigured: false,
      claudeCompactionConfigured: false,
      codexCompactionConfigured: false,
      claudeStartGuardConfigured: false,
      codexStartGuardConfigured: false,
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

    // A hook installed before the MCP dispatchers is stale, not missing: re-running setup upgrades it.
    const legacyHooks = JSON.parse(readFileSync(join(codexHomeDirectory, "hooks.json"), "utf8")) as {
      hooks: { PostToolUse: Array<Record<string, unknown>> };
    };
    legacyHooks.hooks.PostToolUse[0]!.matcher = LEGACY_CODEX_POST_TOOL_USE_MATCHER;
    writeFileSync(join(codexHomeDirectory, "hooks.json"), JSON.stringify(legacyHooks));
    expect(
      inspectAgentConnections({
        homeDirectory,
        repositoryRoot,
        environment: { HOME: homeDirectory, CODEX_HOME: codexHomeDirectory, CLAUDE_CONFIG_DIR: claudeConfigDirectory },
      }).codex.hook,
    ).toBe("stale");

    legacyHooks.hooks.PostToolUse[0]!.matcher = "^apply_patch$";
    writeFileSync(join(codexHomeDirectory, "hooks.json"), JSON.stringify(legacyHooks));
    expect(
      inspectAgentConnections({
        homeDirectory,
        repositoryRoot,
        environment: { HOME: homeDirectory, CODEX_HOME: codexHomeDirectory, CLAUDE_CONFIG_DIR: claudeConfigDirectory },
      }).codex.hook,
    ).toBe("missing");
  });

  it("reports a registration that runs the server entry point directly, which needs a reconnect after builds", async () => {
    const directory = temporaryDirectory();
    const homeDirectory = join(directory, "home");
    const repositoryRoot = join(directory, "repository");
    const codexHomeDirectory = join(homeDirectory, ".codex");
    const claudeConfigDirectory = join(homeDirectory, ".claude");
    mkdirSync(join(repositoryRoot, "apps/mcp/dist"), { recursive: true });
    mkdirSync(codexHomeDirectory, { recursive: true });
    mkdirSync(claudeConfigDirectory, { recursive: true });
    const serverPath = join(repositoryRoot, "apps/mcp/dist/index.js");
    const launcherPath = join(repositoryRoot, "apps/mcp/dist/launcher.js");
    writeFileSync(
      join(homeDirectory, ".claude.json"),
      JSON.stringify({ mcpServers: { "work-intelligence": { command: "node", args: [serverPath] } } }),
    );
    writeFileSync(
      join(codexHomeDirectory, "config.toml"),
      `[mcp_servers.work-intelligence]\ncommand = "node"\nargs = [${JSON.stringify(launcherPath)}]\n`,
    );
    const environment = {
      HOME: homeDirectory,
      CODEX_HOME: codexHomeDirectory,
      CLAUDE_CONFIG_DIR: claudeConfigDirectory,
      WORK_INTELLIGENCE_DB: join(directory, "synthetic.sqlite"),
      WORK_INTELLIGENCE_PORT: "65533",
    };
    const connections = inspectAgentConnections({ homeDirectory, repositoryRoot, environment });
    expect(connections.claudeCode.mcpRegistered).toBe("direct");
    expect(connections.codex.mcpRegistered).toBe("registered");

    const findings = await collectDoctorFindings({ homeDirectory, repositoryRoot, environment });
    expect(findings.find((finding) => finding.title === "Claude MCP")).toMatchObject({
      severity: "warning",
      detail: expect.stringContaining("每次 pnpm build 後都要重新連線"),
      recommendation: expect.stringContaining("pnpm setup:agents"),
    });
    expect(findings.find((finding) => finding.title === "Codex MCP")).toMatchObject({ severity: "ok" });
  });

  it("reports missing compaction hooks next to an installed save reminder without downgrading it", async () => {
    const directory = temporaryDirectory();
    const homeDirectory = join(directory, "home");
    const repositoryRoot = join(directory, "repository");
    const codexHomeDirectory = join(homeDirectory, ".codex");
    const claudeConfigDirectory = join(homeDirectory, ".claude");
    const claudeHook = resolve(repositoryRoot, "apps/mcp/dist/finalize-reminder.js");
    const codexHook = resolve(repositoryRoot, "apps/mcp/dist/codex-finalize-reminder.js");
    mkdirSync(join(repositoryRoot, "apps/mcp/dist"), { recursive: true });
    mkdirSync(codexHomeDirectory, { recursive: true });
    mkdirSync(claudeConfigDirectory, { recursive: true });
    writeFileSync(claudeHook, "// fixture\n");
    writeFileSync(codexHook, "// fixture\n");
    const claudeHandler = [{ type: "command", command: commandForAgentHook(claudeHook, process.platform) }];
    const codexHandler = [{ type: "command", command: commandForAgentHook(codexHook, process.platform) }];
    const claudeHooks: Record<string, unknown> = { Stop: [{ hooks: claudeHandler }] };
    const codexHooks: Record<string, unknown> = {
      PostToolUse: [{ matcher: CODEX_POST_TOOL_USE_MATCHER, hooks: codexHandler }],
      Stop: [{ hooks: codexHandler }],
      UserPromptSubmit: [{ hooks: codexHandler }],
    };
    const write = () => {
      writeFileSync(join(claudeConfigDirectory, "settings.json"), JSON.stringify({ hooks: claudeHooks }));
      writeFileSync(join(codexHomeDirectory, "hooks.json"), JSON.stringify({ hooks: codexHooks }));
    };
    const doctorOptions = {
      homeDirectory,
      repositoryRoot,
      environment: {
        HOME: homeDirectory,
        CODEX_HOME: codexHomeDirectory,
        CLAUDE_CONFIG_DIR: claudeConfigDirectory,
        WORK_INTELLIGENCE_DB: join(directory, "synthetic.sqlite"),
        WORK_INTELLIGENCE_PORT: "65533",
      },
    };
    write();

    let findings = await collectDoctorFindings(doctorOptions);
    expect(findings.find((finding) => finding.title === "Claude 全域 hook")).toMatchObject({
      severity: "ok",
      detail: expect.stringContaining("未設定 PreCompact 與 SessionStart（compact）hook"),
      recommendation: expect.stringContaining("setup:agents"),
    });
    expect(findings.find((finding) => finding.title === "Codex 全域 hook")).toMatchObject({
      severity: "ok",
      detail: expect.stringContaining("未設定壓縮後提醒的 SessionStart（compact）hook"),
      recommendation: expect.stringContaining("setup:agents"),
    });

    expect(findings.find((finding) => finding.title === "Codex 全域 hook")?.detail).toContain("未設定 PreToolUse hook");
    claudeHooks.PreCompact = [{ hooks: claudeHandler }];
    claudeHooks.SessionStart = [{ matcher: "compact", hooks: claudeHandler }];
    codexHooks.SessionStart = [{ matcher: "compact", hooks: codexHandler }];
    write();

    // Only the PreToolUse guard is missing: the recommendation points at setup:agents instead of a generic check.
    findings = await collectDoctorFindings(doctorOptions);
    expect(findings.find((finding) => finding.title === "Claude 全域 hook")).toMatchObject({
      severity: "ok",
      detail: expect.stringContaining("未設定 PreToolUse hook（保存前提示開始時間）"),
      recommendation:
        "執行 pnpm setup:agents，預覽後確認即可補上 PreToolUse hook（保存前提示開始時間），或更新 plugin。",
    });
    expect(findings.find((finding) => finding.title === "Codex 全域 hook")).toMatchObject({
      severity: "ok",
      detail: expect.stringContaining("未設定 PreToolUse hook（保存前提示開始時間）"),
      recommendation:
        "執行 pnpm setup:agents 補上缺少的選用 hook；之後在 Codex 執行 /hooks，檢視並信任 Work Intelligence hooks。",
    });

    claudeHooks.PreToolUse = [
      { matcher: "^mcp__.*(work_finalize_session|work_write_idempotent)$", hooks: claudeHandler },
    ];
    codexHooks.PreToolUse = [{ matcher: "^.*(work_finalize_session|work_write_idempotent)$", hooks: codexHandler }];
    write();
    findings = await collectDoctorFindings(doctorOptions);
    expect(findings.find((finding) => finding.title === "Claude 全域 hook")).toMatchObject({
      detail: expect.stringContaining("Stop、PreCompact 與 SessionStart（compact）hook 已設定"),
      recommendation: "在 Claude Code 工作階段確認 Stop hook 執行與提醒結果。",
    });
    expect(findings.find((finding) => finding.title === "Codex 全域 hook")).toMatchObject({
      severity: "ok",
      detail:
        "PostToolUse、Stop 與 UserPromptSubmit hook 已設定；Codex 仍需在 /hooks 審查並信任，doctor 沒有執行 hook。",
      recommendation: expect.stringContaining("/hooks"),
    });
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

describe("pnpm requirement", () => {
  it("accepts the engines.pnpm minimum this repository declares as well as an exact packageManager pin", () => {
    expect(pnpmRequirementSatisfied("11.16.0", ">=11.16.0")).toBe(true);
    expect(pnpmRequirementSatisfied("11.28.3", ">=11.16.0")).toBe(true);
    expect(pnpmRequirementSatisfied("12.0.0", ">= 11.16.0")).toBe(true);
    expect(pnpmRequirementSatisfied("11.15.9", ">=11.16.0")).toBe(false);
    expect(pnpmRequirementSatisfied("10.30.0", ">=11.16.0")).toBe(false);
    expect(pnpmRequirementSatisfied("11.16.0", "11.16.0")).toBe(true);
    expect(pnpmRequirementSatisfied("11.17.0", "11.16.0")).toBe(false);
    expect(pnpmRequirementSatisfied(undefined, ">=11.16.0")).toBe(false);
    expect(pnpmRequirementSatisfied("11.16.0", "未知")).toBe(false);
  });
});
