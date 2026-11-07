import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SystemAgentConnections } from "../../packages/core/src/index.js";
import { databaseUsage, runDatabaseCli } from "../../apps/server/src/cli.js";
import { diagnoseDatabaseInUse } from "../../apps/server/src/database-busy-diagnosis.js";
import {
  collectDoctorFindings,
  inspectStandalonePackage,
  STANDALONE_LIBEXEC_FILES,
  STANDALONE_PACKAGE_FILES,
} from "../../apps/server/src/doctor.js";
import { describeListenError } from "../../apps/server/src/listen-error.js";
import { collectStartupHints } from "../../apps/server/src/startup-check.js";
import { runTrackCommand, trackUsage } from "../../apps/server/src/track-cli.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "work-intelligence-standalone-messages-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A package folder with every shipped file and the given versions. */
function fakePackage(versions: { package?: string; libexec?: string } = {}): {
  packageRoot: string;
  libexecRoot: string;
} {
  const packageRoot = temporaryDirectory();
  const libexecRoot = join(packageRoot, "libexec");
  const put = (root: string, file: string, content = ""): void => {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), content);
  };
  for (const file of STANDALONE_PACKAGE_FILES) put(packageRoot, file);
  for (const file of STANDALONE_LIBEXEC_FILES) put(libexecRoot, file);
  put(packageRoot, "package.json", JSON.stringify({ version: versions.package ?? "9.9.9" }));
  put(libexecRoot, "package.json", JSON.stringify({ version: versions.libexec ?? "9.9.9" }));
  return { packageRoot, libexecRoot };
}

function connections(): SystemAgentConnections {
  return {
    codex: { mcpRegistered: "registered", canonicalSkill: "stale", legacySkill: "current", hook: "stale" },
    claudeCode: { mcpRegistered: "registered", skill: "current", hook: "installed" },
  };
}

describe("command names in messages", () => {
  it("names pnpm commands in a checkout and work-intelligence commands standalone", () => {
    expect(describeListenError({ code: "EADDRINUSE" }, 3210, false)).toContain("pnpm check");
    expect(describeListenError({ code: "EADDRINUSE" }, 3210, true)).toContain("work-intelligence check");
    expect(describeListenError({ code: "EADDRINUSE" }, 3210, true)).not.toContain("pnpm");
    expect(describeListenError(new Error("x"), 3210, true)).toContain("work-intelligence check");

    const staleHooks = collectStartupHints({ inspectConnections: connections, standalone: true });
    expect(staleHooks.join("\n")).toContain("work-intelligence setup");
    expect(staleHooks.join("\n")).toContain("work-intelligence setup-agents");
    expect(staleHooks.join("\n")).not.toContain("pnpm");
    expect(collectStartupHints({ inspectConnections: connections, standalone: false }).join("\n")).toContain(
      "pnpm bootstrap",
    );

    expect(trackUsage(false)).toContain("pnpm track <資料夾>");
    expect(trackUsage(true)).toContain("work-intelligence track <資料夾>");
    expect(trackUsage(true)).not.toContain("pnpm");

    const usage = databaseUsage(true);
    expect(usage).toContain("work-intelligence db backups --delete <檔名>");
    expect(usage).toContain("work-intelligence track <資料夾>");
    expect(usage).not.toContain("pnpm");
    expect(databaseUsage(false)).toContain("pnpm db:backups --delete <檔名>");
    expect(databaseUsage(false)).toContain("pnpm dev／pnpm start:server");
  });

  it("uses standalone names in database CLI errors and the busy-database diagnosis", async () => {
    const errors: string[] = [];
    const exitCode = await runDatabaseCli(["maintain", "extra"], {
      standalone: true,
      log: () => undefined,
      error: (message) => errors.push(message),
    });
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("work-intelligence db maintain 不接受參數");
    expect(errors.join("\n")).not.toContain("pnpm");

    const lines = await diagnoseDatabaseInUse("/unused", {
      standalone: true,
      platform: "linux",
      port: 3999,
      probeServer: async () => true,
      getServiceStatus: () => ({ state: "running" }),
      getMcpStatus: () => ({ activeProcesses: 0, monitoringAvailable: true }),
    });
    expect(lines.join("\n")).toContain("work-intelligence service uninstall");
    expect(lines.join("\n")).toContain("work-intelligence service install");
    expect(lines.join("\n")).not.toContain("pnpm");
  });

  it("uses standalone names in track errors", async () => {
    const errors: string[] = [];
    const exitCode = await runTrackCommand([], {
      standalone: true,
      withStore: () => {
        throw new Error("unused");
      },
      invocationDirectory: temporaryDirectory(),
      log: () => undefined,
      error: (message) => errors.push(message),
    });
    expect(exitCode).toBe(2);
    expect(errors.join("\n")).toContain("work-intelligence track <資料夾>");
  });
});

