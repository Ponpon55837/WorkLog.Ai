# Changelog

All notable changes to Work Intelligence are documented here. The project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Keep cleanup request creation available during background list refreshes after the current project data has loaded; retain first-load and active-request guards.

- Add 12px content padding to Session related-work hints and align titles, dates and shared paths, with wrapping at narrow widths.

- Scale all 53 activity weeks to the available container width on load and resize, with square cells and responsive month labels; retain keyboard navigation and daily report links.

- Keep committed Knowledge creation and decision promotion successful when SSE supersedes a background refresh.

- Fit the timeline to its measured viewport automatically on first load, period/project changes and returning from list view; keep manual zoom during resize. Full-year ranges fit tablet widths.

- Move the dashboard activity heatmap directly below the page header into a full-width section, ahead of stats, weekly insights and attention lists.

- Reminder display preferences support hide, snooze for seven days and restore with source/preference CAS. Unresolved totals stay authoritative, changed sources resurface, and migration 30 includes portable transfer and permanent deletion.

### Added

- Preview and copy basic or current report-presentation Markdown with source gates, revision checks, escaped text and a download/manual-copy fallback. Clipboard success is shown only after a successful write.

- Dashboard weekly insights use full report totals with verification priority and scoped links.

- Report synthesis versions now have independent section pin/hide/restore controls and manual title/detail edits. The original summary and source references stay intact, edits are audited and portable, and concurrent changes keep the draft for an explicit comparison before applying.

- Suggest up to five same-project Sessions sharing confirmed files in Session detail. A covering file-posting index bounds hot-path reads, excludes existing links/voided or unavailable sources and reports partial coverage; suggestions never create links.

- Aggregate eight existing reminder sources in the Overview with project/type filters, URL pagination, bounded scrolling, explicit failed/partial coverage and policy-gated domain links. Knowledge links open the exact source history, and metadata backfill retains its project/request scope. Dashboard week dates come from the server clock; source status is changed only in its owning workflow.

### Documentation

- Add a staged Mermaid removal plan covering native-format write contracts, safe historical-source reading, dependencies, data lifecycle and verification. No runtime or stored diagram is changed.

- Add a five-feature integration study for attention aggregation, related-work suggestions, report section controls, dashboard insights and report copying, with UX wireframes, data/security boundaries, rollout criteria and a synthetic candidate-query probe. These are research specifications; no production feature or API is added.

## [1.4.0] - 2026-10-09

### Added

- Report synthesis versions now have independent section pin/hide/restore controls and manual title/detail edits. The original summary and source references stay intact, edits are audited and portable, and concurrent changes keep the draft for an explicit comparison before applying.

- Session verification adds `in_progress` (進行中), with an audited edit option, Agent schema/contracts, report and dashboard counts, timeline visuals and portable export/import. It stays distinct from passed, failed, not run and historical missing verification; it does not change the finalized-record lifecycle. Report risk classification collects source ids in one pass.

- Session diagrams accept validated architecture JSON v1 alongside Mermaid, with a bounded node/group/edge/path schema, versioned storage migration, portable import/export, structured secret masking and an MCP schema resource. The Web renders architecture snapshots as grouped cards with sources, direct relations and author-defined paths, with zoom/pan and escaped-source fallback.

- A reproducible, opt-in Archify architecture probe compares a pinned upstream renderer with existing Mermaid across production CSP, themes, locales, three browsers and 6/10/100/500-node synthetic diagrams. The findings retain Mermaid and choose validated JSON plus a project-owned viewer for structured architecture diagrams.
- Session diagrams have an expanded reader with a resizable wide panel, zoom buttons, actual size, fit to view, mouse/touch drag to pan and keyboard navigation. The selected diagram is kept in the URL so reload reopens it. Mermaid remains under the existing strict CSP; invalid diagrams retain their source and offer retry.

### Fixed

- Keep dark primary-button hover on the existing AA-safe green fill and strengthen its border. Report-copy axe checks now explicitly hover the copied action to expose contrast regressions.

- Cached synthetic performance databases now rebind their project roots to the current run’s temporary directories; deleted roots from an earlier run no longer cause policy-gated fixture setup to skip. The cache file itself is unchanged.

- Pin Mermaid’s transitive KaTeX to the patched 0.18.2 release for GHSA-238p-pmpm-9mq7 (inherited renderer settings could bypass trust restrictions when another component had already polluted Object.prototype). Keep strict Mermaid security/CSP and test normal math plus rejected untrusted links in an isolated process.

- Mermaid's root-level `htmlLabels: false` now keeps labels in SVG; the diagram-specific setting is deprecated and was ignored by the current renderer, causing excessive spacing in larger flowcharts.

