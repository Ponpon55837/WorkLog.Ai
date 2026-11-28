# Changelog

All notable changes to Work Intelligence are documented here. The project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `work_get_knowledge_page_context` accepts `sessionsSeenIn`, the `reviewToken` of an earlier full or review read. When an Agent maintains several pages, the new Sessions that read already showed come back as `{ id, title, reasons, previewSeen: true }` stubs instead of repeating their previews. Stubs count against the same 12,000-character Session budget, a Session changed after the token was issued or that is also a changed source keeps its preview, and a full read, a token from another project, or a malformed token never stubs (a malformed or foreign one adds a warning). The `reviewToken` from a read that shows new Sessions also records the shown range and issue time; tokens without them still save as before.

## [1.6.97] - 2026-11-28

[繁體中文更新說明](docs/releases/1.6.97.md).

### Changed

- 系統狀態 now shows 個人偏好 (appearance, language, editor) at the top of the main column instead of below the service paths and MCP registration, with an `#preferences` anchor. The header keeps its theme button and language menu.
- Session search highlights the matched words in the row title and summary with `<mark>` (plain text, never HTML), reading the query like the server (quoted phrases stay whole, case is ignored, at most 8 words of 200 characters; the project name is not searched, so it is not highlighted). A row whose match is not in the shown text gets one line with the first match in the fields the list has, such as 「摘要：…前文 詞 後文…」, 「成果」, 「決策」 or 「變更檔案」, or 「符合工作事件」 when only a work event has it. The query parser now lives in `@work-intelligence/core` and is shared by the server and the web app. The placeholder reads 「搜尋標題、摘要或事件」. The default page size is 20, and the 「顯示 0–0，共 0 筆」 footer is hidden when nothing matches.
- On a phone the Session detail keeps its label column beside the values, shows the 完成時間 with 「耗時」 on a muted line of its own and moves the start and last-updated times into a 「開始與最後更新」 disclosure. 「執行狀態」 shows 「已完成」 instead of the raw `completed`. The `J`/`K` keyboard hint is hidden on touch devices (`(hover: none) and (pointer: coarse)`).
- 關係圖 starts on the project chosen last, else the tracked project with the newest Session, when the URL has no `project`; 「全部專案」 is chosen with `project=all`, which also survives a reload and is remembered after leaving the page. A `project` in the URL wins and loads at once. If the project list or overview fails to load, a notice with 「重試」 shows and the graph loads without a default. Node limits, preview size and 「推導的關係」 moved into a 「顯示設定」 disclosure.
- A project whose folder is not on this computer shows a neutral 「不在這台電腦」, with one note above the list that reading is unaffected, instead of a red 「找不到資料夾」 on every row. A folder that cannot be checked keeps its own 「無法確認資料夾」 in the attention color. 「重新指定位置」 stays for opening files in an editor.
- On a phone, Session search excerpts start close to the match and may use two lines, so the marked word stays visible. The Session detail labels its verification row 「驗證」. The Sessions list, the Knowledge list and the 知識頁 list let the page scroll instead of a small scroll area inside the box on phone widths, like Open items.
- Tab bars fade the edge in the direction where more tabs are hidden, and scrolling keeps the focused edge tab clear of the fade.

### Added

- `/projects/backups` and `/projects/deletions` redirect to `/projects/backup` and `/projects/deletion-audit` (query and hash kept) instead of falling back to the project list.

## [1.6.96] - 2026-11-28

[繁體中文更新說明](docs/releases/1.6.96.md).

### Changed

- The 資料備份 tab now opens with a short guide to which export to use: 「匯出專案資料」/「匯入專案資料」 (JSON) for a new computer or merging two computers, 「匯出整份資料」 (.sqlite) for whole-machine recovery. Export and import are separate boxes, and the .sqlite restore steps are collapsed under 「進階：用指令還原」.
- The import box uses a 「選擇檔案」 button with a hidden file input instead of the browser's native control, shows the chosen file name, and the page scrolls to the import preview and focuses it once the file is checked.
- The import preview describes each count in one line (新增, 將更新, 保留本機, 略過, 衝突) and no longer shows a per-type sub-line that did not add up. A 「各類型明細」 list covers every record type the preview reports. 「確認並匯入」 is a normal-width button, and when nothing would be written the preview says 「沒有需要匯入的變更」 with a 「完成」 button instead of an import button.
- The import preview response carries `writesData`, the server's answer to whether applying it would write anything; the web app uses it to decide between 「確認並匯入」, a conflicts-only message and 「沒有需要匯入的變更」. The count captions say 保留本機版本 and 目前設定下不會寫入 for kept and conflicting records.
- The import result stays in the import box instead of a toast. A file that is not a `.json` file is refused before it is uploaded, for the picker and for drops alike.

### Added

- The import box accepts a dropped `.json` file (same 256 MiB limit as the picker) with a visible drop state; keyboard users use 「選擇檔案」.
- After an import finishes, the result offers 「前往專案清單」.

## [1.6.95] - 2026-11-27

[繁體中文更新說明](docs/releases/1.6.95.md).

### Changed

- The Knowledge page side panel splits a section at line breaks into paragraphs and `-`, `*`, `•` or `1.` lists (plain text nodes, no HTML rendering) with a line length of about 72 characters. Old pages whose paragraph breaks survive only as a sentence end followed by a space are split there too, and a still-long paragraph is cut into chunks at sentence ends (never inside brackets, versions or paths). Each section's sources move into a collapsible 「來源（N）」 list that shows the first 3 Sessions one per line, with a toggle for the rest.
- The 知識頁 tab groups pages by project (two or more projects, no project filter; same-named projects get their folder added to the label), so same-named pages from different projects are told apart; the project name leaves the meta line and the separators between meta items are drawn with consistent spacing. A written page's title now opens it, like 「查看」.
- 「自訂知識頁」 is enabled whenever a project is tracked. When no project is selected and several are tracked, the dialog asks which project to create the page in.
- Knowledge rows show only the title, kind, a one-line summary and one meta line by default, so more rows fit on a screen. 「展開詳情」 (keyboard accessible, `aria-expanded`) reveals the full text, tags, references and applies-to paths.

## [1.6.94] - 2026-11-27

[繁體中文更新說明](docs/releases/1.6.94.md).

### Added

- 待確認決策 can be selected (a select-all row with the same rules as Open items, toolbar only while something is selected) and handled with 「確認所選」 or 「拒絕所選」. The API has no batch decision endpoint, so the web app calls the single review endpoint with at most four requests in flight and refreshes once. The review endpoint overwrites whatever status a decision has, so the web app checks the loaded list instead: once a reject question is answered, decisions that are no longer listed as pending (or, for a batch, no longer selected) and decisions whose project is not tracked are skipped and counted in the toast; a failure keeps the unapplied decisions selected. The list now shows up to 200 decisions instead of 50.
- The 工作知識 sidebar entry shows the pending decisions plus candidates count across all projects.

### Changed

- 待確認決策 rows put 「確認」 first as the only primary button, 「拒絕」 as a default button, and 「整理成 Knowledge」 in a 「更多」 menu. Focus moves to the next row after an action.
- A human review of a decision cannot be reset to pending (only an Agent review can be overturned), so there is no 「復原」: 「確認」 applies at once, and 「拒絕」, single or batch, asks first. This also applies to 「拒絕」 in the overview's 「需要處理」.
- 「整理成 Knowledge」 opens with the content filled from the decision, an empty title with a placeholder and the hint to write a searchable conclusion, no preset tag, and the cursor in the content.
- Opening 工作知識 without a tab shows 待確認決策 while any wait for review, and Knowledge otherwise. The tab is the `/knowledge/:tab?` route parameter, so Knowledge is now `/knowledge/list`; a bare `/knowledge` keeps its URL and shows a loading state until the tab is decided (Knowledge if the count cannot be read), and an older link such as `/knowledge?q=…` or `?knowledge=<id>` is redirected to `/knowledge/list` with its query.

## [1.6.93] - 2026-11-27

[繁體中文更新說明](docs/releases/1.6.93.md).

### Added

- Toasts can carry an action button; changes to Open items now take effect immediately and the toast offers 「復原」 for 8 seconds, for one item and for a batch. Undo uses the existing status endpoints with the status the change set as `expectedStatus`, so an item changed elsewhere meanwhile is not overwritten.
- 「選取全部 N 筆」 selects every pending Open item matching the filters across pages; changes are sent in batches of at most 100.
- An 「未結項」 entry in the sidebar (shortcut `g o`) with the pending count, and the tab shows the same count on first load; the Work history count stays the Session total.
- 「整理未結項」 no longer needs a project filter: the panel lists the projects with pending items and their counts, and shows the only one directly. The counts load only once the project list is known, a project whose count fails shows no number instead of failing the panel, and at most four are read at a time.
- A batch that hits items changed elsewhere skips them instead of failing: a rejected chunk is retried once without the ids the API names, the rest carries on, and the toast says how many were updated and skipped (「N / M」 when a chunk fails for another reason, with the unapplied items still selected). Undo takes the same path.
- Toasts pause their countdown while hovered or focused, and toasts with an action are capped separately so plain toasts never evict a pending 「復原」.

### Changed

- The cleanup panel's 「Agent 已結案」 list follows the same rules as the main list: compact rows (verdict and reason on the meta line), icon actions named after the item at the end of the row, and the bulk bar only while something is selected. 「選擇其他專案」 only appears for a project the panel chose, so it no longer clears a project filter set before the panel opened, and the intro text has the usual space above the create button.
- Single-row changes send the row's current status as `expectedStatus` (through the batch endpoint, which already checks it). Reopening offers 「復原」 only when the item was closed by the user, because undoing it would record the user as the closer. After an action removes a row, focus moves to the next row's first action (or the list); selecting everything also drops items that are visible and no longer pending.
- Icon-only row buttons are named after their item, truncated text has a `title`, and 「選取本頁」 is a real label for its checkbox. The sidebar and tab counts also refresh after a project's status change or deletion.
- Open item rows are compact (content clamped to two lines and one meta line, actions at the end as icon buttons; a right-aligned second line on narrow screens) and show the status only when the filter is not 「待處理」. The batch toolbar appears only while something is selected.
- On narrow screens the Open items list scrolls with the page instead of in a fixed 280px box.

### Removed

- The confirmation dialogs for 「不再需要」 and batch 「不再需要」, and 「復原本次批次」.

## [1.6.92] - 2026-11-27

[繁體中文更新說明](docs/releases/1.6.92.md).

### Added

- `AgentHandoffNotice`: one handoff block for every Agent flow (status, one sentence on what happens next, a copyable command that names Work Intelligence, and cancel where the flow supports it). Agent review, Knowledge pages, Knowledge candidates, Open items cleanup, metadata backfill and the report card all use it; toasts now only say the request was created.
- Agent review no longer needs a project filter: with none chosen it lists the projects that have pending items (count and button each), shows the only one directly, and lists every in-progress request with its own cancel. New `GET /api/agent-review-pending` returns the per-project counts.
- The 「整理候選」 menu has a title and each project's pending count.
- `UiButton` takes `disabledReason`, shown as a tooltip and to assistive tech.
- The Agent review block shows a Flash with 「重試」 when the pending counts or the open requests fail to load, and each start button shows it is working while the request is created.

### Changed

- Disabled buttons use a neutral grey look instead of a dimmed accent.
- Knowledge page rows that already have an update request show 「已要求」 (disabled, with the reason) instead of staying clickable; there is no route to cancel a page update request.
- 「自訂知識頁」 uses the only tracked project when no project filter is chosen.
- Open items cleanup finds the open request on its own instead of only on the current page of requests.

## [1.6.91] - 2026-11-27

[繁體中文更新說明](docs/releases/1.6.91.md).

### Changed

- `work_submit_outstanding_cleanup_proposals` accepts a verdict for an item that was examined without one earlier in the same request. It is rechecked for eligibility, staleness and evidence like a first verdict. An item that already has a verdict, or an examined item resubmitted without a verdict, is still rejected as `already_examined`; replays of either submission return their own examined items. Once every item is examined the request completes and a verdict is rejected as `request_closed` with a hint to open a new request. Export/import keeps such later verdicts.
- `work_get_outstanding_cleanup_context` accepts `projectRoot` instead of `requestId` (exactly one) and reads the project's latest open cleanup request; `no_open_request` reports that none is open.

### Added

- The finalize receipt's `relatedOutstandingItems` lists pending items of the same project (not created by this Session) that share an issue reference with one of its stored `nextSteps` first, marked `possibleDuplicateOf` (the index of that nextStep). Ranges such as `#483–#490` cover a referenced number. The hint points to `supersededOutstandingItemIds` in finalize or `work_resolve_outstanding_items`.

## [1.6.90] - 2026-11-27

[繁體中文更新說明](docs/releases/1.6.90.md).

### Added

- Web filters show their applied value on the menu trigger (accent color; on a phone the icon with a dot) and list headers show each applied filter as a removable chip (`UiFilterChips`) next to 「清除篩選」 on Sessions, Knowledge, Open items and Knowledge pages. The Sessions and Knowledge tab counts read "shown / total" while a filter narrows the list; Knowledge reads the unfiltered total with one extra `pageSize=1` request while filtered.
- Dashboard 「需要處理」 pages 10 rows at a time, groups same-type items of one project into an expandable row (first 3; not when filtered by both project and kind, and a group states a count only when the whole result fits on the page), confirms or rejects pending decisions inline, marks decisions of a project with an open Agent request as 「等待 Agent」 (a per-project estimate, not per item), and moves above the stat cards when items exist. The 待處理 stat card scrolls to and focuses it. 「前往處理」 on a decision adds `decision=<id>` to the Knowledge decisions URL, which scrolls to and highlights it.

### Changed

- The Dashboard cap warning is one line with a link to 工作知識 and no 「重試」; 「未結項入口」 is now 「N 筆未結項」, and its list no longer scrolls inside the box. A partial-coverage notice links to the page of the partial source.
- Graph, Reports, metadata backfill and Agent reads use the shared project filter menu.

## [1.6.89] - 2026-11-27

[繁體中文更新說明](docs/releases/1.6.89.md).

### Changed

