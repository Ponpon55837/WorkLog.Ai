import {
  DESKTOP_CHILD_PROTOCOL_VERSION,
  parseDesktopParentMessage,
  type DesktopBackendErrorCode,
  type DesktopChildMessage,
  type DesktopStartMessage,
} from "@work-intelligence/schema";
import { LATEST_SCHEMA_VERSION } from "@work-intelligence/storage";
import { APP_VERSION } from "@work-intelligence/shared/app-version";
import { probeLoopbackPort, type LoopbackPortProbe } from "@work-intelligence/shared/loopback-port";
import {
  preflightDatabase,
  type DatabasePreflightResult,
  type RevalidationFailureReason,
} from "./database-preflight.js";
import { StartApiError, startApi, type StartApiOptions, type StartedApi } from "./start-api.js";

/** How the child talks to its parent and ends itself; the real one wraps `process`, tests pass a fake. */
export interface DesktopChildHost {
  readonly pid: number;
  readonly execPath: string;
  /** Sends one message and calls back once it has been handed to the channel (so an exit right after loses nothing). */
  send(message: DesktopChildMessage, done: () => void): void;
  onMessage(listener: (message: unknown) => void): void;
  /** The parent went away (crashed, killed, or closed the channel). */
  onDisconnect(listener: () => void): void;
  /** SIGINT or SIGTERM. */
  onSignal(listener: () => void): void;
  exit(code: number): void;
  /** Diagnostic line for the parent's captured stderr; never a path, token or message body. */
  log(line: string): void;
}

export interface DesktopChildDependencies {
  preflight: (path: string) => Promise<DatabasePreflightResult>;
  probePort: (port: number) => Promise<LoopbackPortProbe>;
  startApi: (options: StartApiOptions) => StartedApi;
}

/** A failure the parent can act on: the error code and a short detail that carries no path. */
interface ChildFailure {
  code: DesktopBackendErrorCode;
  detail: string;
}

/** `startApi` revalidation failures: the file is gone or unreadable, or it is no longer the one the user confirmed. */
const REVALIDATION_FAILURES: Record<RevalidationFailureReason, ChildFailure> = {
  missing: { code: "DB_MISSING", detail: "the database file is missing" },
  offline: { code: "DB_OFFLINE", detail: "the database storage is offline" },
  denied: { code: "DB_PERMISSION", detail: "the database file cannot be read" },
  unreadable: { code: "REPAIR_REQUIRED", detail: "the database file cannot be read" },
  "path-replaced": { code: "DB_IDENTITY_CHANGED", detail: "the database path now resolves elsewhere" },
  "file-replaced": { code: "DB_IDENTITY_CHANGED", detail: "the database file was replaced" },
  "lineage-changed": { code: "DB_IDENTITY_CHANGED", detail: "the database history changed" },
};

/** `DatabaseInitializationError.code` values with a dedicated error code; anything else needs repair. */
const STORE_OPEN_FAILURES = new Map<string, ChildFailure>([
  [
    "DATABASE_SCHEMA_VERSION_TOO_NEW",
    { code: "SCHEMA_TOO_NEW", detail: "the database schema is newer than this build" },
  ],
  ["DATABASE_MIGRATION_BACKUP_FAILED", { code: "SCHEMA_MIGRATION_BLOCKED", detail: "the pre-migration backup failed" }],
  ["DATABASE_MIGRATION_FAILED", { code: "SCHEMA_MIGRATION_BLOCKED", detail: "the schema migration failed" }],
  ["DATABASE_FILE_MISSING", { code: "DB_MISSING", detail: "the database file is missing" }],
  ["DATABASE_READ_ONLY", { code: "DB_PERMISSION", detail: "the database is read-only" }],
]);

/** `listen` errno codes that mean the port cannot be used by this user right now. */
const PORT_ERRNO_CODES = new Set(["EADDRINUSE", "EACCES", "EADDRNOTAVAIL"]);

function startFailure(error: unknown): ChildFailure {
  if (!(error instanceof StartApiError)) return { code: "REPAIR_REQUIRED", detail: "unexpected start failure" };
  if (error.kind === "revalidation" && error.revalidation) return REVALIDATION_FAILURES[error.revalidation];
  if (error.kind === "setup") return { code: "REPAIR_REQUIRED", detail: "the API could not be set up" };
  if (error.kind === "file-replaced") return REVALIDATION_FAILURES["file-replaced"];
  if (error.kind === "listen") {
    return PORT_ERRNO_CODES.has(error.listenCode ?? "")
      ? { code: "PORT_OCCUPIED_BY_OTHER", detail: `listen failed (${error.listenCode})` }
      : { code: "REPAIR_REQUIRED", detail: `listen failed (${error.listenCode ?? "unknown"})` };
  }
  const known = error.storeError ? STORE_OPEN_FAILURES.get(error.storeError.code) : undefined;
  return known ?? { code: "REPAIR_REQUIRED", detail: "the database could not be opened" };
}

