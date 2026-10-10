import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";
import { createApiHandler } from "../../apps/server/src/server.js";
import { seedReportPresentation } from "../helpers/report-presentation-fixture.js";

const resources: Array<{ root: string; store: WorkIntelligenceStore; server: Server }> = [];
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wi-presentation-api-"));
  const store = new WorkIntelligenceStore(":memory:");
  const seeded = seedReportPresentation(store, root);
  const server = createServer(createApiHandler(store));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  resources.push({ root, store, server });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  return {
    store,
    ...seeded,
    url: `http://127.0.0.1:${address.port}/api/reports/summaries/${seeded.summary.id}/presentation`,
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { root, store, server } of resources.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
describe("report presentation REST boundary", () => {
  it("enforces strict JSON, Origins, CAS and unavailable-source masking", async () => {
    const { url, store, sourceId } = await fixture();
    const body = { expectedRevision: 0, state: { pinned: [], hidden: ["risks"], overrides: [] } };
    expect((await fetch(url + "?extra=bad")).status).toBe(400);
    expect(
      (await fetch(url, { method: "PATCH", headers: { "content-type": "text/plain" }, body: JSON.stringify(body) }))
        .status,
    ).toBe(415);
    expect(
      (
        await fetch(url, {
          method: "PATCH",
          headers: { "content-type": "application/json", origin: "https://untrusted.example" },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(url, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(url, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(409);
    store.setSessionVoid({ sessionId: sourceId, voided: true, reason: "Fixture" });
    const unavailable = await fetch(url);
    expect(unavailable.status).toBe(404);
    expect(JSON.stringify(await unavailable.json())).not.toContain("Fictional outcome");
  });
  it("masks unexpected internal errors", async () => {
    const { url, store } = await fixture();
    vi.spyOn(store, "getReportPresentation").mockImplementation(() => {
      throw new Error("Private fixture path");
    });
    const result = await fetch(url);
    expect(result.status).toBe(500);
    expect(await result.json()).toEqual({ error: "Internal server error.", code: "internal_error" });
  });
});
