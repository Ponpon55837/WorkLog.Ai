import type { AgentDisplayState, AgentNextStep, AgentSelfTestOutcome } from "../agents/status.js";
import type { ShellLocale } from "./i18n.js";

/**
 * The Agent page of the App window: which Agents use Work Intelligence and how, and the one change the App would make
 * ("連接" through the launcher, or "改由桌面 App 管理" for a hand-written checkout registration). Every write is shown as a
 * diff first and needs the user's click; the page never sends a path or a file's content, only opaque ids.
 */

/** The Agents the App sets up. Claude Desktop is not written by the App in V1. */
export const SETUP_AGENT_IDS = ["codex", "claude-code"] as const;
export type SetupAgentId = (typeof SETUP_AGENT_IDS)[number];

/** Who wrote an Agent's registration, as the page names it; `none` when there is no registration. */
export type AgentRegistrationOwner = "desktop-managed" | "manual" | "plugin" | "mcpb" | "unknown" | "none";

/** What the page knows about an Agent's save-reminder hooks, checked per event (see agent-setup `inspectHookInstallation`). */
export type AgentHookState = "installed" | "stale" | "missing" | "disabled" | "unknown";

/** Who manages working hooks: the App's launcher, a source checkout's scripts, or the Agent's plugin. */
export type AgentHookSource = "app" | "checkout" | "plugin";

export interface AgentCardView {
  readonly id: SetupAgentId;
  readonly state: AgentDisplayState;
  readonly nextStep: AgentNextStep;
  readonly mcp: AgentRegistrationOwner;
  readonly hooks: AgentRegistrationOwner;
  /** The state of the hooks the Agent needs; `hooks` above only says who wrote an entry. */
  readonly hookState?: AgentHookState;
  /** Who manages the hooks when `hookState` is `installed`. */
  readonly hookSource?: AgentHookSource | null;
  /** The Agent's own plugin brings finalize hooks and the App's (or a checkout's) global hook is installed too. */
  readonly pluginHooksDuplicate?: true;
  /** The hand-written registration runs a source checkout (`node <checkout>/…`); shown with `~`. */
  readonly checkoutDisplay?: string;
  /** The checkout is gone: the registration cannot start at all. */
  readonly checkoutMissing: boolean;
  /** The Agent's settings folder exists on this computer; an Agent that is not there is not preselected for setup (M-17). */
  readonly detected: boolean;
  /** A hand-written checkout registration the App can take over ("改由桌面 App 管理"). */
  readonly adoptable: boolean;
  /** Why a hand-written registration cannot be taken over (zh-TW from agent-setup). */
  readonly notAdoptableReason?: string;
  /**
   * The checkout's registration uses a database that is not the App's, so it is not taken over (MCP would keep its
   * database and hooks would follow the App's). `display` is shown with `~`; the page offers "改用這份資料庫".
   */
  readonly otherDatabase?: {
    readonly display: string;
    /** Hooks only, without an MCP entry: the checkout default, unless the Agent's own environment overrides it. */
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

/** A plan computed but not applied: nothing has been written yet. */
export interface AgentsPreview {
  readonly id: string;
  /** `uninstall` is "移除 Agent 設定": the same preview, confirm and transaction path, planned from the setup manifest. */
  readonly mode: "install" | "uninstall";
  readonly adopt: boolean;
  readonly files: readonly AgentsFileChange[];
  readonly actions: readonly string[];
  /** Anything listed here blocks the apply: nothing is written while one exists. */
  readonly conflicts: readonly string[];
}

export type AgentsResult =
  | { readonly kind: "applied"; readonly changed: number }
  | { readonly kind: "removed"; readonly changed: number }
  | { readonly kind: "undone" }
  | { readonly kind: "nothing-to-undo" }
  /** `manualRepairDisplay`: the files left as they are, with `~` for the home folder, joined by ", ". */
  | { readonly kind: "failed"; readonly code: string; readonly manualRepairDisplay?: string };

export interface AgentsState {
  readonly locale: ShellLocale;
  /** The App has a launcher the Agents can run (a packaged App after its first start); without it nothing can be set up. */
  readonly launcherReady: boolean;
  readonly cards: readonly AgentCardView[];
  readonly selfTest: { readonly outcome: AgentSelfTestOutcome; readonly code?: string; readonly elapsedMs?: number };
  readonly preview: AgentsPreview | null;
  /** The last operation the App applied can be undone (its journal and backups are still there). */
  readonly undoAvailable: boolean;
  readonly result: AgentsResult | null;
  readonly busy: boolean;
}

/** Replaces the home directory with `~` in text the page shows (paths inside a diff line included). */
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
    // Only the home folder itself: `/home/tester2` shares the prefix of `/home/tester` but is another folder.
    const pattern = new RegExp(`${escaped}(?=$|[\\\\/"'\\s,;:)\\]}])`, platform === "win32" ? "gi" : "g");
    masked = masked.replace(pattern, "~");
  }
  return masked;
}

/** A file of the preview whose diff the page cannot show (too large to compare): the user cannot review what changes. */
export function hasUndiffableFile(preview: Pick<AgentsPreview, "files">): boolean {
  return preview.files.some((file) => file.tooLarge);
}

/**
 * Whether the preview may be applied. Conflicts block it; a file without a shown diff needs the user's explicit
 * acknowledgement. The page uses this to enable "套用變更" and main uses it again before it applies.
 */
export function canApplyPreview(preview: AgentsPreview, acknowledgedUndiffable: boolean): boolean {
  if (preview.conflicts.length > 0 || preview.files.length === 0) return false;
  return !hasUndiffableFile(preview) || acknowledgedUndiffable;
}

/** Whether a file's `<details>` is open: what the user chose wins, otherwise only the first file opens by itself. */
export function isFileOpen(chosen: ReadonlyMap<string, boolean>, display: string, index: number): boolean {
  return chosen.get(display) ?? index === 0;
}
