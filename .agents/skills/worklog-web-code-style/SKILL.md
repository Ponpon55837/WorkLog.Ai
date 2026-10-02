---
name: worklog-web-code-style
description: Code conventions for the Work Intelligence web app (apps/web) — where files go, file/identifier naming, SFC and import order, comment style, Pinia store and Pinia Colada query/mutation rules (query keys, invalidation), composable and component usage rules, TypeScript and CSS rules. Use together with worklog-ui whenever writing or reviewing .vue/.ts/.css under apps/web.
---

# Work Intelligence web — code style

These rules describe how `apps/web` is already written. Follow them for new code and apply them in reviews. Visual/UX rules (tokens, status colours, layout) live in the [`worklog-ui`](../worklog-ui/SKILL.md) skill; data semantics in its `references/domain-semantics.md`.

## 1. Where code goes

```
apps/web/src/
├─ App.vue              AppShell + <RouterView> + global overlays only (no page logic)
├─ main.ts              app bootstrap; imports styles/tokens.css and styles/base.css
├─ router.ts            routes, lazy views, route meta (title/eyebrow/group)
├─ api/                 transport.ts is the only place that calls fetch(); one module per domain
│                       (projects.ts, sessions.ts…), composed by client.ts
├─ i18n/                index.ts (t, tc, translatedRecord, locale) and en.ts (English catalog)
├─ styles/              tokens.css (all raw colours, dark + light sets) and base.css (reset/typography/focus/motion)
├─ utils/               pure functions and constant maps, no Vue reactivity
│  ├─ format.ts         dates, relative time, text formatting
│  ├─ labels.ts         UI label maps and option lists
│  └─ status.ts         status → { tone, icon, label } (single source of truth)
├─ stores/              Pinia setup stores, query keys, and server-state queries
├─ composables/         view workflows and cross-cutting side effects (see §4)
├─ components/
│  ├─ ui/               generic, domain-agnostic primitives, prefixed `Ui` (UiButton, UiBox…)
│  ├─ layout/           AppShell, AppHeader, AppSidebar, PageHeader, navigation.ts
│  ├─ domain/           Work-Intelligence-aware pieces (SessionRow, SessionPanel, SynthesisCard…)
│  └─ *.vue             legacy-shared primitives kept for compatibility (VirtualList, GraphCanvas)
└─ views/               one component per route: <Name>View.vue
```

Decision rule for a new component:
- Knows nothing about Sessions/Reports/Projects → `components/ui/`.
- Renders or mutates domain data → `components/domain/`.
- Only used by one view and < ~40 template lines → keep it inline in the view.
- Anything that talks to the API → a store (server state) or a composable workflow, never a component.

## 2. Naming

| Thing | Convention | Example |
|---|---|---|
| Vue component file | PascalCase, noun | `SessionPanel.vue`, `UiDateRangeMenu.vue` |
| Generic primitive | `Ui` prefix | `UiBoxRow`, `UiIconButton` |
| View | `<Route>View.vue` | `SessionsView.vue` |
| Composable file / function | `useX.ts` exporting `useX()` | `useReports.ts` |
| Utils file | plural noun or topic | `format.ts`, `labels.ts`, `status.ts` |
| Refs | noun, domain-prefixed inside a domain composable | `reportLoading`, `knowledgePage` |
| Booleans | `is*` / `has*` / `*Loading` / `*Open` | `hasSessionFilters`, `addOpen` |
| Actions | verb first | `loadReport`, `openSessionDetail`, `createReportSynthesisRequest` |
| Event handlers in views | `on<Thing>` or verb | `onAction`, `changeRawPage` |
| Emits | camelCase in `defineEmits`, kebab-case in templates | `openSources` / `@open-sources` |
| Props | camelCase in code, kebab-case in templates | `pageInfo` / `:page-info` |
| Accessible-name prop | always `label` (never `ariaLabel` — vue-tsc cannot map `aria-label` onto it) | `<UiSelect label="選擇報表區間">` |
| CSS classes | block `ui-button` / `session-panel`, element `__title`, modifier `--sm`, state `is-active` | `.ui-box-row__link`, `.is-selected` |
| data-testid | kebab-case, only when no role/label handle exists | `session-row`, `report-synthesis` |
| Route params / query keys | short lowercase | `/reports/:tab`, `?project=&page=` |

## 3. SFC layout

Order: `<script setup lang="ts">` → `<template>` → `<style scoped>`.

