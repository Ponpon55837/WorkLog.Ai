import { z } from "zod";
import { MAX_HANDOFF_ROUTE_LENGTH } from "./port-handoff.js";

/** Version of the private parent/child control protocol; a different version is a repair case, never a fallback. */
export const DESKTOP_CHILD_PROTOCOL_VERSION = 1;

/**
 * Every failure the desktop backend can report, on either side of the channel (R4 section 8.1 plus the supervisor's own
 * checks). One list so the child, the supervisor and the shell never disagree about a spelling.
 */
export const DESKTOP_BACKEND_ERROR_CODES = [
  "DB_MISSING",
  "DB_OFFLINE",
  "DB_PERMISSION",
  "DB_IDENTITY_CHANGED",
  "SCHEMA_TOO_NEW",
  "SCHEMA_MIGRATION_BLOCKED",
  "PORT_OCCUPIED_BY_OTHER",
  "PORT_NOT_PERMITTED",
  "PORT_NOT_RELEASED",
  "RUNTIME_MISSING",
  "SERVICE_IDENTITY_MISMATCH",
  "CHILD_START_TIMEOUT",
  "CHILD_PROTOCOL_ERROR",
  "CHILD_EXITED",
  "REPAIR_REQUIRED",
] as const;

export type DesktopBackendErrorCode = (typeof DESKTOP_BACKEND_ERROR_CODES)[number];

const MAX_PATH_LENGTH = 4096;
const MAX_DETAIL_LENGTH = 2000;
/** A runId is a per-spawn secret (R4 section 5.1): unpredictable, URL-safe, never shown by the plain health endpoint. */
const RUN_ID = /^[A-Za-z0-9_-]{22,128}$/;
const DECIMAL_STRING = /^\d+$/;
const HEX64 = /^[0-9a-f]{64}$/;

const pathSchema = z.string().min(1).max(MAX_PATH_LENGTH);
const portSchema = z.number().int().min(1).max(65_535);
const runIdSchema = z.string().regex(RUN_ID);
const protocolVersionSchema = z.number().int().nonnegative();
const processIdSchema = z.number().int().positive();

/** Same shape as desktop-core's persisted database identity and the server's preflight identity. */
export const desktopDatabaseIdentitySchema = z.strictObject({
  realPath: pathSchema,
  fileId: z
    .strictObject({ device: z.string().regex(DECIMAL_STRING), inode: z.string().regex(DECIMAL_STRING) })
    .nullable(),
  lineageId: z.string().regex(HEX64).nullable(),
});

const sidecarFileSchema = z.strictObject({ exists: z.boolean(), size: z.number().int().nonnegative() });
const sidecarStateSchema = z.strictObject({ wal: sidecarFileSchema, shm: sidecarFileSchema });

/** Result of the child's read-only preflight; the statuses are the server's `DatabasePreflightStatus`. */
export const desktopPreflightResultSchema = z.strictObject({
  type: z.literal("preflight-result"),
  status: z.enum(["missing", "offline", "denied", "unreadable", "unsupported-schema", "ok"]),
  identity: desktopDatabaseIdentitySchema.optional(),
  schemaVersion: z.number().int().nonnegative().optional(),
  compatibility: z.enum(["empty", "current", "older-needs-migration", "newer-unsupported"]).optional(),
  projectCount: z.number().int().nonnegative().optional(),
  /** A few project names (most recently updated first) so the user recognises the database; shown, never stored. */
  projectNames: z.array(z.string().min(1).max(120)).max(5).optional(),
  sidecars: z.strictObject({ before: sidecarStateSchema, after: sidecarStateSchema }).optional(),
  detail: z.string().max(MAX_DETAIL_LENGTH).optional(),
});

/**
 * The one fixed `detail` a preflight result may carry for a failed `quickCheck`, so the App can tell a damaged database
 * from one it merely could not read (locked, timed out, denied).
 */
export const DESKTOP_INTEGRITY_CHECK_FAILED_DETAIL = "the database failed its integrity check";

/**
 * `createIfMissing` asks the child to create a new empty database first, but only when nothing at all exists at the path;
 * without it the preflight stays read-only. `quickCheck` asks for an extra read-only `PRAGMA quick_check` on a database
 * that otherwise reads fine, for a database an old service may have been hard-stopped on.
 */
