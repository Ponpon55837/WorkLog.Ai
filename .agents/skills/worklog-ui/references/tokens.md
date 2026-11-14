# Design tokens

All values live in `apps/web/src/styles/tokens.css`. Components reference tokens only.

## Color

Two sets share the same token names: GitHub dark on `:root` (the default) and a softened light set on `:root[data-theme="light"]`. The page stays cool grey (~87% luminance, never paper white); cards, popovers and dialogs sit on a near-white `--bg-surface` one step above it; text colours are darkened so 12px Label text on its 10% tint still reaches 4.5:1 on every light surface.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg-canvas` | `#0d1117` | `#eef0f3` | Page background, AppHeader, sidebar, SidePanel, UiGroupLabel |
| `--bg-surface` | `#151b23` | `#fbfcfd` | Box (header, body, footer), StatCard, inputs, default buttons, popovers, Dialog, toast, keycap |
| `--bg-inset` | `#010409` | `#e6e9ed` | Command blocks, code and diagram wells |
| `--bg-subtle` | `#11161d` | `#e6e9ed` | Recessed fills inside a card (disclosure headers, quiet panels) |
| `--bg-hover` | `#1c2128` | `#e2e5ea` | Row / nav hover (rows mix it 55% into the surface) |
| `--bg-muted` | `#21262d` | `#e2e5ea` | Active nav item, selected segment, count pill, neutral Label, meter track, button hover |
| `--border` | `#30363d` | `#c9d0d8` | Box / input / button borders, shell edges |
| `--border-muted` | `#242b34` | `#dbe0e6` | Row dividers, Box header/footer rules |
| `--fg` | `#e6edf3` | `#24292f` | Primary text |
| `--fg-muted` | `#9198a1` | `#4f5862` | Meta text, secondary icons |
| `--fg-subtle` | `#848d97` | `#58616b` | Placeholders, sidebar group labels and counts, empty dashes (dark raised from `#6e7681`, which was 4.2:1 on the canvas) |
| `--fg-on-accent` | `#0d1117` | `#ffffff` | Text on a solid `--accent` fill (primary button) |
| `--accent` | `#4493f8` | `#0754ae` | Links, focus ring, selected state, primary data series |
| `--accent-emphasis` | `#1f6feb` | `#0969da` | Input focus border |
| `--success` | `#3fb950` | `#16652a` | Passed, tracked, positive delta |
| `--success-emphasis` | `#238636` | `#1f883d` | Solid success fills (the primary button is accent now) |
| `--attention` | `#d29922` | `#744c00` | Missing / pending / paused |
| `--danger` | `#f85149` | `#a91b26` | Failed, errors, negative delta, destructive actions |
| `--done` | `#a371f7` | `#6235b8` | AI synthesis, completed synthesis, Knowledge accents |

Diagram tones `--diagram-tone-1` … `--diagram-tone-6` (dark: blue `#4493f8`, purple `#ab7df8`, green `#3fb950`, orange `#f0883e`, pink `#f778ba`, cyan `#39c5cf`; light: `#0754ae`, `#6235b8`, `#16652a`, `#8f3c00`, `#99195f`, `#0a5f6b`) are categorical colors for architecture-diagram groups only, never status. Each reaches 4.5:1 as 12px text on its own 8% tint over `--bg-inset`; tint surfaces with `color-mix(in srgb, var(--diagram-tone-N) 6–8%, <surface>)`.

Label recipe: text = color token, background = the `-soft` token (color at 10% alpha), transparent border (the 20px pill keeps its box). Neutral Label: `--fg-muted` text on `--bg-muted`. The selected UnderlineNav tab bar and the primary button use `--accent`.

Contrast (WCAG ratio, computed with the formula in the spec): dark `--fg-muted` on canvas 6.50, surface 5.94, muted 5.23; `--fg-subtle` on canvas 5.62, surface 5.14, muted 4.52; `--fg-on-accent` on `--accent` 6.11 (hover 6.88). Light `--fg-muted` on canvas 6.33, surface 7.04, muted 5.73; `--fg-subtle` on canvas 5.51, surface 6.13; `--fg-on-accent` on `--accent` 7.27 (hover 7.98). 12px Label text on its 10% tint over surface: dark accent 4.87, success 5.83, attention 5.87, danger 4.66, done 4.53; light 6.00–6.41 (all tones are at or above 4.5 on canvas and subtle too).

Counter: `rgba(110,118,129,.4)` background, 12px, pill; attention variant `rgba(187,128,9,.4)`.

## Status mapping

Use these everywhere (lists, panels, dashboard, reports). Implement once in `utils/labels.ts` + `StatusLabel`.

