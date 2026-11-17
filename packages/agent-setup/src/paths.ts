import { join, resolve } from "node:path";
import type { AgentSetupComponentId, AgentSetupPlanOptions } from "./types.js";

export function targetPath(id: AgentSetupComponentId, options: AgentSetupPlanOptions): string {
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
