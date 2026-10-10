# Mermaid 移除方案

日期：2026-10-10。狀態：**規劃已完成，尚未實作移除**。後續由五項功能與總覽活動熱度首屏均合併後的 main 開始，每階段獨立 worktree／PR；最新 head 三平台 Quality 與三瀏覽器 E2E 全綠後才合併。

## 目標與歷史資料

移除 Web Mermaid 執行期、渲染器與相依套件，新工作記錄只使用已驗證的 architecture v1 JSON。歷史 Mermaid 保留原 kind、formatVersion、source、title、id、Session 引用、作廢狀態與稽核；改為安全的原始碼閱讀／複製／下載，匯出再匯入仍可還原相同資料。

本次唯讀盤點覆蓋專案 215 筆未作廢工作記錄，找到 24 張有效 Mermaid 與 6 張有效 architecture；這是當次快照，後續新階段圖表另計。已作廢 Session、備份與其他專案不在此 active 統計範圍；實作前重新盤點並分別驗證資料保留，不列出私人工作內容。

architecture v1 支援卡片、平面群組、來源、直接關係與作者路徑，不能宣稱可無損表示任意 sequence／state／class／gantt 圖。不批次自動轉換；缺少來源證據的歷史圖表保留原始碼。若需要額外語意，另做格式與原生閱讀器技術驗證。

## 需修改的位置

| 範圍 | 已確認現況 | 移除方向 |
| --- | --- | --- |
| 相依性 | apps/web/package.json 固定 mermaid 11.17.2；pnpm-workspace.yaml 固定 mermaid>katex 0.18.2 | 移除 mermaid；核對其他消費者後移除 override，重新生成 lockfile |
| 閱讀器 | apps/web/src/components/domain/SessionDiagram.vue 分派 MermaidDiagram／ArchitectureDiagram，已有 source 回退 | 保留原生 architecture；legacy Mermaid 走純文字來源介面 |
| 渲染工具 | MermaidDiagram.vue、utils/mermaid.ts、utils/mermaid-loader.ts，後者動態 import | 刪除渲染路徑，量測延遲 chunk 成本，不能誤稱主程式成本 |
| 寫入契約 | packages/core/src/index.ts、packages/schema/src/index.ts、packages/storage/src/diagram-service.ts 缺省 kind 仍是 mermaid | 分離新寫入和歷史／portable import schema，新寫入顯式 architecture v1 |
| 儲存生命週期 | session_diagrams、歷史 migrations 19／27、export/import、永久刪除、敏感資料遮蔽 | 保留歷史讀取與 round-trip；不改寫已發布 migration |
| Agent 契約 | apps/mcp 的 operation contracts／agent resources、工作記錄格式與 work-intelligence skill | 移除新作圖的 Mermaid 指示與缺省值；契約更新要求重新連線 |
| 驗證與探測 | Mermaid unit／CSP E2E、KaTeX security、scripts/archify-probe.mjs、test:archify-probe | 以 legacy source 與原生 JSON 驗收取代渲染專用測試；保留歷史探測證據 |

實作時先用 rg 與 pnpm why mermaid／katex 核對完整依賴圖，不能只刪 package.json 的單一項目。

## M1：固定寫入與相容契約

1. 新建圖表限制為顯式 architecture v1，驗證節點、連線、來源相對路徑與所有 ID 引用。沒有必要圖表可省略，不捏造架構。
2. 新寫入 schema 與歷史 record／匯入 schema 分離；舊 Mermaid 仍可讀、匯出／匯入、作廢／復原與刪除。
3. 核對 finalize diagrams、attach diagram、REST／MCP dispatcher、冪等重送及直接 storage 寫入。契約改變後舊 MCP 必須重新連線，不能把 Mermaid source 靜默解讀為 architecture。
4. 以舊 writer 與真實 schema 實測決定是否需要新增 migration／儲存層保護；需要時新增向前 migration，不改歷史 SQL。不假定刪除 union 值即可安全升級。
5. 同時更新完整 operation contracts、工作記錄格式與技能範例。

驗收：合法 architecture 建立及重送成功；新 Mermaid／缺少 kind／錯誤版本明確拒絕；legacy portable round-trip 保留全部欄位；舊 schema、備份與契約連線有回歸證據。

## M2：移除 Web 執行期與套件

1. 先補 legacy source 的繁中／英文、明暗、展開閱讀、可選文字、複製／下載與返回來源；保留網址中圖表選取及作廢操作。
2. source 以 Vue 純文字綁定呈現，不用 v-html，不執行圖表語法或任意 HTML；維持嚴格 CSP、同來源 API 與 project policy。
3. 刪除 MermaidDiagram、loader、renderer util、套件與無其他消費者的 KaTeX override／專用測試／probe 命令。
4. 以相同 Node／build 設定記錄移除前後 dist 原始／gzip 大小、延遲 chunk、首次開圖耗時與網路請求。尚無移除後數據，不先宣稱節省幅度。

驗收：依賴圖與 production build 無 Mermaid 執行依賴，實際頁面不下載 Mermaid／KaTeX 圖表資產；歷史來源保留，architecture 卡片與 strict CSP 正常。

## M3：可選的歷史圖表整理

只有使用者選定且語意適合的圖表，才逐張核對原工作來源，建立新的 architecture 快照。保留原 Mermaid，不覆蓋／刪除，不宣稱自動無損轉換。另以工作記錄列出選取範圍及人工核對結果。

這不是移除執行期的前置條件；歷史 Mermaid 可以保留為純文字證據。

## M4：文件、驗證、部署與清理

- 對齊 README、架構格式、REST／MCP、技能、UI 能力與開發狀態。CHANGELOG、舊研究與發布紀錄保留當時事實，另加日期及新決策。
- 執行 build、unit／coverage、lint／format、typecheck、performance／retrieval／response-size、production dependency audit，維持既有門檻。
- Chromium／Firefox／WebKit 覆蓋原生 architecture、legacy source、網址恢復、複製失敗、作廢／復原、keyboard、axe、zh-TW／en-US、明暗與 1440／960／375px。
- 生命週期覆蓋 tracked policy、portable export/import、舊 schema／備份、來源／ID／稽核、永久刪除與遮蔽。新增持久欄位時同步 registry、counts 與 portable validation。
- 比對 migration 前備份和升級後圖表筆數／核心欄位；有差異先查明，不用刪資料讓測試過關。
- 最新 head 四項 CI 全綠後合併，更新 main；以可恢復快照封存完成 worktree，刪除已合併本機／遠端分支。
- 部署前備份；主安裝 build、health／HTTP、schema／build identity 與 MCP 重新連線各以實際證據確認。舊版可能無法讀新 schema，不承諾直接 checkout 回滾；必要時配合相容版本及升級前備份復原。

## 開始與完成條件

本文件只交付規劃，後續需新的實作指示才執行移除。完成代表新寫入只接受經驗證的原生格式、Web 無 Mermaid runtime／相依、歷史來源和生命週期不丟失、文件契約一致，且最新 head 四項 CI 通過、部署與剩餘證據缺口如實記錄。

實機 Safari／觸控及大量歷史資料性能須另驗收；Playwright WebKit 不能替代實機證據。
