import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { createApiHandler } from "../../apps/server/src/server.js";
import { DEFAULT_SERVER_PORT, resolveServerPort } from "../../apps/server/src/server-port.js";

const resources: Array<{ server: Server; store: WorkIntelligenceStore }> = [];

async function getHealth(store: WorkIntelligenceStore): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = createServer(createApiHandler(store));
  resources.push({ server, store });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The test API did not expose a TCP address.");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

afterEach(async () => {
  for (const { server, store } of resources.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

describe("GET /api/health", () => {
  it("reports a connected database as healthy", async () => {
    const { status, body } = await getHealth(new WorkIntelligenceStore(":memory:"));

    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, database: "connected" });
  });

  it("reports a failing database as not ok", async () => {
    const store = new WorkIntelligenceStore(":memory:");
    store.listProjects = () => {
      throw new Error("database is unavailable");
    };

    const { status, body } = await getHealth(store);

    expect(status).toBe(503);
    expect(body).toMatchObject({ ok: false, database: "unavailable" });
  });
});

describe("resolveServerPort", () => {
  it.each([
    ["4319", 4319],
    [undefined, DEFAULT_SERVER_PORT],
    ["abc", DEFAULT_SERVER_PORT],
    ["0", DEFAULT_SERVER_PORT],
    ["65536", DEFAULT_SERVER_PORT],
  ])("resolves WORK_INTELLIGENCE_PORT=%s to %i", (value, expected) => {
    const environment = value === undefined ? {} : { WORK_INTELLIGENCE_PORT: value };

    expect(resolveServerPort(environment)).toBe(expected);
  });
});
