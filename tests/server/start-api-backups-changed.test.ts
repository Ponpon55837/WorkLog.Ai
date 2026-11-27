import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkIntelligenceStore } from "@work-intelligence/storage";
import { preflightDatabase } from "../../apps/server/src/database-preflight.js";
import { startApi, type StartedApi } from "../../apps/server/src/start-api.js";
import { freePort } from "../helpers/old-writer-barrier.js";

const directories: string[] = [];
const started: StartedApi[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const api of started.splice(0)) await api.shutdown();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function run(onBackupsChanged: () => void): Promise<number> {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "wi-backups-changed-")));
  directories.push(root);
  const path = join(root, "work.sqlite");
  new WorkIntelligenceStore(path).close();
  const backupDirectory = join(root, "backups");
  mkdirSync(backupDirectory);
  const preflight = await preflightDatabase(path);
  if (!preflight.identity) throw new Error("expected an identity");
  const api = startApi({
    database: { path, identity: preflight.identity, backupDirectory },
    port: await freePort(),
    onBackupsChanged,
  });
  started.push(api);
  return (await api.listening).port;
}

describe("startApi onBackupsChanged", () => {
  it("fires after a successful write request (a manual backup), and not after a read or a refused request", async () => {
    const changed = vi.fn();
    const port = await run(changed);
    const url = `http://127.0.0.1:${port}/api/backups`;

    expect((await fetch(url)).status).toBe(200);
    expect(changed).not.toHaveBeenCalled();

    expect((await fetch(url, { method: "POST" })).status).toBeGreaterThanOrEqual(400);
    expect(changed).not.toHaveBeenCalled();

    const created = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(created.status).toBeLessThan(300);
    await created.arrayBuffer();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  });

  it("never lets a throwing listener disturb the response", async () => {
    const port = await run(() => {
      throw new Error("listener failed");
    });
    const created = await fetch(`http://127.0.0.1:${port}/api/backups`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(created.status).toBeLessThan(300);
  });
});
