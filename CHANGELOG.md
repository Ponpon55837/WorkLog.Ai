# Changelog

All notable changes to Work Intelligence are documented here. The project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- The Web UI has a GitHub light theme next to the dark one. The header's sun/moon button switches between them, and System status → 個人偏好 offers 跟隨系統／淺色／深色; the default follows the operating system. The saved theme is applied before the first paint (`public/theme-init.js`, CSP-safe), and Mermaid diagrams redraw with the matching theme. Light semantic colours are one step darker than stock Primer so 12px labels meet WCAG AA.
- The Web UI is available in 繁體中文 and English. The header language menu and 個人偏好 switch it without reloading; the first visit follows the browser language. Dates, weekdays and relative times follow the language. Only interface text is translated; Sessions, reports, Knowledge and Agent output keep the language they were recorded in. A unit test fails when a Chinese UI string has no English translation or a translation drops a placeholder.
- Motion and usability: a colour cross-fade when the theme changes, a top progress bar while a page loads or everything refreshes, a "跳至主要內容" skip link, an animated sidebar indicator, a pop when a counter changes, fading banners, and theme/language commands in the `Ctrl`/`⌘` + `K` palette. All of it turns off with `prefers-reduced-motion`.

- Web-created project cleanup requests snapshot pending outstanding items. Agents read bounded evidence pages and submit idempotent recommendations without changing items; people accept or reject individually or in atomic batches. Acceptance checks source/evidence versions and retains linked audit. Schema 23 cleanup data participates in transfer, redaction and permanent deletion.

### Changed

- 第九輪文件對齊相容性分級、未結項整理與 schema 23 升級重連；狀態頁保留使用者實機驗收／tag 待辦，已完成的第八輪階段移入歷史。測試文件更新合成回應基線與審核／刷新回歸覆蓋。

- Task-focused context ranks pending outstanding items by item keywords, source paths and Session relevance, including older direct matches. Finalize can explicitly supersede replaced pending work with actor Session audit, conservatively leaves ambiguous requests unchanged, and returns bounded reminders for related items still open.

- Outstanding items support current-page multi-selection, atomic batches of up to 100 items with per-item audit history, guarded one-click undo to pending, and inclusive source Session date filters preserved in the URL. Existing MCP list parameters remain compatible.

- MCP build compatibility now fingerprints the schema version, actual tools/list, full operation contracts, and instructions. Compatible implementation rebuilds keep reads and writes available; incompatible or unknown builds require reconnecting. System Status separates reconnect-required and update-available process counts. Every MCP mutation checks the actual database schema inside its write transaction to block stale writers after external migrations.

- Page headers are one compact row (inline eyebrow, 16px title, one-line description with the full text on hover, actions on the right) instead of a stacked title block, so lists and data start about 150px higher at desktop widths. Actions wrap to their own row when they would leave the title less than 360px; on phones the eyebrow hides and the description takes its own single line.

### Fixed

- MCP report summary saves and report synthesis retries share the schema guard's write transaction instead of starting a nested SQLite transaction. Failed saves preserve the previous current summary and leave the request available for resubmission.

- Two file-backed MCP integration tests use a bounded 15-second timeout to accommodate Windows coverage overhead while preserving their assertions and the separate performance gates.

- A field label wrapped around a segmented control no longer becomes the accessible name of its first option; `UiField` has a `group` mode for button sets.
- Segmented controls scroll inside their own track on narrow screens instead of widening the page when their labels are long.

- 活躍整理快照阻擋 Agent finalize／nextSteps 編輯直接結案。未結項與整理審核保留已成功寫入的結果，即使背景刷新遭取消；同頁刷新保留有效勾選，取消整理後清空選取。

- Round-eight handoff Session references now match the existing MCP records. The combined E3 and closing record has source-backed conversation timestamps and evidence; missing execution times remain explicitly unverified without duplicate Sessions.

- MCP startup and System Status now remove expired UUID lease files and abandoned temporary files after a 60-second grace beyond the heartbeat TTL. Each pass attempts at most 64 deletions, startup inspects at most 512 entries, and unrelated files, directories, and symlinks are preserved. Cleanup failures do not interrupt monitoring or recording.

- Dashboard lists (最近完成的工作, 專案狀態) no longer stop at a fixed height with empty space below on tall screens: `VirtualList` gained `growToViewport`, which caps the list at the space left to the viewport bottom and falls back to `maxHeight` when the list starts below the fold.
- System Status no longer hashes the whole MCP runtime build twice on every request: the build identity is cached per repository and reused while every runtime file keeps its size, mtime, and inode (about 16 ms to 3 ms per request on a real install).

## [1.0.0] - 2026-09-30

### Added

