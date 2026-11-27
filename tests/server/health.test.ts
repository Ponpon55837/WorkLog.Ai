import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { createApiHandler } from "../../apps/server/src/server.js";
import {
  computeInstanceProof,
  INSTANCE_CHALLENGE_HEADER,
  INSTANCE_PROOF_HEADER,
} from "../../packages/shared/src/instance-proof.js";
import { DEFAULT_SERVER_PORT, resolveServerPort } from "../../apps/server/src/server-port.js";

const resources: Array<{ server: Server; store: WorkIntelligenceStore }> = [];

interface HealthReply {
  status: number;
  body: Record<string, unknown>;
  proof: string | null;
}

async function getHealth(
  store: WorkIntelligenceStore,
  options: { instanceRunId?: string; challenge?: string } = {},
): Promise<HealthReply> {
  const server = createServer(
    createApiHandler(store, options.instanceRunId ? { instanceRunId: options.instanceRunId } : {}),
  );
  resources.push({ server, store });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The test API did not expose a TCP address.");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/health`, {
    headers: options.challenge ? { [INSTANCE_CHALLENGE_HEADER]: options.challenge } : ({} as Record<string, string>),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    proof: response.headers.get(INSTANCE_PROOF_HEADER),
  };
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
    expect(body.sqlite).toEqual({ version: process.versions.sqlite, walResetFixed: true });
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

describe("GET /api/health instance proof", () => {
  const runId = "synthetic-run-id-0123456789abcdef-health";
  const challenge = "synthetic-challenge-0123456789";

  it("answers a valid challenge with the HMAC of the run id and never leaks the run id", async () => {
    const { status, body, proof } = await getHealth(new WorkIntelligenceStore(":memory:"), {
      instanceRunId: runId,
      challenge,
    });

    expect(status).toBe(200);
    expect(proof).toBe(computeInstanceProof(runId, challenge));
    expect(JSON.stringify(body)).not.toContain(runId);
  });

  it.each([["short"], ["has spaces and !! symbols"], ["x".repeat(129)]])(
    "sends no proof for the invalid challenge %j",
    async (bad) => {
      const { proof } = await getHealth(new WorkIntelligenceStore(":memory:"), {
        instanceRunId: runId,
        challenge: bad,
      });
      expect(proof).toBeNull();
    },
  );

  it("sends no proof without a challenge", async () => {
    const { proof } = await getHealth(new WorkIntelligenceStore(":memory:"), { instanceRunId: runId });
    expect(proof).toBeNull();
  });

  it("behaves as before when the server was not started with a run id", async () => {
    const { status, proof } = await getHealth(new WorkIntelligenceStore(":memory:"), { challenge });
    expect(status).toBe(200);
    expect(proof).toBeNull();
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