## [1.3.1] - 2026-10-08

### Added

- Report synthesis versions now have independent section pin/hide/restore controls and manual title/detail edits. The original summary and source references stay intact, edits are audited and portable, and concurrent changes keep the draft for an explicit comparison before applying.

- A voided Session can be permanently deleted from the Session panel ("Delete permanently", with a danger confirmation). The server refuses Sessions that are not voided, writes a `pre-session-delete-` snapshot first (kept in its own group of 5 so it never pushes out manual backups), and deletes the Session with its events, Evidence, diagrams, edit history, links and outstanding items in one transaction; Knowledge it produced is kept. Only `DELETE /api/sessions/:id` with `{ "confirm": true }` does this: there is no MCP tool, so Agents still can only void and restore. Migration 26 adds the content-free `session_deletion_audit` and lets an outstanding item's history be deleted together with the item.
- Session titles can be corrected: the Session editor has a Title field, `PATCH /api/sessions/:id/title` and the MCP operation `work_update_session_title` (overwrite dispatcher) rename in place and keep the previous title as a note event. Voided Sessions are skipped. Agents must reconnect to see the new operation.

### Fixed

- Two backups written in the same second after the oldest had been pruned reused the freed file name, so the new copy sorted as the oldest and was pruned at once. The same-second suffix now always goes past the highest existing one.

### Changed

- `pnpm test:e2e` now runs through `scripts/run-e2e.mjs`. On CI a browser project that fails is run once more from the start with a fresh server and SQLite database, because the browser regression suite shares `beforeAll` fixtures and cannot be retried test by test; a pass on the rerun is reported as a "Flaky E2E" warning and the first attempt's traces are still uploaded.

## [1.3.0] - 2026-10-07

### Added

- Report synthesis versions now have independent section pin/hide/restore controls and manual title/detail edits. The original summary and source references stay intact, edits are audited and portable, and concurrent changes keep the draft for an explicit comparison before applying.

- Passive audit of Agent reads: every successful read-only MCP call records which Sessions and Knowledge items it returned (ids and counts only, never query or content; 30 days / 5,000 rows). The system status page lists recent reads, and the Session panel shows when Agents were given that Session. Agents do nothing new.
- A Knowledge page's version history can be compared: "Compare with previous version" shows, for the version being viewed (or the current page), which sections were added, removed or changed since the version before it, with a line diff of each changed section and the source Sessions added or removed. It is a read-only viewing aid built from the versions the Web already loads; no new endpoint.
- The Dashboard has a work-activity calendar (GitHub contribution-calendar style): one cell per day for the past 53 weeks, shaded in five levels by how many Sessions were completed that day in tracked projects (voided Sessions excluded; days are local calendar days in the server time zone). Click, or press Enter or Space on, a day to open that day's report; arrow keys move between days. It is read-only and deterministic, served by the new `GET /api/insights/activity?from=&to=[&projectId=]` (at most 400 days, `{ days: [{ date, sessions }] }` for days with work only), with a `getActivity (year)` read benchmark (p90 limit 250 ms).
- The Session panel can copy the Session as Markdown (title, project, completion time, verification, Git, summary, the five workSummary sections and up to 20 changed files, noted as not a Git commit) for pasting into a PR description, standup message or handoff. It leaves out the Session id, local links, events and raw handoff text.
- Each Session records which Agent client wrote it and, optionally, its model. The MCP server takes the client name from the connection handshake, so Agents supply nothing for it; `work_finalize_session` accepts an optional `agentModel` that Agents may omit when unsure. The Session panel shows the Agent, and the Sessions list can be filtered by Agent (`GET /api/sessions?agent=`, `GET /api/sessions/agents`). Existing Sessions stay unreported, and old export bundles still import.

### Fixed

- Restoring a database on Windows could refuse a different file as "the current database": NTFS file ids are 64-bit and lost precision as plain numbers. The check now compares bigint file ids and the device.
- Report totals, the previous-period comparison, project shares, verification counts and the period summary were computed from at most 200 Sessions per period, so a busy month, quarter or year showed 200 in both periods and a delta of 0. They are now counted in SQL over the whole period; the 200-Session limit applies only to the listed Sessions, trends, risks, decisions and evidence.
- Report Changed Files no longer counts Sessions that list more than 20 files, which usually swept in an unrelated dirty worktree; recall and hotspots already treated them this way. `totals.changedFilesOversizedSessions` reports how many were left out, and the summary, Markdown export and the Web card say so.
- `scripts/sfc-layout.mjs` never ran on Windows (its "run directly" check compared a `file://` URL with a Windows path), so `pnpm lint` passed there without checking the `<script setup>` layout. It now compares with `pathToFileURL`.

