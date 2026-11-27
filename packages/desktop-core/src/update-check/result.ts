// Imported by the repair page: only types and constants here, nothing that imports Node, Electron or zod.

export const UPDATE_PLATFORMS = ["windows", "macos"] as const;
export type UpdatePlatform = (typeof UPDATE_PLATFORMS)[number];

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

export interface UpdateNewerResult {
  readonly kind: "newer";
  readonly current: string;
  readonly version: string;
  readonly publishedAt: string | null;
  readonly notes: string;
  readonly notesTruncated: boolean;
  readonly asset: { readonly platform: UpdatePlatform } | null;
}

export type UpdateCheckResult =
  | { readonly kind: "up-to-date"; readonly current: string }
  | UpdateNewerResult
  | { readonly kind: "offline"; readonly timedOut: boolean }
  /** `resetAt` is the ISO time the limit lifts, when GitHub said. */
  | { readonly kind: "rate-limited"; readonly resetAt: string | null }
  | { readonly kind: "error"; readonly reason: UpdateErrorReason };

export interface UpdateLinks {
  readonly asset: string | null;
  readonly page: string | null;
}

export const UPDATE_LINK_TARGETS = ["asset", "page"] as const;
export type UpdateLinkTarget = (typeof UPDATE_LINK_TARGETS)[number];

export interface UpdateOpenLinkResult {
  readonly ok: boolean;
}

export interface RepairUpdateSection {
  readonly currentVersion: string;
  readonly checking: boolean;
  readonly result: UpdateCheckResult | null;
}
