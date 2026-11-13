# Changelog

All notable changes to Work Intelligence are documented here. The project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
