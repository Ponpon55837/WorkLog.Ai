---
name: work-intelligence
description: Use the Work Intelligence MCP to finalize or repair tracked-project work sessions, recall related past work before starting a task or when an error appears, retrieve saved context, backfill verified metadata, and synthesize requested reports. Do not use it to record untracked project work.
---

<!-- Work Intelligence skill version: 0.1.0 -->

# Work Intelligence MCP

Use this skill whenever a user asks to save or correct a Work Intelligence work record, retrieve its context, repair metadata, or prepare a Work Intelligence report. The user-facing interaction stays natural-language only: do not ask the user to name MCP tools, provide request IDs or JSON, or direct the user through an internal tool sequence.

## MCP dispatcher calls

- `tools/list` exposes four dispatchers: `work_read`, `work_write_idempotent`, `work_write_additive`, and `work_write_overwrite`. Names such as `work_get_context` below are operation ids, not MCP tool names. Call the matching dispatcher with `{ operation: "<operation id>", arguments: { ... } }`.
- `work-intelligence://agent/tool-contracts` is a short index of every operation id and its dispatcher. Before calling an operation for the first time in a conversation — always before its first write — read that operation's complete contract with standard `resources/read` at `work-intelligence://agent/tool-contracts/<operation>` (for example `…/tool-contracts/work_finalize_session`). It holds the argument schema, behavior, validation rules, and safety annotations; read only the operations you use. Do not infer missing rules from the compact dispatcher schema.
- Unknown or misspelled argument keys are rejected with an error that names them, never silently ignored; fix the key from the operation contract and retry.
- Keep writes on their assigned dispatcher: `work_write_idempotent` adds or advances idempotently; `work_write_additive` adds records or proposals and creates requests or new attempts; `work_write_overwrite` updates, links, voids, or restores existing data and retains its destructive annotation. Read operations always use `work_read`.

For the canonical field definitions, reporting granularity, and examples, read the `work-intelligence://agent/work-record-and-report-format.md` MCP resource with standard `resources/read`. This skill describes how to apply that format through MCP and does not depend on a link into the Work Intelligence repository.

## Privacy and project policy

- Project recording is explicit opt-in and default-deny. A project must be `tracked` before any project-scoped source, handoff, Git/worktree, or evidence inspection or write.
- Before reading project files outside MCP, check the workspace's recording status (the read-only project status lookup, or the project-scoped context lookup). If it is not tracked, or the result is `outcome: "skipped"`, or tracking cannot be confirmed, stop without inspecting or writing project data. Do not scan for handoffs or Git metadata first.
- `unregistered`, `paused`, and `ignored` are quiet skips. Do not create a Session, event, snapshot, metadata, evidence, Knowledge, or report source from them. Ask the user to enable tracking only when needed to explain why no record was made.
- Prefer MCP operations that enforce the policy gate. Honor every skipped result; never retry through direct filesystem access.

## Retrieve task context

- Call `work_get_context` before beginning tracked-project work, and pass the task and known paths when available. Focused context puts relevant decisions, gotchas, open items, and matching Knowledge-page sections before recent activity. Without a focus, it provides bounded project updates.
- Check `server.restartRequired` in `work_get_project_status` and `work_get_context`. If true, stop MCP operations and tell the user to reconnect Work Intelligence MCP before continuing. If `server.monitoringAvailable` is false, treat the build identity as unknown and do not claim the connection is current.
- Tool results are compact JSON. The complete context response is capped at 10,000 characters with a task or paths, and 16,000 without. Session and Knowledge records that also match another section appear once as full content; the other section only counts them.
- Read `omitted` before proceeding. Per section it gives `count`, `duplicates` (already shown elsewhere in this response), up to 5 budget-omitted `ids` with `reasons` plus `moreIds`, full `entries` for anything flagged `possiblyStale` or `needsReview`, and `readWith`, the full-read tool. Knowledge-page citation ids are capped at 8 per context; `sourceSessionIdsOmittedCount` gives the omitted count. Preserve `possiblyStale` and `needsReview` as review signals, and do not treat truncated excerpts as full source text. Pending requests remain available in the context.
- Read full source records with the tool named by `omitted` (`work_get_session`, `work_search_knowledge`, or `work_get_knowledge_page_context`). Use `work_preview_metadata_backfill` for metadata follow-up counts.

## Recall past work