const preflightRequestSchema = z.strictObject({
  type: z.literal("preflight"),
  path: pathSchema,
  createIfMissing: z.literal(true).optional(),
  quickCheck: z.literal(true).optional(),
});

/**
 * Facts only the desktop shell knows, passed through the protocol (never the environment). Every field is optional so an
 * older shell and a newer child (or the reverse) still understand each other.
 */
export const desktopFactsSchema = z.strictObject({
  /**
   * A login service from the pnpm bootstrap that may share this database with the App's own backend. Not strict: an
   * older shell still sends the removal commands this version no longer reads, and they are dropped.
   */
  legacyService: z.object({ running: z.enum(["running", "stopped", "unknown"]) }).optional(),
  /** The port the App committed for this backend, so the status page can show the effective address. */
  activePort: portSchema.optional(),
  /**
   * The App's launcher shim, so the Web status judges an Agent's hooks by the same rule as the Agent page: a hook that
   * runs another shim is stale.
   */
  launcherShimPath: pathSchema.optional(),
  /**
   * The App's login item as the system reports it (read in the shell, never from the settings file), so the Web status
   * shows the App's own state instead of the old login service's.
   */
  loginItem: z
    .strictObject({
      supported: z.boolean(),
      desired: z.boolean(),
      system: z.enum(["enabled", "disabled", "needs-approval", "unknown"]),
    })
    .optional(),
  /**
   * Positively detected risky storage for the database (DT-08). `unknown` means detection failed or timed out and is a
   * soft note only; it never blocks anything.
   */
  storageRisk: z
    .strictObject({
      risk: z.enum(["network", "removable", "cloud-sync", "hard-link", "unknown"]),
      migrationBlocked: z.boolean(),
    })
    .optional(),
});

const startRequestSchema = z.strictObject({
  type: z.literal("start"),
  runId: runIdSchema,
  port: portSchema,
  database: z.strictObject({ path: pathSchema, identity: desktopDatabaseIdentitySchema }),
  backupDirectory: pathSchema.optional(),
  desktop: desktopFactsSchema.optional(),
});

const shutdownRequestSchema = z.strictObject({ type: z.literal("shutdown") });

/** A short id the parent picks so it can match a reply to its request. */
const requestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

/** Asks a running backend which long jobs are in progress, so the App can refuse a port change while one runs. */
const activityQuerySchema = z.strictObject({ type: z.literal("activity-query"), requestId: requestIdSchema });

/** Replaces the desktop facts of a running backend, for facts the App learns after start (DT-08 storage risk). */
const updateFactsSchema = z.strictObject({ type: z.literal("update-facts"), desktop: desktopFactsSchema });

/**
 * Asks a preview child (never a serving one) for a consistent copy of `source` at `target`, which must not exist yet.
 * The source is never migrated or changed; the child runs PRAGMA quick_check on the copy before it answers (DT-08).
 */
const copyDatabaseRequestSchema = z.strictObject({
  type: z.literal("copy-database"),
  source: pathSchema,
  target: pathSchema,
});

/** Most backup files one `inspect-backups` answers for; the page lists the newest ones only. */
export const DESKTOP_MAX_INSPECTED_BACKUPS = 50;

/**
 * Asks a preview child to look, read-only, at the backups of `databasePath` (its backup folder, or `backupDirectory`) or,
 * when `files` is given, at exactly those files (a file the user picked). Nothing is opened for writing or migrated.
 */
const inspectBackupsRequestSchema = z.strictObject({
  type: z.literal("inspect-backups"),
  databasePath: pathSchema,
  backupDirectory: pathSchema.optional(),
  files: z.array(pathSchema).min(1).max(DESKTOP_MAX_INSPECTED_BACKUPS).optional(),
  /** False: skip `PRAGMA quick_check` (a listing); absent or true: run it (one chosen file). */
  integrity: z.boolean().optional(),
  /** At most this many of the newest backups of the folder (default and maximum: `DESKTOP_MAX_INSPECTED_BACKUPS`). */
  limit: z.number().int().min(1).max(DESKTOP_MAX_INSPECTED_BACKUPS).optional(),
});

/**
 * Asks a preview child to replace `databasePath` with the snapshot `source` (restoreDatabase of the storage package: the
 * snapshot is checked, the current database is backed up first, nothing else may hold it open). Sent only while the
 * backend is stopped.
 */
