# UI Redesign Plan（GitHub Dark）

- 狀態：P0–P4 已於 2026-09-23 在 `feat/ui-redesign` 完成（見 §8 實作紀錄）
- 範圍：只改 `apps/web`；後端與 MCP / HTTP API 契約不變
- 視覺參照：[`.agents/skills/worklog-ui/assets/preview.html`](../.agents/skills/worklog-ui/assets/preview.html)（已確認的預覽稿）
- 實作規範：[`.agents/skills/worklog-ui/SKILL.md`](../.agents/skills/worklog-ui/SKILL.md)

## 1. 已確認決策

| 項目 | 決定 |
|---|---|
| 視覺風格 | 深色，參考 GitHub（Primer dark）：Box 列表、Label、UnderlineNav、SegmentedControl |
| 主題 | 只做深色，不做淺色主題與切換 |
| Icon | `lucide-vue-next`，16px，stroke 1.75 |
| 英文 eyebrow | 保留，改為 12px 大寫灰字 |
| 詳情檢視 | 閱讀用右側 SidePanel；表單與確認用置中 Dialog |
| 範圍 | P0–P4 全部 |

## 2. 現況問題（改版動機）

1. `App.vue` 2617 行，承載全部狀態、API 呼叫與 5 個 modal 內容；各 View 以大量 props / emits 接線（ReportsView 約 50 props、30 emits）。
2. 導覽用 `<button @click="changeView">`，篩選不寫 URL，無法分享、重新整理後狀態遺失。
3. `style.css` 1885 行，後段 "Usability refinements" 反覆覆寫前段 token 與字級；斷點分散為 1100 / 960 / 720 / 640 / 480。
4. 字級曾為 8–10px；icon 使用 Unicode 符號；三套不同的篩選控制與兩種日期選擇器。
5. 每頁大型標語 H2 佔據首屏；Dashboard 沒有「待處理事項」。
6. Projects 頁混合 registry、metadata 回補、handoff 匯入。
7. `*Modal.vue` 只是 BaseModal 的空殼；缺 focus trap。

## 3. 資訊架構

```
WORK       總覽 /dashboard · 工作歷程 /sessions（/worklog redirect）· 工作報告 /reports/:tab?
KNOWLEDGE  工作知識 /knowledge · 工作圖譜 /graph
MANAGE     專案 /projects/:tab?（registry | backfill | import）
```

- 篩選、分頁、報告分頁寫入 URL query；`?session=<id>` 在任何頁面開啟 Session 面板。
- Shell：48px AppHeader（logo、麵包屑、Ctrl K 搜尋、Local-first、重新整理）＋ 240px 分組側欄；< 960px 側欄收成 56px icon rail；< 640px 改為抽屜。

## 4. 各頁設計摘要

| 頁面 | 重點 |
|---|---|
| 總覽 | 4 張 StatCard（記錄中專案、本週 Sessions + 7 日 sparkline〔註明不等同 Git commit〕、Verification 四態分布「21 / 24 通過」而非單一百分比、待處理）；「ACTION REQUIRED」Box 列出報告整理請求 / metadata 缺口並附直接操作；最近工作；右欄專案狀態。移除 hero、orbit、靜態 policy 卡 |
| 工作歷程 | 搜尋列（支援 `key:value` qualifier 顯示）；Box header 放「專案 / 驗證 / 日期 / 排序」ActionMenu；依日期分組；列＝驗證 icon + 標題 + Label + meta；SidePanel（唯讀）依序顯示主摘要句、meta、五段 workSummary（第五段標為「狀態／未結項」）、Changed files（A/M/D/R + provenance）、Git（有值才顯示）、Evidence、Knowledge、Events、snapshot；`J`/`K` 切換 |
| 工作報告 | PageHeader 操作列：SegmentedControl（日週月季年）、日期、專案、匯出▾；UnderlineNav 6 分頁附 Counter；總覽頂部 AI synthesis 卡依 `ReportSummary` 欄位呈現（主題／重點成果／驗證／比較／風險與限制／決策／狀態／未結項），每個區塊附來源 Session chip；前期比較 ▲▼ 只用 deterministic 報表資料 |
| 工作知識 | ≥ 960px 左側 facet 篩選欄；Box 列表；每筆 `…` 選單（編輯 / 變更紀錄 / 封存 / 來源 Session） |
| 工作圖譜 | 全寬畫布、浮動工具列、一行統計兼圖例、節點用 non-modal 固定面板 |
| 專案 | UnderlineNav：專案清單（Box 表格 + 加入專案 Dialog）／Metadata 回補／Handoff 匯入；policy 說明為可關閉 Flash；切換為「記錄中」前以 Dialog 說明將允許讀取的範圍 |

## 4.1 資料語意對 UI 的約束

依據 [`docs/work-record-and-report-format.md`](work-record-and-report-format.md) 與 [`.agents/skills/work-intelligence`](../.agents/skills/work-intelligence/SKILL.md)，UI 不得模糊以下區分（細節見 skill 的 `references/domain-semantics.md`）：