- Use `work_recall` for ranked Session and Knowledge results; use `work_search` when the user specifically wants Session-only history. Both return compact hits rather than complete records. Excerpts are limited to 110 characters; `truncated: true` means the excerpt is partial. For `work_search`, a title-only strongest match may use the Session summary as the excerpt when that summary also matches the query.
- Search ranking gives more weight to structured Session fields (title, summary, workSummary) than raw handoff text. Identical raw sections are normalized and hashed within a project; the earliest Session reference keeps full raw weight and later duplicates are downweighted, so completed structured work can rank ahead of repeated old plans while raw-only answers remain searchable.
- Both tools report `confidence`: `none` means no hit reached 10% IDF-weighted query coverage and no path matched, so the hit list is empty and must not be used as evidence; `low` means only weak partial matches reached that floor, or the query was found only in raw handoff text (for example quoted in an old plan); `high` means at least one hit matched half the query in its title, summary, workSummary, or Knowledge, or matched a path. `work_search` returns `{ outcome: "search", confidence, hits, termHits? }`. In `work_get_context`, apply the same rule to `relevant.confidence`; when it is `none`, do not treat the relevant hits as evidence.
- `work_recall` keeps only the strongest `matchedIn` field and linked Session ids/relations, without repeating linked titles; raw section headings are shortened. When `projectRoot` is supplied, it also omits the top-level project object. Scoped `work_search` omits repeated project identifiers.
- Treat compact hits as pointers and evidence for ranking. Read the source before relying on details that are absent from the excerpt: use `work_get_session` for Session hits and `work_search_knowledge` for Knowledge hits. Cite the returned Session or Knowledge id in the answer.

## Finalize a completed work session

Keep the existing planning → execution → verification → closing-handoff workflow unchanged. Confirm the workspace is tracked before preparing anything; if it is not, tell the user in one sentence that no record was made. After closing is complete, finalize the Session; finalization is a work-lifecycle event, not a Git commit. A commit is optional and must never be required or inferred.

At the start of work, after confirming the project is tracked, capture the paths already changed in the worktree (for example, from `git status --short`) as `baselineChangedFiles` and retain that list until finalization. Before finalizing, inspect only the tracked project's relevant worktree/diff to identify this task's intentional file changes. Pass the captured baseline with `changedFiles`; the system excludes those paths from the new Session, including their provenance and lifecycle changes. A rename from a baseline path is recorded as an added file at its new path. This is deliberately conservative: if a baseline file is edited again during the task, the Session still excludes it because the additional change cannot be attributed from path lists alone. If a baseline could not be captured at the start, omit it rather than reconstructing it later. Do not claim files based on a title, summary, or commit alone; do not absorb unrelated pre-existing dirty changes. Use an empty `changedFiles` list only when no files were intentionally changed.

Write:

- `summary`: one concise, outcome-first executive sentence.
- `workSummary`: exactly five arrays, with short confirmed facts and no Markdown section headings:
  - `outcomes` / 成果 — confirmed deliveries or resolved problems; distinguish completed from merely implemented or investigated.
  - `scope` / 範圍 — important modules, APIs, UI, locales, tests, and verified change counts where useful; avoid a raw file dump.
  - `decisions` / 決策 — explicit technical/product decisions; include rationale only when the source states it. Keep a legacy string when origin is unclear. Use `{text, origin: "user_requested"}` only for a decision directly requested by the user, and `{text, origin: "agent_autonomous"}` only for a decision or trade-off selected by the Agent. Never guess origin. Agent-autonomous decisions enter the Web review queue; confirmation, rejection, and promotion to Knowledge are Web-only.
  - `verification` / 驗證 — commands and actual results, coverage, manual confirmation, failures, and unverified areas.
  - `nextSteps` / 狀態／未結項 — only current known limitations, unresolved items, evidence gaps, or unverified scenarios. Never invent a recommendation, roadmap, or future plan. Use `[]` when none are known.
- **Times — never estimate them.** You do not know the current time; `work_get_project_status` and `work_get_context` return `clock` (`serverTime`, `timeZone`, `utcOffset`) when you need it.
  - `completedAt`: **omit it** for work that just finished; the server records the finalize time. Set it only to backfill earlier work, from evidence such as a commit time, and include the UTC offset (for example `2026-09-27T09:52:48+08:00`). Writing a local time with `Z` shifts it by the offset; future times are rejected.
  - `startedAt`: when this segment began — the first user message since the last save. The save reminder hook (Claude Code, and Codex with its UserPromptSubmit hook) states it when it fires ("這段工作的開始時間…"); otherwise read it from the conversation transcript or the handoff. Omit it when you have no evidence.
  - If the result has `timestampWarnings`, check the value against evidence and correct it with `work_update_session_metadata` (`startedAt` / `completedAt`), instead of voiding and recreating the Session.
