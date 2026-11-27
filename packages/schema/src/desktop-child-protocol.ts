import { z } from "zod";
import { MAX_HANDOFF_ROUTE_LENGTH } from "./port-handoff.js";

/** Version of the private parent/child control protocol; a different version is a repair case, never a fallback. */
export const DESKTOP_CHILD_PROTOCOL_VERSION = 1;

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

export const desktopDatabaseIdentitySchema = z.strictObject({
  realPath: pathSchema,
  fileId: z
    .strictObject({ device: z.string().regex(DECIMAL_STRING), inode: z.string().regex(DECIMAL_STRING) })
    .nullable(),
  lineageId: z.string().regex(HEX64).nullable(),
});

const sidecarFileSchema = z.strictObject({ exists: z.boolean(), size: z.number().int().nonnegative() });
const sidecarStateSchema = z.strictObject({ wal: sidecarFileSchema, shm: sidecarFileSchema });

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

// Lets the App tell a damaged database from one it merely could not read (locked, timed out, denied).
export const DESKTOP_INTEGRITY_CHECK_FAILED_DETAIL = "the database failed its integrity check";

// `createIfMissing` creates only when nothing at all exists at the path; without it the preflight stays read-only.
const preflightRequestSchema = z.strictObject({
  type: z.literal("preflight"),
  path: pathSchema,
  createIfMissing: z.literal(true).optional(),
  quickCheck: z.literal(true).optional(),
});

export const SHELL_LANGUAGE_PREFERENCES = ["system", "zh-TW", "en"] as const;
// The Dashboard calls English `en-US`.
export const SHELL_LOCALES = ["zh-TW", "en"] as const;

/** Every field is optional so an older shell and a newer child (or the reverse) still understand each other. */
export const desktopFactsSchema = z.strictObject({
  /** Not strict: an older shell still sends removal commands this version no longer reads; they are dropped. */
  legacyService: z.object({ running: z.enum(["running", "stopped", "unknown"]) }).optional(),
  activePort: portSchema.optional(),
  launcherShimPath: pathSchema.optional(),
  runtimeRoot: pathSchema.optional(),
  /** Read in the shell, never from the settings file. */
  loginItem: z
    .strictObject({
      supported: z.boolean(),
      desired: z.boolean(),
      system: z.enum(["enabled", "disabled", "needs-approval", "unknown"]),
    })
    .optional(),
  /** `unknown` means detection failed or timed out; a soft note only. */
  storageRisk: z
    .strictObject({
      risk: z.enum(["network", "removable", "cloud-sync", "hard-link", "unknown"]),
      migrationBlocked: z.boolean(),
    })
    .optional(),
  language: z
    .strictObject({ preference: z.enum(SHELL_LANGUAGE_PREFERENCES), locale: z.enum(SHELL_LOCALES) })
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

const requestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

const activityQuerySchema = z.strictObject({ type: z.literal("activity-query"), requestId: requestIdSchema });

const updateFactsSchema = z.strictObject({ type: z.literal("update-facts"), desktop: desktopFactsSchema });

// Preview child only; the source is never migrated or changed and `target` must not exist yet.
const copyDatabaseRequestSchema = z.strictObject({
  type: z.literal("copy-database"),
  source: pathSchema,
  target: pathSchema,
});

export const DESKTOP_MAX_INSPECTED_BACKUPS = 50;

const inspectBackupsRequestSchema = z.strictObject({
  type: z.literal("inspect-backups"),
  databasePath: pathSchema,
  backupDirectory: pathSchema.optional(),
  files: z.array(pathSchema).min(1).max(DESKTOP_MAX_INSPECTED_BACKUPS).optional(),
  // False skips `PRAGMA quick_check` (a listing); absent or true runs it.
  integrity: z.boolean().optional(),
  /** At most this many of the newest backups of the folder (default and maximum: `DESKTOP_MAX_INSPECTED_BACKUPS`). */
  limit: z.number().int().min(1).max(DESKTOP_MAX_INSPECTED_BACKUPS).optional(),
});

// Restore is sent only while the backend is stopped.
export const DESKTOP_MAX_RESTORE_REMAPS = 500;

const restoreDatabaseRequestSchema = z.strictObject({
  type: z.literal("restore-database"),
  source: pathSchema,
  databasePath: pathSchema,
  backupDirectory: pathSchema.optional(),
  remap: z
    .array(z.strictObject({ from: pathSchema, to: pathSchema }))
    .max(DESKTOP_MAX_RESTORE_REMAPS)
    .optional(),
});

const backupRootsRequestSchema = z.strictObject({ type: z.literal("backup-roots"), source: pathSchema });

const maintainDatabaseRequestSchema = z.strictObject({
  type: z.literal("maintain-database"),
  mode: z.enum(["maintain", "check"]),
  databasePath: pathSchema,
  backupDirectory: pathSchema.optional(),
});

const maintenanceHintQuerySchema = z.strictObject({
  type: z.literal("maintenance-hint-query"),
  requestId: requestIdSchema,
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
  // Optional so an older child and a newer shell still understand each other.
  projectCount: z.number().int().nonnegative().optional(),
});

const failedSchema = z.strictObject({
  type: z.literal("failed"),
  code: z.enum(DESKTOP_BACKEND_ERROR_CODES),
  detail: z.string().max(MAX_DETAIL_LENGTH),
});

const stoppedSchema = z.strictObject({ type: z.literal("stopped") });

const backupCompletedSchema = z.strictObject({ type: z.literal("backup-completed"), at: z.iso.datetime() });

const backupsChangedSchema = z.strictObject({ type: z.literal("backups-changed") });

const openAgentSetupSchema = z.strictObject({ type: z.literal("open-agent-setup") });

// The App sanitizes the preferences and route again and keeps them in memory only.
const openPortSettingsSchema = z.strictObject({
  type: z.literal("open-port-settings"),
  preferences: z.unknown().optional(),
  route: z.string().max(MAX_HANDOFF_ROUTE_LENGTH).optional(),
});

const setLanguageSchema = z.strictObject({ type: z.literal("set-language"), locale: z.enum(SHELL_LOCALES) });

// `restore` is reserved: the server has no restore route yet, so nothing reports it today.
export const DESKTOP_BACKEND_ACTIVITIES = ["import", "backup", "export", "restore"] as const;

const activitySchema = z.strictObject({
  type: z.literal("activity"),
  requestId: requestIdSchema,
  busy: z.array(z.enum(DESKTOP_BACKEND_ACTIVITIES)).max(DESKTOP_BACKEND_ACTIVITIES.length),
  /** Not a job: a restart throws it away. Absent means false. */
  pendingImport: z.boolean().optional(),
});

/** The project folders of a backup, as the file records them (`path` is for the parent and never goes to a page). */
export const DESKTOP_MAX_BACKUP_ROOTS = 2000;
const backupRootsResultSchema = z.strictObject({
  type: z.literal("backup-roots-result"),
  status: z.enum(["ok", "failed"]),
  roots: z.array(z.strictObject({ path: pathSchema, name: z.string().max(512) })).max(DESKTOP_MAX_BACKUP_ROOTS),
  truncated: z.boolean().optional(),
});

// Everything but `ok` means the database was left as it was.
const maintainResultSchema = z.strictObject({
  type: z.literal("maintain-result"),
  mode: z.enum(["maintain", "check"]),
  status: z.enum(["ok", "in-use", "missing", "invalid", "integrity-failed", "backup-failed", "failed"]),
  backupFileName: z.string().max(512).optional(),
  reclaimedBytes: z.number().int().nonnegative().optional(),
});

const maintenanceRunSchema = z.strictObject({
  status: z.enum(["running", "completed", "failed"]),
  at: z.string().max(64),
  failureCode: z.enum(["DATABASE_INTEGRITY_FAILED", "DATABASE_MAINTENANCE_FAILED"]).optional(),
});

const maintenanceHintSchema = z.strictObject({
  type: z.literal("maintenance-hint"),
  requestId: requestIdSchema,
  reclaimableBytes: z.number().int().nonnegative().optional(),
  databaseBytes: z.number().int().nonnegative().optional(),
  suggest: z.boolean().optional(),
  last: maintenanceRunSchema.optional(),
});

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
  directoryReadable: z.boolean(),
});

