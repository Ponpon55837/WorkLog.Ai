import type { SystemAgentConnections } from "@work-intelligence/core";
import { commandName } from "@work-intelligence/shared";
import { repositoryRoot as defaultRepositoryRoot } from "./config.js";
import { inspectAgentConnections } from "./doctor.js";

export interface StartupCheckOptions {
  repositoryRoot?: string;
  /** Which command names to show; defaults to the running mode. */
  standalone?: boolean;
  /** Injectable for tests; the default reads only local skill and hook files (no service queries, API calls or database). */
  inspectConnections?: () => SystemAgentConnections;
}

/**
 * One or two hints about Agent setup that is installed but out of date. Installed means present: a missing skill or
 * hook is never mentioned (the user may use the plugin, or not want it). Never throws and never writes.
 */
export function collectStartupHints(options: StartupCheckOptions = {}): string[] {
  try {
    const inspect =
      options.inspectConnections ??
      (() => inspectAgentConnections({ repositoryRoot: options.repositoryRoot ?? defaultRepositoryRoot }));
    const { codex, claudeCode } = inspect();
    const sync = `${commandName("bootstrap", options.standalone)}（或 ${commandName("setup:agents", options.standalone)}）同步`;
    const hints: string[] = [];
    if ([codex.canonicalSkill, codex.legacySkill, claudeCode.skill].includes("stale")) {
      hints.push(`Agent skill 已過期：執行 ${sync}。`);
    }
    if (codex.hook === "stale") {
      hints.push(`Codex 保存提醒 hook 使用舊設定：執行 ${sync}。`);
    }
    return hints;
  } catch {
    return [];
  }
}
