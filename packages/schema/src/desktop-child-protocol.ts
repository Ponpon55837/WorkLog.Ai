import { z } from "zod";

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
  sidecars: z.strictObject({ before: sidecarStateSchema, after: sidecarStateSchema }).optional(),
  detail: z.string().max(MAX_DETAIL_LENGTH).optional(),
});

const preflightRequestSchema = z.strictObject({ type: z.literal("preflight"), path: pathSchema });

const startRequestSchema = z.strictObject({
  type: z.literal("start"),
  runId: runIdSchema,
  port: portSchema,
  database: z.strictObject({ path: pathSchema, identity: desktopDatabaseIdentitySchema }),
  backupDirectory: pathSchema.optional(),
});

const shutdownRequestSchema = z.strictObject({ type: z.literal("shutdown") });

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
});

const failedSchema = z.strictObject({
  type: z.literal("failed"),
  code: z.enum(DESKTOP_BACKEND_ERROR_CODES),
  detail: z.string().max(MAX_DETAIL_LENGTH),
});

const stoppedSchema = z.strictObject({ type: z.literal("stopped") });

/** Parent to child. */
export const desktopParentMessageSchema = z.discriminatedUnion("type", [
  preflightRequestSchema,
  startRequestSchema,
  shutdownRequestSchema,
]);

/** Child to parent. */
export const desktopChildMessageSchema = z.discriminatedUnion("type", [
  helloSchema,
  desktopPreflightResultSchema,
  readySchema,
  failedSchema,
  stoppedSchema,
]);

export type DesktopDatabaseIdentity = z.infer<typeof desktopDatabaseIdentitySchema>;
export type DesktopPreflightResultMessage = z.infer<typeof desktopPreflightResultSchema>;
export type DesktopParentMessage = z.infer<typeof desktopParentMessageSchema>;
export type DesktopChildMessage = z.infer<typeof desktopChildMessageSchema>;
export type DesktopStartMessage = z.infer<typeof startRequestSchema>;
export type DesktopReadyMessage = z.infer<typeof readySchema>;
export type DesktopHelloMessage = z.infer<typeof helloSchema>;

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
