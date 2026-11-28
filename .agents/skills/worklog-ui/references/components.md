# Component catalog

Location: `apps/web/src/components/ui/` (generic, `Ui*`), `components/layout/` (shell), `components/domain/` (Work Intelligence specific). The source is the final authority; update this file whenever an API changes. Every component is browsable in the dev-only `/__ui` route (`views/UiShowcaseView.vue`).

**Prop naming:** the accessible name of a control is always the `label` prop (never `ariaLabel`). Two-way state uses `v-model` (`defineModel`).

## Layout

| Component | API |
|---|---|
| `AppShell` | Props `refreshing`, `counts` (sidebar counters by route name), `fullWidth`. Emits `refresh`, `search`. Slots: default (page), `overlays`. Mounts `UiConfirmHost` and `UiToastHost`, a "跳至主要內容" skip link, and a 2px top progress bar while a page chunk loads or `refreshing` is set (`useNavigationProgress`). |
| `AppHeader` | Menu button (< 640px), `WI` logo (filled), crumb (`Work Intelligence /` muted, page name 500), search trigger with `Ctrl`/`⌘` and `K` as two keycaps, Local-first 6px dot (hidden < 640px), language `UiActionMenu` (label hidden < 640px), sun/moon theme `UiIconButton`, refresh `UiIconButton`. |
| `AppSidebar` | Built from `layout/navigation.ts` (`navItems`, `navGroups`). Counters come from `AppShell` `counts`: 未結項 is the pending total, 工作知識 is pending decisions plus candidates (`useWorkKnowledgePendingStore`). Full ≥ 960, icon rail 640–959, drawer < 640. Nav links carry `data-testid="nav-<name>"`. `navTarget` / `isNavItemActive` handle the 未結項 entry, which is the `sessions` route with `tab=outstanding` (`g o`). |
| `PageHeader` | Props `title?` (defaults to route meta; 20px/600), `description?` (13px muted, single line, truncated, full text in `title`). Slot `actions`. One compact row; scrolls away with the page. |
| `PageToolbar` | Sticky container for page search and/or `UiUnderlineNav`; publishes `--page-toolbar-height` for sticky Box headers. One per page. |

## Actions & inputs

| Component | API |
|---|---|
| `UiButton` | `variant: default (surface + border) \| primary (solid accent, `--fg-on-accent` text) \| invisible \| danger \| link`, `size: md \| sm`, `icon`, `trailingIcon`, `loading`, `disabled`, `disabledReason` (tooltip; disabled is neutral grey, loading keeps its color), `type`, `to` (renders RouterLink), `iconOnly` + `label`, `truncate`. `variant="link"` is an inline accent-coloured text link that runs a command (inherits the surrounding font size, underline on hover); never hand-roll a link-styled `<button>`. |
| `UiIconButton` | Required `icon`, `label`; `variant` (default `invisible`), `size`, `loading`, `disabled`. |
| `UiCopyButton` | `text`, `label`, `successMessage`, `variant`, `size`, `iconOnly`. Toast + check-mark feedback. |
| `UiTextInput` | `v-model`, `icon`, `type: text \| search \| date`, `placeholder`, `label`, `size`, `mono`, `maxlength`, `required`, `autofocus`. Slots `prefix`, `suffix`. |
| `UiTextarea` | `v-model`, `rows`, `placeholder`, `maxlength`, `required`, `mono`, `autofocus` (the dialog focus trap focuses the first `[autofocus]` element, so a dialog picks which field takes the cursor). |
| `UiSelectionBar` | Select-all row of a list with bulk actions: `v-model` (all selected), `label`, `selectText` (shown while nothing is selected), `groupLabel`, `summary`, `count`, `indeterminate`, `disabled`, optional `toolbarTestid` / `summaryTestid`. The actions and the visible summary render only while `count > 0`; a visually hidden `role="status"` region stays mounted so the first selection is announced. Pair it with `useRowSelection` (selection state) and `useFocusRestore` (focus after rows leave the list); used by Open items and 待確認決策. |
| `UiCheckbox` | Native checkbox. Required boolean `v-model` and accessible `label`; optional `disabled`, `indeterminate` for mixed group selection. |
| `UiSelect` | Native select. `v-model`, `options: SelectOption[]`, `label`, `icon`, `size`, `disabled`. Use for forms/toolbars and anything e2e selects by label. |
| `UiField` | `label`, `hint`, `error`, `group`; wraps one control. Pass `group` around a SegmentedControl or other button set: it renders a labelled `role="group"` instead of a `<label>`, which would name only the first button. |
| `UiActionMenu` | Popover menu. `label` (trigger text), `items: SelectOption[]`, `header`, `icon`, `align: start \| end`, `variant: filter \| button`, `size`, `hideLabelOnMobile`, `loading` (spinner replaces the icon, trigger disabled). With `v-model` + `defaultValue` it is a single-select filter (trigger shows `label：value` in the accent color when applied, with the full text in `title`; with `hideLabelOnMobile` a phone shows the icon and a dot); without `v-model` it is an action menu and emits `select`. Arrow keys, Esc, outside click. |
| `UiSegmentedControl` | `v-model`, `options`, `label`. Arrow keys move selection. |
| `UiUnderlineNav` | `v-model`, `items: SelectOption[]` (`icon`, `count`), `label`, `idPrefix` (tabs get `${idPrefix}-tab-<v>`, panels should use `${idPrefix}-panel-<v>`). |
| `UiDateRangeMenu` | `v-model: { from, to }`, `label`, `variant`, `align`. Presets 不限／今天／昨天／近 7 天／本月 + two-click custom range. The only date-range picker. |
| `UiPagination` | `pageInfo`, `v-model:page-size`, `sizeLabel` (accessible name of the size select), emits `page`; scrolls its Box back into view when the list top is off-screen. |

