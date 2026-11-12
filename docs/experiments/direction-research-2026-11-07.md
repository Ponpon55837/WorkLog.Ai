# 1.6.8 下一階段方向研究：實際使用資料彙總

研究日期：2026-11-07。目的是用實際資料庫找出最常用、最慢、最常失敗的 Agent 工具與路徑，產出有數據的改進候選。

## 資料來源與方法

- 來源：使用者實際資料庫（repo 的 `data/work-intelligence.sqlite`，依 `apps/mcp/src/database-location.ts` 與 `packages/shared/src/database-path.ts` 判定；環境未設定 `WORK_INTELLIGENCE_DB`，`~/.work-intelligence` 不存在）。
- 取得方式：以 `sqlite3 'file:<path>?mode=ro'` 唯讀開啟，只執行 `VACUUM INTO` 產生副本；之後只查副本，未寫入、未停止服務。研究結束後副本（含 -wal／-shm）已刪除。
- 報告只含數量、比例、耗時彙總；不含任何記錄內容、標題、摘要、路徑或專案名稱。路徑類只以 MCP operation id 或程式碼位置出現。
- 資料量：Session 349 筆（全部 finalized／completed）、Agent 讀取稽核 1,410 筆（2026-10-09 至 2026-11-07，其中 10-09 至 10-11 共 1,183 筆，之後較稀疏）、讀取稽核記錄關聯 2,450 筆、Outstanding item 598 筆、知識 65 筆、搜尋 chunk 3,760 筆。
- 可用訊號與限制：
  - `agent_read_audit` 有 `tool`、`outcome`、`returned_count`、`agent_client`、省略數量，沒有耗時欄位。`outcome` 是依工具分類的結果標籤，只有 `not_found`、`skipped` 代表未取得資料。
  - 非同步請求表（metadata backfill、report synthesis、knowledge candidate）有 `requested_at`、`started_at`、`completed_at`，可算等待與執行時間。
  - 資料庫維護只有 1 次執行紀錄。
  - REST 路由、Web 頁面、MCP 寫入操作沒有任何請求記錄或耗時資料。
  - 驗證的 `verification_json.status` 只記錄 Session 結果，不是工具執行結果。
- 約 4% 讀取來自 smoke／verification client（`codex-live-projection-smoke`、`codex-release-verification`），以下排名的結論不受影響。

## 彙總數據

### Agent 讀取工具使用量（1,410 筆）

| MCP operation                          |   次數 | 占比 | 平均回傳筆數 | 回傳 0 筆比例 | 失敗（not_found／skipped） |
| -------------------------------------- | -----: | ---: | -----------: | ------------: | -------------------------: |
| `work_get_session`                     |    678 | 48.1% |          1.2 |          0.0% |                          0 |
| `work_get_context`                     |    292 | 20.7% |          3.3 |          0.3% |                    1（skipped） |
| `work_get_project_status`              |    199 | 14.1% |            0 |        100.0% |                          0 |
| `work_get_knowledge_page_context`      |    104 |  7.4% |            0 |        100.0% |              6（5.8%） |
| `work_list_outstanding_items`          |     45 |  3.2% |            0 |        100.0% |                          0 |
| `work_search_knowledge`                |     33 |  2.3% |          3.4 |         27.3% |                          0 |
| `work_recall`                          |     31 |  2.2% |          4.7 |          3.2% |                          0 |
| `work_list_sessions`                   |     18 |  1.3% |         26.0 |          0.0% |                          0 |
| 其餘 5 個 operation（合計）            |     10 |  0.7% |            - |             - |                          0 |

`returned_count` 為 0 的工具（status、outstanding、page context）本來就不以筆數表示結果，不代表空結果；只有 `work_search_knowledge` 的 27.3% 是真正的零命中。

### 近期使用（2026-10-23 之後，227 筆）

`work_get_session` 86、`work_get_context` 63、`work_get_project_status` 24、`work_search_knowledge` 15、`work_recall` 14、`work_get_knowledge_page_context` 14，排名與全期一致。

### 重複讀取

| 記錄類型 | 關聯筆數 | 不重複記錄 | 平均每筆被讀次數 |
| -------- | -------: | ---------: | ---------------: |
| session  |    2,123 |        299 |             7.10 |
| knowledge |     327 |         60 |             5.45 |

被讀過的 299 個 Session 中：只讀 1 次 55 個、讀 2 至 4 次 151 個、讀 5 次以上 93 個，最多一筆被讀 148 次。

### 非同步請求（queue 等待與執行，秒）

| 類型                       | 完成／失敗 | 等待平均／最大 | 執行平均／最大 |
| -------------------------- | ---------- | -------------- | -------------- |
| metadata backfill          | 3／1       | 33.1／60.2     | 147.9／210.2   |
| report synthesis           | 5／0       | 100.3／225.7   | 540.0／976.6   |
| knowledge candidate        | 6／0       | 99.4／340.8    | 99.0／164.2    |

metadata backfill 的 1 筆失敗請求已開始但沒有 `completed_at`。

### 其他

- Session 驗證狀態：passed 339、in_progress 7、not_run 3；`changed_files_confirmed` 348／349；無 commit sha 15、無 branch 10、已作廢 9。
- 驗證更新 151 筆（agent 144、web 7），涉及 78 個 Session，平均每個 1.94 次。
- 資料庫維護 1 次，2.2 秒完成（284 Session、62 知識、3,176 chunk、3,016 path）。
- Outstanding item：completed 358、not_needed 222、pending 18。Knowledge candidate：accepted 29、rejected 8。

