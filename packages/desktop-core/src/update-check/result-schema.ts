import { z } from "zod";
import { NOTES_MAX_CHARACTERS } from "./sanitize.js";
import { UPDATE_ERROR_REASONS, UPDATE_PLATFORMS, type UpdateCheckResult } from "./result.js";

export const updateCheckResultSchema: z.ZodType<UpdateCheckResult> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("up-to-date"), current: z.string().max(64) }),
  z.strictObject({
    kind: z.literal("newer"),
    current: z.string().max(64),
    version: z.string().max(64),
    publishedAt: z.string().max(40).nullable(),
    notes: z.string().max(NOTES_MAX_CHARACTERS),
    notesTruncated: z.boolean(),
    asset: z.strictObject({ platform: z.enum(UPDATE_PLATFORMS) }).nullable(),
  }),
  z.strictObject({ kind: z.literal("offline"), timedOut: z.boolean() }),
  z.strictObject({ kind: z.literal("rate-limited"), resetAt: z.string().max(40).nullable() }),
  z.strictObject({ kind: z.literal("error"), reason: z.enum(UPDATE_ERROR_REASONS) }),
]);
