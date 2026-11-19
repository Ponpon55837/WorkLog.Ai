import {
  DESKTOP_CHILD_PROTOCOL_VERSION,
  DESKTOP_INTEGRITY_CHECK_FAILED_DETAIL,
  parseDesktopParentMessage,
  sanitizeBrowserPreferences,
  sanitizeHandoffRoute,
  type DesktopBackendErrorCode,
  type DesktopChildMessage,
  type DesktopFacts,
  type DesktopStartMessage,
} from "@work-intelligence/schema";
import { LATEST_SCHEMA_VERSION } from "@work-intelligence/storage";
import { APP_VERSION } from "@work-intelligence/shared/app-version";
import { probeLoopbackPort, type LoopbackPortProbe } from "@work-intelligence/shared/loopback-port";
import { portFailureCode } from "@work-intelligence/shared/port-failure";
import { createDatabaseIfMissing } from "./database-create.js";
import {
  inspectBackups,
  listBackupProjectRoots,
  restoreFromBackup,
  type InspectBackupsResult,
} from "./backup-restore.js";
import { maintainForApp, readMaintenanceHint } from "./database-maintenance-app.js";
import { copyDatabaseConsistently, type DatabaseCopyResult } from "./database-copy.js";
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
  preflight: (path: string, options?: { quickCheck?: boolean }) => Promise<DatabasePreflightResult>;
  /** Creates a new empty database when nothing exists at the path; a failure result, or `undefined` to go on to preflight. */
  createDatabase?: (path: string) => DatabasePreflightResult | undefined;
  /** A consistent copy of `source` at `target` for a preview child (DT-08); never touches the source. */
  copyDatabase?: (source: string, target: string) => Promise<DatabaseCopyResult>;
  /** Read-only look at the backups of a database or at the files given (the App's 「從備份還原」); a preview child only. */
  inspectBackups?: typeof inspectBackups;
  /** Replaces the database with a backup (a preview child only, and only while the backend is stopped). */
  restoreFromBackup?: typeof restoreFromBackup;
  /** The project folders a backup records, read-only (a preview child only). */
  listBackupRoots?: typeof listBackupProjectRoots;
  /** Maintains or checks the database (a preview child only, and only while the backend is stopped). */
  maintain?: typeof maintainForApp;
  /** Reclaimable space and the last maintenance run of the serving database. */
  maintenanceHint?: typeof readMaintenanceHint;
  probePort: (port: number) => Promise<LoopbackPortProbe>;
  startApi: (options: StartApiOptions) => StartedApi;
  /**
   * Test seam of the desktop smoke tests: resolves when the child may open the store (and so migrate). It is given a
   * predicate that turns false once the start was abandoned, so a held child still shuts down. Absent in production:
   * see desktop-child-test-hold.ts.
   */
  holdBeforeOpen?: (stillStarting: () => boolean) => Promise<void>;
}

/**
 * Set by esbuild when the desktop runtime is bundled (scripts/build-standalone.mjs, `desktopTestBuild`): true only for
 * the smoke-test runtime (`scripts/desktop-runtime-spike/build.mjs --desktop-test-build`), false in every other bundle,
 * including the one a packaged App ships. A plain `tsc`/vitest/tsx run defines nothing, so it reads as false.
 */
declare const __WI_DESKTOP_TEST_BUILD__: boolean | undefined;

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
      ? { code: portFailureCode(error.listenCode ?? ""), detail: `listen failed (${error.listenCode})` }
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

/** The one raw detail that may be named: the fixed text for a failed quick_check, so the App can tell it from a read failure. */
function preflightReplyDetail(result: DatabasePreflightResult): string {
  return result.status === "unreadable" && result.detail === "quick_check failed"
    ? DESKTOP_INTEGRITY_CHECK_FAILED_DETAIL
    : PREFLIGHT_DETAILS[result.status];
}

function preflightReply(result: DatabasePreflightResult): DesktopChildMessage {
  return {
    type: "preflight-result",
    status: result.status,
    ...(result.identity ? { identity: result.identity } : {}),
    ...(result.schemaVersion === undefined ? {} : { schemaVersion: result.schemaVersion }),
    ...(result.compatibility ? { compatibility: result.compatibility } : {}),
    ...(result.projectCount === undefined ? {} : { projectCount: result.projectCount }),
    ...(result.projectNames === undefined ? {} : { projectNames: result.projectNames }),
    ...(result.sidecars ? { sidecars: result.sidecars } : {}),
    ...(result.status === "ok" ? {} : { detail: preflightReplyDetail(result) }),
  };
}

