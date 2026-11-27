---
name: work-intelligence
description: Use the Work Intelligence MCP to finalize or repair tracked-project work sessions, recall related past work before starting a task or when an error appears, retrieve saved context, backfill verified metadata, synthesize requested reports, and handle Agent review requests, Knowledge candidates and Knowledge page updates. Do not use it to record untracked project work.
---

<!-- Work Intelligence skill version: 0.2.0 -->

# Work Intelligence MCP

Use this skill when asked to save or correct a Work Intelligence record, retrieve its context, repair metadata, or prepare a report. Talk to the user in plain language, not tool names, IDs, JSON, or call order.

## Privacy and project policy

- Project recording is explicit opt-in and default-deny. A project must be `tracked` before any project-scoped source, handoff, Git/worktree, or evidence inspection or write.
- Before reading project files outside MCP, call `work_get_context` once with `projectRoot`, plus the task and the files you plan to touch as `paths`; it returns `tracked` with the context. If `tracked` is not `true`, the result is `outcome: "skipped"`, or tracking cannot be confirmed, stop without inspecting or writing project data. Do not scan for handoffs or Git metadata first.
- `unregistered`, `paused`, and `ignored` are quiet skips. Do not create a Session, event, snapshot, metadata, evidence, Knowledge, or report source from them. Ask to enable tracking only to explain why no record was made. If an unregistered answer lists `matchingProjects`, ask the user whether one is meant; never switch to it.
- When the user says something must not be stored, wrap it in `<private>…</private>` in any text you write, always with the closing tag; the block is removed before storage, and an unclosed tag is stored as written.
- Never put secrets, tokens, or personal data in a record, a diagram, or Knowledge.
- Prefer MCP operations that enforce the policy gate. Honor every skipped result; never retry through direct filesystem access.
- Do not substitute an unrestricted repository scan for missing recorded context; if nothing relevant is recorded, say so briefly and continue.

## MCP calls

- Operation ids such as `work_get_context` go through the dispatchers in `tools/list`; the index is `work-intelligence://agent/tool-contracts`. Before calling an operation for the first time in a conversation — always before its first write — read its complete contract at `work-intelligence://agent/tool-contracts/<operation>`.
- If `server.restartRequired` is true, stop MCP operations and tell the user to reconnect Work Intelligence MCP. Only `restartRequired` stops operations; `server.updateAvailable: true` permits normal use, with one reminder to reconnect at closing.

## Guides to read on demand

Each guide is MCP resource `work-intelligence://agent/work-intelligence/references/<guide>.md` and, in a plugin or checkout, `references/<guide>.md`. Read one when its flow starts.

- `reading-records` — before you read Sessions in part, page context omissions, or rely on recall and Knowledge search.
- `diagrams` — before you attach a diagram to a Session.
- `repair-and-backfill` — before you correct a saved Session, backfill metadata, or update its commit.
- `outstanding-cleanup` — before you handle a 整理未結項 request.
- `agent-review` — before you handle an Agent review request.
- `synthesis` — before you synthesize a report or write or revise summaries.
- `knowledge` — before you propose Knowledge candidates, update pages, or record Knowledge.

Field definitions and examples: `work-intelligence://agent/work-record-and-report-format.md`.

## Start of work

- After confirming the project is tracked, capture the paths already changed in the worktree (for example, from `git status --short`) as `baselineChangedFiles` and retain that list until finalization.
- Before planning, read the returned relevant Knowledge, the decisions of related Sessions, and the open items of Sessions that changed the same files. Before editing a file with history, call `work_get_file_history` with 1–3 repository-relative `paths`.
- **Error or unexpected behavior**: recall with the key part of the error message (and the file) before debugging from scratch.
- **Question about past work**: recall with the user's words (`work_recall`; `work_search` for Session-only history), rephrase if some words matched nothing, and give a named period ("上週") as calendar dates.
- A record the user asks for at task start follows the repair-and-backfill guide.

## Rely only on what a source supports

- Hits, digests, previews, and context items are pointers. Read the full source (`work_get_session` with `view: "handoff"`, or the tool `omitted.readWith` names) before relying on details the excerpt lacks, and cite the sessionId or knowledgeId you applied.
- `confidence` (and `relevant.confidence` in context) only measures how much of the query's wording a hit matches. When it is `none`, the hits must not be used as evidence.
- Knowledge marked possibly stale or needs review must be checked against the current code before you rely on it; if they conflict, trust the code and say the record looks outdated.
- After reading the full source, cite it only when it directly supports the answer. If no source supports the answer, say `資料不足`; do not infer from wording overlap, confidence, rank, recency, or a partial excerpt.

## Finalize a completed work session

After the planning → execution → verification → closing-handoff workflow completes, finalize the Session; finalization is a lifecycle event, not a Git commit. A commit is optional and must never be required or inferred. Use a stable idempotency key per piece of work.

1. **Refresh context.** Refresh `work_get_context` once with `projectRoot`, this task, actual changed paths, and the ids of Sessions you will link (`linkedSessionIds`). If it is skipped (`tracked` is not `true`), prepare nothing and tell the user in one sentence that no record was made.
2. **Outstanding items.** Read each applicable source Session behind `relevant.continuedOutstandingItems` and `relevant.outstandingItems` before relying on a pointer. Only items this work directly verified as complete belong in `resolvedOutstandingItemIds`. Never use the ranking, wording, or reminder as completion evidence; leave uncertain items unchanged.
3. **Changed files.** Inspect only the tracked project's relevant worktree/diff to identify this task's intentional file changes. Pass the captured baseline as `baselineChangedFiles`; if none was captured, omit it and never reconstruct it later. Do not claim files from a title, summary, or commit alone; do not absorb unrelated pre-existing dirty changes.
4. **Write the record** by the work record contract in the `work_finalize_session` contract. `nextSteps` / 狀態／未結項 holds only items that stay open and need a concrete later action or verification; never invent a recommendation, roadmap, or future plan. Never guess a decision's origin. Agent-autonomous decisions are reviewed only in the Web unless the user opens an Agent review request (agent-review guide).
5. **Times — never estimate them.** `work_get_context` returns `clock` when you need the time.
   - `completedAt`: **omit it** for work that just finished; the server records the finalize time. Set it only to backfill earlier work, from evidence such as a commit time, with its UTC offset.
   - `startedAt`: the first user message since the last save. The hooks give it; otherwise read it from the transcript or handoff; with no evidence, omit it.
6. **Knowledge you used.** Report recalled Knowledge that proved still valid as applied, and Knowledge that turned out wrong as contradicted. Reports count as evidence, so do not report Knowledge you did not actually use, and never report `unreportedKnowledge` just to clear it.
7. **Links and diagrams.** Pass the Session this one continues as the parent link. For cross-module flows, state machines, architecture, or multi-step processes, attach a diagram without being asked (diagrams guide says when to skip).
8. **Read the receipt.** It lists only what the server derived or changed. Follow its hints in the same turn, from evidence only.

## Other requests

- To find a specific Session, recall or list Sessions within the tracked project and read that one in full; do not guess a sessionId.
- Never create a replacement Session just to fix its text or metadata; read the repair guide first.
- Mention an `outstandingCleanup` request once at closing; never process it unasked.
- Record or update Knowledge only when the user asks or when the MCP workflow explicitly calls for it, and only with reusable, source-supported facts; read the knowledge guide first (also for `pendingRequests.knowledgeBacklog`).

Summarize what was saved or corrected, report verification and remaining gaps accurately, and keep MCP mechanics out of the user-facing text.
