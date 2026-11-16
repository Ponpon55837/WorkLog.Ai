import { createServer, request as httpRequest, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/index.js";

// The Host allowlist reads WORK_INTELLIGENCE_ALLOWED_ORIGINS when the server module loads, so each case loads it fresh.
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function startApi(
  allowedOrigins?: string,
): Promise<{ port: number; statusForHost: (host: string) => Promise<number> }> {
  vi.resetModules();
  if (allowedOrigins !== undefined) vi.stubEnv("WORK_INTELLIGENCE_ALLOWED_ORIGINS", allowedOrigins);
  const { createApiHandler } = await import("../../apps/server/src/server.js");
  const store = new WorkIntelligenceStore(":memory:");
  const server: Server = createServer(createApiHandler(store));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => {
    server.close();
    store.close();
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The test API did not expose a TCP address.");
  const statusForHost = (host: string) =>
    new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        { host: "127.0.0.1", port: address.port, path: "/api/projects", headers: { host } },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.once("error", reject);
      request.end();
    });
  return { port: address.port, statusForHost };
}

describe("Host header port check", () => {
  it("accepts every loopback name on the port the server listens on, IPv6 included", async () => {
    const { port, statusForHost } = await startApi("");

    expect(await statusForHost(`127.0.0.1:${port}`)).toBe(200);
    expect(await statusForHost(`localhost:${port}`)).toBe(200);
    expect(await statusForHost(`[::1]:${port}`)).toBe(200);
  });

  it("rejects a loopback name on any other port with 421", async () => {
    const { port, statusForHost } = await startApi("");

    expect(await statusForHost(`127.0.0.1:${port + 1}`)).toBe(421);
    expect(await statusForHost("localhost:5966")).toBe(421);
    expect(await statusForHost(`[::1]:${port + 1}`)).toBe(421);
  });

  it("rejects a loopback Host without a port, which means port 80", async () => {
    const { statusForHost } = await startApi("");

    expect(await statusForHost("127.0.0.1")).toBe(421);
    expect(await statusForHost("localhost")).toBe(421);
  });

  it("still accepts the default development Web origins when none are configured", async () => {
    const { statusForHost } = await startApi();

    expect(await statusForHost("localhost:5966")).toBe(200);
    expect(await statusForHost("127.0.0.1:5966")).toBe(200);
    expect(await statusForHost("localhost:5967")).toBe(421);
  });

  it("accepts an allowlisted origin only with its exact host and port", async () => {
    const { statusForHost } = await startApi("http://dev.example.test:8080");

    expect(await statusForHost("dev.example.test:8080")).toBe(200);
    expect(await statusForHost("dev.example.test:9090")).toBe(421);
    expect(await statusForHost("dev.example.test")).toBe(421);
    expect(await statusForHost("other.example.test:8080")).toBe(421);
  });

  it("treats an allowlisted origin without a port as port 80", async () => {
    const { statusForHost } = await startApi("http://dev.example.test");

    expect(await statusForHost("dev.example.test")).toBe(200);
    expect(await statusForHost("dev.example.test:80")).toBe(200);
    expect(await statusForHost("dev.example.test:81")).toBe(421);
  });
});
