import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getMcpLeaseScopeId,
  MCP_LEASE_SCOPE_ENVIRONMENT,
  registerMcpLease,
} from "../../packages/shared/src/mcp-runtime.js";
import { readMcpLeaseInput } from "../../packages/desktop-core/src/shell/mcp-lease-input.js";

let base = "";
let runtimeRoot = "";
let configDirectory = "";
const releases: Array<() => void> = [];

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "wi-lease-input-"));
  runtimeRoot = join(base, "App Runtime Root");
  configDirectory = join(base, "config");
  mkdirSync(runtimeRoot, { recursive: true });
  mkdirSync(configDirectory, { recursive: true });
});
afterEach(() => {
  while (releases.length > 0) releases.pop()?.();
  rmSync(base, { recursive: true, force: true });
});

function observe(lease?: unknown): void {
  writeFileSync(
    join(configDirectory, "agent-observations.json"),
    JSON.stringify({
      version: 1,
      observations: {
        "claude-code": {
          contractFingerprint: "e".repeat(64),
          observedAt: "2026-11-19T01:00:00.000Z",
          ...(lease ? { lease } : {}),
        },
      },
    }),
  );
}

describe("readMcpLeaseInput", () => {
  const environment = () => ({ [MCP_LEASE_SCOPE_ENVIRONMENT]: runtimeRoot });

  it("reports the backend scope with no lease and no Agent as plain facts", () => {
    const input = readMcpLeaseInput(runtimeRoot, configDirectory);
    expect(input).toEqual({
      backendScopeId: getMcpLeaseScopeId(runtimeRoot, environment()),
      backendDirectoryWritable: true,
      activeLeases: 0,
      agentObserved: false,
    });
  });

  it("says a different scope when the Agent's MCP recorded another one", () => {
    observe({ scopeId: "9f".repeat(12), directoryWritable: true });
    expect(readMcpLeaseInput(runtimeRoot, configDirectory)).toMatchObject({
      agentObserved: true,
      observedScopeId: "9f".repeat(12),
      observedDirectoryWritable: true,
      cause: "scope_mismatch",
    });
  });

  it("counts a live lease of the same scope and names no cause", () => {
    const registration = registerMcpLease(runtimeRoot, undefined, { environment: environment() });
    releases.push(registration.release);
    observe(registration.registration());
    const input = readMcpLeaseInput(runtimeRoot, configDirectory);
    expect(input).toMatchObject({ activeLeases: 1, agentObserved: true, backendDirectoryWritable: true });
    expect(input).not.toHaveProperty("cause");
  });
});
