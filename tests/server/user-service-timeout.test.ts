import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getUserServiceStatusAsync } from "../../apps/server/src/user-service.js";

// execFile is wrapped so a test can read the options the production code passes and shorten only the timeout value.
const execFileCalls = vi.hoisted(() => ({ options: [] as Array<Record<string, unknown>>, timeoutOverrideMs: 0 }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const actualAsync = promisify(actual.execFile);
  const wrapped = ((...args: unknown[]) =>
    (actual.execFile as (...values: unknown[]) => unknown)(...args)) as typeof actual.execFile;
  Object.defineProperty(wrapped, promisify.custom, {
    value: (file: string, args: readonly string[], options: Record<string, unknown>) => {
      execFileCalls.options.push(options);
      const timeout =
        execFileCalls.timeoutOverrideMs > 0 ? execFileCalls.timeoutOverrideMs : (options.timeout as number);
      return actualAsync(file, args, { ...options, timeout });
    },
  });
  return { ...actual, execFile: wrapped };
});

const temporaryDirectories: string[] = [];
const originalPath = process.env.PATH;

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "work-intelligence-service-timeout-"));
  temporaryDirectories.push(directory);
  return directory;
}

function linuxOptions(root: string) {
  return {
    platform: "linux" as const,
    homeDirectory: join(root, "home"),
    repositoryRoot: join(root, "repository"),
    environment: { HOME: join(root, "home"), WORK_INTELLIGENCE_DB: join(root, "data", "database.sqlite") },
    configFileExists: () => true,
  };
}

function timeoutError(): Error {
  // The shape Node's execFile gives a child that outlived `timeout`: killed with the default SIGTERM.
  return Object.assign(new Error("Command failed: systemctl"), { killed: true, signal: "SIGTERM", code: null });
}

afterEach(() => {
  process.env.PATH = originalPath;
  execFileCalls.options.length = 0;
  execFileCalls.timeoutOverrideMs = 0;
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("service status host query timeout", () => {
  it("reports a runner that was killed by its timeout as unavailable instead of throwing", async () => {
    const status = await getUserServiceStatusAsync({
      ...linuxOptions(temporaryDirectory()),
      runCommand: async () => {
        throw timeoutError();
      },
    });
    expect(status).toMatchObject({ state: "unavailable", supported: true, running: false, enabled: true });
  });

  it.skipIf(process.platform === "win32")(
    "passes a 10 second timeout and a hidden window to the real asynchronous execFile",
    async () => {
      const root = temporaryDirectory();
      // An empty PATH directory makes the spawn fail with ENOENT after the options were recorded.
      process.env.PATH = join(root, "empty-bin");
      const status = await getUserServiceStatusAsync(linuxOptions(root));
      expect(status.state).toBe("unavailable");
      expect(execFileCalls.options).toHaveLength(1);
      expect(execFileCalls.options[0]).toMatchObject({ timeout: 10_000, windowsHide: true, encoding: "utf8" });
    },
  );

  it.skipIf(process.platform === "win32")(
    "kills a hung real child at the timeout, reports unavailable and keeps the event loop running",
    async () => {
      const root = temporaryDirectory();
      const binDirectory = join(root, "bin");
      const script = join(binDirectory, "systemctl");
      mkdirSync(binDirectory, { recursive: true });
      writeFileSync(script, "#!/bin/sh\nexec sleep 30\n");
      chmodSync(script, 0o755);
      process.env.PATH = `${binDirectory}${delimiter}${originalPath ?? ""}`;
      execFileCalls.timeoutOverrideMs = 150;
      let ticks = 0;
      const ticker = setInterval(() => ticks++, 10);
      const started = Date.now();
      try {
        const status = await getUserServiceStatusAsync(linuxOptions(root));
        expect(status).toMatchObject({ state: "unavailable", running: false });
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(ticks).toBeGreaterThanOrEqual(5);
      } finally {
        clearInterval(ticker);
      }
    },
  );
});