/**
 * Everything but `ok` means the current database was NOT replaced; `locked` is a file lock (EBUSY / EPERM, mostly
 * Windows), `in-use` another process holding the database.
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
  safetyBackup: z.string().max(512).optional(),
  schemaVersion: z.number().int().nonnegative().optional(),
  projects: z.number().int().nonnegative().optional(),
  sessions: z.number().int().nonnegative().optional(),
  remappedProjects: z.number().int().nonnegative().optional(),
  detail: z.string().max(MAX_DETAIL_LENGTH).optional(),
});

export const desktopParentMessageSchema = z.discriminatedUnion("type", [
  preflightRequestSchema,
  startRequestSchema,
  shutdownRequestSchema,
  activityQuerySchema,
  updateFactsSchema,
  copyDatabaseRequestSchema,
  inspectBackupsRequestSchema,
  restoreDatabaseRequestSchema,
  backupRootsRequestSchema,
  maintainDatabaseRequestSchema,
  maintenanceHintQuerySchema,
]);

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
  setLanguageSchema,
  activitySchema,
  copyResultSchema,
  inspectResultSchema,
  restoreResultSchema,
  backupRootsResultSchema,
  maintainResultSchema,
  maintenanceHintSchema,
]);

export type DesktopDatabaseIdentity = z.infer<typeof desktopDatabaseIdentitySchema>;
export type DesktopPreflightResultMessage = z.infer<typeof desktopPreflightResultSchema>;
export type DesktopParentMessage = z.infer<typeof desktopParentMessageSchema>;
export type DesktopChildMessage = z.infer<typeof desktopChildMessageSchema>;
export type DesktopFacts = z.infer<typeof desktopFactsSchema>;
export type ShellLanguagePreference = (typeof SHELL_LANGUAGE_PREFERENCES)[number];
export type DesktopStartMessage = z.infer<typeof startRequestSchema>;
export type DesktopReadyMessage = z.infer<typeof readySchema>;
export type DesktopHelloMessage = z.infer<typeof helloSchema>;
export type DesktopBackendActivity = (typeof DESKTOP_BACKEND_ACTIVITIES)[number];
export type DesktopCopyResultMessage = z.infer<typeof copyResultSchema>;
export type DesktopInspectResultMessage = z.infer<typeof inspectResultSchema>;
export type DesktopInspectedBackup = z.infer<typeof inspectedBackupSchema>;
export type DesktopRestoreResultMessage = z.infer<typeof restoreResultSchema>;
export type DesktopBackupRootsResultMessage = z.infer<typeof backupRootsResultSchema>;
export type DesktopMaintainResultMessage = z.infer<typeof maintainResultSchema>;
export type DesktopMaintenanceHintMessage = z.infer<typeof maintenanceHintSchema>;

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

export function parseDesktopParentMessage(value: unknown): ParsedDesktopMessage<DesktopParentMessage> {
  return parseWith(desktopParentMessageSchema, value);
}

export function parseDesktopChildMessage(value: unknown): ParsedDesktopMessage<DesktopChildMessage> {
  return parseWith(desktopChildMessageSchema, value);
}
