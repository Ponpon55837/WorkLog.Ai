import type { AgentRegistrationDuplicate } from "./inspect.js";

export type AgentSetupComponentId =
  | "codexSkill"
  | "codexLegacySkill"
  | "claudeSkill"
  | "codexMcp"
  | "claudeMcp"
  | "claudeStopHook"
  | "claudePreCompactHook"
  | "claudePreToolUseHook"
  | "claudeSessionStartHook"
  | "codexPostToolUseHook"
  | "codexStopHook"
  | "codexUserPromptSubmitHook"
  | "codexPreToolUseHook"
  | "codexSessionStartHook";

export type CodexHooksFeature = "enabled" | "disabled" | "unknown";

export interface AgentSetupFinding {
  componentId: AgentSetupComponentId;
  state: "current" | "missing" | "stale" | "unreadable";
  detail: string;
}

/**
 * What the registrations point at: this checkout (`node <repo>/apps/mcp/dist/...`, what `pnpm setup:agents` has always
 * written) or the fixed launcher shim the desktop App installs. The shim path is taken as input, never derived, so
 * this package does not depend on desktop-core.
 */
export type AgentSetupTarget =
  | { kind: "checkout" }
  | {
      kind: "launcher";
      /** Absolute path of `<root>/bin/work-intelligence-launcher` (`.cmd` on Windows); used verbatim. */
      shimPath: string;
      /** The canonical `work-intelligence` skill the App ships, since a launcher install has no checkout to copy it from. */
      skillSourcePath: string;
    };

export interface AgentSetupPlanOptions {
  homeDirectory: string;
  /** The checkout; with a launcher target it only serves to recognise hand-written checkout registrations. */
  repositoryRoot: string;
  /** Defaults to the checkout target. */
  target?: AgentSetupTarget;
  codexHomeDirectory?: string;
  claudeConfigDirectory?: string;
  now?: Date;
  platform?: NodeJS.Platform;
}

export interface AgentSetupFileMutation {
  path: string;
  label: string;
  before: Buffer | null;
  after: Buffer | null;
  mode: number;
  backupPath?: string;
  /** sha256 of `before` as read at plan time, or `"absent"`; apply re-verifies it before writing. */
  beforeFingerprint: string;
  /** What `after` hashes to (or `"absent"` for a removal); verify and compensation compare against it. */
  afterFingerprint: string;
}

export interface AgentSetupPlan {
  mode: "install" | "uninstall";
  actions: string[];
  conflicts: string[];
  mutations: AgentSetupFileMutation[];
  /** Duplicate registrations found while planning; informational, they never change `actions` or `conflicts`. */
  findings: AgentRegistrationDuplicate[];
}

export type HookComponentId = Extract<AgentSetupComponentId, `${string}Hook`>;

export type ManagedEntry =
  | { id: "codexSkill" | "codexLegacySkill" | "claudeSkill"; kind: "file"; expected: string }
  | { id: "codexMcp"; kind: "toml-block"; expected: string }
  | { id: "claudeMcp"; kind: "json-property"; expected: unknown }
  | {
      id: HookComponentId;
      kind: "json-array-item";
      expected: unknown;
    };

export interface SetupManifest {
  version: 2;
  codexHomeDirectory?: string;
  claudeConfigDirectory?: string;
  components: ManagedEntry[];
}

export interface JsonMutationSpec {
  id: ManagedEntry["id"];
  kind: "property" | "array-item";
  path: string[];
  expected: unknown;
  label: string;
  similar?: (value: unknown) => boolean;
  /**
   * An existing entry that already does the job (for example written by hand before setup existed, with an
   * absolute node path or exec-form args). It is kept as is and not recorded as setup-owned.
   */
  equivalent?: (value: unknown) => boolean;
  /** Returns an upgraded copy of an existing entry that needs only a known fix, or undefined. */
  upgrade?: (value: unknown) => unknown;
}

export interface ReadFileResult {
  bytes: Buffer | null;
  mode: number;
  conflict?: string;
}
