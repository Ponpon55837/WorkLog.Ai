# Layout & interaction patterns

## Shell and routes

```
WORK       總覽 /dashboard · 工作歷程 /sessions (/worklog → redirect) · 工作報告 /reports/:tab?
KNOWLEDGE  工作知識 /knowledge · 工作圖譜 /graph
MANAGE     專案 /projects/:tab?   (registry | backfill | import)
```

Route meta: `{ title, eyebrow, group, icon }`. The sidebar, breadcrumb and `PageHeader` read from it — never hard-code page titles in App.vue.

## Page anatomy

All pages share the full available main width and responsive gutters. Graph and other routes must keep the same left and right content edges during navigation; the main scroll container reserves stable scrollbar space.

1. `PageHeader`: one compact row (about 32px) — inline eyebrow (12px) → title (16px) → description (13px, one line, ellipsis with the full text on hover); actions on the right. No bottom border, 12px gap below. The app bar breadcrumb already names the page, so never grow the header back into a stacked title block; below 640px the eyebrow hides and the description moves to its own line, still one line, so its length never shifts the controls below.
2. Optional `UiUnderlineNav` directly under the header (full-bleed to the page gutter).
3. Content: `StatCard` grid (4 columns ≥ 960, 2 columns below) and/or `UiBox` lists. Secondary info goes in a 340px right column at ≥ 960.

Do not add hero banners, decorative illustrations or slogan-sized headings. The first screen belongs to data: keep page chrome (header + toolbar) under about 110px at 1440px.

## Scrolling

- `<main>` is the scroll container. Page-level controls that must stay reachable (search box, `UiUnderlineNav` tabs, a tab-specific search) go inside `PageToolbar`, which is sticky at the top of the content. The `PageHeader` above it scrolls away.
- Every list `UiBox` under a toolbar uses `sticky-header`, so its filters/count stay pinned directly below the toolbar (offset `--page-toolbar-height`).
- Path changes (new page or tab) reset scroll to the top (AppShell). Query-only changes (filters, pagination, `?session`) keep position; pagination scrolls the list top back into view.
- Never hand-roll a scrolling wrapper around a list. A list that can grow long without pagination (e.g. the backup list) scrolls inside its Box through `VirtualList` (`enabled` once it passes a handful of rows, a smaller `maxHeight`, a `label`), so the page does not stretch; paginated lists use `VirtualList` only in "All" mode. When such a list is the last thing in its column (dashboard 最近完成的工作／專案狀態), add `grow-to-viewport` so it reaches the viewport bottom instead of stopping at a fixed `maxHeight` and leaving empty space; short lists still shrink to their content, and `maxHeight` remains the fallback when the list starts below the fold. The Graph canvas is the other scroll area.

## Lists (the GitHub issue-list pattern)

- Wrap every list in `UiBox`.
- Box header: left = count + optional context ("128 Sessions · 顯示 1–20"); right = `UiActionMenu` / `UiDateRangeMenu` filters. Free-text search sits above the Box as `UiTextInput type="search"` + a "清除篩選" button when filters are applied.
- Only offer filters the API supports. Sessions: search, project, date range (no verification or sort filter). Knowledge: search, project, kind, status. Evidence: search, kind.
- Wire list pages with `useRouteQuery` → `useListReload`; the list itself is a Pinia Colada query keyed by its filters (see the code-style skill §4).
- Rows: leading status icon, title (600), one meta line. Trailing Labels ≤ 2 (hide the less important one below 640px).
- Group by date with `UiGroupLabel` where time ordering matters (Sessions).
- Footer: `UiPagination`. Use `VirtualList` only when page size is "all".
- Timestamps: relative in the list, absolute in tooltip and in panels.

## Detail views

| Situation | Use |
|---|---|
| Read a record (Session, Knowledge history) | `UiSidePanel` (modal overlay) |
| Graph node | `UiSidePanel` `modal=false`, docked 460px (resizable), overlaying the graph; graph stays interactive, dims unrelated nodes and scrolls the selected node clear of the panel |
| Create / edit (加入專案, Knowledge 編輯) | `UiDialog`; warn on close with unsaved changes |
| Import confirmation (Handoff 匯入) | `UiDialog size="lg"` listing items to import and excluded items with reasons |
| Destructive or scope-widening action (delete version, cancel request, enable tracking) | `await confirmAction({...})` — never act on first click |

Open records are addressable: `?session=<id>` (and equivalents) so a refresh or shared link reopens the panel.

## Dashboard priority

StatCards: 記錄中專案 · 本週完成 Sessions (foot: 不等同 Git commit) · Verification (`VerificationBreakdown`: "21 / 24 通過" + four-state meter — no bare percentage, so missing verification is never folded into pass/fail) · 待處理.

Order is fixed: full-width **ACTIVITY** heatmap (directly after PageHeader / first-run guidance) → StatCards → weekly insights → **ACTION REQUIRED** (pending/failed report synthesis, active metadata backfill request, metadata gaps; each with one direct action) → 最近完成的工作 → right column 專案狀態. Keep healthy empty and all-suppressed reminder states distinct. When no unresolved source exists, show the healthy empty state with a success check. Dashboard only reads existing request state; it must not trigger a metadata scan.

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

- Copy lives in `src/i18n/locales/zh-TW.json` and `en-US.json` under semantic keys (write the 繁體中文 first, then the English); keep Session, Knowledge, verification, metadata, handoff, Agent, MCP in English in both. English copy: sentence case, plain verbs ("Back up now", "Copy Agent instruction"), singular Label names ("Reusable pattern"), and a `one|other` plural form for counts.
- Eyebrows are English uppercase noun phrases: `TODAY'S SIGNAL`, `SESSION ARCHIVE`, `WORK REPORTS`, `EXPLICIT KNOWLEDGE`, `DETERMINISTIC WORK GRAPH`, `PROJECT REGISTRY`, `ACTION REQUIRED`, `LATEST MEMORY`, `AI SYNTHESIS`.
- Buttons are verbs: 重試、複製 Agent 指令、前往回補、加入專案、匯出.
- Never ask the user for MCP tool names, request IDs or JSON; instructions shown for Agents are natural language inside a copyable mono block.

## Responsive

- ≥ 960: full sidebar, 4-column stats, right column visible.
- 640–959: 56px icon-rail sidebar with tooltips, 2-column stats, single content column.
- < 640: sidebar becomes a drawer behind a menu button, search trigger becomes an icon, 16px page gutter, filter menu triggers show icon + chevron only, SidePanel full screen.

## Timeline viewport

Measure the mounted chart viewport before fitting the period. Fit on first load, period/project changes and returning from list view; while fitted, resize with the container. Preserve manual zoom on resize. Hidden/list views have zero width and must not set the fit scale. Full-year ranges fit tablet widths.
