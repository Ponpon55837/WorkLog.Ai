---
name: worklog-ui
description: Use for ANY change to the Work Intelligence web UI (apps/web) — new pages, components, styles, layouts, lists, filters, dialogs/side panels, icons, copy, or the P0–P4 UI redesign migration. Defines the GitHub-dark design tokens, the ui/ component catalog, layout and detail-view rules, status→color mapping, copy/eyebrow rules, and the verification checklist. Load this BEFORE editing any .vue or .css file under apps/web.
---

# Work Intelligence UI

The web UI (`apps/web`, Vue 3 + vue-router + Vite) is being redesigned to a **GitHub-dark (Primer-like)**, data-first tool UI. This skill is the single source of truth for how UI code must look and be built. The rationale and phase plan live in [`docs/ui-redesign-plan.md`](../../../docs/ui-redesign-plan.md). The approved visual reference is [`assets/preview.html`](assets/preview.html) — open it in a browser when in doubt about look and feel. Every implemented component is live in the dev-only `/__ui` route. File placement, naming, comments and composable rules are in the companion [`worklog-web-code-style`](../worklog-web-code-style/SKILL.md) skill.

## Fixed decisions (do not re-ask the user)

- Dark theme only. No light theme, no theme toggle, no `prefers-color-scheme` branches.
- GitHub/Primer dark visual language: Box lists, Label pills, Counter, UnderlineNav, SegmentedControl, ActionMenu.
- Icons: `lucide-vue-next` only, 16px, `stroke-width` 1.75. No Unicode glyph icons (⌂ ◈ ▥ ✦ ◎ ≡ ⌕ ↻).
- Keep English uppercase eyebrows above Chinese titles (e.g. `SESSION ARCHIVE` / 工作歷程).
- Reading details → right **SidePanel**; forms and confirmations → centered **Dialog**.
- Backend, MCP and HTTP API contracts are out of scope. Never add an endpoint to make a UI work; hide the block instead.
- UI text is 繁體中文; technical terms (Session, Knowledge, verification, metadata, handoff) stay in English.

## Workflow

1. The P0–P4 migration is complete (see `docs/ui-redesign-plan.md`); new work builds on the shipped design system.
2. Before writing UI, check `apps/web/src/components/ui/` and `components/layout/` for an existing component. Reuse it. If it does not exist yet, build it to the spec in [references/components.md](references/components.md) — never hand-roll a one-off.
3. Use only tokens from [references/tokens.md](references/tokens.md). No raw hex / rgba in component CSS except inside `styles/tokens.css`.
4. Follow page and interaction patterns in [references/patterns.md](references/patterns.md).
5. Whenever a view displays Sessions, verification, changed files, reports/synthesis, metadata backfill or project status, apply [references/domain-semantics.md](references/domain-semantics.md). It is derived from `docs/work-record-and-report-format.md` and the [`work-intelligence` skill](../work-intelligence/SKILL.md); those sources win on conflict.
6. When migrating an existing page, follow [references/migration.md](references/migration.md), including deleting the page's old CSS.
7. Run the verification checklist below and report results honestly.

## Non-negotiables

- **State lives in composables, not App.vue.** Views call `useXxx()` directly; no prop-drilling of data, labels or formatter functions. Formatters go in `utils/format.ts`, label maps in `utils/labels.ts`.
- **URL is the state for filters.** Filters, pagination, report tabs and the open Session (`?session=<id>`) are synced through `useRouteQuery`.
- **Navigation uses `RouterLink`**, page title/eyebrow come from route `meta`.
- **Styling**: component styles use `<style scoped>` and tokens. Global CSS is only `styles/tokens.css` + `styles/base.css`. Never append "refinement" override blocks to a global stylesheet.
- **Minimum font size 12px.** Body text is 14px.
- **One component per concept**: one date-range picker, one filter pattern, one pagination, one status Label mapping.
- **Accessibility**: every icon-only button has `aria-label`; focus is always visible (`:focus-visible` accent outline); Dialog/SidePanel trap focus, close on Esc, restore focus to the trigger, lock background scroll.
- **Data semantics are not styling choices**: `nextSteps` is labeled 狀態／未結項 (never 後續); `executionStatus` is neutral, not success; missing verification (未回報) ≠ `not_run` (未執行) ≠ passed; changed files ≠ Git commit; deterministic report numbers ≠ Agent synthesis text; summary, workSummary, and verification are edited only in place through the Session editor Dialog, and voiding a Session or evidence always asks for a reason (changed files, events, and evidence content stay read-only).
- **Test hooks**: e2e selects by role, label or `data-testid` — never by styling class. When you rename or remove a class, check `e2e/` first.

## Verification checklist

Run and report each result:

```bash
pnpm --filter @work-intelligence/web typecheck
pnpm --filter @work-intelligence/web build
pnpm lint
pnpm test:e2e
```

Then check in a browser at **1440 / 960 / 375** px widths:

- [ ] No horizontal page scroll; no overlapping or clipped text.
- [ ] Sidebar: full at ≥ 960, icon rail at 640–959, drawer at < 640.
- [ ] Loading shows Skeleton, empty state has a next-step action, errors show a Flash with retry.
- [ ] All interactive elements reachable by keyboard with visible focus.
- [ ] Status colors follow the mapping in [references/tokens.md](references/tokens.md#status-mapping).
- [ ] Domain distinctions in [references/domain-semantics.md](references/domain-semantics.md) are visible (狀態／未結項 label, four verification states, Git separate from changed files, synthesis blocks cite sources).
- [ ] No raw hex outside `tokens.css`, no Unicode icons, no font size < 12px.
- [ ] For a migrated page: its old classes are gone from `style.css`, and before/after screenshots are attached to the PR.