- A tag-only GitHub Actions release workflow validates the application version and matching changelog section, runs the complete quality and browser checks, then publishes a GitHub Release with ZIP and tar.gz source archives. Pull requests never publish a release.
- A user-run release acceptance checklist documents native folder selection, Windows backup and Agent setup, macOS Safari, private recall evaluation, and a complete run in another project. Every physical check remains unverified until the user records its result.
- Optional user-level login startup on macOS (LaunchAgent), Windows (Task Scheduler), and Linux (`systemd --user`) through `pnpm service:install`, `pnpm service:uninstall`, and `pnpm service:status`. Installation previews the complete config file before confirmation; uninstall preserves the database, backups, and logs. Doctor and System Status report service state without installing or changing it; CI only generates configs in temporary directories and never installs an OS service.
- Knowledge-page maintenance reminders now appear after a source needs review, an update was requested, or three new Sessions have accumulated; context orders those pages by review priority, finalize includes the same one-line hint, and the Pages tab shows the latest checked-through time.
- The dashboard now shows a four-step first-run checklist when no project is tracked or no Session exists. System Status adds read-only Codex and Claude Code MCP registration, skill-copy freshness, hook installation, and A3 reconnect status; malformed or unreadable Codex configuration is shown as unknown and is never modified.
- MCP processes embed a startup build fingerprint and maintain per-process heartbeat leases. `work_get_project_status`, `work_get_context`, `pnpm run doctor`, and the Web system status compare the same installation runtime; stale processes request reconnect, while interrupted or incomplete builds remain explicitly unknown.
- MCP `tools/list` now exposes four safety-classified dispatchers instead of repeating 44 large tool definitions (81,487 to 3,769 UTF-16 code units). A compact operation index maps each id to its dispatcher; each operation’s full schema, description, validation rules, and original annotations are served by its own `work-intelligence://agent/tool-contracts/{operation}` resource template. Dispatch rejects unknown envelope and argument keys instead of silently dropping them, then applies each operation’s original runtime Zod schema. Codex finalization reminders accept the new dispatcher operation and legacy direct tool names; the setup installer upgrades managed legacy matchers, and Doctor flags legacy-only matchers until the user applies the project update.
- `pnpm setup:agents` previews a user-level Codex and Claude Code setup before confirmation, backs up managed settings before installation, and supports safe uninstall; `doctor` detects missing or stale skill copies by content hash, and the MCP serves its complete agent skill and record-format contract through standard resources.
- A synthetic MCP response-size baseline that exercises `work_get_context`, `work_recall`, and `work_search` through the in-memory transport; CI reports and gates serialized character counts without using the user database.
- Task-aware `work_get_context` deduplicates recent and relevant Session/Knowledge content, selects matching Knowledge-page sections, and applies a whole-response character budget with explicit omission pointers and truncation markers.
- Compact `work_recall` and `work_search` results keep ranked source ids and answer-bearing excerpts while avoiding repeated project and Session digest data; full source records remain readable by id.
- Agent `work_recall`, `work_search`, and task-focused context report retrieval confidence; no-evidence searches return empty hits, while weak partial matches are clearly marked.
- Recall expands a fixed in-source software vocabulary across endpoint/API/路由/route, 慣例/convention, 效能/performance, 測試/test, 設定/config, and 遷移/migration. Expansion scores are lower than original-term scores; synonym-only matches stay low-confidence and do not affect original-term `termHits` or high-confidence coverage.
- `pnpm eval:recall <questions.json>` evaluates recall and context questions through the in-memory MCP server. It opens the source SQLite read-only, snapshots it into a private OS temp directory, reports per-mode hit@1/hit@5/MRR, ranks, confidence, MCP payload characters and latency, and refuses output paths that could overwrite the question file, database, hardlinks, or SQLite sidecars. A synthetic CLI smoke checks rank-1 positives, no-hit false positives, missing databases, and protected output paths; evaluator snapshot/fallback tests run in CI. The 5,000-Session snapshot path passed its 1,000 ms p90 gate at 239.84 ms locally.
- Retrieval ranking favors structured Session fields over raw planning text; normalized raw handoff hashes ensure repeated excerpts count once at full weight, with later references downweighted. Schema 20 rebuilds legacy search rows lazily.
- Session diagrams: Agents attach Mermaid diagrams with `work_attach_diagram` or finalize `diagrams` (masked, idempotent, voidable but never deleted, included in export, import, and deletion). The Session panel lazy-loads Mermaid in strict mode and renders into a shadow root with a constructed stylesheet, so the page's Content Security Policy stays unchanged; invalid source is shown as text.
- Jump from records to code: projects accept an https repository URL (no credentials; exported and imported, unsafe values dropped on import) so commit SHAs link to the commit page, and a per-browser editor preference (VS Code or Cursor) adds "open in editor" links to changed files, built only for tracked projects and never outside the project folder. External links use `rel="noopener noreferrer"`.
- Timeline tab on the graph page (`GET /api/insights/timeline`): project lanes with Sessions as bars (or points without a start time), links as arcs, and Knowledge created/confirmed/contradicted/superseded marks; zoomable, drawing only the visible time window, with a date-grouped list view that phones use automatically.
- Graph edges carry provenance: recorded edges are solid, and derived `co_changed` edges (files several Sessions changed together, with the count as the reason) can be turned on and are dashed, with a legend. The node panel explains how two nodes are related step by step (`GET /api/graph/path`, MCP `work_get_graph_path`).
- Hotspots: `GET /api/insights/hotspots` and a Hotspots tab on the graph page list the files or directories most Sessions changed, with failure and not-run counts and the latest Sessions; reports list the period's hotspots with the risks, and `work_get_context` warns when a path you pass was changed often in the last 30 days.
- `work_recall` and `work_search` (and `GET /api/search`) accept `from`/`to` calendar dates, filtered in SQL on each record's date, so "last week" or "in June" questions return only that period.
- Knowledge evidence strength: Session confirmations, contradictions, and manual confirmations are kept in `knowledge_feedback` (backfilled from certain audit rows on upgrade). Knowledge shows how many times it was confirmed and contradicted with the source Sessions, `work_recall` hits carry the counts, and ranking favors well-confirmed Knowledge and lowers Knowledge whose latest feedback is a contradiction.
- Standing Knowledge pages: each tracked project gets Architecture and conventions, In-progress work and open items, and Pitfalls pages (plus custom questions) that an Agent rewrites from recorded Sessions with `work_request_knowledge_page_update`, `work_get_knowledge_page_context`, and `work_save_knowledge_page`. Every section cites its source Sessions or says 資料不足; a new Session marks a page as needing an update, `work_get_context` includes bounded page digests, and the Knowledge page has a Pages tab with sources, version history, manual edits, and update requests.
- Session `nextSteps` now create durable, source-linked outstanding items with pending, completed, and not-needed states plus append-only audit history. Schema migration keeps historical items pending; finalize completes only explicitly named items verified in the same tracked project. Context shows a bounded pending summary, MCP provides a read-only five-item page, and the Web UI supports project/status filters and audited status changes. Items and their events follow project export/import, deletion, and redaction.
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

