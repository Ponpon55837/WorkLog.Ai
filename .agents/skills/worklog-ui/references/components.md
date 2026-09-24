# Component catalog

Location: `apps/web/src/components/ui/` (generic, `Ui*`), `components/layout/` (shell), `components/domain/` (Work Intelligence specific). The source is the final authority; update this file whenever an API changes. Every component is browsable in the dev-only `/__ui` route (`views/UiShowcaseView.vue`).

**Prop naming:** the accessible name of a control is always the `label` prop (never `ariaLabel`). Two-way state uses `v-model` (`defineModel`).

## Layout

| Component | API |
|---|---|
| `AppShell` | Props `refreshing`, `counts` (sidebar counters by route name), `fullWidth`. Emits `refresh`, `search`. Slots: default (page), `overlays`. Mounts `UiConfirmHost` and `UiToastHost`. |
| `AppHeader` | Menu button (< 640px), `WI` logo, crumb from route meta, search trigger (`Ctrl/⌘ K`), Local-first dot, refresh `UiIconButton`. |
| `AppSidebar` | Built from `layout/navigation.ts` (`navItems`, `navGroups`). Full ≥ 960, icon rail 640–959, drawer < 640. Nav links carry `data-testid="nav-<route>"`. |
| `PageHeader` | Props `title?`, `eyebrow?` (default to route meta), `description?`. Slot `actions`. Scrolls away with the page. |
| `PageToolbar` | Sticky container for page search and/or `UiUnderlineNav`; publishes `--page-toolbar-height` for sticky Box headers. One per page. |

## Actions & inputs

| Component | API |
|---|---|
| `UiButton` | `variant: default \| primary \| invisible \| danger`, `size: md \| sm`, `icon`, `trailingIcon`, `loading`, `disabled`, `type`, `to` (renders RouterLink), `iconOnly` + `label`. |
| `UiIconButton` | Required `icon`, `label`; `variant` (default `invisible`), `size`, `loading`, `disabled`. |
| `UiCopyButton` | `text`, `label`, `successMessage`, `variant`, `size`, `iconOnly`. Toast + check-mark feedback. |
| `UiTextInput` | `v-model`, `icon`, `type: text \| search \| date`, `placeholder`, `label`, `size`, `mono`, `maxlength`, `required`, `autofocus`. Slots `prefix`, `suffix`. |
| `UiTextarea` | `v-model`, `rows`, `placeholder`, `maxlength`, `required`, `mono`. |
| `UiSelect` | Native select. `v-model`, `options: SelectOption[]`, `label`, `icon`, `size`, `disabled`. Use for forms/toolbars and anything e2e selects by label. |
| `UiField` | `label`, `hint`, `error`; wraps one control. |
| `UiActionMenu` | Popover menu. `label` (trigger text), `items: SelectOption[]`, `header`, `icon`, `align: start \| end`, `variant: filter \| button`, `size`, `hideLabelOnMobile`. With `v-model` + `defaultValue` it is a single-select filter (trigger turns bold when applied); without `v-model` it is an action menu and emits `select`. Arrow keys, Esc, outside click. |
| `UiSegmentedControl` | `v-model`, `options`, `label`. Arrow keys move selection. |
| `UiUnderlineNav` | `v-model`, `items: SelectOption[]` (`icon`, `count`), `label`, `idPrefix` (tabs get `${idPrefix}-tab-<v>`, panels should use `${idPrefix}-panel-<v>`). |
| `UiDateRangeMenu` | `v-model: { from, to }`, `label`, `variant`, `align`. Presets 不限／今天／昨天／近 7 天／本月 + two-click custom range. The only date-range picker. |
| `UiPagination` | `pageInfo`, `v-model:page-size`, `sizeLabel` (accessible name of the size select), emits `page`; scrolls its Box back into view when the list top is off-screen. |

## Display

