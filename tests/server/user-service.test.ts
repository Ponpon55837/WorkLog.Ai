import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, posix, win32 } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import {
  createUserServicePlan,
  formatUserServicePreview,
  getUserServiceStatus,
  installUserServiceWithConfirmation,
  uninstallUserService,
  type UserServicePlatform,
} from "../../apps/server/src/user-service.js";

const temporaryDirectories: string[] = [];
const supportedPlatforms = ["darwin", "linux", "win32"] as const;

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "work-intelligence-service-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function managerFor(platform: UserServicePlatform): string {
  return platform === "darwin" ? "LaunchAgent" : platform === "linux" ? "systemd --user" : "Task Scheduler";
}

function temporaryRootForPlatform(platform: UserServicePlatform, root: string): string {
  const name = basename(root);
  if (platform === "win32") {
    return process.platform === "win32" ? root : win32.join("C:\\", "Temp", name);
  }
  return process.platform === "win32" ? posix.join("/tmp", name) : root;
}

function createPlan(platform: Exclude<UserServicePlatform, "unsupported">, root: string) {
  const win = platform === "win32";
  const targetRoot = temporaryRootForPlatform(platform, root);
  const pathJoin = win ? win32.join : posix.join;
  const homeDirectory = pathJoin(targetRoot, "home with spaces");
  const repositoryRoot = pathJoin(targetRoot, "repository with spaces");
  const databasePath = pathJoin(targetRoot, "database", "work-intelligence.sqlite");
  const backupDirectory = pathJoin(targetRoot, "database", "snapshots");
  const packageManagerExecutable = win ? "C:\\Program Files\\pnpm\\pnpm.cmd" : posix.join(targetRoot, "bin", "pnpm");
  const nodeExecutable = win ? "C:\\Program Files\\nodejs\\node.exe" : "/usr/bin/node";
  const environment: NodeJS.ProcessEnv = {
    HOME: homeDirectory,
    USERPROFILE: homeDirectory,
    LOCALAPPDATA: win ? win32.join(homeDirectory, "AppData", "Local") : undefined,
    XDG_CONFIG_HOME: win ? undefined : posix.join(homeDirectory, ".config"),
    XDG_STATE_HOME: win ? undefined : posix.join(homeDirectory, ".local", "state"),
    WORK_INTELLIGENCE_DB: databasePath,
    WORK_INTELLIGENCE_BACKUP_DIR: backupDirectory,
    PATH: process.env.PATH ?? delimiter,
  };
  return createUserServicePlan({
    platform,
    homeDirectory,
    repositoryRoot,
    environment,
    nodeExecutable,
    packageManagerExecutable,
    userId: "S-1-5-21-1000",
    uid: 501,
  });
}

