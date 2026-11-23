import { USAGE_RANGES } from "@work-intelligence/core";
import { z } from "zod";

/** Body of `POST /api/usage/scan`: bounded, unknown keys rejected; manual folders are never echoed back. */
export const usageScanRequestSchema = z
  .object({
    projectIds: z.array(z.string().min(1).max(300)).max(200).optional(),
    all: z.boolean().optional(),
    manualFolders: z.array(z.string().min(1).max(1024)).max(20).optional(),
    range: z.enum(USAGE_RANGES),
    since: z.iso.datetime({ offset: true }).optional(),
    until: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