const restoreDatabaseRequestSchema = z.strictObject({
  type: z.literal("restore-database"),
  source: pathSchema,
  databasePath: pathSchema,
  backupDirectory: pathSchema.optional(),
});

const helloSchema = z.strictObject({
  type: z.literal("hello"),
  protocolVersion: protocolVersionSchema,
  pid: processIdSchema,
  execPath: pathSchema,
});

const readySchema = z.strictObject({
  type: z.literal("ready"),
  protocolVersion: protocolVersionSchema,
  runId: runIdSchema,
  port: portSchema,
  appVersion: z.string().min(1).max(100),
  schemaVersion: z.number().int().nonnegative(),
  databaseIdentity: desktopDatabaseIdentitySchema,
  execPath: pathSchema,
  pid: processIdSchema,
  /** How many projects the database holds; optional so an older child and a newer shell still understand each other. */
  projectCount: z.number().int().nonnegative().optional(),
});

const failedSchema = z.strictObject({
  type: z.literal("failed"),
  code: z.enum(DESKTOP_BACKEND_ERROR_CODES),
  detail: z.string().max(MAX_DETAIL_LENGTH),
});

const stoppedSchema = z.strictObject({ type: z.literal("stopped") });

/** The running backend wrote a backup successfully; `at` is the backup's UTC instant (ISO 8601). */
const backupCompletedSchema = z.strictObject({ type: z.literal("backup-completed"), at: z.iso.datetime() });

/**
 * An API call that can write or delete a backup file finished (a manual backup, an import, a deletion, ...). It carries
 * nothing: the shell only forgets what it cached about the backup folder and reads it again.
 */
const backupsChangedSchema = z.strictObject({ type: z.literal("backups-changed") });

/** The web UI asked the App to open its Agent setup window; it carries nothing and never changes any Agent config. */
const openAgentSetupSchema = z.strictObject({ type: z.literal("open-agent-setup") });

/**
 * The web UI asked the App to open its port settings (DT-14). It may carry the page's whitelisted preferences and route
 * so the App can restore them on the new origin; the App sanitizes both again and keeps them in memory only.
 */
const openPortSettingsSchema = z.strictObject({
  type: z.literal("open-port-settings"),
  preferences: z.unknown().optional(),
  route: z.string().max(MAX_HANDOFF_ROUTE_LENGTH).optional(),
});

/**
 * The long jobs a running backend reports; any of them makes a port change wait. `import` means an upload is being
 * saved or an import or preview is reading a staged file; a staged file nobody reads is `pendingImport` instead. `restore` is reserved for a future
 * restore flow: the server has no restore route yet, so nothing reports it today.
 */
export const DESKTOP_BACKEND_ACTIVITIES = ["import", "backup", "export", "restore"] as const;

const activitySchema = z.strictObject({
  type: z.literal("activity"),
  requestId: requestIdSchema,
  busy: z.array(z.enum(DESKTOP_BACKEND_ACTIVITIES)).max(DESKTOP_BACKEND_ACTIVITIES.length),
  /**
   * An uploaded import file is staged and idle (nobody reads it, it has not expired). It is not a job: a restart throws
   * it away, so it never blocks a port change, but the App tells the user afterwards. Absent means false.
   */
  pendingImport: z.boolean().optional(),
});

/** Result of `copy-database`; on `ok` the identity is the copy's, read back after the integrity check. */
const copyResultSchema = z.strictObject({
  type: z.literal("copy-result"),
  status: z.enum(["ok", "no-space", "target-exists", "integrity-failed", "failed"]),
  identity: desktopDatabaseIdentitySchema.optional(),
  detail: z.string().max(MAX_DETAIL_LENGTH).optional(),
});

/** What the child found in one backup file; names and numbers only. `path` is for the parent, never for a page. */
const inspectedBackupSchema = z.strictObject({
  path: pathSchema,
  fileName: z.string().min(1).max(512),
  /** Only for a file of the backup folder (the file name carries it). */
  kind: z
    .enum(["automatic", "manual", "migration", "deletion", "session_deletion", "maintenance", "import"])
    .optional(),
  createdAt: z.string().max(64).optional(),
  bytes: z.number().int().nonnegative(),
  status: z.enum(["ok", "newer-schema", "not-database", "corrupt", "unreadable", "missing"]),
  schemaVersion: z.number().int().nonnegative().optional(),
  projects: z.number().int().nonnegative().optional(),
  sessions: z.number().int().nonnegative().optional(),
});

