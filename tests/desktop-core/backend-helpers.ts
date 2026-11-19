import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { vi } from "vitest";
import {
  computeInstanceProof,
  INSTANCE_CHALLENGE_HEADER,
  INSTANCE_PROOF_HEADER,
} from "../../packages/shared/src/instance-proof.js";
import {
  BackendSupervisor,
  DEFAULT_BACKEND_TIMEOUTS,
  type BackendStartRequest,
  type BackendSupervisorDependencies,
  type HealthResponse,
  type SupervisedChild,
} from "../../packages/desktop-core/src/index.js";
import type { DatabaseIdentity } from "../../packages/desktop-core/src/index.js";

// Fictional values only.
export const RUN_ID = "synthetic-run-id-0123456789abcdef-synthetic";
export const CHALLENGE = "synthetic-challenge-0123456789";
export const EXECUTABLE = "/synthetic/runtime/node/bin/node";
export const DB_PATH = "/synthetic/data/work-intelligence.sqlite";
export const IDENTITY: DatabaseIdentity = {
  realPath: DB_PATH,
  fileId: { device: "10", inode: "100" },
  lineageId: "a".repeat(64),
};
export const PORT = 41_234;

/** The state of one scripted child: what it says to the parent, and how it reacts to being asked to stop. */
export interface ChildScript {
  hello?: Record<string, unknown> | false;
  preflight?: Record<string, unknown> | false;
  ready?: Record<string, unknown> | false;
  /** What the child does when it gets `shutdown`: exit with this code, or ignore it. */
  onShutdown?: { exit: number } | "ignore";
  onSigterm?: { exit: number | null } | "ignore";
  onSigkill?: "exit" | "ignore";
  /** What the child does right after it said `ready`: end itself, optionally after reporting `failed`. */
  afterReady?: { exit: number; failed?: { code: string; detail: string } };
  /** The answer to `copy-database`; false stays silent. */
  copy?: Record<string, unknown> | false;
  /** The answer to `inspect-backups`; false stays silent. */
  inspect?: Record<string, unknown> | false;
  /** The answer to `restore-database`; false stays silent, "exit" ends the child without an answer. */
  restore?: Record<string, unknown> | false | "exit";
  /** The answer to `backup-roots`; false stays silent, "exit" ends the child without an answer. */
  roots?: Record<string, unknown> | false | "exit";
  /** The answer to `maintain-database`; false stays silent, "exit" ends the child without an answer. */
  maintain?: Record<string, unknown> | false | "exit";
}

/** A `ChildProcess` stand-in driven by a script, with real streams and EventEmitter semantics. */
export class FakeChild extends EventEmitter {
  pid: number | undefined = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly sent: Record<string, unknown>[] = [];
  readonly kills: (string | number | undefined)[] = [];
  runId: string | undefined;
  script: ChildScript;

  constructor(script: ChildScript = {}) {
    super();
    this.script = script;
  }

  send(message: Record<string, unknown>, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message);
    callback?.(null);
    queueMicrotask(() => this.react(message));
    return true;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal);
    if (signal === "SIGTERM") {
      const action = this.script.onSigterm ?? "ignore";
      if (action !== "ignore") this.exit(action.exit, action.exit === null ? "SIGTERM" : null);
    } else if ((this.script.onSigkill ?? "exit") === "exit") {
      // SIGKILL ends a POSIX process by signal; the argument-less kill() is TerminateProcess on Windows (exit code 1).
      if (signal === undefined) this.exit(1);
      else this.exit(null, "SIGKILL");
    }
    return true;
  }

  /** Delivers a child message to the parent. */
  say(message: Record<string, unknown>): void {
    this.emit("message", message);
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", this.exitCode, signal);
    this.stdout.end();
    this.stderr.end();
  }

  helloMessage(): Record<string, unknown> {
    return { type: "hello", protocolVersion: 1, pid: this.pid, execPath: EXECUTABLE };
  }

  private react(message: Record<string, unknown>): void {
    if (message.type === "preflight" && this.script.preflight !== false) {
      this.say({
        type: "preflight-result",
        status: "ok",
        identity: IDENTITY,
        schemaVersion: 33,
        compatibility: "current",
        ...this.script.preflight,
      });
    } else if (message.type === "start") {
      this.runId = message.runId as string;
      if (this.script.ready !== false) {
        this.say({
          type: "ready",
          protocolVersion: 1,
          runId: message.runId,
          port: message.port,
          appVersion: "9.9.9",
          schemaVersion: 33,
          databaseIdentity: IDENTITY,
          execPath: EXECUTABLE,
          pid: this.pid,
          ...this.script.ready,
        });
        const after = this.script.afterReady;
        if (after) {
          if (after.failed) this.say({ type: "failed", ...after.failed });
          this.exit(after.exit);
        }
      }
    } else if (message.type === "copy-database" && this.script.copy !== false) {
      this.say({ type: "copy-result", status: "ok", identity: IDENTITY, ...this.script.copy });
    } else if (message.type === "inspect-backups" && this.script.inspect !== false) {
      this.say({ type: "inspect-result", items: [], directoryReadable: true, ...this.script.inspect });
    } else if (message.type === "restore-database" && this.script.restore !== false) {
      if (this.script.restore === "exit") this.exit(1);
      else this.say({ type: "restore-result", status: "ok", ...this.script.restore });
    } else if (message.type === "backup-roots" && this.script.roots !== false) {
      if (this.script.roots === "exit") this.exit(1);
      else this.say({ type: "backup-roots-result", status: "ok", roots: [], ...this.script.roots });
    } else if (message.type === "maintain-database" && this.script.maintain !== false) {
      if (this.script.maintain === "exit") this.exit(1);
      else this.say({ type: "maintain-result", mode: message.mode, status: "ok", ...this.script.maintain });
    } else if (message.type === "shutdown") {
      const action = this.script.onShutdown ?? { exit: 0 };
      if (action !== "ignore") this.exit(action.exit);
    }
  }
}

