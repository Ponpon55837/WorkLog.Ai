import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopFacts } from "../../packages/schema/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { createApiHandler, type ApiHandlerOptions } from "../../apps/server/src/server.js";
import {
  OPEN_AGENT_SETUP_MIN_INTERVAL_MS,
  OPEN_PORT_SETTINGS_MIN_INTERVAL_MS,
} from "../../apps/server/src/desktop-services.js";

// Fictional values only; the status never touches a real service manager or Agent settings.
const LEGACY = {
  running: "running",
} as const;
const JSON_HEADERS = { "content-type": "application/json" };

const resources: Array<{ server: Server; store: WorkIntelligenceStore }> = [];

async function listen(options: ApiHandlerOptions = {}, store = new WorkIntelligenceStore(":memory:")): Promise<string> {
  const server = createServer(
    createApiHandler(store, {
      agentConnections: () => ({ codex: {}, claudeCode: {} }) as never,
      userServiceStatus: () => ({ state: "not_installed" }) as never,
      ...options,
    }),
  );
  resources.push({ server, store });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The test API did not expose a TCP address.");
  return `http://127.0.0.1:${address.port}`;
}

function post(baseUrl: string, headers: Record<string, string> = JSON_HEADERS): Promise<Response> {
  return fetch(`${baseUrl}/api/desktop/open-agent-setup`, { method: "POST", headers, body: "{}" });
}

