# Component catalog

Location: `apps/web/src/components/ui/` (generic), `components/layout/` (shell), `components/domain/` (Work Intelligence specific). Names are `Ui*` for generic components. If a component below does not exist yet, create it with this API; if it exists, read its source before use — the source wins over this doc, and update this doc when you change an API.

## Layout

| Component | Purpose / API |
|---|---|
| `AppShell` | Grid: 48px `AppHeader` + (`AppSidebar` \| scrollable `<main>`). Hosts `ToastHost`, the global `SessionPanel` and the command palette. |
| `AppHeader` | Logo mark `WI`, breadcrumb `Work Intelligence / {route.meta.title}`, search trigger (`Ctrl K`), Local-first dot, refresh `UiIconButton`. |
| `AppSidebar` | Groups WORK / KNOWLEDGE / MANAGE built from route meta; `RouterLink` items with icon, label, optional `UiCounter`; active = `--bg-muted` + 4px accent bar on the left. Bottom: Policy gate badge with tooltip. Icon rail < 960, drawer < 640. |
| `PageHeader` | Props `eyebrow`, `title`, `description?`; slot `actions`; optional slot `nav` for an `UiUnderlineNav` directly beneath. One line of description max — no slogans in large type. |

## Inputs & actions

| Component | API notes |
|---|---|
| `UiButton` | `variant: 'default' \| 'primary' \| 'invisible' \| 'danger'`, `size: 'md' \| 'sm'`, `icon?`, `trailingIcon?`, `loading?`. Primary is green; only one primary per view region. |
| `UiIconButton` | Required `label` (becomes `aria-label` + tooltip). |
| `UiTextInput` / `UiSearchInput` | Inset background, accent focus ring. Search supports leading icon and displaying `key:value` qualifiers in accent mono. |
| `UiSelect` | Native select styled to tokens; use for forms. For list filters use `UiActionMenu`. |
| `UiActionMenu` | Trigger + popover list; single/multi select with check marks, optional per-item icon, header title, keyboard navigation, closes on outside click / Esc. Used in Box headers ("專案 ▾ 驗證 ▾ 日期 ▾ 排序 ▾"). Applied filter → trigger text becomes `--fg` + 600. |
| `UiSegmentedControl` | Mutually exclusive small sets (report period 日/週/月/季/年). `role="radiogroup"`. |
| `UiDateRangeMenu` | ActionMenu with presets (今天、昨天、近 7 天、本月) + 自訂區間 calendar. The only date picker in the app (Sessions and Reports both use it). |
| `UiCopyButton` | Copies text, shows transient check + toast. Used for Agent instructions. |

## Display

| Component | API notes |
|---|---|
| `UiBox` | Bordered container. Slots: `header` (bg-subtle, title left + controls right), default (rows), `footer` (pagination). |
| `UiBoxRow` | Row with leading icon slot, title, meta line (12px muted, ellipsis), trailing slot for Labels/buttons. `clickable` adds hover and Enter-to-activate. |
| `UiGroupLabel` | Date group separator inside a Box (今天 / 昨天 / 9 月 20 日). |
| `UiLabel` | `tone: 'success' \| 'danger' \| 'attention' \| 'accent' \| 'done' \| 'neutral'`, optional `icon`. |
| `StatusLabel` | Wraps `UiLabel` with the status mapping (`kind="verification" \| "tracking" \| "request"`, `value`). Never map status → color inline. |
| `UiCounter` | Numeric pill; `tone: 'default' \| 'attention'`. |
| `StatCard` | Label with icon, value (24px), foot text, optional `delta` (▲ success / ▼ danger), optional sparkline or segmented meter slot. |
| `UiUnderlineNav` | Tabs bound to route (`/reports/:tab`, `/projects/:tab`); each item icon + text + optional Counter; active bar `#f78166`. |
| `UiPagination` | Page size menu + prev / numbered / next. One implementation. |
| `UiFlash` | Inline banner `tone` + optional action (e.g. 重試) + dismissible. For page-level errors and notices. |
| `ToastHost` / `useToast()` | Bottom-right stack, auto-dismiss 4s, success/danger tone. |
| `UiSkeleton` | Row-shaped and card-shaped placeholders. Use instead of spinners for list/page loads. |
| `UiEmptyState` | Icon, one-sentence explanation, one next-step action. |
| `UiTooltip` | Hover/focus tooltip; used by icon buttons and truncated timestamps (absolute time on hover). |

## Overlays

| Component | API notes |
|---|---|
| `UiSidePanel` | Right overlay, width `min(640px, 100%)`, backdrop, focus trap, Esc, scroll lock, restore focus. Slots `header`, default, `footer`. `modal=false` variant docks without backdrop (Graph node panel, 360px). Full-screen below 640px. |
| `UiDialog` | Centered, radius 12px, `size: 'sm' \| 'md' \| 'lg'`; same a11y guarantees. Header title + close, body, footer with actions right-aligned (primary last). |
| `UiConfirmDialog` / `useConfirm()` | Promise-based confirm for destructive actions (封存、刪除版本、取消請求). Danger button for destructive confirm. |
| Command palette | P4: `Ctrl K` / `⌘K`; jump to pages, search Sessions and Knowledge. |

## Domain components

| Component | Notes |
|---|---|
| `SessionRow` | Verification icon, title, `StatusLabel`, file-count neutral Label, meta `project · relative time (tooltip absolute) · outcome summary`. |
| `SessionPanel` | Read-only. Opened via `?session=<id>` from anywhere. Header: eyebrow `SESSION · <id>` (muted mono), title, Labels (verification, project, file count), prev/next, 複製連結, close. Body: `summary` sentence (16px) → meta `<dl>` (專案、完成時間、執行狀態 neutral Label、Verification) → five workSummary sections in fixed order 成果 outcomes / 範圍 scope / 決策 decisions / 驗證 verification / 狀態／未結項 nextSteps (empty → "—"; missing workSummary → note) → collapsible Changed files → Git (only when commit SHA / branch exist) → Evidence → Knowledge → Events timeline → Handoff snapshot. Footer shows `J`/`K`/`Esc` hints and position. See domain-semantics.md. |
| `ChangedFileList` | Mono paths, A/M/D/R letter badge, `new ← old` for renames, provenance sources right-aligned in muted text (`未提供來源` when empty). Caption: "changed files 不代表 Git commit". |
| `SynthesisCard` | Header: AI SYNTHESIS eyebrow, report title, `StatusLabel kind="request"`, version menu, actions (複製 Agent 指令 / 重試 / 取消 / 重新整理 by status). Body: executive summary, then blocks 主題 / 重點成果 / 驗證 / 比較 / 風險與限制 / 決策 / 狀態／未結項; each block item = title + detail + source chip (`n Sessions`, opens those Sessions). Grain hint next to 主題. Footer: total sources, generatedByAgent / model / promptVersion, time. `資料不足` rendered attention-muted. |
| `VerificationBreakdown` | Segmented meter + legend for passed / failed / not_run / not_supplied counts. Used by Dashboard and Reports instead of a single pass-rate percentage. |
| `ActionInboxRow` | Dashboard "ACTION REQUIRED" row: status icon, title + Label, meta, one direct action button. |
| `KnowledgeRow` | Kind icon, title, kind + status Labels, 3-line clamp body (expandable), `#tag` Labels, mono references, `…` ActionMenu. |
| `GraphCanvas` | Existing SVG canvas; restyle to tokens, add floating toolbar and docked node panel. |
