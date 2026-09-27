# Changelog

All notable changes to Work Intelligence are documented here. The project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

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
