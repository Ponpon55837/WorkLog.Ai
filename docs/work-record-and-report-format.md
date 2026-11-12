# Work record and report format v1

## Purpose

Keep Agent-written Session records consistent, factual, compact, searchable, and useful as source material for daily through annual reports. A Session is the primary record; a report is a period-specific synthesis of source Sessions, events, evidence, and saved metadata, never a summary of other reports.

## Canonical Session record

`work_finalize_session` and `work_update_session_work_summary` use the existing five-section `workSummary` object. The arrays and property names remain stable for API and database compatibility:

| Field | Display label | Include | Exclude |
| --- | --- | --- | --- |
| `outcomes` | 成果 | Confirmed delivery or problem resolution, with the important behavior and result. Use accurate completion language. | Activity logs, unsupported impact, or work described as complete when it is only implemented or located. |
| `scope` | 範圍 | Important modules, components, APIs, services, UI, locales, tests, and concise changed-file counts when known. | A raw filename dump or facts already stated in another section. |
| `decisions` | 決策 | Explicit technical, API, compatibility, security, or architecture decisions; include the reason only when the source states it. Include behavior intentionally kept unchanged when relevant. | Guessed rationale or routine implementation details. |
| `verification` | 驗證 | Actual commands and results, counts, browser/platform coverage, manual/user confirmation, expected failures, and unverified areas. | A claim of broad success from a narrow check, or an inference from changed files. |
| `nextSteps` | 狀態／未結項 | Facts that remain true at finalization: known limitations, unresolved items, missing evidence, or unverified scenarios. This compatibility field is **not** a place to invent recommendations, plans, or future outlook. Use `[]` when no such fact is known. | “Next, do X” recommendations, guessed work, or future roadmap. |

Additional rules:

- `summary` is one concise executive sentence; `workSummary` carries the five distinct detail categories. Do not repeat the same fact in multiple fields.
- Each array item is one concise, confirmed statement. Use `[]` when a category has no supported content; do not add filler or Markdown headings.
- Distinguish `完成` (confirmed complete), `實作` (implemented but not necessarily fully verified), `處理` (worked on), `定位` (root cause found, not necessarily fixed), and `未驗證` (not tested). Keep failures, expected failures, and unrun checks explicit.
- `verification.status` remains the machine-readable status (`passed`, `failed`, `in_progress`, or `not_run`) and is not replaced by prose in `workSummary.verification`. `in_progress` means verification has started but has no confirmed result; update the same record after verification finishes. It does not change the finalized-record lifecycle or imply passed. Historical missing status remains `not_supplied`; never convert missing information to `not_run` or infer success.
- Git remains optional structured metadata (`branch`, `commitSha`, `dirty`) outside `workSummary`. Include only observed values. `changedFiles` describes file-change evidence, not a commit.
- Events, raw handoff snapshots, evidence, changed-file provenance, and Git metadata remain separate source records. Do not copy them wholesale into `workSummary`.
- Every statement must be supported by the current Session's available handoff, event, evidence, metadata, or verified worktree information. If unavailable, omit it or state the known gap; never guess.
- Finalize and work-summary update inputs remain backward compatible with decision strings and also accept `{ "text": "…", "origin": "user_requested" | "agent_autonomous" }`. Use `user_requested` only for a decision directly requested by the user, `agent_autonomous` only for an Agent-selected decision or trade-off, and a plain string when the origin is unclear. The stored five-section `workSummary.decisions` stays a string array; provenance and review state live in the project-data `session_decisions` table.
- Only `agent_autonomous` decisions enter the pending Web review queue. People can confirm or reject them, or open a prefilled Knowledge editor that links the resulting Knowledge to the source Session. MCP context returns only the pending count; decision review is Web-only.
- Deterministic reports include the number of Agent-autonomous decisions for the period and the pending items with links to their source Sessions.
- Each `workSummary.nextSteps` entry is also kept as a durable outstanding item with a stable id and source Session. Existing entries are backfilled as `pending`; never infer that historical text was completed. `nextSteps` remains the compatibility representation in the Session record.
- Resolve an outstanding item only after verifying it in the same project, by passing its id to `work_finalize_session`; the status change and audit history are saved with the Session. The Web UI can also move an item from `pending` to `completed` or `not_needed`. Session edits preserve the id and status for unchanged text, create pending items for newly added text, mark removed pending items `not_needed`, and retain completed history. A voided Session cannot be edited through `work_update_session_work_summary`; restore it in the Web UI first.
- Before finalizing, refresh task-and-path context and read the sources behind `relevant.outstandingItems`. Only directly verified completion belongs in `resolvedOutstandingItemIds`; use `supersededOutstandingItemIds` only when this Session’s nonempty nextSteps explicitly replace older pending work. Supersession is audited as pending→not_needed with the actor Session id. Conflicting arrays, invalid/voided/terminal/cross-project ids and supersession without replacement nextSteps leave items unchanged and warn. Finalize returns bounded `relatedOutstandingItems` still pending, excluding its own new nextSteps; retrieval is a pointer and never completion evidence.
- Session digests and Agent context include only pending outstanding items; completed and `not_needed` entries are not shown as open work even if their compatibility text remains in `nextSteps`. Context returns bounded text and count/truncation metadata. Use the read-only outstanding-items operation for a paginated status-filtered list; do not treat the bounded context as the full list.
- Times are never estimated. Omit `completedAt` for work that just finished; the server records it. `startedAt` is the first user message of this segment (the Claude Code save reminder states it), taken from evidence with its UTC offset, or omitted. Future times are rejected; implausible ones return `timestampWarnings` and are corrected with `work_update_session_metadata`. `updatedAt` is system-managed and records the last change.

## Reports, backfill, and diagrams

Agents read the rest of the format with the flow that needs it, from the Work Intelligence skill's on-demand guides (each is also the MCP resource `work-intelligence://agent/work-intelligence/references/<guide>.md`):

- [Report synthesis and writing](../.agents/skills/work-intelligence/references/synthesis.md): grouping by period (daily through annual), the `ReportSummary` field mapping, source coverage, and the bilingual writing guides.
- [Repair and backfill](../.agents/skills/work-intelligence/references/repair-and-backfill.md): correcting a saved Session in place, records saved at task start, metadata backfill, and normalizing existing work summaries.
- [Session diagrams](../.agents/skills/work-intelligence/references/diagrams.md): when and how to attach a versioned architecture diagram; every field and limit is in the [architecture diagram format](architecture-diagram-format.md).
