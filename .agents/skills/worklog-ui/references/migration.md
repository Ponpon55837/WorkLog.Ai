# Migration guide (P0–P4)

Full plan: `docs/ui-redesign-plan.md`. Each phase ships as its own PR(s). Never mix phases.

## P0 — Safety net
- Capture Playwright screenshots of all 6 pages at 1440 / 960 / 375 into `docs/ui-baseline/`.
- Replace class-based `locator(".worklog-row")`-style selectors in `e2e/work-intelligence.spec.ts` with `getByRole` / `getByLabel` / `data-testid`. Add `data-testid` to the current markup where no accessible handle exists.
- Done when: `pnpm test:e2e` passes with zero styling-class selectors.

## P1 — Architecture split, no visual change
- Extract one domain at a time from `App.vue` into `composables/` (sessions → reports + synthesis → knowledge → graph → projects + backfill + handoff import). Run e2e after each extraction.
- Views call composables directly; delete the matching props/emits.
- Move formatters to `utils/format.ts`, label maps to `utils/labels.ts`.
- Switch nav to `RouterLink`, titles to route meta, add `useRouteQuery`, add `/sessions` with `/worklog` redirect.
- Done when: screenshots match the P0 baseline, App.vue < 150 lines, typecheck/build/e2e pass.

## P2 — Design system
- `pnpm --filter @work-intelligence/web add lucide-vue-next`.
- Add `styles/tokens.css` and `styles/base.css`; build `components/ui` and `components/layout` per [components.md](components.md).
- Mount the new `AppShell`; old pages render inside it unchanged.
- Add a dev-only `/__ui` route showing every component state (guard with `import.meta.env.DEV`).

## P3 — Page-by-page migration
Order: Sessions (+ SessionPanel) → Dashboard → Projects → Knowledge → Reports → Graph. For each page:
1. Rebuild the template with ui/layout/domain components.
2. Delete every selector in `style.css` that only this page used (grep the class across `apps/web/src` and `e2e/` before deleting).
3. Attach before/after screenshots at three widths to the PR.
4. Pass the SKILL.md verification checklist.

## P4 — Cleanup
- Remove leftover global CSS (target: `style.css` gone or < 150 lines of base) and the empty `*Modal.vue` wrappers.
- Command palette and keyboard shortcuts.
- Accessibility pass: contrast ≥ 4.5:1 for text, visible focus, axe with zero critical issues.

## Old → new mapping (quick reference)

| Old | New |
|---|---|
| `.panel`, `.metric-card` | `UiBox`, `StatCard` |
| `.nav-item` buttons + `changeView()` | `AppSidebar` + `RouterLink` |
| `.section-intro` + big `h2` slogan | `PageHeader` |
| `.filter-field`, `.report-control`, `.graph-tools` | `UiActionMenu` in Box header / `PageHeader` actions |
| custom Worklog calendar + native `type="date"` | `UiDateRangeMenu` |
| `.pagination-bar` copies | `UiPagination` |
| `.verification-badge`, `.metadata-gap-chip`, `.synthesis-status` | `StatusLabel` |
| `.toast` | `ToastHost` / `useToast()` |
| `BaseModal` + `*Modal.vue` wrappers | `UiSidePanel` / `UiDialog` |
| `.loading-state` spinner | `UiSkeleton` |
| Unicode icons | `lucide-vue-next` |
