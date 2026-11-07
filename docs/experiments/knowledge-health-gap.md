# Knowledge Health 唯讀缺口量測

日期：2026-11-07。性質：研究，不改正式流程（無 migration、MCP、finalize、產品端 LLM 變更）。資料：全部為合成資料，未接觸 `data/`、根目錄 SQLite、使用者服務或 `~/.claude`。

## 問題

外部研究建議借鑑 OpenKB 的 knowledge lint。第一步只問：現有的 Page `needsReview`／`reviewSections`、Knowledge `possiblyStale`、`review`（contradicted）與 lifecycle（`active`／`archived`＋`supersedesId`）已經抓到多少問題？還有哪些重要、可重現、尚未涵蓋的問題？缺口不成立就 No-Go。

## 1. 現況對照表（依原始碼核對）

Knowledge 的狀態欄位只有 `active`／`archived`；「confirmed／overturned／superseded」是由欄位組合推得的概念，不是獨立狀態：confirmed＝`lastConfirmedAt`＋`applied`／`manual_confirm` feedback，overturned＝`review.reason = "contradicted"`，superseded＝`supersedesId` 且舊版被封存。

| 面向 | 已具備（程式位置） | 尚未覆蓋 |
|---|---|---|
| Page 引用的來源失效 | `knowledge-page-service.ts` 的 `needsReview`：`source_missing`（不存在或跨專案）、`source_voided_after_save`、`source_restored_after_save`、`source_updated_after_save`、`source_state_unknown`；存檔時拒絕引用已作廢或跨專案 Session | 只看「存檔之後」的事件；沒有跨 Page 彙總，也不連到 Knowledge |
| Page 新資料 | `status: has_new_data`、`newSessionCount`、`checkedThrough` 審查游標 | — |
| Knowledge 的來源失效 | 無。`knowledge.session_id` 單一欄位，Session 作廢時不做任何事 | **來源已作廢、Knowledge 仍 active** |
| Knowledge 的來源被刪除 | 無。`session_id` 為 `ON DELETE SET NULL`，刪除後變成與手動建立無法區分的空值 | **來源被刪除而孤立**（只能靠 `knowledge_audit` 的建立紀錄分辨） |
| Knowledge 的來源被修改 | 無 | 來源 Session 在 Knowledge 之後被修改（見下，噪音高） |
| 內容過時 | `possiblyStale`：僅當 `appliesTo` 非空，且 `max(createdAt, lastConfirmedAt)` 之後有其他 Session 改到相符路徑（`knowledgeStaleness`） | `appliesTo` 為空的 Knowledge 永遠不會有此訊號 |
| 被推翻 | `review: contradicted`（finalize 的 `contradictedKnowledgeIds`），再次確認即清除；`evidence` 計數 | — |
| Lifecycle 一致性 | `recordKnowledge` 以 `supersedesId` 建立時，把仍為 active 的舊版封存；找不到 `supersedesId` 只回警告 | `updateKnowledge(status:"active")` 可把已被取代的舊版還原，與 active 的新版並存且無檢查；不檢查 supersedes 指向不存在／跨專案／成環 |
| 同題多版本 | 只有明確的 `supersedesId` 流程 | 未經 `supersedesId`、同標題的多個 active 版本 |
| 重複 | Knowledge candidate 只用 `uncoveredSessionIds` 避免重複請求同一批 Session；沒有與既有 Knowledge 比對 | 來源重疊且文字高度相似的 Knowledge |
| 衝突 | 只有 Session 自行回報的 contradicted | 沒有任何主動偵測 |

## 2. 方法

### 合成測資（`knowledge-health-probe.mjs`，固定 PRNG 種子）

每個實例（instance）使用 12 個專屬 Session，植入有標記的案例與「看起來像但其實乾淨」的對照：

