# Repair and backfill Sessions

Read this guide with the core [Work Intelligence skill](../SKILL.md) before you correct a saved Session or backfill its metadata. The core's privacy rules apply first: inspect nothing of a project that is not confirmed tracked.

## Repair an existing Session in place

Never create a replacement Session just to fix its text or metadata.

- Read the current Session in full before correcting it. The user can also edit `summary` and `workSummary` in the Web UI, so base the correction on the stored text, not on what was finalized earlier, and do not overwrite the user's edits unless asked.
- For the primary `summary`, update the existing `sessionId`. `replace` replaces the full sentence/text; `append` adds a clearly separated follow-up. Give this update its own idempotency key. Repeating the same operation must not append twice.
- For `workSummary`, use `patch` when changing only confirmed sections and preserve every omitted section. Use `replace` only when supplying all five arrays. An explicit `[]` clears that section. Use a distinct idempotency key for this operation.
- Preserve the Session ID, original finalize key, events, raw handoff snapshot, changed files and provenance, verification, Git metadata, evidence, and Knowledge unless the specific update contract says otherwise.
- Evidence is not a substitute for correcting the main summary or structured workSummary.
- Update results are receipts like finalize's: the Session id, times, verification status, and changed-file count, plus only what the server changed (stored text or changed files that differ from what you sent, redaction counts, `timestampWarnings`). Read the Session again only when you need its full stored text.

## Records saved at task start

If the user explicitly asks for a record at task start, save the same task as verification.in_progress with a verifiable startedAt from the conversation or hook. Update that record at closing with the actual verification, completion time, outcomes, and observed Git metadata. Do not guess timestamps or create a replacement record merely to change its status.

## Backfill metadata

For metadata-backfill requests, inspect the tracked project's actual diff/worktree or available handoff evidence before applying changes. Update only confirmed changed files, verification, provenance, or Git metadata. If no files were intentionally changed, explicitly use an empty replacement list; do not infer file changes from a commit or summary. Keep missing verification distinct from `not_run`. When the user asks to fill metadata gaps and no request is pending, create one yourself (same scope rules as the Projects page); if nothing needs backfilling, say so.

## Normalize existing work summaries

When normalizing existing records, update the same finalized Session with `work_update_session_work_summary` (the Web UI Session editor uses the same in-place update); read the current Session first, because the user may already have edited it; do not create replacement Sessions or alter their primary summary, events, evidence, changed files, verification status, Git metadata, or snapshots. Read all available structured and raw source under the tracked-project policy gate. Preserve confirmed facts, remove unsupported or duplicated claims, and replace future-looking `nextSteps` with objective current-state facts or `[]`. If source data is unavailable or a project is not tracked, do not read it or fabricate a replacement.
