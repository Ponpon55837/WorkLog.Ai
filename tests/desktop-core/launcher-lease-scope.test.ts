import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MCP_LEASE_SCOPE_ENVIRONMENT } from "../../packages/shared/src/mcp-runtime.js";
import { runLauncher, type LauncherHost } from "../../packages/desktop-core/src/runtime/index.js";
import { INERT_LEASE_HOST, installFixture, makeRoot } from "./runtime-helpers.js";

let root = "";
let runtimeDirectory = "";

beforeEach(async () => {
  root = await makeRoot("launcher-lease-scope");
  runtimeDirectory = (await installFixture(root, "rt-1", { commit: true })).runtimeDirectory;
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

async function scopeSeenBy(action: string, environment: Record<string, string | undefined> = {}) {
  const env = { ...environment };
  const seen: (string | undefined)[] = [];
  const host: LauncherHost = {
    execPath: path.join(runtimeDirectory, "node/bin/node"),
    versions: { node: "24.0.0" },
    platform: "linux",
    arch: "x64",
    stdout: () => undefined,
    stderr: () => undefined,
    unsetEnv: (name) => void delete env[name],
    getEnv: (name) => env[name],
    setEnv: (name, value) => void (env[name] = value),
    desktopDatabase: () => ({ kind: "none" }),
    setArgv: () => undefined,
    importModule: async () => void seen.push(env[MCP_LEASE_SCOPE_ENVIRONMENT]),
    ...INERT_LEASE_HOST,
  };
  await runLauncher({ runtimeDirectory, argv: [action] }, host);
  return seen;
}

describe("runLauncher's MCP lease scope", () => {
  it("gives the backend and the MCP the same scope, the App's runtime root", async () => {
    const mcp = await scopeSeenBy("mcp");
    const serve = await scopeSeenBy("serve");
    expect(mcp).toHaveLength(1);
    expect(mcp[0]).toBeTruthy();
    expect(serve).toEqual(mcp);
    expect(path.resolve(String(mcp[0]))).toBe(path.resolve(root));
  });

  it("does not leave a stale value from the Agent's environment in charge", async () => {
    const seen = await scopeSeenBy("mcp", { [MCP_LEASE_SCOPE_ENVIRONMENT]: "/somewhere/else" });
    expect(path.resolve(String(seen[0]))).toBe(path.resolve(root));
  });

  it("leaves a hook alone: it keeps no lease", async () => {
    expect(await scopeSeenBy("claude-finalize-reminder")).toEqual([undefined]);
  });
});