/**
 * What the parent may read about a preflight. The underlying `detail` (an SQLite or file-system message) can carry the
 * database path, so only these fixed classification texts ever leave this process.
 */
const PREFLIGHT_DETAILS: Record<DatabasePreflightResult["status"], string> = {
  ok: "the database can be opened",
  missing: "the database file is missing",
  offline: "the database storage is offline",
  denied: "the database file cannot be read",
  unreadable: "the database file cannot be read",
  "unsupported-schema": "the database schema is not supported by this build",
};

function preflightReply(result: DatabasePreflightResult): DesktopChildMessage {
  return {
    type: "preflight-result",
    status: result.status,
    ...(result.identity ? { identity: result.identity } : {}),
    ...(result.schemaVersion === undefined ? {} : { schemaVersion: result.schemaVersion }),
    ...(result.compatibility ? { compatibility: result.compatibility } : {}),
    ...(result.projectCount === undefined ? {} : { projectCount: result.projectCount }),
    ...(result.sidecars ? { sidecars: result.sidecars } : {}),
    ...(result.status === "ok" ? {} : { detail: PREFLIGHT_DETAILS[result.status] }),
  };
}

const defaultDependencies: DesktopChildDependencies = {
  preflight: (path) => preflightDatabase(path),
  probePort: probeLoopbackPort,
  startApi,
};

/**
 * The backend side of the private parent/child channel (R4 section 5.1, C-08). One instance serves one parent: it answers
 * a read-only preflight, accepts exactly one `start`, reports `ready` only after the listener is up, and shuts down
 * gracefully on `shutdown`, on a signal, or when the parent disappears. It never reads the port or database from the
 * environment: the parent's `start` message is the only source.
 */
export class DesktopChild {
  private readonly host: DesktopChildHost;
  private readonly dependencies: DesktopChildDependencies;
  private phase: "idle" | "starting" | "running" | "stopping" = "idle";
  private api: StartedApi | undefined;
  private starting: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private failed = false;
  private exited = false;

  constructor(host: DesktopChildHost, dependencies: DesktopChildDependencies = defaultDependencies) {
    this.host = host;
    this.dependencies = dependencies;
  }

  /** Subscribes to the parent and announces this process; the channel keeps the process alive from here on. */
  begin(): void {
    this.host.onMessage((raw) =>
      this.handle(raw).catch(() => this.host.log("[desktop-child] a message handler failed")),
    );
    this.host.onDisconnect(() => void this.stop({ notify: false }).catch(() => undefined));
    this.host.onSignal(() => void this.stop({ notify: false }).catch(() => undefined));
    this.host.send(
      {
        type: "hello",
        protocolVersion: DESKTOP_CHILD_PROTOCOL_VERSION,
        pid: this.host.pid,
        execPath: this.host.execPath,
      },
      () => undefined,
    );
  }

  /** Handles one raw message; an unknown or malformed one is logged and dropped, never fatal. */
  async handle(raw: unknown): Promise<void> {
    const parsed = parseDesktopParentMessage(raw);
    if (!parsed.ok) {
      this.host.log(`[desktop-child] dropped a message (${parsed.reason})`);
      return;
    }
    const message = parsed.message;
    if (message.type === "shutdown") {
      await this.stop({ notify: true });
    } else if (message.type === "preflight") {
      await this.preflight(message.path);
    } else {
      await this.start(message);
    }
  }

  private async preflight(path: string): Promise<void> {
    if (this.phase !== "idle") {
      this.host.log("[desktop-child] dropped a preflight request: already started");
      return;
    }
    let result: DatabasePreflightResult;
    try {
      result = await this.dependencies.preflight(path);
    } catch {
      result = { status: "unreadable" };
    }
    this.host.send(preflightReply(result), () => undefined);
  }

  private start(message: DesktopStartMessage): Promise<void> {
    if (this.phase !== "idle") {
      this.host.log("[desktop-child] dropped a second start request");
      return Promise.resolve();
    }
    this.phase = "starting";
    this.starting = this.run(message);
    return this.starting;
  }

