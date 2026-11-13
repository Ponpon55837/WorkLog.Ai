---
name: work-intelligence
description: Use the Work Intelligence MCP to finalize or repair tracked-project work sessions, recall related past work before starting a task or when an error appears, retrieve saved context, backfill verified metadata, and synthesize requested reports. Do not use it to record untracked project work.
---

<!-- Work Intelligence skill version: 0.2.0 -->

# Work Intelligence MCP

Use this skill whenever a user asks to save or correct a Work Intelligence work record, retrieve its context, repair metadata, or prepare a Work Intelligence report. The user-facing interaction stays natural-language only: do not ask the user to name MCP tools, provide request IDs or JSON, or direct the user through an internal tool sequence.

## Privacy and project policy

- Project recording is explicit opt-in and default-deny. A project must be `tracked` before any project-scoped source, handoff, Git/worktree, or evidence inspection or write.
- Before reading project files outside MCP, call `work_get_context` once with `projectRoot`, plus the task and the files you plan to touch as `paths` (Knowledge written for those files, even a possiblyStale one, is matched through `paths`): one call returns `tracked` and `projectStatus` with the context, so do not also call `work_get_project_status` (use that only for a status check without context). If `tracked` is not `true`, the result is `outcome: "skipped"`, or tracking cannot be confirmed, stop without inspecting or writing project data. Do not scan for handoffs or Git metadata first.
- `unregistered`, `paused`, and `ignored` are quiet skips. Do not create a Session, event, snapshot, metadata, evidence, Knowledge, or report source from them. Ask the user to enable tracking only when needed to explain why no record was made.
- When the user says something must not be stored, wrap it in `<private>…</private>` in any text you write, always with the closing tag; the block is removed before storage, and an unclosed tag is stored as written.
- Never put secrets, tokens, or personal data in a record, a diagram, or Knowledge; sensitive values that slip through are masked before storage.
- Prefer MCP operations that enforce the policy gate. Honor every skipped result; never retry through direct filesystem access.
- Stay within the tracked project's scope when the question is about this project. Do not substitute an unrestricted repository scan for missing recorded context; if nothing relevant is recorded, say so briefly and continue.

## MCP dispatcher calls

- `tools/list` exposes four dispatchers: `work_read`, `work_write_idempotent`, `work_write_additive`, and `work_write_overwrite`. Names such as `work_get_context` below are operation ids, not MCP tool names: call the dispatcher named in the operation index (`work-intelligence://agent/tool-contracts`) with `{ operation: "<operation id>", arguments: { ... } }`. Read operations always use `work_read`.
- Before calling an operation for the first time in a conversation — always before its first write — read its complete contract with standard `resources/read` at `work-intelligence://agent/tool-contracts/<operation>`: argument schema, behavior, validation rules, and safety annotations. Read only the operations you use. Do not infer missing rules from the compact dispatcher schema.
- Unknown or misspelled argument keys are rejected with an error that names them, never silently ignored; fix the key from the operation contract and retry.
- Check `server.restartRequired` in `work_get_context` (or `work_get_project_status`). If true, stop MCP operations and tell the user to reconnect Work Intelligence MCP before continuing. Only `restartRequired` stops operations; `server.updateAvailable: true` permits normal reads and writes, with one reminder to reconnect at closing. If `server.monitoringAvailable` is false, treat the build identity as unknown and do not claim the connection is current.

## Guides to read on demand

Each guide is the MCP resource `work-intelligence://agent/work-intelligence/references/<guide>.md` and, in a plugin or checkout, the file `references/<guide>.md` beside this one. Read a guide when its flow starts; it does not repeat the rules here.

- `reading-records` — before you read Sessions in part, page context omissions, or rely on recall and Knowledge search details.
- `diagrams` — before you attach a diagram to a Session.
- `repair-and-backfill` — before you correct a saved Session or backfill its metadata.
- `outstanding-cleanup` — before you review outstanding items for a 整理未結項 request.
- `synthesis` — before you synthesize a report, or write or revise Session summaries and reports.
- `knowledge` — before you propose Knowledge candidates, update Knowledge pages, or record Knowledge.

The field definitions, evidence rules, and examples of a Session record are in `work-intelligence://agent/work-record-and-report-format.md`.

## Start of work

- After confirming the project is tracked, capture the paths already changed in the worktree (for example, from `git status --short`) as `baselineChangedFiles` and retain that list until finalization.
- Before planning, read the returned relevant Knowledge (gotchas, patterns, decisions), the decisions of related Sessions, and the open items of Sessions that changed the same files.
- Before editing a file with history, call `work_get_file_history` with `projectRoot` and 1–3 repository-relative `paths`.
- **When an error or unexpected behavior appears**: recall with the key part of the error message (and the file involved) before debugging from scratch; the fix may already be recorded.
- **When the user asks about past work**: recall with their words (`work_recall`; `work_search` for Session-only history). If some words matched nothing, rephrase instead of concluding nothing exists. Convert a named period ("上週") to calendar dates using the server clock and pass them as the date range.
- A record the user asks for at task start follows the repair-and-backfill guide.

## Rely only on what a source supports

- Hits, digests, previews, and context items are compact pointers. Read the full source (`work_get_session` with `view: "handoff"`, or the tool `omitted.readWith` names) before relying on details that are absent from the excerpt, and cite the sessionId or knowledgeId you applied. Do not treat truncated excerpts as full source text.
- `confidence` (and `relevant.confidence` in context) only measures how much of the query's wording a hit matches, not whether it answers the question. When it is `none`, the hits must not be used as evidence; read the full record before citing any hit, whatever its confidence.
- Knowledge marked possibly stale (its files changed after it was last confirmed) or needs review (a Session reported it wrong) must be checked against the current code before you rely on it. If the record contradicts the current code, trust the code and say the record looks outdated.
- After reading the full source, cite it only when it directly supports the answer. If no source supports the answer, say `資料不足`; do not infer from wording overlap, confidence, rank, recency, or a partial excerpt.

