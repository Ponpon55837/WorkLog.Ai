# 固定閱讀量 A/B 工具（Issue #440）

設計見 [`2026-11-agent-reading-budget-design.md`](../../decisions/2026-11-agent-reading-budget-design.md) 第 5 節。資料全部是虛構的 Harbor 專案，每個 run 在自己的暫存資料夾建立資料庫與專案，不讀任何真實記錄。

| 檔案 | 用途 |
|---|---|
| `fixture.mjs` | 建立 Harbor 專案（Git、工作前已有的變更）與資料庫內容：3 個未結項、2 個 Knowledge、1 個有 2 筆未複核 Session 的知識頁 |
| `harness.mjs` | `prepare` 建立 run 並啟動 broker；`prompt` 印出 Agent prompt；`check` 依事先定好的條件判定；`stop` 結束 broker |
| `client.mjs` | Agent 唯一的 MCP 連線（tools、resources、read、call），broker 記錄每次呼叫的字元數 |
| `prompts.mjs` | 兩臂逐字相同的 prompt，只有伺服器 instructions 依臂別不同 |

broker 在整個 run 期間保持同一條 MCP stdio 連線，所以伺服器看到的是一段 Agent 對話（開始時間觀察、未回報的 Knowledge 都依此計算）。A5 在 Agent 第一次讀知識頁之後插入另一位寫入者：一筆新完成的 Session 與一次段落更新，讓 Agent 的 reviewToken 過期。A6 擋下所有 resource 讀取，Agent 只看得到 instructions、tools/list 與工具回應。

```bash
node docs/experiments/reading-budget-ab/harness.mjs prepare A1 1 <arm checkout> <new run dir>
node docs/experiments/reading-budget-ab/harness.mjs prompt <run dir>
node docs/experiments/reading-budget-ab/harness.mjs check <run dir>
node docs/experiments/reading-budget-ab/harness.mjs stop <run dir>
```

## 結果檔

- `runs-1.6.78.json`：第一輪，A1 與 A2。A2 在兩臂都沒通過「先確認追蹤再看資料夾」，因此停下。
- `runs-1.6.78-review.json`：複檢輪。A2 以同一個模型比較 instructions 的前後措辭（0/3 → 3/3），並補跑 A3–A6 兩臂各三次；A6 的記錄情境在驗證錯誤改為指出子欄位後再跑三次。

結論與決定見 [`2026-11-agent-reading-budget-ab.md`](../../decisions/2026-11-agent-reading-budget-ab.md)。
