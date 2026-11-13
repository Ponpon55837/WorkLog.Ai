# Outstanding items probe

唯讀量測腳本：`docs/experiments/outstanding-items-probe.mjs`。用來量化待辦（outstanding items）的關閉、改寫、完成與漏標行為，作為「改寫配對修正」部署前後的對照基準。腳本不寫入資料庫、不呼叫模型、不連網。

## 執行

```bash
pnpm build            # 需要 packages/storage/dist（改寫配對器）；缺少時改寫相關數字為 null
node docs/experiments/outstanding-items-probe.mjs --db <path> [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--split YYYY-MM-DD] [--now <ISO>]
node docs/experiments/outstanding-items-probe.mjs --self-check
```

- 以 `new DatabaseSync(path, { readOnly: true })` 開啟，stdout 只輸出一個 JSON 物件。
- `--since` / `--until`：以待辦的 `created_at` 篩選（含當日，UTC）。
- `--split`：每個指標輸出兩次，`split.before`（建立時間早於該日 00:00Z）與 `split.onOrAfter`。未指定時輸出 `metrics`。
- `--now`：計算待辦年齡的基準時間；預設為資料庫內最大時間戳，結果可重現。
- `--self-check`：在暫存資料夾以 `WorkIntelligenceStore` 建立虛構資料庫，斷言數字、斷言輸出不含任何虛構文字／id／路徑／專案名，並以約 2 萬筆待辦量測耗時（只寫 stderr）。
- 較舊的資料庫缺少 cleanup 表時，該區塊為 `null`；缺少 `outstanding_items` 或 `sessions` 則回報 `E_SCHEMA`。

## 隱私保證

輸出只有計數、比例、中位數、百分位數與直方圖桶。不會輸出任何待辦文字、Session 標題、id、路徑或專案名稱；暫時性用語的正規表示式只做分類，不輸出命中內容。錯誤只輸出代碼（`E_USAGE`、`E_DB_NOT_FOUND`、`E_DB_OPEN`、`E_SCHEMA`、`E_QUERY`、`E_INTERNAL`），不轉述 SQLite 訊息。

## 輸出欄位

頂層：`meta`、`metrics`（或 `split`）、`cleanup`。每組 metrics 含：

