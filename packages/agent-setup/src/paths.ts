import { join, resolve } from "node:path";
import { manifestPath } from "./manifest.js";
import type { AgentSetupComponentId, AgentSetupPlanOptions } from "./types.js";

/** The directories that decide where targets live; everything else in the plan options does not affect paths. */
export type AgentSetupLocation = Pick<
  AgentSetupPlanOptions,
  "homeDirectory" | "codexHomeDirectory" | "claudeConfigDirectory"
>;

const COMPONENT_IDS: readonly AgentSetupComponentId[] = [
  "codexSkill",
  "codexLegacySkill",
  "claudeSkill",
  "codexMcp",
  "claudeMcp",
  "claudeStopHook",
  "claudePreCompactHook",
  "claudePreToolUseHook",
  "claudeSessionStartHook",
  "codexPostToolUseHook",
  "codexStopHook",
  "codexUserPromptSubmitHook",
  "codexPreToolUseHook",
  "codexSessionStartHook",
];

export function targetPath(id: AgentSetupComponentId, options: AgentSetupLocation): string {
  const codexHome = options.codexHomeDirectory ?? join(options.homeDirectory, ".codex");
  const claudeConfigDirectory = options.claudeConfigDirectory ?? join(options.homeDirectory, ".claude");
  switch (id) {
    case "codexSkill":
      return join(options.homeDirectory, ".agents", "skills", "work-intelligence", "SKILL.md");
    case "codexLegacySkill":
      return join(codexHome, "skills", "work-intelligence", "SKILL.md");
    case "claudeSkill":
      return join(claudeConfigDirectory, "skills", "work-intelligence", "SKILL.md");
    case "codexMcp":
      return join(codexHome, "config.toml");
    case "claudeMcp":
      return join(options.homeDirectory, ".claude.json");
    case "claudeStopHook":
    case "claudePreCompactHook":
    case "claudePreToolUseHook":
    case "claudeSessionStartHook":
      return join(claudeConfigDirectory, "settings.json");
    case "codexPostToolUseHook":
    case "codexStopHook":
    case "codexUserPromptSubmitHook":
    case "codexPreToolUseHook":
    case "codexSessionStartHook":
      return join(codexHome, "hooks.json");
  }
}

export function normalizePlanOptions(options: AgentSetupPlanOptions): AgentSetupPlanOptions {
  const homeDirectory = resolve(options.homeDirectory);
  return {
    ...options,
    homeDirectory,
    repositoryRoot: resolve(options.repositoryRoot),
    codexHomeDirectory: resolve(options.codexHomeDirectory ?? join(homeDirectory, ".codex")),
    claudeConfigDirectory: resolve(options.claudeConfigDirectory ?? join(homeDirectory, ".claude")),
  };
}

/** Every file setup may ever write for this location, resolved: the component targets and the manifest. */
export function knownTargetPaths(location: AgentSetupLocation): Set<string> {
  const homeDirectory = resolve(location.homeDirectory);
  const normalized = {
    homeDirectory,
    codexHomeDirectory: resolve(location.codexHomeDirectory ?? join(homeDirectory, ".codex")),
    claudeConfigDirectory: resolve(location.claudeConfigDirectory ?? join(homeDirectory, ".claude")),
  };
  return new Set([manifestPath(homeDirectory), ...COMPONENT_IDS.map((id) => targetPath(id, normalized))]);
}