| Domain | Value | Tone | Lucide icon | 顯示文字 |
|---|---|---|---|---|
| verification | `passed` | success | `circle-check` | 通過 |
| verification | `failed` | danger | `circle-x` | 失敗 |
| verification | `in_progress` | accent | `clock-3` | 進行中 |
| verification | `not_run` | neutral | `circle-minus` | 未執行 |
| verification | missing / `not_supplied` | attention | `circle-dashed` | 未回報 |
| execution | `completed` | neutral | — | completed |
| project tracking | `tracked` | success | `folder-git-2` | 記錄中 |
| project tracking | `paused` | attention | `folder` | 已暫停 |
| project tracking | `ignored` | neutral | `folder-x` | 已忽略 |
| project tracking | `unregistered` | neutral | `folder` | 未註冊 |
| synthesis / backfill request | pending | attention | `circle-dashed` | 待處理 |
| synthesis / backfill request | processing | accent | spinner | 處理中 |
| synthesis / backfill request | completed | done | `check` | 已完成 |
| synthesis / backfill request | failed / timed out | danger | `circle-x` | 失敗 |
| synthesis / backfill request | cancelled | neutral | `circle-slash` | 已取消 |
| file change | added / modified / deleted / renamed | success / attention / danger / done | letter badge `A` `M` `D` `R` | — |
| metadata gap | changed-files 缺漏 | attention | `file-question` | 檔案 metadata 缺漏 |
| metadata gap | verification 未回報 | attention | `circle-dashed` | Verification 未回報 |
| metadata gap | verification not_run | neutral | `circle-minus` | 明確未執行 |
| knowledge kind | decision / pattern / gotcha / procedure / skill | accent / done / attention / success / neutral | `scale` / `shapes` / `triangle-alert` / `list-ordered` / `graduation-cap` | 決策 / 模式 / 陷阱 / 流程 / 技能 |
| knowledge status | active / archived | success / neutral | — | 使用中 / 已封存 |

Keep "metadata 缺漏", "verification 尚未回報" and "verification 明確 not_run" visually distinct (attention vs neutral), per README requirement 8.

## Typography

- Font: `-apple-system, "Segoe UI", "Noto Sans TC", "Microsoft JhengHei", "Noto Sans", Helvetica, Arial, sans-serif`
- Mono: `ui-monospace, SFMono-Regular, "SF Mono", Consolas, monospace` — paths, IDs, commands, event types.
- Scale: 12 (meta, Label, Counter, keycap) · 13 (stat label, description, group label) · 14 (body, default) · 16 (dialog title) · 20 (page title, panel title) · 24 (stat value) · 32 (hero number, rare).
- Weights: 400 body, 500 buttons/labels/row titles/active nav, 600 titles. Line-height 1.5.
- No eyebrows (removed in 1.6.36). `--fg-muted` is for meta text and secondary icons.

## Spacing, radius, elevation

- Spacing scale (4px base): 4 · 8 · 12 · 16 · 24 · 32 · 48 · 64.
- Radius, two levels plus two small ones: `--radius` 6px inner (controls, rows, inputs, Flash), `--radius-outer` 10px outer (Box, StatCard, popovers, Dialog), `--radius-sm` 4px (keycaps, meter bars, small chips), `--radius-xs` 2px (heat cells, legend swatches, chart bars), `--radius-pill` for Label/Counter. `--radius-lg` (12px) was replaced by `--radius-outer`.
- Shadow only on floating layers: popover `0 8px 24px rgba(1,4,9,.75)`, SidePanel `-16px 0 48px rgba(1,4,9,.6)`. Cards and Boxes are flat (border, no shadow).
- Control heights: 32px default, 28px small. Nav items 32px.

## Motion

Motion is short and purposeful (the reference is beautifului.dev): quick feedback on hover and press, gentle entrances, fast exits. Tokens in `tokens.css`, keyframes in `base.css`:

| Token | Value | Use |
| --- | --- | --- |
| `--ease-out` | `cubic-bezier(0.23, 1, 0.32, 1)` | Entrances and anything that settles (ease-out quint) |
| `--ease-standard` | `cubic-bezier(0.4, 0, 0.2, 1)` | Exits |
| `--duration-instant` | 120ms | Hover and press color changes |
| `--duration-fast` | 180ms | Menus, exits, chevrons |
| `--duration-base` | 240ms | Dialogs, tab panels, page fade, toasts, tab indicator |
| `--duration-slow` | 360ms | Side panel slide, card entrance |

Page sections already enter once through the shared page fade and the stat cards' `wi-fade-up` (6px, at most 8px); nothing else was added in 1.6.36. Keyframes: `wi-fade-in`, `wi-fade-up` (6px), `wi-pop-in` (scale 0.96), `wi-drop-in` (menus). Rules:

- Entrances animate opacity and at most a few pixels of transform; never animate width, height, top, or left of layout boxes. Anything inside a panel that measures its size on mount (`VirtualList` fit-viewport, tab panels) only fades, so its measurements stay right.
- Exits are faster than entrances; the page transition leaves in 80ms so navigation never feels delayed.
- `prefers-reduced-motion: reduce` turns every animation and transition off globally (`base.css`); do not add motion that bypasses it. Playwright runs with `reducedMotion: "reduce"`.
- Stagger only small, fixed sets (dashboard stat cards, at most 5 steps of 40ms). Do not animate rows of virtualized lists: they remount while scrolling.
- More keyframes in `base.css`: `wi-pop` (UiCounter when its value changes), `wi-progress` (the shell's indeterminate loading bar, shown 150ms late so fast loads never flash it). Shared `<Transition name="fade">` classes are for banners and notices that come and go.
- A theme switch cross-fades colours for one `--duration-base` (`.is-theme-switching` on `<html>`, added by useAppearance); nothing else animates colour globally.

## Breakpoints

`sm 640` · `md 960` · `lg 1280`. Do not introduce others. All routes use the full available main width with the same responsive gutters; do not add route-specific width limits. Reserve stable scrollbar space on the main scroll container.

## Keycap

One global `kbd` rule in `base.css` (12px mono, `--bg-surface`, 1px border with a 2px bottom, `--radius-sm`). Never restyle `kbd` in a component; put one `<kbd>` per key.
