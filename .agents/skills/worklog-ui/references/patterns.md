# Layout & interaction patterns

## Shell and routes

```
WORK       總覽 /dashboard · 工作歷程 /sessions (/worklog → redirect) · 工作報告 /reports/:tab?
KNOWLEDGE  工作知識 /knowledge · 工作圖譜 /graph
MANAGE     專案 /projects/:tab?   (registry | backfill | import)
```

Route meta: `{ title, eyebrow, group, icon }`. The sidebar, breadcrumb and `PageHeader` read from it — never hard-code page titles in App.vue.

## Page anatomy

1. `PageHeader`: eyebrow → title (20px) → one-line description; actions on the right. Bottom border `--border-muted`, 24px gap below.
2. Optional `UiUnderlineNav` directly under the header (full-bleed to the page gutter).
3. Content: `StatCard` grid (4 columns ≥ 960, 2 columns below) and/or `UiBox` lists. Secondary info goes in a 340px right column at ≥ 960.

Do not add hero banners, decorative illustrations or slogan-sized headings.

## Lists (the GitHub issue-list pattern)

- Wrap every list in `UiBox`.
- Box header: left = count + optional context ("128 Sessions · 顯示 1–20"); right = `UiActionMenu` filters. Free-text search sits above the Box as `UiSearchInput` + "清除篩選" button when filters are applied.
- Rows: leading status icon, title (600), one meta line. Trailing Labels ≤ 2 (hide the less important one below 640px).
- Group by date with `UiGroupLabel` where time ordering matters (Sessions).
- Footer: `UiPagination`. Use `VirtualList` only when page size is "all".
- Timestamps: relative in the list, absolute in tooltip and in panels.

## Detail views

| Situation | Use |
|---|---|
| Read a record (Session, Knowledge history) | `UiSidePanel` (modal overlay) |
| Graph node | `UiSidePanel` `modal=false`, docked 360px; graph stays interactive |
| Create / edit (加入專案, Knowledge 編輯) | `UiDialog`; warn on close with unsaved changes |
| Import confirmation (Handoff 匯入) | `UiDialog size="lg"` listing items to import and excluded items with reasons |
| Destructive action | `useConfirm()` with danger button — never act on first click |

Open records are addressable: `?session=<id>` (and equivalents) so a refresh or shared link reopens the panel.

## Dashboard priority

StatCards: 記錄中專案 · 本週完成 Sessions (foot: 不等同 Git commit) · Verification (`VerificationBreakdown`: "21 / 24 通過" + four-state meter — no bare percentage, so missing verification is never folded into pass/fail) · 待處理.

Order is fixed: StatCards → **ACTION REQUIRED** (pending/failed report synthesis, active metadata backfill request, metadata gaps; each with one direct action) → 最近完成的工作 → right column 專案狀態. When nothing needs action show "全部處理完畢" with a success check. Dashboard only reads existing request state; it must not trigger a metadata scan.

## Filters and URL

- All list filters, sort, page, page size and tabs sync via `useRouteQuery` (replace, not push, for typing; push for discrete choices).
- Applying a filter resets page to 1.
- Show applied state on the ActionMenu trigger and offer 清除篩選.

## Loading / empty / error

| State | Pattern |
|---|---|
| First page load | Skeleton rows / cards shaped like the content |
| Refetch with data present | Keep data, show small spinner in the triggering control (`loading` prop) |
| Empty | `UiEmptyState` with one next step (e.g. "前往專案加入記錄") |
| Error | `UiFlash tone="danger"` inside the affected region with 重試; toast only for action results |

## Keyboard

- Global: `Ctrl K`/`⌘K` palette, `/` focuses page search, `g d` / `g s` / `g r` / `g k` / `g g` / `g p` page jumps (P4).
- SidePanel open: `J` / `K` next / previous, `Esc` close.
- Shortcuts are ignored while focus is in an input, textarea, select or contenteditable.

## Copy rules

- 繁體中文 UI; keep Session, Knowledge, verification, metadata, handoff, Agent, MCP in English.
- Eyebrows are English uppercase noun phrases: `TODAY'S SIGNAL`, `SESSION ARCHIVE`, `WORK REPORTS`, `EXPLICIT KNOWLEDGE`, `DETERMINISTIC WORK GRAPH`, `PROJECT REGISTRY`, `ACTION REQUIRED`, `LATEST MEMORY`, `AI SYNTHESIS`.
- Buttons are verbs: 重試、複製 Agent 指令、前往回補、加入專案、匯出.
- Never ask the user for MCP tool names, request IDs or JSON; instructions shown for Agents are natural language inside a copyable mono block.

## Responsive

- ≥ 960: full sidebar, 4-column stats, right column visible.
- 640–959: 56px icon-rail sidebar with tooltips, 2-column stats, single content column.
- < 640: sidebar becomes a drawer behind a menu button, search trigger becomes an icon, 16px page gutter, filter menu triggers show icon + chevron only, SidePanel full screen.
