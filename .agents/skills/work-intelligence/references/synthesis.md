# Report synthesis and writing

Read this guide with the core [Work Intelligence skill](../SKILL.md) when the user asks to organize or refine a Work Intelligence report, or when you write or revise Session summaries or reports. The report synthesis contract in the `work_get_report_context` and `work_save_report_summary` operation contracts applies as well.

## Report writing and source pages

When generating or revising Session summaries or reports, read `work-intelligence://agent/worklog-report-writing/SKILL.md`, then only the guide for the output language. Skip these writing resources for retrieval, metadata backfill, and Knowledge maintenance.

MCP report reads default to an Agent preview with a 24,000-character whole-response budget (12,000–60,000 configurable). Read projection omission counts and full source Sessions before relying on previews. `view: full` explicitly restores full legacy fields without this budget. A synthesis request saves all eligible source IDs at creation; use sessionPage to read that fixed set, rather than the current period's latest 200 records. evidencePage pages evidence within the selected source page. Coverage distinguishes saved, currently eligible, unavailable, selected and current-period counts. Budget omissions are separate from source/evidence pagination.

## Synthesize a report

When the user asks to organize or refine a Work Intelligence report, handle the pending request end-to-end without exposing internal tool names or request IDs:

1. Find the newest applicable pending report-synthesis request. If there is none, create one yourself for the period and scope the user asked for (default: this week, all tracked projects) — the user does not need to open the Web UI first.
2. Obtain that request's bounded deterministic context. If the request timed out or was interrupted, use the supported retry operation before getting fresh context. Do not retry a still-processing request or work from a stale context. The period report block (totals, comparison, projects, risks, decisions, trends) comes only with the first Session page; later pages carry their Sessions and evidence, so keep the block while paging, or read the first page again after a restart.
3. Read source Sessions directly and synthesize across the entire requested period; do not create weekly reports from daily summaries or annual reports from monthly summaries. Use the period's correct grain from the list below.
4. Keep deterministic report data separate from Agent-derived summaries. Write the period and scope plus an outcome-first executive summary. Use themes for work groups, highlights for outcomes, verification for exact status/evidence, comparison only with deterministic prior-period data, risks only when evidenced, decisions only when explicit, and `nextSteps` only for current status/open items/limitations.
5. Keep `passed`, `failed`, `in_progress`, `not_run`, and historical `not_supplied` distinct. Do not estimate metrics, infer commits from changed files, or claim complete coverage when context is truncated. State `資料不足` where sources do not support a conclusion.
6. Every material report block must include its supporting `sourceSessionIds`; the top-level source list must include the Sessions actually used. Validate source IDs against the request context before saving. Preserve prior report versions as the product contract requires; do not delete them as part of synthesis.

## Report synthesis by period

A report is a period-specific synthesis of source Sessions, events, evidence, and saved metadata. Do not build a weekly report by summarizing daily reports, or a yearly report by summarizing monthly reports, when source Sessions are available.

Report periods are calendar dates in the server's local time zone; the report context states it as `timezone`, so describe the period in that zone. Always read the bounded deterministic report context and its source Sessions directly. Re-cluster related work across the whole requested period, deduplicate repeated facts, and cite `sourceSessionIds` on every material report block. If context is truncated, do not imply that the report covers unseen Sessions. Do not invent metrics or aggregate counts; use only deterministic values or exact source evidence.

- **Daily** — Task / Feature / Issue. Preserve engineering detail: outcome, scope, explicit decisions, exact verification, optional observed Git metadata, and current limitations. Merge related Session activity into one task outcome.
- **Weekly** — Feature / Workstream. Re-cluster across days; report complete feature outcomes, major workstreams, decisions, representative verification, scope, comparison when supported, and current limitations. Do not organize as a weekday diary.
- **Monthly** — Project / Milestone / Major Feature. Compress small tasks and commits into project delivery and system improvements; retain durable decisions, representative quality evidence, objective data, and month-end limitations.
- **Quarterly** — Initiative / Major Project / Major System Improvement. Describe the initiative lifecycle and system-level results, trade-offs, quality evidence, measurable outcomes, and quarter-end limitations.
- **Annual** — Major Contribution / Major Initiative / System-level Improvement. Re-analyze source Sessions for the year; report only representative contributions, long-term system changes, durable decisions, quality evidence, reliable objective metrics, and year-end limitations. Do not concatenate monthly reports.

## Agent report storage mapping

The current `ReportSummary` API fields remain unchanged. Use them consistently:

- `title` and `executiveSummary`: report period/scope and concise outcome-first summary.
- `themes`: the period-level grouping from the list above (task/workstream/project/initiative/major contribution).
- `highlights`: supported outcomes and significant delivery details. For a daily report, include an optional block titled `Git` only when source Sessions provide actual Git metadata; do not infer commits from changed files.
- `verification`: representative exact verification outcomes, preserving `passed`, `failed`, `in_progress`, `not_run`, `not_supplied`, partial coverage, and environment limits.
- `comparison`: previous-period comparisons or objective trends only when supplied by deterministic report data; otherwise `[]`.
- `risks`: risks and current known limitations, with the affected Session sources. Put source coverage diagnostics once in a dedicated risks block, distinguishing the request's saved sources, the available and fully read sources, current-period totals, and gaps; do not repeat the same diagnostic in `executiveSummary`, `verification`, `comparison`, and `risks`.
- `decisions`: only explicit decisions and documented trade-offs.
- `nextSteps`: retained as a compatibility key, but carries only confirmed current status/open items/limitations; it must never contain recommendations or future plans. It may be `[]`.
- Each block's `sourceSessionIds` must identify the Sessions that support that block. Top-level `sourceSessionIds` must include all Sessions actually used.

Keep every limitation and citation that affects a conclusion; never drop key evidence to shorten the text. An MCP preview never replaces reading the full source.
