import { createServer, type Server } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { createApiHandler } from "../../apps/server/src/server.js";
import { apiRoutes } from "../../apps/server/src/routes/index.js";

const PROBE_FIELD = "unexpectedProbeField";
const ROUTES_DIRECTORY = fileURLToPath(new URL("../../apps/server/src/routes/", import.meta.url));

/** Mutating routes that take no JSON body at all, so there is no field to mistype; each says why. */
const ROUTES_WITHOUT_BODY: Readonly<Record<string, string>> = {
  "POST /api/backups": "creates a backup; the request carries no options",
  "POST /api/system/pick-folder": "opens the native folder picker; the request carries no options",
  "POST /api/reports/synthesis-requests/:requestId/retry": "retries the named request; nothing else is sent",
  "POST /api/reports/synthesis-requests/:requestId/cancel": "cancels the named request; nothing else is sent",
  "POST /api/backfill/metadata-requests/:requestId/cancel": "cancels the named request; nothing else is sent",
  "DELETE /api/reports/summaries/:summaryId": "removes the named summary; nothing else is sent",
  "DELETE /api/sessions/:sessionId/links": "fails validation without the other Session id",
  "DELETE /api/sessions/:sessionId/links/:relatedSessionId": "unlinks the two named Sessions; nothing else is sent",
};

/** Project data import and export validate whole bundles with schemas of their own and answer in their own shape. */
const TRANSFER_ROUTES = new Set(["POST /api/export", "POST /api/import", "POST /api/import/preview"]);

/** Query objects that reach a schema whole; other GET routes read only the parameters they name. */
const QUERY_ROUTES = [
  "/api/attention",
  "/api/sessions/probe-id/related",
  "/api/reports/summaries/probe-id/presentation",
  "/api/reports/summaries/probe-id/presentation/export",
] as const;

let server: Server;
let store: WorkIntelligenceStore;
let baseUrl: string;

function concretePath(pattern: string): string {
  return pattern
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "probe-id" : segment))
    .join("/");
}

beforeAll(async () => {
  store = new WorkIntelligenceStore(":memory:");
  server = createServer(createApiHandler(store));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The test API did not expose a TCP address.");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
});

describe("strict REST input", () => {
  it("rejects an unknown body field on every mutating route and names it", async () => {
    const mutating = apiRoutes.filter((route) => route.method !== "GET");
    const probed: string[] = [];
    const lenient: string[] = [];
    for (const route of mutating) {
      const key = `${route.method} ${route.pattern}`;
      if (ROUTES_WITHOUT_BODY[key] || TRANSFER_ROUTES.has(key)) continue;
      const response = await fetch(`${baseUrl}${concretePath(route.pattern)}`, {
        method: route.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [PROBE_FIELD]: 1 }),
      });
      const body = (await response.json()) as { code?: string };
      // A route may answer its own validation code (for example a deletion confirmation); the key must be named.
      if (response.status !== 400 || !JSON.stringify(body).includes(PROBE_FIELD)) {
        lenient.push(`${key} → ${response.status} ${body.code ?? ""}`);
      }
      probed.push(key);
    }
    expect(lenient).toEqual([]);
    expect(probed.length).toBeGreaterThan(30);
  });

  it("keeps the list of body-less mutating routes current", () => {
    const registered = new Set(apiRoutes.map((route) => `${route.method} ${route.pattern}`));
    const listed = [...Object.keys(ROUTES_WITHOUT_BODY), ...TRANSFER_ROUTES];
    expect(listed.filter((key) => !registered.has(key))).toEqual([]);
  });

  it("rejects a nested unknown field with its path", async () => {
    const response = await fetch(`${baseUrl}/api/sessions/probe-id/work-summary`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workSummary: { outcomes: ["Fictional outcome."], outcomez: [] } }),
    });
    const body = (await response.json()) as { details?: { fieldErrors?: Record<string, string[]> } };
    expect(response.status).toBe(400);
    expect(body.details?.fieldErrors?.workSummary?.join(" ")).toMatch(/in workSummary: outcomez/);
  });

  it("rejects an unknown query parameter where the whole query reaches the schema", async () => {
    for (const path of QUERY_ROUTES) {
      const response = await fetch(`${baseUrl}${path}?${PROBE_FIELD}=1`);
      const body = await response.text();
      expect({ path, status: response.status }).toEqual({ path, status: 400 });
      expect(body).toContain(PROBE_FIELD);
    }
  });

  it("parses every route input through the strict REST parser", () => {
    // Import and export validate their bundles with schemas that are strict themselves; they are left as they are.
    const allowed = new Set([
      "projectDataImportInputSchema",
      "projectDataExportRequestSchema",
      "databaseBackupFileNameSchema",
    ]);
    const direct = readdirSync(ROUTES_DIRECTORY)
      .filter((file) => file.endsWith(".ts"))
      .flatMap((file) =>
        [...readFileSync(join(ROUTES_DIRECTORY, file), "utf8").matchAll(/(\w+)\.safeParse\(/g)].flatMap((match) =>
          allowed.has(match[1]!) ? [] : [`${file}: ${match[1]}`],
        ),
      );
    expect(direct).toEqual([]);
  });
});
