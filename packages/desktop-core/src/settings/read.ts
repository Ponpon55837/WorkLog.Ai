import fs from "node:fs/promises";
import { recoveryPathFor } from "./atomic-write.js";
import { parseDesktopSettings, type DesktopSettingsV1 } from "./schema.js";

export type SettingsRepairReason = "unreadable" | "invalid-json" | "invalid-schema" | "unsupported-version" | "denied";

export type DesktopSettingsReadResult =
  | {
      readonly kind: "ok";
      readonly settings: DesktopSettingsV1;
      readonly source: "primary" | "recovery";
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

export interface SettingsReadDeps {
  readFile(filePath: string): Promise<string>;
}

type FileState =
  | { readonly state: "ok"; readonly settings: DesktopSettingsV1 }
  | { readonly state: "missing" }
  | { readonly state: "failed"; readonly reason: SettingsRepairReason; readonly detail: string };

const RECOVERABLE_REASONS: ReadonlySet<SettingsRepairReason> = new Set([
  "invalid-json",
  "invalid-schema",
  "unreadable",
]);

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

export async function readDesktopSettings(
  filePath: string,
  deps: SettingsReadDeps = NODE_READ_DEPS,
): Promise<DesktopSettingsReadResult> {
  const primary = await inspectFile(deps, filePath);
  if (primary.state === "ok")
    return { kind: "ok", settings: primary.settings, source: "primary", primaryDamaged: false };

  const primaryReason = stateLabel(primary);
  if (primary.state === "failed" && !RECOVERABLE_REASONS.has(primary.reason)) {
    // A newer app's file or a permission problem is NOT damage: the recovery copy is older and would hide it.
    return { kind: "needs-repair", reason: primary.reason, detail: primary.detail, primaryReason };
  }
  const recovery = await inspectFile(deps, recoveryPathFor(filePath));
  if (recovery.state === "ok") {
    return { kind: "ok", settings: recovery.settings, source: "recovery", primaryDamaged: true, primaryReason };
  }
  if (primary.state === "missing" && recovery.state === "missing") return { kind: "new-install" };

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
