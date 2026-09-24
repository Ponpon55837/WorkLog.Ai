---
name: work-intelligence
description: Use the Work Intelligence MCP to finalize or repair tracked-project work sessions, recall related past work before starting a task or when an error appears, retrieve saved context, backfill verified metadata, and synthesize requested reports. Do not use it to record untracked project work.
---

# Work Intelligence MCP

Use this skill whenever a user asks to save or correct a Work Intelligence work record, retrieve its context, repair metadata, or prepare a Work Intelligence report. The user-facing interaction stays natural-language only: do not ask the user to name MCP tools, provide request IDs or JSON, or direct the user through an internal tool sequence.

For the canonical field definitions, reporting granularity, and examples, read [the work record and report format](../../../docs/work-record-and-report-format.md). This skill describes how to apply that format through MCP.

## Privacy and project policy

- Project recording is explicit opt-in and default-deny. A project must be `tracked` before any project-scoped source, handoff, Git/worktree, or evidence inspection or write.
- Before reading project files outside MCP, check the workspace's recording status (the read-only project status lookup, or the project-scoped context lookup). If it is not tracked, or the result is `outcome: "skipped"`, or tracking cannot be confirmed, stop without inspecting or writing project data. Do not scan for handoffs or Git metadata first.
- `unregistered`, `paused`, and `ignored` are quiet skips. Do not create a Session, event, snapshot, metadata, evidence, Knowledge, or report source from them. Ask the user to enable tracking only when needed to explain why no record was made.
- Prefer MCP operations that enforce the policy gate. Honor every skipped result; never retry through direct filesystem access.

## Finalize a completed work session

Keep the existing planning → execution → verification → closing-handoff workflow unchanged. Confirm the workspace is tracked before preparing anything; if it is not, tell the user in one sentence that no record was made. After closing is complete, finalize the Session; finalization is a work-lifecycle event, not a Git commit. A commit is optional and must never be required or inferred.

Before finalizing, inspect only the tracked project's relevant worktree/diff to identify this task's intentional file changes. Do not claim files based on a title, summary, or commit alone; do not absorb unrelated pre-existing dirty changes. Use an empty `changedFiles` list only when no files were intentionally changed.

Write:

- `summary`: one concise, outcome-first executive sentence.
- `workSummary`: exactly five arrays, with short confirmed facts and no Markdown section headings:
  - `outcomes` / 成果 — confirmed deliveries or resolved problems; distinguish completed from merely implemented or investigated.
  - `scope` / 範圍 — important modules, APIs, UI, locales, tests, and verified change counts where useful; avoid a raw file dump.
  - `decisions` / 決策 — explicit technical/product decisions; include rationale only when the source states it.
  - `verification` / 驗證 — commands and actual results, coverage, manual confirmation, failures, and unverified areas.
  - `nextSteps` / 狀態／未結項 — only current known limitations, unresolved items, evidence gaps, or unverified scenarios. Never invent a recommendation, roadmap, or future plan. Use `[]` when none are known.
- `startedAt`: when this work actually began (for example the first user message of this conversation or the handoff's start), so work that spans days shows both days. Omit it when you do not know; never estimate it. `completedAt` defaults to the finalize time.
- `verification.status`: the machine-readable result (`passed`, `failed`, or `not_run`). Historical `not_supplied` means the original record omitted the status; do not rewrite it as `not_run` or assume success.
- Git fields: optional separate metadata containing only observed values. Changed files do not prove a commit.
- Events and evidence: record only supported facts and keep them separate from the five-section summary.

If this work relied on recalled Knowledge, report it when finalizing: Knowledge that proved still valid as applied, and Knowledge that turned out to be wrong as contradicted (then tell the user which one and why, so it can be updated or archived). Do not report Knowledge you did not actually use.

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
- **When the user asks about past work**: recall with their words; words are matched independently, so natural-language and Chinese questions work. If some words matched nothing (the result lists per-word hit counts), rephrase with other terms instead of concluding nothing exists.
- Knowledge marked possibly stale (its files changed after it was last confirmed) or needs review (a Session reported it wrong) must be checked against the current code before you rely on it.
- A Session hit may list related Sessions (the plan it implements, or its follow-up); check them when the hit alone does not explain the decision.
- Hits are compact. Open the full Session or Knowledge before relying on it, and cite the sessionId or knowledgeId you applied when you explain a decision or fix. If the record contradicts the current code, trust the code and say the record looks outdated.
- Stay within the tracked project's scope when the question is about this project. Do not substitute an unrestricted repository scan for missing recorded context; if nothing relevant is recorded, say so briefly and continue.

## Context, search, and Knowledge

To find a specific Session (for example before correcting it), recall or list Sessions within the tracked project and then read that one Session in full; do not guess a sessionId. Pending report and metadata requests also appear in the context result.

Record or update Knowledge only when the user asks or when the MCP workflow explicitly calls for it, and only with reusable, source-supported facts; do not turn guesses or an entire Session transcript into Knowledge. When recording, set the paths it applies to when they are clear, and name the older Knowledge it replaces instead of leaving both active.

When responding, summarize what was saved or corrected, report verification and remaining gaps accurately, and keep internal MCP mechanics out of the user-facing instructions.
