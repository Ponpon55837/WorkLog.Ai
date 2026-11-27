export const COMPACT_SESSION_START_MATCHER = "compact";
// Sees finalize calls both as a legacy direct tool and through the MCP dispatcher.
export const CODEX_POST_TOOL_USE_MATCHER = "^(apply_patch|.*(work_finalize_session|work_write_idempotent))$";
// Claude names MCP tools `mcp__<server>__<tool>`.
export const CLAUDE_PRE_TOOL_USE_MATCHER = "^mcp__.*(work_finalize_session|work_write_idempotent)$";
export const CODEX_PRE_TOOL_USE_MATCHER = "^.*(work_finalize_session|work_write_idempotent)$";
export const LEGACY_CODEX_POST_TOOL_USE_MATCHER = "^(apply_patch|.*work_finalize_session)$";
export const MCP_LAUNCHER_RELATIVE_PATH = "apps/mcp/dist/launcher.js";
export const MCP_SERVER_RELATIVE_PATH = "apps/mcp/dist/index.js";
export const SKILL_SOURCE_RELATIVE_PATH = ".agents/skills/work-intelligence/SKILL.md";
export const MANIFEST_FILENAME = ".work-intelligence-agent-setup.json";
export const JOURNAL_FILENAME = ".work-intelligence-agent-setup.journal.json";
export const TOML_BLOCK_START = "# >>> Work Intelligence setup:agents >>>";
export const TOML_BLOCK_END = "# <<< Work Intelligence setup:agents <<<";
export const LAUNCHER_MCP_ARGUMENT = "mcp";
// Must match `HOOK_ACTIONS` in desktop-core.
export const CLAUDE_HOOK_ACTION = "claude-finalize-reminder";
export const CODEX_HOOK_ACTION = "codex-finalize-reminder";
// The fixed shim file name desktop-core installs under `<root>/bin`.
export const LAUNCHER_SHIM_BASENAMES: ReadonlySet<string> = new Set([
  "work-intelligence-launcher",
  "work-intelligence-launcher.cmd",
]);
