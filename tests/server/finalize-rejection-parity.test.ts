import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createApiHandler } from "../../apps/server/src/server.js";
import { finalizeSessionInputSchema } from "../../packages/schema/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { FINALIZE_CONTRADICTIONS, finalizeRequest } from "../helpers/finalize-contradictions.js";

// Fictional fixtures only.
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startApi() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-finalize-parity-"));
  const store = new WorkIntelligenceStore(":memory:");
  store.updateProject(store.addProject("Lighthouse", root).id, { status: "tracked" });
  const server: Server = createServer(createApiHandler(store));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The test API did not expose a TCP address.");
  cleanups.push(
    () => rmSync(root, { recursive: true, force: true }),
    () => store.close(),
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  return { store, root, baseUrl: `http://127.0.0.1:${address.port}` };
}

describe("finalize rejections through REST", () => {
  it.each(FINALIZE_CONTRADICTIONS)(
    "answers $code with 200 and the storage body, writing nothing",
    async ({ code, fields, ids }) => {
      const { store, root, baseUrl } = await startApi();
      const body = finalizeRequest(root, `parity-${code}`, fields);
      const tokenBefore = store.getChangeToken();

      const response = await fetch(`${baseUrl}/api/work/finalize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const rest = await response.json();
      const direct = store.finalizeSession(finalizeSessionInputSchema.parse(body));

      expect(response.status).toBe(200);
      expect(rest).toEqual(direct);
      expect(rest).toMatchObject({ outcome: "rejected", code, ...(ids ? { ids } : {}) });
      expect(store.listSessions()).toEqual([]);
      expect(store.getChangeToken()).toEqual(tokenBefore);
    },
  );
});