- `verification.status`: the machine-readable result (`passed`, `failed`, or `not_run`). Historical `not_supplied` means the original record omitted the status; do not rewrite it as `not_run` or assume success.
- Git fields: optional separate metadata containing only observed values. Changed files do not prove a commit.
- Events and evidence: record only supported facts and keep them separate from the five-section summary.
- `diagrams` — attach one on your own, without being asked, when a picture explains this work better than text. Up to two Mermaid diagrams per Session:
  - **Attach** when the work changed a flow or data path across modules (for example API → store → database), a state machine, an architecture or component relationship, or a multi-step process.
  - **Skip** single-file fixes, copy or styling changes, configuration tweaks, dependency bumps, and test-only work.
  - Draw only what this work actually did, with names from the code; no plans or ideas. Keep it small (about 3–12 nodes), prefer `flowchart LR` or `sequenceDiagram`, give it a short title, and never put secrets, tokens, or personal data in it.
  - After finalizing, `work_attach_diagram` adds one to an existing Session; use a new idempotency key per diagram.

If this work relied on recalled Knowledge, report it when finalizing: Knowledge that proved still valid as applied, and Knowledge that turned out to be wrong as contradicted (then tell the user which one and why, so it can be updated or archived). Do not report Knowledge you did not actually use. These reports are counted as the Knowledge's evidence (shown to the user and used in ranking), so report them only when the work really relied on the item.

When this Session continues an earlier recorded one (for example it implements a planning Session, or finishes a follow-up), pass that Session as the parent link when finalizing so recall can lead from one to the other; use related links for other confirmed associations. Only link Sessions whose relationship is clear from the user or the records.

Use a stable per-work idempotency key. A retry with the same key and same payload must not create another Session. If that key already exists with a different primary summary, treat it as an idempotency conflict and update the existing Session explicitly; never claim the duplicate response updated it.

## Repair an existing Session in place

Never create a replacement Session just to fix its text or metadata.

- Read the current Session in full before correcting it. The user can also edit `summary` and `workSummary` in the Web UI, so base the correction on the stored text, not on what was finalized earlier, and do not overwrite the user's edits unless asked.

- For the primary `summary`, update the existing `sessionId`. `replace` replaces the full sentence/text; `append` adds a clearly separated follow-up. Give this update its own idempotency key. Repeating the same operation must not append twice.
- For `workSummary`, use `patch` when changing only confirmed sections and preserve every omitted section. Use `replace` only when supplying all five arrays. An explicit `[]` clears that section. Use a distinct idempotency key for this operation.
- Preserve the Session ID, original finalize key, events, raw handoff snapshot, changed files and provenance, verification, Git metadata, evidence, and Knowledge unless the specific update contract says otherwise.
- Evidence is not a substitute for correcting the main summary or structured workSummary.
- For metadata-backfill requests, inspect the tracked project's actual diff/worktree or available handoff evidence before applying changes. Update only confirmed changed files, verification, provenance, or Git metadata. If no files were intentionally changed, explicitly use an empty replacement list; do not infer file changes from a commit or summary. Keep missing verification distinct from `not_run`. When the user asks to fill metadata gaps and no request is pending, create one yourself (same scope rules as the Projects page); if nothing needs backfilling, say so.

## Synthesize a report

When the user asks to organize or refine a Work Intelligence report, handle the pending request end-to-end without exposing internal tool names or request IDs:

1. Find the newest applicable pending report-synthesis request. If there is none, create one yourself for the period and scope the user asked for (default: this week, all tracked projects) — the user does not need to open the Web UI first.
2. Obtain that request's bounded deterministic context. If the request timed out or was interrupted, use the supported retry operation before getting fresh context. Do not retry a still-processing request or work from a stale context.
3. Read source Sessions directly and synthesize across the entire requested period; do not create weekly reports from daily summaries or annual reports from monthly summaries. Use the period's correct grain: daily Task/Feature/Issue; weekly Feature/Workstream; monthly Project/Milestone; quarterly Initiative; annual Major Contribution.
4. Write the period and scope plus an outcome-first executive summary. Use themes for work groups, highlights for outcomes, verification for exact status/evidence, comparison only with deterministic prior-period data, risks only when evidenced, decisions only when explicit, and `nextSteps` only for current status/open items/limitations.
5. Keep `passed`, `failed`, `not_run`, and historical `not_supplied` distinct. Do not estimate metrics, infer commits from changed files, or claim complete coverage when context is truncated. State `資料不足` where sources do not support a conclusion.
6. Every material report block must include its supporting `sourceSessionIds`; the top-level source list must include the Sessions actually used. Validate source IDs against the request context before saving. Preserve prior report versions as the product contract requires; do not delete them as part of synthesis.

