import { describe, expect, it, vi } from "vitest";
import { APP_VERSION } from "../../packages/shared/src/app-version.js";
import {
  parseStandaloneArgs,
  runStandaloneCli,
  standaloneUsage,
  type StandaloneRuntime,
} from "../../apps/server/src/standalone-cli.js";

function fakeRuntime(overrides: Partial<StandaloneRuntime> = {}) {
  const logs: string[] = [];
  const errors: string[] = [];
  const runtime = {
    log: (message: string) => logs.push(message),
    error: (message: string) => errors.push(message),
    start: vi.fn(async () => undefined),
    mcp: vi.fn(async () => undefined),
    check: vi.fn(async () => 0),
    database: vi.fn(async () => 0),
    trackUsage: vi.fn(async () => "track usage"),
    ...overrides,
  } satisfies StandaloneRuntime;
  return { runtime, logs, errors };
}

describe("parseStandaloneArgs", () => {
  it.each([[[]], [["help"]], [["--help"]], [["-h"]]])("shows help for %j", (argv) => {
    expect(parseStandaloneArgs(argv)).toEqual({ kind: "help" });
  });

  it.each([[["--version"]], [["-v"]], [["version"]]])("shows the version for %j", (argv) => {
    expect(parseStandaloneArgs(argv)).toEqual({ kind: "version" });
  });

  it("rejects arguments after --version", () => {
    expect(parseStandaloneArgs(["--version", "x"])).toMatchObject({ kind: "invalid" });
  });

  it.each(["start", "mcp", "check"] as const)("accepts %s without arguments", (command) => {
    expect(parseStandaloneArgs([command])).toEqual({ kind: command });
  });

  it.each(["start", "mcp", "check"] as const)("rejects extra arguments for %s but allows --help", (command) => {
    expect(parseStandaloneArgs([command, "--port", "1"])).toMatchObject({ kind: "invalid" });
    expect(parseStandaloneArgs([command, "--help"])).toEqual({ kind: "help" });
  });

  it("passes track arguments through untouched", () => {
    expect(parseStandaloneArgs(["track", "../project", "--name", "A B", "--yes"])).toEqual({
      kind: "track",
      args: ["../project", "--name", "A B", "--yes"],
    });
    expect(parseStandaloneArgs(["track", "--help"])).toEqual({ kind: "track-help" });
    expect(parseStandaloneArgs(["track"])).toEqual({ kind: "track", args: [] });
  });

  it("passes db arguments through and maps --help to the database usage", () => {
    expect(parseStandaloneArgs(["db", "backups", "--delete", "x.sqlite"])).toEqual({
      kind: "db",
      args: ["backups", "--delete", "x.sqlite"],
    });
    expect(parseStandaloneArgs(["db"])).toEqual({ kind: "db", args: [] });
    expect(parseStandaloneArgs(["db", "--help"])).toEqual({ kind: "db", args: [] });
  });

  it("rejects unknown commands and checkout-only script names", () => {
    expect(parseStandaloneArgs(["bogus"])).toEqual({ kind: "invalid", message: "未知的指令：bogus" });
    expect(parseStandaloneArgs(["db:backup"])).toMatchObject({ kind: "invalid" });
    expect(parseStandaloneArgs(["--port"])).toMatchObject({ kind: "invalid" });
  });
});

describe("runStandaloneCli", () => {
  it("prints the usage with standalone command names and runs nothing", async () => {
    const { runtime, logs } = fakeRuntime();
    expect(await runStandaloneCli([], runtime)).toBe(0);
    expect(logs.join("\n")).toBe(standaloneUsage());
    expect(standaloneUsage()).toContain("work-intelligence db");
    expect(standaloneUsage()).not.toContain("pnpm");
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it("prints the version of the running code", async () => {
    const { runtime, logs } = fakeRuntime();
    expect(await runStandaloneCli(["--version"], runtime)).toBe(0);
    expect(logs).toEqual([`work-intelligence ${APP_VERSION}`]);
  });

  it("exits 2 with the usage for a bad command line", async () => {
    const { runtime, errors } = fakeRuntime();
    expect(await runStandaloneCli(["nope"], runtime)).toBe(2);
    expect(errors[0]).toContain("未知的指令：nope");
    expect(errors[0]).toContain(standaloneUsage());
  });

  it("starts the server and the MCP server through the runtime", async () => {
    const { runtime } = fakeRuntime();
    expect(await runStandaloneCli(["start"], runtime)).toBe(0);
    expect(await runStandaloneCli(["mcp"], runtime)).toBe(0);
    expect(runtime.start).toHaveBeenCalledTimes(1);
    expect(runtime.mcp).toHaveBeenCalledTimes(1);
  });

  it("returns the doctor's exit code", async () => {
    const { runtime } = fakeRuntime({ check: vi.fn(async () => 1) });
    expect(await runStandaloneCli(["check"], runtime)).toBe(1);
  });

  it("hands track and db to the database CLI with the right argument list", async () => {
    const { runtime } = fakeRuntime({ database: vi.fn(async () => 7) });
    expect(await runStandaloneCli(["track", "../p", "--yes"], runtime)).toBe(7);
    expect(await runStandaloneCli(["db", "restore", "x.sqlite"], runtime)).toBe(7);
    expect(await runStandaloneCli(["db"], runtime)).toBe(7);
    expect(runtime.database).toHaveBeenNthCalledWith(1, ["track", "../p", "--yes"]);
    expect(runtime.database).toHaveBeenNthCalledWith(2, ["restore", "x.sqlite"]);
    expect(runtime.database).toHaveBeenNthCalledWith(3, []);
  });

  it("prints the track usage for track --help", async () => {
    const { runtime, logs } = fakeRuntime();
    expect(await runStandaloneCli(["track", "--help"], runtime)).toBe(0);
    expect(logs).toEqual(["track usage"]);
    expect(runtime.database).not.toHaveBeenCalled();
  });

  it("reports a command that throws with a fixed message, never the error text", async () => {
    const { runtime, errors } = fakeRuntime({
      check: vi.fn(async () => {
        throw new Error("secret internal detail at /home/someone");
      }),
    });
    expect(await runStandaloneCli(["check"], runtime)).toBe(1);
    expect(errors.join("\n")).toContain("work-intelligence check");
    expect(errors.join("\n")).not.toContain("secret");
  });
});
