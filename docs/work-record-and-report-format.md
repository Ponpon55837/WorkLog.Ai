# Work record and report format v1

## Purpose

Keep Agent-written Session records consistent, factual, compact, searchable, and useful as source material for daily through annual reports. A Session is the primary record; a report is a period-specific synthesis of source Sessions, events, evidence, and saved metadata. Do not build a weekly report by summarizing daily reports, or a yearly report by summarizing monthly reports, when source Sessions are available.

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
- `verification.status` remains the machine-readable status (`passed`, `failed`, or `not_run`) and is not replaced by prose in `workSummary.verification`. Historical missing status remains `not_supplied`; never convert missing information to `not_run` or infer success.
- Git remains optional structured metadata (`branch`, `commitSha`, `dirty`) outside `workSummary`. Include only observed values. `changedFiles` describes file-change evidence, not a commit.
- Events, raw handoff snapshots, evidence, changed-file provenance, and Git metadata remain separate source records. Do not copy them wholesale into `workSummary`.
- Every statement must be supported by the current Session's available handoff, event, evidence, metadata, or verified worktree information. If unavailable, omit it or state the known gap; never guess.

## Report synthesis by period

Report periods are calendar dates in the server's local time zone; the report context states it as `timezone`, so describe the period in that zone. Always read the bounded deterministic report context and its source Sessions directly. Re-cluster related work across the whole requested period, deduplicate repeated facts, and cite `sourceSessionIds` on every material report block. If context is truncated, do not imply that the report covers unseen Sessions. Do not invent metrics or aggregate counts; use only deterministic values or exact source evidence.

| Period | Primary grouping | Detail level and report focus |
| --- | --- | --- |
| Daily | Task / Feature / Issue | Preserve engineering detail: outcome, scope, explicit decisions, exact verification, optional observed Git metadata, and current limitations. Merge related Session activity into one task outcome. |
| Weekly | Feature / Workstream | Re-cluster across days; report complete feature outcomes, major workstreams, decisions, representative verification, scope, comparison when supported, and current limitations. Do not organize as a weekday diary. |
| Monthly | Project / Milestone / Major Feature | Compress small tasks and commits into project delivery and system improvements; retain durable decisions, representative quality evidence, objective data, and month-end limitations. |
| Quarterly | Initiative / Major Project / Major System Improvement | Describe the initiative lifecycle and system-level results, trade-offs, quality evidence, measurable outcomes, and quarter-end limitations. |
| Annual | Major Contribution / Major Initiative / System-level Improvement | Re-analyze source Sessions for the year; report only representative contributions, long-term system changes, durable decisions, quality evidence, reliable objective metrics, and year-end limitations. Do not concatenate monthly reports. |

## Agent report storage mapping

The current `ReportSummary` API fields remain unchanged. Use them consistently:

- `title` and `executiveSummary`: report period/scope and concise outcome-first summary.
- `themes`: the period-level grouping from the table above (task/workstream/project/initiative/major contribution).
- `highlights`: supported outcomes and significant delivery details. For a daily report, include an optional block titled `Git` only when source Sessions provide actual Git metadata; do not infer commits from changed files.
- `verification`: representative exact verification outcomes, preserving `passed`, `failed`, `not_run`, `not_supplied`, partial coverage, and environment limits.
- `comparison`: previous-period comparisons or objective trends only when supplied by deterministic report data; otherwise `[]`.
- `risks`: risks and current known limitations, with the affected Session sources.
- `decisions`: only explicit decisions and documented trade-offs.
- `nextSteps`: retained as a compatibility key, but carries only confirmed current status/open items/limitations; it must never contain recommendations or future plans. It may be `[]`.
- Each block's `sourceSessionIds` must identify the Sessions that support that block. Top-level `sourceSessionIds` must include all Sessions actually used.

## Backfilling existing Sessions

When normalizing existing records, update the same finalized Session with `work_update_session_work_summary` (the Web UI Session editor uses the same in-place update); read the current Session first, because the user may already have edited it; do not create replacement Sessions or alter their primary summary, events, evidence, changed files, verification status, Git metadata, or snapshots. Read all available structured and raw source under the tracked-project policy gate. Preserve confirmed facts, remove unsupported or duplicated claims, and replace future-looking `nextSteps` with objective current-state facts or `[]`. If source data is unavailable or a project is not tracked, do not read it or fabricate a replacement.