  /** Never rejects: every failure is reported to the parent, so `starting` is always safe to await. */
  private async run(message: DesktopStartMessage): Promise<void> {
    // The store may migrate the database, so a port that cannot be bound is found out before it is opened. This probe
    // narrows but cannot close the window up to `listen`: a port taken in between still fails the start, and by then any
    // migration was already approved by the parent (`allowSchemaMigration` + `markMigrationStarted`) and is not unsafe.
    let probe: LoopbackPortProbe;
    try {
      probe = await this.dependencies.probePort(message.port);
    } catch {
      return this.fail({ code: "REPAIR_REQUIRED", detail: "the port could not be probed" });
    }
    // A shutdown, disconnect or signal that arrived during the probe wins: nothing is opened, and `shutDown` finishes it.
    if (this.phase !== "starting") return;
    if (!probe.free) {
      return this.fail({ code: "PORT_OCCUPIED_BY_OTHER", detail: `listen failed (${probe.code})` });
    }
    let api: StartedApi | undefined;
    try {
      api = this.dependencies.startApi({
        database: {
          path: message.database.path,
          identity: message.database.identity,
          ...(message.backupDirectory ? { backupDirectory: message.backupDirectory } : {}),
        },
        port: message.port,
        instanceRunId: message.runId,
        onBackupCompleted: (at) => this.host.send({ type: "backup-completed", at }, () => undefined),
        onBackupsChanged: () => this.host.send({ type: "backups-changed" }, () => undefined),
      });
      this.api = api;
      const listening = await api.listening;
      if (this.phase !== "starting") return;
      this.phase = "running";
      this.host.send(
        {
          type: "ready",
          protocolVersion: DESKTOP_CHILD_PROTOCOL_VERSION,
          runId: message.runId,
          port: listening.port,
          appVersion: APP_VERSION,
          schemaVersion: LATEST_SCHEMA_VERSION,
          databaseIdentity: listening.databaseIdentity ?? message.database.identity,
          execPath: this.host.execPath,
          pid: this.host.pid,
        },
        () => undefined,
      );
    } catch (error) {
      // Whatever the API opened before failing is closed (idempotent), then the failure is reported.
      await api?.shutdown().catch(() => undefined);
      await this.fail(startFailure(error));
    }
  }

  /**
   * Reports a failed start and ends the process; nothing keeps running half-started. A failure is final: `stopped` is
   * never sent after `failed`, and the process exits exactly once (a shutdown that races a failure only waits for it).
   */
  private fail(failure: ChildFailure): Promise<void> {
    if (this.failed) return Promise.resolve();
    this.failed = true;
    this.phase = "stopping";
    return new Promise<void>((resolve) => {
      this.host.send({ type: "failed", ...failure }, () => {
        this.exit(1);
        resolve();
      });
    });
  }

  private exit(code: number): void {
    if (this.exited) return;
    this.exited = true;
    this.host.exit(code);
  }

  /** Graceful stop; every caller shares one run. `notify: false` when the parent can no longer be told. */
  private stop(options: { notify: boolean }): Promise<void> {
    this.stopping ??= this.shutDown(options.notify);
    return this.stopping;
  }

  private async shutDown(notify: boolean): Promise<void> {
    const startedBeforeStop = this.phase === "starting";
    this.phase = "stopping";
    // A start still waiting for its probe or listener finishes (or fails and exits) first, so SQLite is never left open.
    if (startedBeforeStop) await this.starting;
    await this.api?.shutdown().catch(() => undefined);
    // A start that failed has already told the parent and exited; there is nothing left to announce.
    if (this.failed) return;
    const code = process.exitCode === undefined ? 0 : Number(process.exitCode);
    if (!notify) {
      this.exit(code);
      return;
    }
    await new Promise<void>((resolve) => {
      this.host.send({ type: "stopped" }, () => {
        this.exit(code);
        resolve();
      });
    });
  }
}

/** The host backed by this process and its IPC channel. */
function processHost(): DesktopChildHost {
  return {
    pid: process.pid,
    execPath: process.execPath,
    send: (message, done) => {
      try {
        if (process.send) process.send(message, undefined, undefined, () => done());
        else done();
      } catch {
        // The channel closed between the check and the send; the disconnect handler already owns the shutdown.
        done();
      }
    },
    onMessage: (listener) => process.on("message", listener),
    onDisconnect: (listener) => process.on("disconnect", listener),
    onSignal: (listener) => {
      process.on("SIGINT", listener);
      process.on("SIGTERM", listener);
    },
    exit: (code) => process.exit(code),
    log: (line) => console.error(line),
  };
}

/**
 * Entry of `work-intelligence start --desktop-ipc`. Needs the IPC channel a Node parent opens with `stdio: [..., "ipc"]`;
 * without one it explains itself and returns a non-zero exit code. With one it returns 0 as soon as it is listening
 * for the parent: the channel keeps the process alive until it shuts itself down.
 */
export async function runDesktopChild(
  host?: DesktopChildHost,
  dependencies?: DesktopChildDependencies,
): Promise<number> {
  const resolved = host ?? (process.send ? processHost() : undefined);
  if (!resolved) {
    console.error(
      "這個入口只供 Work Intelligence 桌面 App 使用，需要由它的父程序以 IPC 啟動；一般使用請執行 work-intelligence start。",
    );
    return 2;
  }
  new DesktopChild(resolved, dependencies).begin();
  return 0;
}