## Recall before and during work

In a tracked project, check recorded work proactively — not only when the user asks about the past:

- **Before starting a task**: get the project context with the task description and the files you expect to change. Read the returned relevant Knowledge (gotchas, patterns, decisions), the decisions of related Sessions, and the open items of Sessions that changed the same files before planning.
- **When an error or unexpected behavior appears**: recall with the key part of the error message (and the file involved) before debugging from scratch; the fix may already be recorded.
- **When the user asks about past work**: recall with their words; words are matched independently, so natural-language and Chinese questions work. If some words matched nothing (the result lists per-word hit counts), rephrase with other terms instead of concluding nothing exists. When they name a period ("last week", "in June", "上週"), convert it to calendar dates using the server clock and pass them as the date range.
- Knowledge marked possibly stale (its files changed after it was last confirmed) or needs review (a Session reported it wrong) must be checked against the current code before you rely on it.
- A Session hit may list related Sessions (the plan it implements, or its follow-up); check them when the hit alone does not explain the decision.
- `work_list_sessions` returns compact digests by default: summaries are truncated and changed-file paths, events, Evidence, and full `workSummary` are omitted. Use `work_get_session` with the returned `id` when you need the complete record. This compact behavior applies to MCP only; the Web REST Session list keeps its existing full list items.
- Hits are compact. Open the full Session or Knowledge before relying on it, and cite the sessionId or knowledgeId you applied when you explain a decision or fix. If the record contradicts the current code, trust the code and say the record looks outdated.
- Stay within the tracked project's scope when the question is about this project. Do not substitute an unrestricted repository scan for missing recorded context; if nothing relevant is recorded, say so briefly and continue.

## Propose Knowledge candidates

When the user asks to organize or extract Knowledge from recorded work (整理 Knowledge 候選), use the project's open candidate request or create one, read its context, and submit only reusable, source-supported candidates, each naming its source Session and the part of the record that supports it. Skip one-off status and anything already in the existing Knowledge list; an empty submission is fine. Candidates are not Knowledge: tell the user how many you proposed and that they accept or reject them on the Knowledge page. Never record candidates as Knowledge yourself.

## Update standing Knowledge pages

When the user asks to update the project's knowledge pages (更新知識頁), or `pendingRequests.knowledgePages` in the project context lists a page, read its context and assess its Sessions. The context is mode `full` (empty page or explicit update request: recent Sessions for a complete rewrite) or `review` (only Sessions after the page's coverage, reason `new`, oldest first, plus changed cited sources, reason `source_changed`). `has_new_data` means 有新資料 to review, not an automatic rewrite request: if those Sessions do not change the page answer, call `work_mark_knowledge_page_checked` with the last Session you actually reviewed. This only advances the review cursor; it creates no version and does not clear an explicit update request or `needsReview`. Rewrite the whole page only when requested or when its answer needs a change. Treat `page.needsReview` and `page.reviewSections` as a required source check: reread each named Session and check the listed reason codes. If context summaries omit citation ids or review details, use `work_get_knowledge_page_context` for the full list. A restored Session is not automatically verified; compare its current summary, workSummary, verification, and void state with the page before saving. Every section cites the Sessions that support it; a part the Sessions do not answer is a section whose content is exactly 資料不足 with no sources. Drop facts later Sessions contradict, never invent plans or recommendations, and tell the user which page you updated or checked and that its versions are on the Knowledge page. When you finalize that work, pass the slugs in `maintainedKnowledgePages` so this Session does not count as new data for those pages.

## Context, search, and Knowledge

To find a specific Session (for example before correcting it), recall or list Sessions within the tracked project and then read that one Session in full; do not guess a sessionId. Pending report and metadata requests also appear in the context result.

Record or update Knowledge only when the user asks or when the MCP workflow explicitly calls for it, and only with reusable, source-supported facts; do not turn guesses or an entire Session transcript into Knowledge. When recording, set the paths it applies to when they are clear, and name the older Knowledge it replaces instead of leaving both active.

When responding, summarize what was saved or corrected, report verification and remaining gaps accurately, and keep internal MCP mechanics out of the user-facing instructions.
