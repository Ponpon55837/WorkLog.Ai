import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryOperationJournalStore,
  OperationCoordinator,
  OperationJournal,
  launcherShimPath,
  readCurrentContractFingerprint,
  readHostObservations,
} from "../../packages/desktop-core/dist/index.js";
import { createAgentsPage } from "../../apps/desktop/src/main/agents.js";

/**
 * The Agent cards read what the MCP server recorded in `agent-observations.json` (the same config directory the server
 * writes) and compare it with the fingerprint the installed runtime ships. Everything here is synthetic.
 */

const CURRENT = "a".repeat(64);
const OLD = "b".repeat(64);
const RUNTIME_ID = "runtime-1";

let root: string;
let home: string;
let configDirectory: string;
let runtimeRoot: string;

function writeRuntimeFingerprint(fingerprint: string | undefined): void {
  const dist = join(runtimeRoot, "runtimes", RUNTIME_ID, "app", "libexec", "apps", "mcp", "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(runtimeRoot, "current"), `${RUNTIME_ID}\n`);
  if (fingerprint !== undefined) {
    writeFileSync(
      join(dist, "contract-fingerprint.json"),
      JSON.stringify({ version: 1, contractFingerprint: fingerprint }),
    );
  }
}

function writeObservations(entries: Record<string, { contractFingerprint: string; observedAt?: string }>): void {
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(
    join(configDirectory, "agent-observations.json"),
    JSON.stringify({
      version: 1,
      observations: Object.fromEntries(
        Object.entries(entries).map(([name, value]) => [
          name,
          {
            clientName: name,
            clientVersion: "1",
            protocolVersion: "2025-06-18",
            serverVersion: "1.0.0",
            observedAt: "2026-01-01T00:00:00.000Z",
            ...value,
          },
        ]),
      ),
    }),
  );
}

function cards() {
  const journal = new OperationJournal(new InMemoryOperationJournalStore());
  const skill = join(root, "SKILL.md");
  writeFileSync(skill, "# skill\n");
  const page = createAgentsPage({
    state: { databasePath: () => null } as never,
    coordinator: new OperationCoordinator(journal),
    paths: { runtimeRoot },
    skillSourcePath: skill,
    log: () => undefined,
    offerDatabase: async () => undefined,
  });
  return Object.fromEntries(page.snapshot().cards.map((card) => [card.id, card.state]));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wi-observed-"));
  home = join(root, "home");
  configDirectory = join(root, "config");
  runtimeRoot = join(root, "runtime");
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("CODEX_HOME", "");
  vi.stubEnv("CLAUDE_CONFIG_DIR", "");
  vi.stubEnv("WORK_INTELLIGENCE_CONFIG_DIR", configDirectory);
  // Both Agents registered with the App's launcher, as the App writes it.
  const shim = launcherShimPath(runtimeRoot, process.platform);
  mkdirSync(join(runtimeRoot, "bin"), { recursive: true });
  writeFileSync(shim, "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(
    join(home, ".codex", "config.toml"),
    `[mcp_servers.work-intelligence]\ncommand = ${JSON.stringify(shim)}\nargs = ["mcp"]\n`,
  );
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { "work-intelligence": { command: shim, args: ["mcp"] } } }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("Agent cards and recorded host observations", () => {
  it("shows observed-connected for a host that saw the current contract, and ignores unknown clients", () => {
    writeRuntimeFingerprint(CURRENT);
    writeObservations({
      "claude-code": { contractFingerprint: CURRENT },
      "codex-mcp-client": { contractFingerprint: CURRENT },
      "some-other-client": { contractFingerprint: OLD },
    });
    expect(cards()).toEqual({ codex: "observed-connected", "claude-code": "observed-connected" });
  });

  it("asks for a reconnect when the host saw an older contract", () => {
    writeRuntimeFingerprint(CURRENT);
    writeObservations({
      "claude-code": { contractFingerprint: OLD },
      "codex-mcp-client": { contractFingerprint: CURRENT },
    });
    expect(cards()).toEqual({ codex: "observed-connected", "claude-code": "needs-reconnect" });
  });

  it("stays configured-unverified without an observation, and never claims a connection without the runtime's fingerprint", () => {
    writeRuntimeFingerprint(CURRENT);
    expect(cards()).toEqual({ codex: "configured-unverified", "claude-code": "configured-unverified" });
    rmSync(join(configDirectory), { recursive: true, force: true });
    writeRuntimeFingerprint(undefined);
    rmSync(join(runtimeRoot, "runtimes"), { recursive: true, force: true });
    writeObservations({
      "claude-code": { contractFingerprint: CURRENT },
      "codex-mcp-client": { contractFingerprint: CURRENT },
    });
    expect(Object.values(cards())).not.toContain("observed-connected");
  });

  it("treats a damaged observations file as no observation", () => {
    writeRuntimeFingerprint(CURRENT);
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(join(configDirectory, "agent-observations.json"), "{ not json");
    expect(cards()).toEqual({ codex: "configured-unverified", "claude-code": "configured-unverified" });
  });
});

describe("readHostObservations and readCurrentContractFingerprint", () => {
  it("keeps the newest observation when two client names belong to one host, and drops malformed entries", () => {
    writeObservations({
      codex: { contractFingerprint: OLD, observedAt: "2026-01-01T00:00:00.000Z" },
      "codex-mcp-client": { contractFingerprint: CURRENT, observedAt: "2026-02-01T00:00:00.000Z" },
      "claude-code": { contractFingerprint: "not-a-fingerprint" },
    });
    expect(readHostObservations(configDirectory)).toEqual({
      codex: { contractFingerprint: CURRENT, observedAt: "2026-02-01T00:00:00.000Z" },
    });
  });

  it("reads nothing from a missing directory or a missing, malformed or hostile runtime pointer", () => {
    expect(readHostObservations(join(root, "missing"))).toEqual({});
    expect(readCurrentContractFingerprint(runtimeRoot)).toBeUndefined();
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(join(runtimeRoot, "current"), "../../escape\n");
    expect(readCurrentContractFingerprint(runtimeRoot)).toBeUndefined();
    writeRuntimeFingerprint("not-hex");
    expect(readCurrentContractFingerprint(runtimeRoot)).toBeUndefined();
    writeRuntimeFingerprint(CURRENT);
    expect(readCurrentContractFingerprint(runtimeRoot)).toBe(CURRENT);
  });
});
