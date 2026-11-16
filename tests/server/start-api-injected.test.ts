import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { WorkIntelligenceStore } from "@work-intelligence/storage";
import { BarrierSandbox, freePort } from "../helpers/old-writer-barrier.js";

const sandboxes: BarrierSandbox[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.stopAll()));
});

describe("startApi with an injected verified database (child process)", () => {
  it("serves on the given free port, logs the resolved database path and stops cleanly on SIGTERM", async () => {
    const sandbox = new BarrierSandbox();
    sandboxes.push(sandbox);
    new WorkIntelligenceStore(sandbox.databasePath).close();
    const port = await freePort();
    expect(port).not.toBe(3210);

    const api = sandbox.spawnEntry("tests/helpers/start-api-injected.ts", [], {
      START_API_TEST_DB: sandbox.databasePath,
      WORK_INTELLIGENCE_PORT: String(port),
    });
    await api.waitForLine(new RegExp(`listening on http://127\\.0\\.0\\.1:${port}$`));
    await api.waitForLine(new RegExp(`SQLite database: ${realpathSync(sandbox.databasePath)}$`));

    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(response.status).toBeLessThan(500);

    api.child.kill("SIGTERM");
    expect(await api.exited).toBe(0);
  });
});
