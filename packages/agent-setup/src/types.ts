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

/** The shim path is taken as input, never derived, so this package does not depend on desktop-core. */
export type AgentSetupTarget =
  | { kind: "checkout" }
  | {
      kind: "launcher";
      shimPath: string;
      skillSourcePath: string;
    };

export interface AgentSetupAdoptOptions {
  // Compared case-insensitively on Windows, `\` and `/` alike.
  repositoryRoots: string[];
  // Adopting an entry of a checkout on another database would split one Agent across two databases.
  databasePath?: string;
}

export interface AgentSetupPlanOptions {
  homeDirectory: string;
  repositoryRoot: string;
  target?: AgentSetupTarget;
  adopt?: AgentSetupAdoptOptions;
  codexHomeDirectory?: string;
  claudeConfigDirectory?: string;
  agents?: readonly ("codex" | "claude-code")[];
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
  // Apply re-verifies this before writing.
  beforeFingerprint: string;
  afterFingerprint: string;
}

export interface AgentSetupAdoptedRegistration {
  agent: "codex" | "claude-code";
  kind: "mcp" | "hook";
  componentId: AgentSetupComponentId;
  location: string;
  repositoryRoot: string;
  effectiveDatabase?: string;
}

export interface AgentSetupPlan {
  mode: "install" | "uninstall";
  actions: string[];
  conflicts: string[];
  mutations: AgentSetupFileMutation[];
  // Informational: they never change `actions` or `conflicts`.
  findings: AgentRegistrationDuplicate[];
  adopted?: AgentSetupAdoptedRegistration[];
}

export type HookComponentId = Extract<AgentSetupComponentId, `${string}Hook`>;

export type ManagedEntry = (
  | { id: "codexSkill" | "codexLegacySkill" | "claudeSkill"; kind: "file"; expected: string }
  | { id: "codexMcp"; kind: "toml-block"; expected: string }
  | { id: "claudeMcp"; kind: "json-property"; expected: unknown }
  | {
      id: HookComponentId;
      kind: "json-array-item";
      expected: unknown;
    }
) & {
  // `expected` holds what was written, extra keys included, so later plans keep it and uninstall still matches it.
  adopted?: true;
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
  // Kept as is and not recorded as setup-owned.
  equivalent?: (value: unknown) => boolean;
  upgrade?: (value: unknown) => unknown;
}

export interface ReadFileResult {
  bytes: Buffer | null;
  mode: number;
  conflict?: string;
}