describe("doctor in a standalone package", () => {
  async function standaloneFindings(
    layout: { packageRoot: string; libexecRoot: string },
    appVersion = "9.9.9",
  ): Promise<Awaited<ReturnType<typeof collectDoctorFindings>>> {
    const home = temporaryDirectory();
    return collectDoctorFindings({
      standalone: true,
      repositoryRoot: layout.libexecRoot,
      packageRoot: layout.packageRoot,
      appVersion,
      homeDirectory: home,
      environment: {
        HOME: home,
        WORK_INTELLIGENCE_CONFIG_DIR: join(home, "config"),
        WORK_INTELLIGENCE_PORT: "65531",
      },
    });
  }

  it("checks the package instead of pnpm, dist freshness, the service manager and root SQLite files", async () => {
    const layout = fakePackage();
    writeFileSync(join(layout.libexecRoot, "stray.sqlite"), "");
    const findings = await standaloneFindings(layout);
    const titles = findings.map((finding) => finding.title);
    expect(titles).toEqual(
      expect.arrayContaining(["Node.js", "套件檔案", "套件版本", "登入自動啟動服務", "資料庫", "API"]),
    );
    expect(titles).not.toContain("pnpm");
    expect(titles).not.toContain("Build 檔案");
    expect(titles).not.toContain("MCP runtime");
    expect(titles).not.toContain("repo 根目錄的資料庫檔");
    expect(findings.find((finding) => finding.title === "套件檔案")).toMatchObject({ severity: "ok" });
    expect(findings.find((finding) => finding.title === "套件版本")).toMatchObject({ severity: "ok" });
    expect(findings.find((finding) => finding.title === "登入自動啟動服務")?.severity).toBe("ok");
    expect(JSON.stringify(findings)).not.toContain("pnpm");
  });

  it("resolves the database from the config directory and names it in the report", async () => {
    const layout = fakePackage();
    const findings = await standaloneFindings(layout);
    expect(findings.find((finding) => finding.title === "資料庫")?.detail).toContain(
      join("config", "data", "work-intelligence.sqlite"),
    );
    expect(findings.find((finding) => finding.title === "資料庫")?.recommendation).toBe(
      "第一次啟動 work-intelligence start 後會建立資料庫。",
    );
  });

  it("reports missing package files by name and tells the user to reinstall", async () => {
    const layout = fakePackage();
    rmSync(join(layout.packageRoot, "web", "index.html"));
    rmSync(join(layout.libexecRoot, "apps/mcp/dist/index.js"));
    const finding = (await standaloneFindings(layout)).find((item) => item.title === "套件檔案");
    expect(finding).toMatchObject({ severity: "warning", recommendation: expect.stringContaining("重新下載") });
    expect(finding?.detail).toContain("web/index.html");
    expect(finding?.detail).toContain("libexec/apps/mcp/dist/index.js");
  });

  it("flags a package whose pieces disagree about the version", async () => {
    const finding = (await standaloneFindings(fakePackage({ libexec: "9.9.8" }))).find(
      (item) => item.title === "套件版本",
    );
    expect(finding).toMatchObject({ severity: "warning" });
    expect(finding?.detail).toContain("9.9.8");
    expect((await standaloneFindings(fakePackage(), "9.9.7")).find((item) => item.title === "套件版本")?.severity).toBe(
      "warning",
    );
  });

  it("inspects without throwing when package.json is unreadable", () => {
    const layout = fakePackage();
    writeFileSync(join(layout.packageRoot, "package.json"), "{ not json");
    const inspection = inspectStandalonePackage({ ...layout, appVersion: "9.9.9" });
    expect(inspection.versions.package).toBeUndefined();
    expect(inspection.versionsAgree).toBe(false);
    expect(inspection.missingFiles).toEqual([]);
  });

  it("still checks a checkout the old way when not standalone", async () => {
    const home = temporaryDirectory();
    const findings = await collectDoctorFindings({
      standalone: false,
      repositoryRoot: join(home, "repository"),
      homeDirectory: home,
      userServiceStatus: {
        supported: false,
        state: "unsupported",
        manager: null,
        enabled: false,
        running: false,
        configPath: join(home, "service.conf"),
        databasePath: join(home, "data.sqlite"),
        backupDirectory: join(home, "backups"),
        logPath: join(home, "server.log"),
      },
      environment: { HOME: home, WORK_INTELLIGENCE_DB: join(home, "x.sqlite"), WORK_INTELLIGENCE_PORT: "65531" },
    });
    const titles = findings.map((finding) => finding.title);
    expect(titles).toEqual(expect.arrayContaining(["pnpm", "Build 檔案", "MCP runtime"]));
    expect(titles).not.toContain("套件檔案");
  });
});
