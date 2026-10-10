# Work Intelligence

Version **1.4.0** adds in-progress verification and native architecture diagram cards. Existing Mermaid diagrams retain their saved format; the app stays on database schema 27. After updating and rebuilding, restart the running server and reconnect the Agent MCP to load the new contracts.

**English** | [繁體中文](README.zh-TW.md)

**Local-first work memory for developers.** When an Agent such as Codex or Claude finishes a piece of work, it writes what it did, which files it changed and how it verified the result into a single SQLite file on your computer. You review that history in the Web UI and build daily, weekly, monthly, quarterly, yearly or custom-range reports; before starting new work or when hitting an error, the Agent can look up past work and Knowledge from the same place.

- 🔒 **Nothing is recorded by default**: only projects you explicitly set to "Tracked" are read and saved; every other project is skipped.
- 🏠 **Your data stays on your machine**: the API only accepts connections on `127.0.0.1`, never sends data anywhere, and never writes configuration into your project repos.
- ✅ **Open items you can check off**: before wrapping up, the Agent fetches the items related to the task and its files and closes them only when they are done. When new work replaces an old item the Session audit is kept, and items without enough evidence stay open. The Web UI handles batches of up to 100 items with undo, and you can request a cleanup where the Agent proposes changes with evidence that you accept or reject.
- 🧾 **Traceable**: every summary and report conclusion links back to its source Sessions, files and evidence. Changed files are not Git commits, verification results are never guessed for the Agent, and corrections and voids leave an audit trail.
- 💾 **Portable and deletable**: daily automatic backups, whole-database SQLite snapshots, JSON export of one or all projects with merge import, and permanent per-project deletion with a content-free deletion record.
- 🩺 **Self-diagnosing**: `pnpm run doctor` checks the whole environment read-only; when the API drops, a banner appears and the page reloads its data once the API is back.

---

## Contents

