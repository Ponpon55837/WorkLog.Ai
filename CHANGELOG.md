# Changelog

All notable changes to Work Intelligence are documented here. The project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- A synthetic MCP response-size baseline that exercises `work_get_context`, `work_recall`, and `work_search` through the in-memory transport; CI reports and gates serialized character counts without using the user database.
- Task-aware `work_get_context` deduplicates recent and relevant Session/Knowledge content, selects matching Knowledge-page sections, and applies a whole-response character budget with explicit omission pointers and truncation markers.
- Session diagrams: Agents attach Mermaid diagrams with `work_attach_diagram` or finalize `diagrams` (masked, idempotent, voidable but never deleted, included in export, import, and deletion). The Session panel lazy-loads Mermaid in strict mode and renders into a shadow root with a constructed stylesheet, so the page's Content Security Policy stays unchanged; invalid source is shown as text.
- Jump from records to code: projects accept an https repository URL (no credentials; exported and imported, unsafe values dropped on import) so commit SHAs link to the commit page, and a per-browser editor preference (VS Code or Cursor) adds "open in editor" links to changed files, built only for tracked projects and never outside the project folder. External links use `rel="noopener noreferrer"`.
- Timeline tab on the graph page (`GET /api/insights/timeline`): project lanes with Sessions as bars (or points without a start time), links as arcs, and Knowledge created/confirmed/contradicted/superseded marks; zoomable, drawing only the visible time window, with a date-grouped list view that phones use automatically.
- Graph edges carry provenance: recorded edges are solid, and derived `co_changed` edges (files several Sessions changed together, with the count as the reason) can be turned on and are dashed, with a legend. The node panel explains how two nodes are related step by step (`GET /api/graph/path`, MCP `work_get_graph_path`).
- Hotspots: `GET /api/insights/hotspots` and a Hotspots tab on the graph page list the files or directories most Sessions changed, with failure and not-run counts and the latest Sessions; reports list the period's hotspots with the risks, and `work_get_context` warns when a path you pass was changed often in the last 30 days.
- `work_recall` and `work_search` (and `GET /api/search`) accept `from`/`to` calendar dates, filtered in SQL on each record's date, so "last week" or "in June" questions return only that period.
- Knowledge evidence strength: Session confirmations, contradictions, and manual confirmations are kept in `knowledge_feedback` (backfilled from certain audit rows on upgrade). Knowledge shows how many times it was confirmed and contradicted with the source Sessions, `work_recall` hits carry the counts, and ranking favors well-confirmed Knowledge and lowers Knowledge whose latest feedback is a contradiction.
- Standing Knowledge pages: each tracked project gets Architecture and conventions, In-progress work and open items, and Pitfalls pages (plus custom questions) that an Agent rewrites from recorded Sessions with `work_request_knowledge_page_update`, `work_get_knowledge_page_context`, and `work_save_knowledge_page`. Every section cites its source Sessions or says 資料不足; a new Session marks a page as needing an update, `work_get_context` includes bounded page digests, and the Knowledge page has a Pages tab with sources, version history, manual edits, and update requests.
- `work_get_project_status` and `work_get_context` return the server `clock` (`serverTime`, `timeZone`, `utcOffset`) so Agents stop estimating the current time; finalize and metadata updates return `timestampWarnings` for times that look estimated; the Claude Code save reminder states when the current segment began, read from the transcript.
- Fixed-rule secret masking on Session, Evidence, Knowledge, candidate, report, handoff import, and portable JSON write paths; Session records expose a redaction count, and `pnpm db:redact` provides read-only counts plus backed-up transactional cleanup for existing database content.
- Portable project imports show source and local folder status, can remap projects one at a time without typing the old path, and allow a project root to be reassigned from the project list with a content-free audit record.
- Local-first SQLite work tracking with explicit project opt-in, structured Sessions, handoffs, events, evidence, and Knowledge.
- REST API, stdio MCP server, and Vue web interface for reviewing and managing tracked work.
- Full-text search and ranked Agent recall across Session summaries, raw handoffs, Knowledge, and file paths, plus task-aware context.
- Daily, weekly, monthly, yearly, and custom-range reports with sourced summaries, history, and Markdown export.
- Knowledge candidates, review and staleness signals, Session relationships, and audit history for record changes.
- Database backups and restore, full database export, and portable project data import and export.
- Offline database maintenance with a verified pre-maintenance backup, integrity checks, VACUUM, ANALYZE, and search-index rebuild.
- Production startup that serves the built web app and API from one local port, plus a global web notice for API disconnections.
- Application and schema version details in the API health response, MCP server metadata and instructions, and web sidebar.
- Permanent project deletion from the web UI and REST API, guarded by typing the project name and a verified pre-deletion backup; it removes the project's records, search rows, and cross-project links in one transaction and keeps a content-free audit row. MCP has no deletion tool.
- `pnpm run doctor`, a read-only diagnosis of Node.js, pnpm, build output, database health and schema, backups, maintenance history, API reachability, MCP registration, and global save-reminder hooks.
- User guide, troubleshooting guide, contributing guide, and security policy.
- Quality gates in CI: macOS alongside Ubuntu and Windows, a core Firefox E2E flow, read-path and import performance limits, a synthetic retrieval-quality evaluation (hit@5 and MRR), and axe accessibility checks on the six main pages.

