import { ATTENTION_KINDS } from "@work-intelligence/core";
import { z } from "zod";

/** Bounded, read-only attention filters; unknown input is rejected. */
export const attentionQuerySchema = z
  .object({
    projectId: z.string().min(1).max(300).optional(),
    kind: z.enum(ATTENTION_KINDS).optional(),
    view: z.enum(["visible", "suppressed"]).optional(),
    page: z.coerce.number().int().min(1).max(100_000).optional(),
    pageSize: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();

/** A Web-only display intent for a rechecked single-project pointer. */
export const updateAttentionPreferenceSchema = z
  .object({
    projectId: z.string().min(1).max(300),
    kind: z.enum(ATTENTION_KINDS),
    sourceId: z.string().min(1).max(300),
    sourceRevision: z.string().regex(/^[a-f0-9]{64}$/),
    expectedRevision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    action: z.enum(["snooze", "hide", "restore"]),
  })
  .strict();
