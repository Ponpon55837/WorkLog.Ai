/** SessionStart matcher (on `source`) for the session that resumes after a compaction; same in both Agents. */
export const COMPACT_SESSION_START_MATCHER = "compact";
/** PostToolUse matcher that sees finalize calls both as a legacy direct tool and through the MCP dispatcher. */
export const CODEX_POST_TOOL_USE_MATCHER = "^(apply_patch|.*(work_finalize_session|work_write_idempotent))$";
/** PreToolUse matchers for finalize calls (Claude names MCP tools `mcp__server__tool`). */
export const CLAUDE_PRE_TOOL_USE_MATCHER = "^mcp__.*(work_finalize_session|work_write_idempotent)$";
export const CODEX_PRE_TOOL_USE_MATCHER = "^.*(work_finalize_session|work_write_idempotent)$";
/** Pre-dispatcher matcher; setup upgrades it and Doctor reports it as stale. */
export const LEGACY_CODEX_POST_TOOL_USE_MATCHER = "^(apply_patch|.*work_finalize_session)$";
/** The stable launcher Agents register; it swaps the server child after each build without a reconnect. */
export const MCP_LAUNCHER_RELATIVE_PATH = "apps/mcp/dist/launcher.js";
/** The server entry point registrations used before the launcher; setup upgrades it and Doctor reports it. */
export const MCP_SERVER_RELATIVE_PATH = "apps/mcp/dist/index.js";
export const SKILL_SOURCE_RELATIVE_PATH = ".agents/skills/work-intelligence/SKILL.md";
export const MANIFEST_FILENAME = ".work-intelligence-agent-setup.json";
/** Operation journal next to the setup manifest; see {@link ./journal.ts}. */
export const JOURNAL_FILENAME = ".work-intelligence-agent-setup.journal.json";
export const TOML_BLOCK_START = "# >>> Work Intelligence setup:agents >>>";
export const TOML_BLOCK_END = "# <<< Work Intelligence setup:agents <<<";
/** The MCP argument the launcher shim starts the MCP server with. */
export const LAUNCHER_MCP_ARGUMENT = "mcp";
/** The launcher actions the finalize-reminder hooks run (mirrors `HOOK_ACTIONS` in desktop-core). */
export const CLAUDE_HOOK_ACTION = "claude-finalize-reminder";
export const CODEX_HOOK_ACTION = "codex-finalize-reminder";
/** The fixed shim file name desktop-core installs under `<root>/bin`; `.cmd` on Windows. */
export const LAUNCHER_SHIM_BASENAMES: ReadonlySet<string> = new Set([
  "work-intelligence-launcher",
  "work-intelligence-launcher.cmd",
]);
