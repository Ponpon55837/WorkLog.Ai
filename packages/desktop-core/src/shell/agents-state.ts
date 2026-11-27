import type { AgentDisplayState, AgentNextStep, AgentSelfTestOutcome } from "../agents/status.js";
import type { ShellLocale } from "./i18n.js";

export const SETUP_AGENT_IDS = ["codex", "claude-code"] as const;
export type SetupAgentId = (typeof SETUP_AGENT_IDS)[number];

export type AgentRegistrationOwner = "desktop-managed" | "manual" | "plugin" | "mcpb" | "unknown" | "none";

export type AgentHookState = "installed" | "stale" | "missing" | "disabled" | "unknown";

export type AgentHookSource = "app" | "checkout" | "plugin";

export interface AgentCardView {
  readonly id: SetupAgentId;
  readonly state: AgentDisplayState;
  readonly nextStep: AgentNextStep;
  readonly mcp: AgentRegistrationOwner;
  readonly hooks: AgentRegistrationOwner;
  readonly hookState?: AgentHookState;
  readonly hookSource?: AgentHookSource | null;
  readonly duplicateOldHook?: true;
  readonly projectHooksNote?: true;
  readonly pluginHooksDuplicate?: true;
  readonly checkoutDisplay?: string;
  readonly checkoutMissing: boolean;
  readonly detected: boolean;
  readonly adoptable: boolean;
  readonly notAdoptableReason?: string;
  readonly otherDatabase?: {
    readonly display: string;
    readonly fromCheckoutDefault: boolean;
  };
}

export type AgentsDiffLineType = "context" | "add" | "remove" | "note";

export interface AgentsFileChange {
  readonly display: string;
  readonly label: string;
  readonly change: "create" | "update" | "delete";
  readonly tooLarge: boolean;
  readonly hunks: readonly {
    readonly oldStart: number;
    readonly newStart: number;
    readonly lines: readonly { readonly type: AgentsDiffLineType; readonly text: string }[];
  }[];
}

export interface AgentsPreview {
  readonly id: string;
  readonly mode: "install" | "uninstall";
  readonly adopt: boolean;
  readonly files: readonly AgentsFileChange[];
  readonly actions: readonly string[];
  readonly conflicts: readonly string[];
}

export type AgentsResult =
  | { readonly kind: "applied"; readonly changed: number }
  | { readonly kind: "removed"; readonly changed: number }
  | { readonly kind: "undone" }
  | { readonly kind: "nothing-to-undo" }
  | { readonly kind: "failed"; readonly code: string; readonly manualRepairDisplay?: string };

export interface AgentsState {
  readonly locale: ShellLocale;
  readonly launcherReady: boolean;
  readonly cards: readonly AgentCardView[];
  readonly selfTest: { readonly outcome: AgentSelfTestOutcome; readonly code?: string; readonly elapsedMs?: number };
  readonly preview: AgentsPreview | null;
  readonly undoAvailable: boolean;
  readonly result: AgentsResult | null;
  readonly busy: boolean;
}

export function maskHome(text: string, homeDirectory: string, platform: NodeJS.Platform): string {
  if (!homeDirectory) return text;
  const variants = new Set([homeDirectory]);
  if (platform === "win32") {
    variants.add(homeDirectory.replaceAll("\\", "/"));
    variants.add(homeDirectory.replaceAll("\\", "\\\\"));
  }
  let masked = text;
  for (const variant of [...variants].sort((a, b) => b.length - a.length)) {
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`${escaped}(?=$|[\\\\/"'\\s,;:)\\]}])`, platform === "win32" ? "gi" : "g");
    masked = masked.replace(pattern, "~");
  }
  return masked;
}

export function hasUndiffableFile(preview: Pick<AgentsPreview, "files">): boolean {
  return preview.files.some((file) => file.tooLarge);
}

export function canApplyPreview(preview: AgentsPreview, acknowledgedUndiffable: boolean): boolean {
  if (preview.conflicts.length > 0 || preview.files.length === 0) return false;
  return !hasUndiffableFile(preview) || acknowledgedUndiffable;
}

export function isFileOpen(chosen: ReadonlyMap<string, boolean>, display: string, index: number): boolean {
  return chosen.get(display) ?? index === 0;
}
