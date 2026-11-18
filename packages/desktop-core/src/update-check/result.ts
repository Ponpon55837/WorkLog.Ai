// What the repair page receives from main. The page imports this module, so nothing here may import Node, Electron or
// zod: only types and constants. The zod schemas that main checks these shapes with are in `result-schema.ts`.

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
  "tls",
  "no-release",
  "bad-version",
  "unexpected",
] as const;
export type UpdateErrorReason = (typeof UPDATE_ERROR_REASONS)[number];

/** The answer of a check that found a release newer than the running version. */
export interface UpdateNewerResult {
  readonly kind: "newer";
  readonly current: string;
  readonly version: string;
  /** ISO time of the release, or null when GitHub gave none that parses. */
  readonly publishedAt: string | null;
  /** Plain text; shown with `textContent` only. */
  readonly notes: string;
  readonly notesTruncated: boolean;
  /** The installer for this platform, or null: only the release page is offered. */
  readonly asset: { readonly platform: UpdatePlatform } | null;
}

/**
 * The answer of one check. It carries no URL: the page asks main to open "asset" or "page", and main opens only a link
 * it kept from this answer after checking it again.
 */
export type UpdateCheckResult =
  | { readonly kind: "up-to-date"; readonly current: string }
  | UpdateNewerResult
  | { readonly kind: "offline"; readonly timedOut: boolean }
  /** `resetAt` is the ISO time the limit lifts, when GitHub said. */
  | { readonly kind: "rate-limited"; readonly resetAt: string | null }
  | { readonly kind: "error"; readonly reason: UpdateErrorReason };

/** The links of the last answer; they stay in main. */
export interface UpdateLinks {
  readonly asset: string | null;
  readonly page: string | null;
}

export const UPDATE_LINK_TARGETS = ["asset", "page"] as const;
export type UpdateLinkTarget = (typeof UPDATE_LINK_TARGETS)[number];

/** What `openUpdateLink` answers. */
export interface UpdateOpenLinkResult {
  readonly ok: boolean;
}

/**
 * What the repair page's 「更新」 card gets in the repair state. The check itself runs in main (started by the button or
 * by the tray item) and its progress lives here, so the page only ever displays it: it never starts a check from state.
 */
export interface RepairUpdateSection {
  /** The running version, shown next to the result. */
  readonly currentVersion: string;
  /** A check is running in main now. */
  readonly checking: boolean;
  /** The last finished answer of this run of the App, or null when none was asked for yet or one is running. */
  readonly result: UpdateCheckResult | null;
}
