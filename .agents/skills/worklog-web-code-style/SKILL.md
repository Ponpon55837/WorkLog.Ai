---
name: worklog-web-code-style
description: Code conventions for the Work Intelligence web app (apps/web) — where files go, file/identifier naming, SFC and import order, comment style, composable and component usage rules, TypeScript and CSS rules. Use together with worklog-ui whenever writing or reviewing .vue/.ts/.css under apps/web.
---

# Work Intelligence web — code style

These rules describe how `apps/web` is already written. Follow them for new code and apply them in reviews. Visual/UX rules (tokens, status colours, layout) live in the [`worklog-ui`](../worklog-ui/SKILL.md) skill; data semantics in its `references/domain-semantics.md`.

## 1. Where code goes

```
apps/web/src/
├─ App.vue              AppShell + <RouterView> + global overlays only (no page logic)
├─ main.ts              app bootstrap; imports styles/tokens.css and styles/base.css
├─ router.ts            routes, lazy views, route meta (title/eyebrow/group)
├─ api/client.ts        the only place that calls fetch()
├─ styles/              tokens.css (all raw colours) and base.css (reset/typography/focus)
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
- Anything that talks to the API → a composable, never a component.

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

Inside `<script setup>`:
1. Imports (order below).
2. Local `type` aliases.
3. One JSDoc sentence describing the component's purpose (above `defineProps` when there are props).
4. `defineProps` / `defineModel` / `defineEmits`.
5. Composable destructuring.
6. `useRouteQuery` / `useListReload` / `useViewLoader` wiring.
7. `computed`, then functions, then `watch`, then lifecycle hooks.

Import order (blank-line-free, one group after another, alphabetical inside a group):
1. `vue`, `vue-router`
2. third-party (`lucide-vue-next`)
3. `import type … from "@work-intelligence/core"`
4. components: `layout/` → `domain/` → `ui/` → other components
5. composables
6. `../router`
7. `../utils/*`

Template rules:
- Use `v-if`/`v-else-if` chains for loading → empty → content; never render an empty list without `UiEmptyState`.
- No inline object literals longer than one line — move them to a `computed` or constant.
- No business logic in templates beyond simple ternaries.

## 4. Stores and composables

- Domain state belongs in a **Pinia setup store** under `stores/`, with one store per domain. Components and views use `useXxxStore()` and `storeToRefs()`; do not add new module-level reactive singletons.
- Server state uses Pinia Colada `useQuery()` and `useMutation()`. Define stable query keys in `stores/query-keys.ts`; every mutation lists its affected keys and invalidates them after success. Do not build a separate cache or copy query data into another mutable ref.
- Keep form drafts and temporary view state local to the component that owns the interaction. Use store state only when multiple parts of the app share it.
- API calls go through `useApi().client` from a store or composable. Legacy composables may continue to use `runKeyed(key, task, { onError, onSettled })` until their domain migrates to Pinia Colada.
- Transitional `useXxx()` adapters may expose refs and actions from a store while existing consumers migrate; do not add new domain behavior to the adapter.
- User feedback: `useToast().showToast(message, tone)`; destructive or scope-widening actions: `await confirmAction({...})`. Never `window.confirm`/`alert`.
- List pages wire three helpers, in this order: `useRouteQuery` (URL ⇄ filter refs) → `useListReload` (filter change → page 1, page change → reload, debounced search) → `useViewLoader` (load on mount and on global refresh).
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

- Language: code comments and JSDoc in **English**; user-facing strings in **繁體中文**.
- Every exported composable function, util with non-obvious behaviour, and every component gets a one-sentence `/** … */` stating purpose or contract.
- Inline `//` comments explain **why** (a trade-off, a data-contract rule, a browser quirk), never restate the code.
- Reference the rule source when a comment encodes a domain rule, e.g. `// Missing verification is historical not_supplied, never not_run.`
- No commented-out code, no TODOs without an owner/issue, no section-divider banners.

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

If ports 5967/3211 are busy, run e2e on others: `WORK_INTELLIGENCE_E2E_WEB_PORT=5987 WORK_INTELLIGENCE_E2E_API_PORT=3231 npx playwright test`.

Review checklist:
- [ ] File in the right folder with the right name (§1–2).
- [ ] Import order and SFC order (§3).
- [ ] No fetch/API call outside composables; `runKeyed` used (§4).
- [ ] `ui/` primitives and `utils/status.ts` used; no inline status colours (§5).
- [ ] Comments explain why, in English (§6).
- [ ] No `any`, no stray `!`, explicit return types on exports (§7).
- [ ] Tokens only, scoped, breakpoints from the set (§8).
