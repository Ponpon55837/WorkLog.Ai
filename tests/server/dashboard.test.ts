import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dashboardScript = join(repositoryRoot, "scripts/dashboard.mjs");
const cleanups: Array<() => void> = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "work-intelligence-dashboard-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Runs a script without blocking this process, so servers started by the test keep answering. */
function run(script: string, args: string[], environment: NodeJS.ProcessEnv) {
  const inherited = { ...process.env };
  for (const name of ["WORK_INTELLIGENCE_HOME", "WORK_INTELLIGENCE_CONFIG_DIR", "WORK_INTELLIGENCE_PORT"]) {
    delete inherited[name];
  }
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolveRun) => {
    execFile(
      process.execPath,
      [script, ...args],
      { env: { ...inherited, USERPROFILE: environment.HOME, ...environment }, timeout: 30_000 },
      (error, stdout, stderr) => resolveRun({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  cleanups.push(() => server.close());
  return { server, port: (server.address() as AddressInfo).port };
}

async function freePort(): Promise<number> {
  const { server, port } = await listen(() => undefined);
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

/** A checkout whose scripts/start.mjs serves /api/health on WORK_INTELLIGENCE_PORT for a few seconds. */
function builtCheckout(root: string): string {
  mkdirSync(join(root, "scripts"), { recursive: true });
  cpSync(dashboardScript, join(root, "scripts/dashboard.mjs"));
  writeFileSync(
    join(root, "scripts/start.mjs"),
    [
      'import { createServer } from "node:http";',
      "const server = createServer((request, response) => {",
      '  response.setHeader("content-type", "application/json");',
      '  response.end(JSON.stringify({ ok: true, database: "ok" }));',
      "});",
      'server.listen(Number(process.env.WORK_INTELLIGENCE_PORT), "127.0.0.1");',
      "setTimeout(() => process.exit(0), 5000);",
    ].join("\n"),
  );
  for (const file of ["apps/server/dist/index.js", "apps/web/dist/index.html"]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "");
  }
  return root;
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("pnpm dashboard", () => {
  it("prints the URL of a server that is already running and starts nothing", async () => {
    const { port } = await listen((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(request.url === "/api/health" ? { ok: true, database: "ok" } : {}));
    });
    const home = temporaryDirectory();
    const result = await run(dashboardScript, [], { HOME: home, WORK_INTELLIGENCE_PORT: String(port) });
    expect(result).toMatchObject({ code: 0, stdout: `Dashboard: http://127.0.0.1:${port}\n` });
  });

  it("starts the checkout's server in the background and waits until it answers", async () => {
    const home = temporaryDirectory();
    const checkout = builtCheckout(join(home, "checkout"));
    const port = await freePort();
    const result = await run(join(checkout, "scripts/dashboard.mjs"), [], {
      HOME: home,
      WORK_INTELLIGENCE_PORT: String(port),
    });
    expect(result).toMatchObject({
      code: 0,
      stdout: `Started the Work Intelligence server: http://127.0.0.1:${port}\n`,
    });
    const health = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as { ok: boolean };
    expect(health.ok).toBe(true);
  }, 30_000);

  it("refuses a port another program holds and an unbuilt checkout", async () => {
    const home = temporaryDirectory();
    const { port } = await listen((request, response) => {
      response.statusCode = 404;
      response.end("not here");
    });
    const occupied = await run(dashboardScript, [], { HOME: home, WORK_INTELLIGENCE_PORT: String(port) });
    expect(occupied.code).toBe(1);
    expect(occupied.stderr).toContain(`Port ${port} is in use`);

    const unbuilt = join(home, "unbuilt");
    mkdirSync(join(unbuilt, "scripts"), { recursive: true });
    cpSync(dashboardScript, join(unbuilt, "scripts/dashboard.mjs"));
    const notBuilt = await run(join(unbuilt, "scripts/dashboard.mjs"), [], {
      HOME: home,
      WORK_INTELLIGENCE_PORT: String(await freePort()),
    });
    expect(notBuilt.code).toBe(1);
    expect(notBuilt.stderr).toContain("pnpm build");
  });

  it("is reachable through the plugin launcher, which skips the unbuilt marketplace clone", async () => {
    const home = temporaryDirectory();
    // Codex runs the plugin inside its own clone of the repository; scripts/dashboard.mjs exists there but unbuilt.
    const clone = join(home, ".codex/.tmp/marketplaces/worklog-ai");
    for (const file of ["pnpm-workspace.yaml", "apps/mcp/package.json", "packages/shared/package.json"]) {
      mkdirSync(dirname(join(clone, file)), { recursive: true });
      writeFileSync(join(clone, file), "{}");
    }
    mkdirSync(join(clone, "scripts"), { recursive: true });
    cpSync(dashboardScript, join(clone, "scripts/dashboard.mjs"));
    cpSync(join(repositoryRoot, "plugins/work-intelligence"), join(clone, "plugins/work-intelligence"), {
      recursive: true,
    });
    const checkout = builtCheckout(join(home, "checkout"));
    for (const file of ["pnpm-workspace.yaml", "apps/mcp/package.json", "packages/shared/package.json"]) {
      mkdirSync(dirname(join(checkout, file)), { recursive: true });
      writeFileSync(join(checkout, file), "{}");
    }
    mkdirSync(join(home, ".work-intelligence"));
    writeFileSync(join(home, ".work-intelligence/plugin-link.json"), JSON.stringify({ repositoryRoot: checkout }));
    const port = await freePort();
    const result = await run(join(clone, "plugins/work-intelligence/scripts/launch.mjs"), ["dashboard"], {
      HOME: home,
      WORK_INTELLIGENCE_PORT: String(port),
    });
    expect(result).toMatchObject({
      code: 0,
      stdout: `Started the Work Intelligence server: http://127.0.0.1:${port}\n`,
    });
  }, 30_000);
});
