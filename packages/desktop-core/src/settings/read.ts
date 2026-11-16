import fs from "node:fs/promises";
import { recoveryPathFor } from "./atomic-write.js";
import { parseDesktopSettings, type DesktopSettingsV1 } from "./schema.js";

/** Reasons a settings read needs the user (or a repair flow) instead of silently continuing. */
export type SettingsRepairReason =
  "unreadable" | "invalid-json" | "invalid-schema" | "unsupported-version" | "denied" | "other-sources-present";

/** Result of reading the settings file; fail-closed, never a silent default. */
export type DesktopSettingsReadResult =
  | {
      readonly kind: "ok";
      readonly settings: DesktopSettingsV1;
      readonly source: "primary" | "recovery";
      /** True when the primary is missing or damaged and the recovery copy was used. Reading never repairs it. */
      readonly primaryDamaged: boolean;
      readonly primaryReason?: SettingsRepairReason | "missing";
    }
  | { readonly kind: "new-install" }
  | {
      readonly kind: "needs-repair";
      readonly reason: SettingsRepairReason;
      readonly detail: string;
      readonly primaryReason?: SettingsRepairReason | "missing";
      readonly recoveryReason?: SettingsRepairReason | "missing";
    };

/** Injectable read dependencies. */
export interface SettingsReadDeps {
  readFile(filePath: string): Promise<string>;
  /** True when other data (e.g. detected databases) shows this is not really a new install. */
  hasOtherSources?(): boolean | Promise<boolean>;
}

type FileState =
  | { readonly state: "ok"; readonly settings: DesktopSettingsV1 }
  | { readonly state: "missing" }
  | { readonly state: "failed"; readonly reason: SettingsRepairReason; readonly detail: string };

const NODE_READ_DEPS: SettingsReadDeps = { readFile: (filePath) => fs.readFile(filePath, "utf8") };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function inspectFile(deps: SettingsReadDeps, filePath: string): Promise<FileState> {
  let text: string;
  try {
    text = await deps.readFile(filePath);
  } catch (error) {
    const code = typeof error === "object" && error !== null ? (error as { code?: string }).code : undefined;
    if (code === "ENOENT") return { state: "missing" };
    const reason: SettingsRepairReason = code === "EACCES" || code === "EPERM" ? "denied" : "unreadable";
    return { state: "failed", reason, detail: describeError(error) };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { state: "failed", reason: "invalid-json", detail: describeError(error) };
  }
  const parsed = parseDesktopSettings(raw);
  if (!parsed.ok) return { state: "failed", reason: parsed.kind, detail: parsed.detail };
  return { state: "ok", settings: parsed.settings };
}

function stateLabel(state: FileState): SettingsRepairReason | "missing" | undefined {
  if (state.state === "ok") return undefined;
  return state.state === "missing" ? "missing" : state.reason;
}

async function resolveNothingFound(deps: SettingsReadDeps): Promise<DesktopSettingsReadResult> {
  let others: boolean;
  try {
    others = (await deps.hasOtherSources?.()) ?? false;
  } catch (error) {
    return {
      kind: "needs-repair",
      reason: "unreadable",
      detail: `cannot check other sources: ${describeError(error)}`,
    };
  }
  if (others) {
    return {
      kind: "needs-repair",
      reason: "other-sources-present",
      detail: "no settings file, but other data sources exist",
    };
  }
  return { kind: "new-install" };
}

/**
 * Read the settings file fail-closed. `new-install` is returned only when both the primary and the
 * recovery copy are absent and no other sources exist; anything corrupt, denied or unknown is
 * `needs-repair`. A valid recovery copy is returned (flagged) when the primary is damaged. This
 * function never writes, renames or deletes anything.
 */
export async function readDesktopSettings(
  filePath: string,
  deps: SettingsReadDeps = NODE_READ_DEPS,
): Promise<DesktopSettingsReadResult> {
  const primary = await inspectFile(deps, filePath);
  if (primary.state === "ok")
    return { kind: "ok", settings: primary.settings, source: "primary", primaryDamaged: false };

  const recovery = await inspectFile(deps, recoveryPathFor(filePath));
  const primaryReason = stateLabel(primary);
  if (recovery.state === "ok") {
    return { kind: "ok", settings: recovery.settings, source: "recovery", primaryDamaged: true, primaryReason };
  }
  if (primary.state === "missing" && recovery.state === "missing") return resolveNothingFound(deps);

  const recoveryReason = stateLabel(recovery);
  if (primary.state === "failed") {
    return { kind: "needs-repair", reason: primary.reason, detail: primary.detail, primaryReason, recoveryReason };
  }
  const failed = recovery as Extract<FileState, { state: "failed" }>;
  return {
    kind: "needs-repair",
    reason: failed.reason,
    detail: `recovery copy: ${failed.detail}`,
    primaryReason,
    recoveryReason,
  };
}
