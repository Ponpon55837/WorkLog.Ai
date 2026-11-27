import type { SystemAgentConnections } from "@work-intelligence/core";
import { commandName } from "@work-intelligence/shared";
import { repositoryRoot as defaultRepositoryRoot } from "./config.js";
import { inspectAgentConnections } from "./doctor.js";

export interface StartupCheckOptions {
  repositoryRoot?: string;
  standalone?: boolean;
  inspectConnections?: () => SystemAgentConnections;
}

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
