/**
 * Aggregates usage numbers from local Agent session logs. It never prints message text, tool inputs, file paths,
 * working directories, branch or project names, or error messages: only counts, token sums and timestamps.
 *
 * Pipeline (Claude Code files): phase one (`extractFile`) turns each line into a compact record without deduplication or
 * range filtering; phase two (`reduceClaudeRecords`) applies the rules below over the records of all files in path
 * order. Phase-one results are cached per file in a `UsageCache` (unchanged file: reused; grown file with the same
 * 4 KiB prefix hash: read from the cached byte offset only; anything else: re-extracted). An unterminated last line is
 * parsed for the report but the offset stays before it. Codex rollouts are NOT cached: their state depends on other
 * files, so they are reparsed on every scan. With `since`, a file whose mtime is older is skipped unread (lines are
 * appended, so none is newer than the mtime); its lines then count in no total.
 *
 * Work Intelligence operations: the dispatcher tools `work_read`, `work_write_idempotent`, `work_write_additive` and
 * `work_write_overwrite` are grouped as `<entry>/<operation>`; only `input.operation` (Codex: `.operation` of the
 * parsed function_call `arguments`, `invocation.arguments` of mcp_tool_call_begin, `item.arguments` of a code-mode
 * McpToolCall) is read, and only when it matches /^work_[a-z0-9_]+$/; anything else, or an absent value (Codex calls
 * that carry no arguments, a known limitation), is `<entry>/(unknown)`. Direct tools keep their own name as key.
 * Result characters are attributed to the key through the tool_use id / call_id.
 *
 * Supported formats: Claude Code session logs (*.jsonl) and, EXPERIMENTALLY, Codex CLI rollouts
 * (~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl). The Codex parser was written from reading the openai/codex
 * source, not from real logs: check it with `--debug-shape` (prints key names and JS types only, never values) and by
 * comparing one session with the numbers Codex shows in `/status`. Add a format by pushing another parser onto PARSERS;
 * a parser may define `endFile(state)`, called after each file, and reads per-file context from `state.file`.
 * Lines no parser recognizes (other Claude Code line types, non-objects aside) are ignored.
 *
 * Token basis: the headline is `primary` = fresh input + output. Cache reads and cache writes are reported separately
 * and never added to it; `cacheReadShareOf` = cacheRead / (input + cacheRead + cacheCreation). There are no prices,
 * multipliers, dollar amounts or network calls.
 *
 * Breakdowns (kept in the metrics accumulator so `mergeMetrics` carries them; `publicMetrics` turns them into lists):
 * - `models`: tokens and responses per (agent, model). Agent is `codex` for Codex rollouts and `claude-code` otherwise.
 *   Model ids pass `safeModelId` (allowlist: at most 96 characters, one or two `/`-separated segments of
 *   [A-Za-z0-9][A-Za-z0-9._:@+-]{0,63}; no `..`, no drive letter, first segment not a path root such as users, home,
 *   tmp); anything else is "" ("unlabelled model"), so a path in a model field never reaches a report. Claude Code: the
 *   `message.model` of the assistant message (compact record field `md`); each message's token delta is credited to that
 *   message's model, a later line of the same message id names the model only when the first line had none. Codex: the
 *   latest `payload.model` of `turn_context` (or `session_meta`) lines; each credited token_count delta and each
 *   `token_usage_record` fallback entry goes to the model current at that line. Responses are Claude Code assistant
 *   messages and Codex credited deltas.
 * - `daily`: tokens per local calendar day of the server (`YYYY-MM-DD`) of the line timestamp; lines without a
 *   timestamp count in no day.
 * - `blocks` (ccusage rules, per Agent, `buildActiveBlocks`): the first usage opens a block starting at its local hour
 *   (offset taken from the host time zone, so +05:30 works) and ending 5 hours later; usage 5 hours after the block
 *   start or 5 hours after the previous usage opens a new block. Only the last block per Agent is returned, and only
 *   while active (`now` before its end and under 5 hours since its last usage). Usage events are kept only for the last
 *   24 hours before `options.now` (default `Date.now()`), which bounds memory.
 * - Codex compaction subtraction removes the replayed first delta from the same model, day and block it was credited to.
 *
 * Rules (Claude Code):
 * - A streamed assistant message repeats the same `message.id` over several lines, each carrying the usage. Usage is
 *   counted once per id, using the per-field maximum seen for that id (the last line holds the final output_tokens,
 *   and input/cache fields are identical across lines, so the maximum equals the final value).
 * - tool_use blocks are deduplicated by their `id`; tool_result sizes are deduplicated by `tool_use_id`.
 * - Lines with `isSidechain: true` (subagents) stay in the session aggregate of their `sessionId`; their tokens and
 *   tool calls count, but their prompts are not turns. `turns` counts main-thread human prompts only (no `isMeta`).
 * - Time ranges filter by each line's `timestamp`; with a range, lines without a valid timestamp are excluded.
 *
 * Rules (Codex, experimental): lines look like `{timestamp, type, payload}`.
 * - One file is one session, keyed by the UUID in the file name (else the first session_meta id, else the path); keys
 *   are only ever hashed. Only the first session_meta is used.
 * - Tokens are the delta of the cumulative `token_count.info.total_token_usage`. A repeated total is a duplicate and is
 *   skipped; a total with any lower field is a counter reset and counts `last_token_usage` (else the total). Tracking
 *   always advances, even outside the time range; only in-range deltas are credited. `assistantMessages` is the
 *   number of credited deltas. `token_usage_record` lines (deduplicated by response_id) are a fallback used only when a
 *   file has no token_count; both are never added. Canary counters (`codexTokenMismatches`,
 *   `codexTokenSourceDisagreements`) flag credited deltas that disagree with `last_token_usage` or the other source.
 *   The first total of a file that starts after compaction or a resume already holds earlier usage; that gap is
 *   counted (it is real usage of the thread) but is not a canary hit, and it is left out of the source comparison.
 * - Compaction chains: after compaction Codex may start a new thread in a new rollout whose leading `compacted` line
 *   names the previous thread (`latest_token_usage_record.thread_id`) and whose first total repeats that thread's
 *   total. When the previous thread's rollout is among the inputs, its credited usage is subtracted from the new
 *   rollout's first delta after all files are read (file order does not matter) and the replayed response is not an
 *   assistant message (`codexCompactionLinked`). When it is not among the inputs, the carried usage stays counted
 *   (`codexCompactionCarryovers`). The whole first delta of such a rollout is left out of the source comparison.
 * - function_call_output lines without a call_id that Codex marks `additional_context_tool_output: true` answer no
 *   tool call; they are skipped and counted in `codexContextOutputs`.
 * - Codex input is normalised to Anthropic semantics: input = input_tokens - cached_input_tokens (uncached only),
 *   cacheRead = cached_input_tokens, cacheCreation = cache_write_input_tokens (0 when absent). Whether input_tokens
 *   already includes cache writes is unverified. output_tokens already includes reasoning tokens; they are also exposed
 *   as `tokens.reasoningOutput` for Codex sessions only.
 * - Forked sessions (`forked_from_id`) replay their parent's history. Tool calls are deduplicated globally by call_id.
 *   A fork skips token deltas whose cumulative total was already seen under its parent id (`codexForkedSessions` counts
 *   forks). Fork-of-fork chains read in the wrong order (child before parent) can overcount.
 * - Tool calls come from response_item function_call / custom_tool_call / local_shell_call (name `local_shell`); the
 *   name is namespace + name when a namespace exists. A call is MCP when its name starts with `mcp__`, has a namespace
 *   and contains `__`, or has an `mcp_tool_call_begin` event. Work Intelligence tools match
 *   /(?:^|__)(work_[a-z0-9_]+)$/. Calls without a call_id are counted but cannot be deduplicated.
 * - Code mode (Codex 0.163+): MCP calls made inside `exec` have no function_call and no mcp_tool_call_begin/end; they
 *   leave only an `item_completed` event whose item type is McpToolCall ({id, server, tool, result.content[]}). It is
 *   registered like mcp_tool_call_begin with item.id as the call_id, and its result is used like mcp_tool_call_end.
 *   The `exec` call itself still counts once as an ordinary tool; its output is not MCP.
 * - Result sizes come from function_call_output / custom_tool_call_output (first per call_id wins); an
 *   `mcp_tool_call_end` result is used only when no output item exists for that call_id. Caveat: Codex may store MCP
 *   results as a JSON envelope string, which inflates characters slightly compared with Claude Code.
 * - Turns: the first non-zero of (1) user_message events, (2) item_completed UserMessage items, (3)
 *   task_started/turn_started events, (4) user response_item messages not starting with "<"; never summed, deduplicated
 *   by turn_id when present. Subagent files (session_meta source mentions "subagent") have 0 turns and count their
 *   in-range lines in `sidechainLines`.
 */
export { UsageCache } from "./cache.js";
export { UsageScanAbortedError, UsageScanTimeoutError } from "./errors.js";
export { summarizeFiles, summarizeShapes } from "./scan.js";
export { buildActiveBlocks } from "./blocks.js";
export { safeModelId } from "./model.js";
export { cacheReadShareOf, formatForAgent, formatShapes, formatTable, primaryOf } from "./report.js";
export type { ForAgentOptions } from "./report.js";
export { defaultUsageSourceDirs, encodeClaudeProjectDir, resolveProjectSources } from "./sources.js";
export type { UsageProjectInput, UsageProjectSources, UsageSourceDirs, UsageSourceProblem } from "./sources.js";
export type {
  DayUsage,
  ModelUsage,
  OperationUsage,
  SessionUsage,
  ShapeReport,
  TokenCounts,
  UsageAgentId,
  UsageBlock,
  UsageCacheCounts,
  UsageEvent,
  UsageMetrics,
  UsageReport,
  UsageScanOptions,
  UsageTokens,
} from "./types.js";
