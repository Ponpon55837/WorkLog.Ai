# 專案現況與未結項

目前仍開放的工作，以及最近一次盤點的結果。完成的項目直接從這裡移除；過程細節請看 Git 歷史與 PR。

> 回到 [README](../README.md)

- 最後更新：2026-09-23（CI 上線後）

## 未結項

| 項目 | 狀態 | 說明 |
| --- | --- | --- |
| TypeSafe Adapter（Insight Provider Phase 2） | BLOCKED：等待外部契約 | Provider abstraction、No-op 與 optional injection 已完成，`WorkIntelligenceStore` 預設使用 No-op。開始實作前需要 TypeSafe／產品方先定稿：SDK 或 HTTP endpoint 與版本；backend-only credential 注入、日誌遮罩與資料外送規則；evaluation request／response／error schema（signal、confidence、usage、timeout）；timeout、retry、circuit-breaker 契約；egress guard 的呼叫邊界。這些到位前不新增依賴、網路呼叫、設定開關或假 adapter。 |
| Async path resolver | 刻意延後 | 2026-09-22 以 200 個 changed-file paths 量測，中位數約 205 ms。只有在提高 metadata 上限、加入批次 ingest，或實測到 server／UI 阻塞時，才用真實資料重新量測並評估 async 重構。 |
| Graph 總數計算 | 觀察中 | Graph 會載入所有 tracked Session 來計算節點總數；5,000 筆合成資料約 53 ms，目前不是瓶頸。 |
| 非 tracked 專案的歷史 Session | 待確認行為 | Dashboard 的 `finalizedSessions`、`recentSessions` 與 `/api/sessions` 沒有限制 tracked-only，會包含之後被暫停或忽略的專案的歷史 Session。可能是刻意保留的歷史檢視，尚未決定是否要改。 |

## 最近完成（2026-09-23）

- **資料盤點**：2 個 tracked 專案（DevTools、Assistant）共 62 筆 Session 全部有五段 workSummary。修正 5 筆重複或放錯區段的內容，只重新安排既有句子，沒有加入新內容。報告摘要目前有 3 份現行版本，全部是 `report-synthesis-v3`，每個區塊都有可對應的 `sourceSessionIds`。
- **CI**：Quality（Linux + Windows：build、test、typecheck、coverage）與 E2E（Linux Chromium），每個 PR 與 `main` push 都會執行，目前全綠。第一次執行失敗的兩個原因已修正（PR #4）：workspace 套件透過 `dist/` 互相引用，所以要先 build 再測試；Windows runner 預設 `autocrlf=true` 會讓 Prettier 看到 CRLF，現在以 `.gitattributes` 的 `eol=lf` 統一換行。
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
