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

export interface DesktopChildHost {
  readonly pid: number;
  readonly execPath: string;
  send(message: DesktopChildMessage, done: () => void): void;
  onMessage(listener: (message: unknown) => void): void;
  onDisconnect(listener: () => void): void;
  onSignal(listener: () => void): void;
  exit(code: number): void;
  /** Diagnostic line for the parent's captured stderr; never a path, token or message body. */
  log(line: string): void;
}

export interface DesktopChildDependencies {
  preflight: (path: string, options?: { quickCheck?: boolean }) => Promise<DatabasePreflightResult>;
  createDatabase?: (path: string) => DatabasePreflightResult | undefined;
  copyDatabase?: (source: string, target: string) => Promise<DatabaseCopyResult>;
  inspectBackups?: typeof inspectBackups;
  restoreFromBackup?: typeof restoreFromBackup;
  listBackupRoots?: typeof listBackupProjectRoots;
  maintain?: typeof maintainForApp;
  maintenanceHint?: typeof readMaintenanceHint;
  probePort: (port: number) => Promise<LoopbackPortProbe>;
  startApi: (options: StartApiOptions) => StartedApi;
  holdBeforeOpen?: (stillStarting: () => boolean) => Promise<void>;
}

// Defined only by the desktop runtime bundle; a plain tsc, vitest or tsx run reads it as false.
declare const __WI_DESKTOP_TEST_BUILD__: boolean | undefined;

interface ChildFailure {
  code: DesktopBackendErrorCode;
  detail: string;
}

const REVALIDATION_FAILURES: Record<RevalidationFailureReason, ChildFailure> = {
  missing: { code: "DB_MISSING", detail: "the database file is missing" },
  offline: { code: "DB_OFFLINE", detail: "the database storage is offline" },
  denied: { code: "DB_PERMISSION", detail: "the database file cannot be read" },
  unreadable: { code: "REPAIR_REQUIRED", detail: "the database file cannot be read" },
  "path-replaced": { code: "DB_IDENTITY_CHANGED", detail: "the database path now resolves elsewhere" },
  "file-replaced": { code: "DB_IDENTITY_CHANGED", detail: "the database file was replaced" },
  "lineage-changed": { code: "DB_IDENTITY_CHANGED", detail: "the database history changed" },
};

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

/** The `detail` can carry the database path, so only these fixed classification texts leave this process. */
const PREFLIGHT_DETAILS: Record<DatabasePreflightResult["status"], string> = {
  ok: "the database can be opened",
  missing: "the database file is missing",
  offline: "the database storage is offline",
  denied: "the database file cannot be read",
  unreadable: "the database file cannot be read",
  "unsupported-schema": "the database schema is not supported by this build",
};

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
  // Folds to a constant in a bundle, so a production bundle drops this branch together with the hold module.
  holdBeforeOpen:
    typeof __WI_DESKTOP_TEST_BUILD__ !== "undefined" && __WI_DESKTOP_TEST_BUILD__
      ? async (stillStarting) => {
          const { migrationHoldFromEnvironment } = await import("./desktop-child-test-hold.js");
          await migrationHoldFromEnvironment(process.env, true)?.(stillStarting);
        }
      : undefined,
};

export class DesktopChild {
  private readonly host: DesktopChildHost;
  private readonly dependencies: DesktopChildDependencies;
  private phase: "idle" | "starting" | "running" | "stopping" = "idle";
  private api: StartedApi | undefined;
  private starting: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private facts: DesktopFacts | undefined;
  private failed = false;
  private exited = false;
  private databasePath: string | undefined;

  constructor(host: DesktopChildHost, dependencies: DesktopChildDependencies = defaultDependencies) {
    this.host = host;
    this.dependencies = dependencies;
  }

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

  private reportActivity(requestId: string): void {
    const busy = this.phase === "running" ? (this.api?.activity() ?? []) : [];
    const pendingImport = this.phase === "running" && (this.api?.hasPendingImport() ?? false);
    this.host.send({ type: "activity", requestId, busy, pendingImport }, () => undefined);
  }

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

  private async run(message: DesktopStartMessage): Promise<void> {
    // The store may migrate the database, so an unbindable port is found out before it opens. The probe cannot
    // close the window up to `listen`.
    let probe: LoopbackPortProbe;
    try {
      probe = await this.dependencies.probePort(message.port);
    } catch {
      return this.fail({ code: "REPAIR_REQUIRED", detail: "the port could not be probed" });
    }
    // A shutdown, disconnect or signal during the probe wins: nothing is opened.
    if (this.phase !== "starting") return;
    if (!probe.free) {
      return this.fail({ code: portFailureCode(probe.code), detail: `listen failed (${probe.code})` });
    }
    const hold = this.dependencies.holdBeforeOpen;
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
          onSetLanguage: (locale) => this.host.send({ type: "set-language", locale }, () => undefined),
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
      await api?.shutdown().catch(() => undefined);
      await this.fail(startFailure(error));
    }
  }

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

function processHost(): DesktopChildHost {
  return {
    pid: process.pid,
    execPath: process.execPath,
    send: (message, done) => {
      try {
        if (process.send) process.send(message, undefined, undefined, () => done());
        else done();
      } catch {
        // The channel closed between the check and the send; the disconnect handler owns the shutdown.
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