| 情境 | 標記 | 備註 |
|---|---|---|
| 有效來源的 Knowledge／Page | 乾淨 | |
| 已作廢來源（Knowledge、Page 各一） | `source_invalid_cited` | 經 `setSessionVoid` 實際作廢；Page 在存檔後作廢 |
| 來源被修改（Knowledge、Page 各一） | `source_modified_after_creation` | 以 SQL 設定 `sessions.updated_at` |
| 來源被刪除 | `source_orphaned` | 以 SQL 刪除 Session，與 `ON DELETE SET NULL` 效果相同 |
| 合法手動 Knowledge（無 Session、有／無 references） | 乾淨 | 驗證孤立規則的排除 |
| supersedes 鏈正確（舊版封存） | 乾淨 | |
| 舊版被還原與新版並存 | `lifecycle_supersede_conflict` | 經 `updateKnowledge` 實際還原；另每 5 個實例加 1 個 supersedes 指向不存在 id（匯入後才可能出現，API 不可達） |
| 同題多版本、無 supersedes（同標題不同類型為對照） | `topic_multiple_active` | |
| 明確衝突（相同標籤、同文只差 always／never；雙否定、不相關否定為對照） | `possible_conflict_negation` | |
| 重複（同來源、近乎相同文字；同來源不同文字為對照） | `duplicate_overlap` | |
| 文字重複但無共同來源 | `duplicate_text_only` | 規則刻意不涵蓋，用來量測召回上限 |
| `appliesTo` 路徑被後續 Session 改動／被後續 Session 回報 contradicted | `existing_*` | 現有訊號本來就抓得到，作為基準 |
| 大量填充 Knowledge：約 70% 有來源、隨機標籤、15% 有 `appliesTo`、30% 有共用 references | 乾淨 | 製造噪音與桶內配對 |
| 良性觸碰：填充來源 Session 的一部分被 link／evidence／標題編輯更新 `updated_at` | 乾淨 | `--benign-touch-rate`，預設 0.1（假設值，非實測） |

### Analyzer（`knowledge-health-analyzer.mjs`）

唯讀（`DatabaseSync(path, { readOnly: true })`）、無隨機性、無 LLM、不寫入。每項輸出 `rule`、`subjectId`、`sourceId`、`reason`、`at`（問題成立的時間）、`version`（Page 版本或 `rev:<updated_at>`）。只處理 `tracked` 專案。

| 規則 | 判定 | 複雜度 |
|---|---|---|
| `source_invalid_cited` | active Knowledge 的 `session_id`／references 指向已作廢或跨專案 Session；Page 區段引用已作廢／不存在／跨專案 Session（不論 `needsReview`） | 一次 `json_each` 查詢 |
| `source_modified_after_creation` | 來源 `updated_at` 晚於 `max(createdAt, lastConfirmedAt)`；Page 對照 `sourced_through` | 同上 |
| `source_orphaned` | `session_id` 為空，但 `knowledge_audit` 的 created 紀錄有 `sessionId`（來源被刪）；建立時就沒有 Session 的手動 Knowledge 排除 | 只查空值者 |
| `lifecycle_supersede_conflict` | 新舊版同為 active、supersedes 目標不存在／跨專案、成環 | 一次記憶體走訪 |
| `topic_multiple_active` | 同專案同類型同標題（正規化後）≥2 個 active，且無 supersedes、文字非完全相同 | 以 Map 分組 |
| `duplicate_overlap` | 同專案、共用 `session_id` 或 reference，且內文 token Jaccard ≥ 0.8（拉丁字用詞，CJK 用字二元組） | 倒排索引取候選配對，桶上限 200，不做全配對 |
| `possible_conflict_negation` | 共用標籤、否定詞極性相反、去掉否定詞後 Jaccard ≥ 0.6 | 同上 |

### 量測

種子、現有訊號、analyzer 各在獨立行程執行（RSS 才不含種子負擔）；analyzer 跑 3 輪取中位數，並斷言 3 輪輸出完全相同。現有訊號用公開 API：`listKnowledgePages`（`needsReview`）與分頁 `searchKnowledge`（`possiblyStale`、`review`、`archived`）。重疊率＝analyzer 發現的項目，其主體（或配對任一方）同時被現有訊號標記的比例。

重現：

```
pnpm build
node docs/experiments/knowledge-health-probe.mjs --self-check                 # 小型夾具，斷言每條規則召回 100%、對照零誤報
node docs/experiments/knowledge-health-probe.mjs --json <新檔案>              # 5,000 Sessions，預設 --benign-touch-rate 0.1
```

原始結果：[knowledge-health-gap.results.json](knowledge-health-gap.results.json)（touch rate 0.1）。

