---
name: dashboard
description: Open the Work Intelligence Web UI (dashboard) for the user. Starts the local Work Intelligence server from their checkout when it is not running, then gives them the URL. Use when the user asks to see, open or check the Work Intelligence dashboard, Web UI, work history, reports or Knowledge pages in a browser.
---

# Open the Work Intelligence dashboard

The dashboard is the Work Intelligence Web UI, served on this computer at `http://127.0.0.1:3210` (or the port in `WORK_INTELLIGENCE_PORT`). It shows the same database the MCP tools read and write. It needs the user's local WorkLog.Ai checkout, built with `pnpm build`; the bundled server in a release build has no Web UI.

## Steps

1. Run the dashboard script. It prints the URL when the server is already running; otherwise it starts the server in the background, waits until it answers, prints the URL, and opens it in the default browser.
   - **Claude Code**: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs" dashboard --open`.
   - **Codex and other agents**: find the checkout first: the `WORK_INTELLIGENCE_HOME` environment variable, else `repositoryRoot` in `~/.work-intelligence/plugin-link.json` (written by `pnpm plugin:link`). Then run `node "<checkout>/scripts/dashboard.mjs" --open`.
2. Give the user the printed URL as a link. Say whether the server was already running or was just started.
3. If the script fails, relay its message and the fix it names:
   - not built: run `pnpm install && pnpm build` in the checkout;
   - port in use by another program: stop it, or set `WORK_INTELLIGENCE_PORT`;
   - no checkout or no `plugin-link.json`: clone WorkLog.Ai, build it, and run `pnpm plugin:link`;
   - the agent's sandbox blocks starting a background process or reaching `127.0.0.1`: ask the user to approve the command, or to run `pnpm dashboard` in the checkout themselves.

A server started this way runs until the computer restarts or the user stops it. To start it automatically at login, the user can run `pnpm service:install` in the checkout once.

Do not change any records or settings while opening the dashboard.