export interface Harness {
  readonly killTree: ReturnType<typeof vi.fn>;
  readonly supervisor: BackendSupervisor;
  readonly children: FakeChild[];
  readonly deps: BackendSupervisorDependencies;
  readonly spawn: ReturnType<typeof vi.fn>;
  readonly isPortFree: ReturnType<typeof vi.fn>;
  readonly fetchHealth: ReturnType<typeof vi.fn>;
  readonly planLaunch: ReturnType<typeof vi.fn>;
  readonly logs: string[];
}

export interface HarnessOptions {
  platform?: NodeJS.Platform;
  parentEnvironment?: Record<string, string | undefined>;
  /** One script per spawn, in order; the last one repeats. */
  scripts?: ChildScript[];
  isPortFree?: (port: number) => Promise<boolean>;
  health?: (url: string, headers: Record<string, string>, runId: string | undefined) => Promise<HealthResponse>;
  realpath?: (path: string) => string;
  timeouts?: Partial<typeof DEFAULT_BACKEND_TIMEOUTS>;
  workingDirectory?: string;
  /** Makes the working directory exist; absent, the supervisor creates nothing. */
  ensureDirectory?: (path: string) => Promise<void>;
  /** Stands in for the Windows process-tree kill; the harness records its calls. */
  killTree?: (pid: number) => void | Promise<void>;
}

/** The proof a genuine child with `runId` would send for the request's challenge. */
export function genuineHealth(
  runId: string | undefined,
  headers: Record<string, string>,
  status = 200,
): HealthResponse {
  const challenge = headers[INSTANCE_CHALLENGE_HEADER] ?? "";
  const proof = runId ? computeInstanceProof(runId, challenge) : undefined;
  return {
    status,
    header: (name) => (name === INSTANCE_PROOF_HEADER ? proof : undefined),
  };
}

export function makeHarness(options: HarnessOptions = {}): Harness {
  const children: FakeChild[] = [];
  const logs: string[] = [];
  const scripts = options.scripts ?? [{}];
  const spawn = vi.fn(() => {
    const child = new FakeChild(scripts[Math.min(children.length, scripts.length - 1)]);
    children.push(child);
    // The first message of a real child arrives after the parent has attached its listeners.
    queueMicrotask(() => {
      if (child.script.hello !== false) child.say({ ...child.helloMessage(), ...child.script.hello });
    });
    return child as unknown as SupervisedChild;
  });
  const isPortFree = vi.fn(options.isPortFree ?? (async () => true));
  const planLaunch = vi.fn(async (argv: readonly string[], env: Readonly<Record<string, string | undefined>>) => ({
    command: EXECUTABLE,
    args: ["/synthetic/runtime/app/bin/work-intelligence.mjs", "start", ...argv],
    env: { ...env },
  }));
  const fetchHealth = vi.fn(async (url: string, headers: Readonly<Record<string, string>>): Promise<HealthResponse> =>
    options.health
      ? options.health(url, { ...headers }, children[children.length - 1]?.runId)
      : genuineHealth(children[children.length - 1]?.runId, { ...headers }),
  );
  const killTree = vi.fn((pid: number) => options.killTree?.(pid));
  const deps: BackendSupervisorDependencies = {
    killTree,
    planLaunch,
    spawn,
    isPortFree,
    fetchHealth,
    randomRunId: () => RUN_ID,
    randomChallenge: () => CHALLENGE,
    realpath: options.realpath ?? ((path) => path),
    ...(options.ensureDirectory ? { ensureDirectory: options.ensureDirectory } : {}),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
    platform: options.platform ?? "linux",
    parentEnvironment: options.parentEnvironment ?? { HOME: "/synthetic/home" },
  };
  const supervisor = new BackendSupervisor({
    dependencies: deps,
    log: (line) => logs.push(line),
    ...(options.timeouts ? { timeouts: options.timeouts } : {}),
    ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
  });
  return { killTree, supervisor, children, deps, spawn, isPortFree, fetchHealth, planLaunch, logs };
}

export function startRequest(overrides: Partial<BackendStartRequest> = {}): BackendStartRequest {
  return { port: PORT, databasePath: DB_PATH, ...overrides };
}

/** Lets pending microtasks (fake child replies) run without moving the fake clock. */
export async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}
