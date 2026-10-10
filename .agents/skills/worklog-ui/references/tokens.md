# Design tokens

All values live in `apps/web/src/styles/tokens.css`. Components reference tokens only.

## Color

Two sets share the same token names: GitHub dark on `:root` (the default) and a softened light set on `:root[data-theme="light"]`. Light surfaces are cool grey (the page is ~87% luminance) because pure white was too glaring; text colours are darkened so 12px Label text on its 10% tint still reaches 4.5:1 on every light surface.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg-canvas` | `#0d1117` | `#eef0f3` | Page background, Box body, SidePanel |
| `--bg-inset` | `#010409` | `#e6e9ed` | AppHeader, sidebar, text inputs, command blocks |
| `--bg-subtle` | `#161b22` | `#e6e9ed` | Box header/footer, StatCard, popovers, Dialog |
| `--bg-hover` | `#1c2128` | `#e2e5ea` | Row / nav hover |
| `--bg-muted` | `#21262d` | `#e2e5ea` | Default button, active nav item, SegmentedControl track |
| `--border` | `#30363d` | `#c9d0d8` | Box / input / button borders |
| `--border-muted` | `#21262d` | `#d6dbe1` | Row dividers, header bottom borders |
| `--fg` | `#e6edf3` | `#24292f` | Primary text |
| `--fg-muted` | `#9198a1` | `#4f5862` | Meta text, eyebrows, secondary icons |
| `--fg-subtle` | `#6e7681` | `#58616b` | Placeholders, sidebar group labels, empty dashes |
| `--accent` | `#4493f8` | `#0754ae` | Links, focus ring, selected state, primary data series |
| `--accent-emphasis` | `#1f6feb` | `#0969da` | Input focus border |
| `--success` | `#3fb950` | `#16652a` | Passed, tracked, positive delta |
| `--success-emphasis` | `#238636` | `#1f883d` | Primary button background (hover retains dark `#238636` / light `#1c8139`; stronger border marks hover so white text stays AA) |
| `--attention` | `#d29922` | `#744c00` | Missing / pending / paused |
| `--danger` | `#f85149` | `#a91b26` | Failed, errors, negative delta, destructive actions |
| `--done` | `#a371f7` | `#6235b8` | AI synthesis, completed synthesis, Knowledge accents |
| UnderlineNav active bar | `#f78166` | `#fd8c73` | Only for the selected UnderlineNav tab |

Label recipe (GitHub style): text = color token, border = color at 40% alpha, background = color at 10% alpha. Neutral Label: `--fg-muted` text, `--border` border, transparent background.

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
- Scale: 12 (meta, eyebrow, Label, Counter) · 14 (body, default) · 16 (section title, page title) · 20 (panel title) · 24 (stat value) · 32 (hero number, rare).
- Weights: 400 body, 500 buttons/labels, 600 titles. Line-height 1.5.
- Eyebrow: 12px (11px inside Box headers / sidebar groups is the only exception), 600, uppercase, `letter-spacing: .08em`, `--fg-muted`.

## Spacing, radius, elevation

- Spacing scale (4px base): 4 · 8 · 12 · 16 · 24 · 32 · 48 · 64.
- Radius: 6px everywhere; 12px for popovers/Dialog; 999px for Label/Counter.
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

Keyframes: `wi-fade-in`, `wi-fade-up` (6px), `wi-pop-in` (scale 0.96), `wi-drop-in` (menus). Rules:

- Entrances animate opacity and at most a few pixels of transform; never animate width, height, top, or left of layout boxes. Anything inside a panel that measures its size on mount (`VirtualList` fit-viewport, tab panels) only fades, so its measurements stay right.
- Exits are faster than entrances; the page transition leaves in 80ms so navigation never feels delayed.
- `prefers-reduced-motion: reduce` turns every animation and transition off globally (`base.css`); do not add motion that bypasses it. Playwright runs with `reducedMotion: "reduce"`.
- Stagger only small, fixed sets (dashboard stat cards, at most 5 steps of 40ms). Do not animate rows of virtualized lists: they remount while scrolling.
- More keyframes in `base.css`: `wi-pop` (UiCounter when its value changes), `wi-grow-y` (sidebar active indicator), `wi-progress` (the shell's indeterminate loading bar, shown 150ms late so fast loads never flash it). Shared `<Transition name="fade">` classes are for banners and notices that come and go.
- A theme switch cross-fades colours for one `--duration-base` (`.is-theme-switching` on `<html>`, added by useAppearance); nothing else animates colour globally.

## Breakpoints

`sm 640` · `md 960` · `lg 1280`. Do not introduce others. Content max width 1280px (Graph page is full width).
