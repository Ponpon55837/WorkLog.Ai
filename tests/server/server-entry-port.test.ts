import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SERVER_PORT } from "../../apps/server/src/server-port.js";

const serverDirectory = resolve(import.meta.dirname, "../../apps/server");
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

function startServerEntry(port: string): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), "work-intelligence-entry-port-"));
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    WORK_INTELLIGENCE_DB: join(directory, "work-intelligence.sqlite"),
    WORK_INTELLIGENCE_BACKUP: "off",
    WORK_INTELLIGENCE_PORT: port,
  };
  delete environment.WORK_INTELLIGENCE_WEB_DIST;
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: serverDirectory,
    env: environment,
  });
  const exit = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  cleanups.push(async () => {
    child.kill();
    await exit;
    rmSync(directory, { recursive: true, force: true });
  });

  let output = "";
  return new Promise((resolveStart) => {
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      if (output.includes(`127.0.0.1:${DEFAULT_SERVER_PORT}`)) {
        resolveStart(output);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    void exit.then(() => resolveStart(output));
  });
}

describe("server entry point", () => {
  it("falls back to the default port when WORK_INTELLIGENCE_PORT is not a port number", async () => {
    const output = await startServerEntry("abc");

    expect(output).not.toContain("ERR_SOCKET_BAD_PORT");
    expect(output).toContain(`127.0.0.1:${DEFAULT_SERVER_PORT}`);
  });
});