function makeStatusOptions(platform: Exclude<UserServicePlatform, "unsupported">, root: string) {
  const win = platform === "win32";
  const targetRoot = temporaryRootForPlatform(platform, root);
  const pathJoin = win ? win32.join : posix.join;
  const homeDirectory = pathJoin(targetRoot, "status home");
  return {
    platform,
    homeDirectory,
    repositoryRoot: pathJoin(targetRoot, "repository"),
    environment: {
      HOME: win ? undefined : homeDirectory,
      USERPROFILE: win ? homeDirectory : undefined,
      LOCALAPPDATA: win ? win32.join(homeDirectory, "AppData", "Local") : undefined,
      WORK_INTELLIGENCE_DB: pathJoin(targetRoot, "data", "database.sqlite"),
      WORK_INTELLIGENCE_BACKUP_DIR: pathJoin(targetRoot, "data", "backups"),
    },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("user-level login service definitions", () => {
  it.each(supportedPlatforms)("generates a %s service for the shared Work Intelligence database", (platform) => {
    const root = temporaryDirectory();
    const targetRoot = temporaryRootForPlatform(platform, root);
    const plan = createPlan(platform, root);
    const contents = plan.files[0]?.contents ?? "";
    const preview = formatUserServicePreview(plan);

    expect(plan.manager).toBe(managerFor(platform));
    expect(plan.configPath).toContain(
      platform === "win32" ? win32.join(targetRoot, "home with spaces") : posix.join(targetRoot, "home with spaces"),
    );
    expect(plan.databasePath).toContain("work-intelligence.sqlite");
    expect(plan.backupDirectory).toMatch(/snapshots$/);
    expect(plan.logPath).toMatch(/server\.log$/);
    expect(contents).toContain(plan.databasePath);
    expect(contents).toContain(plan.backupDirectory);
    expect(preview).toContain("執行命令：pnpm start（正式模式）");
    expect(preview).toContain(plan.logPath);

    if (platform === "darwin") {
      expect(contents).toContain("<key>RunAtLoad</key>");
      expect(contents).toContain("<key>KeepAlive</key>");
      expect(contents).toContain("<key>ProgramArguments</key>");
    } else if (platform === "linux") {
      expect(contents).toContain("WantedBy=default.target");
      expect(contents).toContain("Restart=on-failure");
      expect(contents).toContain("ExecStart=");
    } else {
      expect(contents).toContain("<LogonTrigger>");
      expect(contents).toContain("<LogonType>InteractiveToken</LogonType>");
      expect(contents).toContain("<RunLevel>LeastPrivilege</RunLevel>");
      expect(contents).toContain('<Task version="1.4"');
    }
  });

  it("uses the repository data path by default and resolves relative backup paths beside that database", () => {
    const plan = createUserServicePlan({
      platform: "linux",
      homeDirectory: "/home/tester",
      repositoryRoot: "/workspace/WorkLog.Ai",
      environment: { HOME: "/home/tester", WORK_INTELLIGENCE_BACKUP_DIR: "snapshots" },
      nodeExecutable: "/usr/bin/node",
      packageManagerExecutable: "/usr/bin/pnpm",
    });

    expect(plan.databasePath).toBe("/workspace/WorkLog.Ai/data/work-intelligence.sqlite");
    expect(plan.backupDirectory).toBe("/workspace/WorkLog.Ai/data/snapshots");
  });

  it("escapes XML paths and describes every file before asking for confirmation", async () => {
    const root = temporaryDirectory();
    const targetRoot = temporaryRootForPlatform("darwin", root);
    const plan = createUserServicePlan({
      platform: "darwin",
      homeDirectory: `${targetRoot}/R&D`,
      repositoryRoot: `${targetRoot}/Work & Intelligence`,
      environment: { HOME: `${targetRoot}/R&D`, WORK_INTELLIGENCE_DB: `${targetRoot}/db.sqlite` },
      nodeExecutable: "/usr/bin/node",
      packageManagerExecutable: "/usr/local/bin/pnpm",
    });
    const order: string[] = [];
    const installed = await installUserServiceWithConfirmation(
      plan,
      (preview) => {
        order.push("preview");
        expect(preview).toContain("<string>");
      },
      async () => {
        order.push("confirm");
        return false;
      },
      () => {
        throw new Error("A declined installation must not call the service manager.");
      },
    );

    expect(plan.files[0]?.contents).toContain("R&amp;D");
    expect(plan.files[0]?.contents).toContain("Work &amp; Intelligence");
    expect(order).toEqual(["preview", "confirm"]);
    expect(installed).toBe(false);
    expect(existsSync(plan.configPath)).toBe(false);
    expect(existsSync(dirname(plan.configPath))).toBe(false);
    expect(existsSync(plan.backupDirectory)).toBe(false);
  });

  it("writes only the temporary service config after confirmation and preserves data on uninstall", async () => {
    const root = temporaryDirectory();
    const plan = createPlan(process.platform as Exclude<UserServicePlatform, "unsupported">, root);
    const managerCalls: Array<{ command: string; args: string[] }> = [];
    const runCommand = (command: string, args: string[]) => {
      managerCalls.push({ command, args });
      return "";
    };
    const installed = await installUserServiceWithConfirmation(
      plan,
      () => undefined,
      async () => true,
      runCommand,
    );

    expect(installed).toBe(true);
    expect(existsSync(plan.configPath)).toBe(true);
    expect(readFileSync(plan.configPath, "utf8")).toBe(plan.files[0]?.contents);
    expect(managerCalls.length).toBeGreaterThan(0);
    expect(existsSync(plan.databasePath)).toBe(false);

    mkdirSync(dirname(plan.databasePath), { recursive: true });
    mkdirSync(plan.backupDirectory, { recursive: true });
    mkdirSync(dirname(plan.logPath), { recursive: true });
    writeFileSync(plan.databasePath, "synthetic database");
    writeFileSync(join(plan.backupDirectory, "backup.sqlite"), "synthetic backup");
    writeFileSync(plan.logPath, "synthetic log");
    uninstallUserService(plan, runCommand);

    expect(existsSync(plan.configPath)).toBe(false);
    expect(readFileSync(plan.databasePath, "utf8")).toBe("synthetic database");
    expect(readFileSync(join(plan.backupDirectory, "backup.sqlite"), "utf8")).toBe("synthetic backup");
    expect(readFileSync(plan.logPath, "utf8")).toBe("synthetic log");
  });
});

describe("read-only login service status", () => {
  it.each(supportedPlatforms)("reports the %s manager state without installing a service", (platform) => {
    const root = temporaryDirectory();
    const options = makeStatusOptions(platform, root);
    const commands: string[] = [];
    const runCommand = (command: string, args: string[]): string => {
      commands.push(`${command} ${args.join(" ")}`);
      if (platform === "darwin") return "state = running\npid = 456\n";
      if (platform === "linux") return "LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n";
      return JSON.stringify({ state: "Running", enabled: true });
    };
    const status = getUserServiceStatus({
      ...options,
      configFileExists: () => true,
      runCommand,
      uid: 501,
    });

    expect(status).toMatchObject({ state: "running", enabled: true, running: true });
    expect(status.manager).toBe(managerFor(platform));
    expect(status.databasePath).toBe(options.environment.WORK_INTELLIGENCE_DB);
    expect(status.backupDirectory).toBe(options.environment.WORK_INTELLIGENCE_BACKUP_DIR);
    expect(commands.length).toBe(1);
    if (platform === "win32") expect(commands[0]).toContain(String.raw`-TaskPath '\'`);
  });

  it("reports an absent macOS or Linux config as not installed without calling the manager", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const root = temporaryDirectory();
      const targetRoot = temporaryRootForPlatform(platform, root);
      const status = getUserServiceStatus({
        platform,
        homeDirectory: posix.join(targetRoot, "home"),
        repositoryRoot: posix.join(targetRoot, "repository"),
        environment: { HOME: posix.join(targetRoot, "home") },
        runCommand: () => {
          throw new Error("No manager command should run when the service config is absent.");
        },
      });
      expect(status).toMatchObject({ state: "not_installed", enabled: false, running: false });
    }
  });

  it("reports unsupported operating systems without probing a manager", () => {
    const status = getUserServiceStatus({
      platform: "unsupported",
      homeDirectory: "/tmp/work-intelligence-unsupported",
      repositoryRoot: "/workspace/WorkLog.Ai",
      environment: { HOME: "/tmp/work-intelligence-unsupported" },
      runCommand: () => {
        throw new Error("Unsupported platforms must not run an OS service manager.");
      },
    });

    expect(status).toMatchObject({
      supported: false,
      state: "unsupported",
      manager: null,
      configPath: null,
      logPath: "/tmp/work-intelligence-unsupported/.work-intelligence/logs/server.log",
    });
  });
});
