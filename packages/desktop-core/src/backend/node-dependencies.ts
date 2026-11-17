import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createInstanceChallenge } from "@work-intelligence/shared/instance-proof";
import { probeLoopbackPort } from "@work-intelligence/shared/loopback-port";
import { planLaunch } from "../runtime/launch-plan.js";
import type { VerifyRuntimeOptions } from "../runtime/verify.js";
import type { BackendSupervisorDependencies } from "./types.js";

const RUN_ID_BYTES = 32;

/**
 * V8 limits the backend runs with, given to the bundled Node before the entry script (the child environment drops
 * `NODE_OPTIONS`, so they cannot come from there). They apply to every isolate of the process, the backup worker thread
 * that parses and writes an import included.
 * - `--max-old-space-size=1024`: the largest import the API accepts (50 MiB of JSON, which is a 47.6 MB synthetic project
 *   of 4,600 Sessions and 59,800 events) imports and exports correctly under a cap of 256 MiB and fails cleanly (HTTP
 *   500, backend alive) under 128 MiB, so 1 GiB leaves four times the need. It bounds a runaway to a quarter of the
 *   default on a 16 GB machine (about 2 GiB) instead of letting it take the machine's memory.
 * - `--max-semi-space-size=2`: the young generation may grow to 16 MiB by default, which a desktop App that sits in the
 *   tray all day keeps resident after any burst of requests; 2 MiB costs no measurable time on that import and export.
 */
export const BACKEND_NODE_FLAGS: readonly string[] = ["--max-old-space-size=1024", "--max-semi-space-size=2"];

export interface NodeBackendDependenciesOptions {
  /** The runtime root whose `current` runtime provides the `serve` action. */
  readonly runtimeRoot: string;
  readonly verify?: VerifyRuntimeOptions;
  /** Defaults to this process's platform and environment; the environment is only a source for the allowlist. */
  readonly platform?: NodeJS.Platform;
  readonly parentEnvironment?: Readonly<Record<string, string | undefined>>;
}

/** The real operating-system dependencies of {@link BackendSupervisor}, for the Electron main process. */
export function createNodeBackendDependencies(options: NodeBackendDependenciesOptions): BackendSupervisorDependencies {
  return {
    // ADR-04: the backend runs on the bundled official Node.js, never on Electron run as Node.
    planLaunch: async (argv, env) => {
      const plan = await planLaunch(options.runtimeRoot, "serve", argv, {
        ...options.verify,
        env,
        requiredRuntimeKind: "node",
      });
      return { ...plan, args: [...BACKEND_NODE_FLAGS, ...plan.args] };
    },
    spawn: (command, args, spawnOptions) => spawn(command, [...args], spawnOptions),
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