const defaultDependencies: DesktopChildDependencies = {
  preflight: (path, options) => preflightDatabase(path, options),
  createDatabase: createDatabaseIfMissing,
  copyDatabase: copyDatabaseConsistently,
  inspectBackups,
  restoreFromBackup,
  listBackupRoots: listBackupProjectRoots,
  maintain: maintainForApp,
  maintenanceHint: readMaintenanceHint,
  probePort: probeLoopbackPort,
  startApi,
  // The condition folds to a constant in a bundle, so a production bundle drops this branch together with the hold
  // module it imports (and the variable name inside it); the module is loaded only in the smoke-test runtime.
  holdBeforeOpen:
    typeof __WI_DESKTOP_TEST_BUILD__ !== "undefined" && __WI_DESKTOP_TEST_BUILD__
      ? async (stillStarting) => {
          const { migrationHoldFromEnvironment } = await import("./desktop-child-test-hold.js");
          await migrationHoldFromEnvironment(process.env, true)?.(stillStarting);
        }
      : undefined,
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
  /** The App's current facts; read on every status request, so an `update-facts` can replace them after start. */
  private facts: DesktopFacts | undefined;
  private failed = false;
  private exited = false;
  /** The database this child serves, for the maintenance hint. */
  private databasePath: string | undefined;

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
    } else if (message.type === "update-facts") {
      // The App learned something after the start (DT-08 storage risk): the status endpoint reads `facts` per request.
      this.facts = message.desktop;
    } else if (message.type === "copy-database") {
      await this.copyDatabase(message.source, message.target);
    } else if (message.type === "inspect-backups") {
      this.inspectBackups(message);
    } else if (message.type === "restore-database") {
      this.restoreDatabase(message);
    } else if (message.type === "backup-roots") {
      this.backupRoots(message.source);
    } else if (message.type === "maintain-database") {
      await this.maintain(message);
    } else if (message.type === "maintenance-hint-query") {
      await this.reportMaintenanceHint(message.requestId);
    } else if (message.type === "activity-query") {
      this.reportActivity(message.requestId);
    } else if (message.type === "preflight") {
      await this.preflight(message.path, message.createIfMissing === true, message.quickCheck === true);
    } else {
      await this.start(message);
    }
  }

  /** Answers which long jobs run now; a backend that is not serving has none. */
  private reportActivity(requestId: string): void {
    const busy = this.phase === "running" ? (this.api?.activity() ?? []) : [];
    const pendingImport = this.phase === "running" && (this.api?.hasPendingImport() ?? false);
    this.host.send({ type: "activity", requestId, busy, pendingImport }, () => undefined);
  }

  /** Only a child that has not started reads another database's project folders. */
  private backupRoots(source: string): void {
    if (this.phase !== "idle" || !this.dependencies.listBackupRoots) {
      this.host.log("[desktop-child] dropped a backup-roots request: not a preview child");
      this.host.send({ type: "backup-roots-result", status: "failed", roots: [] }, () => undefined);
      return;
    }
    let result: ReturnType<typeof listBackupProjectRoots>;
    try {
      result = this.dependencies.listBackupRoots(source);
    } catch {
      result = { status: "failed", roots: [] };
    }
    this.host.send({ type: "backup-roots-result", ...result }, () => undefined);
  }

  /** Only a child that has not started maintains a database: a serving backend holds it open. */
  private async maintain(request: {
    readonly mode: "maintain" | "check";
    readonly databasePath: string;
    readonly backupDirectory?: string;
  }): Promise<void> {
    if (this.phase !== "idle" || !this.dependencies.maintain) {
      this.host.log("[desktop-child] dropped a maintenance request: not a preview child");
      this.host.send({ type: "maintain-result", mode: request.mode, status: "failed" }, () => undefined);
      return;
    }
    let result: Awaited<ReturnType<typeof maintainForApp>>;
    try {
      result = await this.dependencies.maintain(request);
    } catch {
      result = { mode: request.mode, status: "failed" };
    }
    this.host.send({ type: "maintain-result", ...result }, () => undefined);
  }

  /** Answers how much space a compaction would give back; a backend that is not serving has no answer. */
  private async reportMaintenanceHint(requestId: string): Promise<void> {
    let hint: Awaited<ReturnType<typeof readMaintenanceHint>> = {};
    if (this.phase === "running" && this.databasePath && this.dependencies.maintenanceHint) {
      try {
        hint = await this.dependencies.maintenanceHint(this.databasePath);
      } catch {
        hint = {};
      }
    }
    this.host.send({ type: "maintenance-hint", requestId, ...hint }, () => undefined);
  }

  /** Only a child that has not started (a preview child) copies: a serving backend never reads another database. */
  private async copyDatabase(source: string, target: string): Promise<void> {
    if (this.phase !== "idle" || !this.dependencies.copyDatabase) {
      this.host.log("[desktop-child] dropped a copy request: not a preview child");
      this.host.send(
        { type: "copy-result", status: "failed", detail: "this process cannot copy a database" },
        () => undefined,
      );
      return;
    }
    let result: DatabaseCopyResult;
    try {
      result = await this.dependencies.copyDatabase(source, target);
    } catch {
      result = { status: "failed", detail: "the copy could not be made" };
    }
    this.host.send(
      {
        type: "copy-result",
        status: result.status,
        ...(result.identity ? { identity: result.identity } : {}),
        ...(result.detail ? { detail: result.detail } : {}),
      },
      () => undefined,
    );
  }

  private inspectBackups(request: {
    readonly databasePath: string;
    readonly backupDirectory?: string;
    readonly files?: readonly string[];
    readonly integrity?: boolean;
    readonly limit?: number;
  }): void {
    if (this.phase !== "idle" || !this.dependencies.inspectBackups) {
      this.host.log("[desktop-child] dropped an inspect request: not a preview child");
      this.host.send({ type: "inspect-result", items: [], directoryReadable: false }, () => undefined);
      return;
    }
    let result: InspectBackupsResult;
    try {
      result = this.dependencies.inspectBackups(request);
    } catch {
      result = { items: [], directoryReadable: false };
    }
    this.host.send(
      { type: "inspect-result", items: [...result.items], directoryReadable: result.directoryReadable },
      () => undefined,
    );
  }

  /** Only a child that has not started replaces a database: a serving backend never does. */
  private restoreDatabase(request: {
    readonly source: string;
    readonly databasePath: string;
    readonly backupDirectory?: string;
  }): void {
    if (this.phase !== "idle" || !this.dependencies.restoreFromBackup) {
      this.host.log("[desktop-child] dropped a restore request: not a preview child");
      this.host.send(
        { type: "restore-result", status: "failed", detail: "this process cannot restore" },
        () => undefined,
      );
      return;
    }
    let result: ReturnType<typeof restoreFromBackup>;
    try {
      result = this.dependencies.restoreFromBackup(request);
    } catch {
      result = { status: "failed", detail: "the restore did not replace the database (failed)" };
    }
    this.host.send({ type: "restore-result", ...result }, () => undefined);
  }

  private async preflight(path: string, createIfMissing: boolean, quickCheck: boolean): Promise<void> {
    if (this.phase !== "idle") {
      this.host.log("[desktop-child] dropped a preflight request: already started");
      return;
    }
    let result: DatabasePreflightResult;
    try {
      const creation = createIfMissing ? this.dependencies.createDatabase?.(path) : undefined;
      result = creation ?? (await this.dependencies.preflight(path, quickCheck ? { quickCheck } : undefined));
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
    this.facts = message.desktop;
    this.databasePath = message.database.path;
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
      return this.fail({ code: portFailureCode(probe.code), detail: `listen failed (${probe.code})` });
    }
    const hold = this.dependencies.holdBeforeOpen;
    // Without the seam (always, in production) nothing is awaited here, so the start's timing is unchanged.
    if (hold) {
      try {
        await hold(() => this.phase === "starting");
      } catch {
        return this.fail({ code: "REPAIR_REQUIRED", detail: "the test hold failed" });
      }
      if (this.phase !== "starting") return;
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
        desktop: {
          getFacts: () => this.facts,
          onOpenAgentSetup: () => this.host.send({ type: "open-agent-setup" }, () => undefined),
          // Already sanitized by the route service; the preferences are only handed on, never logged.
          onOpenPortSettings: ({ preferences, route }) =>
            this.host.send(
              {
                type: "open-port-settings",
                preferences: sanitizeBrowserPreferences(preferences),
                route: sanitizeHandoffRoute(route),
              },
              () => undefined,
            ),
        },
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
          ...(listening.projectCount !== undefined ? { projectCount: listening.projectCount } : {}),
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
