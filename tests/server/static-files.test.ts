import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { createApiHandler } from "../../apps/server/src/server.js";

const resources: Array<{ server: Server; store: WorkIntelligenceStore; root: string }> = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await new Promise<void>((resolve) => resource.server.close(() => resolve()));
    resource.store.close();
    rmSync(resource.root, { recursive: true, force: true });
  }
});

async function startServer(): Promise<{ baseUrl: string; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-static-test-"));
  const webDirectory = join(root, "web");
  mkdirSync(join(webDirectory, "assets"), { recursive: true });
  writeFileSync(join(webDirectory, "index.html"), "<!doctype html><title>Work Intelligence</title>");
  writeFileSync(join(webDirectory, "assets", "app-a1b2c3d4e5.js"), "export {};");
  writeFileSync(join(root, "outside.txt"), "secret-outside-web-root");

  const store = new WorkIntelligenceStore(":memory:");
  const server = createServer(createApiHandler(store, { webDirectory }));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The static test server did not expose a TCP address.");
  }
  resources.push({ server, store, root });
  return { baseUrl: `http://127.0.0.1:${address.port}`, root };
}

function getRawPath(baseUrl: string, path: string): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { hostname, port: Number(port), path, headers: { accept: "text/html" } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    request.once("error", reject);
    request.end();
  });
}

describe("production static file server", () => {
  it("serves SPA routes, hashed assets, and restrictive security headers", async () => {
    const { baseUrl } = await startServer();

    const page = await fetch(`${baseUrl}/sessions`, { headers: { accept: "text/html" } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Work Intelligence");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(page.headers.get("content-security-policy")).not.toContain("unsafe-eval");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("x-frame-options")).toBe("DENY");

    const asset = await fetch(`${baseUrl}/assets/app-a1b2c3d4e5.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("serves the API from the same origin without enabling CORS", async () => {
    const { baseUrl } = await startServer();
    const response = await fetch(`${baseUrl}/api/health`, { headers: { origin: baseUrl } });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await response.json()).toMatchObject({ ok: true, database: "connected" });
  });

  it("rejects literal and encoded parent path segments", async () => {
    const { baseUrl } = await startServer();

    for (const path of ["/../outside.txt", "/%2e%2e/outside.txt", "/assets/%2e%2e/%2e%2e/outside.txt"]) {
      const response = await getRawPath(baseUrl, path);
      expect(response.status, path).toBe(400);
      expect(response.body).not.toContain("secret-outside-web-root");
    }
  });

  it.skipIf(process.platform === "win32")("rejects symlinks that escape the Web root", async () => {
    const { baseUrl, root } = await startServer();
    symlinkSync(join(root, "outside.txt"), join(root, "web", "outside.txt"));

    const response = await getRawPath(baseUrl, "/outside.txt");
    expect(response.status).toBe(400);
    expect(response.body).not.toContain("secret-outside-web-root");
  });
});