## [1.2.1] - 2026-10-02

### Added

- Report synthesis versions now have independent section pin/hide/restore controls and manual title/detail edits. The original summary and source references stay intact, edits are audited and portable, and concurrent changes keep the draft for an explicit comparison before applying.

- The plugin has an icon for its Anthropic directory listing: `plugins/work-intelligence/assets/icon.svg`, the Web UI's favicon, set as `icon` in `.claude-plugin/plugin.json`.

## [1.2.0] - 2026-10-02

### Added

- Report synthesis versions now have independent section pin/hide/restore controls and manual title/detail edits. The original summary and source references stay intact, edits are audited and portable, and concurrent changes keep the draft for an explicit comparison before applying.

- Open the dashboard from the plugin: a `dashboard` skill (`/work-intelligence:dashboard` in Claude Code; ask for it in Codex) and `pnpm dashboard` start the production server from the checkout in the background when it is not running, wait for `/api/health`, print <http://127.0.0.1:3210> and open it. The README now has a full plugin section: marketplace install for Claude Code and Codex, trusting the Codex hooks, the dashboard, updates, switching from manual registration, and the release assets.
- The Codex plugin now carries the save-reminder hooks (`PostToolUse`, `Stop`, `UserPromptSubmit`) in `plugins/work-intelligence/hooks/codex-hooks.json`, rooted at `${PLUGIN_ROOT}`; trust them under `/hooks`. `pnpm run doctor` warns when `~/.codex/hooks.json` still runs the same reminder, and no longer asks for a manual Codex hook when the plugin is enabled.

### Fixed

- `pnpm run doctor` read the required pnpm version only from `packageManager`, so with this repository's `engines.pnpm` (`>=11.16.0`) it always reported "專案要求 未知" and a warning. It now reads `engines.pnpm` too and checks the installed version against the minimum.
- `pnpm build:plugin` failed in the release job, so the v1.1.0 tag produced no GitHub Release: the bundle resolved the workspace packages through their `dist/` folders, which a fresh checkout does not have. It now bundles their TypeScript sources directly, and CI packs the plugin before `pnpm build` to keep it that way.

## [1.1.0] - 2026-10-02

### Added

- Report synthesis versions now have independent section pin/hide/restore controls and manual title/detail edits. The original summary and source references stay intact, edits are audited and portable, and concurrent changes keep the draft for an explicit comparison before applying.

