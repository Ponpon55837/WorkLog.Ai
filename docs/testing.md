# 測試與驗證

各層測試指令、覆蓋率門檻與 E2E 範圍。

> 回到 [README](../README.md)

```powershell
pnpm test       # source-only unit/integration tests across policy, schema, storage, server and MCP
pnpm test:coverage # schema/storage coverage with enforced minimum thresholds
pnpm typecheck  # packages + Vue template + E2E test/config types
pnpm build      # all packages + server/mcp + Vite production bundle
pnpm test:e2e   # isolated Playwright browser regression suite
```

`pnpm test:coverage` 使用 V8：schema 的 statements／branches／functions／lines 門檻為 90%，storage handoff parser 的門檻為 85%／70%／90%／85%；coverage 輸出只寫入被 `.gitignore` 排除的 `coverage/` 目錄。

`pnpm test:e2e` 會先建置 production packages，再以獨立的暫存 SQLite、API `3211` 與 Web `5967` 啟動測試服務，不會讀寫目前使用中的 `data/work-intelligence.sqlite` 或 `5966` 開發畫面。若這兩個 port 已被占用，可改用其他 port：

```powershell
$env:WORK_INTELLIGENCE_E2E_WEB_PORT = "5987"; $env:WORK_INTELLIGENCE_E2E_API_PORT = "3231"; npx playwright test
```

E2E 涵蓋：AI 報告整理卡（來源 Session、歷史版本、重新整理）、工作歷程／知識的每頁筆數與 virtual list、Graph 篩選與節點面板、390px 寬度的 Session 面板、640／390px 各頁無水平捲動、直接路由與 `/worklog` 轉址、`?session=` 深連結、切換為記錄中前的同意對話框、Ctrl／⌘ K 指令面板。

設定 `UI_SCREENSHOTS=<label>` 會額外把六頁 × 1440／960／375 的截圖寫到 `docs/ui-baseline/<label>/`（已被 `.gitignore` 排除），方便改版前後比對。

Unit／integration 測試涵蓋：

- unknown/unregistered、paused、ignored 不會建立 session
- tracked 才能讀 source 與 handoff snapshot
- raw handoff、events、changed files、verification 會保存；缺少結構化欄位時會要求 Agent follow-up
- 同一 `idempotencyKey` finalize 不重複寫入
- 兩個 SQLite store connection 同時使用相同 finalize key 仍只保存一筆 Session
- metadata backfill processing timeout recovery、Session metadata／verification transaction 與 MCP payload boundary
- schema 的 changed-files／metadata backfill 陣列上限
- REST 不接受非 JSON Content-Type，malformed JSON 會回傳安全的 4xx 錯誤
- tracked-only context/search 行為
- tracked-only day/week/month/quarter/year 完整報告、上一期比較、趨勢、風險與 source evidence provenance
- changed-file lifecycle history 的新增／修改／刪除／重新命名、路徑正規化、merge dedupe 與 metadata follow-up
- Markdown／JSON 報告匯出與 paused/unregistered project skip
- metadata backfill preview、明確批次更新、duplicate sessionId protection 與 policy skip
- tracked session evidence 的保存、去重、Session Detail／報告呈現與 policy skip
- explicit Knowledge 的 Session provenance、idempotent record、搜尋、context／Session Detail／UI 呈現與 policy skip
- Knowledge update、封存／恢復、預設 active 搜尋與 policy skip
- Knowledge audit history 的 immutable before／after snapshots、changed fields、REST／MCP／UI 與 policy skip
- metadata backfill 的明確 replace／merge 模式、多 stage 路徑 union、provenance dedupe 與 legacy provenance 保留
- tracked-only deterministic graph 的節點／邊、Knowledge／Evidence／changed-file 關聯與 project policy skip
- Graph UI 的 scope filter、節點類型切換、畫面預覽量、資料載入上限、節點／關係統計、可讀預覽與 Session／Knowledge source navigation
- Agent report synthesis request 的建立、bounded context、sourceSessionIds 驗證、摘要回寫、重試 idempotency 與歷史版本保留
- Agent report synthesis request 的逾時回收、舊 Agent 寫入隔離、失敗請求 retry 與 UI 恢復流程
- Reports 的 Evidence 類型／關鍵字篩選只更新證據區塊，不重新渲染整份報告；原始工作紀錄與來源證據提供 10／20／50／100／All 的局部分頁控制
- project root 之外的 source path 會被拒絕
