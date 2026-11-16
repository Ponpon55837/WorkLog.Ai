import path from "node:path";
import { z } from "zod";
import { databaseIdentitySchema } from "../db-source/identity-schema.js";

/** Why a raw settings value was rejected; `unsupported-version` is deliberately distinct so callers never coerce it. */
export type DesktopSettingsParseFailureKind = "invalid-schema" | "unsupported-version";

/** Outcome of validating a raw settings value. */
export type DesktopSettingsParseResult =
  | { readonly ok: true; readonly settings: DesktopSettingsV1 }
  | { readonly ok: false; readonly kind: DesktopSettingsParseFailureKind; readonly detail: string };

/** Accept POSIX and win32 absolute forms regardless of the host OS (settings may be read on either). */
function isAbsolutePath(value: string): boolean {
  return !value.includes("\0") && (path.posix.isAbsolute(value) || path.win32.isAbsolute(value));
}

const absolutePathSchema = z.string().min(1).refine(isAbsolutePath, { message: "must be an absolute path" });
const portSchema = z.number().int().min(1).max(65535);
const runtimeVersionSchema = z.string().min(1);

/**
 * Version 1 of the desktop settings file. `installId` is an install label only and is not an
 * auth secret. `desired` is user intent; `active`/`lastKnownGood` are what the supervisor last ran.
 */
export const desktopSettingsV1Schema = z.strictObject({
  configVersion: z.literal(1),
  installId: z.string().min(1),
  desired: z.strictObject({
    databasePath: absolutePathSchema,
    port: portSchema,
    launchAtLogin: z.boolean(),
    backupDirectory: absolutePathSchema,
  }),
  active: z
    .strictObject({
      databaseIdentity: databaseIdentitySchema,
      port: portSchema,
      runtimeVersion: runtimeVersionSchema,
      serviceOwner: z.literal("desktop"),
    })
    .nullable()
    .optional(),
  lastKnownGood: z
    .strictObject({
      databaseIdentity: databaseIdentitySchema,
      port: portSchema,
      runtimeVersion: runtimeVersionSchema,
    })
    .nullable()
    .optional(),
});

/** Validated version-1 settings. */
export type DesktopSettingsV1 = z.infer<typeof desktopSettingsV1Schema>;

function parseV1(raw: unknown): DesktopSettingsParseResult {
  const result = desktopSettingsV1Schema.safeParse(raw);
  if (result.success) return { ok: true, settings: result.data };
  const detail = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
  return { ok: false, kind: "invalid-schema", detail };
}

const VERSION_PARSERS: ReadonlyMap<number, (raw: unknown) => DesktopSettingsParseResult> = new Map([[1, parseV1]]);

/**
 * Version dispatcher: reads `configVersion` and routes to that version's parser. Any integer version
 * without a parser (future or ancient) fails closed as `unsupported-version`; it is never coerced,
 * because a newer app may have written fields this build would silently drop.
 */
export function parseDesktopSettings(raw: unknown): DesktopSettingsParseResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, kind: "invalid-schema", detail: "settings must be a JSON object" };
  }
  const version = (raw as Record<string, unknown>).configVersion;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return { ok: false, kind: "invalid-schema", detail: "configVersion must be an integer" };
  }
  const parser = VERSION_PARSERS.get(version);
  if (parser === undefined) {
    return { ok: false, kind: "unsupported-version", detail: `unsupported configVersion ${version}` };
  }
  return parser(raw);
}
