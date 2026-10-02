# Work Intelligence plugin

Work Intelligence keeps a local, searchable record of the work your coding agent does: what changed, how it was verified, what is still open, and reports built from those records. This plugin connects Claude Code (and Codex) to it. Nothing leaves your computer: the records live in a SQLite database on your machine, and the plugin makes no network requests.

## What it adds

- **MCP server `work-intelligence`**: four tools (`work_read`, `work_write_idempotent`, `work_write_additive`, `work_write_overwrite`) for project status, task context, recall of past work, saving a finished session, and reports. Only projects you mark as tracked in the Work Intelligence Web UI are recorded.
- **Skill `work-intelligence`**: tells the agent when and how to use those tools.
- **Save-reminder hooks**: a `Stop` hook in Claude Code, and `PostToolUse`, `Stop` and `UserPromptSubmit` hooks in Codex (`hooks/codex-hooks.json`; trust them under `/hooks`). After the agent edits files in a tracked project and has not saved a record since, it reminds the agent once. To decide, it reads the current session's transcript file (the path the agent passes to the hook) and the tracked-project list from the database, read-only. It writes an empty marker file under the system temp directory so it reminds only once, and never blocks the agent if it cannot tell.

## Requirements

- Node.js 22.13 or later (`node:sqlite`).
- A local checkout of [WorkLog.Ai](https://github.com/Ponpon55837/WorkLog.Ai), built once:

```bash
git clone https://github.com/Ponpon55837/WorkLog.Ai
cd WorkLog.Ai
pnpm install && pnpm build && pnpm plugin:link
```

## What it runs and reads

The plugin contains no copy of Work Intelligence. Its MCP server and hooks start `scripts/launch.mjs`, which finds your checkout and runs that checkout's built `apps/mcp/dist/index.js` (MCP server), `apps/mcp/dist/finalize-reminder.js` (Claude Code hook) or `apps/mcp/dist/codex-finalize-reminder.js` (Codex hooks) with the same Node.js. It looks for the checkout in this order:

1. the `WORK_INTELLIGENCE_HOME` environment variable;
2. a checkout that contains the plugin folder;
3. `~/.work-intelligence/plugin-link.json`, written by `pnpm plugin:link`.

It uses the first one that is built. The database is the checkout's `data/work-intelligence.sqlite`, or `WORK_INTELLIGENCE_DB` when set. A release build (`pnpm build:plugin`) also carries a bundled server in `server/`, used only when no built checkout is found; it then opens the linked checkout's database, or `~/.work-intelligence/data/work-intelligence.sqlite` when nothing is linked.

## Troubleshooting

Run `pnpm run doctor` in the checkout. It reports whether the plugin is enabled and warns if a manual MCP registration duplicates it. More help: [docs/plugins.md](https://github.com/Ponpon55837/WorkLog.Ai/blob/main/docs/plugins.md).

## License

MIT
