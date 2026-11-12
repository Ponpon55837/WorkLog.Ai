import { z } from "zod";

export interface FileHistoryCursor {
  completedAt: string;
  id: string;
}

export const FILE_HISTORY_PATH_LIMIT = 3;
export const FILE_HISTORY_SESSION_LIMIT = 10;

const MAX_PATH_LENGTH = 500;
const MAX_CURSOR_LENGTH = 400;

// btoa/atob with TextEncoder keep this module free of Node built-ins, since the Web bundles the schema package too.
function toBase64Url(text: string): string {
  const binary = String.fromCharCode(...new TextEncoder().encode(text));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

/**
 * A path inside the repository as an Agent names it: relative, either separator, no parent segments, no drive,
 * UNC, or home prefix, and no control characters. Stored records are read by it; the file system never is.
 */
export function isRepositoryRelativePath(value: string): boolean {
  const path = value.replace(/\\/g, "/");
  const control = [...path].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);
  if (control || path.startsWith("/") || path.startsWith("~") || /^[a-z]:/i.test(path)) {
    return false;
  }
  return !path.split("/").some((segment) => segment === "..");
}

export function encodeFileHistoryCursor(cursor: FileHistoryCursor): string {
  return toBase64Url(JSON.stringify([cursor.completedAt, cursor.id]));
}

/** The position an earlier answer stopped at, or undefined for anything that encodeFileHistoryCursor did not make. */
export function decodeFileHistoryCursor(value: string): FileHistoryCursor | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const parsed: unknown = JSON.parse(fromBase64Url(value));
    if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;
    const [completedAt, id] = parsed as unknown[];
    if (typeof completedAt !== "string" || completedAt.length === 0 || completedAt.length > 64) return undefined;
    if (typeof id !== "string" || id.length === 0 || id.length > 200) return undefined;
    return { completedAt, id };
  } catch {
    return undefined;
  }
}

export const fileHistoryQuerySchemaBase = z
  .object({
    projectRoot: z.string().trim().min(1).max(1_000),
    paths: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(MAX_PATH_LENGTH)
          .refine(isRepositoryRelativePath, "Paths must be repository-relative, without '..' segments."),
      )
      .min(1)
      .max(FILE_HISTORY_PATH_LIMIT),
    limit: z.number().int().min(1).max(FILE_HISTORY_SESSION_LIMIT).optional(),
    cursor: z
      .string()
      .trim()
      .min(1)
      .max(MAX_CURSOR_LENGTH)
      .refine((value) => decodeFileHistoryCursor(value) !== undefined, "cursor must be a nextCursor value.")
      .optional(),
  })
  .strict();

export const fileHistoryQuerySchema = fileHistoryQuerySchemaBase.refine(
  (query) => query.cursor === undefined || query.paths.length === 1,
  { message: "cursor pages one path; pass exactly one path with it.", path: ["cursor"] },
);