### Changed

- The timeline changes level of detail with zoom: zoomed out, each project lane shows one column per day colored by verification (one scale for all lanes), and clicking a day zooms in centered on that day's Sessions; single Sessions are drawn only once every lane fits in 10 rows, a zoom found by binary search over a few levels. Zoom is continuous (in, out, show the whole period) and the axis switches between month, Monday, day, and hour ticks.
- Motion across the Web UI (reference: beautifului.dev): shared easing and duration tokens, page fade between routes, a sliding tab indicator and fading tab panels, dialogs that pop in, a smoother side panel, menus and the command palette that drop in, toasts that slide, button press feedback, and staggered dashboard cards; `prefers-reduced-motion` turns it all off.
- The pending Agent decision list has proper row padding and existing color tokens; the source Session sits under the decision text and the actions align right.
- Agents now attach Mermaid diagrams on their own when the work changed a cross-module flow, data path, state machine, architecture, or multi-step process (at most two, only what the work did), and skip small fixes, styling, configuration, and test-only work; the finalize contract, tool descriptions, and work-intelligence skill say so.
- Web dialog and form state (Knowledge and candidate editors, void dialog, Session editor, Session link dialog, confirmation, toasts) moved from module-level refs into Pinia stores with `$reset`; the unused `beginRequest`/`isCurrentRequest`/`finishRequest` helpers are gone, and leaving the app now cancels in-flight queries through Pinia Colada (the old abort helper had nothing registered).
- The REST server's route if-chain is split into one route table per domain (`apps/server/src/routes/`), matched through a hash map for literal paths; behavior is unchanged, and a test pins the complete set of routes.
- The Knowledge page is split into Knowledge, Candidates, and Pending decisions tabs (`/knowledge/:tab`), each showing its count; the Knowledge list fills the window instead of sitting below two empty review boxes.
- Lists on the Projects tabs (projects, handoff import, metadata backfill, deletion audit) fill the window height and scroll inside their box.
- Code placement follows a fixed order in every file type (worklog-code-layout skill). `pnpm lint` now rejects a `const`/`let` used before its declaration, out-of-order Vue macros, unused variables in `.vue` files, and `<script setup>` sections out of order (`scripts/sfc-layout.mjs`, with `--fix`).
- 報告「主要完成事項」與 Agent 報告摘要脈絡的顯示上限由 6 筆增加為最新 10 筆；期間工作總數維持完整統計。

- Save-reminder hooks now count only edit paths within tracked projects: Claude reads `file_path` or `notebook_path` from transcript tool input, and Codex parses `apply_patch` file headers relative to the hook working directory.
- File-backed databases are backed up before schema migrations; databases with a newer schema are refused with a clear update message.
- The Codex save-reminder hook is installed globally in `~/.codex/hooks.json`, like MCP; the repository no longer ships a project-level `.codex/hooks.json`.
- Long lists scroll inside their own panel across the web UI, and the date-range controls keep a stable layout.

### Fixed

- The Claude Code save reminder counts a save only when `work_finalize_session` succeeded, so a rejected, conflicting, or skipped save no longer shifts the next segment's start time. The Codex reminder also states when the segment began, using an optional `UserPromptSubmit` hook; `pnpm run doctor` reports whether it is set up.
- Work record times can no longer be silently wrong: `startedAt`, `completedAt`, and event times later than the server clock are rejected with the server time in the message; times with a UTC offset (for example `+08:00`) are accepted and stored as UTC; `work_update_session_metadata` can correct `completedAt` (recorded as a note event) instead of voiding and recreating the Session, and reports a `startedAt` it cannot apply instead of dropping it silently.
- Work history search (`work_search` and the web search box) no longer takes seconds on large databases: the full-text match now drives the join (about 150× faster at 5,000 Sessions).
- Listing Knowledge computes "possibly stale" markers in one pass per project instead of one query per item (about 15× faster).
- Portable JSON exports now include whether a Session's empty changed-file list was confirmed, so the confirmation survives moving to another computer; older export files still import.
- The MCP server now honors `WORK_INTELLIGENCE_BACKUP_DIR` and `WORK_INTELLIGENCE_BACKUP_KEEP` like the API server and CLI, so pre-migration backups land in the same place whichever process opens the database first. A relative backup directory resolves beside the database.
- The web UI no longer reports the API as unreachable when the API itself answers with a JSON 5xx error; only transport failures and non-API gateway errors show the offline notice.
- `pnpm run doctor` recognizes a Claude Code Stop hook written in exec form, with the script path in `args`.
- `pnpm start` and `pnpm start:server` explain an occupied or forbidden port and exit cleanly instead of crashing with a stack trace, and the daily backup check starts only after the server is listening.

### Security

- Local API access checks, restrictive production content security policy, and safe error responses for unsupported database versions.
