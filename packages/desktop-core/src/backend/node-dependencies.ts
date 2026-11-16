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
    planLaunch: (argv, env) => planLaunch(options.runtimeRoot, "serve", argv, { ...options.verify, env }),
    spawn: (command, args, spawnOptions) => spawn(command, [...args], spawnOptions),
    isPortFree: async (port) => (await probeLoopbackPort(port)).free,
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