| Component | API |
|---|---|
| `UiBox` | Slots `header`, default, `footer`; props `padded`, `tag`, `stickyHeader` (pins the header below `PageToolbar`). Uses `overflow: clip` so sticky works. Adjacent boxes get 16px spacing. |
| `UiBoxTitle` | `title`, `eyebrow`, `icon`, `count`; default slot for inline extras (e.g. a Label). |
| `UiBoxRow` | Props `clickable`, `title`, `meta`, `tag`; emits `select`. Slots `leading`, `title`, `labels`, `meta`, default (body), `trailing`. Clickable rows use a stretched title button; trailing actions stay independently focusable. Add class `hide-sm` to trailing items that should hide < 640px. |
| `UiGroupLabel` | Date/section separator inside a Box. |
| `UiLabel` | `tone: neutral \| accent \| success \| attention \| danger \| done`, `icon`. |
| `UiCounter` | `count`, `tone: default \| attention`. |
| `UiStatCard` | `label`, `value`, `icon`, `suffix`, `foot` (or slot), `valueTone`, `delta: { direction, text }`; default slot for a meter/sparkline. |
| `UiMeter` | `segments: { value, tone, label }[]`, `label`. |
| `UiSparkline` | `values`, `label`. |
| `UiBarChart` | `labels`, `series: { name, tone, values }[]`, `label`, `labelEvery`. Each series scales independently. |
| `UiDisclosure` | Native `<details>`: `title`, `icon`, `count`, `hint`, `open`. |
| `UiCommandBlock` | `text`, `successMessage`. Copyable natural-language Agent instruction (never tool names, IDs or JSON). |
| `UiFlash` | `tone: accent \| success \| attention \| danger`, `title`, `dismissible`; slot `actions`; emits `dismiss`. |
| `UiEmptyState` | `icon`, `title`, `description` (or default slot), `compact`; slot `action`. |
| `UiSkeleton` | `variant: row \| card \| text`, `count`. |
| `UiSpinner` | `size`, `label`. |
| `UiToastHost` / `useToast()` | `showToast(message, tone?)`, `copyWithToast(text, message)`. Stack of 4, auto-dismiss 4 s. |
| Tooltips | Native `title` attribute (icon buttons set it from `label`; timestamps carry the absolute time). No custom tooltip component. |

## Overlays

| Component | API |
|---|---|
| `UiSidePanel` | `open`, `label`, `modal` (default true), `width` (default width, 640), `minWidth` (360), `storageKey` (remembers the user-chosen width in localStorage); emits `close`, `resize(width)`; slots `header`, default, `footer`. The left edge is a `separator` the user can drag or move with ←/→ (Home restores the default); hidden below 640px where the panel is full screen. `modal=false` docks under the header without backdrop or focus trap. Defaults: Session 760, Knowledge history 640, Graph node 460. |
| `UiDialog` | `open`, `title`, `description`, `size: sm \| md \| lg`, `busy` (blocks closing); emits `close`; slot `footer`. |
| `UiConfirmHost` / `confirmAction(options)` | Promise<boolean>; `title`, `message`, `confirmLabel`, `cancelLabel`, `danger`. Cancel is focused by default. |
| `CommandPalette` (domain) | `v-model:open`. Pages, Sessions and Knowledge search via existing APIs. |

All overlays use `useFocusTrap` (focus in, Tab trapped, Esc closes, scroll lock, focus restored). Popovers use `usePopover` (teleported, fixed-positioned, never clipped by a Box).

## Domain components

| Component | Notes |
|---|---|
| `StatusLabel` | `status: StatusVisual` from `utils/status.ts`, `showIcon`, `text`. |
| `SessionRow` | `session`, `showSummary`; emits `open`. Verification icon, title, Labels, `project · relative time · first outcome`. `data-testid="session-row"`. |
| `SessionPanel` | Global; read-only except the header 編輯摘要 action, which opens `SessionSummaryEditorDialog` (summary + five workSummary sections, one item per line). `?session=<id>` deep link, J/K via `setSessionSequence`, summary → meta → `WorkSummarySections` → Changed files → Git (only when present) → Evidence → Knowledge → Events → Handoff snapshot. |
| `WorkSummarySections` | Five sections in fixed order; `nextSteps` shown as 狀態／未結項; legacy note when missing. |
| `ChangedFileList` | A/M/D/R badges, `new ← old` for renames, provenance or 未提供來源, "changed files 不代表 Git commit". |
| `VerificationBreakdown` | `counts: { passed, failed, notRun, notSupplied }`. Four-state meter; no single percentage. |
| `SynthesisCard` / `SynthesisBlock` | ReportSummary order 主題 / 重點成果 / 驗證 / 比較 / 風險與限制 / 決策 / 狀態／未結項, per-block source chips, grain hint, generator meta, version history with delete (confirm). |
| `KnowledgeRow` | `item`; emits `action: edit \| history \| toggle-status \| source`. |
| `KnowledgeEditorDialog`, `KnowledgeHistoryPanel` | Global; driven by `useKnowledge`. |
| `MetadataBackfillSection` | Scan, gap stats (three gap kinds), gap rows, Agent request card. |
| `HandoffImportDialog` | Import preview with eligible/excluded reasons; global. |
| `AddProjectDialog` | `v-model:open`. |
| `GraphNodePanel` | Docked non-modal SidePanel (460px default, resizable) that overlays the graph instead of pushing it; its reported width is passed to `GraphCanvas` as `overlayWidth`. Relation rows re-select the related node. |
| `GraphCanvas` (components/) | Lane SVG canvas; lanes stretch to the container (min 220px). Layered layout from `useGraph`: Sessions on even rows, knowledge/evidence/files beside their Sessions. `selectedId` keeps the node and its direct neighbours bright and dims the rest, and scrolls the node into view; `matchIds` marks search hits. `overlayWidth` (docked panel width) keeps lane widths unchanged, adds scroll room on the right and reveals the selected node left of the panel. Only nodes near the viewport render. |
