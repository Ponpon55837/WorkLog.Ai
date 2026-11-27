import { resolve } from "node:path";
import { JSON_OBJECT } from "./files.js";
import {
  commandForAgentHook,
  commandForLauncherHook,
  invokesLauncherAction,
  invokesNodeScript,
  isLauncherMcpRegistration,
  mcpRegistrationKind,
  referencesScriptPath,
  upgradeDirectMcpRegistration,
} from "./commands.js";
import {
  CLAUDE_HOOK_ACTION,
  CLAUDE_PRE_TOOL_USE_MATCHER,
  CODEX_HOOK_ACTION,
  CODEX_POST_TOOL_USE_MATCHER,
  CODEX_PRE_TOOL_USE_MATCHER,
  COMPACT_SESSION_START_MATCHER,
  LAUNCHER_MCP_ARGUMENT,
  LEGACY_CODEX_POST_TOOL_USE_MATCHER,
  MCP_LAUNCHER_RELATIVE_PATH,
} from "./constants.js";
import type { AgentSetupPlanOptions, JsonMutationSpec } from "./types.js";

interface HookInvocation {
  command: string;
  references: (value: unknown) => boolean;
  invokes: (value: unknown) => boolean;
}

function hookInvocation(
  options: AgentSetupPlanOptions,
  platform: NodeJS.Platform,
  checkoutScript: string,
  launcherAction: string,
): HookInvocation {
  const scriptPath = resolve(options.repositoryRoot, "apps/mcp/dist", checkoutScript);
  if (options.target?.kind !== "launcher") {
    return {
      command: commandForAgentHook(scriptPath, platform),
      // A desktop-managed shim hook is the same job: a second hook beside it would run twice.
      references: (value) => referencesScriptPath(value, scriptPath) || invokesLauncherAction(value, launcherAction),
      invokes: (value) => invokesNodeScript(value, scriptPath),
    };
  }
  const shimPath = options.target.shimPath;
  return {
    command: commandForLauncherHook(shimPath, launcherAction, platform),
    // A hand-written checkout hook counts too: adding the shim beside it would run the hook twice.
    references: (value) => referencesScriptPath(value, shimPath) || referencesScriptPath(value, scriptPath),
    invokes: (value) => invokesLauncherAction(value, launcherAction, shimPath),
  };
}

export function getClaudeMcpSpec(options: AgentSetupPlanOptions): JsonMutationSpec {
  const repositoryRoot = options.repositoryRoot;
  if (options.target?.kind === "launcher") {
    const shimPath = options.target.shimPath;
    return {
      id: "claudeMcp",
      kind: "property",
      path: ["mcpServers", "work-intelligence"],
      expected: { type: "stdio", command: shimPath, args: [LAUNCHER_MCP_ARGUMENT] },
      label: "Claude MCP 註冊",
      equivalent: (value) => isLauncherMcpRegistration(value, shimPath),
    };
  }
  const launcherPath = resolve(repositoryRoot, MCP_LAUNCHER_RELATIVE_PATH);
  return {
    id: "claudeMcp",
    kind: "property",
    path: ["mcpServers", "work-intelligence"],
    expected: { type: "stdio", command: "node", args: [launcherPath] },
    label: "Claude MCP 註冊",
    equivalent: (value) => mcpRegistrationKind(value, repositoryRoot) === "launcher",
    upgrade: (value) => upgradeDirectMcpRegistration(value, repositoryRoot),
  };
}

export function compactSessionStartSpec(
  id: "claudeSessionStartHook" | "codexSessionStartHook",
  label: string,
  invocation: HookInvocation,
): JsonMutationSpec {
  const matcher = COMPACT_SESSION_START_MATCHER;
  return {
    id,
    kind: "array-item",
    path: ["hooks", "SessionStart"],
    expected: { matcher, hooks: [{ type: "command", command: invocation.command }] },
    label,
    similar: invocation.references,
    equivalent: (value) => JSON_OBJECT(value) && value.matcher === matcher && invocation.invokes(value),
  };
}