afterEach(async () => {
  for (const { server, store } of resources.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

describe("system status in desktop mode", () => {
  it("has no desktop field for a standalone server", async () => {
    const baseUrl = await listen();
    const status = (await (await fetch(`${baseUrl}/api/system/status`)).json()) as Record<string, unknown>;
    expect(status).not.toHaveProperty("desktop");
  });

  it("reports managed without a legacy service when the App told nothing", async () => {
    const baseUrl = await listen({ desktop: { onOpenAgentSetup: vi.fn() } });
    const status = (await (await fetch(`${baseUrl}/api/system/status`)).json()) as { desktop: unknown };
    expect(status.desktop).toEqual({ managed: true });
  });

  it("passes the legacy service facts through", async () => {
    const baseUrl = await listen({ desktop: { facts: { legacyService: LEGACY }, onOpenAgentSetup: vi.fn() } });
    const status = (await (await fetch(`${baseUrl}/api/system/status`)).json()) as { desktop: unknown };
    expect(status.desktop).toEqual({ managed: true, legacyService: LEGACY });
  });
});

describe("system status database and login item in desktop mode", () => {
  it("reports the database and backup folder the backend really uses, and the App's login item", async () => {
    const directory = mkdtempSync(join(tmpdir(), "desktop-status-"));
    try {
      const databasePath = join(directory, "App 資料", "work-intelligence.sqlite");
      const backupDirectory = join(directory, "App 備份");
      mkdirSync(join(directory, "App 資料"), { recursive: true });
      const store = new WorkIntelligenceStore(databasePath, { backup: { directory: backupDirectory } });
      const loginItem = { supported: true, desired: true, system: "disabled" } as const;
      const baseUrl = await listen({ desktop: { facts: { loginItem }, onOpenAgentSetup: vi.fn() } }, store);
      const status = (await (await fetch(`${baseUrl}/api/system/status`)).json()) as {
        database: { path: string };
        desktop: unknown;
      };
      expect(status.database.path).toBe(databasePath);
      expect(status.desktop).toEqual({ managed: true, loginItem, backupDirectory });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("system status port and storage facts", () => {
  it("reports the active port and storage risk", async () => {
    const facts = { activePort: 40_321, storageRisk: { risk: "network", migrationBlocked: true } } as const;
    const baseUrl = await listen({ desktop: { facts, onOpenAgentSetup: vi.fn() } });
    const status = (await (await fetch(`${baseUrl}/api/system/status`)).json()) as { desktop: unknown };
    expect(status.desktop).toEqual({ managed: true, ...facts });
  });

  it("reads the current facts on every request", async () => {
    let facts: DesktopFacts | undefined = { activePort: 40_321 };
    const baseUrl = await listen({ desktop: { getFacts: () => facts, onOpenAgentSetup: vi.fn() } });
    const read = async () =>
      ((await (await fetch(`${baseUrl}/api/system/status`)).json()) as { desktop: unknown }).desktop;
    expect(await read()).toEqual({ managed: true, activePort: 40_321 });
    facts = { activePort: 40_322, storageRisk: { risk: "unknown", migrationBlocked: false } };
    expect(await read()).toEqual({
      managed: true,
      activePort: 40_322,
      storageRisk: { risk: "unknown", migrationBlocked: false },
    });
  });
});

describe("system status agents in desktop mode", () => {
  it("judges hooks against the launcher shim the App reported, like the Agent page", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-desktop-agents-"));
    try {
      const home = join(root, "home");
      const appShim = join(root, "app", "bin", "work-intelligence-launcher");
      const otherShim = join(root, "other", "bin", "work-intelligence-launcher");
      for (const shim of [appShim, otherShim]) {
        mkdirSync(join(shim, ".."), { recursive: true });
        writeFileSync(shim, "#!/bin/sh\n");
      }
      mkdirSync(join(home, ".claude"), { recursive: true });
      mkdirSync(join(home, ".codex"), { recursive: true });
      const hook = (shim: string) => ({
        hooks: { Stop: [{ hooks: [{ type: "command", command: `'${shim}' claude-finalize-reminder` }] }] },
      });
      writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(hook(otherShim)));
      vi.stubEnv("HOME", home);
      vi.stubEnv("USERPROFILE", home);
      vi.stubEnv("CODEX_HOME", join(home, ".codex"));
      vi.stubEnv("CLAUDE_CONFIG_DIR", join(home, ".claude"));
      const claudeHook = async (facts: DesktopFacts): Promise<unknown> => {
        const baseUrl = await listen({ agentConnections: undefined, desktop: { facts, onOpenAgentSetup: vi.fn() } });
        const status = (await (await fetch(`${baseUrl}/api/system/status`)).json()) as {
          agents: { claudeCode: { hook: string } };
          desktop: Record<string, unknown>;
        };
        // The shim path stays inside the backend.
        expect(status.desktop).not.toHaveProperty("launcherShimPath");
        return status.agents.claudeCode.hook;
      };
      // Another shim than the App's own is stale; without the App's shim any existing shim is accepted.
      expect(await claudeHook({ launcherShimPath: appShim })).toBe("stale");
      expect(await claudeHook({ launcherShimPath: otherShim })).toBe("installed");
      expect(await claudeHook({})).toBe("installed");
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("POST /api/desktop/open-port-settings", () => {
  function postPort(baseUrl: string, body: unknown, headers: Record<string, string> = JSON_HEADERS): Promise<Response> {
    return fetch(`${baseUrl}/api/desktop/open-port-settings`, {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("answers 404 outside desktop mode", async () => {
    const response = await postPort(await listen(), {});
    expect(response.status).toBe(404);
  });

  it("sends only the sanitized preferences and route to the App and answers 202", async () => {
    const onOpenPortSettings = vi.fn();
    const baseUrl = await listen({ desktop: { onOpenAgentSetup: vi.fn(), onOpenPortSettings } });
    const response = await postPort(baseUrl, {
      preferences: { theme: "dark", locale: "xx", token: "secret", sidePanelWidths: { session: 480, other: 9 } },
      route: "/sessions/abc",
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true });
    expect(onOpenPortSettings).toHaveBeenCalledWith({
      preferences: { theme: "dark", sidePanelWidths: { session: 480 } },
      route: "/sessions/abc",
    });
  });

  it("falls back to the home route for an unsafe route and accepts an empty body", async () => {
    let now = 1_000_000;
    const onOpenPortSettings = vi.fn();
    const baseUrl = await listen({ desktop: { onOpenAgentSetup: vi.fn(), onOpenPortSettings, now: () => now } });
    expect((await postPort(baseUrl, { route: "//evil" })).status).toBe(202);
    now += OPEN_PORT_SETTINGS_MIN_INTERVAL_MS;
    expect((await postPort(baseUrl, {})).status).toBe(202);
    expect(onOpenPortSettings).toHaveBeenNthCalledWith(1, { preferences: {}, route: "/" });
    expect(onOpenPortSettings).toHaveBeenNthCalledWith(2, { preferences: {}, route: "/" });
  });

  it("refuses an unknown field and a wrongly typed route with 400", async () => {
    const onOpenPortSettings = vi.fn();
    const baseUrl = await listen({ desktop: { onOpenAgentSetup: vi.fn(), onOpenPortSettings } });
    expect((await postPort(baseUrl, { extra: 1 })).status).toBe(400);
    expect((await postPort(baseUrl, { route: 5 })).status).toBe(400);
    expect(onOpenPortSettings).not.toHaveBeenCalled();
  });

  it("sends at most one message per second but still answers 202", async () => {
    let now = 1_000_000;
    const onOpenPortSettings = vi.fn();
    const baseUrl = await listen({ desktop: { onOpenAgentSetup: vi.fn(), onOpenPortSettings, now: () => now } });

    expect((await postPort(baseUrl, {})).status).toBe(202);
    expect((await postPort(baseUrl, {})).status).toBe(202);
    now += OPEN_PORT_SETTINGS_MIN_INTERVAL_MS - 1;
    expect((await postPort(baseUrl, {})).status).toBe(202);
    expect(onOpenPortSettings).toHaveBeenCalledTimes(1);

    now += 1;
    expect((await postPort(baseUrl, {})).status).toBe(202);
    expect(onOpenPortSettings).toHaveBeenCalledTimes(2);
  });

  it("stays 202 when the App channel throws", async () => {
    const baseUrl = await listen({
      desktop: {
        onOpenAgentSetup: vi.fn(),
        onOpenPortSettings: () => {
          throw new Error("channel closed");
        },
      },
    });
    expect((await postPort(baseUrl, {})).status).toBe(202);
  });

  it("refuses a foreign Origin and a non-JSON body without notifying the App", async () => {
    const onOpenPortSettings = vi.fn();
    const baseUrl = await listen({ desktop: { onOpenAgentSetup: vi.fn(), onOpenPortSettings } });
    expect((await postPort(baseUrl, {}, { ...JSON_HEADERS, origin: "http://evil.example" })).status).toBe(403);
    expect((await postPort(baseUrl, "{}", { "content-type": "text/plain" })).status).toBeGreaterThanOrEqual(400);
    expect(onOpenPortSettings).not.toHaveBeenCalled();
  });
});

describe("POST /api/desktop/open-agent-setup", () => {
  it("answers 404 with the normal error shape outside desktop mode", async () => {
    const response = await post(await listen());
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
  });

  it("asks the App to open its window and answers 202", async () => {
    const onOpenAgentSetup = vi.fn();
    const response = await post(await listen({ desktop: { onOpenAgentSetup } }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true });
    expect(onOpenAgentSetup).toHaveBeenCalledTimes(1);
  });

  it("sends at most one message per second but still answers 202", async () => {
    let now = 1_000_000;
    const onOpenAgentSetup = vi.fn();
    const baseUrl = await listen({ desktop: { onOpenAgentSetup, now: () => now } });

    expect((await post(baseUrl)).status).toBe(202);
    expect((await post(baseUrl)).status).toBe(202);
    now += OPEN_AGENT_SETUP_MIN_INTERVAL_MS - 1;
    expect((await post(baseUrl)).status).toBe(202);
    expect(onOpenAgentSetup).toHaveBeenCalledTimes(1);

    now += 1;
    expect((await post(baseUrl)).status).toBe(202);
    expect(onOpenAgentSetup).toHaveBeenCalledTimes(2);
  });

  it("stays 202 when the App channel throws", async () => {
    const baseUrl = await listen({
      desktop: {
        onOpenAgentSetup: () => {
          throw new Error("channel closed");
        },
      },
    });
    expect((await post(baseUrl)).status).toBe(202);
  });

  it("refuses a foreign Origin and a non-JSON body without notifying the App", async () => {
    const onOpenAgentSetup = vi.fn();
    const baseUrl = await listen({ desktop: { onOpenAgentSetup } });

    const foreignOrigin = await post(baseUrl, { ...JSON_HEADERS, origin: "http://evil.example" });
    expect(foreignOrigin.status).toBe(403);
    const form = await post(baseUrl, { "content-type": "text/plain" });
    expect(form.status).toBeGreaterThanOrEqual(400);
    expect(onOpenAgentSetup).not.toHaveBeenCalled();
  });
});
