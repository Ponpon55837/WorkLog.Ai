import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POSIX_SHIM_NAME, runtimeLayout } from "../../packages/desktop-core/src/runtime/index.js";
import { FIXTURE_FILES, installFixture, makeRoot } from "./runtime-helpers.js";

let root = "";
const sessions: ChildProcessWithoutNullStreams[] = [];

interface Session {
  /** Sends one line and resolves with the next line the session answers. */
  ask(line: string): Promise<string>;
  /** Closes stdin, as an Agent ending its MCP session does, and resolves with the exit code. */
  end(): Promise<number | null>;
}

/** A runtime whose launcher is a line echo server that names its runtime id, run by this test's own Node. */
function echoRuntimeFiles(runtimeId: string): Record<string, string> {
  return {
    ...FIXTURE_FILES,
    "node/bin/node": `#!/bin/sh\nexec "${process.execPath}" "$@"\n`,
    "launcher.mjs": [
      'import { createInterface } from "node:readline";',
      `createInterface({ input: process.stdin }).on("line", (line) => process.stdout.write(\`${runtimeId}:\${line}\\n\`));`,
    ].join("\n"),
  };
}

/** One MCP-like stdio session through the fixed shim, the way an Agent's `command` starts it. */
function startSession(): Session {
  const child = spawn(path.join(runtimeLayout(root).binDirectory, POSIX_SHIM_NAME), ["mcp"], {
    env: { PATH: "/usr/bin:/bin" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  sessions.push(child);
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const exited = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
  return {
    ask: async (line) => {
      child.stdin.write(`${line}\n`);
      const next = await lines.next();
      return next.value as string;
    },
    end: () => {
      child.stdin.end();
      return exited;
    },
  };
}

beforeEach(async () => {
  root = await makeRoot();
});

afterEach(async () => {
  for (const child of sessions.splice(0)) child.kill("SIGKILL");
  await fs.rm(root, { recursive: true, force: true });
});

// G-MCP-01 (update): an App update installs a new runtime and moves `current`; sessions that run must not notice.
describe.skipIf(process.platform === "win32")("switching the current runtime under a running MCP session", () => {
  it("keeps the running session on its runtime, and starts the next one on the new runtime", async () => {
    await installFixture(root, "rt-a", { commit: true, files: echoRuntimeFiles("A") });
    const running = startSession();
    expect(await running.ask("one")).toBe("A:one");

    await installFixture(root, "rt-b", { commit: true, files: echoRuntimeFiles("B") });
    expect((await fs.readFile(runtimeLayout(root).currentFile, "utf8")).trim()).toBe("rt-b");

    expect(await running.ask("two")).toBe("A:two");
    const next = startSession();
    expect(await next.ask("three")).toBe("B:three");
    expect(await running.ask("four")).toBe("A:four");
    expect(await Promise.all([running.end(), next.end()])).toEqual([0, 0]);
  });

  it("keeps a running session alive when its runtime directory is removed, as cleanup does after an update", async () => {
    const { runtimeDirectory } = await installFixture(root, "rt-a", { commit: true, files: echoRuntimeFiles("A") });
    const running = startSession();
    expect(await running.ask("one")).toBe("A:one");
    await installFixture(root, "rt-b", { commit: true, files: echoRuntimeFiles("B") });
    await fs.rm(runtimeDirectory, { recursive: true, force: true });
    expect(await running.ask("two")).toBe("A:two");
    expect(await running.end()).toBe(0);
  });
});