## 3. 結果（5,050 Sessions、2,260 Knowledge、150 Pages，單機 macOS）

### 規模與耗時

| 項目 | 結果 |
|---|---|
| analyzer 耗時（3 輪） | 中位數 1.20 秒（0.99–1.21 秒；touch rate 0 時 0.92 秒） |
| analyzer 記憶體 | RSS 42.2 → 79.0 MB（峰值 79.0 MB），heap 增量約 15.6 MB |
| 現有訊號讀取（`listKnowledgePages`＋分頁 `searchKnowledge`） | 2.66 秒，RSS 122.5 MB（含載入 store） |
| 跳過的過大桶 | 0 |

analyzer 每次執行是整庫掃描，主執行緒同步工作，因此即使做成產品功能也應放在 CLI／doctor 或離峰任務，不放進請求路徑。

### 每項規則（touch rate 0.1，總計 524 筆發現）

| 規則 | 植入 | 發現 | TP | FP | precision | recall | 現有訊號已抓到 | 與現有重疊 | 全新 TP |
|---|---|---|---|---|---|---|---|---|---|
| source_invalid_cited | 100 | 100 | 100 | 0 | 1.000 | 1.000 | 50 | 50 | 50 |
| source_modified_after_creation | 100 | 164 | 100 | 64 | **0.610** | 1.000 | 50 | 60 | 50 |
| source_orphaned | 50 | 50 | 50 | 0 | 1.000 | 1.000 | 0 | 0 | 50 |
| lifecycle_supersede_conflict | 60 | 60 | 60 | 0 | 1.000 | 1.000 | 0 | 0 | 60 |
| topic_multiple_active | 50 | 50 | 50 | 0 | 1.000 | 1.000 | 0 | 0 | 50 |
| possible_conflict_negation | 50 | 50 | 50 | 0 | 1.000 | 1.000 | 0 | 0 | 50 |
| duplicate_overlap | 50 | 50 | 50 | 0 | 1.000 | 1.000 | 0 | 0 | 50 |
| duplicate_text_only（規則不涵蓋） | 50 | 0 | — | — | — | 0（設計） | 0 | — | — |
| existing_possibly_stale（基準） | 50 | 0 | — | — | — | — | 50 | — | — |
| existing_contradicted（基準） | 50 | 0 | — | — | — | — | 50 | — | — |

「植入」中 `source_invalid_cited`／`source_modified_after_creation` 各含 50 個 Knowledge 與 50 個 Page（Page 以 `頁面ID:來源ID` 為單位）；`lifecycle_supersede_conflict` 含 10 個 API 不可達的 dangling supersedes。

### 重疊與缺口

- Analyzer 524 筆發現中，有 110 筆（21.0%）同時被現有訊號標記；以 460 筆真陽性計為 100 筆（21.7%）。重疊 **全部來自 Page**：Page 的失效／被修改來源與 `needsReview` 完全重疊（100 對 100），這兩條規則對 Page 沒有新增價值。另有 10 筆是誤報剛好落在有 `possiblyStale` 的 Knowledge 上。
- 全新真陽性 360 筆（78.3% 的真陽性）。**這個比例由植入組成決定，不代表真實資料的盛行率。**
- 反過來看：把 Page 以外的 410 個植入問題（Knowledge 來源失效 50、來源被修改 50、孤立 50、lifecycle 60、同題多版本 50、衝突 50、重複 50、純文字重複 50）交給現有訊號，抓到 0 個；現有訊號對全部 510 個非基準問題的召回為 100／510＝19.6%，且全由 Page 的 `needsReview` 貢獻。
- touch rate 為 0 時所有規則 precision 均為 1.000（460/460）；`source_modified_after_creation` 的 precision 隨良性觸碰比例單調下降，0.1 時為 0.610，因為 `touchSession` 在 link、evidence、標題編輯、void 等多處都會更新 `updated_at`。

## 4. Go／No-Go 建議

**合成資料階段的建議：有條件 Go，範圍縮到三條規則；整套 lint 與其餘規則 No-Go。實際資料結果見 4.1，最終判定為 No-Go。**

Go（Knowledge 層的來源與 lifecycle 一致性，皆為確定性、可重現、無 LLM）：