- The MCP contract resource `work-intelligence://agent/tool-contracts` is now a short operation index (3,954 UTF-16 code units); each operation's complete contract is served by the `work-intelligence://agent/tool-contracts/{operation}` resource template with compact JSON Schema. An Agent that saves a record reads about 18,300 code units (tools/list, index, and the finalize contract) instead of the 109,755-unit full catalog.
- `work_get_knowledge_page_context` has two modes. `full` (an empty page or an explicit update request) gives recent Sessions for a complete rewrite; `review` (a written page) gives only Sessions finished after the page's coverage and cited sources that changed, oldest first. The Session budget dropped from 40,000 to 24,000 characters; on a real project a page review went from about 60,000 to 24,000 characters.
- Finalize accepts `maintainedKnowledgePages`: the Session that saved or checked those pages no longer counts as their new data (`knowledgePagesAcknowledged` in the result). The cursor moves only when no other unreviewed Session came before it.
- All MCP tool results are compact JSON (no indentation). `work_get_context` is capped at 10,000 characters with a task or paths and 16,000 without, measured the same way. Its `omitted` list only counts records already shown in another section (`duplicates`), lists at most 5 budget-omitted ids per section (`ids`, `reasons`, `moreIds`), and keeps full `entries` only for items flagged `possiblyStale` or `needsReview`; relevant items are now dropped only after long excerpts are shortened. On a real project, a task context went from 11,902 to 9,932 characters while its relevant content grew from 3,587 to 7,790 characters.
- Recall confidence is `high` only when a hit matches half the query in structured fields (title, summary, workSummary, Knowledge) or matches a path; a query found only in raw handoff text, such as a test phrase quoted in an old plan, is `low`.
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

- `pnpm setup:agents` only treats an existing MCP entry as equivalent when a Node executable runs this repository's built entry point or pnpm runs `start:mcp` in this repository. Hooks are equivalent only when a Node executable runs the matching reminder script; a command that merely mentions its path (such as `echo <path>`) is preserved as a conflict. Valid hand-written registrations stay unchanged and are not recorded as setup-owned; a legacy Codex PostToolUse matcher is upgraded in place only when its hook actually runs the Node reminder script.
- System Status no longer leaves large gaps between mismatched two-column cards: Agent connections and preferences form the main column and MCP, database, backup, and maintenance details a 340px side column (single column below 1200px). Agent connections are grouped by Codex and Claude Code with each item's location, a summary label, and a copyable `pnpm setup:agents` hint when anything needs setup; the duplicate MCP reconnect row moved into the MCP box.
- A Codex hook installed with the pre-dispatcher PostToolUse matcher is reported as `stale` (需要更新) instead of `missing` (未安裝) in System Status and Doctor, with the setup command as the fix.
- MCP operation calls reject unknown or misspelled argument keys at any nesting level with an `unrecognized_keys` error naming them, instead of silently dropping them (for example `limit` on `work_list_sessions`), matching the advertised `additionalProperties: false`.
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

- Dependency audit found no known vulnerabilities; license review of all 482 resolved lockfile packages found no conflict with the repository's MIT license, including cross-platform optional binaries.
- Local API access checks, restrictive production content security policy, and safe error responses for unsupported database versions.
