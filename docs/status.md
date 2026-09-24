# 專案現況與未結項

目前仍開放的工作，以及最近一次盤點的結果。完成的項目直接從這裡移除；過程細節請看 Git 歷史與 PR。

> 回到 [README](../README.md)

- 最後更新：2026-09-24

## 未結項

| 項目 | 狀態 | 說明 |
| --- | --- | --- |
| TypeSafe Adapter（Insight Provider Phase 2） | BLOCKED：等待外部契約 | Provider abstraction、No-op 與 optional injection 已完成，`WorkIntelligenceStore` 預設使用 No-op。開始實作前需要 TypeSafe／產品方先定稿：SDK 或 HTTP endpoint 與版本；backend-only credential 注入、日誌遮罩與資料外送規則；evaluation request／response／error schema（signal、confidence、usage、timeout）；timeout、retry、circuit-breaker 契約；egress guard 的呼叫邊界。這些到位前不新增依賴、網路呼叫、設定開關或假 adapter。 |
| Async path resolver | 刻意延後 | 2026-09-22 以 200 個 changed-file paths 量測，中位數約 205 ms。只有在提高 metadata 上限、加入批次 ingest，或實測到 server／UI 阻塞時，才用真實資料重新量測並評估 async 重構。 |
| Graph 總數計算 | 觀察中 | Graph 會載入所有 tracked Session 來計算節點總數；5,000 筆合成資料約 53 ms，目前不是瓶頸。 |

## 最近完成（2026-09-23～24）

- **報告日期改用系統時區**（PR #10）：報告、趨勢與工作歷程日期篩選改依 server 所在系統時區計算，報告回傳 `timezone`，報告頁頁首顯示時區名稱。另外修正搜尋把 `%`、`_` 當萬用字元的問題，API 拒絕非 loopback 的 `Host`（防 DNS rebinding），Prettier 改為檢查全專案。
- **MCP 補強**：新增 `work_get_project_status`（唯讀記錄狀態）、`work_list_sessions`、`work_get_session`、`work_request_report_synthesis`、`work_request_metadata_backfill`；`work_get_context` 多回傳 `pendingRequests`。所有工具加上 MCP annotations，新增 `finalize-work`／`synthesize-report` prompts。Server instructions 精簡為路由規則（原本會被用戶端截斷），三份 contract 只附在負責寫入的工具上。

- **只顯示 tracked 專案的 Session**：Dashboard 的 Session／事件計數、最近完成的工作與工作歷程列表（`/api/sessions`）都排除已暫停、忽略的專案；資料仍保留在 SQLite，恢復記錄中後會再出現。這也修正了列表會列出、但點進去詳情卻 404 的不一致。
- **圖譜節點面板改為覆蓋**：面板覆蓋在圖譜右側，不再把圖譜往左推，欄寬維持不變；畫布右側多出可捲動空間，選取的節點會自動捲到面板左側。
- **資料盤點**：2 個 tracked 專案（DevTools、Assistant）共 62 筆 Session 全部有五段 workSummary。修正 5 筆重複或放錯區段的內容，只重新安排既有句子，沒有加入新內容。報告摘要目前有 3 份現行版本，全部是 `report-synthesis-v3`，每個區塊都有可對應的 `sourceSessionIds`。
- **CI**：Quality（Linux + Windows：build、test、typecheck、coverage）與 E2E（Linux Chromium），每個 PR 與 `main` push 都會執行，目前全綠。第一次執行失敗的兩個原因已修正（PR #4）：workspace 套件透過 `dist/` 互相引用，所以要先 build 再測試；Windows runner 預設 `autocrlf=true` 會讓 Prettier 看到 CRLF，現在以 `.gitattributes` 的 `eol=lf` 統一換行。使用的 Actions 已升到 Node 24 版本（`checkout` v7、`setup-node` v7、`pnpm/action-setup` v6、`upload-artifact` v7），不再出現 Node 20 過時警告。
- **工作圖譜改版**（PR #6）：分層排版讓知識、證據、檔案排在所屬 Session 旁邊，連線改為曲線；選取節點時淡化無關節點並自動捲到該節點；新增節點搜尋（`?q=`，Enter 選取第一筆）；欄寬隨容器調整；檔案節點改顯示檔名與目錄，Session 副標題改用 verification 中文標籤。
- **右側面板加大且可調整寬度**（PR #6）：Session 760、Knowledge 變更紀錄 640、圖譜節點 460px；拖曳左緣或用方向鍵調整，寬度依面板各自記住。
- **Storage 讀取效能**：新增 `completed_at` 全域索引與近期決策 partial index；日期條件改為可使用索引的寫法；報告與提煉的 IN 列表查詢固定 join 順序；metadata 預覽先在 SQL 預篩。以 5,000 筆合成資料量測（`packages/storage/bench/read-paths.bench.mjs`，見 [testing.md](testing.md)）：

  | 讀取路徑 | 修改前 | 修改後 |
  | --- | ---: | ---: |
  | Session 列表 | 9.6 ms | 0.6 ms |
  | Dashboard | 7.4 ms | 0.1 ms |
  | 週報 | 20.1 ms | 3.9 ms |
  | 年報 | 30.4 ms | 16.7 ms |
  | Agent context | 84.1 ms | 29.8 ms |
  | metadata 預覽 | 58.0 ms | 17.6 ms |

## 已完成、不要再列為待辦

UI 改版 P0–P4（六頁、共用 UI、App.vue 拆解、a11y、Ctrl／⌘ K）；集中 API client 與 AbortController；`store.ts` 拆出 repository；ESLint／Prettier；coverage 門檻（schema、storage handoff parser）；Graph server-side cursor 與 viewport culling；列表 virtual list；Provider + No-op；跨行程 idempotency 與 migration 交易保護；Content-Type 與 payload 上限；symlink real-path 二次檢查；`commit_required` 移除；handoff parser 單元測試與輸出邊界。