- `pnpm run doctor` recognises the Codex plugin (`[plugins."work-intelligence@…"]` in `config.toml`): it no longer asks for a manual Codex MCP or skill, and warns when the plugin and `[mcp_servers.work-intelligence]` are both present.
- `pnpm build:plugin` packs a self-contained plugin (the MCP server bundled with esbuild) and a Claude Desktop extension (`.mcpb`) into `dist/plugin/`; tagged releases attach both. Without a built checkout, the bundle uses `WORK_INTELLIGENCE_DB`, else the checkout from `WORK_INTELLIGENCE_HOME` or `pnpm plugin:link`, else `~/.work-intelligence/data`. The repository build and `plugins/work-intelligence/` are unchanged.
- A Claude Code and Codex plugin in `plugins/work-intelligence/` with marketplaces at `.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json`. It provides the MCP server, the `work-intelligence` skill and, in Claude Code, the save-reminder Stop hook. A small launcher finds the local checkout (`WORK_INTELLIGENCE_HOME`, the plugin's own repository, or the link written by the new `pnpm plugin:link`) and runs the same `apps/mcp/dist` build, so the database, updates and every existing setup stay unchanged. `pnpm run doctor` accepts the enabled Claude Code plugin in place of manual registration and warns when both are active. See `docs/plugins.md`.
- Pages show a boot splash before the app loads, and every loading skeleton now carries a visible "Loading…" caption. Counts, totals, pagination and empty states wait for the first answer instead of showing `0` or "nothing here" while data is still loading (Work history, Knowledge tabs, candidates, decisions to confirm, backups).

- The Web UI has a GitHub light theme next to the dark one. The header's sun/moon button switches between them, and System status → 個人偏好 offers 跟隨系統／淺色／深色; the default follows the operating system. The saved theme is applied before the first paint (`public/theme-init.js`, CSP-safe), and Mermaid diagrams redraw with the matching theme. Light semantic colours are one step darker than stock Primer so 12px labels meet WCAG AA.
- The Web UI is available in 繁體中文 and English. The header language menu and 個人偏好 switch it without reloading; the first visit follows the browser language. Dates, weekdays and relative times follow the language. Only interface text is translated; Sessions, reports, Knowledge and Agent output keep the language they were recorded in. A unit test fails when a Chinese UI string has no English translation or a translation drops a placeholder.
- Motion and usability: a colour cross-fade when the theme changes, a top progress bar while a page loads or everything refreshes, a "跳至主要內容" skip link, an animated sidebar indicator, a pop when a counter changes, fading banners, and theme/language commands in the `Ctrl`/`⌘` + `K` palette. All of it turns off with `prefers-reduced-motion`.

- Web-created project cleanup requests snapshot pending outstanding items. Agents read bounded evidence pages and submit idempotent recommendations without changing items; people accept or reject individually or in atomic batches. Acceptance checks source/evidence versions and retains linked audit. Schema 23 cleanup data participates in transfer, redaction and permanent deletion.

### Changed

- Interface text now lives in per-locale JSON catalogs, `apps/web/src/i18n/locales/zh-TW.json` and `en-US.json`, under semantic keys such as `common.refresh`; the code and the tests no longer contain interface copy. `t()` accepts only known keys, so a missing or mistyped key fails type checking, and tests fail when the catalogs drift apart or Chinese copy is hard-coded in the web source or in browser specs. A few English-only labels (the Local-first badge, the policy-gate note, Default deny) are now translated too.

- English translations moved from `apps/web/src/i18n/en.ts` to the JSON catalog `apps/web/src/i18n/locales/en-US.json`, and the English locale is now `en-US` (a saved `en` preference upgrades automatically).
- The light theme uses cool grey surfaces (about 87% luminance) instead of pure white to reduce glare, with darker text colours that keep WCAG AA contrast.
- `README.md` is now in English, with the Traditional Chinese version in `README.zh-TW.md`; both link to each other.

- 第九輪文件對齊相容性分級、未結項整理與 schema 23 升級重連；狀態頁保留使用者實機驗收／tag 待辦，已完成的第八輪階段移入歷史。測試文件更新合成回應基線與審核／刷新回歸覆蓋。

- Task-focused context ranks pending outstanding items by item keywords, source paths and Session relevance, including older direct matches. Finalize can explicitly supersede replaced pending work with actor Session audit, conservatively leaves ambiguous requests unchanged, and returns bounded reminders for related items still open.

- Outstanding items support current-page multi-selection, atomic batches of up to 100 items with per-item audit history, guarded one-click undo to pending, and inclusive source Session date filters preserved in the URL. Existing MCP list parameters remain compatible.

- MCP build compatibility now fingerprints the schema version, actual tools/list, full operation contracts, and instructions. Compatible implementation rebuilds keep reads and writes available; incompatible or unknown builds require reconnecting. System Status separates reconnect-required and update-available process counts. Every MCP mutation checks the actual database schema inside its write transaction to block stale writers after external migrations.

- Page headers are one compact row (inline eyebrow, 16px title, one-line description with the full text on hover, actions on the right) instead of a stacked title block, so lists and data start about 150px higher at desktop widths. Actions wrap to their own row when they would leave the title less than 360px; on phones the eyebrow hides and the description takes its own single line.

### Fixed

- The Codex plugin failed to start its MCP server: Codex runs plugins inside its unbuilt clone of the marketplace repository, and the launcher stopped at that clone instead of the checkout linked by `pnpm plugin:link`. The launcher now uses the first built checkout, and `codex.mcp.json` sets `"cwd": "."` so Codex starts the server in the plugin directory.

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

- Report synthesis versions now have independent section pin/hide/restore controls and manual title/detail edits. The original summary and source references stay intact, edits are audited and portable, and concurrent changes keep the draft for an explicit comparison before applying.

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

- Interface text now lives in per-locale JSON catalogs, `apps/web/src/i18n/locales/zh-TW.json` and `en-US.json`, under semantic keys such as `common.refresh`; the code and the tests no longer contain interface copy. `t()` accepts only known keys, so a missing or mistyped key fails type checking, and tests fail when the catalogs drift apart or Chinese copy is hard-coded in the web source or in browser specs. A few English-only labels (the Local-first badge, the policy-gate note, Default deny) are now translated too.

- English translations moved from `apps/web/src/i18n/en.ts` to the JSON catalog `apps/web/src/i18n/locales/en-US.json`, and the English locale is now `en-US` (a saved `en` preference upgrades automatically).
- The light theme uses cool grey surfaces (about 87% luminance) instead of pure white to reduce glare, with darker text colours that keep WCAG AA contrast.
- `README.md` is now in English, with the Traditional Chinese version in `README.zh-TW.md`; both link to each other.

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