- Outstanding cleanup verdicts (#482) apply directly, like Agent review. `work_submit_outstanding_cleanup_proposals` changes each item to `completed` or `not_needed` at submission and writes an `outstanding_item_events` row with `source: agent` that links the cleanup request and proposal. Eligibility of every item, source and evidence version is still rechecked in one transaction, so one stale or ineligible verdict rejects the whole submission without writes. The tool names, bookkeeping, reasons and 1-10 evidence Session IDs stay. `POST /api/outstanding-cleanup/requests/:requestId/decisions` and the accept or reject step in the Web are removed; the cleanup panel shows "Agent 已結案" with each reason, evidence and verdict, and the user reopens items one by one or in a batch through the existing batch status route.
- Schema 43 adds `outstanding_cleanup_proposals.kind` and recreates `trg_outstanding_cleanup_event_scope` (cleanup events must be a `pending` to verdict transition by `web` or `agent` for an accepted proposal of the same request, project, item and status). Proposals still pending are marked `rejected` (`decided_at` stays empty, so an acceptance made on another machine still wins on import) and their items stay pending; requests that were `awaiting_review` become `completed`. Importing an older file applies the same normalization, so a 1.6.87 export with an open review no longer leaves a stuck request. An audit event whose proposal is not accepted locally becomes an import conflict instead of aborting the import. Exports carry `kind`; older exports import with `resolution`. The cleanup events no longer record a Session actor (`actor_session_id` is empty); the request and proposal IDs identify the source.
- Tighter `nextSteps` wording in the work record contract and the work-intelligence skill: scope exclusions, unverified-platform notes and decisions left to the user are facts for `outcomes` or `verification`. `nextStepsWarnings` flags them with the new categories `scope_exclusion`, `unverified_platform` and `deferred_to_user` (warn-only).

### Added

- Cleanup verdict `acknowledged` (記錄為已知限制) for an item that is no task: it needs a reason and no evidence Session, is stored as `not_needed` and is told apart by `kind: acknowledged`.
- `work_resolve_outstanding_items` lets a Session close its own pending items it finished later (the resolved list only; superseding still needs an earlier source).
- The finalize receipt's `relatedOutstandingItems` lists pending items that share an issue reference (`#N`) or version (`x.y.z`) with the Session's title, summary or outcomes first, marked `possiblyDone: true`, as a hint to check them.
- The attention kind `cleanup` (review reminders for cleanup requests) is removed, since no request waits for review anymore. Old exports that carry such preferences still import; those rows are dropped.
- Items a Session closed itself with `work_resolve_outstanding_items` report `closedBy: later_session`, so the Web filter that hides items dropped from nextSteps no longer hides them. Reopening in the cleanup panel sends `expectedStatus`, so an item changed in another tab is not overwritten.

## [1.6.88] - 2026-11-27

[繁體中文更新說明](docs/releases/1.6.88.md).

### Added

- `POST /api/knowledge/candidate-requests/:requestId/cancel` and a 「停止」 button on open candidate requests in the Web stop a pending, processing or failed request (and with it the automatic chain); its Sessions are no longer covered. Cancelling needs no migration or export change (`cancelled` is an existing status). The row and header buttons are disabled while a request is in flight.

### Changed

- The Knowledge candidates tab no longer sums every uncovered Session across projects. It lists, per project, the high-value Sessions (score at least 1) that no request covers yet, each row with its own organize button, and shows nothing when no project has any. The number is what organizing that project clears. The Web store exposes a per-project `candidateBacklog` array, and `list` backlog entries omit projects without high-value Sessions.
- `work_request_knowledge_candidates` selects only high-value Sessions while the project has any, so low-score Sessions are no longer pulled in by the top-10 cut. When none are left, an explicit request still takes the top 10 so small projects can be organized. The not-needed reason now says no Session is left uncovered.
- `work_submit_knowledge_candidates` continues the work: when the project still has high-value uncovered Sessions and no other open request, the same transaction opens the next pending request and the result carries `next: { requestId, sourceSessions, remaining }` (an empty submission continues too; a replay returns the request that is still open and creates none). The Agent contract, the `work_request_knowledge_candidates` description (it said "newest first" although selection is by score), `docs/mcp-tools.md` and the Knowledge guide of the Work Intelligence skill describe it. No migration; exports and imports are unchanged.
- The Knowledge candidate context lists candidates still `proposed` from earlier batches of the project in `existingKnowledge` (`status: "proposed"`, at most 30 titles), so later batches do not repeat them.

## [1.6.87] - 2026-11-27

[繁體中文更新說明](docs/releases/1.6.87.md).

### Fixed

- Knowledge pages no longer show a cited Session as `source_updated_after_save` when it was only linked from a later Session (`parentSessionId`, `relatedSessionIds`, `work_link_sessions`) or got evidence or a diagram void or restore. Schema 42 adds `sessions.content_updated_at`, which only content changes (title, summary, work summary, files, verification, commit, branch, times, void or restore) advance, and the upgrade clears flags that came from a link, evidence or diagram touch. Exports carry the column and older exports still import. The attention fingerprints for Knowledge pages and Sessions missing metadata use it too, so a link no longer resurfaces a hidden or snoozed item.
- After the upgrade, hidden or snoozed attention items may resurface once, because the backfill changes some source fingerprints.
- Importing an export made before this column existed leaves it empty, so those Sessions fall back to `updated_at` until they are edited again.
- Importing a project file after the other machine rewrote a Session's decisions no longer skips them as `unique` conflicts. A Session's decisions are one set that follows the decisions in its summary, so when the file's decisions match that summary and this machine's do not, the outdated local decisions are replaced (Knowledge and Agent review requests that cite them are kept). A file that is the stale side is kept out of the database instead of being reported as conflicts. The import preview (Web and CLI) and its audit report how many local decisions were replaced, and a backup is taken first. Importing again heals a stale machine; nothing is repaired on upgrade.
- An import no longer rejects an outstanding-item audit event whose acting Session was permanently deleted. When that Session is in neither the file nor this database, the event is imported as it is; an acting Session from another project, or one that is itself a conflict, is still rejected.

## [1.6.86] - 2026-11-27

[繁體中文更新說明](docs/releases/1.6.86.md).

### Added

- Project conventions (#451): in the Web the user can mark up to 5 active Knowledge items per project, without a needs-review flag, as conventions (`PUT /api/knowledge/:id/convention`). Schema 41 adds `knowledge.convention_confirmed_at` and `convention_withdrawal_json`. Marking does not change `updatedAt`. There is no MCP write path.
- `work_get_context` with a `projectRoot` returns them as `conventions: { readWith, items: [{ id, title }] }` (titles at most 60 characters, the block at most 700). The context is fitted to its usual budget as if there were no conventions, then the block is added and convention ids are removed from `recentKnowledge`, `relevant.supplements` and their omission pointers, so the block never displaces other content; with conventions the response may reach 10,700 / 16,700 characters. The key is omitted when there are none.
- Archiving, superseding, a contradiction or needs-review report, an Agent edit of the title or body (MCP or Agent review), or a newer imported copy that is archived, needs review or changes the title or body withdraws the flag with its reason; the user has to confirm it again. An Agent action that withdraws one returns a warning asking the Agent to tell the user.
- Exports carry both columns. An import keeps this machine's choice for existing rows, and new rows keep the flag only within the limit; the import preview (Web and CLI) reports how many are not kept.

## [1.6.85] - 2026-11-27

[繁體中文更新說明](docs/releases/1.6.85.md).

### Added

- `work_save_knowledge_page` accepts `checkedThroughSessionId` with a section update (`upsertSections` and `reviewToken`) and advances the page's checked cursor in the same transaction, with the same rules as `work_mark_knowledge_page_checked`. Without it, the receipt says coverage did not advance. A retry under the same `idempotencyKey` that adds the field still advances the cursor.

### Changed

- A section citing more than 20 `sourceSessionIds` is saved with the newest 20 instead of being refused; the receipt lists the rest in `droppedSourceSessionIds` with a warning. In-progress Sessions are dropped first. The Web editor keeps its 20-source limit.
- `version_conflict` from `work_save_knowledge_page` carries a fresh `reviewToken` and `changedHeadings`, so the Agent can reapply only its edits. `invalid_review_token` is unchanged.
- The MCP result of `work_mark_knowledge_page_checked` is a compact receipt (slug, version, status, new Session count and coverage) instead of the whole page.
- In-progress start records (`verification.status: "in_progress"`) no longer count as new Sessions for Knowledge pages or attention, and cannot be a checked cursor. They count once completed.
- The Work Intelligence skill asks the Agent to send `changedFileChanges` with finalize when each file's status is known.

## [1.6.84] - 2026-11-27

[繁體中文更新說明](docs/releases/1.6.84.md).

### Fixed

- Choosing a project on the Work knowledge page no longer narrows its project menus to that project. The menus took their options from the Knowledge list response, which returns only the scoped project; they now use the projects store.
- MCP and REST input errors for a union field (for example a `workSummary.decisions` item) name the failing nested field and its allowed values instead of only "Invalid input". Nested REST field errors carry the same path prefix MCP already used.
- Importing a file (CLI `import` or an App upload) now skips a `session_links` row whose Session pair and relation already exist under another ID. The 1.6.83 fix only covered an already-parsed bundle; reading a file moves `relation` out of the planner row, so the comparison never matched.

### Changed

- Every project menu on Web uses one shared component (`ProjectFilterMenu`, or `useProjectOptions` for native selects) that lists every project from the projects store whatever is selected. Menus that list every project say "All projects"; menus that list tracked projects say "All tracked projects".

### Internal

- `apps/web`, `apps/mcp`, `scripts` and `tests` follow the comment rule (worklog-code-layout §8), which finishes the cleanup for the whole repository; only comments changed, and every touched file prints the same with comments stripped.

## [1.6.83] - 2026-11-27

[繁體中文更新說明](docs/releases/1.6.83.md).

### Fixed

- Completing a start record (`verification.status: "in_progress"`) with the same `idempotencyKey` after an MCP restart keeps the start record's `startedAt` and its start-source event instead of taking the new process's server observation. An explicit `startedAt` still wins. The receipt omits `startedAtSource` when the stored start is kept.
- Rewriting a start record keeps its Session links' IDs and `created_at` instead of recreating them, and an import skips a `session_links` row whose Session pair and relation already exist under another ID instead of reporting a unique conflict. A different relation still conflicts.

### Internal

- `packages/storage`, `apps/server`, `apps/desktop`, `packages/agent-setup` and `packages/schema` follow the comment rule (worklog-code-layout §8); only comments changed, and every touched file prints the same with comments stripped.

## [1.6.82] - 2026-11-27

[繁體中文更新說明](docs/releases/1.6.82.md).

### Added

- The Agent review request box on Web shows a Knowledge pages step for the latest completed request: each affected page with its current state (Updated, Checked, Still pending, Unchanged), a count of pages updated or checked, and a link that opens the page in the Knowledge pages tab. The step is hidden while a newer request is open.
- `GET /api/agent-review-requests` returns `knowledgePages` (`slug`, `title`, `reasons`, `state`) on completed requests. The states are computed on read in a constant number of queries.
- The create-request copy says that after the review the Agent goes on to update the affected Knowledge pages.

### Changed

- A request's Knowledge page list is stored when it completes (schema 40, `agent_review_requests.completion_pages_json`), so updating a queued page no longer drops it from the list. Completed requests from before schema 40 fall back to the computed list. The column is exported and imported. MCP results and contracts are unchanged.

### Internal

- One comment rule for every file type (worklog-code-layout §8): no comment by default, a short why only where removing it would likely get the code broken. `packages/core`, `packages/shared` and `packages/desktop-core` were cleaned to it; only comments changed, and every touched file prints the same with comments stripped.

## [1.6.81] - 2026-11-27

[繁體中文更新說明](docs/releases/1.6.81.md).

### Changed

- The Work knowledge tabs follow the processing order: Decisions to confirm, Candidates, Knowledge, Knowledge pages. Opening Work knowledge still shows Knowledge.
- Every Web prompt that tells the user what to say to the Agent now names Work Intelligence ("use Work Intelligence to handle the Agent review request", "… to organize Knowledge candidates", "… to update the Knowledge pages", and the outstanding cleanup copy), so an Agent without context maps it to this tool.
- The server instructions add one sentence that maps those requests to their guides (agent-review, knowledge, outstanding-cleanup). The skill description names Agent review requests, Knowledge candidates and Knowledge page updates, and its Claude and plugin copies match the canonical description again.

Schema stays 39. Reconnect the MCP after upgrading so Agents read the new instructions.

## [1.6.80] - 2026-11-27

[繁體中文更新說明](docs/releases/1.6.80.md).

### Changed

- A `work_finalize_session` with `verification.status: "in_progress"` is a start record. Finalizing again with the same `idempotencyKey` completes that Session in place (summary, workSummary, changed files, verification, Git, completion time, events, decisions and outstanding items), and records the verification change in its history. A completed Session is never downgraded: a late retry of the start payload still returns `idempotency_conflict`. A start record may omit `workSummary.nextSteps` and creates no outstanding items.
- While verification is `in_progress`, Agent receipts and structured content omit `executionStatus` (stored as `completed`, which read as finished) and add a one-line hint on how to complete the record. REST, Web and export are unchanged.

### Fixed

- An `in_progress` finalize no longer resets the server-observed segment, so the completing finalize keeps the observed start time and HEAD for `startedAt` and Git change observation.
- `work_update_session_metadata` with `completedAtNow` now ends the observed segment of that Session's project. The next work's observed start no longer predates the previous work's completion.

Schema stays 39. Reconnect the MCP after upgrading so Agents read the new finalize contract.

## [1.6.79] - 2026-11-27

[繁體中文更新說明](docs/releases/1.6.79.md).

### Fixed

- The finalize receipt's `unreportedKnowledge` no longer mixes the reads of concurrent works that one Agent client runs over separate MCP connections. Reads are now attributed to the MCP server process that served them, and the work window starts at that connection's previous save instead of the client's previous save in the project. With two concurrent works A and B, A lists only A's reads and B only B's, whichever finalizes first. REST and callers without a connection id keep the previous attribution.

### Changed

- Schema 39 (migration `agent-read-audit-connection-id`) adds a nullable `connection_id` to `agent_read_audit`. The audit stays local, outside the portable export; rows written before the upgrade have no connection and are never counted for a connection.

Known limits: Claude Desktop may serve several chats over one MCP connection, so reads of those chats still share one connection. Reads made before the launcher swaps the MCP child for a new build are not counted (under-listing, by design). Reconnecting the MCP is not required.

## [1.6.78] - 2026-11-26

[繁體中文更新說明](docs/releases/1.6.78.md).

### Changed

- What an Agent must read before it can finalize a Session went from 42,244 to 30,099 characters (−29%): server instructions 1,934 → 1,801, `tools/list` 4,476 → 4,356, core skill 13,918 → 8,871, operation index 4,774 → 3,414, `work_get_context` contract 4,803 → 2,782, `work_finalize_session` contract 12,339 → 8,875. Rules the server enforces or the receipt reports are no longer restated in the reading; the budget tests now hold each part to its measured size plus about 10%.
- The finalize receipt says what to do next instead of leaving it to the skill: `outstandingItemWarnings.reasons` names the failed rule for each id (`not_found`, `other_project`, `not_pending`, `source_voided`, `held_by_cleanup`, `not_earlier`, `both_lists`, `no_next_steps`), `privateTagWarnings` lists fields with an unclosed `<private>` tag, `knowledgeToReviewHint` says how to handle each listed Knowledge, and timestamp warnings name `work_update_session_metadata` as the fix.
- A call sent to the wrong dispatcher is told which dispatcher serves the operation. A validation error names the nested key (`scope: …` under `workSummary`) instead of repeating the same message once per missing key.
- The server instructions name what must wait for `work_get_context` in a project (git commands, directory listings, searches, file reads) and say to stop when the project is not tracked.

### Fixed

- `work_finalize_session` rejects four self-contradicting requests with `outcome: "rejected"` and writes nothing: an outstanding item both resolved and superseded, superseded items without `nextSteps`, a Knowledge item both applied and contradicted, and a supplied `startedAt` after a supplied `completedAt`. Unknown or other-project ids stay warnings. REST returns the same result.
- A Knowledge page save checks the `reviewToken` coverage point: it must be empty, the page's saved coverage, or a non-voided Session of the project at that completion time; anything else returns `invalid_review_token` and writes nothing. A save with a token never moves the reviewed point back, and a full save without a token no longer marks unread Sessions as covered. Web edits keep covering everything up to the edit. Clients that return the token unchanged are not affected.

### Verification

- A/B on a fictional project with the same Agent prompt on 1.6.77 and 1.6.78, three runs per cell (`docs/experiments/reading-budget-ab/`). Recording quality and safety criteria: A1 finalize 3/3 on both; A3 secrets 3/3 on both; A4 outstanding items and Knowledge feedback 10 of 11 criteria on both (neither attaches a diagram); A5 Knowledge page conflict 3/3 on both, reading 65,277 → 49,065 characters on average; A6 without resource reads 3/3 on 1.6.78. Untracked-project runs (A2 and two A6 variants) failed the "inspect nothing first" criteria on 1.6.77 and with the earlier wording (0 of 11), and pass with the new instruction sentence (5 of 5).

Schema stays 38. Reconnect the MCP after upgrading so Agents read the new instructions and contracts.

## [1.6.77] - 2026-11-26

[繁體中文更新說明](docs/releases/1.6.77.md).

### Changed

- After an Agent review request is created, the Web says what to tell the Agent next: both the confirmation message and the request box now read "Say “handle the Agent review request” in Claude Code or Codex", like the Knowledge page and candidate requests.
- On the Usage page, the controls box fills the side column down to the bottom of the screen when it sits beside the results; the project list takes the height the range, the advanced folders and the scan button leave. In the stacked layout it keeps its bounded list.
- Usage cards in one row have the same height: the stat cards and the 5-hour block end on the same line, and so do the daily trend and the token composition.

No database, REST or MCP change: the schema stays 38 and connected Agents do not need to reconnect.

## [1.6.76] - 2026-11-26

[繁體中文更新說明](docs/releases/1.6.76.md).

### Added

- Agent review of active Knowledge in doubt. An Agent review request now also snapshots active Knowledge that is `possiblyStale` or contradicted (needs review), using the same rule as the attention queue; `broadChangesSince` alone does not count, and Knowledge that was only never confirmed for a long time is not included. Knowledge shares the 500-item cap with decisions and candidates, and the request reports `knowledgeCount`. Each context item carries the content, `appliesTo`, why it is in doubt (`doubt`), `createdAt`, `lastConfirmedAt`, and up to 5 later focused Sessions that touched its paths (title, completion time, up to 5 matching paths), with `laterSessionsOmitted`. Items keep their normal field limits; the later Sessions and the existing Knowledge titles use only what is left of the 24,000-character page.
- Three Knowledge verdicts in `work_submit_agent_review_verdicts`, each with a reason: `confirm` (the existing confirmation), `archive` (the existing archive path) and `supersede` (a new Knowledge record with `supersedesId` through the existing write path, which archives the old one; `knowledge` carries the rewritten title and body, other fields default to the old record's). A refused Knowledge write (for example a redaction or validation refusal) returns `knowledge_rejected` with its reason and leaves the item pending, so it can be resubmitted under a new `idempotencyKey`. An item changed since the snapshot is skipped as before.
- `GET /api/agent-review-knowledge` lists the Knowledge whose latest Agent verdict still stands (newest first, at most 200), and `POST /api/knowledge/:knowledgeId/overturn` overturns it: a confirmation is withdrawn (the earlier confirmation time, confirming Session and review mark come back), an archive is restored, and a supersede is reverted (the Agent's new Knowledge is archived and the old one is active again). Knowledge edited after the verdict is left as it is (`unchanged`).
- On the Web Knowledge tab, the Knowledge list header switches between all Knowledge and "Processed by Agent", which lists each verdict, its reason and an overturn button, in zh-TW and English. The Agent review request box (create the request, progress and results) sits in the side column on the Knowledge, candidates and decisions tabs, so each list stays on the first screen.
- Database schema 38 (migration `agent-review-knowledge-items`) widens the item and verdict checks of `agent_review_request_items` to accept `knowledge`, `archive` and `supersede`. No table or column is added, so export, import, permanent deletion and search are unchanged. The migration runs automatically with a backup on upgrade; exports from schema 31–37 still import.
- An upgrade fixture for schema 37 (`tests/fixtures/upgrade/schema-37.sqlite`, generated from the 1.6.75 build).

### Changed

- The Agent review contract, the three Agent review tool descriptions and the agent-review guide in both skill copies state the Knowledge rules: read the current code or the later work records before judging, leave the item pending when the evidence is not enough, and never archive only because related files changed. The Agent still acts only on a request the user created. The fixed Agent reading goes from 42,249 to 42,244 of 42,250. The MCP contract text changed, so the MCP compatibility id changes: connected Agents receive `restartRequired` after upgrading and must reconnect the Work Intelligence MCP.
- The "Ask Agent to review" button no longer turns off when no decision or candidate is pending, because the Web cannot tell whether Knowledge needs review; a request with nothing to review shows the server's "nothing to review" message.

### Fixed

- A Session that finished before a contradiction no longer clears it when it reports the Knowledge as applied afterwards. The applied feedback is still recorded, but the needs-review mark stays unless the applying Session finished at or after the contradiction, so the Knowledge is not dropped from the attention queue or from Agent review.
- The reverse order holds too: a Session that finished before the last confirmation (or before a newer contradiction) no longer puts the Knowledge back in doubt by reporting it as contradicted afterwards. The record follows the newest evidence by completion time, the same rule search ranking uses; on a tie the confirmation stands.
- Overturning an Agent confirmation withdraws only that confirmation. A later confirmation by a person or a Session stands (the result is `unchanged`), also when it happened in the same millisecond, and a contradiction reported after the Agent's confirmation is kept.
- A Knowledge verdict is skipped as `skipped_stale` when another focused Session touched the Knowledge's `appliesTo` after the request was created, because the Agent has not read that evidence. Sessions that touch nothing it applies to do not affect the verdict.
- The Agent review context hint names the real submit operation, `work_submit_agent_review_verdicts`.

## [1.6.75] - 2026-11-26

[繁體中文更新說明](docs/releases/1.6.75.md).

### Added

- Deleting a custom Knowledge page from the Web UI. The Knowledge page panel shows "Delete page" on custom pages only. Its danger confirmation names how many history versions go with the page. `DELETE /api/knowledge-pages/:id` with `{ "confirm": true }` removes the page and every version in one transaction. The update request, which is stored on the page row, goes with it, and the `attention_page_deleted` trigger removes the page's attention preferences. The answer reports `deletedCounts` (`knowledgePageVersions`, `attentionPreferences`). The three default pages (`architecture`, `in-progress`, `pitfalls`) are refused with 409 `knowledge_page_default`; a missing page gets 404 `knowledge_page_not_found`; a project that is not tracked gets 200 `skipped`. The request is JSON-only and passes the usual Origin and Host checks. There is no MCP tool, so Agents can only suggest a deletion. The same slug can be requested again later as a new, empty page.
- Database schema 37 (migration `knowledge-page-deletion-audit`): the content-free `knowledge_page_deletion_audit` table keeps only the time, page id, project id and counts. It is not exported and outlives project deletion. A merge or newer-wins import uses it so an older export does not add a deleted page back: the page and its attention preferences are reported as `deleted` conflicts (its versions as `dependency`), in the preview, in the Web backup section and in `pnpm db:import --dry-run`, and none of them is written. A page created later under the same slug has a new id and imports as usual. The migration runs automatically with a backup on upgrade; exports from schema 31–36 still import.
- `emptyPageHint` in `work_get_knowledge_page_context`. Reading a custom page whose sections are all 資料不足 (or that has none) adds one sentence asking the Agent to tell the user the page can be deleted in the Web UI. Default pages, pages with a pending update request and pages with content get no hint.
- `versionCount` in `GET /api/knowledge-pages/:id/versions`: the number of all versions, not only the 50 listed.
- An upgrade fixture for schema 36 (`tests/fixtures/upgrade/schema-36.sqlite`, generated from the 1.6.70 build).

### Changed

- Cleanup before splitting a page. `splitWith`, the `page_limit_exceeded` reason, the Knowledge page contract, the `work_get_knowledge_page_context` and `work_save_knowledge_page` descriptions, the knowledge guide in both skill copies and the Web limit notice (zh-TW and en) now give the same order: first remove what no longer answers the page question (finished items, facts later work overturned); only if the page still does not fit, ask the user to move sections to a custom page. Text that is still true is still never shortened or merged to make room. Limits are unchanged. To stay within the guide budget, the knowledge guide drops a repeated `version_conflict` clause and shortens one example. The fixed Agent reading is unchanged at 42,249 of 42,250. The MCP contract text changed, so the MCP compatibility id changes: connected Agents receive `restartRequired` after upgrading and must reconnect the Work Intelligence MCP.

## [1.6.74] - 2026-11-26

[繁體中文更新說明](docs/releases/1.6.74.md).

### Added

- `unreportedKnowledge` in the finalize receipt: up to 3 active Knowledge records (each with only `id` and a title of at most 80 characters, newest read first, plus `total` when more were found) that recall reads returned during this work and that the Session has not reported as applied or contradicted, with a one-sentence `hint`. A read counts only when it came from `work_get_context`, `work_recall`, `work_search` or `work_search_knowledge` with Knowledge content (a `view: "compact"` list is never audited as a Knowledge read), in the same project, from the same MCP client, between the Session's `startedAt` and its completion, and after that client's previous save in the project. Knowledge reported in this request or earlier by this Session, and Knowledge already in `knowledgeToReview`, is left out. Backfills (`completedAt` in the request), Sessions without `startedAt` and saves without a known client get no list. It is one query over the existing read-audit indexes, run after the transaction commits; a failure only omits the field, and nothing is ever blocked.
- `knowledgeFeedback: { applied, contradicted }` in the finalize receipt when the request reported Knowledge: how many of the requested ids this Session now records for each kind.
- `work_update_session_metadata` (and `PATCH /api/sessions/:id/metadata`) accepts `appliedKnowledgeIds` and `contradictedKnowledgeIds`, so Knowledge can be reported after the save. An id this Session already reported the same way is not written again, so repeating the request changes no Knowledge, audit or feedback row; the answer adds `knowledgeFeedback` and `knowledgeWarnings`. `work_apply_metadata_backfill` does not take these fields.
- A performance case for the lookup: 5,000 read audits of 50 Knowledge records each by one client inside the work window (p90 limit 250 ms).

### Changed

- The core skill, the repair-and-backfill guide, the finalize closing contract, the `work_update_session_metadata` description and `docs/mcp-tools.md` describe the list and the late report. Two clauses of the core skill that the contracts already state were shortened to keep the fixed Agent reading within its budget. The MCP contract text changed, so the MCP compatibility id changes: connected Agents receive `restartRequired` after upgrading and must reconnect the Work Intelligence MCP.

## [1.6.73] - 2026-11-25

[繁體中文更新說明](docs/releases/1.6.73.md).

### Added

- Matching-project hints for an unregistered project root. When any MCP operation is refused because its `projectRoot` is not a registered project (a moved folder, another computer, a mistyped path, or a call from a subfolder), the answer adds `matchingProjects`: at most 5 tracked or paused projects, each with only `name`, `rootPath` and `status`, and its `reason` asks the Agent to check with the user. A project matches only when the path is inside its root (nearest root first), when the path's folder name equals the root's folder name or the project name, or when its root is inside the path (shallowest first); case and a trailing separator are ignored, and ties are ordered by name and root. Ignored projects and `unregistered` rows are never listed. No project data is read, nothing is recorded for the unregistered path, and the Agent is never switched to a match. Without a match the answer is unchanged.
- A compact view for `work_search_knowledge`: `view: "compact"` keeps the filters, order, `pageInfo` and the fallback fields, but each item has only `id`, `kind`, `status`, `title`, `updatedAt`, `appliesToCount` (when `appliesTo` is not empty) and `needsReview`, plus `projectId`/`projectName` in an unscoped search. The answer adds `view` and `readFull`, which points to `work_get_knowledge_history` for a full record. The query reads only those columns and counts `appliesTo` in SQL, so bodies are never loaded. A page of 50 synthetic records with about 1,400-character bodies is 10,872 characters instead of 87,220. Without `view` (or with `view: "full"`) the answer is unchanged; REST does not take the parameter.
- Performance cases for both read paths: `searchKnowledgeCompactForAgent` over 200 records with 30 appliesTo entries of 1,000 characters (p90 limit 250 ms) and `matchingProjects` for an unregistered subfolder (50 ms).

### Changed

- The core skill, the reading-records guide, the `work_get_project_status`, `work_get_context` and `work_search_knowledge` descriptions and `docs/mcp-tools.md` describe the hint and the compact view. Two sentences of the `work_get_context` description that the core skill already states were removed to keep the fixed Agent reading within its budget. The MCP contract text changed, so the MCP compatibility id changes: connected Agents receive `restartRequired` after upgrading and must reconnect the Work Intelligence MCP.

## [1.6.72] - 2026-11-25

[繁體中文更新說明](docs/releases/1.6.72.md).

### Added

- Split suggestions for Knowledge pages near their limits. When a page has 11 or more of its 12 sections, or 7,200 or more of its 8,000 characters of section content (90%, about one average section left), every `work_get_knowledge_page_context` read (full, focused with `query` or `headings`, and `reviewOnly`) and every `work_save_knowledge_page` result (whole-page saves, section-update receipts and replays) adds `size` (`sectionCount`, `maxSections`, `contentChars`, `maxContentChars`) and `splitSuggestion`: `near` (`sections` and/or `content`), `headings` (the largest sections to move to a custom page, largest first, at most 3 and never every section) and `splitWith` (a one-line pointer to `work_request_knowledge_page_update`). A review-only read already had `size` and only gains `splitSuggestion`. Below the thresholds none of these fields is added, so responses keep their size.
- The Knowledge page view and the page editor show the current usage and the suggested sections when a page is near its limits, in Traditional Chinese and English.

### Changed

- `page_limit_exceeded` says to move sections to a custom page instead of sending shorter sections, and carries `splitSuggestion` for the merged page. The input errors for a whole page over 12 sections or 8,000 characters say the same. The limits are unchanged, and the server never splits a page itself.
- The limits and the near-limit rule are defined once in `@work-intelligence/core` (`knowledgePageLimits`) and shared by storage, the input schema, MCP and the Web.
- The Knowledge page contract, the `work_get_knowledge_page_context` and `work_save_knowledge_page` descriptions and the Knowledge guide describe the suggestion: ask the user, create the custom page, save the sections there and remove them from the original page, never trim existing text to make room. The MCP contract text changed, so the MCP compatibility id changes: connected Agents receive `restartRequired` after upgrading and must reconnect the Work Intelligence MCP.

## [1.6.71] - 2026-11-25

[繁體中文更新說明](docs/releases/1.6.71.md).

### Added

- Review-only reads for `work_get_knowledge_page_context`: pass `reviewOnly: true` to get only the sections that need another look, so an Agent maintaining a page with section updates no longer reads the whole page and every new Session. A section needs review when a Session it cites changed since the save (the existing `reviewSections`) or when a new Session maps to it: the new Session continues or relates to a Session the section cites (a Session link in either direction), or changed a file one of them changed. A link weighs 2 and a shared file 1, split evenly across the sections the evidence points at; evidence pointing at more than 3 sections (a changelog or package.json every section's Sessions touched) does not count. Each new Session maps to at most its 3 highest-scoring sections; one with only weak evidence is listed as unmapped. A new Session the page already cites does not map to its own section. Text is not compared, so the mapping is repeatable, and it takes two queries.
- The review-only response: `review` (`sections`, `new_sessions`, `none`, `full_rewrite` for an empty or requested page, or `use_full_read`), `page` state, `sections` in full with `reasons` (source reason codes plus `new_session_linked` and `new_session_shared_files`), `changedSources` and `newSessionIds`, `otherSections` (heading and length), `size` (`sectionCount`, `maxSections`, `contentChars`, `maxContentChars`), `sessions` (previews of the Sessions behind those sections, each once, within the 12,000-character Session budget), `unmappedSessions` (new Sessions that map to no section, by id, title and completion time, within 3,000 characters), `checkedThroughCandidate` (the newest new Session accounted for, with every earlier one, for `work_mark_knowledge_page_checked`), `truncated` and a `reviewToken` that keeps the page's coverage, as a focused read does. With nothing to review the answer is small and says `review: "none"`.
- A review-only read never costs more than the full read: when more than half the page's sections, or more than 4,000 characters of section content, need review, or the answer would not be smaller than the `review` read, it returns `review: "use_full_read"` with no sections or Sessions.
- `reviewOnly` with `query` or `headings` is rejected as invalid input.

### Changed

- The `review` mode of `work_get_knowledge_page_context` lists a Session that is both new and a changed cited source once, among the new Sessions, with `reasons: ["new", "source_changed"]`; it used to appear twice and used up the Session budget twice. Context Sessions now carry `reasons` (an array) instead of `reason`. Coverage still ends at the last new Session shown.
- Changed cited sources are only previewed when they still belong to the page's project.
- The Knowledge page contract, the `work_get_knowledge_page_context` description and the Knowledge guide describe the review-only read. The MCP contract text changed, so the MCP compatibility id changes: connected Agents receive `restartRequired` after upgrading and must reconnect the Work Intelligence MCP.

## [1.6.70] - 2026-11-25

[繁體中文更新說明](docs/releases/1.6.70.md).

### Added

- Agent review requests. The user opens one for a tracked project on the Knowledge page or asks their Agent (`work_request_agent_review`). The request snapshots the pending Agent-autonomous decisions and the proposed Knowledge candidates. An Agent reads them with `work_get_agent_review_context` and applies verdicts directly with `work_submit_agent_review_verdicts`, each with a required reason: decisions are confirmed, rejected or promoted to Knowledge; candidates are accepted (with optional edits) or rejected. Items without evidence stay pending. Items changed or reviewed since the snapshot are skipped and never overwritten. A project has one open request at a time, the snapshot holds at most 500 items and the Web app shows how many were left out, a request that stays in processing for over 30 minutes becomes failed and can be resumed, and the user can cancel it on the Web app.
- Attribution: decisions and candidates record who reviewed them (user or Agent), the reason, the request and the time. Rows reviewed before this version read as reviewed by the user.
- Web app: the decision and candidate lists can filter to items handled by an Agent and show the reason. The user can overturn an Agent verdict: the item returns to the user's queue, and Knowledge created by that verdict is archived if it is still active (left unchanged if already archived or deleted). Overturned items are never picked up by a later request.
- After a request completes, its result lists the Knowledge pages that received new material. The Agent updates them through the existing page flow (section update); the server never rewrites pages.
- REST: `POST /api/agent-review-requests`, `GET /api/agent-review-requests`, `POST /api/agent-review-requests/:requestId/cancel`, `POST /api/session-decisions/:decisionId/overturn`, `POST /api/knowledge/candidates/:candidateId/overturn`, `GET /api/session-decisions?status=agent_reviewed` and `GET /api/knowledge/candidates?reviewedBy=agent`.
- MCP: the operations `work_request_agent_review`, `work_get_agent_review_context` and `work_submit_agent_review_verdicts`, and the on-demand guide `references/agent-review.md` in the work-intelligence skill.
- A schema 35 upgrade sample (from 1.6.64) for the upgrade tests.

### Changed

- Database schema 36: new tables for review requests, their items and submissions, and review attribution columns on decisions and candidates. The migration runs automatically with a backup on upgrade. Project export and import carry the new data and still import exports from schema 31–35.
- Cleanup of outstanding items stays human-approved, and how candidates are proposed is unchanged.
- The MCP contract text and tool list changed, so the MCP compatibility id changes: connected Agents receive `restartRequired` after upgrading and must reconnect the Work Intelligence MCP to see the new operations.

## [1.6.69] - 2026-11-25

[繁體中文更新說明](docs/releases/1.6.69.md).

### Added

- Section updates for `work_save_knowledge_page`: pass `upsertSections` (1–12 sections) and/or `removeHeadings` (1–12 headings) instead of `sections`, always with `reviewToken`; the two forms are mutually exclusive. A section with the same heading (trimmed, case-insensitive) is replaced in place, otherwise appended; the other sections stay as stored. The 12-section and 8,000-character limits are checked on the merged page. New outcomes `section_not_found` (`reason`, `headings`) and `page_limit_exceeded` (`reason`, `sectionCount`, `maxSections`, `contentChars`, `maxContentChars`) write nothing; a stale token still returns `version_conflict`, and idempotency works as for a full save.
- The MCP answer to a section update is a compact receipt: `outcome`, `duplicate`, `page` (`slug`, `version`, `status`, `newSessionCount`, plus `needsReview` and `updateRequestedAt` when set), `sectionChanges` (`replaced`, `added`, `removed`) and `redactions` when masked. Full saves and every other result are unchanged.
- Focused reads of `work_get_knowledge_page_context` (`query` or `headings`) now return `reviewToken`. It keeps the page's existing coverage, so saving with it never marks unshown Sessions as covered.

### Changed

- A section update does not advance Session coverage, does not move the review cursor and does not clear the user's update request; a full save or `work_mark_knowledge_page_checked` advances them. Replaced and added sections lose `needsReview`; untouched sections keep it.
- The Knowledge page contract, the `work_save_knowledge_page` and `work_get_knowledge_page_context` descriptions and the Knowledge guide describe section updates and keep the whole-page rewrite for full and review maintenance. The MCP contract text changed, so the MCP compatibility id changes: connected Agents receive `restartRequired` after upgrading and must reconnect the Work Intelligence MCP.

### Known limitations

- Importing a 1.6.69 export into an older App ignores the per-section baseline stored in `knowledge_pages.sections_json`, so pages updated section by section may lose some needs-review flags there.

No schema change: the database stays at schema 35 and project exports keep the 1.6.64 format; `knowledge_pages.sections_json` may carry an internal per-section baseline (version rows never do).

## [1.6.68] - 2026-11-25

[繁體中文更新說明](docs/releases/1.6.68.md).

### Added

- `nextStepsWarnings` on the results of `work_finalize_session`, `work_update_session_work_summary`, `POST /api/work/finalize` and `PATCH /api/sessions/:id/work-summary`: `{ items: [{ index, category }], message }`, present only when a stored `nextSteps` item reads like in-task transient state. The categories are `uncommitted`, `not_pushed`, `pending_merge` (a PR awaiting merge or not merged back to a branch, including the 未合回, 未合入 and 併入 main forms), `ci_running` and `phase_not_started`. The check is keyword matching that needs Git, PR or CI context, so it can misfire. It only warns: the server never drops, rewrites or rejects an item. It is absent on idempotent replays, and for work-summary updates it runs only when the request supplied `nextSteps`. The item text is not echoed. The patterns use only bounded windows: a strict pass, then, only when the item has Git context, a second pass for bare state words (at most three linear scans per item), so the cost is linear in the text length, and a test feeds adversarial input.

### Changed

- The work record contract and step 4 of the work-intelligence skill now list the same in-task examples (uncommitted, not pushed, PR awaiting merge or not merged back, CI running, phase not started) and mention `nextStepsWarnings`. The `nextSteps` row of the format doc states the exclusion.
- The MCP contract text changed, so the MCP compatibility id changes: connected Agents receive `restartRequired` after upgrading and must reconnect the Work Intelligence MCP.
- The repair-and-backfill guide says to backfill the observed commit and branch with `work_update_session_metadata` after a later commit, merge or push, and never to guess.
- The Knowledge page contract and the Knowledge guide state that Git is the source of truth for branch, commit, PR and merge state: pages do not record it, and the Agent checks Git live. The Knowledge guide also says facts already in Knowledge are not copied into the Agent's own memory files, only a pointer.
- The default question of the "進行中的工作與未結項" (`in-progress`) Knowledge page is now "目前有哪些尚未完成或尚未驗證的事項與已知限制？" and no longer asks about in-progress work, which is branch state. The slug and title are unchanged. Pages saved earlier keep their stored question, because a default applies only when a page is first requested; the question can be changed when requesting an update.
- The Usage page was redesigned. The project, range and Scan controls sit in a sticky left column once the page is wide enough, and only the results scroll. A headline card with a daily sparkline and four compact cards sit next to the 5-hour block card, which shows time progress and start and end times, never a quota. There are no inner scroll areas: tables turn into cards in a narrow results column, and the model table shows an input/output bar and the share of the total. A fix stops the document from scrolling past the page body through visually hidden table headers.

### Tests

- The desktop smoke test waits for the removal's commit log line before it walks the home folder. The removal deletes the install's backups before it logs the commit, so walking early could list a backup and fail to stat it (ENOENT on the v1.6.67 Windows release run).

No schema change: the database stays at schema 35 and project exports keep the 1.6.64 format.

## [1.6.67] - 2026-11-23

[繁體中文更新說明](docs/releases/1.6.67.md).

### Changed

- The Usage page, `pnpm usage:report` and "Copy for Agent" no longer show an estimated cost. The 1.6.66 cost split applied assumed price multipliers that ignored the model, so cache reads decided most of the number. The headline is now input + output (uncached input plus output). Cache read and cache write are listed separately and never added to it, with a cache read share (cache read ÷ all input-side tokens; the logs record no per-request hit, so it is not a hit rate). Conversations are ranked by input + output.
- The Usage page was redesigned: stat tiles with K/M/B numbers, a two-row token composition (counted tokens and cache, each on its own scale), a daily stacked bar of input and output, and ranked tables with inline bars. Every chart has a table with the same numbers, and the page works in both themes and on narrow screens.
- API and `--json` (breaking for the 1.6.66 fields): `costShares`, `costMultipliers` and the sessions' `estimatedCostUnits` are removed. `tokens` gains `primary` and `cacheReadShare`, sessions carry `primary`, and `models`, `daily` and `blocks` are new. The usage cache format changed, so the first scan after the update reads every log file again.

### Added

- Model breakdown: tokens by Agent and model. Claude Code reads the model of each response, Codex the model announced at each turn. A model name is kept only when it looks like a model id; a path-like value or a placeholder such as `<synthetic>` is stored as empty and shown as "Unlabelled model".
- Current 5-hour block per Agent, with the ccusage `blocks` rules: the block starts at its first usage floored to the local hour and lasts 5 hours, and a 5-hour gap starts a new one. It shows input + output, elapsed time, time left in the block and input + output per minute. It appears only when the range reaches the present.
- Usage for monorepos: when a Claude Code folder (worktree folders included) or a Codex session working directory is a parent folder of tracked project roots, it is a shared source of those projects. The projects form a group on the Usage page with a "Select whole group" button, and each conversation of the shared source is counted once and allocated, for matching only, by (1) the most frequent `projectRoot` of its Work Intelligence calls, else (2) the directories of the files Claude's Read/Edit/Write/MultiEdit/NotebookEdit calls named, else (3) the working directory of its lines (Codex: session_meta and turn_context). Bases 2 and 3 need more than half of the hits under the group's projects and at least 3. The rest is a per-group "shared (unallocated)" bucket. Scanning some projects of a group counts only the conversations allocated to them; the unallocated bucket counts when the whole group is selected. The API adds `groups` to `GET /api/usage/projects` and `allocation` to the scan response (project ids, conversation counts, tokens and counts by basis `projectRoot` / `filePaths` / `cwd`, no paths), and `--json` and "Copy for Agent" carry the same. The usage cache format changed (version 3: shared-source files keep normalised `projectRoot` values, file directories and working directories, in the local owner-only cache file only), so the first scan after upgrading rereads the logs.

### Tests

- The packaged tests' check for processes left by an ended browser now confirms a parent by its process id and start time. On Windows a reused process id could make it count system processes, such as `winlogon.exe` and `dwm.exe`, as the browser's.

No schema change: the database stays at schema 35 and project exports keep the 1.6.64 format.

## [1.6.66] - 2026-11-23

[繁體中文更新說明](docs/releases/1.6.66.md).

### Added

- The Web dashboard has a "Usage" page next to System status, for the App's Dashboard and for `pnpm bootstrap` installs. It reads the local Claude Code and Codex logs of the tracked projects you choose (worktree folders included; Codex rollouts by their recorded working directory, which is compared and never shown) and shows turns, tool calls, the Work Intelligence share, tokens by kind, an estimated cost split, Work Intelligence calls per operation, the conversations with the highest estimated cost and the other top tools. "Copy for Agent" previews and copies a summary with totals, project names and conversation numbers only. Parsing runs in a background worker with a 60-second limit and cancellation, and an incremental cache reuses unchanged log files and reads only the appended part of a grown one. The same report is available as `pnpm usage:report` (`--project`, `--all`, `--since`, `--until`, `--json`, `--for-agent`).
- `scripts/agent-usage-report.mjs` now counts Work Intelligence calls per operation (`work_read` → `work_get_context`, …) with their result characters. It reads only the `operation` field of the call input. The parser moved to `@work-intelligence/shared/agent-usage`; the script keeps its options and output.

### Tests

- The desktop smoke test now starts the App over the committed schema 34 (1.6.63) and schema 31 upgrade samples, as an App upgrade finds them. It checks that the App shows "Needs update" with a single main button, then that one press leaves the backend running at the latest schema, with exactly one pre-migration backup and the same row counts. The packaged smoke step in CI has a 20-minute limit and stops itself at 17 minutes. Its output and the App logs are written to files as it runs, uploaded even when the step fails, and the last lines go in the job summary. The packaged tests' process cleanup no longer ends the processes that started the test, such as the CI step's shell or the runner, or anything created before the run. On Windows a reused process id could make it do that.

No schema change: the database stays at schema 35 and project exports keep the 1.6.64 format.

## [1.6.65] - 2026-11-23

[繁體中文更新說明](docs/releases/1.6.65.md).

### Added

- The desktop App's Settings tab has a new "Language" card at the top, with a "Display language" choice: "Follow system (<language>)" (the default), "繁體中文" and "English". A system language starting with zh reads as 繁體中文, anything else as English. The App window, the tray menu, the macOS application menu and the App's dialogs switch at once, with no restart.
- The Dashboard the App manages uses the same language. It switches to the App's language when it opens or refreshes its status, and changing the language in the Dashboard changes the App's setting too. If the App is on "Follow system" and you pick in the Dashboard the language the system already reads as, the App stays on "Follow system". A standalone server keeps the Dashboard's language in the browser, as before.
- The choice is kept in its own small file next to the App's settings, not in the settings file, so an older App version ignores it. "Follow system" removes the file. A damaged file reads as "Follow system" and never stops the App from starting.

### Changed

- The Work Intelligence skill's Knowledge page guide has a short "Page maintenance steps" list: keep the `review` read when checking a page and request an update (`full`) only for a complete rewrite, read a `truncated` context again until no `new` Sessions are left, and mark the page checked when nothing changes instead of saving the same sections. An A/B run on the synthetic fixture kept these three steps and dropped the others; results are in `docs/experiments/retrieval-baseline/ab-report.md` and the decision in `docs/decisions/2026-11-agent-guidance-ab.md`.

### Fixed

- After a desktop App upgrade, the App's own database no longer ends at a dead "Unsupported version" status. A database that only needs a schema update now shows "Needs update" (`SCHEMA_MIGRATION_BLOCKED`), and the Status and Data tabs offer one main button, "Back up and update database". "Retry start" becomes a secondary button meanwhile. A database made by a newer App still shows "Unsupported version" (`SCHEMA_TOO_NEW`).
- When the database is on storage that must not be updated in place (a cloud sync folder, a removable disk, or a hard link), the in-place button is not offered. "Copy to a local folder and update" copies it to the default data folder after confirmation, updates the copy and switches to it; the original file is not changed.
- New repair IPC channel `repair:approve-migration` previews the file again in the main process, then keeps the explicit consent and the pre-migration backup. If the update fails, nothing is changed and the error card asks to press "Back up and update database" again.

No schema change: the database stays at schema 35 and project exports keep the 1.6.64 format. The language choice is kept outside the desktop settings file, so going back to 1.6.64 needs no repair.

## [1.6.64] - 2026-11-23

[繁體中文更新說明](docs/releases/1.6.64.md).

### Added

- The Agent read audit records `responseChars`, the number of characters in the MCP response actually sent for each read (JavaScript string length, that is UTF-16 code units, not bytes or tokens): the text content plus `structuredContent` when present. Only the number is stored, never content. `GET /api/agent-reads` items carry it, `GET /api/agent-reads/stats` returns `responseChars: { count, p50, p95, total }` per tool (nearest-rank, rows with a recorded size only), and the System status page shows both.

### Changed

- SQLite schema 35 adds a nullable `response_chars` column to `agent_read_audit`. Existing rows stay NULL (unknown, not 0). The audit table is not part of project data export, so export and import formats are unchanged.

### Tests

- `scripts/agent-usage-report.mjs` reads local Claude Code session logs and prints only aggregates: turns, tool calls by name (Work Intelligence MCP tools listed separately), input, output and cache tokens deduplicated by message id, and MCP tool_result characters. It never prints message text, paths or project names. Its tests run with `pnpm test:scripts`, which CI runs on Ubuntu, Windows and macOS. Codex rollout logs are supported experimentally: checked against real Codex CLI 0.163 rollouts, including code-mode MCP calls and compaction chains, but not yet against Codex `/status`. `--debug-shape` prints only key names and types so the format can be checked locally.

### Documentation

- Retrieval and Knowledge page baseline in `docs/experiments/retrieval-baseline/`: a fictional fixture, 30 retrieval questions with hand-written gold, 5 policy cases, 5 Knowledge page end-to-end scenarios, a runner that calls the storage read functions directly, and a report with the A/B decision rules.

The database migrates from schema 34 to 35 on first start, after an automatic pre-migration backup. Reconnect Work Intelligence MCP when an Agent reports `restartRequired`. A build older than 1.6.64 cannot open the upgraded database (`DATABASE_SCHEMA_VERSION_TOO_NEW`) or import a project export made by 1.6.64; restore the pre-migration backup to go back.

## [1.6.63] - 2026-11-23

[繁體中文更新說明](docs/releases/1.6.63.md).

### Fixed

- Knowledge pages no longer mark Sessions an Agent never saw as covered. A save used to set the page's coverage to the save time, so Sessions left out of a truncated context, or finished between the read and the save, were hidden from the next review. `work_get_knowledge_page_context` now returns a `reviewToken`; when `work_save_knowledge_page` receives it, coverage ends at the last Session that read showed, and those Sessions stay new.
- Reusing an idempotencyKey with different sections in `work_save_knowledge_page` returns `idempotency_conflict` and writes nothing. It used to report `duplicate: true` and drop the new content, even when that content cited invalid sources or carried an invalid `reviewToken`.
- Saving a Knowledge page no longer silently overwrites a newer version. An Agent save with `reviewToken`, or a Web edit with `baseVersion`, returns `version_conflict` and writes nothing when the page was saved after that read or edit started. The Web editor keeps the draft open and says which version it conflicts with.

### Changed

- SQLite schema 34 adds two nullable columns to `knowledge_pages` for the Session coverage position. Existing pages keep their current coverage, and exports from schema 31–33 still import. Agent saves without `reviewToken` keep the old behavior and return `warnings`.

### Tests

- Deterministic storage tests for Knowledge page maintenance: checking unrelated Sessions, cited-source changes, void and restore, character-budget truncation, idempotent retries, source changes between read and save, and page/version consistency after a save.

The database migrates from schema 33 to 34 on first start, after an automatic pre-migration backup. Reconnect Work Intelligence MCP when an Agent reports `restartRequired`. A build older than 1.6.63 cannot open the upgraded database (`DATABASE_SCHEMA_VERSION_TOO_NEW`); restore the pre-migration backup to go back.

## [1.6.62] - 2026-11-22

[繁體中文更新說明](docs/releases/1.6.62.md).

### Changed

- Updated Vue from 3.5.42 to 3.5.45, Electron from 45.3.2 to 45.3.4, Vite from 6.4.6 to 8.3.8, and ESLint from 10.14.0 to 10.15.0. Vite 8 changes the default Dashboard build targets to Chrome and Edge 111, Firefox 114, and Safari 16.4.
- Updated the development dependency `@types/node` from 24.19.2 to 26.6.6. TypeScript now infers the path API from `path.win32` and `path.posix` in storage-risk checks and Agent integration records. Supported Node.js runtime versions are unchanged.

### Fixed

- Desktop unit tests and coverage resolve Electron mocks from the desktop workspace. Tests that use a mock can run without the Electron binary.

### Documentation

- Reworked the English and Traditional Chinese READMEs and updated the install, Agent setup, and troubleshooting guides to follow the desktop App workflow.

SQLite schema 33 requires no migration for this update.

## [1.6.61] - 2026-11-19

[繁體中文更新說明](docs/releases/1.6.61.md).

This patch release lets the desktop App take over a hand-written `pnpm start:mcp` registration, which reported a conflict on macOS 1.6.60. The schema stays at 33 and no migration is needed. Real-device acceptance on Windows 11 and macOS is still pending.

### Fixed

- **"Conflict, nothing written" for a hand-written pnpm registration.** Adoption ("改由桌面 App 管理") only knew `node <checkout>/apps/mcp/dist/launcher.js`, so `command = "pnpm", args = ["--dir", <checkout>, "start:mcp"]` in Codex `config.toml` and the Claude MCP entry was refused. It now reads `pnpm`, `pnpm.cmd` and `pnpm.exe` (absolute or on PATH, also behind `cmd /c`) with `--dir`, `-C`, `--dir=` or `cwd`, optionally `run start:mcp`, finds the checkout root, and rewrites only `command` and `args` to the launcher shim. `enabled`, other `env` keys, the other servers, `[hooks.state]` and a `cwd` that names another folder stay; a `cwd` that only named the checkout is removed, because the launcher would fail to start once that folder is gone. Undo restores both files byte for byte.
- **Another database is never swapped in.** `WORK_INTELLIGENCE_DB` follows the existing same-file check: when it names another file than the App's, nothing is adopted and the Agent card says so, with the choice the App already offered.
- **An adopted entry follows the App's database.** An entry is only adopted when its database is the App's file, so adopting removes its `WORK_INTELLIGENCE_DB` (an explicit variable would win in the launcher and pin MCP to the old file while the hooks follow the App). An `env` that held only that variable is removed with it; other variables stay. This applies to the node and pnpm forms, in Codex TOML (own table, dotted key, inline table) and in Claude JSON, and undo restores the files fully. Without the App's database to compare with, the variable stays as before.
- **The refusal now says what to do.** A plain "Preview changes" that is refused because an Agent has an adoptable hand-written registration points at "Let the desktop App manage it…". When a registration cannot be adopted, the card explains why in plain words and what the person can do; no command is asked for.
- **An old checkout hook beside the App's hook (Codex card stayed "conflict").** The hook adoption only knew `node <script>` written exactly as setup writes it. It now reads `node` by name or absolute path (also `node.exe`) with plain flags and any quoting, and `pnpm [--dir|-C <dir>] [exec] node <script>`; a flag that loads code (`--require`, `--eval`, …) is refused. When the App's own hook is already on the same event, the old hook is a duplicate and adoption removes it (its group goes too when it was the only hook; a sibling or third-party hook in the group stays), with journaled undo. A hook that is not ours is never touched or reported. A checkout's own `.codex/hooks.json` is never read for changes; if it also runs the reminder the card only says so.
- **Plugin hooks next to the App's hook.** The Agent card warns when the Agent's own Work Intelligence plugin brings finalize hooks (Codex: plugin enabled, or trust state for a `work-intelligence@…` hook in `[hooks.state]`; Claude Code: plugin enabled) while an App or checkout hook is installed, so the reminder may fire twice. The plugin is never changed.

- **A later `--dir` is not pnpm's.** `pnpm start:mcp --dir <other>` runs the entry's own directory; the flag after the script name is no longer taken as the checkout.

### Notes

- The database path of a refused adoption is shown only on the Agent card, never in the diagnostics summary.

## [1.6.60] - 2026-11-19

[繁體中文更新說明](docs/releases/1.6.60.md).

This patch release fixes the MCP connection count that stayed 0 on Windows 1.6.59, and closes the review notes of the 1.6.59 desktop work. The schema stays at 33 and no migration is needed. Real-device acceptance on Windows 11 and macOS is still pending.

### Fixed

- **MCP connection count stayed 0 on Windows (cause found).** An Agent wrote its observation to the config directory, but the MCP's lease lived in the OS temp directory, whose path depends on the `TEMP`/`TMP` the process sees (a restricted Agent environment, an 8.3 short name, a different case). The backend counted leases in another directory. Leases now live under the config directory, next to the observation, so the two sides cannot disagree about it; the old temp location is still read until 1.8.0. The lease scope uses the real path (and, on Windows, ignores case and separators).
- **The App's MCP never kept a lease.** The desktop runtime's MCP is a standalone bundle, and standalone bundles skipped lease registration altogether, so the count could not exceed 0 whatever the directory. A bundle running inside the App (scope variable set, or located in `<App root>/runtimes/<id>/`) now registers; a plain standalone install still does not.
- **A failed lease is no longer silent.** The MCP records its lease scope id, whether its directory is writable and the failure reason in `agent-observations.json` (an optional field; the file version stays 1 and an older App ignores it). Web System Status says why the count is 0 (different scope, unwritable directory, Agent disconnected, or not reported by an older MCP), and the diagnostics summary has an MCP lease section with the scope ids (8 characters), counts and booleans only, no paths.
- **Start failure before the service stopped.** A failed runtime preparation no longer marks the App stopped or in need of repair while a service is still running.
- **Database check had no deadline.** A read-only integrity check now ends with an explicit failure after the existing 5-minute limit; no timeout was raised. Maintenance no longer reports "data intact: false" when the step never ran.
- **A second server on the same database.** When the chosen port is held by another Work Intelligence server on the same database, the App no longer starts a fallback server (also for change-database and takeover); it reports the original error.
- **Backup location.** The folder is no longer created before it is classified, so a refused folder leaves nothing behind. If restoring the old folder fails after a failed restart, the result says so (`not-restored`) and goes through the repair flow instead of only logging.
- **Restore.** The database's WAL and SHM files are not emptied if an Agent opened the database while the staging copy was built; the restore stops with "database in use" and the current database is untouched.
- **Restore on a new computer.** Two missing projects with the chosen folder's name, or that would land in the same folder, are no longer mapped.

### Notes

- Not changed, with the reason: an unresponsive backend (`reportUnresponsive`) is ended through the same single stop path as any other stop, which reports a child that will not die in its result instead of throwing.
- Limits: the observation is written once per MCP process, so a heartbeat failure after the first tool list is not reflected in it; a `WORK_INTELLIGENCE_CONFIG_DIR` visible to the Agent but not to the backend would still split both. Whether Codex passes `TEMP`/`TMP` to its MCP could not be verified without a Windows machine.

## [1.6.59] - 2026-11-19

[繁體中文更新說明](docs/releases/1.6.59.md).

This minor release wires the gaps 1.6.58's guards listed, so every setting, message and channel the App ships is reachable from a window. The schema stays at 33 and no migration is needed. Real-device acceptance on Windows 11 and macOS is still pending.

### Added

- **Restore on a new computer.** 「從備份還原」 finds the backup's project folders that do not exist on this computer and asks, in a native dialog, where they are now: choose a folder (the App matches same-named project folders and maps the paths with the same logic as the CLI's `--remap-root`), repeat, skip or cancel. The page still sends only an opaque backup id; every path stays in main. The Web backup page's desktop text describes this.
- **Database maintenance in the App.** The Data tab can maintain the database (automatic backup, integrity check, VACUUM, search index rebuild) and check integrity read-only. It runs as a `maintenance` operation of the coordinator, is refused while another operation, an Agent connection or an import or backup is active, and asks first. The Status tab and the Web System Status show the reclaimable space and how the last run ended.
- **Last-working-port fallback.** When the chosen port is taken or not allowed, the service starts on the port the last verified start used, only after the usual health and identity check, and the Status tab says so. The user's setting is not rewritten. A database is never swapped automatically and a runtime is not rolled back; a fallback that fails too ends in the repair flow with the original error and no change to the data.
- **Backup location.** The Settings tab can change where backups go: native folder dialog, a write test, the database's storage policy (a network drive is refused; an external, cloud-synced or hard-linked folder needs a yes), a service restart so it uses the folder, and the old folder is restored if that fails. Existing backups are never moved, and the card says so.
- **Install label in diagnostics.** The diagnostics preview carries a short install label (the first 8 characters of the install id), so a report can be matched to an install without the full id.

### Fixed

- **MCP connection count stayed 0 on Windows.** 1.6.58 made the launcher name one lease scope for the backend and for an Agent's MCP, but the backend is not started through the launcher, so it never got the variable and counted leases in a different directory. The App now sets the scope for the backend too, and a process inside `<App root>/runtimes/<id>/` finds its App root from its own location when no variable is set (an older launcher, a client that starts the MCP another way). When an Agent has been seen connecting but no live record is visible, the Web status says so instead of "no connections to monitor yet".
- **Web status layout.** The note under the start-at-login rows ("change it in the desktop App's Settings tab") had no side padding and touched the card edge; it now lines up with the rows in light and dark and at narrow widths.
- **Concurrent settings writes.** All settings changes go through one serial queue that writes the file before it updates memory, so two overlapping changes cannot overwrite each other's fields.
- **Windows startup entry.** The App no longer re-registers its login item at every start when the system already holds a matching entry, so a "disabled" mark set in Windows' startup settings is not cleared.

### Tests and guards

- `lastKnownGood` and `installId` are no longer exempt from the settings-field guard.
- A new unused-export guard (`pnpm check:unused-exports`, knip, with a baseline that only shrinks); test-only helpers are tagged `@internal test-only`.
- A docs-claims guard fails CI when the user documents repeat a superseded claim (for example 「目前沒有還原流程」 or 「修復視窗」); the release checklist asks for `docs/user-guide.md` to change with every user-visible feature.

## [1.6.58] - 2026-11-19

[繁體中文更新說明](docs/releases/1.6.58.md).

This patch fixes three things seen in the packaged Windows App 1.6.57. The schema stays at 33 and no migration is needed. Real-device acceptance on Windows 11 and macOS is still pending.

### Fixed

- **Start at login can be changed after setup.** The Settings tab has a 「登入時自動啟動」 switch on Windows and macOS. The page sends only a boolean; turning it on still needs the user's own click as consent, the settings file is written atomically before the system login item is touched, and the card shows what the system really reports (for example, the entry was turned off in the system's startup settings) in zh-TW and English, with no command.
- **System Status shows the App, not the old service.** Under the desktop App, the 「登入自動啟動」 card shows the App's own login state and the database and backup folder the backend really uses. They were computed with the repository defaults, so the card showed `data` in a checkout, the Task Scheduler entry, `service\work-intelligence.task.xml` and `logs\server.log`. The old service appears only when it is detected, and points to the App's Status tab. This was a display error only: the backend opened the database the App passed, and no second database was in use.
- **MCP connections are counted for the App.** The lease directory was derived from each runtime's own root, and the backend and an Agent's MCP run from different `runtimes/<id>` folders, so the page showed 0. The launcher now gives both one scope, the App's runtime root (`WORK_INTELLIGENCE_APP_LEASE_SCOPE`). A runtime or launcher without the variable keeps the older root-based scope; old lease folders are not migrated because a lease lives only seconds.
- **Windows path spelling no longer splits the lease scope.** On Windows the scope path is lower-cased and uses one separator before it is hashed, so one install always maps to one lease directory.
- **A refused login-start change is reported as failed.** When the system refuses the login item, the switch answers failed with the real system state and the settings file is put back, instead of answering ok. On macOS a login item waiting for approval reads 「需要在系統設定核准」 with a button that opens the Login Items pane through the fixed target list, not "off".
- **Agent connection evidence on the Web page.** System Status now reads `agent-observations.json` with the same shared code as the App's Agent tab, so both show the same host clients and the same current, stale or none state. The login-start state sent to the Web page is re-sent when the system changes it behind the App's back, and the Settings switch re-enables itself after a failed change.

### Removed

- **Dead code and unused strings.** Unused page titles and headings in the shell messages, an unused update-link schema, two unused storage helpers, three unused shared constants, and the unused `blockingTab`, `recognised` and `other-sources-present` fields. The settings file keeps `active.runtimeVersion` and `active.serviceOwner`, because 1.6.57 refuses a file without them.

### Tests

- New guards: the repair channel four-way check (preload, `REPAIR_CHANNELS`, main handler, page call), a read and write check for every settings field, a use check for every shell message key, a registry of the files the product exchanges state through, and a no-command check over all of `apps/web/src`.

## [1.6.57] - 2026-11-19

[繁體中文更新說明](docs/releases/1.6.57.md).

This is the last V1 patch. It fixes the medium and low findings of the 1.6.55 review that were left after 1.6.56. The schema stays at 33 and no migration is needed. Real-device acceptance on Windows 11 and macOS is still not done. Not done in this release: L-05 (build provenance attestation, no verified action SHA was available), the content hash in the runtime id (M-08), Git Bash coverage of the Windows hook command (M-13), and L-29 (a remote branch of the repository owner).

### Fixed

- **One activity gate for every restart (M-01, M-02, M-04).** Change database, change port, copy to a local disk and the storage verdict ask the backend what it is doing before stopping it, through the same gate and the operation coordinator. On Windows the final kill takes the whole process tree, and the server's shutdown grace (7 s) stays under the App's.
- **Retry and recovery (M-03, M-05).** A Windows task query that does not answer is "unknown", not "none". An automatic retry that meets a held lock tries again and then shows the failure.
- **Database switch and runtime messages (M-07, M-08).** After a database switch the page tells the user to reopen Agents. A locked runtime folder says to close the Agent that uses it (`RUNTIME_IN_USE`).
- **First start after an install (M-09).** On Windows the ACL stamp is taken after `current` moves, so the first start reads no ACL again; a failed check restores the previous pointer.
- **Supply chain (M-10).** The SHA-256 of the bundled Node.js archives is pinned.
- **Agents one by one (M-17).** Agent setup is chosen per Agent; a conflict in one Agent no longer blocks the other.
- **Codex: remove, then set up again.** Removing Codex also removes the per-tool approval tables Codex adds after our block (an undo restores them), and a file that holds only such approvals is no longer reported as a conflict: setup writes its block in front of them and keeps the approvals. A registration that is not a command (for example a `url`) is still left alone.
- **System Status no longer asks for a reconnect that cannot help (desktop and standalone).** The packaged runtime now carries a verifiable MCP build identity: the build embeds the contract id and a hash of the shipped bundles, and the status reads the bundles themselves instead of looking for the repository's `packages/*/dist`. A bundle that was changed afterwards, or one that cannot be read, still reads as unknown.
- **No command on the desktop status page or restore steps.** The page subtitle, the empty maintenance hint and the restore-from-export steps point to the App's Diagnostics and Data tabs instead of `pnpm` commands; the web server keeps its own wording. The no-command guard now scans the whole web locale, and a string that reads like a command has to be listed with its reason.
- **Agent cards show a real connection.** The Agent page now reads what the MCP server records when an Agent host completes `initialize` and `tools/list` (`agent-observations.json` in the config directory, the same one the server writes) and compares it with the tool-contract fingerprint the runtime ships (written at build time, so the server need not start). A host that saw the current contract reads "observed connected", an older one "needs reconnect"; Codex (`codex-mcp-client`) and Claude Code (`claude-code`) are mapped, unknown clients and the self-test are ignored, and without the runtime's fingerprint nothing is claimed as connected. Before, both cards stayed on "configured, unverified" because the file was never read.
- **Restore (M-14, L-24).** The final rename retries under a Windows file lock, old WAL/SHM files are settled before the replacement, and the restore check is a full `integrity_check`.
- **Import (M-18).** A UTF-8 byte order mark at the start of an import file is skipped.
- **Hook command (M-13).** A Windows-only test hands the hook command to cmd.exe and PowerShell.
- **Low findings.** Diagnostics mask more absolute folders, the extended-length prefix and the real database path (L-01, L-02); the desktop log is created 0700/0600 (L-03); `launchctl` runs from its system path (L-04); the port change confirmation names a staged import preview (L-06); agent and first-run handlers take the page-action lock (L-07); a running backend is health-checked every minute and ended after three misses (L-09); Windows USB disks read as removable (L-11); runtime cleanup keeps the named fallback and stops retrying a grace period (L-12, L-13); a vanished lease is recreated again (L-14); copied runtime files are flushed before the install commits (L-15); file-manager junk files such as `.DS_Store` no longer fail runtime verification (L-16); group-writable runtime files are accepted on purpose and documented (L-17); the config rename retries under a Windows file lock (L-21); Agent setup keeps a config file's indentation and trailing newline (L-22); the project export stops as soon as it passes the 256 MiB import limit (L-23); leftover transfer folders are swept hourly while the App runs (L-25); a background worker request has a 30-minute watchdog (L-26); the App/Dashboard theme difference is documented (L-27); two helpers only tests used are removed (L-28).
- **CI (L-18, L-19).** The runtime spike workflow always starts and decides internally which jobs run; desktop smoke covers plugins and gates the release. The six Spike check names are unchanged.
- **Test stability.** The SQLite timing test holds every transaction so its record count is deterministic; the Windows update-check tray test asserts the pushed state, not the first request's latency.
- **Schema:** no change (33).

### Known gaps

- L-05, M-08 (content hash in the runtime id), M-13 (Git Bash), L-29, and real-device acceptance, as above.

## [1.6.56] - 2026-11-18

[繁體中文更新說明](docs/releases/1.6.56.md).

This release fixes the high-severity findings of the 1.6.55 review. Crash recovery now runs at startup, restore is available inside the App, and the App no longer asks users to run commands. The schema stays at 33 and no migration is needed. Real-device acceptance on Windows 11 and macOS is not done yet, and restore still does not retry the final rename on Windows (M-14, planned for 1.6.57).

### Fixed

- **Crash recovery is wired into startup (H-01, M-06, L-10).** The main process runs `recoverAtStartup` after settings are read and before first-run setup or backend start. Interrupted operations are closed from real state (settings file, database identity and schema, child process, old-service detection), never from the journal. An empty journal costs one read. Results appear as a dismissible banner on the Status tab. A corrupt journal is renamed aside and recovery starts from an empty journal. An orphaned local copy is removed by recovery.
- **Restore inside the App (H-02).** The Data tab has a restore flow that uses opaque one-time backup tokens, runs through `OperationCoordinator` as kind `restore`, rejects newer-schema and non-Work Intelligence files, and warns to close Agents first.
- **Remove Agent setup (M-11).** The Agent tab has a Remove Agent setup action that uses `uninstallPlan`, with the same preview and transaction as install.
- **Undo falls back to entry-level removal (M-12).** When the file hash no longer matches, undo removes only the entries this app added.
- **No commands in the legacy-service flow (M-15).** The copy-command button is removed. The `openSystemSettings` action opens Task Scheduler on Windows (`%SystemRoot%\System32\taskschd.msc` through `shell.openPath`), and Login Items on macOS with a LaunchAgents folder fallback.
- **Copy and busy messages (M-16, L-08).** Copy points at the Status, Settings and Agent tabs, dead strings are deleted, and the busy message gives the real reason.
- **Manual-repair message (L-20).** The result no longer claims that a rollback happened when manual repair is needed.
- **Operation kinds.** The unused `update-install` kind and `advance()` are removed. The kinds in use are `apply-agent` and `restore`.
- **Guard test.** `tests/desktop-core/no-command-copy.test.ts` forbids pnpm, npm, terminal and command wording in desktop strings.
- **Schema:** no change (33).

### Known gaps

- M-14: the final rename in restore is not retried on Windows (planned for 1.6.57).
- Windows 11 and macOS real-device acceptance is not done.

## [1.6.55] - 2026-11-18

[繁體中文更新說明](docs/releases/1.6.55.md).

This release turns the desktop App into one window with tabs (Status, Agent, Settings, Data and Diagnostics, plus Setup while first-run setup is needed), and moves the design tokens into a package shared with the Web app. The schema stays at 33 and no migration is needed. Real-device acceptance on Windows 11 and macOS is not done yet.

### Added

- **Single window with tabs.** The App opens one window with WAI-ARIA tabs. Setup appears first and only while first-run setup is needed. Switching between settings pages no longer needs the tray menu. The last tab is remembered for the App session only, through the new `app:get-tab` and `app:remember-tab` IPC, which check the sender and validate input strictly.
  - Tabs support arrow keys, Home and End, roving tabindex and a visible focus ring. A busy badge shows on a tab while an operation runs.
  - Diagnostics preview, a pending confirmation and in-flight operations survive tab switches.
  - The 4-second poll updates only what changed and never moves focus.
- **Setup complete card.** After first-run setup finishes, the Status tab shows a one-time 「開始使用 Work Intelligence」 card with a button to Set up Agents.
- **Shared design tokens.** `packages/ui-tokens` holds the tokens moved verbatim from `apps/web/src/styles/tokens.css`. The Web build output is byte-identical apart from the import path.
- **Tests.** 12 new shell-window tests in the Linux desktop smoke (89 passed on Linux), a macOS-only shortcut test for Cmd+C/V/X/A/Z/W, and a test that forbids raw colours in the desktop renderer. Packaged smoke and packaged page screenshots run in the Desktop package, and light and dark screenshots of every tab, plus the NEEDS_REPAIR and needsSetup states, are uploaded as CI artifacts.

### Changed

- **Tray menu is shorter.** It shows an optional legacy-service status line (only while the start is held), 「完成首次設定…」 (only while setup is needed), Open Dashboard, 「開啟 Work Intelligence…」, Check for updates… and Quit. Check for updates… opens Settings and starts a check. Tray items, startup flags and Web open requests focus the single window and select the tab; they never open a second window.
- **Menu bar is reduced.** Windows and Linux have no application menu. macOS has a minimal menu: App (About, Hide, Hide Others, Show All, Quit), Edit (undo, redo, cut, copy, paste, select all) and Window (Minimize, Close Window with Cmd+W, which closes the window and does not quit). There is no View, reload or DevTools menu, and DevTools is off in packaged builds.
- **Theme follows the OS.** The window switches between light and dark live with the operating system setting.
- **Window size.** Default 920x760, minimum 720x560, clamped to the work area. The last size and position are kept for the session only.
- **Schema:** no change (33).

### Security

- **No new privileged IPC.** The CSP, the IPC allowlists and the OperationCoordinator BUSY rules are unchanged.

## [1.6.54] - 2026-11-18

[繁體中文更新說明](docs/releases/1.6.54.md).

This release makes diagnostics export preview-first, removes old runtimes only when no running process holds them, and adds a test-only Windows SQLite timing measurement. The schema stays at 33 and no migration is needed. Real-device acceptance on Windows 11 and macOS is not done yet.

### Added

- **Diagnostics export preview (DT-19).** 「匯出診斷資訊」 in the repair window opens a preview of the exact text to be saved, with a masking summary per category and a count of the non-App output lines left out. 「儲存檔案…」 writes exactly the previewed text (mode 0600 on POSIX); 「取消」 or Esc closes it. Only a manual export writes a file. Nothing is uploaded and there is no telemetry (ADR-29).
  - Masking covers user home folders on Windows, macOS and Linux (including names with spaces and the JSON-escaped form), UNC paths, the database and backup paths, email addresses, the dashboard one-time handoff code, secrets in URL parameters and fragments, URL credentials, and token shapes (JWT, PEM private keys, AWS, Slack, GitHub and OpenAI-style keys).
  - A second, independent scan checks the masked text. If anything is still found, the export is refused with `DIAGNOSTICS_SCAN_FAILED`.
  - The file is capped at 1 MiB. The oldest output lines are dropped first, then the oldest errors, and the file records how much was dropped.
  - A preview is valid for 10 minutes, can be saved once, and only from the window that asked for it.
- **Runtime leases (DT-24).** Every launcher action (MCP, serve and hooks) writes a lease containing only the action name and creation time, and removes it on exit. MCP and serve renew it every 60 seconds. A lease not renewed across two heartbeats of the App's monotonic clock counts as gone.
- **Windows SQLite timing (test only).** With `WI_SQLITE_TIMING=1`, set only on Windows CI for the unit tests and the SQLite stress job, a test helper records SQLite calls over 1 second, `BEGIN IMMEDIATE` waits, database open times, every `wal_checkpoint` call and tests over 10 seconds. It never records bound values. The production bundle check fails if the helper reaches a bundle. No threshold, timeout or assertion changed.
- **Tests.** Diagnostics tests, including linear-time checks on about 75 adversarial input shapes of 200,000 characters (each under 200 ms); runtime lease and cleanup tests; a Windows-only file-lock test; and a desktop smoke test that checks the saved file equals the preview.

### Changed

- **Old runtimes are removed after a deferred check.** An older runtime is removed only when it has been retired for at least 7 days, no lease holds it, and Windows lets the folder be renamed aside. Updates never delete a runtime or wait on a lock. A deferred removal is retried after 10 and 30 minutes, then hourly while the App runs, and at the next start (ADR-16).
- **Idle import previews no longer block a port change.** A staged import preview that no operation is reading no longer blocks a port change, which previously could be refused for up to 30 minutes. Running imports, backups, exports and restores still block. The port section shows a notice only when the change actually discarded a preview; the staged file is removed on App restart, when the Web page is left, and on `pagehide` (ADR-27).
- **Hook and MCP status recognizes launcher installs.** The Web status page and the desktop Agent page share one recognizer for hook commands (launcher, checkout or other), and each required event and matcher gets its own state. An MCP entry named work-intelligence counts as registered only when its command is Work Intelligence. The API stays backward compatible.
- **Schema:** no change (33).

### Security

- **Linear-time redaction.** The old redactor had a pattern that could take minutes on crafted input. The patterns were rewritten to run in linear time.
- **Refuse on a failed final scan.** An export whose masked text still matches a secret pattern is refused, not written.

## [1.6.53] - 2026-11-18

[繁體中文更新說明](docs/releases/1.6.53.md).

This release adds a manual update check to the desktop App. It runs only when you press 「檢查更新」: nothing is checked at launch, in the background or while idle, and there is no setting to turn it on, because the press is the consent. The App shows the latest version and its release notes, offers the installer for your platform in the default browser, and never installs anything itself. The schema stays at 33 and no migration is needed. Real-device acceptance on Windows 11 and macOS is not done yet.

### Added

- **Manual update check.** The repair window's 「更新」 card has 「檢查更新」, and the tray has 「檢查更新…」, which starts the check in the main process (sharing one request with the button) and opens the window (ADR-40).
  - The request is made only by the main process: `GET https://api.github.com/repos/<owner>/WorkLog.Ai/releases?per_page=20`, in a memory-only session with no cookies or credentials, no cache and no redirects. It sends no version, OS, machine id or token, and the `Accept-Language` header the browser stack adds is stripped. It times out after 10 seconds, also when a response stalls after its headers, and the response is capped at 1 MiB, also when it is chunked. Only one check runs at a time.
  - Drafts and pre-releases are skipped. A tag must be `vX.Y.Z`; the highest version is compared with the installed one.
  - The states are: up to date; newer (version, date and release notes); offline; rate limited (403 with no quota left, or 429), with the reset time and no automatic retry; secure connection failed (an untrusted certificate or TLS failure, often a proxy or security software); no stable release; and error. A link the system cannot open is reported, not shown as opened. Every state offers 「開啟發行頁面」.
  - Release notes are plain text only, with control and bidi characters removed, capped at 20 000 characters.
  - The primary button opens the platform installer (`Work-Intelligence-<x.y.z>-win-x64-setup.exe`, `-mac-arm64.dmg` or `-mac-x64.dmg`) in the default browser. A hint next to it says to verify the download with `SHA256SUMS.txt` from the release page. Other platforms and architectures get the release page only.
  - Download links are rebuilt from the tag and opened only when they are exactly this repository's github.com release URLs.
- **Daily audit-exception watch.** `.github/workflows/audit-exceptions-watch.yml` runs `node scripts/check-audit-ignores.mjs --registry` at 03:37 UTC and on manual dispatch. It has `contents: read`, no secrets, no install step, and is not a PR check. It fails, and GitHub emails the owner, when npm publishes a patched release of an ignored package or the audit no longer reports the advisory; the failure prints the removal steps. There are no exceptions now, so it passes; it stays as general infrastructure. See [相依套件稽核例外](docs/security/audit-exceptions.md).
- **Tests.** 82 unit tests (`tests/desktop-core/update-check-{logic,request,controller}.test.ts`, `tests/desktop-core/dashboard-link.test.ts`) and 24 desktop smoke tests (`apps/desktop/tests/desktop-smoke/update-check.spec.ts`) against a local fake GitHub server. The smoke tests prove that no request is made at launch or while idle, and cover the button flows, rate limiting, timeout, malformed responses, HTML shown as text, a bad asset URL (release page only), the exact request header set, one request per tray click with none on window close or reopen, a stalled body, a chunked body over 1 MiB, no stable release, and the notes keeping their scroll position on refresh. The test-only API-origin and platform overrides exist only in unpackaged test builds.

### Changed

- **Installers are not signed.** The update card says so: macOS is ad-hoc signed and Windows is unsigned, so Gatekeeper or SmartScreen may prompt when you install manually (ADR-38). Your data is kept.
- **Schema:** no change (33).

### Security

- **vue-router 5.5.0 → 4.6.5; the GHSA-fc5q-39xc-vjpf exception is removed.** vue-router 5.x pulled picomatch (ReDoS, no patched release) into the production tree through its build-time file-routing tools. 4.6.5 depends only on `@vue/devtools-api`, so `pnpm why picomatch --prod -r` is empty and `pnpm audit --prod --audit-level high` passes with no exception; the audit command and level are unchanged. `auditConfig.ignoreGhsas` and `ALLOWED_AUDIT_IGNORES` are both empty, and the unit test pins the allowed list to empty. The web app uses no 5.x-only API, so no code changed; history mode, deep links and back/forward behave as before. Web JavaScript grows by 1,936 B (899 B gzipped): 1,008,770 → 1,010,706 B.
- **Dependabot ignores vue-router >= 5.** Revisit when vue-router 5.x no longer depends on picomatch or picomatch ships a fix (>= 4.0.8); tracked under 「待重新評估」 in [相依套件稽核例外](docs/security/audit-exceptions.md), because the daily watch only covers listed exceptions.
- **Update check.** The App sends one anonymous GET to the GitHub releases API, and only after a button press. It never installs an update in-app (ADR-25).

## [1.6.52] - 2026-11-17

[繁體中文更新說明](docs/releases/1.6.52.md).

v1.6.51 was not released on its own; this release includes all of its changes (see [1.6.51](#1651---2026-11-17)).

This release adds upgrade-sample, migration-interruption and restore tests (DT-32), and a multi-process SQLite WAL stress suite (DT-07). Restore now verifies the migrated copy before it replaces the live database. The schema stays at 33 and no migration is needed. Real-device acceptance on Windows 11 and macOS is not done yet.

### Added

- **Upgrade samples (DT-32).** Three samples written by real builds (v1.6.8 at schema 31, v1.6.21 at schema 32, 1.6.51 at schema 33) are upgraded through the real store in `tests/storage/upgrade-samples.test.ts`. They are regenerated by hand with `node scripts/generate-upgrade-fixtures.mjs`, never in CI. A new migration must ship the sample of the previous schema; the guard test fails and names the command.
- **Interruption tests with real processes.** `tests/storage/migration-interruption.test.ts` kills the process inside the migration transaction, during the pre-migration backup, at 20 seeded random times, and during a restore. The database always stays all-old or all-new, and no partial backup is published.
- **Desktop smoke for an interrupted migration.** `apps/desktop/tests/desktop-smoke/migration-interruption.spec.ts`: a backend killed after the migration started goes to `NEEDS_REPAIR` and never returns to the old service; the next repair migrates once. The hold that stops the child before it opens the database exists only in the smoke runtime (`desktop-runtime-spike/build.mjs --desktop-test-build`, esbuild define `__WI_DESKTOP_TEST_BUILD__`); the runtime a packaged App ships has neither the code nor the variable name, and `check-production-bundle.mjs --runtime` checks it.
- **SQLite stress suite (DT-07).** `pnpm test:sqlite-stress` (not part of `pnpm test`) runs writers, readers, a checkpointer, a `VACUUM INTO` snapshotter and seeded SIGKILLs for 45 seconds, then checks integrity, foreign keys, FTS5, exactly-once acknowledged writes and restored snapshots. Thrown `SQLITE_BUSY` is gated: writers may throw at most `max(5, ceil(2% of their writes))`, readers, the checkpointer and the snapshotter none; the `busy` flag of `PRAGMA wal_checkpoint` stays report-only. `perf-results/sqlite-stress-<platform>.json` records the numbers and the applied limit per OS (`busyGate`), and is written before a failed gate fails the test; the packaged smoke's 6-second run applies the same gate. CI adds three jobs, `SQLite stress (ubuntu-latest|windows-latest|macos-latest)`; required checks are now 23.
- **Packaged runtime check.** The packaged smoke asserts the SQLite version and FTS5 of the App's bundled Node and records them in the package results.

### Changed

- **Restore** verifies the migrated staging copy (`quick_check` and `foreign_key_check`) before it is renamed over the live database. A failed check raises the new error `RESTORE_VERIFY_FAILED`; the live database is not changed and the staging copy is removed.
- **Storage (Node 26) CI job** also runs `check-sqlite-version`.

### Security

- **Audit exception for GHSA-fc5q-39xc-vjpf** (picomatch <= 4.0.7 ReDoS, high), approved by the user. It is the only entry in `auditConfig.ignoreGhsas` in `pnpm-workspace.yaml`. The audit command, its level and the CI and release audit steps are unchanged, and no overrides are used.
  - The path is `apps/web` > `vue-router` 5.5.0 > `picomatch` 4.0.7, also via `tinyglobby`/`fdir` and `unplugin-utils`.
  - It is build-time only: the `pnpm build` web dist contains no picomatch code.
  - Every glob comes from the repository, never from user input.
  - No patched release exists yet; remove the exception once picomatch >= 4.0.8 ships.
  - `node scripts/check-audit-ignores.mjs` (run in CI) fails when an exception is stale, and a unit test pins the list to this one entry.
  - See [docs/security/audit-exceptions.md](docs/security/audit-exceptions.md).

## [1.6.51] - 2026-11-17

[繁體中文更新說明](docs/releases/1.6.51.md).

v1.6.51 was not released on its own; it ships with v1.6.52.

This release adds two desktop pieces after stage 4: changing the port from the App (DT-14) and a file-system risk policy for the database location (DT-08). The schema stays at 33 and no migration is needed. Real-device acceptance on Windows 11 and macOS is not done yet.

### Added

- **Changing the port from the App (DT-14).** It is in the repair window's 「連接埠」 section and the tray item 「變更連接埠…」. There is no port control in Web.
  - The Web system status page shows the current address and 「在桌面 App 變更連接埠」. The button only asks the App to open its port section (`POST /api/desktop/open-port-settings`, at most once per second). It hands over whitelisted non-secret preferences and the current route; the App keeps them in memory only, for one use and at most 2 minutes.
  - Accepts integers 1024–65535. Browser-restricted ports are refused. Choosing the current port does nothing.
  - An occupied target is refused before anything is stopped. A port the OS does not permit reports `PORT_NOT_PERMITTED` (EACCES/EADDRNOTAVAIL, including the Hyper-V/WinNAT excluded ranges on Windows), distinct from `PORT_OCCUPIED_BY_OTHER`.
  - Refused while another App operation runs, or while the backend imports, backs up or exports.
  - Order: native confirm, stop, start on the new port, verify through private IPC and the HTTP proof, then one atomic settings write of `desired.port`, `active` and `lastKnownGood`. A failure restarts on the old port; if that also fails, the repair window's port section is available. A crash mid-change leaves the old port.
  - After success the App opens the Dashboard at the new address with a one-time URL fragment, which the page reads, clears from the address bar, and uses to restore whitelisted preferences and the route.
- **File-system risk policy (DT-08).** At start (in parallel with the backend) and when choosing a database, the App classifies the database location as none, network drive, removable drive, cloud-sync folder, hard link or unknown.
  - Network drives are refused as the App's database. The backend stops and the App goes to repair with `DB_STORAGE_NETWORK`; retrying stays refused.
  - UNC paths stay refused, with a message to copy the database to a local disk first.
  - Removable, cloud-sync and hard-link locations are never a one-click 「沿用」; they need a consent checkbox that states the reason. The App never migrates the schema there.
  - Unknown blocks only the one-click choice, never startup or a schema update.
  - 「複製到本機磁碟並改用」 (first-run and repair pages): a native confirm, a free-space check, a consistent `VACUUM INTO` copy through a read-only preview child, `PRAGMA quick_check` on the copy, and a non-overwriting name (`work-intelligence-local.sqlite`, `-2`, ...) in the App's default data folder. The App then switches to the copy through the normal journaled change and upgrades it. The original file is never changed or deleted.
  - 系統狀態 shows the risk as a warning.
- **Status fields.** `GET /api/system/status` `desktop` gains `activePort` and `storageRisk`.

### Changed

- **Tray:** new 「變更連接埠…」 item.
- **Error codes:** `PORT_NOT_PERMITTED` and `DB_STORAGE_NETWORK` are added.

## [1.6.50] - 2026-11-17

[繁體中文更新說明](docs/releases/1.6.50.md).

This release finishes the old-service and Agent-takeover parts of stage 4 of the desktop app plan. The schema stays at 33 and no migration is needed.

### Added

- **「停用舊的登入服務…」 in the App.** It is on the old-service card of the first-run page and the repair window, and in the tray, which opens the repair window. There is no Web button. It is offered only for a definition that detection recognises and whose checkout is known.
  - A read-only preview explains in plain zh-TW what happens. The commands are only under 「詳細步驟」.
    - On Windows: 「正在執行的舊服務會被立即結束；已儲存的資料不受影響，正在寫入的一筆可能需要重做。」
    - On macOS and Linux the service stops gracefully.
  - An import (a fresh `import-*` transfer directory with its marker) or a backup (a staging directory whose owner is alive) shows 「舊服務可能正在匯入或備份，建議稍後再停用。」. The user may continue with 「仍要停用」.
  - 「停用」 asks once more in a native dialog, with Cancel as the default.
  - The disable acts only on exactly what was previewed:
    - detection now carries a SHA-256 of a recognised definition, and the disable detects again first: if the definition, checkout or port changed, nothing is done;
    - the file is removed only while it is still that regular file;
    - commands are argv arrays with fixed names only.
  - Same steps as `pnpm service:uninstall`. Nothing is removed until the port is free and, on Windows, the runner's process trees are gone (bounded). A final detection must find nothing.
  - It runs under the operation lock as a new `legacy-disable` journal kind.
  - When the old service used the App's database, a read-only `PRAGMA quick_check` runs before the App opens it. On failure:
    - `DB_INTEGRITY_CHECK_FAILED` is recorded;
    - the repair window shows the database;
    - nothing starts.
  - 「立即啟動」 is offered only in an interactive launch with settings and no backend running. The App never starts by itself after a disable.
- **Windows runner descendants (DT-13).** Only `node.exe` processes whose command line names this checkout's `scripts\service-runner.mjs` are ended (`taskkill /T`). The match is normalised and case-insensitive, and the path must stand alone. Every descendant (pnpm, the old server, conhost) is found by parent id and waited for, never ended on its own.
- **Desktop preview `quickCheck`.** The child preflight message gains optional `quickCheck: true`. It runs `PRAGMA quick_check` on the same read-only handle, and a failure reports `unreadable` with a fixed detail.

### Changed

- **"改由桌面 App 管理" takes over checkout entries only when they use the App's database.** The database is compared by file identity. An entry on another database (explicit `WORK_INTELLIGENCE_DB`, or the checkout default) is refused and nothing is rewritten. Its card instead offers 「改用這份資料庫」, which previews that database in the repair window for the user to confirm.
- **Tray:** "如何移除舊服務" is now 「停用舊的登入服務…」.

### Fixed

- **Independent review of the disable and adoption (this release).**
  - The App's own backend on the old port counts as the port being free.
  - After a failed `bootout` / `disable --now`, nothing is removed while `launchctl print` / `systemctl is-enabled` still finds the service.
  - The database is checked after any stop, also when a later step fails. Only a failed `quick_check` is reported as `DB_INTEGRITY_CHECK_FAILED`. A check that could not finish (locked, a 5-minute timeout, a child failure) is "unverified": no error is recorded and 「立即啟動」 is not offered.
  - Windows warns about the hard stop when a runner of the checkout is alive even though the task reads as stopped.
  - An import or backup that starts after the preview is warned about before the dialog.
  - Adoption is refused per Agent, and not at all without an App database.
  - The packaged-smoke pid-reuse guard compares each ancestor with the earliest known time on the walk.

- **Windows packaged smoke: a Firefox background task's own children no longer count as a browser the App opened.** The v1.6.49 release run (44091619638) failed the uninstaller test on a `-contentproc` child of the Firefox Default Browser Agent. A candidate is now excluded when its nearest browser ancestor, found by parent pid with a pid-reuse guard, is a Firefox `--backgroundtask` that does not name the Dashboard. A new child of an already running normal Firefox still counts. Failure lines also print the start of the parent's command line.

## [1.6.49] - 2026-11-17

[繁體中文更新說明](docs/releases/1.6.49.md).

This release is the second part of stage 4 of the desktop app plan:

- a first-run page (DT-01);
- Agent setup inside the App;
- taking over checkout Agent registrations ("改由桌面 App 管理") with a preview diff and undo;
- read-only detection of the old `pnpm bootstrap` login service.

The schema stays at 33 and no migration is needed.

### Added

- **First-run page (DT-01), for a new install only.** An install that already has `desktop-settings.json` (an upgrade from 1.6.47 or 1.6.48) never sees it.
  - "使用預設設定開始" is on the first screen from the first paint. It stays disabled, with "正在檢查…完成後即可使用", until the detection is done, and the main process refuses it before then.
  - A read-only detection offers existing databases:
    - the standalone location;
    - the environment;
    - the old service definition;
    - checkout MCP registrations of the Agents.
  - Each database gets one read-only preview, with its status and project count. A database that needs a schema update needs an explicit tick.
  - Nothing is written, created or bound before the user chooses.
  - The default start creates a new empty database at the default location, writes the settings only once the start worked, and opens the Dashboard. A failed start removes the database it created (ADR-27).
  - "稍後再說" and a `--background` new install show no window; the tray offers "完成首次設定…".
- **Agent page in the App window.** It opens from the tray ("設定 Agent…") or with `--open-agent-setup`, including as a second launch.
  - Cards for Codex and Claude Code show:
    - the status (ADR-34);
    - who owns the MCP entry and the hooks;
    - any checkout found.
  - "預覽變更" shows a per-file diff with the home shown as `~`. "套用變更" applies exactly the previewed plan with the DT-21 journal and refuses on conflicts. A file too large to diff needs the tick "我了解有檔案無法顯示差異" first, enforced by the main process. "測試連線" runs MCP `initialize` and `tools/list` through the fixed launcher. "復原上次變更" restores from the journal, and an unfinished journal is recovered at the next start.
- **"改由桌面 App 管理…"** takes over hand-written registrations that point at a checkout. It previews first and can be undone; unrecognised entries are left alone, with the reason shown. The agent-setup package gains `adopt`, `findCheckoutRegistrations`, `undoAgentSetupOperation` and `describeAgentSetupMutations`.
- **Web: "在桌面 App 設定 Agent"** on the status page, only when the backend is desktop-managed.
  - `/api/system/status` gains `desktop: {managed, legacyService?}` in desktop mode.
  - `POST /api/desktop/open-agent-setup` answers 202 (at most once per second) in desktop mode and 404 standalone. The Web never writes Agent files.
- **Old login service detection.** The App detects the service `pnpm service:install` leaves behind (LaunchAgent, systemd user unit, Windows task), read-only.
  - The exact warning "偵測到舊的登入服務（pnpm bootstrap）也在使用這份資料庫；同時執行兩個後端可能造成問題" appears in the first-run page, the repair window and the Web status page, with the exact removal command and a copy button.
  - Database paths are compared by their real path. A definition the OS no longer has registered counts as no service.
  - **Running (or not known to be stopped):** the App does not start its backend on that database (`LEGACY_SERVICE_ACTIVE`, never retried automatically) until the user confirms "仍要啟動", which lasts until the App quits.
  - **Stopped but enabled at login:** a `--background` login start does not start the backend. The tray shows "偵測到舊的登入服務也使用這份資料庫，未自動啟動" with "仍要啟動" (confirmed first) and "如何移除舊服務", and the OS shows at most one notification per run (fail-open). An interactive start starts with the warning and "下次登入時會啟動。".
  - **Disabled or not installed:** starts normally.
  - A port taken by the old service is named as such.
- **Desktop child protocol.** The preflight request gains `createIfMissing`, which creates a new database only where no file exists. The start message gains optional `desktop` facts, and a new child-to-parent `open-agent-setup` message is added.

### Changed

- **The fixed launcher hands Agents the App's database (ADR-39).** Without `WORK_INTELLIGENCE_DB`, every MCP and hook run reads the App's committed `desired.databasePath` through `<runtime root>/desktop-settings-path`. An explicit `WORK_INTELLIGENCE_DB` always wins. Invalid settings fall back to the standalone rule, with one stderr line for MCP and none for hooks. The cost per hook run is a median of 0.44 ms on Linux, against a 5 ms budget.
- **The Agent skill is packaged once**, as `resources/skills/work-intelligence/SKILL.md` outside the asar.

### Fixed

- **Masking the home folder no longer touches a sibling folder** that shares its prefix (for example `/home/tester2`).
- **A background-process out-of-memory is reported as 413 again on macOS arm64** (1.6.48). V8's native stack trace after its report could be longer than the 8 KiB of stderr that was searched, so the exit was reported as a plain 500. The report is now recognised as it arrives, carrying only a few bytes between chunks.
- **Telling two files apart on Windows uses the exact file id.** The recall evaluator, restoring a backup and the MCP launcher's change checks read the 64-bit Windows file id as a JS number, so two different files on volumes with wide ids could look like one: the recall evaluator then refused a question file as if it were the database. They now share one bigint comparison.

## [1.6.48] - 2026-11-17

[繁體中文更新說明](docs/releases/1.6.48.md).

This release finishes the large-transfer part of stage 4 of the desktop app plan. Project-data import, preview and export stream through an isolated background child process, so memory no longer grows with the file and running out of memory ends only that child. The import cap rises from 50 MiB to 256 MiB, and the Web UI uploads the raw file once to a server-staged import instead of parsing it in the browser. The desktop App gains a WI icon that matches the brand mark and success feedback after a repair. The schema stays at 33 and no migration is needed.

### Added

- Staged Web UI import: `POST /api/import/staged` (raw export body, optional `?strategy=`) saves the file under the transfer root and answers 201 with a 256-bit `stagingId`, `expiresAt`, a header (schema version, export time, scope, projects) and the first preview. `POST /api/import/staged/:id/preview` and `POST /api/import/staged/:id` take only the choices; `DELETE /api/import/staged/:id` cancels (204). A staged file is removed after a successful import, on cancel, 30 minutes after upload, at shutdown and by the start-up sweep. At most 2 are kept: another upload removes the oldest idle one, or is refused with 409 when both are in use. Unknown or expired ids answer 404. The existing `{bundle}` JSON endpoints are unchanged.
- Desktop repair success feedback: after a successful user-started repair the repair window shows the database path and project count, sends one notification, closes and opens the Dashboard once. Background starts and automatic retries do not. The backend ready message gains an optional `projectCount` (omitted when it cannot be read).
- macOS menu-bar template icon (`trayTemplate.png`, `@2x`).
- Performance gate `apps/server/bench/project-transfer.bench.mjs --check` in `pnpm test:performance` (peak RSS growth from 10 to 100 MiB at most 160 MiB, no run above 400 MiB), and a desktop smoke step that runs it (10 and 40 MiB) with the worker cold-start bench on Windows, macOS and Linux.

### Changed

- Backups, exports, import previews and imports run in a forked background child process with its own heap limit (default 1 GiB, `WORK_INTELLIGENCE_BACKGROUND_HEAP_MB`) instead of a worker thread. A child that runs out of memory exits on its own; the API answers 413 `backup_worker_out_of_memory` and keeps serving, and the next request starts a new child.
- Imports are streamed to `<database dir>/.work-intelligence-transfer/import-*` and read row by row; row text is spilled to a file beside it, so memory holds only what merge planning needs. Exports are written row by row to a file and streamed to the client. REST, the inline fallback and `db:import` (including `--dry-run`) share one reader; previews, conflicts and export bytes are unchanged and still all-or-nothing. On Linux with a 17.5 MiB export, peak RSS fell from 172 to 129 MiB for import, 154 to 103 MiB for preview and 140 to 109 MiB for export; at 100 MiB peaks are 199, 220 and 128 MiB.
- Import cap raised from 50 MiB to 256 MiB for REST, the CLI and the Web UI. The upload is refused with 507 `database_disk_full` unless free disk space is at least 2.5 times its size, and with 413 before reading when Content-Length is over the cap. The 200,000-rows-per-table limit is unchanged (about 14,000 Sessions per export at about 14 work events per Session) and its message now names the table.
- The Web UI no longer reads or parses the import file; it streams it to the staged endpoint and shows an indeterminate uploading state.
- The desktop App icon is generated from `apps/web/public/favicon.svg` and all `.png`, `.ico` and `.icns` files were regenerated.
- Project export decides with one indexed query whether diagram masking is needed, instead of writing the export twice when an architecture diagram exists.
- Error messages: a single row over 32 MiB now answers 413 "匯入檔中有單筆資料過大，無法匯入。" (was 400); a body of many tiny JSON containers answers 400 "匯入檔格式錯誤：內容結構異常或過於龐大。" (was 413 from the precheck).

### Removed

- The import structure precheck, its bench and the injected worker out-of-memory test helper; tests now exhaust a real child heap.

### Fixed

- On Node 24, exhausting the background heap could end the whole backend process; it now ends only the child.
- The start-up sweep removes only directories it made: under the dedicated `.work-intelligence-transfer` folder, named exactly as created, holding a marker file, and never through a symbolic link, so a user's own `export-*` or `import-*` folder beside the database is never touched.
- The streaming reader reads a number or literal (`1`, `null`, `true`) cut by a chunk boundary the same as a whole one, refuses a bracket closed by the other kind (`[}`) as invalid JSON, counts masked secrets only in the rows the import keeps when a table, `tables` or `bundle` key repeats, and looks for a string's closing quote only in the bytes it holds.
- Tests: kill the child mid-import (database intact, nothing written, re-import works), 48 corrupt-file cases with the 1.6.47 messages, streaming reader edge cases, staged import expiry, binding, reuse and cleanup, the web store, and an end-to-end import of a file over 50 MiB.

## [1.6.47] - 2026-11-17

[繁體中文更新說明](docs/releases/1.6.47.md).

This release is the CI-verifiable part of stage 3 (Agent integration) of the desktop app plan. It adds a shared, non-interactive Agent setup API with fingerprint checks, a durable operation journal and compensation; an MCP stdio handshake probe and observed-connection status for Agents; the fixed launcher wiring for the plugin, MCPB and standalone entry points; and a Dashboard hand-off to the desktop App. It also pre-warms the Windows ACL reader during first start. The stage 3 gate is not passed: real host handshakes and the Windows and macOS behaviour still need CI or a real machine. The schema stays at 33 and no migration is needed.

### Added

- `packages/agent-setup` (`@work-intelligence/agent-setup`): plan, apply, verify and compensate for Agent configuration. Each plan records a SHA-256 fingerprint per file. Apply re-checks every item before each write and stops at an external change (`externally-modified`) without overwriting it. A durable journal is written before the first write, and compensation only restores items this operation wrote that still hold the written content. `pnpm setup:agents` output and written files are byte-for-byte unchanged (golden tests).
- Registration inspection for Codex, Claude Code and Claude Desktop, with sources `desktop-managed`, `manual`, `plugin`, `mcpb` or `unknown`. Duplicate registrations are flagged, and a plan refuses to add a second registration. The Claude Desktop MCPB detection is inferred from file layout and is pending real-machine verification.
- A launcher target for `setup:agents`: MCP runs the fixed shim with `mcp`; hooks run the quoted shim with `claude-finalize-reminder` or `codex-finalize-reminder`. Windows accepts only drive-letter shim paths.
- An MCP stdio handshake probe and Agent status grading in `packages/desktop-core/src/agents`. States: observed-connected, configured-unverified, needs-trust, externally-managed, conflict, runtime-incompatible and needs-reconnect.
- `apps/mcp` records the host's first `initialize` (client name and version, protocol version, contract fingerprint, server version and time) in `agent-observations.json`, fail-open. `WORK_INTELLIGENCE_MCP_SELFTEST=1` opens no database and writes no runtime state.
- An MCP contract fingerprint (`packages/shared/src/mcp-contract-fingerprint.ts`): a SHA-256 of each tool's name, input schema, output schema and annotations.
- `desktop-integration.json` (version 1), written by the packaged App once the runtime is current. It holds the launcher path, runtime root, App executable and App version, and no database path or user data.
- Dashboard hand-off (`launch.mjs dashboard`, `pnpm dashboard`): when no server answers on the port and a valid record exists, the App is started detached with `--open-dashboard`. The command never starts a checkout server. The App opens the Dashboard once the backend is ready, and a second instance forwards its request through single-instance data.
- Windows ACL pre-warm: on a fresh install the tier-1 PowerShell reader starts before the runtime copy and falls back to the one-shot reader on failure. The provisioning log gains `acl-prewarm=<ms> ms` and the performance metric `firstStartAclPrewarmMs`.

### Changed

- `desktop-integration.json` now stores the canonical real path of `runtimeRoot` and `appExecutable` (`realpathSync.native`: no symlink such as macOS `/var` → `/private/var`; on Windows the real letter case and long names). An unresolvable path, or a Windows path that resolves to a UNC share, keeps the original value. A warm start still writes nothing.
- Tests: the packaged smoke ends a browser that the OS opened outside the App's process tree for the Dashboard (Safari on macOS, Edge on Windows) only with `CI=true` or `WI_PACKAGED_STRICT=1`. On a developer's machine it only lists such a browser in a warning, because it could be one the developer opened. A test whose launches are all `--background` or `--quit` fails if a browser appeared. The second-instance hand-over, which opens the Dashboard by design, is marked as such.
- Backend memory after a large export or import: the export's read-only connection uses a 1 MB SQLite page cache instead of 16 MB (an export reads each page once), and the backup worker exits 1 s instead of 5 s after a heavy operation. On Linux (33 MiB synthetic project data, median of 3) idle RSS after an export fell from 122 to 92 MiB (baseline 85 MiB), and RSS 3 s after an export or import from 237–280 to 121–130 MiB; idle RSS after an import is unchanged. Export bytes are unchanged.
- The plugin, MCPB and standalone entry points prefer the fixed launcher shim. The order is: an explicitly set `WORK_INTELLIGENCE_HOME` checkout, the desktop shim, the plugin-location checkout, then the bundled server. A runtime that is not ready falls back to the next entry with a stderr line.
- Hooks that run through the shim are silent, end after 25 seconds (on Windows the process tree is ended with `taskkill /T`), and always exit 0.
- `WORK_INTELLIGENCE_DB` from the MCPB user configuration passes through the launcher.

### Fixed

- Project-data import: a request body of many tiny JSON containers (for example `{},` repeated up to the 50 MiB limit) could abort the whole server process instead of returning 413. The backup worker parses the body with one native `JSON.parse`, which V8 cannot interrupt: under a 64 MB worker limit the heap reached 278 MB and the process died with "Reached heap limit" ("`{},`" keeps about 22 times its size in heap, `[[]],` 20, `[],` 14, `{"a":1},` 6, against 2.1 for a real export). A new precheck makes one pass over the raw bytes (no string is allocated), counts the `{` and `[` outside JSON strings, and answers 413 `payload_too_large` when 72 B per container plus 2 B per byte exceeds 384 MiB, before anything is parsed, in the worker, in the inline fallback and in `db:import` (which prints the same message and exits 1 without writing). A 43 MiB synthetic export estimates 95 MiB (measured 89 MiB) and a 33 MiB one 70 MiB (measured 68 MiB), so real exports pass with about 4-5 times the margin. The scan takes 28 ms for a 50 MiB export-shaped body and at most about 110 ms for 50 MiB of containers or whitespace. The out-of-memory tests now use a valid bundle that exhausts the 64 MB worker in interruptible JavaScript (worker heap peaked at 64.6 MB), and a new test covers the old padding body.
- Portable JSON import no longer reports a conflict for work-summary update rows when only one machine has pruned their replay columns. At startup the server clears `previous_work_summary_json` and `resulting_work_summary_json` of update rows older than 7 days to `'{}'`, and the table has no version column, so "newer wins" could not resolve it. These two columns now count as equal when either side is `'{}'`; the local value is kept, and two different non-empty values are still a conflict. No data was lost: the work summary itself was identical on both sides.
- Tests: on Windows, the suites that install, verify and launch real fixture runtimes use a stated 30 s per-test timeout and half the logical CPUs as workers, set once in `packages/desktop-core/vitest.config.ts` (POSIX keeps vitest's defaults); the directory lock runs once per run in a global setup instead of once per file, and the fixture suites answer the ACL check with a synthetic descriptor instead of a real PowerShell read (the real reader stays covered by the ACL suite). The Windows desktop-core run went from 46.2 s wall and 125.4 s summed test time to 34.4 s and 49.4 s. No test is skipped.
- Tests: the `setup:agents` golden test compares Windows output with the same golden files. The CLI prints and writes native paths (`~\.codex\config.toml`), and only the separators of `<TMP>` and `~` paths are made portable; the shell-quoted repository name is protected.
- Tests: the non-Windows-policy ACL prewarm case is pinned on both hosts. A Windows runner reports every file as 0o666, so the POSIX policy refuses the install there.

### Notes

- Plugin manifests still start `node launch.mjs`, so Agents still need Node to start the plugin itself. The App UI does not call the Agent setup API yet.
- DT-24 remains partial: old runtime cleanup does not yet prove that no live connection uses a runtime.
- Schema unchanged (33). No migration.

[繁體中文更新說明](docs/releases/1.6.46.md).

A fix release for the release pipeline. The 1.6.45 release run built and smoke-tested all three desktop packages, but its publish step stopped before creating the GitHub Release, so 1.6.45 has a tag and no release; 1.6.46 ships the same desktop App. It changes no schema; the schema stays at 33 and no migration is needed.

### Fixed

- `release.yml`: `upload-artifact` keeps each file's path below the pattern's first wildcard, so the merged download nested the installers under `<platform>-<arch>/out/` and the exact-name check failed. The publish job now moves every downloaded installer to one flat folder before the check and fails when two installers share a name, so `SHA256SUMS.txt` and the release assets use the plain file names.
- `pnpm package:desktop -- --dir` failed with `Unexpected argument` because the `--` separator reached the script. One leading `--` is now dropped; `pnpm package:desktop --dir` keeps working.

## [1.6.45] - 2026-11-16

[繁體中文更新說明](docs/releases/1.6.45.md).

This release is the packaging part of stage 5 of the desktop app plan. It adds the electron-builder 26.18.1 packaging for a Windows 11 x64 NSIS installer and for macOS DMG and ZIP files (arm64 and x64, built separately), a bundled official Node.js 24.22.3 runtime that is installed into the launcher root on first launch, a Windows ACL check for that root, a `--quit` command used by the installer, and a packaged black-box smoke test. This stage has no auto-update, no Developer ID signing and no notarization (macOS builds are ad-hoc signed only): electron-builder 26 does not verify the signed update manifests of v27, so Windows shows SmartScreen warnings and macOS shows Gatekeeper warnings. The packaging has been verified only on Linux locally; the Windows and macOS installers have not been run on real machines, and the stage 5 gate has not passed. It changes no schema; the schema stays at 33 and no migration is needed.

### Added

- `apps/desktop`: packaging with electron-builder 26.18.1 (`appId` `ai.worklog.workintelligence`, product name "Work Intelligence"). The Windows target is a one-click per-user NSIS installer (`perMachine` false, `allowElevation` false, no UAC prompt). The macOS targets are DMG and ZIP, one set per architecture. There is no universal macOS build. A Linux `dir` target exists only for local verification; Windows ARM and Linux are not V1 platforms.
- An original app icon (rounded square, log timeline and a spark) for the installer, the executable, the `.app` and the tray. `apps/desktop/build/icon.svg` is the only source; `icon.ico`, `icon.icns`, `icon.png` and `tray.png` are generated from it with `pnpm --filter @work-intelligence/desktop generate-icons` (Playwright Chromium renders the sizes, the ICO and ICNS containers are written by the script) and committed. Packaging fails when an icon file is missing or malformed, or when the packed macOS `icon.icns` is not the custom one.
- A bundled official Node.js 24.22.3 and the backend, placed in `extraResources` as `runtime-bundle/` outside the asar. The manifest SHA-256 is built into the main bundle, which is inside the asar with integrity checking on. On first launch the runtime is staged, renamed with backoff (for Windows Defender locks), fully hashed against the bundled manifest, fingerprinted in a cache, and then made current with an atomic switch. When the same version is already installed, the fast path does no hashing. A corrupt installed copy is quarantined and reinstalled; permission problems go to repair.
- The launcher root for the packaged App: `%LOCALAPPDATA%\WorkIntelligence\runtime` on Windows and `~/Library/Application Support/WorkIntelligence/runtime` on macOS, or `<userData>/runtime` when started with `--user-data-dir`.
- A Windows ACL check for the launcher root and runtimes. It reads the SDDL in two tiers: first with .NET (`Directory` and `File.GetAccessControl`, no PowerShell module load); only if that read fails, with `Get-Acl` plus `whoami /user` (for Constrained Language Mode). Windows PowerShell 5.1 is started by its absolute path with an allow-list environment (`PSModulePath` pinned to the System32 Modules folder, a clean `Path`), so an installed PowerShell 7 or a custom `PSModulePath` cannot break it. Both scripts turn off progress output and module auto-loading (`$ProgressPreference`, `$PSModuleAutoLoadingPreference`), PowerShell gets `-InputFormat None` and its stdin is closed. Tier 1 exits with code 3 when the session is not FullLanguage, so Constrained Language Mode is detected by exit code, not by localized text. The owner must be the current user, SYSTEM, Administrators or TrustedInstaller (CREATOR OWNER and OWNER RIGHTS are never accepted as owner); write-capable allow entries for other principals, and a null DACL, are refused. SDDL aliases of fixed well-known SIDs (`BU`, `WD`, `AU` and the others) are expanded to their SIDs before the check, and messages show the SID with the alias, such as `S-1-5-32-545 (BU)`; domain- and machine-relative aliases (`DA`, `LG` and the others) stay unknown and untrusted, and any other principal field fails closed. An unsafe verdict is final, with no fallback to the second tier. If both tiers fail, the check reports `RUNTIME_ACL_UNREADABLE` in one line per tier with the exit code, signal or timeout, the elapsed time and stderr cleaned of CLIXML (for example `dotnet: exit=3 (ConstrainedLanguage) 412 ms; get-acl: timeout after 60000 ms; whoami: ok 95 ms`), never the command line, and it fails closed. `icacls` was rejected because `icacls /save` has no owner, and the owner must be verified. The tier used and the time per tier are logged. The check is verified with fixtures on Linux only; the real Windows behaviour is CI-only.
- `--quit`: a second instance passes `{action:"quit"}` through `requestSingleInstanceLock` additional data. A strict zod schema validates it, and the running instance performs the normal non-interactive quit (stops the backend and confirms the port is free). The NSIS installer and uninstaller use it, wait up to 40 s, then end the current user's processes with `taskkill /T /F`.
- Production build guards: test hooks and test environment switches are removed at compile time (`__WI_TEST_BUILD__`), checked by `check-production-bundle.mjs` and by an asar scan in the packaged smoke test. Electron fuses turn off RunAsNode, NODE_OPTIONS and `--inspect`, enable cookie encryption and embedded asar integrity, and load only the app from the asar. The packaged App refuses `--remote-debugging-port`, `--remote-debugging-pipe` and `--inspect`.
- A packaged black-box smoke test (`apps/desktop/tests/packaged-smoke`, `pnpm test:desktop-packaged`) covering a sandbox user data path with spaces and Chinese characters, a run without Node on PATH, a second instance, a missing database that opens the repair window, `--quit`, runtime reuse, tamper detection, a refused debug switch, a macOS codesign check and DMG mount check, and on Windows a silent install and uninstall.
- `.github/workflows/desktop-package.yml` (pull requests, manual dispatch and `workflow_call`): Windows x64, macOS arm64 and macOS x64 run in parallel. The workflow caches Electron, electron-builder, runtime downloads and the pnpm store, compares the installer compression only when `compare-compression` is passed (NSIS and ZIP normal vs maximum, DMG ULFO vs UDZO, sizes and times in the job log), uploads the installers, the package result JSON and the packaged performance JSON. `release.yml` calls it with the release commit; publishing requires it to succeed, and the installers are added to `SHA256SUMS.txt` and the GitHub Release.

### Changed

- Performance gate: the heavy cases (backup, export, import preview, import) now end their timed operation at the response's last byte instead of after the benchmark client's own `Buffer.concat`, `toString` and `JSON.parse` (the checks still run and still fail the run). The result table prints both, `operationP90Ms` (gated) and `verifiedOperationP90Ms` (the old metric). They run 10 times instead of 5, so p90 is no longer the maximum. The `exportProjectData (all projects)` limit is tightened from 400 to 360 ms.
- Project data export skips re-sorting rows that SQL already returned in collator order. The exported bytes are identical; a golden test compares them with the always-sort path.
- The unpackaged desktop-smoke performance gates are tighter, based on the 1.6.44 CI run: win32 cold start, repair window and quit go from 8000, 8000 and 5000 ms to 3000, 3000 and 2000 ms; darwin goes from 15000, 15000 and 5000 ms to 5000, 5000 and 3000 ms. The performance JSON is also printed to stdout.
- The packaged App removes 53 Electron locales (it keeps en-US and zh-TW) and source maps. Local Linux unpacked size is 395.9 MiB, down from 405.8 MiB, and `app.asar` is 0.66 MB, down from 3.3 MB.
- Old runtimes are removed by a best-effort background cleanup that keeps the current and the previous runtime. There is no proof yet that no live connection uses a runtime, so DT-24 is partial.
- Runtime refusals keep their real error code. The backend supervisor no longer turns them into `RUNTIME_MISSING`: codes such as `RUNTIME_UNSAFE_PERMISSIONS` and `RUNTIME_ACL_UNREADABLE` reach `recentErrors`, the log and the repair window, with an actionable hint in zh-TW and English. Only `RUNTIME_MISSING` and content or integrity codes trigger the automatic one-time reinstall; permission and ACL codes go straight to repair, without a retry.
- macOS packages are ad-hoc signed by an `afterPack` hook, not by electron-builder (`mac.identity` is null). The hook flips the Electron fuses and then signs inside out (Mach-O files, frameworks, Helper apps, then the app) with `codesign --force --sign - --timestamp=none`, without hardened runtime or entitlements. `runtime-bundle` is left untouched, so the official Node.js keeps its own signature. Pull-request and release builds take the same path, since electron-builder skips signing on pull requests. The packaging gates read back the fuses on every platform, run `codesign --verify --deep --strict` and check `Signature=adhoc`, verify the bundled Node.js with `codesign --verify --strict`, check that runtime symlinks are relative and stay inside the app, and re-verify the app extracted from the shipped zip. `spctl` is recorded only. There is no Developer ID and no notarization.
- Memory of the packaged App (Linux, xvfb, idle, median of 3 runs): PSS falls from 352 to 292 MiB and the RSS sum from 662 to 538 MiB. The session policy is applied when the first window opens, not at start-up, because reading `session.defaultSession` early made Chromium keep a spare renderer (about 28 MiB PSS). The backend Node.js runs with `--max-old-space-size=1024 --max-semi-space-size=2`; a synthetic 47.6 MB import and export works at a 256 MiB cap. Disabling the GPU (no PSS change on Linux) and an in-process network service (security) were rejected. The packaged performance JSON now has a per-process breakdown (main, gpu, renderer, utility, zygote, backend). Idle memory gates: Linux 360 MiB PSS and 128 MiB for the backend; Windows and macOS are provisional at 1024 MiB and 192 MiB until CI data is available.
- Server shutdown: SIGTERM and SIGINT now also close idle connections and, after a 10 s grace period, all connections, so a client stalled mid-headers no longer keeps the process alive until Node's headers timeout. After an export, import preview or import the backup worker exits after 5 s idle instead of the 15 s used for light operations, so the parsed document is not held while still avoiding a worker cold start for a preview followed by its import. Request bodies are read into one buffer sized from `Content-Length`.
- Desktop test hardening: the Windows test directories are locked like the real `%LOCALAPPDATA%` root (`icacls /inheritance:r`, current user, SYSTEM and Administrators only). New negative tests refuse a root writable by `BUILTIN\Users` with exit code 78 and `RUNTIME_UNSAFE_PERMISSIONS` (spike), and the packaged App shows the repair window without a backend. The smoke helpers fail fast on a settled `NEEDS_REPAIR` instead of waiting for timeouts.
- Windows ACL reader tier 2 (`Get-Acl`, used under Constrained Language Mode) imports `Microsoft.PowerShell.Security` by absolute path under `$PSHOME` built by string concatenation (`Join-Path` would auto-load a module) and runs `whoami` alongside PowerShell. The timeouts are 20 s for tier 1, 60 s for tier 2 and 15 s for `whoami`; a tier that times out is retried once, and every attempt is reported with its failure kind. CI measured tier 1 at about 0.4 s and tier 2 at about 6 s with a heavy tail; the timeouts are to be tightened from field data. A Windows CI step runs the ACL test under a real Constrained Language Mode (machine `__PSLockdownPolicy=4`, removed afterwards).
- `commitCurrent` can reuse the ACL read of the `installRuntime` that ran earlier in the same process (`reuseAclStamp`). The stamp is in memory only and is never read from `.verified.json`. It is reused only when every covered object has the same change time and inode and the same set of objects, and no file missed the hash cache; otherwise the ACL is read again. The provisioning log line reports `acl-reads=N`.
- `afterPack` and `package.mjs` print `[afterPack]` and `[package]` lines: the fuses flipped, the number of paths ad-hoc signed by kind, the fuses read back, codesign, `Signature=adhoc` and bundled Node verification, the symlink count, the `spctl` exit code and the extracted-zip verification. electron-builder's "code signing will be skipped" line on pull requests is expected: it signs nothing, and `afterPack` does the signing.
- Backup worker: the worker runs with explicit `resourceLimits` of `maxOldGenerationSizeMb: 1024` and `maxYoungGenerationSizeMb: 6`. These bound servers started without `--max-old-space-size` (dev and standalone, where Node's default was about 2 GiB). When the process runs with `--max-old-space-size` (the desktop backend flags), V8 applies that value to the worker and ignores `maxOldGenerationSizeMb`. Measured with synthetic data (median of 3, worker `heapUsed` peak): 10 MB preview 45.8 MiB and import 59.0 MiB; 47.6 MB preview 163.2 MiB and import 192.8 MiB. Main-thread `heapUsed` stays at about 15–17 MiB, because the body is an external Buffer.
- If the backup worker runs out of memory, pending requests fail with `backup_worker_out_of_memory` (HTTP 413). Retrying the same document cannot succeed, which distinguishes it from `payload_too_large`. The server keeps running and the next request uses a fresh worker. The web UI asks the user to import or export one project (or fewer projects) at a time. No data is changed.

### Fixed

- Windows system tools (`whoami`, `schtasks`, `taskkill`, `icacls`, `powershell`, `cmd`) are always started from `%SystemRoot%\System32` by absolute path, through the shared helper `@work-intelligence/shared/windows-system-tool`. Git for Windows or MSYS on `PATH` can no longer shadow them, because its `whoami.exe` rejects `/user`. `ComSpec` is deliberately not trusted; `cmd` is always `System32\cmd.exe`. The `scripts/*.mjs` files that spawn these tools import `packages/shared/dist`, so run `pnpm build` first.
- Packaged smoke on Windows: an interactive launch opens the Dashboard in the external browser (ADR-01), and the browser inherited the sandbox profile, so cleanup failed with EPERM and its processes counted as App memory. Packaged smoke launches now use `--background` unless the test is about interactive behaviour; the App logs `[shell] dashboard opened`, one interactive test asserts it and background launches assert it is absent. The sandbox cleanup waits for, then ends, every process that uses the sandbox and names the ones it cannot remove. Packaged memory counts only the App's own processes; anything else is listed as excluded. Every PowerShell call in the test and script helpers turns progress off and closes stdin.
- Signing decision (ADR-38): no paid Apple Developer ID or Windows code-signing certificate. macOS stays ad-hoc signed, Windows unsigned, without notarization, and packaging on the user's own machine (`pnpm package:desktop`, see the "本機打包" section of `docs/desktop/README.md`) is the main way to get the App; CI and Release builds are secondary. Downloaded installers show Gatekeeper and SmartScreen prompts, and macOS cannot auto-update through Squirrel.Mac. The stage 5 and 6 gates in §9.4 now require SHA256SUMS (and our own manifest signature, if update checks are added) instead of signed installers. No gate or test was relaxed.
- `pnpm package:desktop` (and `--dir`) now runs the whole workspace build first, so a local package is one command; a failed build stops it before anything is packaged. The build time is printed as `[package] build N s` and recorded as `timings.buildSeconds`. `--skip-build` skips it; `desktop-package.yml` passes it, since the workflow builds in its own step.
- Installer compression defaults, from the CI comparison (size in MiB / build seconds): DMG is now ULFO (lzfse; darwin-arm64 148.93 / 9.0 against UDZO 151.87 / 48.3, x64 156.88 / 11.8 against 159.97 / 38.8; lzfse needs macOS 10.11 or later and Electron 45 needs macOS 12). NSIS stays normal (120.63 / 132.9 against maximum 120.63 / 264.3) and ZIP stays normal (arm64 146.51 / 62.3 against maximum 145.89 / 440.1). Pull-request runs no longer build the comparison, which added 8–10 minutes to each macOS job.
- Packaged performance gates for Windows and macOS are tightened from the first packaged CI run: idle memory 400 MiB on Windows (472 MiB measured, 204 MiB of it the Dashboard's Edge, now excluded) and 440 MiB on macOS (arm64 346–347 MiB, x64 213 MiB), backend 128 MiB on both (macOS 90 MiB). The macOS time gates follow the medians of the same run (arm64 / x64: first start 1455 / 2325 ms, warm 1232 / 1154 ms, repair window 1524 / 2703 ms, quit 434 / 565 ms): first start 30 s to 7 s, warm 8 s to 4 s, quit 5 s to 2 s, repair window unchanged at 8 s. A new `firstStartAclMs` gate covers the ACL read of the first start. The Windows gates follow the medians of run 43991395594 (first start 2123 ms, its ACL read 186 ms, warm 524 ms, repair window 2021 ms, quit 114 ms, idle working set 262.3 MiB, backend 71.6 MiB): first start 30 s to 7 s, ACL read 5 s to 1.5 s (below the 2–2.6 s of a cold Windows PowerShell start), warm 6 s to 2 s, quit 4 s to 1 s, idle memory 400 to 330 MiB, backend 128 to 100 MiB, repair window unchanged at 6 s.
- Runtime verification hashes the files while the Windows ACLs are read, instead of after the read. Nothing is trusted until both pass, and when both fail the permission error is reported. Right after an install the runtime's 130 MB are in the file cache and hash in about 0.2 s (Linux, 119 files), so a first start saves about that much; the cold PowerShell start of the ACL read (about 2 s on the first App start of a Windows machine) remains.
- Packaged smoke on Windows: every PowerShell call of the test helpers sets the console output to UTF-8. Windows PowerShell 5.1 writes in the OEM code page, which turned the Chinese characters of the sandbox path into `?` in the process list, so the check that the backend runs from `userData\runtime\runtimes` could not match. The check now compares `realpathSync.native` of both paths (case-insensitive on Windows) and prints both on failure.
- Packaged smoke on Windows: the installer test starts the App with the real `USERPROFILE` as well as the real `APPDATA`. Windows can expand the known folder of the default userData with the process's `USERPROFILE`, so with the sandbox's the App would write its log, and take its single-instance lock, in the sandbox home, where neither the test nor the installer's `--quit` looks. That test now runs only with `CI=true` or `WI_PACKAGED_STRICT=1`: on a developer's machine it is skipped with the reason, since it would use the user's own settings, database and log and its `--quit` would close their App; on CI it refuses to start, creating nothing, when a default userData folder already exists. A launch that does not reach MANAGED now reports its exit code and signal, the ends of its stdout and stderr, every process of the packaged App and each folder its log could have gone to.
- Packaging: electron-builder normalizes `files` in place, so a config reused for a second `build()` (macOS DMG and then ZIP, and the compression comparison) failed with "Cannot read properties of null (reading 'from')". Each build now gets a fresh config. A `beforeBuild` that resolves to false tells electron-builder that dependencies are handled outside it, which skips its node_modules search of about 7 s (the staged App has no node_modules).

## [1.6.44] - 2026-11-16

[繁體中文更新說明](docs/releases/1.6.44.md).

This release is stage 2 of the desktop app plan, the safe minimal desktop. It adds the Electron shell (a single instance, a tray or menu-bar item, a repair window and a quit flow that stops the backend and checks its port) and a backend child lifecycle that checks the identity of the child the App started: the child reports its run over a private IPC channel, and the HTTP readiness check requires an HMAC proof that only that child can compute. A new desktop-smoke workflow runs the shell on Windows, macOS and Ubuntu under xvfb. The checks that need a real Windows 11 or macOS machine have not been done, and the stage 2 gate has not passed. It changes no schema; the schema stays at 33 and no migration is needed.

### Added

- `apps/desktop`: a thin Electron 45.3.2 shell. The main process takes the single-instance lock before the app is ready, so a second launch exits at once. It owns a tray item (a menu-bar item on macOS), whose Dashboard entry is enabled only while the managed backend runs, and a repair window. The login item is off by default; turning it on needs an explicit consent. A background start (the `--background` argument on Windows, `wasOpenedAtLogin` on macOS) shows no window.
- The repair window, served from the fixed `wi-repair://` scheme: sandboxed, with context isolation, no Node integration, a minimal typed preload, a sender check and a zod schema on every IPC channel, a strict Content-Security-Policy, and navigation, `window.open`, webviews and permission requests all denied. It offers retry, choosing a database (which must be previewed before it can be confirmed), opening a folder and exporting redacted diagnostics.
- `packages/desktop-core/src/backend`: `BackendSupervisor`, which starts, verifies and stops the one backend child the App spawned. It brings the child up in a fixed order (hello, read-only preflight, start, ready, then an HTTP proof), runs it with an allowlisted environment and a fixed `PATH`, masks secrets and paths in its output, and stops it with IPC `shutdown`, then `SIGTERM` on POSIX only, then a kill, and finally waits for the port to be released. On Windows the kill is `TerminateProcess`.
- `start --desktop-ipc` in `apps/server` (`desktop-child.ts`): the backend child entry. It speaks a versioned private IPC protocol (`DESKTOP_CHILD_PROTOCOL_VERSION` 1, defined in `@work-intelligence/schema`) with 14 stable error codes.
- An instance proof in `@work-intelligence/shared`: `/api/health` returns an HMAC-SHA256 header over the parent's one-time challenge, keyed by a per-spawn run id that is never sent over HTTP. A shared loopback port probe is added alongside it.
- A last-successful-backup tracker and a redacted diagnostics export. The export masks the home directory, the user name, the database and backup paths, the run id and secret-looking values.
- A candidate database preview: a read-only preview child that receives only `preflight`, never `start`, so it never listens and never opens the database for writing.
- `.github/workflows/desktop-smoke.yml`: runs on pull requests that touch the desktop, shell, server, storage, shared or schema code, and on manual dispatch. It runs the Playwright `_electron` smoke tests (eleven cases, one of them Windows only, plus the performance spec below) on Windows, macOS and Ubuntu under xvfb, and caches the Electron binary per OS and version. Only the Linux test launch passes `--no-sandbox`, because Ubuntu 24.04 blocks unprivileged user namespaces for an unpackaged Electron and the downloaded binary has no setuid `chrome-sandbox`; the renderer settings under test are unchanged, Windows and macOS keep the OS sandbox, and the product never passes the flag.
- Traditional Chinese and English shell strings in `@work-intelligence/desktop-core`.
- A desktop performance spec (`apps/desktop/tests/desktop-smoke/performance.spec.ts`), run with the smoke tests on all three platforms. On synthetic data it measures, three times each: cold start (launch to MANAGED with a passing health proof), the repair window for a missing database (launch to its choose-database button), quit (to the backend gone and its port free) and idle memory five seconds after MANAGED (the main process from `app.getAppMetrics()`, the backend from `/proc`, `ps` or `Get-Process`). The medians must stay under the per-platform gates in `perf-gates.ts`, which also records where each gate comes from. The workflow uploads the results as `desktop-perf-<os>.json` on every run.
- A start-up guard: when Electron cannot name the data folder (`app.getPath("userData")` throws or returns nothing), the App writes the reason to stderr, shows a native error box and exits with code 1 at once, before `ready`, the single-instance lock, a tray or a backend; it never waits for `ready`, which Electron may not reach without that folder. The decision (`resolveUserDataDirectory`) is unit-tested, and a dev-only redirect of the data folder is applied before the default is first read. Known limitation: a Windows profile whose Roaming AppData folder is gone ends inside Electron's native start-up before the App's script runs (exit code 0xFFFF7003, Crashpad's "not connected to handler"), so no error box is shown; the smoke test records that it leaves no log, port or process behind.

### Changed

- The new `electron` dev dependency does not make `pnpm install` download the Electron binary (`allowBuilds: electron: false`). Only `pnpm test:desktop-smoke` and the desktop-smoke workflow download it, through `apps/desktop/scripts/ensure-electron.mjs`.
- `planLaunch()` accepts `requiredRuntimeKind`. The desktop App requires the bundled Node.js runtime (ADR-04) and refuses any other kind with the new `RUNTIME_KIND_NOT_ALLOWED` code.
- `startApi()` returns a handle with an awaitable shutdown, accepts a port and an instance run id, and re-reads the database identity after opening. Graceful shutdown always closes SQLite.
- The backup file name parser moved to `@work-intelligence/shared`, so storage and desktop-core read the same rules.
- `/api/health` sends the instance-proof header only when the request carries a valid challenge. The response body is unchanged.
- The App starts its backend as soon as it holds the single-instance lock: the settings read, the port check and the spawn no longer wait for Electron's `ready` or the tray, so the child boots while Electron gets ready. Only what shows something (a window, the Dashboard, a notification, the login item) waits for `ready`, and so does the recovery for a backend that exits early. An alternating A/B on local Linux (nine samples each) found no measurable change: cold-start median 501 ms before and 506 ms after, inside the run-to-run noise; the overlap can only matter where `ready` itself takes longer. A start that finds the same active record (port, runtime version and database identity) no longer rewrites the settings file with an fsync. The main-process log creates its folder once instead of before every line.
- The whole-database download (`POST /api/export` with `{}`) is about a third faster: its staging copy, which is streamed once and then removed, is written without SQLite fsyncs (`exportTo(target, { durable: false })`) and read in 1 MiB chunks. The bytes are the same, the snapshot is still checked before it is sent, and backups and the CLI export stay durable. The project-data export encodes its JSON with `Buffer.from`, to the same bytes.

## [1.6.43] - 2026-11-16

[繁體中文更新說明](docs/releases/1.6.43.md).

This release is stage 1 of the desktop app plan, the runtime spike. It measures two ways to ship the runtime that an Agent's MCP server and hooks start, the official Node.js binary and Electron run as Node, and records the choice (bundled official Node). It adds a fixed launcher with a versioned runtime manifest, which all validation runs through, and a smoke test that starts that launcher with no Node.js on the PATH and no network. It changes no schema; the schema stays at 33 and no migration is needed.

### Added

- Runtime spike scripts (`scripts/desktop-runtime-spike`, `pnpm spike:runtime:build` and `pnpm spike:runtime:smoke`). The build downloads the official Node.js 24 or Electron archive, checks it against the published `SHASUMS256.txt`, and lays out a launcher root with `bin/work-intelligence-launcher` (and `.cmd` on Windows), a single-line `current` pointer and `runtimes/<id>/`. The smoke test serves the Web UI, writes a synthetic database, runs FTS5 search and a backup, starts the MCP server over stdio and runs the hook actions, then checks that tampered runtimes are refused. It writes sizes, cold-start times and idle memory to `dist/desktop-runtime-spike/*.json`. The compressed size comes from a tar stream written by the script and gzipped with Node's zlib, not from the system `tar`: Windows bsdtar reads its arguments in the ANSI code page and could not open a path with non-ASCII characters.
- The runtime launcher and manifest in `@work-intelligence/desktop-core` (`packages/desktop-core/src/runtime`): a strict version 1 `runtime-manifest.json` that lists every file with its size and SHA-256, the symlinks a runtime may contain, and the actions it allows (`mcp`, `serve`, `codex-finalize-reminder`, `claude-finalize-reminder`). The launcher checks every file before it starts the runtime, refuses unlisted files and symlinks that point outside the runtime, and reports stable error codes (`RUNTIME_POINTER_MISSING`, `RUNTIME_POINTER_INVALID`, `RUNTIME_MANIFEST_INVALID`, `RUNTIME_FILE_TAMPERED`, `RUNTIME_FILE_UNEXPECTED` and others). `mcp` and `serve` exit 78 with an empty stdout when the runtime is refused; hook actions exit 0 so that a broken runtime never blocks the Agent that called the hook.
- `.github/workflows/desktop-runtime-spike.yml`: runs the build and the smoke test on Windows, macOS and Ubuntu for both the Node and Electron runtimes, and uploads the measurements. It runs on pull requests that touch the runtime, the storage, shared and server packages, and on manual dispatch.
- Unit tests for the manifest, the installer and the launcher (`tests/desktop-core/runtime-*.test.ts`).

### Changed

- The project-data export column list now has a single source, `PROJECT_DATA_EXPORT_COLUMNS` in `@work-intelligence/core`. The export writer, the backup worker and the import validator all read it; `@work-intelligence/schema` re-exports it as `projectDataExportTableColumns`. The duplicate in `packages/storage` and its drift test are removed. Export output is unchanged.

## [1.6.42] - 2026-11-16

[繁體中文更新說明](docs/releases/1.6.42.md).

This release starts stage 0 of the desktop app plan, which covers contracts and the test foundation. It adds a pure TypeScript `@work-intelligence/desktop-core` package for settings, database source resolution and service ownership, a read-only database preflight that runs before any store that could migrate is built, and a test environment isolated from the real home directory and port 3210. It also trims the cold start of the backup and export worker. It changes no schema; the schema stays at 33 and no migration is needed.

### Added

- `@work-intelligence/desktop-core` (`packages/desktop-core`): a settings store for `DesktopSettingsV1` (`desired`, `active` and `lastKnownGood`) with atomic writes and fail-closed reads; a database source resolver that lists read-only candidates, gives each one a status, and groups candidates by file identity; and the ServiceOwner state machine with a file-backed operation journal and a single in-process `OperationCoordinator`. The package depends only on `zod` and `@work-intelligence/shared`, runs in `pnpm test`, `test:coverage`, `typecheck` and `lint`, and is not bundled into the plugin or the standalone package.
- A file identity helper in `@work-intelligence/shared` that reads the real path and the device and inode of a file without opening or writing it.
- `apps/server/src/database-preflight.ts`: a read-only preflight (`node:sqlite` with `readOnly`, never `immutable=1`) that reports file identity, lineage, schema compatibility and sidecar state, and a `revalidateBeforeCommit` check that re-reads the path, file and lineage before a store opens the database.
- A verified `startApi({ database })` entry that re-validates the database and refuses to create a missing one: it opens the revalidated real path with the new `WorkIntelligenceStore` option `requireExistingDatabase` (a missing file throws `DATABASE_FILE_MISSING` instead of being created) and re-checks the file identity after opening. The CLI behaviour is unchanged.
- A multi-process experiment (`tests/server/old-writer-barrier.test.ts`) that runs old and new writers against one WAL database: MCP stdio, the HTTP API, long-lived Store writers, and processes started after a migration.
- `tests/helpers/isolated-environment.ts`, loaded by every Vitest config. It points the home, app-data and configuration variables at per-file temporary directories, sets the port sentinel to 65533, and fails any listen or connect on port 3210.

### Changed

- The backup and export worker loads a lean entry, `@work-intelligence/storage/backup-export`, which never imports `zod` or `@work-intelligence/schema`. Import preview and the full storage package load lazily. A cold first export in a fresh worker went from a median of 188.5 ms to 64–80 ms, and its p90 from 196.7 ms to 72–90 ms (15 runs). Export output is byte-identical: the SHA-256 of the all-projects export, a single-project export and the import preview are unchanged.
- The export column list is still duplicated in `packages/storage/src/project-data-export-columns.ts`. A drift test keeps the two lists in step. Moving it to a single source in `packages/core` is a follow-up.

### Fixed

- Test suites no longer read or write the real home directory, the agent configuration or port 3210. The server entry-port test that bound 3210, the doctor tests that probed 3210, the Playwright `webServer` environment and the smoke-script environment now use isolated settings.

## [1.6.41] - 2026-11-16

[繁體中文更新說明](docs/releases/1.6.41.md).

This release blocks writes from a process that is older than the database schema, tightens the Host check, reports whether the bundled SQLite carries the WAL-reset corruption fix, and modernises the Windows folder picker. It changes no schema; the schema stays at 33 and no migration is needed.

### Added

- `/api/health` and `/api/system/status` return `sqlite: { version, walResetFixed, fixedIn? }` from `sqlite_version()`. `pnpm check` prints the SQLite version and warns when it predates the WAL-reset corruption fix (3.51.3, backports 3.50.7 and 3.44.6), and the System status page shows a warning. CI, the release workflow and the standalone smoke test print and check the SQLite bundled with Node.js.

### Changed

- Every write transaction, not only MCP writes, now checks under the write lock that no newer process migrated the database. The REST API answers such writes with 503 `server_restart_required`; reads keep working and skip their lazy search-index sync, serving the existing index. MCP still returns `MCP_RESTART_REQUIRED`. The check is cached against `PRAGMA data_version` and `schema_version`, so it re-reads `schema_migrations` only after another connection commits.
- The Host check (DNS-rebinding guard) also requires the port: loopback names are accepted only on the port the server listens on, plus the exact host and port of each allowed origin. An allowed origin on its scheme's default port also matches a Host without a port. The default dev setup (Vite on 5966) is unaffected; a custom `WORK_INTELLIGENCE_WEB_PORT` now needs a matching `WORK_INTELLIGENCE_ALLOWED_ORIGINS` entry.
- Windows: Choose folder opens the modern Explorer-style folder dialog (`IFileOpenDialog`), DPI aware and in front of the browser. It falls back to the classic dialog when the modern one cannot be used.

### Fixed

- Adding or renaming a project, the periodic summary-history prune, Knowledge candidate, report synthesis and metadata backfill request updates, and the read-audit prune now run in write transactions, so they take the write lock and pass the schema check.
- `pnpm db:export --out x.json` (or `--out=x.json`) without `--all` or `--project` no longer writes a full SQLite copy named `--out` into the current directory. Any portable-export option now selects the JSON export, and `--out` alone means `--all`. The positional snapshot form `db:export <file>` refuses names that start with `-`. The shared argument check (`cli-args.ts`) now also refuses a valued option with a missing or empty value (a trailing `--project` used to import every project), an empty argument (`db:export ""`) and a lone `-` or `--`, and its errors say to write `./-name` or `--option=-value` for a path or value that starts with `-`; the `track`, `import`, `restore` and `backups --delete` commands use it, and every failure path writes nothing.

## [1.6.40] - 2026-11-15

[繁體中文更新說明](docs/releases/1.6.40.md).

This release updates dependencies only. It changes no behaviour and no schema; the schema stays at 33 and no migration is needed.

### Changed

- `vue-router` 4.5.0 to 5.5.0. The web app uses no file-based routing, so no code changed.
- `vite` 6.3 to 6.4.6. `vue-router` 5 brings `vite` into the production dependency path, and versions up to 6.4.3 carry a high-severity advisory (GHSA-587h-7wmj-h5pm).
- `pinia` 4.0.3 to 4.1.0, `@vitejs/plugin-vue` 5 to 6, `tsx` 4.23.13 to 4.23.15.
- `prettier` 3.9 to 3.10; five Vue templates are reformatted.
- `@types/node` 22 to 24, matching the Node version CI and releases already use.

## [1.6.39] - 2026-11-15

[繁體中文更新說明](docs/releases/1.6.39.md).

This release stops bulk changes from marking Knowledge as possibly stale on their own, reports wide `appliesTo` patterns as weak signals, and makes retrieval say how much Knowledge it actually found. It changes no schema; the schema stays at 33 and no migration is needed.

### Changed

- Knowledge staleness ignores bulk changes on its own: a later Session that listed more than 20 changed files no longer sets `possiblyStale`. It is counted in the new `broadChangesSince`, and `possiblyStale` (its first Session, paths and `sessionCount`) looks only at Sessions with 20 or fewer files, as the co-change, related-work, hotspot and inferred-path features already do. The baseline is the later of creation and last confirmation.
- `possiblyStale` carries `reason` (`applies_to_changed` or `broad_applies_to`) and `appliesToBreadth { share, sessions }`: when an `appliesTo` touches more than 15% of the project's newest 200 ordinary Sessions (at least 10; the same breadth as at write time, not only the Sessions after the baseline), the marker says it is a weak signal.
- `work_record_knowledge` and `work_update_knowledge` (when `appliesTo` changes) report `appliesToBreadth { share, sessions, truncated, broad }` over the project's newest 200 Sessions with 1-20 files, and warn when the `appliesTo` is broad.
- `recall` and `getContext` report `knowledgeConfidence`, the `none`, `low` and `high` rule applied to Knowledge hits only. `relevant.confidence` still combines Sessions and Knowledge. `getContext` adds `knowledgeHint` when no Knowledge matched.
- `work_search_knowledge` returns `termHits` when a query has no match in scope, names an all-zero query in its hint, passes `appliesToScanTruncated` through for a scoped search, and returns `effectiveQuery` whenever the query was cut.
- Knowledge matched only through a synonym carries `matchedVia: "synonym"`. MCP `work_recall` keeps up to four `matchedIn` fields, and `work_search` no longer fills `matchedIn` with `title`.
- Compact Knowledge entries keep `possiblyStale: true` and add `staleReason` and `broadChangesSince` when present. `appliesTo` matches in recall honour `from` and `to`.
- Web: Knowledge rows show the weak signals (`broad_applies_to` and `broadChangesSince`) as secondary text. Knowledge touched only by broad changes shows no possibly-stale label. Saving an `appliesTo` that the backend measures as broad shows a warning, and a rejected restore says the item was replaced.

### Fixed

- `termHits` no longer reports false misses: a query with more than 32 terms reports `termHitsTruncated` and leaves out the terms past the cap, and a non-CJK compound word counts as matched when any of its parts matched, as ranking does.
- Malformed `changed_files_json` (non-JSON text, `null`, an object, or a list with non-string entries) is read as an empty list everywhere. The derived graph, `getContext`, related work, hotspots and the review hint no longer throw on such rows.
- Knowledge page sections match a Chinese task by character pairs.
- A backfilled finalize no longer moves `lastConfirmedAt` or `lastConfirmedSessionId` backwards; the `applied` feedback is still recorded.
- Restoring an archived Knowledge that an active Knowledge supersedes is rejected (`outcome: "rejected"`, `reason: "superseded_by_active"`) instead of leaving two active versions. `updateKnowledge` now runs in one write transaction.
- A manual confirmation is documented as written by the Web UI or by an Agent through `work_update_knowledge` with `confirm: true`.

### Added

- A feasibility study, `docs/experiments/retrieval-trust-feasibility-2026-11-15.md`, and its probe, `docs/experiments/retrieval-trust-probe.mjs`. The study's figures come from one private project measured at research time; they are not measurements of this release.

### Upgrading

No schema change (33) and no migration. Rebuild and restart, then have Agents reconnect once to see the new tool descriptions. `possiblyStale` becomes less frequent, MCP responses gain optional fields, and `work_update_knowledge` can return `outcome: "rejected"` with `reason: "superseded_by_active"` when a restore is refused.

Not verified yet: the end-to-end runs and the before-and-after comparison on real data, which the coordinator runs.

## [1.6.38] - 2026-11-14

[繁體中文更新說明](docs/releases/1.6.38.md).

This release restores the green marker for confirmed Knowledge on the Work graph timeline. It changes no data, no API and no MCP behaviour; the schema stays at 33.

### Fixed

- Work graph timeline: a confirmed Knowledge event is a green diamond again, and the legend lists confirmed and superseded separately. Superseded stays an open diamond and contradicted stays a cross.

## [1.6.37] - 2026-11-14

[繁體中文更新說明](docs/releases/1.6.37.md).

This release restores the verification colors on the Work graph timeline, which 1.6.36 had turned gray. It changes no data, no API and no MCP behaviour; the schema stays at 33.

### Fixed

- Work graph timeline: Session bars and day columns again take the color of their verification result (passed is green, failed is red, in progress is blue, not run or not provided is muted), and the legend lists the four results again. The 1.6.36 layout stays: weekend shading, the fixed project name column and the Knowledge event shapes.

## [1.6.36] - 2026-11-14

[繁體中文更新說明](docs/releases/1.6.36.md).

This release restyles the Web UI: refined tokens in the existing blue, no uppercase English eyebrow labels, and redesigned Overview, Work history, Work knowledge, Work graph and Work reports pages. Layout and scroll behaviour do not change. It changes no data, no API and no MCP behaviour; the schema stays at 33.

### Changed

- Overview: the activity heatmap stays at the top and keeps its 53 weeks. A "This week's loop" strip shows Sessions recorded, new Knowledge, Knowledge pages updated, and confirmations and contradictions, using only counts the product records. The completed-this-week card gains an eight-week trend.
- Work history: a time rail, a whole-day summary per day and a count of new Knowledge per day.
- Work knowledge: the trust bar is drawn from confirmations and contradictions only. The reason an item may be stale moves under its title, tags are quieter, and a kind breakdown shows counts for the current project and status.
- Work graph timeline: neutral day bars with failed work in red, new Knowledge as accent diamonds, confirmed and superseded events as open diamonds, weekend shading when days are wide enough, and project names in a fixed left column.
- Work reports: daily columns, a one-line banner when no synthesis exists yet, a project share bar stacked by project, and a timed list of what happened.
- Projects, System status, the Session panel and the graph's relationship and hotspot views follow the same appearance rules. No page layout changes.
- Visual system: refined tokens with a surface layer, two radius steps, an on-accent text colour and a tab underline in the accent colour. Keycaps share one style. Sidebar group labels follow the interface language.
- Shared UI components replace hand-written copies: side panel header, stat grid, split layout, stack, a link variant of `UiButton`, `UiStatCard` and `UiMeter`.

The design check method draws on unslop by Damir Sokolovsky (CC BY 4.0). Only the ideas were borrowed; no code was used.

### Fixed

- The reminder text in the Overview insights used an undefined colour token (`--fg-attention`), so its colour never applied. It now uses a defined colour.
- Graph timeline labels were 10px, below the 12px minimum. They are now at least 12px.
- Subtle text in the dark theme has more contrast.
- Project export and import controls and the report toolbar controls share one control height.

### Upgrading

No schema change (33) and no migration. Rebuild and restart. Data, API and MCP behaviour are unchanged; only the appearance and text change. The README screenshots were retaken with fictional sample data.

## [1.6.35] - 2026-11-14

[繁體中文更新說明](docs/releases/1.6.35.md).

This release makes accessible names match the text people can see (WCAG 2.5.3 Label in Name), extends the axe checks to dialogs, open menus and the mobile sidebar in both interface languages, makes the timing-sensitive tests steadier, and refreshes dependencies. It changes no data and no schema; the schema stays at 33.

### Accessibility

axe-core 4.14 reports `label-content-name-mismatch` as serious. The fixes below make the accessible name start with, or contain, the visible text.

- Architecture diagram node buttons no longer use `aria-label`. Their names come from the visible label, the description, the group and the file name.
- The header search button's name comes from its visible text. The shortcut is exposed through `aria-keyshortcuts`, and the `kbd` is `aria-hidden`. On narrow screens the text is visually hidden instead of `display: none`, so the name never becomes empty. The header logo is "WI" plus a visually hidden "Work Intelligence home" instead of an `aria-label`.
- Graph canvas nodes draw the label and description as one text run with a real space between them, so the visible text is contained in the name. English words previously ran together.
- The Knowledge evidence button, the changed-file "Open in editor" link and the outstanding item source-Session button have names that start with their visible text.
- Calendar day buttons are named by the long date in the interface language (for example "November 5, 2026" or "2026年11月5日") instead of an ISO string.
- Form controls have names equal to their visible field labels: the system status editor select, the backup export and import selects, the Knowledge editor kind and status, and the delete-project confirmation input. The delete confirmation now uses a field label, with the project name as its hint.
- `UiTextInput` no longer renders a nested `<label>` inside `UiField`. Inputs inside fields had no label (axe `label` rule).
- Days outside the current month no longer use opacity, so they meet WCAG AA contrast.
- The sidebar icon rail (640–959px) keeps its link names by visually hiding the labels instead of using `display: none`.

### Added

- New E2E spec `tests/e2e/accessibility-states.spec.ts`. It runs axe (critical and serious rules) on the command palette, the Session side panel, the Session editor, the Knowledge editor and delete-project dialogs, open menus (language, project filter and date range calendars), and the mobile sidebar drawer, in both zh-TW and en-US. It also checks the primary pages in en-US.

### Changed

- Dependency updates. Already merged to main: `@pinia/colada` 1.4.9, `eslint` 10.14.0, `@modelcontextprotocol/sdk` 1.32.2 and `vue-tsc` 3.3.14. On this branch: `@axe-core/playwright` 4.14.0 and `smol-toml` 1.9.1 (Dependabot PR #350); the TOML tests for agent setup, doctor and plugins pass.
- Timing-sensitive tests are steadier. The shared helper `tests/helpers/timing.ts` scales fixed millisecond limits by a same-size reference workload timed in the same process. The factor is clamped between 1 and 8 and never goes below the written limit. It applies to the handoff parser and both secret-redaction linear-time tests, and the doubling-ratio checks interleave half-size and full-size runs. A temporary quadratic regression was confirmed to fail the tests. No threshold was loosened.

### Upgrading

No schema change (33) and no migration. Rebuild and restart. Not verified yet: the verification run listed in [docs/releases/1.6.35.md](docs/releases/1.6.35.md).

## [1.6.34] - 2026-11-14

[繁體中文更新說明](docs/releases/1.6.34.md).

This release is a security hardening pass. It tightens the permissions of the local database, widens secret redaction, stops imports from overwriting rows owned by another project, rejects over-deep JSON with a clear error, makes the handoff parser and file reads linear and safe on adversarial input, and pins every CI action to a commit. It also adds a manual release trigger. The schema stays at 33.

### Security

- Local database files are private on POSIX systems. A newly created data directory is 0700, the database file is created 0600 before SQLite opens it, and the `-wal` and `-shm` files inherit that mode. An existing database, `-wal` or `-shm` file owned by the current user and accessible to its group or others is narrowed to 0600 on open; a failure there is ignored. `pnpm check` (doctor) warns with 資料庫檔案權限 when the database file or its folder is accessible to other users, but it changes nothing. Windows is unchanged.
- Secret redaction covers more forms. Keyed assignments now match prefixed environment names (`DB_PASSWORD=`, `GITHUB_TOKEN=`), camelCase keys such as `accessToken`, JSON key and value pairs, and quoted values with spaces. New detectors cover `Authorization` headers (Bearer, Basic and Token, including `curl -H`), `Cookie` and `Set-Cookie`, Stripe, GitLab, npm, SendGrid, Google, Slack and Hugging Face tokens, Twilio keys, Azure keys, connection-string passwords, signed URL query parameters, PGP and PuTTY private key blocks, and AWS access key identifiers and secrets. On a fictional corpus of 113 secret-like strings, 29 were masked before and 113 after; 73 benign strings stayed unchanged. Some values are deliberately kept: `credential` and `credentials` keys match only as a whole key or a `_`, `-` or `.` suffix (so `withCredentials` is not a secret); an unquoted literal (`true`, `false`, `null`, `nil`, `undefined`, `none`, `0` or `1`) followed by `,`, `;`, `)`, `}`, `]` or the end is kept; an unquoted type annotation (a type name such as `string`, `number`, `boolean`, `unknown`, `Buffer`, `str` or `bytes`, optionally with `[]`, `?`, `|` and other types or `null`, or a trailing `=`, as in `password: string | null` or `secret: Buffer`) is kept, and an unquoted value also ends at a backtick or full-width punctuation (`、`, `，`, `；`), so `` `password: string`、`fileName: string` `` is not read as one value; a key followed by a closing quote, spaces and the next attribute name (`password" :aria-label=`) is not an assignment; placeholders such as `[[...]]`, `[REDACTED...]`, `<...>`, `${...}`, `{{...}}` and all-asterisk values are kept; and re-redacting redacted text changes nothing. A bare JSON `"token"` key is masked only when its value looks like a credential, so a JSON `"token"` secret shorter than 12 characters, with a single character class, or letters-only and shorter than 24 characters is not masked; other keys such as `access_token`, `api_key` and `password` are unaffected. Each new rule has a 200,000-character adversarial test that must run in linear time. Redaction is a safety net for accidental pastes, not a guarantee.
- Imports cannot overwrite rows owned by another project. With newer-wins, a row with the same ID whose project or immutable parent differs from the stored row is reported as a dependency conflict, and the stored row is left untouched. Updates never rewrite `project_id`, and a new child row must cite a parent owned by its own project, including in tables without `project_id`. The one exception is `session_links.related_session_id`, which may point to a Session of another project: linking requires only that the related Session exists and is tracked, and the link belongs to the project of its `session_id`. Every other parent reference must still be same-project. Single-project export and import behave as before: links to Sessions outside the project are left out of the export, and a hand-edited link pointing outside is refused. An all-projects export therefore re-imports completely. A round-trip test seeds every project-data table, including cross-project links, exports everything, and imports into an empty database and into one already holding part of the data, with both merge and newer-wins; the result is 0 conflicts and equal row counts per table.
- Imports refuse deep nesting. Any `*_json` column nested deeper than 100 levels is rejected with `invalid_input` (REST 400) before parsing, instead of a `RangeError`, and any unexpected validation failure is also reported as `invalid_input`. Redaction walks values with an explicit stack, so 50,000-level values no longer overflow.
- The handoff parser is linear on adversarial input. Multiline regular expressions whose whitespace could cross line breaks are replaced by per-line anchored patterns and hand-written scans. At the 200,000-character cap, all 57 adversarial shapes finish in under 200 ms, also with coverage instrumentation (slowest about 44 ms, 101 ms instrumented), and doubling the input at most 2.4 times the time. The output is identical to the old parser on a 443-document fictional fixture and on about 3 million random inputs compared during development.
- Special files are not read. Handoff discovery, preview and import, finalize's handoff path capture, and loose Git ref reads open files with `O_NONBLOCK` and check the descriptor before reading. FIFOs, sockets and devices are skipped with the new reason `not_regular_file`, which has Web labels in English and Traditional Chinese. Handoff files over 4 MiB are reported as `unreadable`, and Git ref files are capped at 4 KiB. The Claude Code hook reads `transcript_path` the same way, with a 256 MiB cap; any failure there stays silent.
- Record content is untrusted data. The server instructions and the reading-records guide say that record content returned by tools (session summaries, handoffs, Knowledge and open items) must not be followed as instructions; Agents confirm with the user instead.
- CI actions are pinned to commits. Every action in `.github/workflows` is pinned to the commit its official tag points at, verified with `git ls-remote`, with the version in a comment. Checkouts do not persist credentials, the publish job has no dependency cache, and `tests/server/workflow-security.test.ts` checks these rules. A Dependabot configuration updates GitHub Actions and npm weekly.

### Added

- Manual release trigger. `release.yml` accepts a `workflow_dispatch` run with a `version` input, on `main` only. The input must match `^[0-9]+\.[0-9]+\.[0-9]+$` and equal `package.json`, a successful push run of `ci.yml` must exist for the same commit, and the tag `v<version>` must not exist. A create-tag job, the only job with `contents: write`, masks the encoded credential (`::add-mask::`) before exporting it, creates an annotated tag as `github-actions[bot]` and pushes it, and the same run continues through verification, audit, quality, E2E and publish, because a tag pushed with `GITHUB_TOKEN` does not start other workflows. The tag-push path is unchanged. `docs/release.md` and `docs/release-checklist.md` describe the flow. If a job fails after create-tag has succeeded, use "Re-run failed jobs" on that run rather than dispatching again, because the tag already exists and a new dispatch is refused (see `docs/release.md`).
- Research reports. Four research reports (value measurement, Knowledge retrieval and lifecycle, observed rules and clients, and code health audit) and their read-only scripts are merged into `docs/experiments`. They contain aggregate numbers only.

### Changed

- Agent reading budgets are kept. Duplicated sentences were removed from the server instructions and the reading-records guide to make room for the untrusted-data rule. The fixed Agent reading is now 42,161 of 42,250 characters, the core skill 13,981 of 14,000 (unchanged), and the reading-records guide 8,982 of 9,000. No limit was raised.

### Upgrading

No schema change (33) and no migration. Rebuild and restart, then reconnect Agents so they see the new instructions. Exports and existing data are unaffected, except that old exports with details nested deeper than 100 levels are now refused on import. An existing data directory with mode 0755 is not tightened automatically, and `pnpm check` warns about it. The service log written by `scripts/service-runner.mjs` still uses the default file mode; it holds no work-record content. Not verified: Windows (the permission code is POSIX-only and skipped there, and the FIFO tests are skipped), real Agent clients with the new instruction, a manual release dispatch on GitHub (not run yet, and tag rulesets with `GITHUB_TOKEN` are untested), and actionlint (not available). Redaction does not detect URL-encoded, base64-wrapped, split-line, zero-width or full-width look-alike secrets.

## [1.6.33] - 2026-11-13

[繁體中文更新說明](docs/releases/1.6.33.md).

This release follows measurements on a copy of real data (650 Sessions in six projects). It adds the server-observed change statuses, Knowledge pointers for task-only context calls, focused reads of Knowledge pages, and several fixes to the CLI, the save hooks and the Git lookups.

### Added

- Server-observed change statuses. A `work_finalize_session` call that lists a path in `changedFiles` without a `changedFileChanges` entry for it gets the status from Git: `added`, `modified`, `deleted`, or `renamed` with `previousPath`. Git is asked only for a tracked project, when the call has no `completedAt`, and not on a retry with the same `idempotencyKey`. The lookup runs in at most three Git processes with a 1.5-second timeout, outside the write lock. An Agent-reported status always wins. Each status the server fills is recorded as a `note` event with `source: "server_observed_git"`, and the receipt returns `changedFileChangesSource: { serverObservedGit: <count> }`. A path Git does not report gets no status: the receipt returns `changedFileChangesFollowUp` and a `suggestedCall` to `work_update_session_metadata` with `changedFilesMode: "merge"`. A failed lookup only skips the observation; the save still succeeds.
- Knowledge pointers for task-only context. `work_get_context` with `task` and no `paths` may return up to three `relevant.supplements` entries with `includedBecause.kind: "inferred_path"`. Each is an active Knowledge item whose `appliesTo` or references cover files changed by the most similar Sessions, and at least two distinct similar Sessions must support it. The pointer names the inferred file and up to two source Sessions to read first. It is a pointer, not evidence. Pointers use only budget left after the normal response, and calls with `paths` or without `task` are unchanged. On 5,000 synthetic Sessions the task-only call has a median of 55 ms and a p90 of 62 ms with inference on (gate 250 ms).
- Focused Knowledge page reads. `work_get_knowledge_page_context` accepts `query` (up to 200 characters) and `headings` (up to 12, from `relevant.knowledgePages` or a previous `otherSections`). A focused read returns the matching sections in full with their `sourceSessionIds`, the page metadata, and `otherSections` (heading and length of every other section, in page order). It returns no Session list and sets `sessionsOmitted: true`. A query term matches a whole token, or a token prefix when it has at least four Latin characters. On real pages the median full read is 14,648 characters (maximum 30,705), a focused read by heading 1,334 (maximum 2,927) and by query 1,437 (maximum 5,357).
- Search hints for `work_search_knowledge` when the strict search finds nothing. `otherStatusFullMatches` counts the records in other statuses that contain every word, so a re-query with that `status` answers strictly. `effectiveQuery` appears when the strict search cut the query (more than eight words, or an over-long word) and is the exact query the counts were computed with. `queryTruncated` marks a relaxed ranking that reached its term or path-word limit.
- `pnpm test:start-smoke` (`scripts/smoke-start.mjs`) starts the real `pnpm start` entry against a temporary database on a free port, checks `/api/health` and the Web UI, and checks that the process exits and releases its port on SIGTERM. CI runs it in every OS Quality job after the build.
- `docs/experiments/task-path-replay.mjs` is rewritten as a read-only replay with `--db` and `--project` options and a `--self-check` on a synthetic database. It prints aggregate JSON only. See `docs/experiments/task-path-replay.md`.

### Changed

- `work_update_session_metadata` applies the `changedFiles` merge rules to `changedFileChanges`. With `changedFilesMode: "merge"`, a status replaces the stored status of the same path, and a rename replaces the entry for its `previousPath`, so a correction never leaves two statuses for one path. With `"replace"`, a call that sends `changedFiles` without `changedFileChanges` keeps only the stored statuses of paths still listed.
- Knowledge page sections in `relevant.knowledgePages` are excerpted around the matched terms instead of their first characters. The excerpt keeps the densest cluster of matched terms and cuts at a sentence or word boundary.
- The Claude Code start-time pause also asks for change statuses. When a save sends `changedFiles` without `changedFileChanges`, the pause asks the Agent to add each file's status from the real diff. The hook never reads Git.

### Fixed

- `pnpm db:export --help` no longer writes a snapshot to a file named `--help`. Before any `db` or `track` command acts, option-like arguments are checked: `--help` and `-h` print the subcommand's usage and exit with 0, and an undeclared option, or a valued option whose value looks like an option (`--out --foo`), is refused with the usage on stderr and a non-zero exit. `db:backup` rejects extra arguments.
- Imported project roots are stored in the canonical key that every other writer and lookup uses. On Windows, an imported project with a mixed-case folder was missed until the next startup repair. A root that is not absolute on the current platform (a Windows path in a bundle imported on Linux, or the reverse) is kept as written.
- The branch and HEAD commit are now read in linked worktrees (where `.git` is a file) and when refs are packed. Loose `.git` files still answer the common case without a subprocess. Git is asked only when they cannot, and only for a root that is itself a checkout.
- `structuredContent` no longer claims a save that did not happen. A `work_finalize_session` result without a Session (`skipped` for a paused or unregistered project, `idempotency_conflict`, `not_found`) carried the defaults `executionStatus: "completed"`, `changedFilesCount: 0` and `sessionId: null`; Claude Code and Codex hand the model `structuredContent` alone, so the Agent could read a skipped save as completed. Such results are now passed through unchanged. A `session_unchanged` answer from `work_get_session` keeps the `session` fields the text has.
- The Claude Code save hooks ignore a failed `Edit`, `Write`, `MultiEdit` or `NotebookEdit` result, and use the most specific tracked project root when tracked roots are nested.

### Upgrading

No schema change (33), so no migration; exports and existing data are unaffected. Build and restart as for 1.6.32, and reconnect Agents so they see the updated tool descriptions. The Claude Code change-status flow was verified with the real `claude` CLI in four scenarios. Codex was not verified with a real client, because no CLI was available, and the Windows-specific behaviour (path handling in the E2E fix, CLI arguments, import roots) was not run on real Windows. The Claude Code hook counts only changes made with `Edit`, `Write`, `MultiEdit` and `NotebookEdit`; changes made by Bash commands are not seen. Whether Agents read or use the inferred pointers is not measured: only one project has enough data, and a pointer in a response does not mean the Agent used it. At 20,000 synthetic Sessions the task-only `work_get_context` p90 is about 263 ms with or without inference; this cost was already there and is not addressed in this release.

## [1.6.32] - 2026-11-13

[繁體中文更新說明](docs/releases/1.6.32.md).

This release follows measurements on a copy of real data (647 Sessions in six projects). It keeps the product loop unchanged (record what matters, bring it back when it applies, correct it afterwards) and fixes where that loop was measurably leaking.

### Added

- Start times no longer need a reminder from the user. Claude Code's plugin adds a PreToolUse hook: a save that names neither `startedAt` nor `completedAt` is paused once per segment with the start time read from the transcript, and the Agent retries with it. Codex states the start time at the first prompt of a segment and has a matching PreToolUse guard. When an Agent still omits `startedAt`, the MCP server uses the first tool call it observed for that project since the last save: the receipt labels it `startedAtSource: "server_observed"`, a note event records it, a value older than seven days is not used, and a backfill that passes `completedAt` never uses it. A save left without a start returns `startedAtFollowUp` and a `suggestedCall`. Nothing is estimated.
- `work_update_session_metadata` accepts `completedAtNow: true` (the server records its own current time; mutually exclusive with `completedAt`) for a Session that was continued and has now finished, and accepts an omitted `changedFiles`, which leaves the stored files, provenance and changes untouched. Before, a time-only correction had to resend the file list, and `[]` cleared it.
- `work_resolve_outstanding_items`: a finalized Session closes, in one call, pending items of earlier Sessions that its work verified, also after finalize. Every rule is rechecked in one transaction and the event records that Session as the actor. `work_get_context` accepts `linkedSessionIds` and returns `relevant.continuedOutstandingItems`, and the finalize receipt returns `continuedOutstandingItems`: the pending items of the same-project Sessions being linked (up to 10, kept out of `relatedOutstandingItems`).
- `work_request_outstanding_cleanup`: an Agent starts 整理未結項 when the user asks, without a round trip through Web. Accepting or rejecting proposals stays in Web.
- Outstanding item lists expose `closedBy` (`source_session`, `later_session`, `user`, `cleanup_review`, `migration`), derived from existing events, with a REST filter, Web labels and a filter that hides removals by the source Session.
- `pendingRequests.knowledgeBacklog` in a project-scoped `work_get_context` (`uncoveredSessions`, `highValueSessions`, `requestWith`), shown only when the project has no open request, at least five high-value uncovered Sessions and no request in the last seven days. `work_request_knowledge_candidates` returns `remaining`; the candidates list and the Web candidates box show the backlog.
- Read-only experiment scripts with synthetic self-checks that print aggregate numbers only: `docs/experiments/outstanding-items-probe.mjs` and `docs/experiments/knowledge-reuse-attribution.mjs`.

### Changed

- `work_recall` and `work_get_context` match Knowledge `appliesTo` against the queried `paths` (at 0.85 of a `references` match, inside the existing bounded scan), keep up to three places for path-matched Knowledge on files with many Sessions, and list path-matched Knowledge that does not fit as pointers with a title and the matched path. Character budgets are unchanged and calls without `paths` behave as before. On the real-data replay, for later Sessions that changed a file an active Knowledge item applies to, a call with those paths returned the full item in 67.1% of 337 cases instead of 3.3% (a pointer in 29.7%, nothing in 3.3%), and the mean response length changed by less than 0.5%. When the response is at its limit, lower-ranked Knowledge page sections, recent lists and later Sessions give way before these pointers lose their title and path.
- Knowledge candidate requests pick the ten uncovered Sessions with the strongest recorded signals (confirmed decisions, a failed verification later passed, later Sessions linking to it, deliberate re-reads) instead of the ten newest, so older uncovered Sessions are reached. A failed request is now listed in `pendingRequests` instead of silently blocking new ones.
- An outstanding item keeps its identity when its own Session rewords the `nextSteps` entry (character-bigram similarity of at least 0.5, paired one to one): the item is updated in place instead of being closed as `not_needed` and recreated. `work_update_session_work_summary` reports `outstandingItems` counts when anything changed.
- The work record contract keeps in-task progress (uncommitted changes, a PR awaiting merge, CI running, a phase not started) out of `nextSteps`.
- A `startedAt` correction now leaves a note event, like a `completedAt` correction. The skill tells Agents to pass `agentModel` when their system prompt states it.
- Knowledge staleness results are reused while the data revision is unchanged; warm `work_recall` and `work_get_context` with paths are as fast as in 1.6.31 on 5,000 synthetic Sessions (about 11 ms and 50 ms). `resolveStartedAt` scans events once instead of sorting them.
- `doctor` recommends adding the PreToolUse hook when only that hook is missing.
- Tests and budgets: the largest operation contract may be 12,500 characters (12,000) and the fixed Agent reading 42,250 (41,500) for the two new operations and the new parameters; the core skill stays within 14,000.
- Docs: `docs/mcp-tools.md`, `docs/rest-api.md`, `docs/agent-setup.md`, `docs/user-guide.md`, `docs/testing.md`, `docs/plugins.md`, `docs/troubleshooting.md`, `docs/status.md`, the work-intelligence skill and its guides.

### Fixed

- `DataRevisionCache.getMany` wrote a whole batch even when it exceeded the cache limit.

### Upgrading

No schema change (33); exports and existing data are unaffected. Reinstall or refresh the plugin, or run `pnpm setup:agents` for a manual setup, to get the PreToolUse hooks; `pnpm check` reports when they are missing. Reconnect Agents so they see the new operations and tool descriptions. The hooks are covered by unit tests only and were not exercised in a real Claude Code or Codex client. In Claude Desktop several conversations can share one MCP process, so a server-observed start can predate the current conversation; it is labelled and capped at seven days.

## [1.6.31] - 2026-11-13

[繁體中文更新說明](docs/releases/1.6.31.md).

### Fixed

- A projected `work_get_session` read (`view` or `select`) returned its body only in the text content, next to a `structuredContent` that held identity and status fields alone (outcome, sessionId, projection, status, executionStatus, verification, changedFilesCount). A client that hands the model `structuredContent` instead of the text when both are present therefore showed the Agent no summary, workSummary, decisions, files or links. This was seen in the Claude desktop app's Code tab: 21 handoff and select reads in one conversation came back without a body and had to be repeated as full reads. Since 1.6.18 the server instructions, the contract and the skill make `view: "handoff"` the default read, so the cheaper read cost an extra full read in such a client. A projected read now answers in text only, with no `structuredContent`: every client gets the body, and it is still sent once. Full reads, `session_unchanged`, the finalize receipt and the Session update receipts keep their `structuredContent`, which already matches their text. Other clients (Claude Code in a terminal, Codex, the Claude Desktop extension) were not checked.

### Changed

- Tests: `tests/mcp/session-projection.test.ts` now requires that every part of a handoff result a client may hand to the model (the text, and `structuredContent` when present) carries the body on its own, and that projected reads have no `structuredContent`; it used to require the metadata-only `structuredContent`. `tests/mcp/result.test.ts` covers the same rule for `textResult`.
- Docs: `docs/mcp-tools.md` (projected reads answer in text only), `docs/status.md`.

### Upgrading

No schema change (33). An MCP client that read `structuredContent` of a projected `work_get_session` result must read the text content instead; the text is unchanged. Agents connected through the launcher switch to the new build without reconnecting.

## [1.6.30] - 2026-11-12

[繁體中文更新說明](docs/releases/1.6.30.md).

### Fixed

- The pre-import snapshot of 1.6.29 was written before the import was planned, so an import that changed nothing (every row already present) or that failed while planning (for example a selected project that is not in the file) still wrote one, and three such attempts pushed out the snapshot of an earlier import that really changed data. The import now plans first, from a read snapshot, and writes and checks the snapshot only when the plan adds, updates or renumbers at least one row, still before the write transaction and still failing closed. An import that changes nothing writes no snapshot, returns no `backupFileName` and reports the new result field `changed: false` (`true` when rows were written); the CLI and the Web say that nothing was changed. When the database changes between planning and the write lock so that the plan made again under the lock now writes rows, the import releases the lock without writing, writes the snapshot and tries once more; the second attempt always backs up first, so there are at most two. The owner's export still imports into a fresh database with 4,344 rows, 0 conflicts and one snapshot; importing it again adds nothing and writes no snapshot.

### Changed

- `work_recall` now places a returned Knowledge item directly above its own source Session (the Session it was recorded from, in the same project) when that Session ranks higher. The Knowledge item is the reviewed statement of what the longer record says. Only the order of the hits already selected changes: scores, confidence, which hits are returned and their number stay the same. On a copy of real data, for 18 queries whose answer is an active Knowledge item, the item ranks first in 17 instead of 9 (none of the 9 lost); 11 of 56 queries change order, each only by this rule. `pnpm test:retrieval-quality` metrics are unchanged (25/25).
- Benchmark: `importProjectData (all projects, already present)` now checks that nothing changed and no snapshot was written; p90 580–604 → 414 ms (limit 1,500 ms).
- Docs: `docs/mcp-tools.md` (recall order), `docs/rest-api.md`, `docs/user-guide.md` and `docs/troubleshooting.md` (when the import snapshot is written; restoring it also discards anything written after it), `docs/testing.md`.

### Upgrading

No schema change (33). The import result has the new field `changed`; `backupFileName` is absent when nothing changed.

Coming from 1.6.14 or earlier: read "Upgrading from 1.6.14 or earlier" under 1.6.27 below first. It lists every change since 1.6.14 that an existing Agent, REST client or exported file can notice (schema 33 and its migration, which exports import, strict REST input, receipts instead of echoed Sessions, the report block sent once, the new error codes). Coming from 1.6.8 or earlier (schema 31), also read the 1.6.9–1.6.14 entries. Since that note was written, 1.6.29 added the safety snapshot before an online import, the `missing_parent` conflict category and the import running in the background worker, and this release the `changed` field and the recall order above.

## [1.6.29] - 2026-11-12

[繁體中文更新說明](docs/releases/1.6.29.md).

### Fixed

- An online project-data import (Web, `POST /api/import` and `pnpm db:import`) wrote no backup: once committed, the only way back was the daily backup. It now writes and checks a `pre-import-` snapshot (backup kind `import`) before it writes anything and returns its `backupFileName`; when the snapshot cannot be written the import does not run and REST answers 503 `project_backup_failed` (a busy, read-only or full database keeps its own code). Import snapshots keep their own group, as many copies as automatic backups (3 by default), so repeated imports never push out manual, deletion or migration backups. A preview writes nothing. If the import fails halfway, the database is unchanged and the snapshot stays.
- Rows whose project, Session, report request or report summary is not in the file were dropped without a word: with one of 5,000 Sessions pointing at a missing project, 4,999 were imported and the counts did not mention the other. Such rows are now counted as conflicts per table, with a reason, under the new category `missing_parent` in the preview, the result and the Web preview ("Missing from the file"). The rows imported are the same; a row already stored here unchanged counts as skipped, and rows of a project in the file that was not selected are out of scope as before.
- `POST /api/import` parsed, validated and imported on the API thread, so every other request and the SSE stream waited: at 5,000 Sessions `/api/health` stalled 1,453 ms, at 20,000 5,574 ms. The background worker that already ran the preview now runs the whole import (parse, validation, backup, plan, write and the search-index sync), through a write connection opened in a new `existing` store mode that never migrates; the worst `/api/health` latency during the same imports is 7 ms and 13 ms. The plan is made from a read snapshot and the write lock is held only while rows are written: the write transaction checks that `data_revision` has not changed since planning and plans again under the lock when it has. Write transaction at 5,000 / 20,000 Sessions: 670 / 2,440 ms → 280–390 / 1,260–1,310 ms; the search-index sync after it is its own transaction of about 420 / 1,700 ms, as before. The CLI import stays synchronous.
- A preview or import validated the whole file four times (route or worker, sanitizing, and twice more in the planner). It is now validated once, into a `ValidatedProjectDataImport` that only validation can create and the planner requires, so an unchecked bundle cannot reach it; the CLI validates the file once and re-validates only the options when the user picks a new folder. The validator also no longer rebuilds two column sets for every row. Every rule still runs exactly once on every entry path (a test feeds each invalid-file class through the store, REST inline and through the worker, and `db:import`). Preview at 5,000 / 20,000 Sessions into an empty database: 718 / 2,426 ms → 325 / 973 ms, peak RSS 188 / 455 MiB → 160 / 345 MiB; into a database that already holds the data 737 / 3,178 ms → 408 / 1,356 ms.
- An unreadable import file, or one that is not JSON, showed the browser's untranslated reason in the Web; both now show a translated message.

### Changed

- Export: the portable redaction ran eleven regular-expression passes over every stored string and copied every row. Each rule now runs only when the text contains a literal it needs, and a row or Session is copied only when its text or count changes. The exported bytes are identical (compared on a real data copy and the 5,000-Session benchmark database). `exportProjectData` for the 5,000-Session benchmark data 155 → 83 ms in process; benchmark p90 334 → 245–300 ms (limit 400 ms). `exportTo` is SQLite's `VACUUM INTO` plus `quick_check` and the download; it is unchanged.
- Benchmark: `importProjectData (all projects, already present)` (1,500 ms), the whole online import through the worker with the API's event-loop gate.
- The 1.6.28 figure for reaching the staleness history ceiling ("at most 2.4 s and 380 MB") holds for the longest paths too: Sessions of 200 distinct 1,000-character paths reach it after about 800 Sessions in 1.6 s with a 330 MB peak process RSS (the 0.7 GB estimated in review did not occur). A regression test now checks that a page of 50 whose items each name a directory with 4,000 later paths and one of its subdirectories is fully decided: 84M match units, above the 50M ceiling first chosen and under a third of 300M.
- Docs: `docs/rest-api.md`, `docs/user-guide.md`, `docs/troubleshooting.md` (the import backup, `missing_parent`), `docs/architecture.md` (the import worker), `docs/mcp-tools.md` and `docs/testing.md`.

### Upgrading

No schema change (33) and no new import rule. `POST /api/import` can now answer 503 `project_backup_failed`, and its result has `backupFileName`; the import needs free space for one more snapshot of the database.

## [1.6.28] - 2026-11-12

[繁體中文更新說明](docs/releases/1.6.28.md).

### Fixed

- The staleness check of a Knowledge read (every Knowledge list or read, page 20–50, and reads that attach Knowledge trust) compared every `appliesTo` entry of the page with every distinct file later Sessions changed, with a budget that grew with history and no ceiling. On 2,000 later Sessions of 50 distinct paths of about 100 characters with 200 Knowledge items of five entries, a page of 20 took 2.97 s (1.6.14: 0.96 s) and a page of 50 6.8 s, growing linearly with history; 200 Sessions of 200 distinct 1,000-character files with 30-entry items took 55 s, and one 15-star entry in each item 58 s. It now builds, once per call and per project, an index of the distinct paths the later Sessions changed (a stored path repeated across Sessions is normalized once; each distinct path keeps the Sessions that changed it and, when the call resolves more than two entries, is filed under each of its path segments), and resolves each distinct entry once per call against the paths that can match it: a plain entry only against the paths that have its rarest segment and the paths equal to the text after one of its `/`; a glob only against the paths that have a whole segment of its literal prefix or suffix, and against every distinct path only when it has none. Each candidate is still decided by the existing matcher, so the answers are the same (the code comments give the argument that the candidates contain every match). A read that resolves one or two entries (a single Knowledge read) tests them against every distinct path instead, which is faster than filing the segments. Same data: 0.19 s for a page of 20 and 0.17 s for a page of 50 (5× and 12× faster than 1.6.14); 5,000 Sessions 0.49 / 0.47 s (1.6.14: 2.4 / 5.4 s); the 200 × 200 × 1,000-character data 0.34 s with the correct answer; ordinary data of 5,000 / 20,000 Sessions 23 / 75 ms (1.6.14: 31 / 112 ms); one Knowledge item over 5,000 Sessions of 20 distinct files 0.18 s (1.6.27: 0.18 s, 1.6.14: 0.17 s).
- The check has two fixed ceilings per call again, set from measurement: reading later Sessions into the index (2,200,000,000 units; the largest legitimate history measured, 5,000 Sessions of 50 distinct paths under a 110-character project root, uses 708M, and 20,000 ordinary Sessions 53M) and resolving entries (300,000,000 units; ordinary pages use about 1M, the 200 × 200 × 1,000-character data 12.7M, and a page of 50 whose items carry a directory entry with about 8,000 candidate paths needed between 50M and 150M in the release review, which is why the ceiling is not the 50M first chosen). Reaching either marks the affected items `stalenessUnchecked`, never current. Reaching the history ceiling took at most 2.4 s and 380 MB on the development machine; reaching the resolution ceiling is about 1.2 s, estimated from about 4 ns per unit. A set of entries costly enough to exhaust it is marked unchecked instead of running on (the earlier versions answered the 15-star case after 9–58 s).
- Knowledge and Session list searches were 1.6–4× slower than 1.6.14 on ordinary data, and 2,000 Knowledge rows at the write limits with three words took 0.76 s instead of 0.075 s. The per-row guard of 1.6.27 put each word's field tests in a `CASE … THEN (a OR b OR …)` branch, where SQLite computes `OR` as a value and searched every field for every word; the tests are now a `CASE WHEN guard AND (a OR b OR …)` condition, which stops at the first field that has the word. A Session's event bytes, which needed a `SUM` over its events for every word, are now summed only when a word was not found in the Session's own columns and is about to read its events, at most once per row; the later words of a Session search re-check the first word's column bytes in SQL instead of calling the counting function again. Same results: 206 list queries on a real data copy and 44 on 5,000 synthetic Sessions return the same ids, order and totals. At 5,000 synthetic Sessions: Knowledge three-word list 3.3 ms (1.6.27 4.2, 1.6.14 2.3), Sessions three-word list 11.1 ms (23.3, 5.6), recall 75 ms (67, 75); 2,000 Knowledge rows at the write limits 98 ms (757, 75).
- A Session whose own columns are within the 4 MiB search cap but whose events push it over it was skipped by every word; it is now found by words that appear in its columns, and a word that would read its events is still refused and counted. Only a hand-written database holds such a row.
- `normalizePath` runs each of its three replacements only when its pattern can match, and remembers the lowered project root (bounded), with the same result.

### Changed

- Benchmark: the gate review's distinct-path staleness shape (2,000 Sessions × 50 distinct files, 200 Knowledge × 5 entries, page 20; 1,000 ms) and the 15-star glob that stops at the resolution ceiling (1,000 ms), on a database of their own.
- Docs: the inventory in `docs/architecture.md` describes the indexed staleness check and gains the Knowledge-candidate overlap advisory (the newest 1,000 Knowledge items and 1,000 candidates of the project, the first 4,000 body characters each); `docs/mcp-tools.md` says that MCP reports skipped records in `warnings` and that `searchSkippedRecords` is a REST and Web field.
- finalize `knowledgeToReview` already reads later Sessions once, newest first, with an early stop for the few candidates that name a changed file, so it keeps its own pass; only its SQL narrowing now stops at the first matching fragment. Its results are unchanged.

### Upgrading from 1.6.14 or earlier

Unchanged from the 1.6.27 note below: 1.6.28 changes no schema (33), response shape or import rule. `stalenessUnchecked` is again set by fixed per-call ceilings, far above legitimate use.

## [1.6.27] - 2026-11-12

[繁體中文更新說明](docs/releases/1.6.27.md).

### Security

- Work that grows with the length of stored text was bounded only inside the `appliesTo` matcher. This release takes an inventory of every MCP or REST path whose work grows with stored text or with the caller's words and paths (the table is in `docs/architecture.md`, "儲存文字上的有界工作") and bounds each one that could block the event loop for more than about 300 ms with the largest data the write limits allow.
- Knowledge and Session list searches (`GET /api/knowledge`, `GET /api/sessions`, `work_search_knowledge`, `work_list_sessions`) matched each word with `LOWER(column) LIKE '%word%'`, which re-matches the whole word from every stored position: one long near-miss word over 2,000 Knowledge rows with the largest allowed `appliesTo` took 38.6 s, and eight such words over 200 rows 15.7 s. Words are now matched with `instr()`, which gives the same results without the retry; at most the first 8 words are used and each word is matched by its first 200 characters (real queries are 2–6 short words; the longest real word is a 41-character path, the longest stored changed-file path 81 characters). Each row's cost is bounded instead of the total: before a word reads a row, the row's searched bytes are checked against a per-row cap above the largest row the write limits allow (256 KiB for Knowledge, 4 MiB for Sessions); a row above it is not read and is counted. There is no total budget, because a fixed total cut an ordinary three-word query short on 20,000 synthetic Sessions; a row now costs at most its bytes × words × about 5.4 ns, so the scan is linear in stored text. Eight near-miss words over 200 of those Knowledge rows take 250 ms (about 1.2 s per 1,000 rows; about 10 s per 1,000 rows at the cap); an ordinary three-word query over 20,000 synthetic Sessions takes 187 ms. A cut word, ignored words and skipped rows are reported in a new `warnings` array, and REST also returns `searchSkippedRecords`; ordinary queries get neither.
- `work_recall`, `work_get_context` and the relaxed Knowledge search compared queried paths with stored paths by `LIKE`, about 400 ns per stored byte for a 1,000-character near-miss path. They now use `instr()` (about 5 ns per byte) and skip a stored path above 4 KiB; a skipped path adds `warnings` to recall and sets `appliesToScanTruncated` on the relaxed search.
- Finalize `knowledgeToReview` ran one SQL scan of later Sessions per candidate and charged only the rows it returned: 200 candidates over 5,000 later Sessions took 2.9 s with `knowledgeToReviewTruncated: false`. It now reads later Sessions once for all candidates, newest first, and compares each distinct pattern with each Session's files once; the same case takes 19–23 ms with the same answer. Reading, parsing and comparing each later Session is charged after granting three times its ordinary cost (for at most 32 distinct patterns per Session), so the budget grows with the history it reads and legitimate history is never cut short, while a crafted entry that costs far more per pair than an ordinary one still runs out and sets `knowledgeToReviewTruncated`.
- The staleness check of a Knowledge read loaded every later Session's changed files with one `.all()`: 5,000 Sessions of 50 × 100 characters took 433 ms and 235 MB, 500 of 200 × 1,000 characters 783 ms and 431 MB. It now reads them one at a time, and each list, path and pattern × file set is charged after granting three times its ordinary cost (about 12 units plus both lengths per pair), so its budget grows with the history (the fixed 50M units of 1.6.26 would have reached 70% on 20,000 synthetic Sessions; now 12%). The two cases finish with the correct answer in 477 ms / 194 MB and 1.2 s / 320 MB. A record is marked `stalenessUnchecked` only when a later list is above the load bound, an entry is above the write limits, or crafted entries exhaust the budget.
- The related outstanding items of finalize and `work_get_context` scored up to 2,000 pending items against up to 24 words and 20 paths without a bound, and copied the source Session's changed files into every item row: the largest allowed input took 2.1 s. Changed files are now read once per source Session, and each item is charged before it is scored (50,000,000 units, about 100 ms); a spent budget sets the existing `truncated`. The same input takes 156 ms.
- A stored `appliesTo` list longer than the import bound (100 entries of 4,096 characters, as six-byte JSON escapes: about 2.5 MB) is no longer loaded by the matcher: SQL returns it as missing, and the scan treats it like an entry above the write limits (never matches, scan marked incomplete). Changed-file lists above about 1.2 MB (200 paths of 1,000 characters as escapes) are not loaded by the staleness, review and related-item reads either. Only a hand-written database can hold such values.
- Parsing a stored `appliesTo` list is charged 4 units per character instead of 1, its measured cost. Telling a glob from a plain entry is charged by the entry's length, and the review check classifies and compiles each entry once instead of once per changed file. The compiled-glob cache's eviction loop stays uncharged; its work is amortized over the charged misses and hits (the argument is in the code).

### Fixed

- The performance gate failed in CI on `exportTo (whole database)` because earlier benchmark cases wrote into the shared database before the backup and export cases ran, so those copied a larger file than with `--backup-worker-only` (26.5 MB grew to 27.9 MB). The four heavy cases now run against a byte copy of the database taken after seeding and before any case runs; the file they see is the same in both modes (26,484,736 bytes on one cache). The 300 / 400 ms limits are unchanged.
- `docs/mcp-tools.md` said file history matches `appliesTo` "like `work_recall`"; `work_recall` does not match `appliesTo` at all, only the relaxed Knowledge search does. The docs now say so.

### Changed

- Benchmark: worst-case cases for the list search over 200 of the largest Knowledge rows (1,000 ms), the one-pass review check (250 ms) and the staleness read over 5,000 later Sessions, which now finishes (500 ms), each on its own database; heavy cases report the database size they read. The stored-entry case uses a 2 MB entry instead of 5 MB, since parsing is now charged at its measured cost and SQL no longer loads lists above the import bound.

- Web: the Sessions and Knowledge lists show a short notice when a search skipped records above the per-record search size (`searchSkippedRecords`), saying the results may be incomplete and to narrow the search.

### Upgrading from 1.6.14 or earlier

Everything since 1.6.14 that can affect an existing Agent, REST client or exported file, in one place. Coming from 1.6.8 or earlier (schema 31), also read the 1.6.9–1.6.14 entries below: 1.6.9 introduced schema 32 (Agent read durations and error codes) and `restartRequired` after the upgrade; such a database migrates from 31 straight to 33 on first start, after one pre-migration backup.

- Schema and connections: the database migrates to schema 33 on first start of 1.6.24 or later, after an automatic pre-migration backup; reconnect Work Intelligence MCP when an Agent reports `restartRequired`. An Agent still running a build from before 1.6.24 against the upgraded database gets `DATABASE_SCHEMA_VERSION_TOO_NEW`. There is no downgrade below schema 33 other than restoring that pre-migration backup (`pnpm db:restore`).
- Import and export: import accepts exports from schema 31 (v1.6.7 and later) to 33 and refuses older and newer files (`unsupported_schema`; 1.6.24). From 1.6.26 it also refuses a Knowledge or candidate `applies_to_json` beyond 100 entries of 4,096 characters, which no version writes. Exports gained `knowledge_candidates.overlaps_json` (1.6.24); schema-32 exports import with it empty.
- REST: unknown body fields, and unknown fields of query objects validated whole, are rejected with 400 `invalid_input` instead of ignored (1.6.25; the export body from 1.6.26). Where a 500 came before, a read-only database answers 503 `database_read_only` and a full disk 507 `database_disk_full` (1.6.25). `GET /api/knowledge` also matches `appliesTo` paths (1.6.16).
- MCP error codes: `DATABASE_READ_ONLY` and `DATABASE_DISK_FULL` (1.6.25); busy, read-only and disk-full startups are retried by later calls instead of failing until restart.
- Response shapes: `work_finalize_session` (1.6.20) and `work_update_session_metadata`, `_summary`, `_title` and `_work_summary` (1.6.22) answer with receipts instead of echoing the Session; read it with `work_get_session`. Calls scoped by `projectRoot` name the project once and omit `projectId`/`projectName` from items (1.6.15). `work_get_context` keeps `omitted` to small pointers (1.6.15) and its `relevant.outstandingItems` entries to id, source Session and a 240-character excerpt (1.6.18). `work_get_report_context` sends the report block only on `sessionPage: 1`, lists at most 8 `sourceSessionIds` per project and risk, and names evidence Sessions by id (1.6.19). `work_get_knowledge_page_context` Sessions are previews (1.6.19). A strict `work_search_knowledge` miss returns empty `items` with `match: "relaxed"` or `"none"` and `relaxedMatches` digests (1.6.16).
- Bounds and flags: a relaxed Knowledge search uses at most 5 path-like words and `appliesTo` scans read at most the 2,000 newest Knowledge rows (1.6.18). New `appliesTo` globs above 16 stars are rejected on create and candidate review, accepted with `warnings` on update (1.6.23). `appliesToScanTruncated`, `knowledgeToReviewTruncated` and `stalenessUnchecked` mark scans cut by the match budget (1.6.23) or, from 1.6.26, scans that skipped an entry above the write-time limits; `relatedOutstandingItems` and context outstanding items read at most 2,000 and carry `truncated` (1.6.23), also when their scoring budget runs out (1.6.27). List searches use at most 8 words of at most 200 characters and add `warnings` when they cut one or skip a record above the per-record size, which the Web lists show as a notice (1.6.27).
- New, additive: `work_get_file_history` (1.6.17), `session.files` in `work_get_session` (1.6.18), candidate `overlaps` (1.6.18, stored from 1.6.24), finalize `knowledgeToReview` (1.6.20), `work_list_sessions` `commitSha` (1.6.24).

## [1.6.26] - 2026-11-12

[繁體中文更新說明](docs/releases/1.6.26.md).

### Security

- The `appliesTo` match budget is now an upper bound on the work a scan does. In 1.6.23 it counted one step per pattern × path pair plus the simulation, but the checks that run before the simulation, compiling a pattern and reading the stored list were not counted: a stored 2-star glob of about 600 characters against 1,000-character paths spent 44 µs per pair in the literal search while counting 1 step, so one call could block for about 50 s within the limits. Every operation whose cost grows with the length of a stored entry or a caller path is now charged before it runs, in one unit (a character operation) and at least once per comparison it may make: parsing and normalizing the stored list, compiling a glob (on a cache miss), each pair's constant work, the prefix, suffix and equality checks, the ordered literal search, and the simulation. The literal search and the plain-entry segment search use Knuth-Morris-Pratt (at most two comparisons per path character) instead of `indexOf`. A property test generates 140 hostile cases within the enforced limits (near-miss literal runs, alternating `?*`, 16 stars with long literals, repeated prefixes, distinct 1,000-character patterns that defeat the cache, long plain entries, random globs) and checks, with a debug counter of the comparisons the loops make, that no case examines more than it was charged, that a budget one unit short does none of a pair's checks, and that a spent budget stops the scan and does no further work.
- The budget is set from a time target. On the development machine the slowest path costs 3.7 ns per unit (simulation; literal search 3.1, compiling 3.6–4.0, plain entries 3.2–3.5, ordinary patterns 3.3), so recall, the relaxed Knowledge search, file history and finalize `knowledgeToReview` get 20,000,000 units per call (about 75–90 ms there) and the staleness check of a Knowledge read 50,000,000 (about 200 ms; it compares stored entries with stored history and cannot yield). On a real database copy the heaviest caller-path scan spends 300,000 units (1.5%) and the staleness check of the whole Knowledge list 3.4 million (7%). The near-miss shape above, as 2,000 rows × 30 entries × 20 paths, stops at the budget in 75–110 ms.
- `appliesTo` entries enter matching only within the write-time limits, however they were stored: at most the first 30 entries of a record, each at most 1,000 characters. A longer entry is never normalized or tokenized (a 5 MB entry took 1.7 s and 674 MB of memory to compile; it is now skipped at no cost), and the stored row still loads and shows unchanged. A scan that skipped such an entry reports itself incomplete like one the budget cut short: `appliesToScanTruncated`, `knowledgeToReviewTruncated`, or `stalenessUnchecked` on that Knowledge record. Compiled globs are kept in a cache bounded by count and characters with second-chance eviction, instead of one that was cleared whole when full, and every miss is charged.
- Portable JSON import (preview and import, REST, Web and `pnpm db:import`) rejects a `knowledge` or `knowledge_candidates` row whose `applies_to_json` is not an array of at most 100 strings of at most 4,096 characters, with the reason `knowledge.applies_to_json 必須是最多 100 筆、每筆最多 4,096 字元的文字清單。` and nothing written, as it already did for invalid JSON. The bound is structural and deliberately wider than the write limits (30 entries of 1,000 characters): credential redaction can lengthen a stored entry (a masked 8-character connection-string password becomes a 37-character marker, so a valid 1,000-character entry can be stored at about 2,700), and older versions may have stored longer values. Such entries import unchanged and never match, with the over-bound signalling above; a test redacts a 1,000-character entry, exports it, re-imports it with 0 conflicts and reads it back unchanged. The real export copy imports with 0 conflicts and identical counts, and the committed schema-31 and schema-32 fixtures still import. Reading the largest importable list is charged like any other (its JSON text, then at most 30 entries within the write limits), and the scans read rows one at a time, so they stop reading once the budget is spent. The star bound is still not applied on import.
- Path normalization (`normalizePath`, used for every stored and queried path) no longer uses two regular expressions that took quadratic time on crafted input: removing trailing slashes (354 µs for 1,000 characters of slashes) and removing a `#L` line anchor before a long run of digits (381 µs). Both are single passes with identical results (20,000 generated strings and every real path agree).
- Error messages that name unknown request fields list at most 10 names per location, each name and path segment shortened to 64 characters, and count the rest. This applies to every REST body, `POST /api/export` (which now uses the same strict parser as the other bodies), import and import preview, and `pnpm db:import`; before, a body of many long unknown keys was echoed whole.

### Fixed

- `work_list_sessions` with `commitSha` did not find a Session whose sha was stored in upper case (the filter is lowercased since 1.6.24, while finalize stored the sha as given). Hex shas are now stored in lower case on finalize and metadata updates; the filter seeks the lowercase range and, when the prefix has letters, the uppercase range, and two spellings of one commit no longer count as an ambiguous prefix. Mixed-case shas, which Git does not print, are not found. The real database copy has 323 recorded shas, none in upper case; there is no migration.
- The knowledgeToReview Session scan narrows by a fragment of at most 64 characters, so SQLite's `instr()` costs at most that per stored character whatever the stored entry's length; exact-name checks there are charged to the budget too.

### Changed

- Benchmark: new cases for the near-miss literal runs and for the stored-entry shapes (5 MB entry, distinct 1,000-character entries), 250 ms each; the 16-star case runs to a budget about eight times longer in time, so its limit is 250 ms instead of 100 ms.

### Upgrading from 1.6.14

Everything since 1.6.14 that can affect an existing Agent, REST client or exported file, in one place (coming from 1.6.8 or earlier, also read the 1.6.9–1.6.14 entries; see the 1.6.27 note):

- Schema and connections: the database migrates to schema 33 on first start of 1.6.24 or later, after an automatic pre-migration backup; reconnect Work Intelligence MCP when an Agent reports `restartRequired`. An Agent still running a build from before 1.6.24 against the upgraded database gets `DATABASE_SCHEMA_VERSION_TOO_NEW`. There is no downgrade below schema 33 other than restoring that pre-migration backup (`pnpm db:restore`).
- Import and export: import accepts exports from schema 31 (v1.6.7 and later) to 33 and refuses older and newer files (`unsupported_schema`; 1.6.24). From 1.6.26 it also refuses a Knowledge or candidate `applies_to_json` beyond 100 entries of 4,096 characters, which no version writes. Exports gained `knowledge_candidates.overlaps_json` (1.6.24); schema-32 exports import with it empty.
- REST: unknown body fields, and unknown fields of query objects validated whole, are rejected with 400 `invalid_input` instead of ignored (1.6.25; the export body from 1.6.26). Where a 500 came before, a read-only database answers 503 `database_read_only` and a full disk 507 `database_disk_full` (1.6.25). `GET /api/knowledge` also matches `appliesTo` paths (1.6.16).
- MCP error codes: `DATABASE_READ_ONLY` and `DATABASE_DISK_FULL` (1.6.25); busy, read-only and disk-full startups are retried by later calls instead of failing until restart.
- Response shapes: `work_finalize_session` (1.6.20) and `work_update_session_metadata`, `_summary`, `_title` and `_work_summary` (1.6.22) answer with receipts instead of echoing the Session; read it with `work_get_session`. Calls scoped by `projectRoot` name the project once and omit `projectId`/`projectName` from items (1.6.15). `work_get_context` keeps `omitted` to small pointers (1.6.15) and its `relevant.outstandingItems` entries to id, source Session and a 240-character excerpt (1.6.18). `work_get_report_context` sends the report block only on `sessionPage: 1`, lists at most 8 `sourceSessionIds` per project and risk, and names evidence Sessions by id (1.6.19). `work_get_knowledge_page_context` Sessions are previews (1.6.19). A strict `work_search_knowledge` miss returns empty `items` with `match: "relaxed"` or `"none"` and `relaxedMatches` digests (1.6.16).
- Bounds and flags: a relaxed Knowledge search uses at most 5 path-like words and `appliesTo` scans read at most the 2,000 newest Knowledge rows (1.6.18). New `appliesTo` globs above 16 stars are rejected on create and candidate review, accepted with `warnings` on update (1.6.23). `appliesToScanTruncated`, `knowledgeToReviewTruncated` and `stalenessUnchecked` mark scans cut by the match budget (1.6.23) or, from 1.6.26, scans that skipped an entry above the write-time limits; `relatedOutstandingItems` and context outstanding items read at most 2,000 and carry `truncated` (1.6.23).
- New, additive: `work_get_file_history` (1.6.17), `session.files` in `work_get_session` (1.6.18), candidate `overlaps` (1.6.18, stored from 1.6.24), finalize `knowledgeToReview` (1.6.20), `work_list_sessions` `commitSha` (1.6.24).

## [1.6.25] - 2026-11-12

[繁體中文更新說明](docs/releases/1.6.25.md).

### Fixed

- An MCP server that started while another process held the write lock waited 5 seconds and then answered every tool call with `DATABASE_MIGRATION_FAILED` ("restore from backup") for the rest of its life, although the database was current. Opening a database that is already at the current schema now only reads it and needs no write lock, so it starts at once and serves reads. When a migration is pending and the lock is held, it answers `DATABASE_BUSY` before writing the pre-migration backup, and the next tool call tries again. Busy, read-only and disk-full startups are retried (at most one attempt per call and per second); a schema that is too new, invalid version information, a failed backup or migration, and a file that cannot be opened still stay until restart. The pre-migration backup and the refusal of newer schemas are unchanged.
- A write to a read-only database returned the bare SQLite text over MCP and a generic 500 over REST. It now answers `DATABASE_READ_ONLY` (REST `database_read_only`, 503), and a full disk answers `DATABASE_DISK_FULL` (REST `database_disk_full`, 507), both in the existing error shape with fixed text and a translated Web message. Reads keep working on a read-only database. Project and Session deletion keep these codes (and busy) instead of reporting a failed backup or deletion.
- REST request bodies, and query objects that reach a schema whole, silently dropped unknown fields: `PATCH /api/sessions/:id/title` with `{"title":"x","extra":1}` returned 200. Every REST route now rejects unknown fields, including nested ones, with 400 `invalid_input` and names each one in `details`. The Web client sent no extra fields; one E2E fixture did and was fixed. MCP schemas are unchanged.
- When a list failed to load, Sessions, Knowledge, Projects, the dashboard, the graph and reports showed the error together with an empty state such as "no work records yet". They now show the error only; the Sessions list has its own message and retry.
- `pnpm db:maintain` on a file that is not a SQLite database said the database was in use and asked to stop the server; it now answers `DATABASE_INVALID` and leaves the file unchanged.
- A handoff file that could not be read showed the file-system message, including its absolute path, in the import preview; it now shows fixed text with the relative path.

### Changed

- `docs/mcp-tools.md` documents the eight operations it never named and `docs/rest-api.md` the routes it omitted; parity tests fail when a registered operation or route is undocumented or the docs name one that does not exist.
- The lockfile resolves fast-uri 3.1.9, qs 6.17.1 and ip-address 10.7.6 (transitive under the MCP SDK, within its existing ranges), which clears every `pnpm audit --prod` advisory.

## [1.6.24] - 2026-11-12

[繁體中文更新說明](docs/releases/1.6.24.md).

### Upgrade note

- The database upgrades from schema 31 or 32 to schema 33 on first start, after the usual pre-migration backup; if the backup fails, nothing is migrated. Schema 33 is additive only: one nullable column (`knowledge_candidates.overlaps_json`) and two indexes (`idx_sessions_commit_sha`, `idx_sessions_live_project`); no existing row is rewritten. Older MCP connections report `restartRequired` after the upgrade; reconnect Work Intelligence MCP.
- Portable JSON import now accepts exports from schema 31 (written by v1.6.7 and later) up to 33. Before, it accepted only exports from exactly the program's schema, so this release would otherwise have refused every earlier file, including the schema-32 exports of v1.6.9–v1.6.23. An export from a newer schema is still refused with `unsupported_schema`, and the message asks the user to update Work Intelligence first; the Web shows the same advice.

### Added

- Knowledge candidates keep their overlap advisory. The advisory that `work_submit_knowledge_candidates` computes (up to three possible duplicates of active Knowledge, overlaps with archived Knowledge or with rejected candidates of the same project) is stored with the candidate as ids, submission-time statuses and scores only, validated by a strict Zod schema on write and dropped, never shown, when a stored value is not that form. `GET /api/knowledge/candidates` returns it as `overlaps`, with the title read from the matched record of the candidate's own project, and the Web candidate card shows a compact note in both languages and themes, saying it is advisory, with a link that opens matched Knowledge that still exists. A record of another project is never named, and the stored value holds no text, so there is nothing to redact. Resubmitting the same payload replays the stored advisory instead of recomputing it, so a matched record whose status changed later no longer changes the label; candidates submitted before schema 33 have none stored and are recomputed as before. The column travels in portable export and import as a locally derived value: a copy without it is the same candidate (skipped, never a conflict), and schema-32 exports import with it empty. It is not indexed for search and is deleted with the candidate when a project is deleted.
- `work_list_sessions` takes `commitSha`: a full sha or an unambiguous prefix of 7 to 64 hex characters (any other character is rejected), matched only within the scoped tracked projects, so an Agent can find the Session behind a commit from `git blame` or `git log`. A prefix that matches more than one commit in the scope returns `ambiguous_commit_sha` and lists nothing. The recorded sha is the HEAD seen at finalize, which can be the commit before the work was committed; how it is captured is unchanged. The REST Session list keeps its own filters.

### Changed

- The partial index `sessions(project_id) WHERE voided_at IS NULL` serves counts and lists of live Sessions per project. At 20,000 synthetic Sessions the Dashboard Session count takes 0.46 ms instead of 6.1 ms (0.11 instead of 1.1–1.8 ms at 5,000) and the first Session list page 1.1 ms instead of 3.2 ms (median of three alternating processes against the same build without the index). `EXPLAIN QUERY PLAN` over the 352 read statements of the benchmark shows 21 plans switching to the new index and none to a scan; the whole read-path benchmark at 5,000 and 20,000 Sessions, in three alternating rounds against v1.6.21, shows no path slower beyond the run-to-run spread of this machine, and the two queries whose join order changed (the pending items of a Session list and the applied-Knowledge feedback) spend no more time per SQL statement.
- The commit filter reads its prefix range from `idx_sessions_commit_sha` once as a rowid subquery; as a plain range term SQLite preferred the project equality and read every Session of each tracked project (3.5 ms instead of 0.13 ms at 5,000 Sessions). The new benchmark case `listSessionsForAgent (commitSha prefix)` has a 50 ms p90 limit.

## [1.6.23] - 2026-11-12

[繁體中文更新說明](docs/releases/1.6.23.md).

### Security

- Matching stored `appliesTo` globs has a bounded cost. Since 1.6.18 one match cost pattern length × path length, and both can be large at the schema limits, so stored globs against long caller paths could still hold the single-threaded MCP and API process for seconds per call. Three layers now bound it, and ordinary patterns match exactly as before (the previous regular expression stays the test oracle over the fixed tables and a new 6,000-case generated table; 59,682 pattern × changed-file pairs from a real database copy give identical results):
  - Exact rejections before the matcher runs: a path shorter than the pattern's literal and `?` count, a literal prefix or suffix that does not match, or literal runs that do not occur in order between them.
  - A glob may have at most 16 stars (`*` or `**`, adjacent stars of one kind count once); every glob in the real data has one. A stored or imported glob above the bound loads unchanged and never matches. New Knowledge (`work_record_knowledge`, REST create) and Knowledge candidates (submission and review edits) reject it with a validation message that says how to rewrite it. Updates accept it, so such a record can still be archived or edited, and `work_update_knowledge` answers with `warnings` while the saved `appliesTo` keeps it. JSON import, restore and reads apply no such rule.
  - A deterministic step budget per scan (one step per pattern × path pair plus one per pattern token for each path character simulated): 2,000,000 steps for the scans of caller paths (relaxed Knowledge search, file history, finalize `knowledgeToReview`), whose heaviest real use spends 4,332, and 16,000,000 for the staleness check of a Knowledge read, which spends about 73,000 on the real Knowledge list. When the budget runs out the scan stops and the result says so: `appliesToScanTruncated: true` on the relaxed Knowledge search and file history, `knowledgeToReviewTruncated: true` on the finalize result, and `stalenessUnchecked: true` on a Knowledge record whose `possiblyStale` could not be decided.
  - 30 entries of 500 stars against 20 paths of 1,000 characters took about 3.6 s and now take under 2 ms (600 steps). The costliest globs the bound allows stop at the budget in about 10 ms. Benchmark cases cover both (20 ms and 100 ms).

### Changed

- The related pending items that finalize (`relatedOutstandingItems`) and `work_get_context` (`relevant.outstandingItems`) rank are read at most 2,000 at a time, newest source Sessions first; the largest real project holds 43. When more qualify, the result has `truncated: true` and `total` counts the ranked ones. Below the limit results and order are unchanged: 300 focuses on a real database copy return the same matches in the same order. A SQL relevance prefilter was measured and left out because it removed few rows and doubled the call time.
- The core work-intelligence skill states again that Agent-autonomous decisions enter the Web review queue and that confirming, rejecting and promoting them to Knowledge are Web-only, and that finalize `resolvedOutstandingItemIds` and `supersededOutstandingItemIds` must not bypass an active outstanding-cleanup review. `tests/mcp/agent-reading-budget.test.ts` checks both as core rules.
- A comment in `db:redact` now says that the re-index runs after the redaction commits, and why that is safe.

## [1.6.22] - 2026-11-12

[繁體中文更新說明](docs/releases/1.6.22.md).

### Changed

- The work-intelligence skill is split into a core that every session reads and six on-demand guides, so an Agent reads a flow's rules when it starts that flow. The core keeps the privacy and tracking rules (Tracked-only, default-deny, quiet skips, `<private>`, no secrets), the dispatcher and contract rules, the start-of-work steps, the evidence rules, and the finalize flow as ten steps. The guides are `reading-records` (partial Session reads, context omissions and supplements, recall ranking and confidence, Knowledge search matches), `diagrams`, `repair-and-backfill`, `outstanding-cleanup`, `synthesis` (report synthesis, period grouping, the `ReportSummary` field mapping, report writing) and `knowledge`. Each is the MCP resource `work-intelligence://agent/work-intelligence/references/<guide>.md` and the file `references/<guide>.md` beside `SKILL.md`; the plugin, the Claude Desktop extension and the standalone package ship them, so a client that loads only the skill folder reaches them too.
- Rules stated in several places are kept where the Agent reads them when it needs them. The `work_get_context` details live in its contract, the record field rules in the finalize contract and the format document, and the finalize-only rules (outstanding items, `knowledgeToReview`, diagrams) in a closing contract attached only to `work_finalize_session`. `docs/work-record-and-report-format.md` keeps the Session record and points to the guides for reports, backfill and diagrams. The server instructions name the core and its guides and drop the cleanup routing the cleanup guide now holds. Before the restructure, 350 normative statements were taken from the skill, the format document, the instructions and the affected contracts; each is still present, 296 word for word and 54 merged or reworded, and the Chinese diagram and 1.5.1 notes of the format document now read in English in their guides. One rule was added to the core: never put secrets, tokens or personal data in a record, a diagram or Knowledge.
- The fixed reading before an Agent's first useful call (instructions, tools/list, core skill, operation index, and the `work_get_context` and `work_finalize_session` contracts) is 39,642 characters instead of 63,209 (−37%); the core skill is 12,893 instead of 35,554 and the format document 7,749 instead of 11,789. A rare flow costs the core, the format document and its guide, at most 29,115 instead of 47,343. `tests/mcp/agent-reading-budget.test.ts` locks these budgets, checks that the core states each core rule itself, and checks that every guide and resource URI the texts name exists and is served.
- `work_update_session_metadata`, `work_update_session_summary`, `work_update_session_title` and `work_update_session_work_summary` answer with a receipt like `work_finalize_session`: the Session id, times, verification status and changed-file count, plus only what the server changed or decided (a stored changed-file list, summary, title or workSummary section that differs from the request, redaction counts, `timestampWarnings`). The title update keeps `previousTitle`; skipped, not-found and conflict results are unchanged. On real data these responses were 3,534–5,940 characters; on the synthetic fixture in `tests/mcp/response-size.test.ts` they are 303–405 and are locked at 1,200. REST and storage results are unchanged.

## [1.6.21] - 2026-11-12

[繁體中文更新說明](docs/releases/1.6.21.md).

### Changed

- Read paths no longer redo work or stall; every result is unchanged. On the real database the serialized results of `getContext` (unfocused, global and 5 tasks), 15 recalls, 41 relaxed Knowledge searches, 6 Session list queries, the dashboard, attention and the metadata follow-up counts hash identically before and after (220 results, three runs each), and so do 37 read paths on the 5,000- and 20,000-Session synthetic benchmark databases. Medians below are from the read-path benchmark, three interleaved processes per variant at 5,000 Sessions and two at 20,000.
- The metadata follow-up count that `work_get_context` reads on every call scanned every Session of its scope (11 ms at 5,000 Sessions, 46 ms at 20,000). It is now cached per connection and project scope, keyed by the database id, `data_revision` and SQLite's `schema_version`, read in one statement before the count. Any project-data write by any process, a replaced database file, or a schema change makes the next read count again; nothing is cached or served inside an open transaction, and the policy check still runs on every call. Unfocused `getContext` takes 19 ms instead of 38 ms (77 instead of 140 ms at 20,000), a project context 18 instead of 25 ms; the count after a write is unchanged at about 12 ms.
- One `work_get_context` call built the same project's Knowledge page records up to three times (digests, page omissions, pending page requests); they are now built once per call and nothing is kept afterwards.
- Recall and the relaxed Knowledge search read the document frequency of each query term with `COUNT(*)` instead of returning every matching rowid to JavaScript, and read the rowids only when coverage needs them: not when the scoped query returned nothing, not for a term without matches, and not when only one term matches at all. A relaxed Knowledge search that finds nothing ran 7 full term reads (14 ms at 5,000 Sessions) and now runs 7 counts (about 1.5 ms). A test compares recall, relaxed Knowledge search and focused context with the previous implementation on a seeded corpus, and `pnpm test:retrieval-quality` gives the same numbers.
- A large search-index backlog is cheaper and is no longer left to the first read. The index sync removes the old rows of all dirty documents with one statement each, prepares its statements once, and reads each project's path context once, writing the same rows and rowids as before; re-indexing 5,000 Sessions takes 572 ms instead of 839 ms (602 instead of 935 ms at 20,000), and the recall p95 of `pnpm bench:recall-scale` at 5,000 distractor Sessions, which includes that first sync, is 345 ms instead of 595 ms with unchanged ranks. Online project imports re-index right after the commit, and `db:restore` and `db:redact --apply` (on a database at the current schema) re-index before they return. The usual single document after a finalize is still re-indexed by the next read, so a new Session is searchable at once.
- The Session list with a text query scans once: it reads the ordered ids of every match, takes the total from them, and reads the page by primary key, with the same items, total and page clamping. A query without matches takes 23 ms instead of 47 ms (112 instead of 188 ms at 20,000).
- Queries that grew faster than the data: newest-first Session lists (dashboard, context recent Sessions and decisions) walk the completion index and stop at the limit instead of sorting every tracked Session; report and period hotspots start from the period's Sessions instead of every changed path; the outstanding attention count starts from pending items; the dashboard event count reads the eligible Sessions once. At 20,000 Sessions the dashboard takes 31 ms instead of 50 ms, a project week report 19 instead of 41 ms, a week report 26 instead of 62 ms, monthly directory hotspots 16 instead of 45 ms, and suppressed outstanding attention 4 instead of 11 ms. Each rewrite is checked against the plain join in tests.
- Benchmark: new cases for the follow-up count after a write (100 ms) and the first read after 5,000 dirty documents (on its own copy, 1,500 ms); the dashboard limit is now 250 ms and the unfocused context limit 500 ms.

## [1.6.20] - 2026-11-12

[繁體中文更新說明](docs/releases/1.6.20.md).

### Added

- `work_finalize_session` returns `knowledgeToReview`: at most 3 active Knowledge items of the Session's project that this Session is the first to put in doubt. An `appliesTo` entry must name a changed file (the exact path or a matching glob; directory entries and loose path suffixes do not count), and no other Session may have changed a file the Knowledge covers since it was recorded or last confirmed, so its `possiblyStale` marker starts with this Session; Knowledge that is already `possiblyStale` is flagged on every read and is not repeated. Exact matches come first, then the newest, over the same 2,000 newest Knowledge rows as the other `appliesTo` scans. Knowledge the Session recorded, or already reported as applied or contradicted, is left out, and so is a backfilled Session that finished before the last confirmation. Each item has its `id`, `title`, the matched `path`, and the `appliesTo` entry when it differs from the path. It is advisory and changes no Knowledge; the work record contract and the work-intelligence skill tell the Agent to confirm an item that still holds (`work_update_knowledge` with `confirm: true`), update it with the user when the change made it wrong, or leave it. Replaying the 50 newest real Sessions (Knowledge state as of each Session) gives a hint on 5 of them (6 items); the first, broader rule (any `appliesTo` match) fired on 32 of 50, mostly for Knowledge earlier Sessions had already put in doubt. The check reads later Sessions newest first, narrowed in SQL by a fragment every covered path contains, and stops at the first one that touches the Knowledge.

### Changed

- The MCP finalize result is a receipt instead of an echo of the request. `session` carries the id, `executionStatus`, `completedAt`, `updatedAt`, `verificationStatus`, and `changedFilesCount`, plus only what the server changed or derived: a `startedAt` it derived or changed, the stored `changedFiles` when they differ from the submitted list, Git metadata it read because the request had none, and void state. `redactions` appears only when something was masked; resolved and superseded item ids appear when the request named items or a retry recovered them; follow-ups, warnings, `knowledgePageMaintenanceHint`, and `relatedOutstandingItems` are unchanged, the latter in the `work_get_context` pointer shape (id, source Session id, text). The title, summary, work summary, and submitted changed files are read with `work_get_session`. On the real database a realistic finalize (3,064-character request) now answers with 1,500 characters of text and 1,638 of `structuredContent` instead of 5,249 and 5,453; a synthetic realistic request is held to 2,000 characters in `tests/mcp/response-size.test.ts`. REST `POST /api/work/finalize` and the storage result keep the full Session. Both the text block and `structuredContent` stay: the MCP specification asks tools that return structured content to also return it as text for clients that read only text, and the Codex finalize hook reads `structuredContent` first.
- Finalize is faster. The related-outstanding-items reminder matched every stored changed file against every query path in SQL and recomputed the normalized path per pair; it now reads the eligible pending items once and scores them in memory, normalizing each path once, with the same rules (only ASCII letters fold, as SQLite `lower()` does) and the same tie order. A characterization test written against the old SQL pins the ordering, and on the real database the old and new lookup return identical results for 300 focuses (7,211 matches, same order). The lookup takes 0.9 ms instead of 5.9 ms (median over the 100 newest Sessions' finalize focuses), finalize 6.0 ms instead of 16.3 ms (median of 21 calls through MCP), and a focused `work_get_context` about 35 ms instead of 54 ms. On 5,000 synthetic Sessions a finalize with 20 changed files that share paths with pending items and Knowledge takes 15.8 ms instead of 35.4 ms (median of three processes), including a Knowledge check that walks every later Session.
- The Knowledge page maintenance hint is computed after the finalize commit, with the other read-only reminders, so the write lock is no longer held for it (finalize transaction median 1.0 ms instead of 3.8 ms at 5,000 Sessions). Its text is unchanged; a failed lookup now only omits the hint instead of failing the finalize.

### Fixed

- `work_get_knowledge_page_context` shortens Session previews without splitting an emoji or another character outside the Basic Multilingual Plane; it uses the code-unit truncation helper that outstanding item lists already used, now shared.
- The two tests that make the MCP lease directory unwritable (`tests/server/server.test.ts` system status, `tests/server/doctor.test.ts` stale lease) replace the directory with an empty file instead of removing its write permission, so they also run on Windows and as root, where permission bits do not stop a write.

## [1.6.19] - 2026-11-12

[繁體中文更新說明](docs/releases/1.6.19.md).

### Changed

- `work_get_report_context` (agent view) sends the period report block once. Totals, comparison, projects, risks, decisions, trends, and spanning do not change between Session pages, yet every page repeated them: on a real month with 193 Sessions about 86,000 of the 158,000 characters of pages 1–8 were the same block. Only `sessionPage: 1` now returns the block; a later page returns `report.evidence` and `report.evidencePageInfo` for its own Sessions, `reportBlockOnSessionPage: 1`, and `report.block` in `projection.omittedFields`. An Agent that reads page N directly, retries a page, or resumes after a restart reads page 1 again to get the same block; the server keeps no paging state. A period that fits one page is complete on that page. `view: "full"` and REST are unchanged.
- In that block, `projects` and `risks` list at most 8 `sourceSessionIds` with `sourceSessionIdsOmittedCount` for the rest (every source is on the Session pages), and evidence names its Session by `sessionId` only, because the preview of that Session is on the same page. The space this frees reaches the Agent as content the budget used to remove: on the 193-Session month page 1 now keeps all 8 decisions and 7 risks (all were removed before), and the pages deliver 317 evidence items instead of none. The month reads 156,378 characters instead of 180,943 in the same 9 calls; a 68-Session month 56,259 instead of 70,849 (3 calls); a 5-Session week 12,561 instead of 13,385 (1 call).
- `maxSessions` stays 24 by default. With 32 or more Sessions per page the 193-Session month would take 7 or 5 calls, but page 1 of the 68-Session month would then lose decisions (32) or decisions and risks (40) to the budget.
- `work_get_knowledge_page_context` bounds each Session to what a page rewrite needs first: id, title, completion time, and the first two `outcomes`, `decisions`, and `nextSteps` of its work summary, each at most 100 characters (shortened text ends with `…` and the Session has `truncated: true`). `omittedSessionFields` names the summary, scope, and verification, which `work_get_session` with `view: "handoff"` returns (`sessionReadWith`). The Session budget is 12,000 characters instead of 24,000, and the fixed `instructions` text is gone because the Knowledge page contract and the work-intelligence skill already carry it. The current page and the ids its sections cite are unchanged. On the real database the three standing pages read 14,935, 11,982, and 13,900 characters instead of 23,705, 20,752, and 22,670, with the same 8 Sessions each.
- The report synthesis contract, the Knowledge page contract, the work-intelligence skill, and the report-writing skill say that the report block arrives once and that page-context Sessions are previews. The prompt version stays `report-synthesis-v4`: it names the writing rules, and they did not change.

## [1.6.18] - 2026-11-12

[繁體中文更新說明](docs/releases/1.6.18.md).

### Security

- Matching a Knowledge `appliesTo` glob no longer uses a regular expression. The old matcher turned every `*` and `**` into a backtracking group, and since 1.6.16 and 1.6.17 such stored patterns are tested against caller-chosen paths (`work_get_file_history` and path-like words of a relaxed `work_search_knowledge` query). A stored pattern made of many stars could take seconds per call at 60 characters and block the single-threaded MCP and API process at the 500-character path limit; such a pattern can also arrive through a project import. The new matcher walks all pattern positions at once, so its cost is at most pattern length × path length, and it matches exactly what the old one did (checked against the old expression on a table of ordinary patterns and 2,000 generated star-heavy pairs). A star-heavy pattern against three 500-character paths now takes well under a millisecond (benchmark limit 20 ms).
- A relaxed Knowledge search uses at most 5 path-like words of its query, and each `appliesTo` scan (relaxed Knowledge search, file history) reads at most the 2,000 newest Knowledge rows, so their cost stays bounded when no `projectRoot` narrows the scope.

### Added

- `work_get_session` has a new projection field `session.files`: the changed files with each path once and its `status`, `previousPath`, `sources`, and `references`, merged from `changedFiles`, `changedFilesProvenance`, and `changedFileChanges`. `view: "handoff"` now includes it. A read without `view` or `select` keeps its full shape, and REST and the Web are unchanged.
- `work_submit_knowledge_candidates` returns advisory `overlaps` on each candidate that resembles the same project's Knowledge or an earlier candidate: `possible_duplicate` (active Knowledge or a candidate still waiting for review), `overlaps_archived`, or `overlaps_rejected`, with the matched id, title, status, and score (at most 3). The score weighs the title and the title plus body equally (overlap coefficient of the retrieval tokens; flagged from 0.3). Only records of the same project that existed before the submission compare, and nothing is rejected, merged, or changed. Resubmitting the same payload for a completed request returns the stored candidates with the same advisories and `duplicate: true` instead of `request_not_open`; no candidate is stored twice. The Web candidate review does not show the advisories yet.

### Changed

- Agent guidance (server instructions, the `work_get_session` contract, and the work-intelligence skill) steers Agents to `view: "handoff"` and to the full read only when they need raw provenance, events, evidence, Knowledge, or diagrams. `work_get_file_history` returns `readArguments: { view: "handoff" }` next to `readWith`. On a real 328-Session database the 20 sampled Sessions read 95,720 characters in the handoff view instead of 150,728 in full (median 4,021 instead of 6,907; p95 12,922 instead of 18,909); their merged file list averages 1,861 characters instead of 2,977 for the three lists.
- A focused `work_get_context` spends less of its 9,800-character budget on pointers. Each `relevant.outstandingItems` entry is its `id`, `sourceSessionId`, and a text excerpt of up to 240 characters (was up to 400, plus the source title and date), and among `relevant.decisions` only the first decision of each Session carries its title and date. On the same real database, the five task contexts' outstanding items take 960–1,141 characters instead of 1,534–1,709 and decisions 1,407–2,038 instead of 1,663–2,753; the freed budget keeps 2–3 relevant Sessions instead of 1–2, one-hop supplements now fit in two contexts instead of one, and every context keeps the supplement omission pointer (two of five lost it before). Finalize's `relatedOutstandingItems` is unchanged.
- `work_get_knowledge_candidate_context` lists in `existingKnowledge` the project's archived Knowledge and rejected candidates (flagged with `status`) after its active Knowledge, titles only, newest first, at most 150 active, 30 archived, and 20 rejected, with `existingKnowledgeOmitted` when a cap applies. Source Sessions carry the `outcomes`, `decisions`, and `nextSteps` of their work summary; `scope` and `verification` are listed in `omittedWorkSummarySections` and read with `work_get_session`. On the real database the context is 17,910 characters instead of 19,625 while listing 69 titles instead of 31.

## [1.6.17] - 2026-11-12

[繁體中文更新說明](docs/releases/1.6.17.md).

### Added

- `work_get_file_history` (a `work_read` operation, so `tools/list` is unchanged) tells an Agent what happened to a file before it edits it, in one bounded call. For a tracked project and 1–3 repository-relative paths it returns, per path, totals over the whole history (Sessions whose recorded changed files contain the path, first and last dates, counts by verification status, Sessions with decisions, pending outstanding items from them, and broad changes of more than 20 files), the newest Sessions as digests (default 5, up to 10; first decisions and pending items shortened), older failed or `not_run` Sessions under `attention` (at most 3), counts of what was left out, and a `nextCursor` to page further back. Active Knowledge whose `appliesTo` covers a path is listed by id and title, with the same matching rule as `work_recall`. Only recorded changed files relate a Session to a path; voided Sessions are excluded, untracked projects are skipped quietly, absolute and `..` paths are rejected, and the worktree is never read. The response is capped at 4,000 characters for one path (3,000 more per extra path). On a real 328-Session database the five most changed files return totals equal to a direct count (22–69 Sessions each) in 1,685–2,640 characters and about 2 ms, where assembling a partial picture took about 7 calls and 27,000–60,000 characters.

### Changed

- `work_get_context` with `paths` hints the first three requested paths whenever they have history, not only after three Sessions in the last 30 days; each hint adds `totalSessions` over the whole history, and `relevant.fileHistoryReadWith` points to `work_get_file_history` when a path has more Sessions than the context shows. The Web hotspot views are unchanged.

## [1.6.16] - 2026-11-12

[繁體中文更新說明](docs/releases/1.6.16.md).

### Added

- `work_search_knowledge` no longer dead-ends on a strict miss. With `q`, the result carries `match`: `strict` when `items` hold every word (unchanged results), otherwise `items` stays empty and `match` is `relaxed` with up to 3 `relaxedMatches` or `none`. Relaxed matches come from the recall ranking over the same scope, `kind`, and status (shared tokenizer with Chinese character pairs and identifier parts, OR matching, path-like words matched against `appliesTo` and references). Each is a digest, not the full record: id, kind, status, title, up to three `appliesTo` entries, the `matchedTerms` and `matchedPaths` it shares, and a body `excerpt` of up to 400 characters around those terms (`excerptTruncated` when cut); `work_get_knowledge_history` reads the full record. A relaxed answer on real data is 1,000–2,600 characters. On a real 64-Knowledge database the 7 queries that missed an active record now find it first, and none of 41 queries returns an empty answer.
- An empty or relaxed Knowledge search answer reports `otherStatusMatches`, a count per status the filter left out (for example `{ "archived": 2 }`), with a `hint` naming the status to pass. It carries counts only, within the policy-gated scope; all 21 real queries aimed at an archived record now say so.
- The read audit records a Knowledge search with a query as outcome `knowledge_strict`, `knowledge_relaxed`, or `knowledge_none`, without an error code, so the real zero-hit rate can be measured.

### Changed

- The strict Knowledge search (MCP and `GET /api/knowledge`, so also the Web list) matches `appliesTo` paths besides title, body, tags, and references, so a file path finds the Knowledge recorded about it. Queries that already matched return the same records.
- `work_recall`, `work_search`, and `work_get_context` leave single function characters such as 的, 與, and 讓 out of `termHits`, and count an unsegmented Chinese run as found when half of its character pairs appear in one record, instead of reporting it as matching nothing. `work_recall` judges confidence only on the hits it returns. Ranking is unchanged.

### Fixed

- The read audit again lists the Knowledge and Session ids of `projectRoot`-scoped responses, whose records omit `projectId` since 1.6.15.

## [1.6.15] - 2026-11-12

[繁體中文更新說明](docs/releases/1.6.15.md).

### Changed

- `work_get_context` keeps `omitted` to a small pointer per section: a count, the tool to read the rest, up to three ids, and the id and flag of each left-out item marked `possiblyStale` or `needsReview`. Page review sections and cited Session ids are no longer repeated there; `work_get_knowledge_page_context` carries them. On a synthetic history and a real 328-Session database, the omitted section of a task context fell from about 6,000 to 2,000 characters, and the freed budget now keeps more relevant Sessions, decisions, and page sections; task contexts that used to exceed their 10,000-character cap now fit.
- A `work_get_context` call without a task or paths keeps its three newest Sessions until older Knowledge, decisions, and page content have been trimmed, instead of dropping every recent Session first.
- Calls scoped by `projectRoot` name the project once: `work_get_context` returns `project` with an empty `projects`, and its Session, Knowledge, outstanding-item, and relevant entries omit `projectId`/`projectName`; `work_recall`, `work_list_sessions`, and `work_list_outstanding_items` return `project: { id, name }` instead of repeating it on every hit or row; a scoped `work_search_knowledge` returns `project: { id, name, rootPath }` without the duplicate `projects` list. Unscoped calls and REST responses other than `GET /api/context` are unchanged.

### Added

- `work_get_knowledge_page_context` explains a missed lookup instead of only pointing to `work_request_knowledge_page_update`: the result carries `reasonCode` (`page_id_as_slug`, `slug_looks_like_id`, `slug_near_match`, `page_not_requested`, or `page_unknown`), the project's `existingSlugs` (at most 20), and a `suggestedSlug` when the value is the id of one of the project's pages or within two edits of an existing or default slug. The read audit stores the reason code in `errorCode` with outcome `not_found`; `GET /api/agent-reads/stats` counts it under `errorCodes` but not as a failed read.

## [1.6.14] - 2026-11-10

[繁體中文更新說明](docs/releases/1.6.14.md).

### Fixed

- `pnpm bootstrap` no longer ends every run with "reconnect MCP in your Agent". It now says to open a new conversation or restart the Agent only after connecting it for the first time, and that later updates need no reconnect because connected MCP sessions switch to the new build on their own; reconnect once only when the Agent reports `restartRequired`.

## [1.6.13] - 2026-11-09

[繁體中文更新說明](docs/releases/1.6.13.md).

### Changed

- Portable JSON import now works for two computers that both keep recording the same project. When the project ID already exists under a different root, the import reuses this computer's root (project and handoff paths) instead of marking the whole project and every child row as conflicting.
- New merge strategy `newer-wins` (Web default; CLI `--strategy newer-wins`; REST `strategy`). A mutable row that differs on both sides is replaced only when the imported copy is newer by its own time columns (for example `updated_at`, `reviewed_at`, `decided_at`); a newer local row is always kept, and append-only history and the local project row are never overwritten. The default `merge` strategy still only adds rows, but now keeps newer local rows without calling them conflicts. The preview shows how many rows will be updated and how many local rows are kept.
- Rows that differ only in values each computer derives itself are no longer conflicts: Session `redaction_count`, text masked only by newer masking rules, the order of merged changed-file provenance, attention hide/snooze state, and `is_current` on report summaries (recomputed after import). Rows already identical locally are skipped even when their parent conflicts, and a conflicting existing Session or Knowledge item no longer blocks new child rows.
- Handoff source paths that differ only in Windows letter case or separators (a stored Windows root is lowercase while the handoff path keeps its case) are the same path, not a path conflict.
- When both computers saved the same Knowledge page version number, all of that page's versions are renumbered by creation time and both are kept; the page counter moves to the newest version.
- Import conflicts are summarized by table, category (path, newer imported copy, different content, unique key, dependency) and reason with sample ids, instead of only the first 100 ids.
- A single-project export now also carries the cross-project report requests, summaries and metadata backfill requests that cite the project's Sessions, so deleting the project and importing it again keeps them.
- Import preview prepares each unique-key lookup once per connection instead of once per row; previewing 5,000 Sessions and 50,000 events into an empty database uses about 19% less CPU.

## [1.6.12] - 2026-11-09

[繁體中文更新說明](docs/releases/1.6.12.md).

### Documentation

- Recompressed the 16 README Web UI screenshots to palette PNGs (at most 256 colors): 4.19 MB down to 1.34 MB (-68%) with the text still sharp. No content changes.

## [1.6.11] - 2026-11-09

[繁體中文更新說明](docs/releases/1.6.11.md).

### Documentation

- Both READMEs now show eight Web UI screenshots (overview, work history, Session details, reports, knowledge, graph, projects, system status) in English and Traditional Chinese. Project names and record text in the images are blurred.

## [1.6.10] - 2026-11-08

[繁體中文更新說明](docs/releases/1.6.10.md).

### Fixed

- Voiding or restoring a diagram is now atomic and idempotent. It runs in one immediate transaction that re-reads the diagram, so voiding an already voided diagram keeps its original time and reason and restoring an active one changes nothing; both answer `duplicate: true`. A real change moves the owning Session's `updatedAt`, like voiding Evidence (a repeat does not).
- A finalize that links Sessions with `parentSessionId` or `relatedSessionIds` now moves each linked Session's `updatedAt` too, in the same transaction and once per Session, as `work_link_sessions` does for both ends. Ids that cannot be linked and retried finalizes touch nothing.
- A runtime build that fails no longer leaves `.work-intelligence-build-in-progress` behind to block the next build. When compiling or finalizing fails, `pnpm build` and a direct package build remove the marker only while it still holds the content they wrote, so another build's marker, a marker replaced mid-build, and the root build's marker seen from a package build are kept. A failed build still never counts as a valid MCP build (its dist lacks the matching embedded fingerprint), and a build that is killed keeps the marker as before.

## [1.6.9] - 2026-11-08

[繁體中文更新說明](docs/releases/1.6.9.md).

### Added

- Unsaved work survives context compaction. Claude Code's `PreCompact` hook (manual and automatic) prints extra summary instructions when a tracked project has edits after the last successful save: keep that the work is unsaved, the segment's start time, and the changed files (paths relative to the tracked root, at most 30 then "等 N 個", control characters removed, never contents, far below the 10,000-character cap). It never blocks compaction and prints nothing otherwise. After a compaction, `SessionStart` (`compact`) in Claude Code (from the transcript, which keeps entries before the compact boundary; the compaction summary is not taken as a typed message) and in Codex (from its unsaved marker) adds the unsaved reminder and start time back as `additionalContext`, on every compaction. Both reuse the existing reminder scripts and dispatch on `hook_event_name`; the plugin manifests, `pnpm setup:agents` (preview and confirmation as before; uninstall removes them) and `pnpm check` include the new hooks, which stay optional.
- The Agent read audit records how long each MCP read took and why a read failed (schema 32 adds nullable `duration_ms` and `error_code` to `agent_read_audit`; older rows stay unknown). Failed reads are now audited too, with `outcome: "error"` and a fixed code only — `invalid_input`, `database_busy`, `restart_required` or `internal_error` — and never their ids, response or error message. Tool responses and error handling are unchanged, and audit writes still change only the audit revision.
- `GET /api/agent-reads/stats` (filters `projectId`, `agent`) summarizes the retained audit per tool: count, failures by code, and nearest-rank p50 / p95 / max latency, slowest p95 first. System Status → Agent read log shows each read's duration and failure label plus a per-tool latency table that refreshes with the read log.
- Every `work_get_session` body (full or `view`/`select`) carries `session.revision`: 16 base64url characters of the SHA-256 of the Session's full Agent detail (raw snapshot content as lengths, project record excluded), so one Session state has one revision. Passing it back as optional `knownRevision` returns `{ outcome: "session_unchanged", session: { id, projectId, title, revision, voided? } }` instead of the body while it still matches (constant-time comparison), so an Agent re-reading a Session it still holds skips the payload. Derived Knowledge trust and linked Sessions are part of the hash. `not_found` and `skipped` are unchanged and never reveal a revision. The read audit records `session_unchanged` with the Session id, and the Agent skill says to pass it only for content still in the current context.
- Text wrapped in `<private>…</private>` is never stored: every write that already masks credentials (finalize, summary / workSummary / verification edits, events, handoff snapshots, Evidence, Knowledge, candidates, report summaries, Knowledge pages, outstanding cleanup, portable import, `pnpm db:redact`) first replaces each block with `[REDACTED:private_block]` and reports it under the new `private_block` kind (counts only). Tags are case-insensitive and may span lines; a block needs its closing tag (nested blocks become one marker), and an unclosed `<private>` or a stray `</private>` is stored as written, so records that name the tag keep their text; a credential inside a block counts once, as `private_block`. Handoff files read from `handoffPath` or imported from `.openspec/handoffs` have blocks removed before the 200,000-character cut, so a block straddling the cut is still removed. The scan is a single linear pass. The Agent skill tells Agents to wrap what the user says must not be stored.
- `work_get_context` with `projectRoot` is now an explicit tracking check: a tracked project's context carries top-level `projectStatus: "tracked"` and `tracked: true` (the same fields as `work_get_project_status`, from the policy decision already made, with no extra query); a paused, ignored, unregistered or missing root returns only `outcome: "skipped"`, `projectRoot`, `projectStatus`, `tracked: false`, `reason` and `server`, never project data. Context without `projectRoot` is unchanged.

### Changed

- `pnpm db:redact` and portable export / import mask stored JSON columns (`*_json`) value by value when a rule matches, so a match can no longer span two JSON strings or break the JSON; text that is not JSON is masked as before.
- A Knowledge page title and question set when requesting a page are now masked before storage (they were stored as typed) and the response reports `redactions` counts.
- Agents confirm tracking and get context with one call: the skill, MCP instructions, the `finalize-work` prompt, the `work_get_project_status` description, the `pnpm setup:agents` project snippet and `docs/agent-setup.md` now say to call `work_get_context` with `projectRoot` once at the start and once before finalizing, without a separate status call. `work_get_project_status` stays for a status check that needs no context.
- The database upgrades to schema 32 on first start (with the usual pre-migration backup). Older MCP connections report `restartRequired` after the upgrade; reconnect Work Intelligence MCP.
- `work_get_session` with `view`/`select` still returns only the requested families, but now also builds the full detail once to compute `session.revision` (one revision per Session state). On the synthetic 5,000-Session benchmark this moved the three projection cases from a median of 0.75–1.36 ms to 3.19–3.84 ms; the full read with revision is 3.2 ms and an unchanged answer 3.54 ms (p90 limit 250 ms).

### Security

- Credential masking no longer takes quadratic time on unusual text. Every write masks each stored string (up to about 200,000 characters) on the API / MCP event loop, and a long word, `token=token=…`, `a://` followed by a long word, or `eyJ` followed by a long word made the connection-string or assigned-value rule re-scan the rest of the text from every position: about 1.9 s at 40,000 characters and roughly 46 s at 200,000, freezing every other request (repeated private-key headers without a footer took 0.5 s). Each rule now finds its matches in linear time (a match can only start where a run of its characters starts, unbounded runs are taken atomically, and a header or assigned value that cannot match is skipped whole), so 200,000 characters of any of these shapes take at most a few tens of milliseconds. What gets masked is unchanged, except that a connection-string password equal to its user name is now masked in the password position (the user name was masked before and the password stayed visible).

## [1.6.8] - 2026-11-07

[繁體中文更新說明](docs/releases/1.6.8.md).

### Added

- MCP launcher (`apps/mcp/dist/launcher.js`): Agents now connect through a small, stable stdio launcher that runs the server as a child process and relays JSON-RPC line by line. After `pnpm build` writes a new server build, it queues new requests, waits for those in flight, starts the new build, replays the client's `initialize` and `notifications/initialized` (the second initialize response is not forwarded), stops the old child (TerminateProcess on Windows), and sends `notifications/tools/list_changed` / `notifications/resources/list_changed` when the lists differ. Codex, Claude Code and Claude Desktop keep the same connection. A new build that fails to start or times out leaves the old one serving and the next request gets an explicit JSON-RPC error; a crashed child is restarted with the replayed handshake. Under the launcher, `server.launcher` reports the launcher version and `restartRequired` is `true` only when the launcher file itself changed.
- `pnpm setup:agents`, the plugin and `pnpm start:mcp` register or run the launcher. Setup upgrades earlier registrations of `apps/mcp/dist/index.js` (owned or hand-written, keeping other fields); `pnpm check` and System Status report a registration that still runs the server directly as `direct` ("Direct; reconnect after builds").
- `pnpm build:standalone` packs the API server, Web UI, MCP server and CLI into a checkout-free package (`dist/standalone/work-intelligence-<version>/` and a reproducible `.tgz`) with a `work-intelligence` command (`start`, `mcp`, `track`, `check`, `db`, `--version`) that runs in one process. In a package, messages name `work-intelligence …` instead of `pnpm …`, the Web UI is served from the package's `web/` folder, and `check` verifies the package files and version instead of the checkout's pnpm, dist and root SQLite files. `pnpm test:standalone` builds, unpacks and runs the package end to end. See `docs/standalone.md`.
- Each GitHub Release attaches the standalone package `work-intelligence-<version>.tgz` and `SHA256SUMS.txt` with the SHA-256 of every asset. The release workflow builds the package, runs `node scripts/smoke-standalone.mjs --tarball` on the exact file it uploads, and stops before creating the Release if that fails. `docs/standalone.md` explains downloading and verifying it.

### Changed

- The tag release workflow runs the three Playwright browsers as parallel jobs that start alongside the Quality matrix, and each OS runs the unit suite once, matching CI. Every check and threshold is unchanged, and publishing still waits for all of them.
- The release workflow skips the duplicate Quality and E2E jobs when the tagged commit already has a successful CI run on `main` covering all seven jobs, while still re-running the production dependency audit; any missing or uncertain result falls back to the full checks.
- The Node.js requirement is now 22.16 or later on the 22 line, or 24 and later (`engines.node` `>=22.16.0 <23 || >=24.0.0`; the `.mcpb` manifest uses the same range). Node.js 22.13–22.15 and every 23.x release ship SQLite without FTS5, so the search-index migration failed with `no such module: fts5`. `pnpm bootstrap` refuses those versions, and `pnpm check` now opens an FTS5 table to confirm the module is present.
- The API server, CLI, `pnpm check`, login service and MCP now share one database path rule (`@work-intelligence/shared/database-location`). A checkout resolves a relative `WORK_INTELLIGENCE_DB` from the repository root exactly as before; a self-contained bundle resolves it from `~/.work-intelligence` (or `WORK_INTELLIGENCE_CONFIG_DIR`), where the bundled MCP previously kept relative values unresolved. The standalone CLI no longer takes relative folders from an inherited `INIT_CWD`.
- The Web entry bundle shrank from 514.38 kB (gzip 168.29 kB) to 313.18 kB (gzip 111.44 kB), below Vite's 500 kB warning. The English catalog is a separate chunk fetched only when English is the saved or chosen language (the boot splash waits for it, and switching language keeps the current language until it has loaded), and the global panels and dialogs load together as one chunk (65.63 kB) after the first paint, mounting in their original order so they stack as before. Screens, copy and behavior are unchanged.
- Search index sync deletes every dirty document's old FTS rows before inserting any new ones and prepares its statements once per sync. Interleaving the two made FTS5 flush and merge a small segment per document; with every Session marked dirty (after a migration or redaction), the median of three interleaved runs on synthetic data fell from 4.79 to 2.53 s for 2,000 Sessions and from 11.87 to 5.32 s for 4,000, and every run was faster.

### Fixed

- Search index writes no longer fail with `ERR_OUT_OF_RANGE` (`Value is too large to be represented as a JavaScript number`) once the FTS5 index stores delete tombstones, whose shadow rowids exceed 2^53. The error rolled back every index sync, so reports, recall and Knowledge candidate lists returned HTTP 500 until the server restarted on a fixed build. FTS writes no longer read the connection's last insert rowid, and the rowid is reset after them. Stored data and the index were never damaged; no migration is needed.
- The release workflow publishes the exact commit the checks verified: it checks out `github.sha` instead of re-resolving the tag, refuses to publish if the tag was moved to another commit since, archives `GITHUB_SHA`, and no longer leaves the write-scoped token in `.git/config` while dependencies install and build.
- MCP launcher: a response to the launcher's own request that arrives after its wait timed out is dropped instead of reaching the Agent (the private ids also carry a per-launcher nonce); a cancelled request (`notifications/cancelled`) leaves the in-flight set, so it no longer holds back the next build; after one drain timeout for a build, later requests go to the running server without waiting again; and a first start waits at most 15 s for a leftover build marker instead of 120 s.

## [1.6.7] - 2026-11-07

[繁體中文更新說明](docs/releases/1.6.7.md).

### Changed

- The performance gate measures a failing case once more before failing, keeping every limit unchanged; the table marks re-measured cases with their first-pass p90. Shared CI runners had failed unrelated pull requests on single worker-operation passes (for example `exportProjectData` 410.94 and 477.33 ms, `createBackup` 336.61 ms).
- CI runs the three Playwright browsers as parallel jobs that start alongside the Quality matrix, and each OS runs the unit suite once (Ubuntu with coverage, Windows and macOS without). The required `E2E (Chromium + Firefox + WebKit)` check now aggregates the per-browser jobs; `E2E_PROJECTS` selects browsers for `pnpm test:e2e`.
- The `listSessionsPage (query)` benchmark and a new no-match worst case now have 300 ms limits in the performance check. `docs/testing.md` documents evaluation discipline for retrieval and knowledge experiments.
- The API runs database backups, whole-database exports, and project-data export/import previews on a dedicated worker thread. Startup automatic backup is delayed by 60 seconds; shutdown drains the worker before closing SQLite.
- The backup worker opens the current schema read-only, refuses a version mismatch without changing the database, keeps nested SQLite busy errors classifiable, and exits after 15 seconds idle. Project-data exports transfer UTF-8 bytes from the worker, and import preview JSON is parsed there from transferred request bytes.
- Snapshot publication cleans only abandoned private staging directories, checks the finished snapshot before publishing, refuses to replace an existing target, and leaves no publication-lock artifacts. It prefers an atomic hard link and falls back to an exclusive openSync(..., "wx") target reservation followed by rename; failed renames remove the reservation.
- Writable and read-only SQLite connections share the 5,000 ms busy timeout and 16,000 KiB page-cache configuration.
- Backup worker failures are scoped to their worker lifetime; startup busy errors remain classifiable by the HTTP layer.
- `work_get_context` calculates metadata follow-up totals with a SQLite aggregate instead of materializing every metadata preview item. Its SQL candidate logic matches the JavaScript preview semantics, including malformed legacy metadata.
- Finalize reminder lookup runs after the outermost immediate transaction commits, including MCP's compatible-schema transaction and idempotent resends. Related-item scoring first filters rows using the same keyword, source-session, and path relevance conditions. If the post-commit reminder lookup fails, finalize still reports the committed Session and omits `relatedOutstandingItems`.
- Knowledge staleness (`possiblyStale`) indexes a project's later Sessions once by normalized changed file and matches each distinct `appliesTo` pattern against distinct files once, instead of re-running every pattern over every later Session's files per Knowledge. Results (counts, first Session, paths, ordering) are unchanged; an equivalence test compares against the original algorithm.
- `getGraph` reads only the Session columns it needs and decodes only the Sessions its response can show (the newest per project, or one cursor page) instead of loading and JSON-decoding every Session; node, edge and total counts come from SQLite aggregates. Nodes, edges, totals, truncation and order are unchanged.
- Year-report agent decision totals and pending list pin `session_decisions` as the outer loop (`CROSS JOIN`), so the plan no longer flips to a full Session scan after `db:maintain` runs `ANALYZE`. `db:maintain` also runs `ANALYZE` once, after the search index rebuild, instead of twice.
- Attention source revisions for Knowledge pages, outstanding items, metadata backfill and cleanup proposals summarize their sources as `[count, latest updated_at, latest id]` instead of serializing every source row. A hidden or snoozed item still resurfaces when a source is added, updated, removed or voided; importing an older `updated_at` while deleting a different source in the same step is the one combination no longer detected.
- The `--force` bypass was removed from `pnpm db:restore`; an in-use database always blocks restoration.
- Schema 31 tracks project-data and Agent-read audit revisions separately. Project changes send the existing data-free `changed` event; Agent read audits send `agent-reads-changed`, which refreshes only Agent read history. Older MCP connections report `restartRequired` after the schema upgrade; reconnect Work Intelligence MCP.
- Storage coverage now measures all of `packages/storage/src` and enforces per-file thresholds on 27 high-risk services (policy helpers, redaction, reports, attention, related work, outstanding items, knowledge, data transfer, deletion, transactions) plus a looser floor for the rest. Added storage unit tests for `policy-helper` and the Agent report projection (`report-agent-view`).

### Fixed

- Metadata backfill previews no longer throw when a session's `changed_files_json` (or related metadata column) is stored as JSON `null`; non-array values are treated as empty, matching the SQL follow-up counts.
- System status checks the login service asynchronously, shares concurrent probes and caches successful results for 30 seconds, keeping the API responsive while the service manager is slow.
- Snapshot publication closes its exclusive fallback reservation once, including when the subsequent rename fails.

## [1.6.6] - 2026-10-30

[繁體中文更新說明](docs/releases/1.6.6.md).

### Added

- `pnpm service:restart` restarts an installed start-at-login service without rewriting its configuration, then waits up to 30 seconds for `/api/health` to report this checkout's version and fails with the log path otherwise. `pnpm bootstrap` now points to it after an update.

### Fixed

- On Windows, `pnpm service:install`, `service:restart` and `service:uninstall` now also stop the service runner process tree left behind by `schtasks /End`, which only ends the task's own conhost. Previously the old server kept port 3210 after an update, so the new version failed to start and the old one kept serving. Only runners whose command line contains this repository's `scripts/service-runner.mjs` are stopped.

## [1.6.5] - 2026-10-30

[繁體中文更新說明](docs/releases/1.6.5.md).

### Changed

- Focused `work_get_context` may return a separate, optional `relevant.supplements` list of compact one-hop parent/related Session and active applied Knowledge pointers from the three highest-ranked Sessions retained after normal budget trimming. The list is capped at four pointers and two per source; its entries identify the source relationship and Knowledge trust flags, and are described as possibly related indicators rather than literal-match evidence. Supplements are trimmed before existing context and recorded separately in `omitted`; the existing `relevant.sessions` and `relevant.knowledge` lists, recall ranking, confidence, database schema and input rules remain unchanged. `docs/mcp-tools.md` and the work-intelligence skill describe the response field.

## [1.6.4] - 2026-10-28

[繁體中文更新說明](docs/releases/1.6.4.md).

### Changed

- The `work_recall`, `work_search` and `work_get_context` tool descriptions, their contracts, the work-intelligence skill and `docs/mcp-tools.md` now tell an Agent what to do after reading the source: cite a record only when it directly supports the answer, and otherwise answer `資料不足` instead of inferring from wording overlap, `confidence`, rank or recency. Earlier wording only required reading the full record before citing. Ranking, `confidence`, responses and schema are unchanged; on the private evaluation all recall and context metrics stayed the same.

### Added

- `pnpm bench:recall-scale` also reports where answers found only in raw handoff text would land in a separate raw-only candidate list, to measure that idea without changing recall output. On the private evaluation the candidates added no missing answers and raised latency, so recall does not use them.
- Retrieval tests cover answerability: answered and unanswered questions with close wording, partially related hits, contradicting records, archived Knowledge and voided or restored Sessions, plus a deterministic MCP flow that reads the full source from each hit's id and checks the tool descriptions direct unsupported answers to `資料不足`. A known limitation is recorded as an expected-failure test: a later Session with no link to an older one does not outrank it.

## [1.6.3] - 2026-10-27

[繁體中文更新說明](docs/releases/1.6.3.md).

### Security

- Upgraded Zod to 4.6.7 to fix GHSA-mrhx-c7xc-m3w5, which has no patched Zod 3 release, and overrode body-parser@^2 to 2.4.0 to fix GHSA-27r3-jxmh-p828.

### Added

- `pnpm bench:recall-scale` measures recall and context ranking as synthetic distractor data grows (1,000, 5,000 and 10,000 Sessions by default), with near misses, outstanding items, Knowledge and Evidence, using the same evaluator as `pnpm eval:recall`. It runs locally only and writes nothing outside an OS temp folder. The first results are in `docs/knowledge-quality-roadmap.md`: answers that exist only in raw handoff text drop out of the top 30 by 1,000 Sessions, while Knowledge, structured Session, question, path and outstanding-item targets stay at rank 1–2.

### Changed

- Recall ranking counts query words that appear only in raw handoff text as half when it weighs how much of the query a record covers. Long imported handoffs mention many words in passing and used to outrank shorter records that answer in their title, summary or Knowledge body. On the private evaluation, recall MRR rose from 0.927 to 0.942 with three answers moving up and none down. Raw-only answers rank lower but are still returned; the coverage floor and `confidence` still use full coverage.
- Recall ranking now shows the latest state of a chain of work first. Among the top 100 ranked hits, a Session that continues an earlier hit (a `continues` link) and scores at least 30% of it is placed directly above that hit; the earlier record stays right after it and nothing is dropped. On the private evaluation, recall hit@1 rose from 0.861 to 0.884 and hit@5 from 0.977 to 1.000, and context hit@5 from 0.875 to 1.000. The `work_recall` contract, the work-intelligence skill and `docs/mcp-tools.md` describe the rule.
- The `work_recall`, `work_search` and `work_get_context` contracts, the work-intelligence skill and `docs/mcp-tools.md` now say that `confidence` `high` and `low` only measure how much of the query's wording a hit matches, not whether it answers the question, so an Agent reads the full record before citing any hit. A private retrieval evaluation found unanswered questions that still came back `high` and correct answers that came back `low`; the calculation itself is unchanged. The findings are recorded in `docs/knowledge-quality-roadmap.md`.

### Fixed

- `work_recall` and `work_get_context` read the stale and evidence state of all Knowledge hits in one batch. They used to look up each Knowledge hit on its own, rescanning the project's later Sessions every time, so a recall with many Knowledge hits slowed down as history grew: with 20 Knowledge hits over 5,000 Sessions, p90 went from 1,414 ms to 113 ms locally. Ranking and response content are unchanged. A new `pnpm test:performance` case keeps this under 250 ms.
- A project registered before project roots were canonicalized could keep its original spelling (on Windows, mixed case such as `C:\Users\...`). Lookups by folder use the canonical spelling, so such a tracked project read as unregistered and the MCP tools quietly skipped it. Opening the database now rewrites those roots to their canonical spelling, after the usual pre-migration backup. Only case and a trailing separator are changed: a root from another computer is left for the project location move, and a root whose canonical spelling already belongs to another project is left untouched.

## [1.6.2] - 2026-10-21

[繁體中文更新說明](docs/releases/1.6.2.md).

### Added

- `pnpm test:performance` now gates how long a manual backup, a whole-database export, a project-data export and an import preview block the server on 5,000 synthetic Sessions. Each runs 5 times and fails when its p90 exceeds its budget.

### Changed

- REST API error codes are all lowercase snake_case. The project and Session deletion codes were renamed and the old spellings are no longer sent: `PROJECT_NOT_FOUND` → `project_not_found` (the code the other project routes already used), `PROJECT_NAME_MISMATCH` → `project_name_mismatch`, `PROJECT_BACKUP_FAILED` → `project_backup_failed`, `PROJECT_DELETE_FAILED` → `project_delete_failed`, `SESSION_NOT_FOUND` → `session_not_found`, `SESSION_NOT_VOIDED` → `session_not_voided`, `SESSION_CITED_BY_PENDING_CLEANUP` → `session_cited_by_pending_cleanup`, `SESSION_BACKUP_FAILED` → `session_backup_failed`, `SESSION_DELETE_FAILED` → `session_delete_failed`. Scripts that match the old codes need the new ones. `docs/rest-api.md` now also documents when the API answers with an HTTP error and when with `200` plus `outcome` (`not_found`, `skipped`).

### Fixed

- `pnpm setup:agents` no longer refuses the Codex MCP block after Codex saves a per-tool approval (`[mcp_servers.work-intelligence.tools.<tool>]`) inside it. The approval tables are moved below the block and kept; any other edit inside the block is still refused.
- Codex hooks detection reads `~/.codex/config.toml` with a real TOML parser, so array tables (`[[skills.config]]`) and quoted headers containing brackets no longer make `setup:agents` and `pnpm check` report that it cannot tell whether hooks are disabled.
- `GET /api/health` now answers `ok: false` with its 503 when the database query fails; it used to say `ok: true`. An invalid `WORK_INTELLIGENCE_PORT` (anything but an integer from 1 to 65535) makes the API listen on the default port 3210, as `pnpm track` and the database-busy hint already assumed, instead of crashing at startup or, for `0`, listening on a random port.

## [1.6.1] - 2026-10-19

[繁體中文更新說明](docs/releases/1.6.1.md).

### Changed

- The architecture diagram reader lays out cards without authored positions along their connections: groups become blocks placed left to right by the links between them, blocks in the same column stack and center, and cards inside a group form sub-columns by their own links. Cycles turn back at the node declared first. Authored `position` values never move, and automatic cards are placed clear of them.
- Connections use orthogonal routes with rounded corners between the facing sides of two cards. Links that share a side get spread ports, routes go around cards in the way, parallel runs keep separate lanes, and among clear routes the one with the fewest crossings and bends wins.
- Edge labels are shown on the line in a pill (long labels are shortened; the full text stays in the tooltip). Each group gets one of six theme tones for its frame, its cards and its outgoing connections; hovering, focusing or selecting a card highlights its connections and dims the rest.
- Removed per-section refresh buttons whose data already updates on its own through the SQLite change stream and Agent request polling: Agent reads, open-item cleanup, metadata backfill status, AI report synthesis status, report presentation and the work report page. The header refresh, error retries, System status refresh and the backup list refresh (service and backup files live outside SQLite) stay.
- AI synthesis re-run buttons no longer read 重新整理: the small one says 重新產生／Regenerate and the main one 重新產生這份報告的整理. Knowledge page update/creation requests use the sparkles icon instead of the refresh icon.

The architecture reader is frontend only: the architecture JSON format, the database schema (30) and the MCP contracts are unchanged.

## [1.6.0] - 2026-10-16

[繁體中文更新說明](docs/releases/1.6.0.md).

### Added

- `pnpm check` (and therefore the last step of `pnpm bootstrap`) reports the free pages inside the database file as reclaimable space. With at least 1 MiB free and either 5 MiB or 20% of the file, it warns and suggests stopping the server and Agents and running `pnpm db:maintain`. The check is read-only and never runs VACUUM itself.

### Changed

- Backup retention is now 3 for manual backups, 3 for automatic daily backups and 3 for the Session-deletion snapshots (was 14 / 14 / 5). `WORK_INTELLIGENCE_BACKUP_KEEP` still overrides the manual count. Older backup files beyond the new limit are removed the next time a backup is written.
- Work-summary update history is pruned: for `session_work_summary_updates` rows older than 7 days, the stored previous/resulting work summary (only used to replay a retried `idempotencyKey`) is emptied. The request itself and the row stay, so the same key with different content still returns a conflict. The prune runs when the API server starts and then hourly with the backup check, needs no migration and never runs VACUUM; reclaim file space with `pnpm db:maintain` if wanted.
- Retrying an old `work_update_session_work_summary` key whose stored response was pruned returns `work_summary_updated` with `duplicate: true` and the Session's current work summary (without `previousWorkSummary`) instead of `not_found`.

Database schema remains 30; no migration is required.

## [1.5.3] - 2026-10-14

[繁體中文更新說明](docs/releases/1.5.3.md).

### Added

- `pnpm track <folder> [--name <name>] [--yes]`: a terminal-only way for the user to add a project and set it to Tracked. It resolves relative paths from where the command was run, previews the name, path and status change (with a warning when roots overlap other projects), and asks `[y/N]` before writing; without a terminal and without `--yes` it only previews. Agents (MCP) cannot track a project.
- `pnpm start` now prints a short reminder when an installed Agent skill copy or the Codex save-reminder hook is out of date, and points to `pnpm bootstrap` and `pnpm check`. The check only compares local files, prints nothing when everything is current or not installed, swallows every error, and never delays or blocks startup.
- `pnpm check` as the main name for the read-only diagnostics; `pnpm run doctor` keeps working. `pnpm bootstrap` step 5 and the docs now use the new name.
- When `pnpm db:maintain` or `pnpm db:redact --apply` cannot lock the database, the CLI now says why: whether the Work Intelligence server is running (and how to stop it), how many Agent MCP connections are active, or that another program may have the file open. The checks are read-only and never replace the original error.
- A bootstrap section in the release checklist for the Windows interactive install and update flow.

### Changed

- `scripts/run-pnpm.mjs` no longer passes an argument array together with `shell: true` on Windows, which removes the Node.js DEP0190 warning when scripts are run directly with `node`; arguments are quoted for cmd.exe and unsafe characters are rejected.
- MCP tests get the same 20 s timeout as the storage and server tests (30 s for the recall-evaluation tests), so Windows coverage runs no longer time out while SQLite waits on a briefly locked file.

Database schema remains 30; no migration is required.

## [1.5.2] - 2026-10-14

[繁體中文更新說明](https://github.com/Ponpon55837/WorkLog.Ai/blob/v1.5.2/docs/releases/1.5.2.md).

### Added

- `pnpm bootstrap` as the single install path: checks Node.js and pnpm, then installs, builds, connects Agents (`pnpm setup:agents`), optionally sets up start-at-login and runs the doctor. Global Agent and service settings keep their own preview and confirmation. Flags: `--yes`, `--skip-agents`, `--service`, `--help`. Re-running it after `git pull` updates the checkout; when the login service is already installed it reminds you to restart it with `pnpm service:install` instead of asking again.
- Doctor lists top-level `*.sqlite` files in the repository root (read-only) and reports a Windows drive-relative `WORK_INTELLIGENCE_DB` as an error.

### Changed

- `pnpm setup:agents` skips the manual MCP, skill and hook registration for an Agent whose Work Intelligence plugin is enabled, so plugin users do not get duplicate tools and reminders.
- `WORK_INTELLIGENCE_DB` is resolved the same way by the server, MCP, doctor and login service: relative paths resolve from the repository root, and a drive-relative path such as `C:Users...` (backslashes eaten by a shell) is rejected instead of silently creating a database in the working directory.
- The minimum Node.js version is 22.13 everywhere (`node:sqlite` needs no flag from 22.13); `engines.node` is declared in the root `package.json`.
- The README quick start is `git clone` → `pnpm bootstrap` → `pnpm start`; plugin and manual registration are listed as alternatives.

Database schema remains 30; no migration is required.

## [1.5.1] - 2026-10-11

[繁體中文更新說明](https://github.com/Ponpon55837/WorkLog.Ai/blob/v1.5.1/docs/releases/1.5.1.md).

### Fixed

- Save all eligible report synthesis sources and read their fixed IDs in pages, even after newer records push them outside the current-period 200-Session window. Report unavailable sources explicitly and scope evidence pagination to selected sources.
- Separate first-load, failure and empty synthesis states; guard creation while source status is unknown. Display saved citations separately from current-period totals and let readers expand long executive summaries.
- Preserve outstanding-item and cleanup-list reading positions during live updates by keeping stable item IDs.
- Bound pending report source pointers in general Agent context without discarding stored request sources.
- Keep the current report version before history when creation timestamps match, including bounded history pages.
- Omit reconnect recommendations when the MCP runtime is healthy.

### Added

- Default MCP Agent report previews with a configurable 24,000-character response budget, explicit omission metadata and full-source lookup instructions. `view: full` preserves the complete legacy response; REST report fields remain full.
- On-demand English STE-inspired and plain Traditional Chinese writing guides in the checkout, MCP resources and distributable plugin. Synthesis contract v4 keeps coverage diagnostics in one section and preserves factual and verification distinctions.

Database schema remains 30; no migration or historical content rewrite is required.

## [1.5.0] - 2026-10-11

[繁體中文更新說明](https://github.com/Ponpon55837/WorkLog.Ai/blob/v1.5.0/docs/releases/1.5.0.md).

### Changed

- Refresh both READMEs and the Traditional Chinese 1.5.0 release guide; retire 17 historical OpenSpec handoffs, preserving two unique audits under `docs/experiments/`.

- New diagrams require explicit architecture JSON v1. Historical Mermaid stays readable as escaped, copyable, downloadable source; remove Mermaid, KaTeX and their renderer dependencies without rewriting stored diagrams.

### Fixed

- Use the full available content width on every page and reserve stable scrollbar space, preventing width jumps when navigating to or from the graph.

- Keep cleanup request creation available during background list refreshes after the current project data has loaded; retain first-load and active-request guards.

- Add 12px content padding to Session related-work hints and align titles, dates and shared paths, with wrapping at narrow widths.

- Scale all 53 activity weeks to the available container width on load and resize, with square cells and responsive month labels; retain keyboard navigation and daily report links.

- Keep committed Knowledge creation and decision promotion successful when SSE supersedes a background refresh.

- Fit the timeline to its measured viewport automatically on first load, period/project changes and returning from list view; keep manual zoom during resize. Full-year ranges fit tablet widths.

- Move the dashboard activity heatmap directly below the page header into a full-width section, ahead of stats, weekly insights and attention lists.

- Reminder display preferences support hide, snooze for seven days and restore with source/preference CAS. Unresolved totals stay authoritative, changed sources resurface, and migration 30 includes portable transfer and permanent deletion.

### Added

- Agent Session reads support optional completion/handoff views and a fixed field whitelist with policy-gated, snapshot-consistent SQL loading. Keep full legacy reads unchanged, retain source safety flags and expose missing historical fields; projected structured metadata avoids duplicating source content.

- Preview and copy basic or current report-presentation Markdown with source gates, revision checks, escaped text and a download/manual-copy fallback. Clipboard success is shown only after a successful write.

- Dashboard weekly insights use full report totals with verification priority and scoped links.

- Report synthesis versions now have independent section pin/hide/restore controls and manual title/detail edits. The original summary and source references stay intact, edits are audited and portable, and concurrent changes keep the draft for an explicit comparison before applying.

- Suggest up to five same-project Sessions sharing confirmed files in Session detail. A covering file-posting index bounds hot-path reads, excludes existing links/voided or unavailable sources and reports partial coverage; suggestions never create links.

- Aggregate eight existing reminder sources in the Overview with project/type filters, URL pagination, bounded scrolling, explicit failed/partial coverage and policy-gated domain links. Knowledge links open the exact source history, and metadata backfill retains its project/request scope. Dashboard week dates come from the server clock; source status is changed only in its owning workflow.

### Documentation

- Document the staged Mermaid removal plan and the M1/M2 implementation completed for this release, covering native-format writes, safe historical-source reading, dependencies, data lifecycle and verification. Historical stored diagrams were not batch-rewritten.

- Document the five-feature integration study for attention aggregation, related-work suggestions, report section controls, dashboard insights and report copying, with UX wireframes, data/security boundaries, rollout criteria and a synthetic candidate-query probe. The study records staged research; completed production implementations for this release are listed above.

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

- Require explicit architecture v1 for new diagrams; keep historical Mermaid as escaped source with copy/download and remove the Mermaid/KaTeX runtime.

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