const inspectResultSchema = z.strictObject({
  type: z.literal("inspect-result"),
  items: z.array(inspectedBackupSchema).max(DESKTOP_MAX_INSPECTED_BACKUPS),
  /** The backup folder could not be read at all (the files are missing or the folder is not readable). */
  directoryReadable: z.boolean(),
});

/**
 * Result of `restore-database`. Everything but `ok` means the current database was NOT replaced; `locked` is a file lock
 * (EBUSY / EPERM, mostly Windows), `in-use` another process holding the database (an Agent).
 */
const restoreResultSchema = z.strictObject({
  type: z.literal("restore-result"),
  status: z.enum([
    "ok",
    "in-use",
    "locked",
    "newer-schema",
    "not-database",
    "corrupt",
    "verify-failed",
    "missing",
    "same-file",
    "no-space",
    "failed",
  ]),
  /** The file name of the backup made of the replaced database. */
  safetyBackup: z.string().max(512).optional(),
  schemaVersion: z.number().int().nonnegative().optional(),
  projects: z.number().int().nonnegative().optional(),
  sessions: z.number().int().nonnegative().optional(),
  detail: z.string().max(MAX_DETAIL_LENGTH).optional(),
});

/** Parent to child. */
export const desktopParentMessageSchema = z.discriminatedUnion("type", [
  preflightRequestSchema,
  startRequestSchema,
  shutdownRequestSchema,
  activityQuerySchema,
  updateFactsSchema,
  copyDatabaseRequestSchema,
  inspectBackupsRequestSchema,
  restoreDatabaseRequestSchema,
]);

/** Child to parent. */
export const desktopChildMessageSchema = z.discriminatedUnion("type", [
  helloSchema,
  desktopPreflightResultSchema,
  readySchema,
  failedSchema,
  stoppedSchema,
  backupCompletedSchema,
  backupsChangedSchema,
  openAgentSetupSchema,
  openPortSettingsSchema,
  activitySchema,
  copyResultSchema,
  inspectResultSchema,
  restoreResultSchema,
]);

export type DesktopDatabaseIdentity = z.infer<typeof desktopDatabaseIdentitySchema>;
export type DesktopPreflightResultMessage = z.infer<typeof desktopPreflightResultSchema>;
export type DesktopParentMessage = z.infer<typeof desktopParentMessageSchema>;
export type DesktopChildMessage = z.infer<typeof desktopChildMessageSchema>;
export type DesktopFacts = z.infer<typeof desktopFactsSchema>;
export type DesktopStartMessage = z.infer<typeof startRequestSchema>;
export type DesktopReadyMessage = z.infer<typeof readySchema>;
export type DesktopHelloMessage = z.infer<typeof helloSchema>;
export type DesktopBackendActivity = (typeof DESKTOP_BACKEND_ACTIVITIES)[number];
export type DesktopCopyResultMessage = z.infer<typeof copyResultSchema>;
export type DesktopInspectResultMessage = z.infer<typeof inspectResultSchema>;
export type DesktopInspectedBackup = z.infer<typeof inspectedBackupSchema>;
export type DesktopRestoreResultMessage = z.infer<typeof restoreResultSchema>;

export type ParsedDesktopMessage<T> = { ok: true; message: T } | { ok: false; reason: string };

/** Names the failing field paths only: the rejected value may hold a path or a secret and must never be echoed. */
function describeIssues(error: z.ZodError): string {
  const paths = error.issues.map((issue) => issue.path.join(".") || "(message)");
  return `invalid message: ${[...new Set(paths)].slice(0, 5).join(", ")}`;
}

function parseWith<T>(schema: z.ZodType<T>, value: unknown): ParsedDesktopMessage<T> {
  const parsed = schema.safeParse(value);
  return parsed.success ? { ok: true, message: parsed.data } : { ok: false, reason: describeIssues(parsed.error) };
}

/** Parses one message the parent sent; an unknown or malformed message is reported, never thrown. */
export function parseDesktopParentMessage(value: unknown): ParsedDesktopMessage<DesktopParentMessage> {
  return parseWith(desktopParentMessageSchema, value);
}

/** Parses one message the child sent; an unknown or malformed message is reported, never thrown. */
export function parseDesktopChildMessage(value: unknown): ParsedDesktopMessage<DesktopChildMessage> {
  return parseWith(desktopChildMessageSchema, value);
}