| 鍵 | 意義 |
|---|---|
| `totals` | 待辦數、有待辦的 Session 數、每 Session 待辦數（median／p90／max）、各狀態數 |
| `notNeeded` | `not_needed` 依關閉事件來源（agent／web／migration／none）；`selfClosed` = 最近一次 pending→not_needed 的 actor 就是來源 Session；建立到關閉的小時數（median／p90、1h／24h 內比例），分「全部」與「自關」 |
| `rewording` | 見下 |
| `transientWording` | 六類進行中狀態用語（uncommitted、not_pushed、pr_pending、ci_running、waiting_subagent、phase_not_started）× 最終狀態與自關比例；`anyTransient` 為任一類。正規表示式在腳本頂端 `TRANSIENT_CATEGORIES`，可審查調整 |
| `completion` | 完成數依來源；agent 完成拆為同 Session／後續 Session；各來源建立→完成天數；web 完成集中度（不同日數、單日最大、前 3 日占比） |
| `missedOpportunities` | web 完成的待辦中，在建立後、web 完成前有後續非作廢同專案 Session：(a) 與來源 Session 連結（任一方向）`laterSessionLinked`，(b) 共用至少一個 changed file `laterSessionSharesChangedFile`，(a 或 b) `either`。共用檔案不排除 lockfile、CHANGELOG 等常見檔，(b) 偏寬 |
| `continuedReplay` | 重播 finalize receipt 的 `continuedOutstandingItems`（同專案、與新 Session 連結的 Session 的 pending 待辦，依 source_session_id、position、id 排序，最多列 10 筆）。對每個 web 完成的待辦，檢查是否存在後續連結（任一方向）、同專案、非作廢的 Session N，其 `completed_at` 落在 [待辦建立, web 完成) 且當時待辦仍 pending，並模擬 N 的清單排序：`webCompleted`、`surfacedInContinued`（至少一次排在前 10）、`surfacedButBeyondCap`（曾 pending 但都排在 10 之後）、`notLinked`（沒有符合的後續連結 Session）、`surfacedShare`、`cap`。沒有 `session_links` 表時其餘為 null |
| `relatedReplay` | 重播 finalize receipt 的 `relatedOutstandingItems`（前 5 筆），對象是 `continuedReplay` 沒列出的 web 完成待辦。對每個非作廢 Session S（`completed_at` 落在 [待辦建立, web 完成)），依儲存層邏輯計算：焦點 = `標題 + 摘要`（前 2000 字）的詞、S 的 changed files（以 S 專案正規化，最多 20 個）；候選 = 當時仍 pending、同專案、來源 Session 非作廢且不是 S、不在 S 的 continued 清單、依來源 Session 新到舊最多 2000 筆；以 dist 的 `rankRelatedPendingWithin` 排名取前 5。每個 Session 只在落入某個視窗時才排名一次（快取）。鍵：`candidatesNotContinued`、`surfacedInRelated`、`notSurfaced`、`combinedSurfaced`（continued 或 related）、`combinedSurfacedShare`（占 webCompleted）、`sessionsRankedSoFar`。需要 `dist/outstanding-item-relevance.js`、`search-text.js`、`applies-to-match.js`，缺少時 `available: false` 且數字為 null。標題／摘要／專案根目錄只在記憶體中使用，不輸出。約 2 萬筆待辦的合成集耗時約 2 秒 |
| `agentPostFinalize` | actor 不是來源 Session 的 agent 完成／不需要事件：事件時間晚於 actor Session 完成時間（`postFinalize`，即 `work_resolve_outstanding_items` 路徑）、同一時刻（`sameInstantAsFinalize`，finalize 清單）、更早、actor 未知 |
| `currentPending` | 目前 pending 數、最老年齡（天）、年齡桶 `<1d`／`1–7d`／`7–30d`／`>30d` |

`cleanup`（不隨 `--split` 切分）：五張 cleanup 表的列數、requests 依狀態、proposals 依 review_status；表不存在為 `null`。

### rewording（修正的關鍵指標）

舊行為下，Agent 改寫待辦文字會讓舊項目 pending→not_needed，並在同一時刻（同一次同步）建立新項目。腳本對每個自關項目，找同一來源 Session、`created_at` 與關閉事件完全相同的新項目，用 `pairRewordedItems`（閾值 0 取得最佳一對一配對，再以 `REWORD_SIMILARITY_THRESHOLD` 判斷）估計新配對器會保留多少：

- `selfClosed`：自關項目數。
- `withSameInstantReplacement`：有同刻替代項目者；`pureRemoval`：沒有替代（純刪除）。
- `keptByMatcher`：相似度達閾值，新配對器會保留身分（不再產生關閉＋建立事件）；`wouldNotBeKept`、`withReplacementUnpaired`、`skippedOverPairLimit`（單次同步配對量超過 2,500）。
- `similarityHistogram`：配對相似度，每 0.1 一桶。
- `closeCreateBursts`：同 Session 同一時刻同時有自關與新建的次數；`syncInstants`：actor 為來源 Session 的不同事件時刻數；`burstsPerSyncInstant`、`burstsPerSummaryUpdate`（分母為 `session_work_summary_updates` 列數）。部署修正後，改寫不再產生事件，這些 burst 比例應下降，部署前後可直接比較。

## 基準與部署後

（待填）

### Baseline（部署前）

- 資料庫快照日期／`--split` 日期：
- 指令：
- 重點數字（selfClosed、withSameInstantReplacement、keptByMatcher、burstsPerSyncInstant、anyTransient.selfClosedShare、missedOpportunities.either / webCompleted、agentPostFinalize.postFinalize）：

### After（部署後）

- 指令：
- 重點數字：
- 結論：
