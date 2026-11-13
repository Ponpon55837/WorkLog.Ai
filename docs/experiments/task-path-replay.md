# 只給 task 時的路徑推論重播

日期：2026-11-13。性質：研究加一項已出貨的小功能（`work_get_context` 只帶 `task`、不帶 `paths` 時的 `inferred_path` 指標）。腳本：`docs/experiments/task-path-replay.mjs`（唯讀，只輸出彙總 JSON）。本文只有彙總數字，不含任何專案名稱、路徑、標題或內文；自我檢查使用虛構的合成資料庫。

## 問題

以 `appliesTo` 綁定檔案的 Knowledge，在 `work_get_context` 只能靠 `paths` 命中。Agent 開工時常只知道任務、還不知道要改哪些檔案。只給 `task` 時，能不能經由「相似的過去 Session 改過哪些檔案」找到這些 Knowledge？代價（誤報、回應大小、擠掉原本內容）是多少？

## 方法

- 對單一專案，逐筆重播每個歷史 Session（題目）：只用它開始前已存在的 Session 與 Knowledge（Knowledge 由 `knowledge_audit` 快照重建），任務文字取其標題並移除檔案樣式的字串。
- 目標（target）：題目開始前已存在、`appliesTo` 涵蓋該 Session 任一變更檔、且不是由它自己產生的 active Knowledge。一個（題目, 目標）是一組 pair。有目標的題目稱正例，沒有的稱負例。
- 原有四種變體（推論關閉）：`task`（只帶 task）、`frequent`（專案最常改的三個檔案當 paths）、`predicted`（最相似五筆 Session 的檔案前三名）、`actual`（真實變更檔，上限）。
- 產品變體：`off`（功能關閉，必須等於 `task`）與 `product`（出貨設定）。`merged` 是大小模擬：在 `task` 回應後附上 `predicted` 查詢新找到的 Knowledge，只要整份 JSON 仍在 9,800 字內。
- 預算：只帶 task 的回應上限 9,800 字；`relevant.*` 第一輪內容永遠不變，推論指標只用剩餘空間。

## 定義

- 寬鬆命中（loose）：目標的標題或 excerpt 出現在 `omitted` 以外的任何位置，包含 `recentKnowledge`。
- 嚴格命中（strict）：目標的標題或 excerpt 出現在 `relevant.knowledge` 或 `relevant.supplements`。`recentKnowledge` 與其他位置不算。
- 為什麼要分：`recentKnowledge` 只是最近更新的 12 筆 Knowledge，與任務無關，卻讓研究基線的寬鬆命中虛高。基線 `task` 的 109 筆寬鬆命中中有 98 筆來自 `recentKnowledge`，嚴格命中只有 11 筆。只看寬鬆定義會把「剛好是最近新增」誤當成「找得到」。
- 精準度（precision）：`inferred_path` 指標中恰好是目標的比例。負例上的指標一律是雜訊。
- 寬鬆損失（`looseLostBy`）：基線的寬鬆命中在變體中消失的原因（`yieldPop` 為讓位被移除、`promote` 為轉成指標後被預算丟掉、`other`）。

## 結果（真實資料，單一專案，只列彙總）

273 筆只帶 task 的回應、70 個正例題目、221 組目標 pair。

研究基線（推論關閉，`task`／`frequent`／`predicted`／`actual`）：

| 定義 | task | frequent | predicted | actual |
| --- | --- | --- | --- | --- |
| 寬鬆（full） | 109 | 116 | 125 | 156 |
| 寬鬆 gained／lost | — | 22／15 | 28／12 | 55／8 |
| 嚴格 | 11 | 50 | 64 | 146 |

推論變體（相對 `task`，嚴格定義）：

| 變體 | 嚴格命中 | 備註 |
| --- | --- | --- |
| e611332 原型（3 個推論路徑，只用剩餘預算） | +3 | 幾乎沒有空間 |
| paths3Yield／paths5Yield／paths8Yield（取推論路徑當 `paths`） | 29／35／39 | 壓縮成 3／5／8 個路徑 |
| weighted3Yield | 47（+36） | 雜訊 7，precision 0.655 |
| bestAllKnobs | 92（+81） | 186 個指標、72 個在負例，precision 0.435 |
| merged（`predicted` 查詢附加在預算內） | +16 | 另有 12 組目標被預算切掉 |
| knowledgeRecallOnly limit 5／8 | 24／25 組（新增 13／14） | 非目標命中 114／119 |

掃描（以 weighted、yield、promote、allowRecentOmitted 為底；`minSessions` 為需要幾筆不同相似 Session 支持，`share` 為分數占全部檔案權重的下限）：