## 排名

最常用：`work_get_session`（48.1%）、`work_get_context`（20.7%）、`work_get_project_status`（14.1%）；三者合計 82.9%。

最慢：Agent 讀取工具資料不足（沒有耗時欄位）。可觀察的只有非同步工作：report synthesis（執行平均 540 秒、最大 977 秒）最慢，其次 metadata backfill（148 秒）與 knowledge candidate（99 秒）；knowledge candidate 的等待時間最大值（341 秒）超過其執行時間。這些時間包含 Agent 思考，不能直接視為伺服器效能。

最常失敗：未取得資料的比例最高為 `work_get_knowledge_page_context`（6／104，5.8%）；`work_get_context` 1 次 skipped。其餘讀取沒有失敗標籤。非同步請求失敗 1／15（metadata backfill 1／4）。REST 與 Web 失敗率資料不足。

## 改進候選

### C1：Session 詳情重複讀取的輕量路徑

- 數據依據：`work_get_session` 占 48.1%；299 個被讀 Session 平均被讀 7.1 次，93 個讀 5 次以上，最多 148 次。
- 預估效益：以「只回傳自上次讀取後有變化」或精簡預設投影，減少約一半以上的重複 payload；每個 Session 的 `work_summary_json` 最大 3,754 字元、changed files 最大 3,305 字元，重複讀取對 context 用量影響最大。
- 程式位置：`apps/mcp/src/server.ts`（`work_get_session` 約 571 行）、`packages/storage/src/agent-read-audit-service.ts`（可用既有稽核判斷同一 client 近期是否已讀過）。

### C2：把追蹤狀態確認併入 context 回應

- 數據依據：`work_get_project_status` 199 次（14.1%）全為純狀態確認；`work_get_context` 292 次，兩者合計 34.8%，而契約要求兩者擇一用來確認追蹤。
- 預估效益：在 `work_get_context` 已含追蹤狀態時，Agent 契約改為只呼叫其一，可省下最多約 14% 的讀取往返。
- 程式位置：`apps/mcp/src/contracts.ts`（第 9 行契約文字）、`apps/mcp/src/server.ts`（約 539、733 行）。

### C3：知識頁 context 的 not_found 診斷

- 數據依據：`work_get_knowledge_page_context` 104 次中 6 次 not_found（5.8%），為全部讀取工具中唯一有明確失敗標籤者。
- 預估效益：回傳可用頁面識別的提示（相近頁面、是否已刪除），降低 Agent 重試；失敗樣本太少，無法判斷原因分布，需先在稽核加入原因代碼。
- 程式位置：`apps/mcp/src/server.ts`（約 956 行）。
- 狀態：1.6.15 完成。not_found 回傳 `reasonCode`、`existingSlugs` 與 `suggestedSlug`，原因代碼記入讀取稽核的 `errorCode`。

### C4：知識搜尋零命中的後備

- 數據依據：`work_search_knowledge` 33 次中 9 次零命中（27.3%）；對照 `work_recall` 零命中只有 3.2%。
- 預估效益：零命中時自動退回 recall 式檢索或回傳相近詞，預期可把近三成的空結果轉成有用結果；樣本僅 33，需持續觀察。
- 程式位置：`apps/mcp/src/server.ts`（約 873 行）、`packages/storage` 的知識搜尋服務。

### C5：補齊耗時與錯誤代碼訊號（其他候選的前提）

- 數據依據：`agent_read_audit` 沒有耗時與錯誤代碼，無法回答最慢路徑；REST 與 Web 完全沒有請求記錄；非同步請求只有時間戳，失敗只有 1 筆且無法分類。
- 預估效益：在稽核加入 `duration_ms` 與 `error_code`（只存數字與代碼，不存內容），下一輪即可用 p50／p95 排名最慢工具；成本是一個 migration 與每次讀取一次計時。依專案資料規則，新欄位須納入匯出匯入與永久刪除。
- 程式位置：`packages/storage/src/agent-read-audit-service.ts`、`packages/storage/src/schema-migrations.ts`、`apps/mcp/src/server.ts` 的 `registerStoreTool` 包裝。

### C6：Report synthesis 長尾的拆段與進度

- 數據依據：report synthesis 執行平均 540 秒、最大 977 秒，為所有非同步請求中最長；knowledge candidate 等待最大 341 秒。
- 預估效益：依來源 Session 分批、回報進度，減少長時間佔用與使用者等待；樣本只有 5 筆，需先以 C5 的訊號確認瓶頸在伺服器還是 Agent 端。
- 程式位置：report synthesis 與 knowledge candidate 請求的 storage 服務（`packages/storage/src` 內對應 `report_synthesis_requests`、`knowledge_candidate_requests`）。

## 資料不足的題目

- 最慢的 MCP 讀寫操作、REST 路由、Web 頁面：缺耗時與請求記錄，見 C5。
- MCP 寫入操作的使用量與失敗率：只有讀取有稽核；寫入只能從 Session、事件、更新表間接推算，無失敗訊號。
- REST 路由與 Web 頁面的使用量：沒有任何訊號。