1. `source_invalid_cited`（Knowledge 部分）：缺口真實存在，現有流程在 Session 作廢時完全不通知 Knowledge；precision 1.0，成本低（一次 `json_each` 查詢）。
2. `source_orphaned`：刪除來源後 Knowledge 與手動建立無法區分，需要 `knowledge_audit` 才能還原，現有流程沒有訊號。
3. `lifecycle_supersede_conflict`：`updateKnowledge(status:"active")` 可還原已被取代的舊版而無任何檢查，是 API 可達的真實路徑；supersedes 目標不存在或成環僅在匯入等情況可能出現，只當防禦性檢查。

No-Go 或延後：

- Page 的來源失效／被修改規則：與 `needsReview` 100% 重疊，沒有缺口。
- `source_modified_after_creation`（Knowledge）：良性觸碰多，precision 0.61，且「來源被修改」本身不等於知識錯誤，不建議做。
- `possible_conflict_negation`：靠否定詞與詞集相似度，在合成資料上得分高是因為植入的文字刻意如此，真實自然語言（中英混用、委婉否定）的精確度未知，不建議在沒有真實語料驗證前做。
- `duplicate_overlap`／`topic_multiple_active`：行為正確但盛行率未知；Knowledge 數量目前小，優先度低於上面三條。純文字重複（無共同來源）規則刻意漏掉，若要抓需要文字相似度全域比對，成本與誤報都較高。

前置條件（進入任何實作之前）：在 **唯讀備份副本**（不是使用者正在使用的資料庫）上用同一支 analyzer 量真實盛行率；若三條規則加總的真實命中數為 0 或極少，則改判 No-Go。這一步需要使用者同意使用實際資料，本研究沒有做。

若之後實作：不新增 migration（三條規則只讀既有欄位與 `knowledge_audit`）；以 `pnpm db:*`／doctor 風格的唯讀診斷輸出，不寫入、不進 MCP 寫入工具、不改 finalize，並依 `worklog-backend` 規則補基準案例與 p90 上限。

## 4.1 實際資料唯讀副本結果（2026-11-07）

依上述前置條件，在使用者本機資料庫以 `VACUUM INTO` 建立的唯讀副本上執行同一支 analyzer，只記錄數量，量完即刪除副本。

| 項目 | 數量 |
| --- | ---: |
| Sessions／Knowledge（active）／Knowledge Pages／專案 | 322／65（31）／6／6 |
| `source_invalid_cited` | 0 |
| `source_orphaned` | 0 |
| `lifecycle_supersede_conflict` | 0 |
| `topic_multiple_active`、`possible_conflict_negation`、`duplicate_overlap` | 0 |
| `source_modified_after_creation`（建議不做的高雜訊規則） | 10 |
| analyzer 耗時 | 約 190 ms |

**結論：No-Go。** 三條建議規則的真實命中數為 0，依前置條件改判 No-Go；Knowledge Impact Analyzer 研究也不開工。限制：該副本不含另一臺電腦 2026-10-30 之後的記錄，匯入後可用同一支 analyzer 重跑。

## 5. 限制

- **植入答案由我們定義**：精確率與召回主要證明規則實作與對照案例正確，不代表真實資料的盛行率或誤報率。唯一接近真實分佈的假設是良性觸碰比例（預設 10%，未實測），其餘 FP 來源（自然語言相似度、真實 `appliesTo` 規模）都沒有被覆蓋。
- 對照案例是我們想得到的類型；沒有被想到的乾淨模式仍可能誤報。
- Session 刪除與 `supersedes_id` 損壞以 SQL 模擬（`search_dirty` 先清空以避開 trigger 衝突），不等同走完整個刪除服務；「來源被修改」同樣以 SQL 設定 `updated_at`。
- 文字相似度用詞集 Jaccard，只比對 body；中文用字二元組，沒有分詞，未調校。
- 單一專案、單機單次環境（macOS、Node 25）；耗時只當量級參考，沒有跨平台。RSS 差值受載入模組影響，heap 增量較可靠。
- 「重疊」只計算同一主體是否被現有訊號標記，不判斷兩者的原因是否相同。
- 沒有評估 `knowledge_feedback` 與 `knowledge_candidates` 的關聯；candidate 接受後 Knowledge 的 `session_id` 行為只由程式碼閱讀得知，未另做實測。