| 設定 | 嚴格增益 | 指標數 | 目標數 | 負例指標 |
| --- | --- | --- | --- | --- |
| limit 3、minSessions 2、share 0（出貨） | +49 | 69 | 49 | 8 |
| limit 3、minSessions 1、share 0 | +81 | 186 | — | 72 |
| limit 3、minSessions 1、share 0.1 | +54 | 96 | — | — |
| limit 3、minSessions 1、share 0.2 | +32 | — | — | 11 |

所有推論設定的平均回應約 8,750 字，最大不超過 9,800 字。

## 決策

出貨：加權檔案（每個相似 Session 對自己的每個檔案貢獻 分數／√檔案數，檔案數為 0 或超過 20 的 Session 不貢獻）、為指標讓位（yield）、命中的 `recentKnowledge` 轉成指標（promote）、預算裁切掉的 `recentKnowledge` 命中可以回來（allowRecentOmitted）、指標上限 3、至少兩筆不同相似 Session 支持（minSessions 2）、不設分數門檻、不因信心高而跳過。

結果：嚴格命中 11 → 60（+49，0 筆損失）；69 個推論指標中 49 個是目標（precision 71%）；8 個落在負例（占增益的 16%）；平均回應約 8,700 字，最大 9,800 字以內。

寬鬆損失原本是 1 筆（`yieldPop`：為指標讓位而被移除的 `recentKnowledge`）。出貨版改成讓位時先把未被命中的 `recentKnowledge` 縮成只剩標題（`excerpt` 空字串、`excerptTruncated: true`），所有項目都只剩標題仍放不下才從後面移除，命中的項目永遠不縮不移；目的是寬鬆損失歸零。

為了讓加權掃描在大專案不吃掉預算，`appliesTo` 比對前先用檔案索引（`AppliesToFileIndex`）篩出候選配對。壓力測試（2,000 筆 Knowledge × 每筆 10 個 glob、100 個檔案）：索引前 78–180 ms 且比對預算用盡；索引後 62 ms，使用 7.5M／20M 單位。

## 被否決的替代方案

- 把推論路徑壓縮成 3／5／8 個當 `paths`：嚴格命中只有 29／35／39，遠低於加權指標的 +49，且改變第一輪內容。
- weighted3Yield：+35 但有 7 筆雜訊、precision 0.655，沒有 minSessions 支持門檻。
- bestAllKnobs（minSessions 1）：+81，但 186 個指標中 72 個在負例，precision 0.435。多出的 32 筆增益要付 64 個誤報，Agent 要逐一讀取查證，不划算。
- 分數門檻（share 0.1／0.2）：增益掉得比雜訊快（+54／+32，負例仍有 11 個）。minSessions 2 用更少的誤報保住更多增益。
- 高信心時跳過（skipHighConfidence）：會損失 9–10 組嚴格命中，因為高信心的回應常常正是缺了綁檔案的 Knowledge。
- 只搜尋 Knowledge 的 recall（knowledgeRecallOnly）：只多 24–25 組 pair（新增 13–14），卻帶進 114–119 個非目標。不值得。
- 把 `predicted` 查詢結果附加在預算內（merged）：+16，另有 12 組被預算切掉；沒有權重、也沒有讓位機制。

## 限制

- 只有一個專案；標題代替任務描述；題目數不大，百分比的信賴區間寬。
- Knowledge 由 `knowledge_audit` 快照重建，審計之外遺失的歷史不在其中。
- 嚴格命中只代表「指標在回應中」，不代表 Agent 讀了、也不代表答案正確；`merged` 是大小模擬。
- 指標是「由相似工作推論，不是證據」：Agent 必須用 `work_search_knowledge` 依標題讀取後才能引用。
- 目標由 `appliesTo` 涵蓋判定；沒有綁檔案的 Knowledge 不在這個實驗內。

## 如何執行

```bash
pnpm build
node docs/experiments/task-path-replay.mjs --self-check
node docs/experiments/task-path-replay.mjs --db <資料庫副本> --project <專案 id 或根目錄>
```

- `--self-check`（未給 `--db` 時預設）在暫存資料夾建立虛構資料庫，斷言：嚴格損失為 0、最大字數不超過 9,800、`off` 與 `task` 完全相同、診斷涵蓋每一組 pair。
- `--db` 以唯讀開啟，重播寫入只進記憶體資料庫，輸出只有彙總 JSON。
- 腳本只保留 `off` 與 `product` 兩個產品變體；唯一的產品掛鉤是 `ContextRecallService` 的私有欄位 `inferTaskPaths`（產品中恆為 `true`）。上表的參數掃描與旋鈕變體已隨旋鈕移除，數字留在本文。
