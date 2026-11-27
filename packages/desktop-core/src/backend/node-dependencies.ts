import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { MCP_LEASE_SCOPE_ENVIRONMENT } from "@work-intelligence/shared/mcp-runtime";
import { createInstanceChallenge } from "@work-intelligence/shared/instance-proof";
import { probeLoopbackPort } from "@work-intelligence/shared/loopback-port";
import { windowsSystemTool } from "@work-intelligence/shared/windows-system-tool";
import { planLaunch } from "../runtime/launch-plan.js";
import type { VerifyRuntimeOptions } from "../runtime/verify.js";
import type { BackendSupervisorDependencies } from "./types.js";

const RUN_ID_BYTES = 32;

export const BACKEND_NODE_FLAGS: readonly string[] = ["--max-old-space-size=1024", "--max-semi-space-size=2"];

export interface NodeBackendDependenciesOptions {
  readonly runtimeRoot: string;
  readonly verify?: VerifyRuntimeOptions;
  readonly platform?: NodeJS.Platform;
  readonly parentEnvironment?: Readonly<Record<string, string | undefined>>;
}

export function createNodeBackendDependencies(options: NodeBackendDependenciesOptions): BackendSupervisorDependencies {
  return {
    // ADR-04: the backend runs on the bundled official Node.js, never on Electron run as Node.
    planLaunch: async (argv, env) => {
      const plan = await planLaunch(options.runtimeRoot, "serve", argv, {
        ...options.verify,
        // Not started through the launcher, so the lease scope is set here; otherwise the backend and an Agent's MCP count
        // leases in different directories.
        env: { ...env, [MCP_LEASE_SCOPE_ENVIRONMENT]: options.runtimeRoot },
        requiredRuntimeKind: "node",
      });
      return { ...plan, args: [...BACKEND_NODE_FLAGS, ...plan.args] };
    },
    spawn: (command, args, spawnOptions) => spawn(command, [...args], spawnOptions),
    killTree: (pid) =>
      // The caller waits so the root process still exists for /T to walk from.
      new Promise<void>((resolve) => {
        const killer = spawn(windowsSystemTool("taskkill.exe"), ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.on("error", () => resolve());
        killer.on("close", () => resolve());
        killer.unref();
      }),
    isPortFree: async (port) => (await probeLoopbackPort(port)).free,
    probePort: probeLoopbackPort,
    fetchHealth: async (url, headers, timeoutMs) => {
      const response = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
      await response.body?.cancel();
      return { status: response.status, header: (name) => response.headers.get(name) ?? undefined };
    },
    randomRunId: () => randomBytes(RUN_ID_BYTES).toString("base64url"),
    randomChallenge: createInstanceChallenge,
    realpath: (path) => realpathSync.native(path),
    ensureDirectory: async (path) => {
      await mkdir(path, { recursive: true });
    },
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
    platform: options.platform ?? process.platform,
    parentEnvironment: options.parentEnvironment ?? process.env,
  };
}
