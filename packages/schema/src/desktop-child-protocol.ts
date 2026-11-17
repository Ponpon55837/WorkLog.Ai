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
  /** A login service from the pnpm bootstrap that may share this database with the App's own backend. */
  legacyService: z
    .strictObject({
      running: z.enum(["running", "stopped", "unknown"]),
      removeCommand: z.string().max(MAX_PATH_LENGTH).optional(),
      fallbackRemoveCommand: z.string().max(MAX_PATH_LENGTH),
    })
    .optional(),
  /** The port the App committed for this backend, so the status page can show the effective address. */
  activePort: portSchema.optional(),
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
 * The long jobs a running backend reports; any of them makes a port change wait. `restore` is reserved for a future
 * restore flow: the server has no restore route yet, so nothing reports it today.
 */
export const DESKTOP_BACKEND_ACTIVITIES = ["import", "backup", "export", "restore"] as const;

const activitySchema = z.strictObject({
  type: z.literal("activity"),
  requestId: requestIdSchema,
  busy: z.array(z.enum(DESKTOP_BACKEND_ACTIVITIES)).max(DESKTOP_BACKEND_ACTIVITIES.length),
});

/** Result of `copy-database`; on `ok` the identity is the copy's, read back after the integrity check. */
const copyResultSchema = z.strictObject({
  type: z.literal("copy-result"),
  status: z.enum(["ok", "no-space", "target-exists", "integrity-failed", "failed"]),
  identity: desktopDatabaseIdentitySchema.optional(),
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
