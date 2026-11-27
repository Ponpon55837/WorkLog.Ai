import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createConnection } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { BarrierSandbox, freePort } from "../helpers/old-writer-barrier.js";

// Runs the real entry as a child stopped the way a service manager stops it; Windows has no SIGTERM, so the IPC shutdown is covered in desktop-child-process.test.ts.
const ENTRY = "apps/server/src/index.ts";
const SIGNALS = ["SIGTERM", "SIGINT"] as const;
const EXIT_WITHIN_MS = 5_000;
const sandboxes: BarrierSandbox[] = [];

function syntheticBundle(sandbox: BarrierSandbox): string {
  const source = new WorkIntelligenceStore(join(sandbox.root, "source.sqlite"));
  try {
    const root = join(sandbox.root, "source-project");
    mkdirSync(root, { recursive: true });
    const project = source.addProject("Shutdown source project", root);
    source.updateProject(project.id, { status: "tracked" });
    for (let index = 0; index < 5; index += 1) {
      source.finalizeSession({
        projectRoot: root,
        idempotencyKey: `shutdown-process-${index}`,
        title: `Synthetic Session ${index}`,
        summary: "A synthetic summary used to give the import worker something to parse.",
        changedFiles: ["src/synthetic.ts"],
        verification: { status: "passed" },
        workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      });
    }
    return JSON.stringify({ bundle: source.exportProjectData({ type: "all" }) });
  } finally {
    source.close();
  }
}

async function startServer(sandbox: BarrierSandbox) {
  const port = await freePort();
  const entry = sandbox.spawnEntry(ENTRY, [], { WORK_INTELLIGENCE_PORT: String(port) });
  await entry.waitForLine(/listening on/);
  return { entry, port, baseUrl: `http://127.0.0.1:${port}` };
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.stopAll()));
});

describe.skipIf(process.platform === "win32")("standalone server shutdown signals (real process)", () => {
  it.each(SIGNALS)(
    "exits with code 0 right after an import started the worker on %s",
    { timeout: 30_000 },
    async (signal) => {
      const sandbox = new BarrierSandbox();
      sandboxes.push(sandbox);
      const { entry, baseUrl } = await startServer(sandbox);

      const imported = await fetch(`${baseUrl}/api/import`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: baseUrl },
        body: syntheticBundle(sandbox),
      });
      expect(imported.status).toBe(200);

      const sentAt = Date.now();
      entry.child.kill(signal);

      expect(await entry.exited).toBe(0);
      expect(Date.now() - sentAt).toBeLessThan(EXIT_WITHIN_MS);
    },
  );

  it(
    "exits with code 0 although a client stalls before finishing its request headers",
    { timeout: 30_000 },
    async () => {
      const sandbox = new BarrierSandbox();
      sandboxes.push(sandbox);
      const { entry, port } = await startServer(sandbox);
      const stalled = createConnection({ host: "127.0.0.1", port });
      stalled.on("error", () => undefined);
      await new Promise<void>((resolve) => stalled.once("connect", resolve));
      stalled.write("GET /api/health HTTP/1.1\r\nHost: localhost\r\n");

      entry.child.kill("SIGTERM");

      // Longer than the default grace period (10 s) plus start-up of the exit path, shorter than the headers timeout (60 s).
      expect(await entry.exited).toBe(0);
      stalled.destroy();
    },
  );
});
