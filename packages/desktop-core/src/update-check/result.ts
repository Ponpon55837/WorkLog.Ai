import { z } from "zod";
import { NOTES_MAX_CHARACTERS } from "./sanitize.js";

// What the repair page receives from main. No module here may import Node or Electron: the page bundles this file.

export const UPDATE_PLATFORMS = ["windows", "macos"] as const;
/** The platform label of the installer the page offers. */
export type UpdatePlatform = (typeof UPDATE_PLATFORMS)[number];

/** Why a check failed, as a code: never a response body, a header or an exception message. */
export const UPDATE_ERROR_REASONS = [
  "client-error",
  "server-error",
  "unexpected-status",
  "not-json",
  "bad-shape",
  "too-large",
  "redirect",
  "bad-version",
  "unexpected",
] as const;
export type UpdateErrorReason = (typeof UPDATE_ERROR_REASONS)[number];

/**
 * The answer of one check. It carries no URL: the page asks main to open "asset" or "page", and main opens only a link
 * it kept from this answer after checking it again.
 */
export const updateCheckResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("up-to-date"), current: z.string().max(64) }),
  z.strictObject({
    kind: z.literal("newer"),
    current: z.string().max(64),
    version: z.string().max(64),
    /** ISO time of the release, or null when GitHub gave none that parses. */
    publishedAt: z.string().max(40).nullable(),
    /** Plain text; shown with `textContent` only. */
    notes: z.string().max(NOTES_MAX_CHARACTERS),
    notesTruncated: z.boolean(),
    /** The installer for this platform, or null: only the release page is offered. */
    asset: z.strictObject({ platform: z.enum(UPDATE_PLATFORMS) }).nullable(),
  }),
  z.strictObject({ kind: z.literal("offline"), timedOut: z.boolean() }),
  z.strictObject({
    kind: z.literal("rate-limited"),
    /** ISO time the limit lifts, when GitHub said. */
    resetAt: z.string().max(40).nullable(),
  }),
  z.strictObject({ kind: z.literal("error"), reason: z.enum(UPDATE_ERROR_REASONS) }),
]);

export type UpdateCheckResult = z.infer<typeof updateCheckResultSchema>;

/** The links of the last answer; they stay in main. */
export interface UpdateLinks {
  readonly asset: string | null;
  readonly page: string | null;
}

export const UPDATE_LINK_TARGETS = ["asset", "page"] as const;
export type UpdateLinkTarget = (typeof UPDATE_LINK_TARGETS)[number];

/** What `openUpdateLink` answers. */
export const updateOpenLinkResultSchema = z.strictObject({ ok: z.boolean() });
export type UpdateOpenLinkResult = z.infer<typeof updateOpenLinkResultSchema>;

/** What the repair page's 「更新」 card gets in the repair state. */
export interface RepairUpdateSection {
  /** The running version, shown next to the result. */
  readonly currentVersion: string;
  /**
   * The tray item asked for a check and no page has been told yet: true in exactly one state, so a later load of the page
   * does not check again.
   */
  readonly startCheck: boolean;
}
