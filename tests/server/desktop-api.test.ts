import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { createApiHandler, type ApiHandlerOptions } from "../../apps/server/src/server.js";
import { OPEN_AGENT_SETUP_MIN_INTERVAL_MS } from "../../apps/server/src/desktop-services.js";

// Fictional values only; the status never touches a real service manager or Agent settings.
const LEGACY = {
  running: "running",
  removeCommand: "synthetic-remove --legacy",
  fallbackRemoveCommand: "synthetic-fallback --legacy",
} as const;
const JSON_HEADERS = { "content-type": "application/json" };

const resources: Array<{ server: Server; store: WorkIntelligenceStore }> = [];

async function listen(options: ApiHandlerOptions = {}): Promise<string> {
  const store = new WorkIntelligenceStore(":memory:");
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