## Display

| Component | API |
|---|---|
| `UiBox` | Slots `header`, default, `footer`; props `padded`, `tag`, `stickyHeader` (pins the header below `PageToolbar`). Uses `overflow: clip` so sticky works. Adjacent boxes get 16px spacing. |
| `UiBoxTitle` | `title`, `icon`, `count` (rendered as a muted pill; no eyebrow); default slot for inline extras (e.g. a Label). |
| `UiBoxRow` | Props `clickable`, `title`, `meta`, `tag`; emits `select`. Slots `leading`, `title`, `labels`, `meta`, default (body), `trailing`. Clickable rows use a stretched title button; trailing actions stay independently focusable. Add class `hide-sm` to trailing items that should hide < 640px. |
| `UiGroupLabel` | Date/section separator inside a Box: canvas fill, 13px/500; optional `summary` prop or `summary` slot is the 12px muted recap beside it. |
| `UiHighlightedText` | `text`, `query`. Wraps the words of a search query found in `text` in `<mark>` (attention tint, no layout shift), reading the query like the server: quoted phrases stay whole, case is ignored. Renders plain text without a query. Use for search results; do not highlight fields the server does not search. |
| `UiLabel` | `tone: neutral \| accent \| success \| attention \| danger \| done`, `icon`. Tinted pill without a border (neutral is `--bg-muted`). |
| `UiCounter` | `count`, `tone: default \| attention`. |
| `UiStatCard` | `label`, `value`, `icon`, `suffix`, `foot` (or slot), `valueTone`, `delta: { direction, text }`, `compact` (tighter padding, 16px value, for dialogs and previews), `featured` (chart card: text left, the default slot, a `UiSparkline size="lg"`, right; meant for the overview's weekly-completed card, not wired to data yet); default slot for a meter/sparkline; `action-title` turns the label into a button that emits `select`. 13px muted label, 24px/600 value, 12px foot. |
| `UiFilterChips` | `chips: FilterChip[]` (`{ key, label }`), `clearable`; emits `remove(key)` and `clear`. Accent pills with an X under a list header; `clearable` adds 「清除篩選」. |
| `UiStatGrid` | Responsive grid for `UiStatCard`s. `columns` 2–5 (default 4); every layout is two columns below 960px (five columns first drop to three below 1280px); gap 16px, 8px below 640px. |
| `UiMeter` | `segments: { value, tone, label }[]`, `label?`, `max?` (denominator; a single segment then reads as progress), `size: md \| sm` (`md` 6px, `sm` the 4px row-level bar; 4px radius), `gap` (2px surface gap between touching segments, for part-to-whole bars). Segment `tone` is a `ChartTone`: the status tones plus `diagram-5` / `diagram-6` (categorical series colors, never status). Without `label` the meter is decorative (`aria-hidden`). |
| `UiStack` | Vertical flex stack with a 16px gap; cancels `UiBox`'s adjacent-box margin for direct Box children. Props `tag`. Use it instead of a grid/flex container plus `.ui-box + .ui-box { margin-top: 0 }`. |
| `UiSplitLayout` | Main column plus a 280–380px side column (slots `main`, `aside`; prop `asideLabel` makes the side an `aside` landmark). Each column is a `UiStack`, columns keep their own height (`align-items: start`), and the side column stacks under the main one below 960px. |
| `UiSparkline` | `values`, `label`, `size: md \| lg` (24px / 52px). |
| `UiBarChart` | `labels`, `series: { name, tone, values }[]`, `label`, `labelEvery`. Each series scales independently. |
| `UiStackedBarChart` | `labels`, `series: { name, tone: ChartTone, values }[]` (first series at the bottom), `label` (accessible name of the plot), `formatValue` (compact axis and `title` numbers), `formatExact` (value table), `labelEvery`, `compact`, `foldTable`. One shared y-scale with a clean maximum on the axis, 2px surface gap between stacked segments, 4px rounded top, bars capped at 24px, always-visible legend, `role="img"` plot, `title` per column, no tab stops per column; a value table sits below (folded into `<details>` when `compact` or `foldTable`). Use it instead of `UiBarChart` whenever series must share one scale (the Usage daily trend). |
| `UiDisclosure` | Native `<details>`: `title`, `icon`, `count`, `hint`, `open`. |
| `UiCommandBlock` | `text`, `successMessage`. Copyable natural-language Agent instruction (never tool names, IDs or JSON). |
| `UiFlash` | `tone: accent \| success \| attention \| danger`, `title`, `dismissible`; slot `actions`; emits `dismiss`. |
| `UiEmptyState` | `icon`, `title`, `description` (or default slot), `compact`; slot `action`. |
| `UiSkeleton` | `variant: row \| card \| text`, `count`. |
| `UiSpinner` | `size`, `label`. |
| `UiToastHost` / `useToast()` | `showToast(message, tone?, action?)`, `copyWithToast(text, message)`. Up to 4 plain and 4 action toasts (each kind is capped on its own), auto-dismiss 4 s; hover or focus pauses the countdown. An `action` (`{ label, run }`) adds a button and keeps the toast 8 s; use it for 復原 after an immediate change instead of a confirmation dialog, and offer it only when the undo restores the exact previous state. |
| Tooltips | Native `title` attribute (icon buttons set it from `label`; timestamps carry the absolute time). No custom tooltip component. |

## Overlays

| Component | API |
|---|---|
| `UiSidePanelHeader` | For the `header` slot of `UiSidePanel`. Props `title`, `closeLabel`; emits `close`; slots `leading` (before the title, e.g. a Back button or kind Label), `actions` (before the close button), default (labels and notes under the title). One title size (20px); no eyebrow. |
| `UiSidePanel` | `open`, `label`, `modal` (default true), `width` (default width, 640), `minWidth` (360), `storageKey` (remembers the user-chosen width in localStorage); emits `close`, `resize(width)`; slots `header`, default, `footer`. The left edge is a `separator` the user can drag or move with ←/→ (Home restores the default); hidden below 640px where the panel is full screen. `modal=false` docks under the header without backdrop or focus trap. Defaults: Session 760, Knowledge history 640, Graph node 460. |
| `UiDialog` | `open`, `title`, `description`, `size: sm \| md \| lg`, `busy` (blocks closing); emits `close`; slot `footer`. |
| `UiConfirmHost` / `confirmAction(options)` | Promise<boolean>; `title`, `message`, `confirmLabel`, `cancelLabel`, `danger`. Cancel is focused by default. |
| `CommandPalette` (domain) | `v-model:open`. Pages, Sessions and Knowledge search via existing APIs. |

All overlays use `useFocusTrap` (focus in, Tab trapped, Esc closes, scroll lock, focus restored). Popovers use `usePopover` (teleported, fixed-positioned, never clipped by a Box).

## Domain components

| Component | Notes |
|---|---|
| `AgentHandoffNotice` | Handoff step of an Agent flow: `title`, `status`, `message`, `command` (UiCommandBlock + copy), `cancelLabel` + `cancel` event, slots `default` and `actions`. Use it for every flow that waits on the Agent; toasts only say the request was created. |
| `StatusLabel` | `status: StatusVisual` from `utils/status.ts`, `showIcon`, `text`. |
| `SessionRow` | `session`, `showSummary`; emits `open`. Verification icon, title, Labels, `project · relative time · first outcome`. `data-testid="session-row"`. |
| `SessionPanel` | Global; read-only except the header 編輯摘要 action, which opens `SessionSummaryEditorDialog` (title, summary + five workSummary sections, one item per line), and, on a voided Session, the 還原 / 永久刪除 actions in its voided Flash (permanent delete asks a danger `confirmAction`). `?session=<id>` deep link, J/K via `setSessionSequence`, summary → meta → `WorkSummarySections` → Changed files → Git (only when present) → Evidence → Knowledge → Events → Handoff snapshot. |
| `WorkSummarySections` | Five sections in fixed order; `nextSteps` shown as 狀態／未結項; legacy note when missing. |
| `ChangedFileList` | A/M/D/R badges, `new ← old` for renames, provenance or 未提供來源, "changed files 不代表 Git commit". |
| `VerificationBreakdown` | `counts: { passed, failed, notRun, notSupplied }`. Four-state meter; no single percentage. |
| `SynthesisCard` / `SynthesisBlock` | ReportSummary order 主題 / 重點成果 / 驗證 / 比較 / 風險與限制 / 決策 / 狀態／未結項, per-block source chips, grain hint, generator meta, version history with delete (confirm). |
| `KnowledgeRow` | `item`; emits `action: edit \| history \| toggle-status \| source`. Collapsed by default (title, kind Label, one-line body, one meta line with the toggle); the `aria-expanded` toggle shows the full body, tags, references and applies-to paths. |
| `KnowledgePagesBox` | `v-model:projectId`, `projects`. With no project filter, rows are grouped under a `UiGroupLabel` (rendered inside each group's first row item, only with two or more groups) (summary: page count); a written page's title is the clickable `UiBoxRow` link that opens the side panel. |
| `KnowledgePageRequestDialog` | `open`, `projects`, `defaultProjectId`; shows a project select (placeholder 先選擇一個專案) when more than one project is tracked. |
| `KnowledgePageSources` | `sessionIds`, `titles`; emits `open`. A `UiDisclosure` 「來源（N）」 listing the first 3 Sessions vertically with an `aria-expanded` show-all toggle. |
| `KnowledgeEditorDialog`, `KnowledgeHistoryPanel` | Global; driven by `useKnowledge`. |
| `SessionSummaryEditorDialog` | Global; driven by `useSessionEditor`. Title input + summary textarea + one textarea per workSummary section (one item per line, `nextSteps` hint forbids plans). Saves only changed fields: title via the title endpoint, summary via replace, sections via patch, each with a fresh idempotency key; then reloads the Session detail and requests an app refresh. |
| `MetadataBackfillSection` | Scan, gap stats (three gap kinds), gap rows, Agent request via `AgentHandoffNotice`. |
| `HandoffImportDialog` | Import preview with eligible/excluded reasons; global. |
| `AddProjectDialog` | `v-model:open`. |
| `GraphNodePanel` | Docked non-modal SidePanel (460px default, resizable) that overlays the graph instead of pushing it; its reported width is passed to `GraphCanvas` as `overlayWidth`. Relation rows re-select the related node. |
| `GraphCanvas` (components/) | Lane SVG canvas; lanes stretch to the container (min 220px). Layered layout from `useGraph`: Sessions on even rows, knowledge/evidence/files beside their Sessions. `selectedId` keeps the node and its direct neighbours bright and dims the rest, and scrolls the node into view; `matchIds` marks search hits. `overlayWidth` (docked panel width) keeps lane widths unchanged, adds scroll room on the right and reveals the selected node left of the panel. Only nodes near the viewport render. |
