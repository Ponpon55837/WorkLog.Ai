# Changelog

All notable changes to Work Intelligence are documented here. The project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

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

- File-backed databases are backed up before schema migrations; databases with a newer schema are refused with a clear update message.
- The Codex save-reminder hook is installed globally in `~/.codex/hooks.json`, like MCP; the repository no longer ships a project-level `.codex/hooks.json`.
- Long lists scroll inside their own panel across the web UI, and the date-range controls keep a stable layout.

### Fixed

- The MCP server now honors `WORK_INTELLIGENCE_BACKUP_DIR` and `WORK_INTELLIGENCE_BACKUP_KEEP` like the API server and CLI, so pre-migration backups land in the same place whichever process opens the database first. A relative backup directory resolves beside the database.
- The web UI no longer reports the API as unreachable when the API itself answers with a JSON 5xx error; only transport failures and non-API gateway errors show the offline notice.
- `pnpm run doctor` recognizes a Claude Code Stop hook written in exec form, with the script path in `args`.
- `pnpm start` and `pnpm start:server` explain an occupied or forbidden port and exit cleanly instead of crashing with a stack trace, and the daily backup check starts only after the server is listening.

### Security

- Local API access checks, restrictive production content security policy, and safe error responses for unsupported database versions.