- [Quick start](#quick-start)
- [Connect Codex / Claude](#connect-codex--claude)
- [Everyday use](#everyday-use)
- [Web UI tour](#web-ui-tour)
- [Backups, moving computers and deletion](#backups-moving-computers-and-deletion)
- [Upgrades and maintenance](#upgrades-and-maintenance)
- [Core concepts](#core-concepts)
- [Security and privacy](#security-and-privacy)
- [Project layout and development](#project-layout-and-development)
- [Documentation](#documentation)
- [License](#license)

## Quick start

Requirements: **Node.js 22.5 or later** (24 recommended; the built-in `node:sqlite` is used) and **pnpm 11.16 or later** (see `engines.pnpm` in `package.json`). Setup takes about five minutes; the first dependency download may take longer.

```bash
cd /path/to/WorkLog.Ai
pnpm install
pnpm build
pnpm setup:agents
```

`pnpm setup:agents` first lists the MCP server, user-level skills and save-reminder hook it would install. The preview writes nothing; after checking it, type `yes` at the prompt and the installer backs up your settings before applying them. Type anything else or exit to leave your global Agent settings untouched. Scope, backups and uninstalling are covered in the [Agent setup guide](docs/agent-setup.md).

Then start the local Dashboard and REST API:

```bash
pnpm start
```

Keep the terminal open; press `Ctrl+C` to stop. In production mode one process serves the Web UI and the REST API on the same port.

To start automatically when you log in, run `pnpm build` and then `pnpm service:install`. It shows the service file it will write, with its full content, and configures a service for the current user only after you confirm; no administrator rights are needed. `pnpm service:status` shows the state and `pnpm service:uninstall` stops and removes the service while keeping the database, backups and logs. Per-platform locations and troubleshooting are in [Start at login](docs/service.md).

| Item | Location |
|---|---|
| Web UI | <http://127.0.0.1:3210> |
| REST API | <http://127.0.0.1:3210/api/health> (returns the app version and schema version) |
| SQLite | `data/work-intelligence.sqlite` (override with `WORK_INTELLIGENCE_DB`) |

Before first use, run the diagnostics:

```bash
pnpm run doctor
```

Use `pnpm run doctor`, not `pnpm doctor`: pnpm 11 reserves `doctor` for its own command, which does not run the Work Intelligence diagnostics. The doctor checks Node.js, pnpm, the build output, database health and schema version, recent backups and maintenance, API reachability, MCP registration, skill copies and the global save-reminder hook — all read-only — and lists fixes in Traditional Chinese. Its output contains no work-record content.

Reconnect the Work Intelligence MCP in Codex or Claude Code; if Codex uses the save-reminder hook, review and trust it under `/hooks`. Then in the Dashboard:

1. Open **Projects** → **Add project** and choose the project folder to record.
2. Switch the project's status to **Tracked** and confirm the scope that may be read.
3. Confirm the connection in your Agent conversation and work as usual; when you finish, ask the Agent to save the work.

Until there is a tracked project or a Session, the overview shows a four-step checklist — add a project → set it to Tracked → connect an Agent → first work record — with links to the right pages and the install command.

The bottom of the sidebar shows the current app version and schema version.

## Connect Codex / Claude

The Work Intelligence MCP is a **local stdio server** started by the Agent itself; it does not use the Web UI's HTTP port. Run `pnpm build` once, then register it with your Agent. Use absolute paths so the API, MCP and CLI share one database.

### Install as a plugin (Claude Code / Codex)

The simplest way to connect an Agent. Claude Code and Codex install Work Intelligence from this repository's marketplace; the plugin runs your local checkout, so build it once and link it:

```bash
git clone https://github.com/Ponpon55837/WorkLog.Ai && cd WorkLog.Ai
pnpm install && pnpm build && pnpm plugin:link
```

**Claude Code**

```bash
claude plugin marketplace add Ponpon55837/WorkLog.Ai
claude plugin install work-intelligence@worklog-ai
```

Restart Claude Code; `/mcp` lists `work-intelligence` as connected. The save reminder works with no further step.

**Codex**

```bash
codex plugin marketplace add Ponpon55837/WorkLog.Ai
```

In Codex, open `/plugins` and install `work-intelligence`, then open `/hooks`, review the plugin's hooks and choose **Trust** (untrusted hooks are skipped; the MCP server and skills work without them). Restart Codex; `/mcp` lists `work-intelligence` as connected.

| The plugin brings | Claude Code | Codex |
|---|---|---|
| MCP server `work-intelligence` (recall, context, finalize, reports) | ✓ | ✓ |
| Skill `work-intelligence` (when and how to use the tools) | ✓ | ✓ |
| Skill `dashboard` (opens the Web UI) | ✓ `/work-intelligence:dashboard` | ✓ ask for it |
| Save reminder hooks | ✓ | ✓ after **Trust** in `/hooks` |

**Open the dashboard**: ask the Agent to "open the Work Intelligence dashboard" (in Claude Code also `/work-intelligence:dashboard`), or run `pnpm dashboard` in the checkout. It starts the server in the background when it is not running and opens <http://127.0.0.1:3210>. To have it running after every login, run `pnpm service:install` once.

**Update**: in the checkout run `git pull && pnpm install && pnpm build`, then `claude plugin update work-intelligence@worklog-ai`; for Codex run `codex plugin marketplace remove worklog-ai` and add it again. Reconnect the Agent when it says so.

**Already registered by hand?** Use either the plugin or the manual registration below, not both, or the Agent sees every tool and reminder twice. Remove the manual one with `claude mcp remove work-intelligence --scope user` / `codex mcp remove work-intelligence` and delete the Work Intelligence entries from the Claude `settings.json` and Codex `hooks.json` hooks; `pnpm run doctor` reports any duplicate.

**No checkout?** Each [GitHub Release](https://github.com/Ponpon55837/WorkLog.Ai/releases) attaches `work-intelligence-plugin-<version>.zip` (the plugin with a bundled MCP server) and `work-intelligence-<version>.mcpb` (a Claude Desktop extension). They need Node.js 22.13+ and keep data in `~/.work-intelligence/data`, but carry no Web UI.

Something wrong? Run `pnpm run doctor`, and see the [plugin guide](docs/plugins.md) for its troubleshooting table.

### Register manually

To set up the MCP server and the user-level skill in one go, run `pnpm setup:agents` to preview the install plan; nothing is written by default. Usage, backups and uninstalling are in the [Agent setup guide](docs/agent-setup.md). The MCP server also serves the full skill and record format through standard `resources/list` / `resources/read`, so any client that supports MCP resources can read `work-intelligence://agent/work-intelligence/SKILL.md` and `work-intelligence://agent/work-record-and-report-format.md`.

macOS / Linux:

```bash
# Codex CLI
codex mcp add work-intelligence --env "WORK_INTELLIGENCE_DB=/path/to/WorkLog.Ai/data/work-intelligence.sqlite" -- pnpm --dir "/path/to/WorkLog.Ai" start:mcp

# Claude Code (user scope, available in every workspace)
claude mcp add --scope user --transport stdio work-intelligence --env "WORK_INTELLIGENCE_DB=/path/to/WorkLog.Ai/data/work-intelligence.sqlite" -- pnpm --dir "/path/to/WorkLog.Ai" start:mcp
```

Windows (PowerShell):

```powershell
codex mcp add work-intelligence --env "WORK_INTELLIGENCE_DB=C:\path\to\WorkLog.Ai\data\work-intelligence.sqlite" -- pnpm.cmd --dir "C:\path\to\WorkLog.Ai" start:mcp

claude mcp add --scope user --transport stdio work-intelligence --env "WORK_INTELLIGENCE_DB=C:\path\to\WorkLog.Ai\data\work-intelligence.sqlite" -- pnpm.cmd --dir "C:\path\to\WorkLog.Ai" start:mcp
```

Expired MCP leases and leftover temporary files are cleaned up in batches during MCP registration and System Status reads (90-second threshold by default, at most 64 deletion attempts per pass); see [Troubleshooting](docs/troubleshooting.md).

Claude Code also gets two MCP prompts: `/mcp__work-intelligence__finalize-work` and `/mcp__work-intelligence__synthesize-report`. Claude Desktop setup, verification and common questions are in **[docs/agent-setup.md](docs/agent-setup.md)**. After updating Work Intelligence, run `pnpm build` again. You only have to reconnect when the schema or Agent contract changed or compatibility cannot be confirmed; an implementation-only update shows "Update available", the existing connection keeps reading and writing, and you are reminded to reconnect when wrapping up.

The round-nine open-item cleanup adds schema and Agent-contract changes. Before updating your main install, save your work records, then follow the [upgrade notes](docs/user-guide.md#更新-work-intelligence) to rebuild, restart the service and reconnect your Agents. Afterwards you can start a cleanup from the Web UI; the Agent submits suggestions and you accept or reject them.

### Save-reminder hook (optional)

To have the Agent reminded once when it forgets to save, add the save-reminder hook. Like the MCP server it is installed **globally** and works in any project; it only acts in "Tracked" projects, lets everything else through, and also lets the Agent through if its own check fails.

| Agent | Global settings file | Events | Script |
|---|---|---|---|
| Claude Code | `~/.claude/settings.json` | `Stop` | `apps/mcp/dist/finalize-reminder.js` |
| Codex | `~/.codex/hooks.json` | `PostToolUse` (`apply_patch`, `work_finalize_session`) + `Stop` | `apps/mcp/dist/codex-finalize-reminder.js` |

- Use the repo's absolute path and run `pnpm build` first.
- Codex requires you to review and trust the hook under `/hooks`.
- The repo does not ship a project-level `.codex/hooks.json`.
- `pnpm run doctor` checks whether the setup is correct.

Full examples are in [Save-reminder hook](docs/agent-setup.md#保存提醒選用).

## Everyday use

You talk to the Agent in plain language; it handles tool names, request IDs and JSON (the rules live in [`.agents/skills/work-intelligence`](.agents/skills/work-intelligence/SKILL.md)).

| To… | Say to the Agent | Or in the Web UI |
|---|---|---|
| Check whether a project is recorded | "Is this project being recorded in Work Intelligence?" | Projects |
| Save this piece of work | "Done — please record this work in Work Intelligence." (untracked projects are skipped) | — |
| Tidy existing open items | "Please tidy this project's open items." | Work history → Open items: choose a project, create a cleanup request, review the sources, reasons and evidence, and accept or reject one by one or in bulk |
| Pick up earlier open items | "Which of the earlier open items did this work resolve?" | Work history → Open items: filter by project and status; mark done, no longer needed, or reopen |
| Recover project context | "First check what has happened in this project recently in Work Intelligence." | Work history, Work knowledge |
| Look up past work or errors | "Have we dealt with the report time-zone problem before?" or paste the error. (The Agent ranks Sessions, raw handoffs and Knowledge with `work_recall`; structured work fields come first, repeated old handoffs score lower, and a fixed software glossary finds low-confidence leads across Chinese and English. `work_search` returns compact Session hits with a confidence; `none` means there is nothing to cite, and full records can be read afterwards.) | Work history search (every keyword must match) |
| Write a report | "Summarize this week's Work Intelligence report for me." (The Agent creates the request if none exists; custom ranges work too.) | Work reports → **Ask Agent to synthesize this report**; the page updates when the Agent is done |
| Synthesize Knowledge candidates | "Synthesize Work Intelligence Knowledge candidates for me." | Work knowledge → **Synthesize candidates**; candidates become Knowledge only after you accept them (optionally editing first) |
| Update standing Knowledge pages | "Update this project's Knowledge pages." | Work knowledge → Knowledge pages: architecture and conventions, work in progress and open items, common gotchas — every section cites its source Sessions. The Agent is prompted to maintain a page when sources need checking or 3 new Sessions accumulate; the page shows when it was last checked and can be edited by hand with version history |
| Fill missing metadata | "Fill the Work Intelligence metadata gaps." (The Agent creates the request if none exists.) | Projects → Metadata backfill → **Scan metadata gaps** |
| Fix a saved summary | "Fix the summary of the last Session: …" | Session panel → **Edit Session** |
| Link related work | "This implements yesterday's plan." | Session panel → **Link Session** |
| Retract a wrongly recorded Session | "The last Session went to the wrong project; please void it." (can be restored) | Session panel → **Void** |
| Import past handoffs | "Preview which handoffs from this project can be imported." | Projects → Handoff import |

Every Session has a one-sentence summary and five fixed sections: **Outcomes / Scope / Decisions / Verification / Status and open items**. Each open item has a stable identifier and links back to its source Session; when existing data is upgraded, items start as pending and are never assumed done. The Agent can report resolved items when it saves later work, and the Open items tab of Work history can mark items done, no longer needed or reopened by hand. The format and report granularity are defined in [Work record and report format v1](docs/work-record-and-report-format.md). Before backfilling past work, the Agent checks existing Sessions and uses only conversation or hook evidence for actual start and end times; gaps stay gaps rather than being estimated from PR merge times.

### Measure your own retrieval quality

You can rerun recall and context with your own private questions to check that the expected Sessions / Knowledge rank near the top:

```bash
pnpm eval:recall ./recall-questions.json --db ./data/work-intelligence.sqlite --out ./recall-report.json
```

Run `pnpm build` first (this CLI needs Node.js 22.5+, like the rest of the repo). Each question sets `mode: "recall"` or `"context"`, a `query`, and one or more expected ids or `expectedNoHit: true`; a project path and recall date range are optional. The report lists hit@1, hit@5 and MRR per mode, each question's rank, confidence, MCP response size and call time. The database is snapshotted to an OS temp file over a read-only SQLite connection, and retrieval and index sync only touch the snapshot; results go to the terminal or to a new file given by `--out`, are never uploaded, and never overwrite an existing file. See [`tests/fixtures/recall-eval-example.json`](tests/fixtures/recall-eval-example.json) for the format and [Testing](docs/testing.md#檢索品質評估) for limits and metric definitions.

More detail is in the **[User guide](docs/user-guide.md)**.

## Web UI tour

A GitHub (Primer) style interface with dark and light themes, available in English and Traditional Chinese. The sidebar has three groups. Long lists scroll inside their own box instead of stretching the page.

- **Theme**: the sun/moon button in the header switches between light and dark; System status → Personal preferences can return to **Follow system**, which tracks your operating system's light or dark setting. The first visit follows the system. The light theme uses soft grey surfaces rather than pure white to reduce glare.
- **Language**: the language menu in the header switches between English and 繁體中文. The first visit follows the browser language (Chinese browsers get Traditional Chinese, everything else English). Only interface text is translated; Sessions, reports and anything an Agent wrote keep the language they were recorded in.
- Theme and language are stored in this browser only and never sent to the local API.
- While data loads, pages show a "Loading…" caption over placeholder rows, and counts stay hidden until they are known.

| Page | What it is for |
|---|---|
| **Overview** | This week's Sessions, verification breakdown and two deterministic insights (full-period counts/project share, weekly comparison and verification priority, with report links), existing reminders grouped by project and kind (Knowledge/page review, autonomous decisions, cleanup review, open-item and metadata-gap entries, and report/backfill requests), with bounded pagination and explicit partial/error coverage, recent work and a **Work activity** calendar (one cell per day for the past 53 weeks, shaded by completed Sessions; click a day to open its report); shows the four-step first-run checklist until there is a tracked project or Session |
| **Work history** | Multi-keyword search over all Sessions with project and date filters. The **Open items** tab pages through items by project, status and source-Session completion date, marks the current page's selection done / no longer needed in batches of up to 100, undoes a batch back to pending or reopens items one by one; every item links to its source Session. Clicking a Session opens its details on the right (start time, duration, last update), with `J`/`K` for next/previous. The panel shows which Agent client (and model, if reported) wrote the Session, and the list can be filtered by Agent; **Copy as Markdown** copies a Session for a PR description, standup or handoff, and **Agent reads** lists when Agents were given this Session. **Edit Session** corrects the summary, the five sections and verification (with change history); you can also link Sessions, void or restore them, and mark individual Evidence as wrong. Newly saved Sessions appear automatically |
| **Work reports** | Daily, weekly, monthly, quarterly, yearly and custom-range (up to 366 days) reports, split by the system time zone, which the header shows. The overview groups the period (the day's Sessions, daily/weekly/monthly/quarterly distribution, project share); there is also AI report synthesis (every section cites source Sessions, with version-specific pin/hide/restore controls and audited manual edits that preserve the original), trends, risks, cross-period work (started earlier, finished later, edited afterwards), raw records and source evidence, with warnings when data exceeds a limit. Export to Markdown / JSON |
| **Work knowledge** | Four tabs, each showing its count: **Knowledge** (decisions, patterns, gotchas, procedures and skills the Agent explicitly submitted; marked "Possibly stale" when related files change and "Needs review" when a Session contradicts it; shows how often Sessions confirmed or contradicted it and which ones; confirm as still valid, edit, archive and view history), **Knowledge pages** (standing pages the Agent writes from recorded Sessions, every section citing its sources; new Sessions first show as "New data available", and after 3 of them or when sources need checking, context and finalize prompt the Agent to review; if the answer is unchanged the page is marked as checked with the checkpoint shown, and it is only rewritten when the answer changes; request an Agent update, edit by hand, view versions and compare a version with the one before it), **Candidates** (Knowledge the Agent proposed, waiting for you to accept or reject) and **Decisions to confirm** (decisions the Agent made on its own, which you can confirm, reject or promote to Knowledge) |
| **Work graph** | Three tabs: **Timeline** (one swimlane per project; zoomed out, one bar per day coloured by verification result, click to zoom into that day; zoomed in, Sessions are drawn as bars or dots and links as arcs; Knowledge created / confirmed / contradicted / superseded events are markers; zoom, show the whole period, choose a range and click to open a Session; also available as a list grouped by date, used automatically at phone width), **Graph** (projects, Sessions, Knowledge, Evidence, files and Session links; solid lines are recorded relationships, and the derived "changed together" relationship can be shown dashed; from a node's panel you can choose another node and see step by step how they are connected) and **Hotspots** (files or folders changed by the most Sessions, with their failed and not-run verification share and the latest 5 Sessions; filter by project and period). The Risks tab of Work reports also lists files changed by 2 or more Sessions in the period |
| **Projects** | The project list and tracking status (pick a folder with the system dialog when adding; set an https repository URL so Session commits link to it), permanent project deletion, Metadata backfill, Handoff import and Data backup (backup, export, import) |
| **Session diagrams** | When work changes cross-module flows, data flows, state machines or architecture, the Agent attaches one or two Mermaid diagrams to the Session (`work_attach_diagram` or finalize's `diagrams`; not for single-file fixes, styling, configuration or test-only work). They load lazily in the Session panel and redraw with the theme; unparseable diagrams show their source. Diagrams can be voided but not deleted, and travel with project export and import |
| **System status** | App and schema version, database location and size, latest automatic backup, backup count and total size, the last database maintenance result, the start-at-login service, and the read-only state of Codex / Claude Code MCP registration, skill copies and global hooks; it never changes service or Agent settings. **Agent read log** lists recent MCP reads (when, which Agent and tool, which project, and the returned Session ids), filterable by project and Agent. **Personal preferences** sets the theme, interface language and whether to open a Session's changed files in VS Code or Cursor (all stored in this browser only). For a full environment check, use `pnpm run doctor` |

Session detail also offers up to five related-work suggestions based on shared confirmed files in the same tracked project. Existing links are excluded, and a partial search is marked; opening a suggestion creates no relationship.

Shortcuts: `Ctrl`/`⌘` + `K` to search, jump to a page, or switch theme and language; `/` to focus the page search; `g` + `d` / `s` / `r` / `k` / `g` / `p` to switch pages. Filters and the open Session live in the URL, so you can share or reload them.

When the API is unreachable, a "Cannot reach the Work Intelligence API" banner appears at the top, and the current data reloads automatically once the connection is back.

## Backups, moving computers and deletion

All records live in one SQLite file.

- **Automatic backups**: the API server backs up once per local calendar day into `backups/` next to the database. Automatic and manual backups are kept separately, the latest 14 of each by default, so manual backups never push out daily ones. Backup files are readable and writable only by the current user.
- **Manual backups**: Web UI → Projects → Data backup → **Back up now**, or `pnpm db:backup`.
- **Managing backups**: Projects → Data backup lists each backup's kind, time and size plus the total; deleting shows the file name and kind and asks for confirmation, with an extra warning for the only listed backup. On the CLI, `pnpm db:backups` lists them and `pnpm db:backups --delete <file name>` deletes one after confirming in an interactive terminal. After a project is deleted, its pre-deletion backup and older backups may still contain its data; manage them from the Data backup page.
- **Taking data per project**: Projects → Data backup exports all projects or a single project as JSON. On the CLI use `pnpm db:export --all` or `pnpm db:export --project <project name or id>`, with `--out <file.json>` for the output location. JSON exports are not encrypted; keep them safe.
- **Merge import**:
  - Choose a JSON file on the same tab. The preview shows each source path and the matching folder's state on this computer; for missing projects you can pick a folder one by one, or skip and import them paused. Only whether the chosen path is a folder is checked; its contents are never read.
  - When several exported paths have a same-named folder under their parent folder, the UI lists the candidates and asks you to confirm each one before using it.
  - CLI: `pnpm db:import <file.json> --dry-run` only previews; an interactive import asks for a new location for each missing folder (press Enter to skip). You can also pass `--remap-root <old path>=<new path>`; nothing is written until you type `yes`.
  - Imports can be repeated and never overwrite existing data; newly imported projects start paused.
  - Imports merge through the running API / SQLite, so there is no need to stop the service.
- **Path remapping**: `--remap-root` can be repeated and matches whole path segments. Windows paths are case-insensitive and separators follow the new path. It only adjusts project roots and handoff source paths in the imported data and never reads or writes files through the imported paths.
- **Relocating a project**: the Projects page flags folders that are missing or cannot be checked. **Relocate** only picks and validates a new folder, then updates the project root and the path prefix of that project's raw snapshots. If the project is tracked you are asked to confirm the new scope the Agent may read and write. The audit stores only the time, project id and whether paths changed — never the paths; MCP cannot change paths or delete anything.
- **Moving to a new computer**:
  1. On the old computer press **Export all data** (or run `pnpm db:export <file>`) to get a `.sqlite` file. It contains every work record and is not encrypted; move it by a trusted route.
  2. On the new computer run `pnpm build`, stop the API server, and close any Agent conversation that starts MCP.
  3. Restore:

     ```bash
     pnpm db:restore <export file> --remap-root <project parent path on old computer>=<path on new computer>
     ```

  Leave out `--remap-root` if projects live in the same place; you can also pass several. The restore checks file integrity and version, backs up the new computer's existing data first, and stops if another program still has the database open. Restoring from a backup uses the same command.

- **Permanently deleting a project**: press the trash button next to a project on Projects → Project list, read the scope, and type the full project name to confirm.
  - A full backup is created and verified first; if it fails, nothing is deleted.
  - One transaction deletes the project's Sessions, events, handoffs, Evidence, Knowledge, candidates, report synthesis, change history, search index, and other projects' links pointing to it.
  - Only a content-free deletion record remains (time, project id, counts per kind).
  - Projects → Deletion history shows each deletion's time, project id and counts — no project name, path or deleted content.
  - The project folder itself is never touched. MCP has no deletion tool; only you can delete, through the UI or REST API.
  - **After deletion the data still exists in earlier backups and exports** until they rotate out or you delete them. See the [User guide](docs/user-guide.md#永久刪除專案資料).

Backup environment variables:

| Variable | Purpose |
|---|---|
| `WORK_INTELLIGENCE_BACKUP_DIR` | Backup folder, `backups/` next to the database by default. Relative paths resolve from the database folder, so the API, MCP, CLI and doctor all point to the same place |
| `WORK_INTELLIGENCE_BACKUP_KEEP` | Number of manual backups kept, 14 by default; 14 automatic backups are kept separately |
| `WORK_INTELLIGENCE_BACKUP=off` | Turns off the daily automatic backup |

## Upgrades and maintenance

**Upgrading**: after updating the code, run `pnpm install` and `pnpm build`, then restart `pnpm start` and your Agent conversations.

- When a new version needs a database upgrade, a pre-migration backup (`pre-migration-v<version>-…`) is created on first open and the migration runs in a single transaction; if the backup fails, nothing is upgraded.
- If the database schema is newer than the program (for example, a newer version was used on another computer), the API, MCP and CLI refuse to open it and ask you to update Work Intelligence first instead of crashing or half-applying anything.
- Step-by-step instructions are in the [User guide](docs/user-guide.md#更新-work-intelligence) and version changes in the [CHANGELOG](CHANGELOG.md).

**Database maintenance**:

```bash
pnpm db:maintain
```

It creates a pre-maintenance backup, then runs `integrity_check`, `VACUUM`, `ANALYZE` and a search-index rebuild, and records the result for `pnpm run doctor` to show. It needs the database to itself, so stop `pnpm start` and close any Agent conversation that starts MCP first; if the database is still open, it stops and tells you.

When something goes wrong, run `pnpm run doctor` first, then see **[Troubleshooting](docs/troubleshooting.md)**.

## Core concepts

**Project recording status (default deny)**

| Status | Meaning |
|---|---|
| Unregistered `unregistered` | The default when a project is added; nothing is read or saved |
| Tracked `tracked` | You explicitly authorized it; the Agent may read handoffs / Git / source and save work records |
| Paused `paused` | Recording paused; existing data is kept |
| Ignored `ignored` | Explicitly excluded |

For any project that is not "Tracked", every Agent request returns `skipped` and no file is read. The Agent cannot switch a project to "Tracked" for you.

**Distinctions that are easy to mix up**

- **Finalize ≠ Git commit**: a piece of work may have no commit; changed files only mean files changed.
- **Verification has five distinct states**: passed, failed, in progress (`in_progress`), explicitly not run (`not_run`), and not reported (older data without it). Choose “In progress” in the Session editor when verification has started but its result is not confirmed; update the same record to passed or failed after checking the result. Starting work alone never implies passed. Reports and portable exports preserve this distinction; record finalization remains separate from verification.
- **Report numbers ≠ AI summary**: statistics and trends are computed by fixed rules; every conclusion in an AI synthesis must cite source Sessions and says "insufficient data" when there is not enough.
- **Knowledge only takes explicitly submitted content**: nothing is extracted automatically from handoffs or source code. The Agent proposes candidates; they become Knowledge only after you accept them.
- **Corrections leave a trail instead of rewriting history**: the summary, the five-section workSummary and verification can be corrected in place by the Agent or in the Session panel (same Session, with change history). Wrongly recorded Sessions and wrong Evidence are voided (a reason is required; they can be restored). Changed files, events and Evidence content stay read-only.
- **Changes that existed before work started are not this work's outcome**: the Agent can record pre-existing changes when starting (`baselineChangedFiles`), and finalize excludes them from changed files.
- **Knowledge flags itself as stale**: when files listed in `appliesTo` change later, it is marked "Possibly stale".
- **Void ≠ delete**: voids can be restored; permanent deletion applies only to whole projects and needs your confirmation.

The full data contracts, consistency guarantees and design principles are in [docs/architecture.md](docs/architecture.md).

## Security and privacy

- The API listens only on `127.0.0.1` and checks `Host` and `Origin`. In production mode the Web UI and API share an origin and add a Content-Security-Policy, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
- Static file serving blocks `..`, encoded paths and symlinks pointing outside.
- Error responses carry fixed messages and never leak SQLite or file-system internals.
- Backups and exports are not encrypted; store and move them by trusted means.
- When using MCP, the Agent host may send tool results to a remote model depending on its settings; that is governed by the Agent host's policy.
- Successful MCP reads are audited locally with ids and counts only (never the query or content), kept for 30 days or the newest 5,000 reads, and removed with their project.

The threat model and how to report vulnerabilities are in [SECURITY.md](SECURITY.md).

## Project layout and development

```text
apps/
  web/       Vue 3 + Vite Web UI (GitHub/Primer design system, dark / light themes, English / 繁體中文 interface from per-locale JSON message catalogs); Pinia stores hold state, Pinia Colada caches and invalidates API data
  server/    REST API, production static files, CLI (db:*) and doctor
  mcp/       MCP stdio server and save-reminder hooks
packages/
  core/            domain types and extension interfaces
  schema/          Zod input contracts
  storage/         SQLite schema, migrations, and services for reports, synthesis, backfill, recall, backups, data transfer, deletion and maintenance
  project-policy/  default-deny policy gate and safe paths
  shared/          shared constants, version and helpers
tests/             unit / integration tests per package and Playwright E2E (one folder per package)
scripts/           production start, pre-build dist cleanup and other scripts
data/              local SQLite and backups/ (not version-controlled)
```

```bash
pnpm dev                      # development: Web UI on 5966 (Vite) + API on 3210
pnpm start                    # production: Web and API on one port (build first)
pnpm dashboard                # start the production server if needed and open the Web UI
pnpm plugin:link              # let the Claude Code / Codex plugin find this checkout
pnpm build:plugin             # self-contained plugin zip and Claude Desktop .mcpb in dist/plugin/
pnpm start:server             # API only
pnpm start:mcp                # MCP stdio server only
pnpm run doctor               # read-only diagnostics
pnpm db:backup                # back up now (db:export, db:import, db:restore above)
pnpm db:backups               # list backups; add --delete <file name> to delete after confirming
pnpm db:maintain              # offline maintenance (stop the server and MCP first)
pnpm test                     # ESLint, code layout and Prettier checks, plus package and Web unit tests
pnpm test:coverage            # coverage (schema, storage, server, mcp and web have thresholds)
pnpm test:performance         # read-path performance thresholds on synthetic data (build first)
pnpm test:retrieval-quality   # work_recall retrieval-quality thresholds on synthetic data (hit@5, MRR)
pnpm eval:recall <questions.json>  # read-only local recall/context evaluation (accepts --db and --out)
pnpm test:response-size       # synthetic MCP output-size baseline and CI limits
pnpm typecheck                # packages, Vue and E2E types
pnpm test:e2e                 # Playwright in production mode after a build (full Chromium suite, Firefox / WebKit core flows) on a separate temporary SQLite
pnpm format                   # format the repo with Prettier
```

CI runs build, test, typecheck and coverage on Ubuntu, Windows and macOS; Ubuntu additionally runs the production-dependency security audit (fails on high / critical), the performance, retrieval-quality and MCP response-size thresholds, and Chromium / Firefox / WebKit E2E (Chromium and Firefox run axe accessibility checks on the six main pages, System status, backup management and the first-run checklist, in both themes). Ubuntu WebKit is not a substitute for testing on a real macOS Safari. Details are in [docs/testing.md](docs/testing.md).

Other settings:

- `WORK_INTELLIGENCE_DB`: SQLite location.
- `WORK_INTELLIGENCE_PORT`: production port, `3210` by default.
- `WORK_INTELLIGENCE_ALLOWED_ORIGINS`: not needed in production mode, which is same-origin. In development or with a custom origin, set it in `.env` (comma-separated, `*` not allowed); its hosts are also added to the API's `Host` allowlist.
- Reports and date filters split days by the server's system time zone (Node honours the `TZ` environment variable).

Before starting work, read the matching shared skill (shared by Codex and Claude, under `.agents/skills/`):

| Area | Skill |
|---|---|
| Web UI design and data semantics | [`worklog-ui`](.agents/skills/worklog-ui/SKILL.md) |
| Web code conventions (Vue, TypeScript, Pinia stores, query keys, i18n) | [`worklog-web-code-style`](.agents/skills/worklog-web-code-style/SKILL.md) |
| Storage, server, MCP (migrations, error codes, performance rules, export and deletion of new tables) | [`worklog-backend`](.agents/skills/worklog-backend/SKILL.md) |
| Code placement order in every file (declare before use, lifecycle position and so on; checked by `pnpm lint`) | [`worklog-code-layout`](.agents/skills/worklog-code-layout/SKILL.md) |
| How Agents use the Work Intelligence MCP tools | [`work-intelligence`](.agents/skills/work-intelligence/SKILL.md) |

Development workflow, health checks and PR rules are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

The guides under `docs/` are written in Traditional Chinese.

| Document | Contents |
|---|---|
| [docs/user-guide.md](docs/user-guide.md) | Installation, production mode, everyday use, reports, Knowledge, backups, deletion, moving computers and upgrades |
| [docs/release.md](docs/release.md) | SemVer, pre-release checks, tag-only GitHub Releases and cross-version upgrades |
| [docs/release-checklist.md](docs/release-checklist.md) | Per-platform manual acceptance steps with result fields; unchecked items stay pending |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Common problems with API connections, ports, MCP, global hooks, restore, import and maintenance |
| [docs/service.md](docs/service.md) | User-level start at login on macOS, Windows and Linux, removal and troubleshooting |
| [docs/agent-setup.md](docs/agent-setup.md) | Registering with Codex CLI, Claude Code and Claude Desktop, and the global save-reminder hook |
| [docs/plugins.md](docs/plugins.md) | The Claude Code / Codex plugin: install, `pnpm plugin:link`, and switching from manual registration |
| [docs/mcp-tools.md](docs/mcp-tools.md) | Every MCP tool's purpose, fields, examples, policy behaviour, annotations and prompts |
| [docs/rest-api.md](docs/rest-api.md) | REST endpoints, metadata backfill, report export, backups, project data export / import, deletion and the live update stream |
| [docs/work-record-and-report-format.md](docs/work-record-and-report-format.md) | The five-section Session format, report granularity and backfill limits |
| [docs/architecture.md](docs/architecture.md) | Data contracts, consistency and input boundaries, the recording policy, design principles |
| [docs/testing.md](docs/testing.md) | Test commands, coverage, performance, retrieval-quality and accessibility thresholds, and E2E scope |
| [docs/status.md](docs/status.md) | Current status, open items and deferred work |
| [docs/ui-redesign-plan.md](docs/ui-redesign-plan.md) | Decisions and implementation notes for the Web UI redesign |
| [docs/five-feature-integration-research.md](docs/five-feature-integration-research.md) | Five-feature integration research: UX, algorithms, security and staged acceptance; not implemented |
| [CHANGELOG.md](CHANGELOG.md) | Version history |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development workflow, health checks, PR and work-record rules |
| [SECURITY.md](SECURITY.md) | Threat model, local security boundaries and private vulnerability reporting |

## License

[MIT](LICENSE)

Reports can preview and copy basic Markdown or the current synthesis presentation. The presentation copy keeps pin/hide/edit choices and source references; it checks the source and revision again. Review the snapshot, then click Copy. If clipboard access fails, select the preview text or download Markdown.