export function preToolUseSpec(
  id: "claudePreToolUseHook" | "codexPreToolUseHook",
  label: string,
  matcher: string,
  invocation: HookInvocation,
): JsonMutationSpec {
  return {
    id,
    kind: "array-item",
    path: ["hooks", "PreToolUse"],
    expected: { matcher, hooks: [{ type: "command", command: invocation.command }] },
    label,
    similar: invocation.references,
    equivalent: (value) => JSON_OBJECT(value) && value.matcher === matcher && invocation.invokes(value),
  };
}

export function getClaudeHookSpecs(options: AgentSetupPlanOptions, platform: NodeJS.Platform): JsonMutationSpec[] {
  const invocation = hookInvocation(options, platform, "finalize-reminder.js", CLAUDE_HOOK_ACTION);
  const simpleHook = { hooks: [{ type: "command", command: invocation.command }] };
  return [
    {
      id: "claudeStopHook",
      kind: "array-item",
      path: ["hooks", "Stop"],
      expected: simpleHook,
      label: "Claude Stop hook",
      similar: invocation.references,
      equivalent: invocation.invokes,
    },
    {
      // No matcher: manual and automatic compactions both get the summary instructions.
      id: "claudePreCompactHook",
      kind: "array-item",
      path: ["hooks", "PreCompact"],
      expected: simpleHook,
      label: "Claude PreCompact hook",
      similar: invocation.references,
      equivalent: invocation.invokes,
    },
    preToolUseSpec("claudePreToolUseHook", "Claude PreToolUse hook", CLAUDE_PRE_TOOL_USE_MATCHER, invocation),
    compactSessionStartSpec("claudeSessionStartHook", "Claude SessionStart（compact）hook", invocation),
  ];
}

export function getCodexHookSpecs(options: AgentSetupPlanOptions, platform: NodeJS.Platform): JsonMutationSpec[] {
  const invocation = hookInvocation(options, platform, "codex-finalize-reminder.js", CODEX_HOOK_ACTION);
  const simpleHook = { hooks: [{ type: "command", command: invocation.command }] };
  const matcher = CODEX_POST_TOOL_USE_MATCHER;
  const compatibleMatchers = new Set([matcher, LEGACY_CODEX_POST_TOOL_USE_MATCHER]);
  return [
    {
      id: "codexPostToolUseHook",
      kind: "array-item",
      path: ["hooks", "PostToolUse"],
      expected: { matcher, hooks: [{ type: "command", command: invocation.command }] },
      label: "Codex PostToolUse hook",
      similar: (value) =>
        JSON_OBJECT(value) &&
        typeof value.matcher === "string" &&
        compatibleMatchers.has(value.matcher) &&
        invocation.references(value),
      equivalent: (value) => JSON_OBJECT(value) && value.matcher === matcher && invocation.invokes(value),
      upgrade: (value) =>
        JSON_OBJECT(value) && value.matcher === LEGACY_CODEX_POST_TOOL_USE_MATCHER && invocation.invokes(value)
          ? { ...value, matcher }
          : undefined,
    },
    {
      id: "codexStopHook",
      kind: "array-item",
      path: ["hooks", "Stop"],
      expected: simpleHook,
      label: "Codex Stop hook",
      similar: invocation.references,
      equivalent: invocation.invokes,
    },
    {
      id: "codexUserPromptSubmitHook",
      kind: "array-item",
      path: ["hooks", "UserPromptSubmit"],
      expected: simpleHook,
      label: "Codex UserPromptSubmit hook",
      similar: invocation.references,
      equivalent: invocation.invokes,
    },
    preToolUseSpec("codexPreToolUseHook", "Codex PreToolUse hook", CODEX_PRE_TOOL_USE_MATCHER, invocation),
    compactSessionStartSpec("codexSessionStartHook", "Codex SessionStart（compact）hook", invocation),
  ];
}
