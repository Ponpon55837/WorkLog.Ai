import { z } from "zod";
import { REPORT_SECTION_KEYS } from "@work-intelligence/core";

const sections = z
  .array(z.enum(REPORT_SECTION_KEYS))
  .max(7)
  .refine((items) => new Set(items).size === items.length, "Duplicate section keys.");
export const reportPresentationStateSchema = z
  .object({
    pinned: sections,
    hidden: sections,
    overrides: z
      .array(
        z
          .object({
            section: z.enum(REPORT_SECTION_KEYS),
            ordinal: z.number().int().min(0).max(49),
            title: z.string().trim().min(1).max(300),
            detail: z.string().trim().min(1).max(4000),
          })
          .strict(),
      )
      .max(290),
  })
  .strict()
  .superRefine((state, ctx) => {
    if (new Set(state.overrides.map((item) => `${item.section}:${item.ordinal}`)).size !== state.overrides.length)
      ctx.addIssue({ code: "custom", message: "Duplicate block keys." });
    if (state.overrides.reduce((n, item) => n + item.title.length + item.detail.length, 0) > 8000)
      ctx.addIssue({ code: "custom", message: "Manual text exceeds 8000 characters." });
  });
export const reportPresentationQuerySchema = z.object({ summaryId: z.string().min(1).max(300) }).strict();
export const updateReportPresentationSchema = reportPresentationQuerySchema
  .extend({
    expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    state: reportPresentationStateSchema,
  })
  .strict();
