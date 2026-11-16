import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeBackendDependencies } from "../../packages/desktop-core/src/index.js";
import { planLaunch } from "../../packages/desktop-core/src/runtime/launch-plan.js";

vi.mock("../../packages/desktop-core/src/runtime/launch-plan.js", () => ({
  planLaunch: vi.fn(async () => ({ command: "synthetic-node", args: ["serve"], env: {} })),
}));

// The real operating-system adapters on a free loopback port. Fictional values only.
const servers: Server[] = [];

async function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no TCP address");
  return address.port;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("createNodeBackendDependencies", () => {
  const dependencies = createNodeBackendDependencies({ runtimeRoot: "/synthetic/runtime" });

  it("creates the working directory with its parents, and is happy when it already exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "wi-cwd-"));
    try {
      const target = join(root, "a", "b", "backend-cwd");
      await dependencies.ensureDirectory?.(target);
      await dependencies.ensureDirectory?.(target);
      expect(existsSync(target)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("plans the serve action of the runtime root with exactly the given environment", async () => {
    const plan = await dependencies.planLaunch(["start", "--desktop-ipc"], { HOME: "/synthetic/home" });

    expect(plan.command).toBe("synthetic-node");
    expect(vi.mocked(planLaunch)).toHaveBeenCalledWith(
      "/synthetic/runtime",
      "serve",
      ["start", "--desktop-ipc"],
      expect.objectContaining({ env: { HOME: "/synthetic/home" } }),
    );
  });

  it("tells a bound loopback port from a free one", async () => {
    const port = await listen((_request, response) => response.end());
    expect(await dependencies.isPortFree(port)).toBe(false);

    await new Promise<void>((resolve) => servers.pop()?.close(() => resolve()));
    expect(await dependencies.isPortFree(port)).toBe(true);
  });

  it("reads the status and a header of a health response without following redirects", async () => {
    const port = await listen((request, response) => {
      response.writeHead(204, { "x-synthetic": request.headers["x-ask"] ?? "none" }).end();
    });

    const reply = await dependencies.fetchHealth(`http://127.0.0.1:${port}/`, { "x-ask": "yes" }, 2000);

    expect(reply.status).toBe(204);
    expect(reply.header("x-synthetic")).toBe("yes");
    expect(reply.header("x-missing")).toBeUndefined();
  });

  it("rejects a health request that exceeds its timeout", async () => {
    const port = await listen(() => undefined);
    await expect(dependencies.fetchHealth(`http://127.0.0.1:${port}/`, {}, 50)).rejects.toBeDefined();
  });

  it("makes unpredictable run ids and challenges, and resolves real paths", () => {
    expect(dependencies.randomRunId()).toMatch(/^[A-Za-z0-9_-]{22,128}$/);
    expect(dependencies.randomRunId()).not.toBe(dependencies.randomRunId());
    expect(dependencies.randomChallenge()).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(dependencies.realpath(tmpdir())).toBeTypeOf("string");
  });

  it("spawns a real process, runs timers and reports this process's platform and environment", async () => {
    const child = dependencies.spawn(process.execPath, ["-e", "process.exit(3)"], { stdio: "ignore" });
    const code = await new Promise((resolve) => child.on("exit", resolve));
    expect(code).toBe(3);

    const fired = vi.fn();
    const timer = dependencies.setTimer(fired, 1);
    dependencies.clearTimer(dependencies.setTimer(fired, 1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    dependencies.clearTimer(timer);
    expect(fired).toHaveBeenCalledTimes(1);
    expect(dependencies.platform).toBe(process.platform);
    expect(dependencies.parentEnvironment).toBe(process.env);
  });

  it("honors an injected platform and environment", () => {
    const injected = createNodeBackendDependencies({
      runtimeRoot: "/synthetic/runtime",
      platform: "win32",
      parentEnvironment: { SystemRoot: "C:\\Windows" },
    });
    expect(injected.platform).toBe("win32");
    expect(injected.parentEnvironment).toEqual({ SystemRoot: "C:\\Windows" });
  });
});