## Finalize a completed work session

Keep the existing planning → execution → verification → closing-handoff workflow unchanged. After closing is complete, finalize the Session; finalization is a work-lifecycle event, not a Git commit. A commit is optional and must never be required or inferred.

1. **Refresh context.** Refresh `work_get_context` once with `projectRoot`, this task, and actual changed paths; this refresh is the tracking check, so no separate status call is needed. If it is skipped (`tracked` is not `true`), prepare nothing and tell the user in one sentence that no record was made.
2. **Outstanding items.** Inspect `relevant.outstandingItems` and read each applicable source Session before relying on a pointer. Only items this work directly verified as complete belong in `resolvedOutstandingItemIds`. When this Session’s nonempty `nextSteps` explicitly replace older pending work, put those ids in `supersededOutstandingItemIds`. Never use the ranking, wording, or reminder as completion evidence; leave uncertain items unchanged. Items held by an active 整理未結項 request go through its review instead; never close them with `resolvedOutstandingItemIds` or `supersededOutstandingItemIds` to bypass it (see the outstanding-cleanup guide).
3. **Changed files.** Inspect only the tracked project's relevant worktree/diff to identify this task's intentional file changes. Pass the captured baseline with `changedFiles`; the system excludes those paths from the new Session. If a baseline could not be captured at the start, omit it rather than reconstructing it later. Do not claim files based on a title, summary, or commit alone; do not absorb unrelated pre-existing dirty changes. Use an empty `changedFiles` list only when no files were intentionally changed.
4. **Write the record** by the work record contract in the `work_finalize_session` contract: one outcome-first `summary` sentence and exactly five `workSummary` arrays of short confirmed facts. `nextSteps` / 狀態／未結項 holds only current known limitations, unresolved items, evidence gaps, or unverified scenarios; never invent a recommendation, roadmap, or future plan. Never guess a decision's origin. Agent-autonomous decisions enter the Web review queue; confirming, rejecting, and promoting them to Knowledge are Web-only. `in_progress` does not mean passed. Git fields contain only observed values; changed files do not prove a commit.
5. **Times — never estimate them.** You do not know the current time; `work_get_context` (and `work_get_project_status`) return `clock` (`serverTime`, `timeZone`, `utcOffset`) when you need it.
   - `completedAt`: **omit it** for work that just finished; the server records the finalize time. Set it only to backfill earlier work, from evidence such as a commit time, and include the UTC offset (for example `2026-09-27T09:52:48+08:00`). Writing a local time with `Z` shifts it by the offset; future times are rejected.
   - `startedAt`: when this segment began — the first user message since the last save. The save reminder hook states it ("這段工作的開始時間…") and the optional compaction hooks restate it after a compaction; otherwise read it from the conversation transcript or the handoff. Omit it when you have no evidence.
   - If the result has `timestampWarnings`, check the value against evidence and correct it with `work_update_session_metadata` (`startedAt` / `completedAt`), instead of voiding and recreating the Session.
6. **Knowledge you used.** Report recalled Knowledge that proved still valid as applied, and Knowledge that turned out to be wrong as contradicted (then tell the user which one and why, so it can be updated or archived). These reports count as the Knowledge's evidence (shown to the user and used in ranking), so do not report Knowledge you did not actually use.
7. **Links.** When this Session continues an earlier recorded one (for example it implements a planning Session, or finishes a follow-up), pass it as the parent link so recall can lead from one to the other; use related links for other confirmed associations. Only link Sessions whose relationship is clear from the user or the records.
8. **Diagrams.** Attach one on your own, without being asked, when the work changed a flow or data path across modules (for example API → store → database), a state machine, an architecture or component relationship, or a multi-step process; skip single-file fixes, copy or styling changes, configuration tweaks, dependency bumps, and test-only work. Read the diagrams guide before drawing one.
9. **Idempotency.** Use a stable per-work idempotency key. A retry with the same key and same payload must not create another Session. If that key already exists with a different primary summary, treat it as an idempotency conflict and update the existing Session explicitly; never claim the duplicate response updated it.
10. **Read the receipt.** The result is a receipt, not an echo of what you sent: ids, times, counts, and only what the server derived or changed. Inspect the `relatedOutstandingItems` hint without guessing completion. For each `knowledgeToReview` item: confirm it with `work_update_knowledge` (`confirm: true`) if it still holds, tell the user and update it with their confirmation if your change made it wrong, and leave it when unsure.

## Other requests

- To find a specific Session (for example before correcting it), recall or list Sessions within the tracked project and then read that one Session in full; do not guess a sessionId. Pending report and metadata requests also appear in the context result.
- Never create a replacement Session just to fix its text or metadata; read the repair guide first.
- Record or update Knowledge only when the user asks or when the MCP workflow explicitly calls for it, and only with reusable, source-supported facts; read the knowledge guide first.
- When a project context carries `pendingRequests.knowledgeBacklog` (uncovered Sessions, many with confirmed decisions, recovered verification, or later work built on them), mention it to the user at most once in the conversation as an offer to organize Knowledge candidates. Do not create a request unless the user asks; a failed request in `pendingRequests.knowledgeCandidates` is resumed, not replaced. Read the knowledge guide before acting.

When responding, summarize what was saved or corrected, report verification and remaining gaps accurately, and keep internal MCP mechanics out of the user-facing instructions.
