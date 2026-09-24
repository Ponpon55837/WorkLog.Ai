# Domain semantics the UI must respect

The Work Intelligence data contract is defined in [`docs/work-record-and-report-format.md`](../../../../docs/work-record-and-report-format.md) and applied by Agents through the [`work-intelligence` skill](../../work-intelligence/SKILL.md). The UI displays that data; it must never blur distinctions the contract keeps separate. When this file and those sources disagree, the sources win — update this file.

## Session

| Rule | UI consequence |
|---|---|
| `summary` is one outcome-first executive sentence; `workSummary` has exactly five arrays | SessionPanel shows `summary` first (16px), then the five sections in fixed order |
| `nextSteps` means **狀態／未結項** — known limitations, unresolved items, evidence gaps. Never recommendations or plans | Label it `狀態／未結項` everywhere (never 後續 / 下一步 / Next steps). Empty array → `—`. No "建議" styling or call-to-action next to it |
| Legacy Sessions may have no `workSummary` | Show the five headings with `—` and a neutral note "此 Session 尚未提供五段摘要"; do not hide the block |
| `executionStatus: "completed"` only means finalize ran; it is not verification | Render as a **neutral** Label, never green |
| `verification.status` ∈ `passed` / `failed` / `not_run`; missing = historical `not_supplied` | Four distinct visuals (see tokens.md). Missing verification is 未回報 (attention), not 未執行 (neutral) and never 通過 |
| Changed files are not a Git commit; Git fields are optional observed metadata | Changed files and Git (commit SHA, branch) are separate panel sections. Git section renders only when values exist. Never label changed files as "commit" |
| `changedFileChanges` carries added / modified / deleted / renamed (+ `previousPath`) | Letter badges A/M/D/R; renamed shows `new ← old` |
| `changedFilesProvenance` sources: agent / handoff / git / worktree; legacy rows may have none | Show sources per file; empty provenance → muted `未提供來源`, never a guessed source |
| Evidence and Knowledge are separate from the summary | Panel has its own Evidence and Knowledge sections (from `SessionDetail.evidence` / `.knowledge`); never merge them into workSummary |
| Corrections happen in place (same `sessionId`, idempotent, audited) by Agents or the Web UI | The Session panel's 編輯 Session Dialog replaces `summary`, patches only the edited `workSummary` sections, and corrects `verification` (status passed / failed / not_run plus an optional note; 未回報 can only be left as is) through the existing PATCH endpoints, each audited. Evidence can only be marked wrong or restored (void with a required reason), a whole Session can be voided or restored, and Session links (接續自／後續／相關) can be added or removed. Never add a "duplicate Session" action or edit changed files, events, or evidence content from the UI |
| Event types: planning / execution / verification / closing / note / finalized | Mono event-type column in the Events timeline, in chronological order |

## Metadata backfill

- Keep three gaps visually distinct: **changed-files metadata 缺漏**, **verification 尚未回報**, **verification 明確 not_run** (README requirement 8).
- The UI only scans stored metadata and creates requests; it never writes guessed metadata. Actions shown are 掃描、複製 Agent 指令、取消、重新整理.

## Reports and AI synthesis

| Rule | UI consequence |
|---|---|
| Deterministic report data (counts, trend, comparison) is separate from Agent-written synthesis | StatCards, trend charts and ▲▼ deltas use only deterministic report fields. Never display numbers parsed from synthesis text |
| `ReportSummary` fields: `title`, `executiveSummary`, `themes`, `highlights`, `verification`, `comparison`, `risks`, `decisions`, `nextSteps`, top-level `sourceSessionIds`, `generatedByAgent`, `generatedByModel`, `promptVersion` | `SynthesisCard` renders executive summary, then sections in that order with Chinese headings 主題 / 重點成果 / 驗證 / 比較 / 風險與限制 / 決策 / 狀態／未結項. Empty sections are omitted (except show `—` for 狀態／未結項 only when the card is expanded) |
| Every block cites `sourceSessionIds` | Each block shows its source count as a chip; clicking opens the Session list / SessionPanel for those IDs. Footer shows total sources used and generator meta (agent, model, prompt version, time) |
| Period grain: 日 Task/Feature/Issue · 週 Feature/Workstream · 月 Project/Milestone · 季 Initiative · 年 Major Contribution | Show the grain as a muted hint next to the 主題 heading (e.g. `週報 · 以 Feature / Workstream 分組`) |
| `資料不足` is a legitimate statement; truncated context must not imply full coverage | Render `資料不足` in attention-muted text, not as an error. When truncation info is available, show a Flash "此版本整理時來源資料已截斷" |
| Prior report versions are preserved | Version menu lists all versions; deleting a version is an explicit user action behind `useConfirm()` |
| Synthesis request states: pending / processing / completed / failed (timeout or interrupted) / cancelled | Use the request status mapping; failed shows 重試, processing shows no retry |
| Report ranges are calendar dates in the server's local time zone (`WorkReport.timezone`) | The report header shows the range followed by the zone name, e.g. `2026-09-21 – 2026-09-27（Asia/Taipei）`; never hard-code UTC or convert the range in the browser |

## Projects and policy

- Statuses: `unregistered` 未註冊 · `tracked` 記錄中 · `paused` 已暫停 · `ignored` 已忽略. New projects start 未註冊.
- Non-tracked projects are quiet skips: never show them as errors or warnings, only as neutral / attention status.
- Switching a project **to** 記錄中 widens what Agents may read — confirm with a Dialog that states: handoff、Git/worktree 與 source 讀取將被允許. Switching away from 記錄中 needs no confirm.
- Policy explanations are short and factual ("未明確加入的專案，不讀取、不保存。").

## User-facing Agent instructions

- Users only need natural language. Copyable instructions contain a plain-language sentence, never MCP tool names, request IDs or JSON.
- IDs (Session ID, request ID) may appear only as de-emphasized mono metadata for copy-link purposes, never as something the user must type.