1. `nextSteps` 一律標示「狀態／未結項」，只呈現現況限制與未結項，不做成「後續建議」或行動按鈕。
2. `executionStatus: completed` 只代表 finalize 完成，用中性 Label，不用綠色。
3. Verification 四態分開呈現：通過、失敗、明確未執行（`not_run`）、未回報（歷史 `not_supplied`）；Dashboard 不用單一通過率百分比。
4. Changed files 不等於 Git commit；Git 欄位獨立一區，有值才顯示。provenance 空值顯示「未提供來源」。
5. Evidence、Knowledge 與五段摘要分開呈現；主摘要與 workSummary 在 UI 唯讀，修正由 Agent 就地更新同一 Session。
6. 報表數字（指標、趨勢、比較）只取 deterministic 報表資料；AI synthesis 每個區塊顯示來源 Session，`資料不足` 與截斷提示正常呈現、不當錯誤。
7. Metadata 缺口三類分開：changed-files 缺漏、verification 未回報、verification 明確 not_run。
8. 給使用者複製的 Agent 指令只用自然語言，不含 MCP tool 名稱、request ID 或 JSON。

## 5. 目標程式架構

```
apps/web/src/
├─ App.vue                 # <AppShell><RouterView/></AppShell>
├─ router.ts               # meta: { title, eyebrow, group, icon }
├─ styles/tokens.css, base.css
├─ components/ui/          # 通用元件（見 skill references/components.md）
├─ components/layout/      # AppShell, AppHeader, AppSidebar, PageHeader
├─ components/domain/      # SessionRow, SessionPanel, SynthesisCard, KnowledgeRow ...
├─ composables/            # useSessions, useReports, useReportSynthesis, useKnowledge,
│                          # useGraph, useProjects, useMetadataBackfill, useHandoffImport,
│                          # useRouteQuery, useToast, useConfirm, useFocusTrap, useHotkeys
├─ utils/format.ts, labels.ts
└─ views/
```

共用狀態使用 provide/inject 或 composable singleton，不引入 Pinia。

## 6. 分階段執行

| 階段 | 內容 | 驗收 |
|---|---|---|
| P0 保護網 | Playwright 為 6 頁 × 1440 / 960 / 375 截 baseline（`docs/ui-baseline/`）；e2e 中 37 個 class `locator` 改為 `getByRole` / `getByLabel` / `data-testid` | e2e 全過 |
| P1 架構拆解（畫面不變） | App.vue 拆 composables、View 自取資料、`RouterLink`、route meta、`useRouteQuery`、`/sessions` + redirect | 截圖與 baseline 一致；e2e、typecheck、build 通過；App.vue < 150 行 |
| P2 設計系統 | 加 `lucide-vue-next`；tokens / base / `components/ui`；AppShell 上線；dev-only `/__ui` 元件展示頁 | 元件所有狀態可見；鍵盤可操作；Dialog / SidePanel focus trap 正確 |
| P3 逐頁遷移 | Sessions → Dashboard → Projects → Knowledge → Reports → Graph，每頁一個 PR，遷完刪該頁舊 CSS | 三種寬度無破版、無水平捲動；e2e 通過；PR 附前後截圖 |
| P4 收尾 | 刪殘留 CSS 與空殼 modal；Ctrl K 指令面板與快捷鍵；a11y 檢查 | `style.css` 移除或 < 150 行；axe 零 critical |

每階段執行：`pnpm --filter @work-intelligence/web typecheck`、`pnpm --filter @work-intelligence/web build`、`pnpm test:e2e`。

## 7. 風險與對策

- P1 狀態交錯：按領域一次抽一個 composable，每次跑 e2e。
- 視覺回歸：PR 一律附 baseline 對照。
- `J`/`K` 快捷鍵只在面板開啟且焦點不在輸入框時生效。
- Dashboard 只讀既有 request 狀態，不自動觸發 metadata 掃描。
- 不新增後端端點；缺資料的區塊直接隱藏。

## 8. 實作紀錄與差異

| 階段 | 結果 |
|---|---|
| P0 | e2e 改用 role／label／data-testid 與版面不變量；`UI_SCREENSHOTS=<label>` 截圖到 `docs/ui-baseline/<label>`（本機產生、不進版控） |
| P1 | App.vue 由 2617 行拆成 domain composables；截圖與 baseline 差異 ≤ 0.1% |
| P2 | tokens／base、lucide、`components/ui`、`components/layout`、`/__ui` 展示頁 |
| P3 | 六頁全部改寫；移除 `style.css` 與 BaseModal 系列 |
| P4 | 移除死碼、label 統一來源、axe 對比修正、指令面板與快捷鍵、新增 e2e（deep link、tracking 同意、指令面板）、新增 code-style skill |

與原規劃的刻意差異：

1. **篩選只提供 API 支援的條件**：Sessions 沒有「驗證」與「排序」篩選（後端不支援，不新增端點）；Knowledge 改用 Box header 的 ActionMenu，而非左側 facet 欄（API 不提供各類別數量）。
2. **Tooltip 使用原生 `title`**，未另做 UiTooltip 元件。
3. **Dashboard 待處理清單**只讀取既有的 report synthesis／metadata backfill request；同一報告範圍只看最新一筆，避免已被後續完成的失敗請求重複出現。
4. **報告時區**沿用後端 UTC，頁首明確標示「（UTC）」。
5. **捲動**：搜尋列與分頁標籤放在 `PageToolbar`，捲動時固定在內容頂端；清單的 Box header 固定在其下方。換頁（分頁按鈕）時捲回清單頂端，切換頁面或分頁標籤時回到頁首。
