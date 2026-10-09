import { ATTENTION_KINDS } from "@work-intelligence/core";
import { z } from "zod";

/** Bounded, read-only attention filters; unknown input is rejected. */
export const attentionQuerySchema = z
  .object({
    projectId: z.string().min(1).max(300).optional(),
    kind: z.enum(ATTENTION_KINDS).optional(),
    page: z.coerce.number().int().min(1).max(100_000).optional(),
    pageSize: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();
