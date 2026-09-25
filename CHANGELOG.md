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
- Production startup that serves the built web app and API from one local port, plus a global web notice for API disconnections.
- Application and schema version details in the API health response, MCP server metadata and instructions, and web sidebar.

### Changed

- File-backed databases are backed up before schema migrations; databases with a newer schema are refused with a clear update message.

### Security

- Local API access checks, restrictive production content security policy, and safe error responses for unsupported database versions.
