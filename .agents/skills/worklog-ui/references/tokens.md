# Design tokens

All values live in `apps/web/src/styles/tokens.css`. Components reference tokens only.

## Color

| Token | Value | Use |
|---|---|---|
| `--bg-canvas` | `#0d1117` | Page background, Box body, SidePanel |
| `--bg-inset` | `#010409` | AppHeader, sidebar, text inputs, command blocks |
| `--bg-subtle` | `#161b22` | Box header/footer, StatCard, popovers, Dialog |
| `--bg-hover` | `#1c2128` | Row / nav hover |
| `--bg-muted` | `#21262d` | Default button, active nav item, SegmentedControl track |
| `--border` | `#30363d` | Box / input / button borders |
| `--border-muted` | `#21262d` | Row dividers, header bottom borders |
| `--fg` | `#e6edf3` | Primary text |
| `--fg-muted` | `#9198a1` | Meta text, eyebrows, secondary icons |
| `--fg-subtle` | `#6e7681` | Placeholders, sidebar group labels, empty dashes |
| `--accent` | `#4493f8` | Links, focus ring, selected state, primary data series |
| `--accent-emphasis` | `#1f6feb` | Input focus border |
| `--success` | `#3fb950` | Passed, tracked, positive delta |
| `--success-emphasis` | `#238636` | Primary button background (hover `#2ea043`) |
| `--attention` | `#d29922` | Missing / pending / paused |
| `--danger` | `#f85149` | Failed, errors, negative delta, destructive actions |
| `--done` | `#a371f7` | AI synthesis, completed synthesis, Knowledge accents |
| UnderlineNav active bar | `#f78166` | Only for the selected UnderlineNav tab |

Label recipe (GitHub style): text = color token, border = color at 40% alpha, background = color at 10% alpha. Neutral Label: `--fg-muted` text, `--border` border, transparent background.

Counter: `rgba(110,118,129,.4)` background, 12px, pill; attention variant `rgba(187,128,9,.4)`.

## Status mapping

Use these everywhere (lists, panels, dashboard, reports). Implement once in `utils/labels.ts` + `StatusLabel`.

| Domain | Value | Tone | Lucide icon | 顯示文字 |
|---|---|---|---|---|
| verification | `passed` | success | `circle-check` | 通過 |
| verification | `failed` | danger | `circle-x` | 失敗 |
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
- Scale: 12 (meta, eyebrow, Label, Counter) · 14 (body, default) · 16 (section title) · 20 (page title, panel title) · 24 (stat value) · 32 (hero number, rare).
- Weights: 400 body, 500 buttons/labels, 600 titles. Line-height 1.5.
- Eyebrow: 12px (11px inside Box headers / sidebar groups is the only exception), 600, uppercase, `letter-spacing: .08em`, `--fg-muted`.

## Spacing, radius, elevation

- Spacing scale (4px base): 4 · 8 · 12 · 16 · 24 · 32 · 48 · 64.
- Radius: 6px everywhere; 12px for popovers/Dialog; 999px for Label/Counter.
- Shadow only on floating layers: popover `0 8px 24px rgba(1,4,9,.75)`, SidePanel `-16px 0 48px rgba(1,4,9,.6)`. Cards and Boxes are flat (border, no shadow).
- Control heights: 32px default, 28px small. Nav items 32px.

## Breakpoints

`sm 640` · `md 960` · `lg 1280`. Do not introduce others. Content max width 1280px (Graph page is full width).