Inside `<script setup>`, follow the section order in the [`worklog-code-layout`](../worklog-code-layout/SKILL.md) skill §2 (imports → types → macros → constants → stores/composables → state → computed → functions → watchers → lifecycle → `defineExpose`). `pnpm lint` checks it with `scripts/sfc-layout.mjs`, `vue/define-macros-order`, and `no-use-before-define`. Put one JSDoc sentence describing the component's purpose above `defineProps` when there are props.

Import order (blank-line-free, one group after another, alphabetical inside a group):
1. `vue`, `vue-router`
2. third-party (`lucide-vue-next`)
3. `import type … from "@work-intelligence/core"`
4. components: `layout/` → `domain/` → `ui/` → other components
5. composables
6. `../router`
7. `../stores/*`
8. `../utils/*`
9. `../i18n` (always the last import)

Template rules:
- Use `v-if`/`v-else-if` chains for loading → empty → content; never render an empty list without `UiEmptyState`.
- No inline object literals longer than one line — move them to a `computed` or constant.
- No business logic in templates beyond simple ternaries.

## 4. Stores and composables

- Domain state belongs in a **Pinia setup store** under `stores/`, with one store per domain. Components and views use `useXxxStore()` and `storeToRefs()`; do not add new module-level reactive singletons.
- Server state uses Pinia Colada `useQuery()` and `useMutation()`. Key prefixes live in `stores/query-keys.ts`; never write key strings inline.
- **Every value a query reads belongs in its key.** Write the key as a function that appends the parameters to the prefix, e.g. `key: () => [...queryKeys.sessions.list, { q, projectId, page, pageSize }]`, so a parameter change refetches by itself and each parameter set gets its own cache entry. Do not read filter refs inside `query` behind a static key and then call `refetch()` by hand. (Some round-5 queries still do this; round 6 migrates them. Do not add new ones.)
- Every mutation lists the key prefixes it affects and invalidates them after success (`invalidateQueries({ key: prefix })` matches all parameter sets under the prefix). Do not build a separate cache or copy query data into another mutable ref.
- Keep form drafts and temporary view state local to the component that owns the interaction. Use store state only when multiple parts of the app share it.
- API calls go through `useApi().client` from a store or composable.
- Components use stores directly (`useXxxStore()` + `storeToRefs`). Do not add `useXxx()` adapters that re-export a store; the round-5 adapters were removed.
- User feedback: `useToast().showToast(message, tone)`; destructive or scope-widening actions: `await confirmAction({...})`. Never `window.confirm`/`alert`.
- List pages wire `useRouteQuery` (URL ⇄ filter refs, the single source of filter state) → `useListReload` (filter change → page 1, page change → reload, debounced search). Loading on mount comes from the query being enabled; a global refresh or an SSE `changed` event calls `invalidateActiveQueries()` from `useAppRefresh`.
- A store or composable must not import a view or a component (the one exception is `router` for navigation actions).
- Keep API response shapes out of templates when they need interpretation — expose a `computed` instead.

## 5. Components

- Use the `ui/` primitive when one exists; do not hand-roll buttons, labels, lists, dialogs, menus or pagination. Raw `<button>` is allowed only inside `components/ui/` or for a bespoke control that no primitive covers (document why in a comment).
- Lists: `UiBox` + `UiBoxRow` (`clickable` + `@select` for row navigation). Status: `StatusLabel` + a map from `utils/status.ts`. Overlays: `UiSidePanel` (read) / `UiDialog` (forms, decisions). Pagination: `UiPagination`. Dates: `UiDateRangeMenu`.
- Icons: import individual lucide components and pass them as `:icon`, or render `<Icon :size="16" :stroke-width="1.75" aria-hidden="true" />`. Icon-only actions use `UiIconButton` with a `label`.
- Props: typed with `defineProps<{…}>()`; defaults via `withDefaults`. Two-way state uses `defineModel` (`v-model`, `v-model:open`, `v-model:page-size`).
- Emit domain intent, not DOM events: `@open`, `@action`, `@select` — not `@click-row`.
- A component that becomes a global overlay (SessionPanel, dialogs, CommandPalette) is mounted once in `App.vue` and controlled by its composable.

## 6. Comments

