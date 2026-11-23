import path from "node:path";
import { SHELL_LANGUAGE_PREFERENCES } from "@work-intelligence/schema";
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

/** Why a database path is refused; `undefined` means it is supported. */
export type DatabasePathProblem = "empty" | "not-absolute" | "unc" | "device";

/** The App's reason for each refusal, in both UI languages (first-run page and any other surface show these). */
export const DATABASE_PATH_PROBLEM_MESSAGES: Readonly<Record<DatabasePathProblem, { "zh-TW": string; en: string }>> = {
  empty: { "zh-TW": "請輸入資料庫路徑。", en: "Enter a database path." },
  "not-absolute": { "zh-TW": "資料庫路徑必須是絕對路徑。", en: "The database path must be absolute." },
  unc: {
    "zh-TW":
      "不支援網路共用路徑（\\\\伺服器\\共用），SQLite 在 SMB 上不安全。請先自己把資料庫複製到這台電腦的本機磁碟，再選擇複製後的檔案。",
    en: "Network share paths (\\\\server\\share) are not supported because SQLite over SMB is unsafe. Copy the database to a local disk on this computer yourself first, then choose the copy.",
  },
  device: {
    "zh-TW": "不支援 \\\\?\\ 或 \\\\.\\ 裝置路徑；請選擇一般的本機磁碟路徑。",
    en: "Device paths (\\\\?\\ or \\\\.\\) are not supported; choose a normal local drive path.",
  },
};

const WINDOWS_DRIVE_ROOT = /^[A-Za-z]:[\\/]/;

/**
 * The one database path rule the App (settings schema, first-run page) and the Agent launcher share. A path must be
 * absolute and must not be a UNC (`\\\\server\\share`, `//server/share`) or device (`\\\\?\\`, `\\\\.\\`) path: SQLite over
 * SMB is risky. With `platform` the form must fit that OS (a drive path on win32, `/…` elsewhere); without it either
 * absolute form passes, because settings may be read on either OS.
 */
export function databasePathProblem(value: string, platform?: NodeJS.Platform): DatabasePathProblem | undefined {
  if (!value || value.includes("\0")) return "empty";
  if (/^[\\/]{2}[?.][\\/]/.test(value)) return "device";
  if (/^[\\/]{2}/.test(value)) return "unc";
  const posix = value.startsWith("/");
  const drive = WINDOWS_DRIVE_ROOT.test(value);
  const fits = platform === undefined ? posix || drive : platform === "win32" ? drive : posix;
  return fits ? undefined : "not-absolute";
}

/** True when {@link databasePathProblem} finds nothing wrong. */
export function isSupportedDatabasePath(value: string, platform?: NodeJS.Platform): boolean {
  return databasePathProblem(value, platform) === undefined;
}

const databasePathSchema = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    const problem = databasePathProblem(value);
    if (problem !== undefined)
      context.addIssue({ code: "custom", message: DATABASE_PATH_PROBLEM_MESSAGES[problem].en });
  });

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
    databasePath: databasePathSchema,
    port: portSchema,
    launchAtLogin: z.boolean(),
    backupDirectory: absolutePathSchema,
    /**
     * The App's language. Absent means 「跟隨系統」: a file written before the setting existed reads as
     * it always did, and 「跟隨系統」 is written by leaving the field out, so the file keeps the older shape.
     */
    language: z.enum(SHELL_LANGUAGE_PREFERENCES).optional(),
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