- Language: code comments and JSDoc in **English**; user-facing strings in **繁體中文**, wrapped in `t()` (§6a).
- Every exported composable function, util with non-obvious behaviour, and every component gets a one-sentence `/** … */` stating purpose or contract.
- Inline `//` comments explain **why** (a trade-off, a data-contract rule, a browser quirk), never restate the code.
- Reference the rule source when a comment encodes a domain rule, e.g. `// Missing verification is historical not_supplied, never not_run.`
- No commented-out code, no TODOs without an owner/issue, no section-divider banners.

## 6a. Interface language (i18n)

The UI ships in 繁體中文 and English. The Chinese source text is the message key (gettext style), so code stays readable and an untranslated string falls back to Chinese rather than to a blank.

- **Wrap every user-visible string** — text, `label`, `aria-label`, `title`, `placeholder`, toast and error messages — in `t("…")` from `src/i18n`. In templates bind it: `:label="t('重新整理')"`, `{{ t("全部 Sessions") }}`.
- **Interpolate, never concatenate**: `t("已匯入 {count} 個 handoff。", { count })`. Name placeholders after what they hold; word order differs between languages, so one sentence is one `t()` call.
- **Counts**: give the English entry a `one|other` form (`"{count} file|{count} files"`); the first number placeholder picks the form.
- **Same text, different meaning**: use `tc(context, source)` and add a `context|source` key (`tc("unit", "週")` → "weeks", while `t("週")` is the "Week" tab). Route titles and nav labels use the `nav` context.
- **Module-level constants** (label maps, status visuals, option lists, route meta) are built once, so they must translate on read: `translatedRecord({...})`, `translatedOptions(list, "label")`, the `visual()` helper in `utils/status.ts`, or store the source text and call `t()` where it is displayed. Never call `t()` in a module-level initializer or a `withDefaults` default — resolve defaults in a `computed`.
- **Do not translate data**: Session text, report content, Agent output, API `reason` strings and data markers (`資料不足`, `KNOWLEDGE_PAGE_INSUFFICIENT`) are compared and shown as stored.
- **Dates and numbers** go through `utils/format.ts`, which uses `intlLocale()`; do not hard-code `"zh-TW"` in `Intl` calls.
- **Catalog**: add the English text to `src/i18n/en.ts` in the same change. `tests/web/i18n/catalog.test.ts` fails when a Chinese string in `src/` has no entry, when an entry is no longer used, or when a translation drops a `{placeholder}`.
- The locale is a module-level ref in `src/i18n` (utils translate outside components); `stores/preferences.ts` persists it and the theme. `App.vue` keys the page and overlays by locale, so setup-time strings refresh on a language switch.

## 7. TypeScript

- `strict` stays on. Exported functions declare return types. Prefer `import type` for types.
- No `any` types. Use `unknown` + narrowing for external data.
- Non-null `!` only in templates right after a guarding `v-if`, never in scripts.
- Shared UI types live in `components/ui/types.ts` (`IconComponent`, `Tone`, `SelectOption`, `DateRange`).
- Enumerations come from `@work-intelligence/core` types; do not redefine them locally.

## 8. CSS

- `<style scoped>` only; global CSS is limited to `styles/tokens.css` and `styles/base.css`.
- Only design tokens (`var(--…)`); raw hex/rgba are allowed only in `tokens.css`.
- Minimum font size 12px (11px only for uppercase eyebrows in Box headers / sidebar groups).
- Breakpoints: `@media (max-width: 1279px)`, `(max-width: 959px)`, `(max-width: 639px)`. Mobile rules go last.
- Style a child component's root through its class from the parent's scoped style; reach inside with `:deep()` only for lucide icons or documented slots.
- Respect `prefers-reduced-motion` for any animation longer than 150 ms.

## 9. Before you finish

```bash
pnpm --filter @work-intelligence/web typecheck
pnpm lint
pnpm --filter @work-intelligence/web build
pnpm test:e2e
```

E2E runs the production build on one port. If the default port is busy: `WORK_INTELLIGENCE_E2E_WEB_PORT=5987 pnpm test:e2e`. Use pnpm, never npm/npx.

Review checklist:
- [ ] File in the right folder with the right name (§1–2).
- [ ] Import order and SFC order (§3).
- [ ] No API call outside stores/composables; queries keyed by every parameter they read; mutations invalidate affected prefixes (§4).
- [ ] `ui/` primitives and `utils/status.ts` used; no inline status colours (§5).
- [ ] Comments explain why, in English (§6).
- [ ] No `any`, no stray `!`, explicit return types on exports (§7).
- [ ] Tokens only, scoped, breakpoints from the set (§8).
