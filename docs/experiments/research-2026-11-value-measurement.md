# R1 研究：持續量測「越用越好用」與伺服器觀察的再利用訊號

研究日期：2026-11-13。基準程式碼：`main`（1.6.32，schema 33）。本文件只含結論、量測設計與彙總數字，不含任何真實記錄內容、標題、路徑、id 或專案名稱。

## 結論先行

1. **先做 `eval:value`（唯讀指令）**：用固定的指標定義，對使用者自己的資料庫輸出「按月／按升級前後／按專案歷史深度」的指標表。只用 SQL 和記憶體內比對，不回放 `getContext`，所以後來的記錄不會影響早期時間點的結果。雛形已放在 `docs/experiments/value-metrics-probe.mjs`，附合成 self-check。在 20,000 Session／3,000 Knowledge／5,000 讀取稽核的合成庫上約 10 秒。
2. **「越用越好用」用 7 個核心指標定義**（見 A1）。其中 4 個（M1／M4／M6／M7）只靠資料庫現有資料就能算到全部歷史，但 M6 目前分不出「保存當下就完整」與「事後補齊」；3 個（M2／M3／M5）依賴讀取稽核，只能算到最近 30 天或 5,000 筆，以較早到者為準。另外，「有沒有真的做得更快更好」**沒有**可信的單人代理指標（見 A4），不應宣稱。
3. **跨版本比較分兩種，不能混用**：
   - 「新程式碼是否更好」：用**同一份凍結的資料快照**跑新舊兩版程式碼（1.6.32 的 3.3%→67.1% 屬於這類，方法成立）。
   - 「使用越久是否越好」：只能用**當時伺服器實際記下的**訊號（讀取稽核、Knowledge 稽核、未結項事件），並按專案歷史深度分組。用現在的資料庫回放過去，結果不可信。
   - 兩者都要求**按版本而不是按日期切分**。目前產品的任何記錄都沒有存寫入當下的版本（`APP_VERSION` 只出現在 MCP 啟動訊息），這是量測基礎的缺口，見 A2。
4. **設計前提（真實資料驗證後確立）**：可攜式匯出檔不含讀取稽核，上層在匯出檔上跑雛形時，所有提供率、干擾率、上下文成本欄位都是空的。所以 M2／M3／M5 只能在使用者本機的資料庫上量。`eval:value` 必須是使用者自己一鍵執行、輸出可以安全分享的彙總；而且讀取稽核 30 天／5,000 列會過期，必須另存每日或每版的彙總數字，趨勢才不會跟著消失。
5. **再利用（主題 B）**：在不靠 Agent 自稱的前提下，伺服器目前只能觀察到「讀過」，觀察不到「用了」。值得做的是一個小 schema 變更：讀取稽核加上**連線 run id 與回應區段**，Knowledge 稽核加上 actor run id。之後才能誠實分辨三件事：路徑命中的提供、「最近 12 筆」清單帶出的曝光、Agent 開工後專程讀取。**先收集 2–4 週再決定要不要拿去影響排序**。另有一個**不需 schema 的確定性過時訊號**：上次確認之後，Knowledge 適用路徑被後續 Session 改動的次數。可以直接用於審閱提示與淘汰建議。
6. **不做**：在 finalize 強制 Agent 表態（會被敷衍回報污染，維持上一輪判斷）；自動判斷「變更是否與 Knowledge 內容相容」（沒有 LLM 做不到，不假裝能）；引入向量庫或 LLM 評審；在 Web 顯示指標（等指標定義穩定兩個版本再說）。

### 最值得先做的三件事（依對「越用越好用」的貢獻排序）

| 順位 | 項目 | 為什麼排這裡 | 工作量 |
| ---- | ---- | ------------ | ------ |
| 1 | `eval:value` 指令（由雛形產品化，含 `--by-depth`、`--split`、`--json` 快照）＋ Session／讀取稽核記錄寫入當下的版本 ＋ 每日彙總小表 | 沒有它，之後每一版的效果都只能臨時寫腳本；沒有版本欄位，前後對照只能猜升級日期；沒有彙總表，稽核過期後趨勢消失 | 3–4 天 |
| 2 | 讀取稽核加 `run_id`、回應區段，Knowledge 稽核加 actor | 這是分辨「真提供」與「最近清單曝光」的唯一辦法；提供率、干擾率、專程讀取都靠它 | 1.5–2 天（含 migration、匯出／刪除規則與測試） |
| 3 | 確定性過時訊號：上次確認後，適用路徑被改動的次數 | 資料越多，過時 Knowledge 越多；這個訊號直接降低噪音，不需新欄位 | 1–2 天 |

## 問題大小（數字與來源）

| 事實 | 數字 | 來源 |
| ---- | ---- | ---- |
| 有效 Knowledge 從未被回報 applied | 105 筆中 87 筆 | 上層彙總，6 專案約 650 Session |
| 有提供機會時 Agent 回報使用 | 約 1% | 同上 |
| applied 回報與該次變更檔的適用路徑無關 | 75 筆中 63 筆 | 同上 |
| 帶路徑查詢時完整提供適用 Knowledge | 3.3%（1.6.31）→ 67.1%（1.6.32），337 次機會 | `docs/releases/1.6.32.md`（凍結快照、新舊程式碼對照） |
| 只給任務描述時完整提供 | 7.4% | 同上 |
| 只用任務標題的命中，大部分其實來自「最近 12 筆」 | 約九成 | 上層 1.6.33 回放（repo 內沒有 1.6.33 文件，未能在 repo 查證） |
| 讀取稽核保留 | 30 天且最多 5,000 列，每 100 次寫入修剪一次 | `packages/storage/src/agent-read-audit-service.ts:25-28` |
| 讀取稽核連線識別 | 無；只有 clientInfo 名稱 | `apps/mcp/src/server.ts:535` |
| 產品版本紀錄 | 無；只有 `schema_migrations.applied_at`（只記 schema 版本） | `packages/storage/src/schema-migrations.ts` |
| 真實資料上 `value-metrics-probe` 的結果 | 6 專案、639 Session、146 Knowledge；讀取稽核 0 筆（匯出檔不含）；見〈真實資料量測〉 | 上層在私有匯出副本上執行 |
| 路徑命中的嚴格提供（R2 獨立重算） | scoped 221 中嚴格 found 11、只經最近清單 95 | R2（平行研究，本文未重算） |
| P5 定案設定在產品實跑 | 嚴格命中 11 → 60；推測指標 69 筆中 49 筆是目標；負面題多 8 筆 | P5（平行研究，本文未重算） |

## 主題 A：持續量測

### A1. 指標定義

以下「機會」（opportunity）指：同專案、未作廢的 Session S，以及 Knowledge K。K 建立早於 S 開工，S 開工時 K 為 active（由 `knowledge_audit` 的 archived／restored 重建），K 設有 appliesTo 且涵蓋 S 至少一個變更檔（以產品的 `appliesToStrength` 判斷），且 S 不是 K 的來源 Session。「時間窗」指 `[S.started_at − 10 分鐘, S.completed_at]`。

| # | 指標 | 精確定義 | 只靠資料庫現有資料？ | 需人工標註？ | 隨資料成長失真？ |
| - | ---- | -------- | -------------------- | ------------ | ---------------- |
| M1 | 高價值知識保存率 | 每 100 筆 Session 新增的 Knowledge 數；其中設 appliesTo 的比例；建立後至今仍 active 的比例 | 是，全歷史 | 「高價值」需要標註；改用代理：設了 appliesTo，且之後至少形成 1 次機會 | 「仍 active」對新記錄偏高，需按建立月份看 |
| M2 | 適用 Knowledge 提供率（伺服器觀察） | 機會中，時間窗內任一筆同專案讀取回傳過 K id 的比例。另外拆出：只經 `work_get_context` 回傳的比例，以及其中 K 當時在「最近 12 筆」近似排名內的比例 | 依賴讀取稽核：只有最近 30 天／5,000 列 | 否 | **會**：專案 Knowledge 少時，「最近 12 筆」幾乎涵蓋全部，提供率虛高；所以一定要同時報 `offeredPossiblyRecentListPct`，並用 `--by-depth` 看 |
| M3 | 無效知識干擾率 | 時間窗內回傳的 Knowledge id 中，設了 appliesTo 卻不涵蓋 S 任何變更檔的比例（off-path）；未設 appliesTo 的比例另列（unscoped） | 同 M2 | 否（是上限估計：off-path 不等於無用，任務相關的知識不一定綁路徑） | 會：Knowledge 越多，off-path 越高才是真訊號；需要和 M2 一起看 |
| M4 | 未結項附依據結案比例 | 結案事件中，Agent 帶 actor Session 結案，加上使用者在 Web 接受附證據的 Agent 清理提案，占全部結案的比例；重開（回到 pending）另列 | 是，全歷史（`outstanding_item_events`） | 否 | 低 |
| M5 | 每次開工的上下文成本 | 每個時間窗內的讀取次數中位數、回傳 id 數中位數、`work_get_context` 耗時中位數 | 讀取稽核；**回應字元數目前沒記**，只能用回傳筆數代理 | 否 | 這正是要觀察的量：若隨深度上升，代表等比例增加噪音 |
| M6 | 時間戳與變更狀態完整率 | 有 `started_at`、`updated_at`、`changed_files_confirmed`、commit、branch、verification passed 的 Session 比例。**必須拆成「保存當下就完整」與「事後補齊」兩個數**：前者是產品引導 Agent 的成效，後者是使用者花力氣補救的量 | 目前只能算「現在是否完整」。摘要、工作摘要、驗證有修訂表（`session_summary_updates` 等，可據 previous_json 判斷保存當下的值）；`started_at` 的更正自 1.6.32 起留 note event；commit、branch、變更檔的事後補填沒有修訂紀錄，分不出來 | 否 | 會：真實資料 `startedAtPct` 近 100% 主要來自歷史上多次批次補填，不是保存當下就有 |
| M7 | 重工訊號（代理） | 作廢 Session 比例；contradicted 回報數；未結項重開數。72 小時內再改動同檔案的比例**降為背景資訊，不當重工指標**（見下） | 是 | 否 | 高度混淆，**只能看趨勢，不能當成品質** |
| 參考 | Agent 自稱 applied | 每個機會的 applied 回報率；applied 中路徑一致的比例 | 是 | 否 | 這是要繞開的訊號，只做對照 |

**72 小時再改動不是重工**：雛形的定義會把「同一件工作分多筆 Session 連續進行」算進去，真實資料 47–75% 的高比例主要就是這個。若要保留，至少排除以下三種：前一筆 Session 的 nextSteps／未結項由後一筆接續（`continuedOutstandingItems`、`session_links`）；兩筆在同一分支且前一筆未提交；前一筆驗證未通過。即使排除，仍分不出「修正錯誤」與「繼續擴充」，所以不建議作為核心指標。

不列入核心的候選：「重複讀取同一筆」（`direction-research-2026-11-07.md` 顯示 Session 平均被讀 7.1 次）。原因是它同時反映 Agent 習慣與上下文不足，方向不明。保留在診斷用。

### A2. 產品化建議

**架構**

```
資料來源（唯讀）                         計算                         輸出
sessions / knowledge / knowledge_audit ─┐
knowledge_feedback / outstanding_*     ─┼─ eval:value（SQL + 記憶體比對）─ 文字表 + --json 快照
agent_read_audit(+records)             ─┘      --split / --by-depth / 月份
eval:recall 題庫（私有）  ─ eval:recall（真實 handler）─ hit@k / MRR（精準度，唯一需要標註的部分）
凍結快照 + 新舊兩版 dist ─ 既有三支回放腳本 ─ 「為什麼沒提供」的診斷
```

- **指令形式**：`pnpm eval:value -- --db <path> [--split <date> | --by-depth] [--json <新檔>]`，與 `eval:recall` 並列。不放進 `db:*`，因為 `apps/server/src/cli.ts` 的 `withStore` 會建立 `WorkIntelligenceStore`，可能觸發 migration。量測必須用 `DatabaseSync({ readOnly: true })` 加單一讀取交易，不建立 store。
- **版本對照：把版本存在記錄上，不只存升級事件**。真實資料證明按日期切分不可靠：匯出在 1.6.32 合併後 42 分鐘取得，`--split 2026-11-13` 的 after 桶只有 7 筆，而且產生它們的機器何時裝上 1.6.32 不得而知；舊的 MCP process 也可能在升級後繼續以舊版執行。建議：
  - `sessions.app_version`（finalize 時由 MCP 帶入 `APP_VERSION:buildHash`），`agent_read_audit.app_version`，`outstanding_item_events` 與 `knowledge_audit` 也各帶一個。每列多約 20 bytes。`--split` 改為接受版本號，按「寫入這筆記錄的版本」分桶。
  - `app_version_events(version, first_seen_at)` 仍有用：給 Web 寫入與沒有記錄的時段一個邊界，但只是輔助。
  - 版本欄位屬於記錄的一部分，可攜式匯出應保留（讓匯出檔也能做版本對照）；匯入時照原值寫入。依 `worklog-backend` 規則補匯出／匯入測試。
- **每日彙總小表**：讀取稽核 30 天／5,000 列的保留，對「跨版本前後對照」不夠：發行間隔常短於 30 天，但重度使用時 5,000 列可能幾天就滿，且一旦過期就無法重算升級前的基準。建議新增 `value_metric_daily(day, project_id, app_version, metric, numerator, denominator)`，只存數字不存 id，由 `db:maintain` 或 server 每日第一次啟動時寫入前一天的彙總。
  - 每專案每日約 20 個指標，一年約 7,300 列／專案，可忽略。
  - 這張表應進可攜式匯出：這樣在匯出檔上也能看到 M2／M3／M5 的歷史，彌補匯出不含讀取稽核的缺口。
  - `eval:value` 讀它和原始表；原始稽核仍在時以原始稽核為準。
  - 第一階段（沒有這張表之前）：使用者每次升級前後各跑一次 `eval:value --json`，自己保存快照。
- **Web 顯示**：暫不做。等指標在兩次發行中都穩定、定義不再改，再做唯讀頁。
- **與既有工具的關係**：
  - `outstanding-items-probe.mjs`：保留為診斷工具；它的 M4 類計數改由 `eval:value` 輸出，避免兩份定義。
  - `knowledge-reuse-attribution.mjs`、`task-path-replay.mjs`：保留。它們回答「為什麼沒提供」，只在凍結快照上比較新舊程式碼時使用。
  - `eval:recall`：保留，是唯一有人工標註的精準度量測，與 `eval:value` 互補。
  - `test:retrieval-quality`、read-paths bench：保留在 CI，屬合成回歸，不是使用者資料指標。
  - 可抽出共用：唯讀開庫、`knowledge_audit` 時點重建、機會定義、`--split` 解析、彙總輸出與隱私自檢。

**計算複雜度與成本**（20,000 Session、3,000 Knowledge、5,000 讀取）

| 指標 | 複雜度 | 合成庫實測 |
| ---- | ------ | ---------- |
| M1、M4、M6、M7（作廢、contradicted、重開） | O(N) 掃描 | 全部指標合計約 10 秒（`value-metrics-probe.mjs`，6 專案，每專案約 500 Knowledge） |
| 機會判定（M2 分母、參考指標） | O(Σ 專案 Session × 專案 Knowledge)，有逐檔快取 | 同上，佔大部分時間 |
| M2、M3、M5 | 每 Session 二分搜尋讀取，O(N log R + 時間窗內 id) | 同上 |
| M7 72 小時再改動 | 每專案 O(N²) 最壞情況；按時間排序後只回看 72 小時可降為 O(N·w) | 雛形用簡單版，20,000 筆仍在 10 秒內；產品化時改成滑動窗 |
| 「最近 12 筆」近似 | 每個命中 O(專案 Knowledge × 稽核列) | 只對命中計算，成本小 |
| 對照：回放 `getContext` | 每 Session 3 變體 × 50–140 ms | 外推約 50–140 分鐘（未實測；依 `docs/testing.md` 5,000 Session 的中位數外推） |

最壞情況是單一專案有 3,000 Knowledge，機會判定約為上表的 6 倍，估計約 1 分鐘，仍可接受。產品化時可用 `search_paths`／`related_work_paths` 先篩檔名再精確比對。

### A3. 回放類指標的方法學風險與「當時狀態重建」

| 風險 | 說明 | 可行的重建 | 極限 |
| ---- | ---- | ---------- | ---- |
| 後來的記錄參與排序 | 用現在的資料庫回放，S 之後的 Session／Knowledge 會搶名次，「最近 12 筆」也是現在的 12 筆 | 在暫存庫只放入 `created_at ≤ t` 的記錄再回放；Knowledge 用 `knowledge_audit` 中 `occurred_at ≤ t` 最後一筆 `after_json` 還原內容、appliesTo 與狀態 | 每個時間點都要重建索引，O(N) 次重建不可行；只能抽樣，例如每月一個檢查點，同一檢查點內的 Session 共用一份快照 |
| 結案標題含開工時未知的資訊 | Session 標題與摘要在 finalize 時寫，含結果與路徑 | `task-path-replay.mjs` 的作法：移除路徑樣式的詞；改用 `session_summary_updates` 等修訂表中最早的版本 | 標題仍含結果用語，無法完全去除；這類指標只能當上限 |
| Session 修訂 | 標題、摘要、驗證、完成時間後來可被更正（112 次完成時間更正中 111 次往後推） | 用 `session_*_updates` 的 previous_json 回到最早值 | 變更檔清單若在 finalize 後補登，無法分辨 |
| 時間重建方式不同導致百分比不可比 | `started_at` 缺失時退回 `completed_at`、不同腳本時間窗不同 | `eval:value` 固定一種定義（時間窗前置 10 分鐘、缺 `started_at` 的 Session 不納入讀取稽核指標，只算在分母外），寫進輸出 | 跨定義的歷史數字（1.6.32 文件與上層臨時腳本）不能直接接到新表上 |
| 稽核覆蓋期 | 讀取稽核只有最近 30 天／5,000 列 | 只納入整個時間窗都落在覆蓋期內的 Session，並輸出覆蓋起點 | 覆蓋期以前的提供率永遠無法重算；這也是 A2 建議保存 `--json` 快照的原因 |
| 稽核時間不是寫入時間 | finalize 的 Knowledge 稽核用 Agent 傳入的 `completedAt` | 排序以 `occurred_at` 為準並記下這個偏差 | 同上 |
| 混淆與 Simpson's paradox | 升級前後的專案組成、任務類型不同，合併百分比可能與分組結論相反 | 一律同時給「按專案深度」與「按時間」兩種表；比較升級前後時，看每個深度桶內的差異 | 單人資料量小，桶內樣本常不足；樣本少於 30 個機會的桶應標示不判讀 |
| 深度與版本、日曆時間共變 | 真實資料中深的桶幾乎都是較新的版本、較晚的日期，且只有 2 個專案超過 200 筆。目前的 `--by-depth` 表分不出「用得越久越好」與「產品版本變好」 | 分層：固定版本區間比深度（同一版內，深專案 vs 淺專案）；固定深度區間比版本（同一深度桶內，新版 vs 舊版）；並逐專案畫自己的曲線，不把 6 個專案混成一條 | 需要先有記錄上的版本欄位（A2）；6 個專案、2 個深專案的規模下，分層後每格樣本多半太少，目前只能看單一專案自己的趨勢 |
| 批次行為讓比例跳動 | 使用者單日在 Web 批次結案 172 筆，使 `--split 2026-11-13` after 桶的附依據結案率只剩 2.3%，與版本無關 | 結案指標改報**各來源的絕對數**加**距建立時間的分布**（中位數、P90），不只報單一比例；同一天、同一來源超過某數量的結案標為批次，另列 | 批次門檻要用實際資料校準 |

**原則**：比較「新程式碼是否更好」時，用凍結快照加新舊 dist（公平，因為資料相同）；判斷「使用越久是否越好」時，只用當時記下的訊號，按深度分組，不回放。

### A4. 「後續任務效益」有無單人代理指標

**沒有可信的。** 理由：

- 沒有對照組：同一個人、同一個專案不會有「沒用本產品」的平行版本。若隨機對部分開工隱藏 Knowledge（holdout），等於故意讓使用者變差，單人工具不應這樣做。
- 完成時間（`started_at`→`completed_at`）取決於任務大小，資料中沒有任務大小；即使分桶，也只能看極粗的趨勢。
- 返工的代理（72 小時內再改動、作廢、重開、contradicted）都和正常的連續開發混在一起。DORA 的 rework rate 以「非計畫部署」定義，單人本機沒有對應的事件。

可以做、但只能描述趨勢、不能宣稱因果的：M7 的四個代理按深度分組；以及使用者偶爾的主觀評分（SPACE 主張至少一項感知指標）。後者需要產品新增輸入，本輪不建議。

## 主題 B：再利用到底有沒有發生

### B1. 現況

- `agent_read_audit_records` 記下回應裡每個帶 `type: "knowledge"` 或 `kind + title + body/excerpt` 的物件 id（`agent-read-audit-service.ts:130-171`）。沒有 type 的 pointer 不記。但 `recentKnowledge`（最近 12 筆，依 `updated_at` 排序，`context-recall-service.ts:1508`）、`relevant.knowledge` 與 relaxed matches **都會記成同一種 id**，不分區段。
- 沒有連線 run id：stdio 一個連線一個 process（`apps/mcp/src/index.ts:61`），但 process 內沒有產生任何 id 寫入資料庫。
- finalize 只會把 applied／contradicted 寫成 `last_confirmed_*` 與 `knowledge_feedback`，不改 appliesTo 或內容（`knowledge-service.ts:176-234`）。`work_update_knowledge` 會寫 `knowledge_audit`（含 before／after），但沒有 actor。

### B2. 伺服器可觀察的訊號

| 訊號 | 精確定義 | 需要的儲存 | 隱私與資料量 | 誤判情境 | 能驅動什麼 | 建議 |
| ---- | -------- | ---------- | ------------ | -------- | ---------- | ---- |
| S1 路徑命中提供後觸及 | 同一 run 內，K 以路徑命中區段回傳；之後 finalize 的 Session 變更檔落在 K 當時的 appliesTo | `agent_read_audit.run_id`、`agent_read_audit_records.section`、`sessions.run_id` | run id 是隨機 UUID，不含內容；每列約多 40 bytes | 觸及不等於採用：Agent 可能讀了沒照做；同一 process 服務多段對話時 run 會混在一起（`segment-observer.ts` 註解） | 提供率與干擾率的分子分母都變乾淨；**不直接拿去排序**，避免熱門者恆熱門 | **先做小實驗**（加欄位、收 2–4 週、跑 `eval:value`） |
| S2 開工後專程讀取 | 同一 run 內，Agent 在 `work_get_context` 之後，又以單筆讀取工具取 K 全文 | 同上（工具名已有） | 同上 | Agent 可能只是好奇；也可能是因為摘要被截斷才讀，代表摘要長度不足而不是「有用」 | 摘要截斷是否太狠的診斷；K 的「被需要」程度 | 隨 S1 一起做，只當診斷 |
| S3 讀後修改 | 同一 run 讀過 K 之後，`work_update_knowledge` 修改了 K（appliesTo、內容或封存） | `knowledge_audit.actor_run_id` | 同上 | 修改可能是 Agent 被要求整理知識，與當下工作無關 | 證明 Knowledge 有被「維護」；配合 S4 判斷過時 | 隨 S1 一起做 |
| S4 確定性過時 | K 上次確認或更新之後，有幾筆 Session 改動了 K 適用路徑內的檔案（不看內容） | 不需要；全靠 sessions 與 `knowledge_audit` | 無新增 | 改了檔案不代表 K 錯了；應作為「該審閱」而不是「已過時」 | 審閱提示的排序；超過門檻且長期未被確認者列為淘汰建議（Guru／Stack Overflow content health 的「過期待驗證、不直接刪除」做法） | **做** |
| S5 適用範圍已死 | K 的 appliesTo 在最近 N 筆 Session 中從未被觸及，且路徑在最近的變更檔與路徑索引中都找不到 | 不需要 | 無新增 | 罕改但重要的檔案（例如發行設定）會被誤列 | 淘汰建議（只提示） | 先做小實驗：在 `eval:value` 輸出數量，觀察誤判再決定 |
| S6 變更是否與 K 內容相容 | — | — | — | 沒有 LLM 無法判斷 | — | **不做**，不假裝能 |
| S7 finalize 強制 Agent 表態 | — | — | — | 上一輪已確認會被敷衍回報污染；本輪真實資料中，applied 回報有 84%（63/75）與路徑無關 | — | **不做** |

### B3. 實作範圍（建議做的 S1–S3 小 schema 變更）

- migration：`agent_read_audit` 加 `run_id TEXT`；`agent_read_audit_records` 加 `section TEXT`（固定列舉：`relevant`、`recent`、`file_history`、`direct`、`other`）；`sessions` 加 `run_id TEXT`（finalize 時由 MCP 帶入）；`knowledge_audit` 加 `actor_run_id TEXT`。
- MCP：`apps/mcp/src/server.ts` 在建立 server 時產生一次 `randomUUID()`，傳給 `auditRead` 與寫入工具；`extractAgentReadRecords` 依回應欄位位置標 section。
- 資料規則：run id 不是專案內容，匯出時可略過；專案永久刪除時隨列刪除（現有 CASCADE 已涵蓋）。依 `worklog-backend` skill 檢查匯出／匯入與搜尋索引不受影響。
- 驗收：合成測試證明 section 分類正確；`eval:value` 能分別輸出「路徑命中提供率」與「最近清單曝光率」；真實資料收集 2 週後，重算 M2／M3，並與本文件的時間窗近似值比較差距。
- 風險：多段對話共用一個 process 時 run 混淆。可量化方法是看同一 run 內 finalize 的 Session 數分布，若常大於 1，就以 finalize 切段。

## 借鑑對象

只借鑑做法，不複製程式碼。查證狀態：「已讀」表示讀到原頁；「摘要」表示只看到搜尋摘要，原網域在此環境無法解析。

| 對象 | 網址 | 解決什麼 | 可借鑑 | 不適用 | 授權 | 查證 |
| ---- | ---- | -------- | ------ | ------ | ---- | ---- |
| GitHub Copilot agentic memory | github.blog（2026-01 文章） | 跨 Agent 重複探索 repo | 記憶附程式碼位置引用，使用當下驗證引用；長期未用者過期；植入假記憶的壓力測試 | 驗證由 LLM 執行；本專案改用確定性檢查（S4） | 閉源 | 摘要 |
| Mem0 | github.com/mem0ai/mem0 | Agent 長期記憶 | 評估同時報準確率、注入 token 數與延遲 | 依賴 LLM 抽取、embedding、向量庫 | Apache-2.0 | 已讀（評估數字為廠商自報） |
| Zep / Graphiti | github.com/getzep/graphiti | 事實隨時間改變 | 雙時間軸：失效而不刪除、可查詢當時狀態（對應 A3 的 `knowledge_audit` 重建） | 需要圖資料庫與 LLM | Apache-2.0 | 已讀（欄位名僅摘要） |
| Aider repo map | github.com/Aider-AI/aider（repomap 文件） | 給模型精簡的 repo 地圖 | 固定 token 預算加排序截斷，注入量不隨資料成長 | tree-sitter 與圖排序是額外依賴 | 未查證 | 已讀 |
| Cursor rules | docs.cursor.com | 規則注入 | 依 glob 自動附加，正是 appliesTo 的思路 | 人工撰寫的規則，不是觀察到的記憶 | 閉源 | 摘要 |
| Cline Memory Bank | docs.cline.bot | 專案記憶檔 | 檔案責任切分 | 完全靠 Agent 自我維護，正是要避免的 | Cline 主 repo Apache-2.0 | 摘要 |
| Basic Memory | github.com/basicmachines-co/basic-memory | Markdown + SQLite 的 MCP 記憶 | 原子化 observation；工具 read-only／destructive 標註 | 預設向量搜尋 | AGPL-3.0（只借概念） | 已讀 |
| MCP memory server | github.com/modelcontextprotocol/servers（src/memory） | 最小記憶實作 | 參考實作的簡單度 | 無時間有效性、無使用訊號 | MIT | 已讀 |
| LongMemEval | arXiv 2410.10813 | 長期記憶 benchmark | 分桶：知識更新、時間推理、棄答；可用來分類 `eval:recall` 題庫，特別是「過時知識不該被回傳」 | 對話記憶，不是程式碼工作 | 論文，方法 | 摘要 |
| trec_eval | github.com/usnistgov/trec_eval | IR 評分 | 指標定義固定、可離線重算（`eval:recall` 已採用 hit@k、MRR） | 需要人工相關判斷 | 未查證 | 已讀 |
| Joachims 2002；Radlinski 等 CIKM 2008 | 論文 | 隱式回饋 | 隱式訊號轉成相對判斷；絕對指標在小樣本下不可靠，比較兩版時優先用成對設計（凍結快照新舊對照） | interleaving 需要線上流量 | 論文，方法 | 摘要 |
| Doubly robust 離線評估（Dudík 等 2011） | 論文 | 用舊 log 評估新策略 | 說明為什麼用歷史讀取紀錄評估新排序有偏差（A3） | 需要記錄曝光傾向，單人工具過重 | 論文，方法 | 摘要 |
| Ragas | github.com/explodinggradients/ragas | RAG 評估 | 不需 LLM 的 ID-based context precision／recall，對應 M2／M3 的 id 比對 | LLM 變體 | Apache-2.0 | 已讀 |
| Langfuse | github.com/langfuse/langfuse | LLM 觀測 | 指標以「名稱、型別、對象」儲存，便於 `--json` 快照版本化 | 雲端平台、LLM 評審 | MIT（ee 除外） | 已讀 |
| Arize Phoenix | github.com/Arize-ai/phoenix | 追蹤 | 只參考追蹤概念 | ELv2 限制 | Elastic License 2.0 | 已讀 |
| Evidently | github.com/evidentlyai/evidently | 資料漂移 | 「參考窗口 vs 目前窗口」加上通過／失敗條件，對應 `--split` | 偏 ML 套件 | Apache-2.0 | 已讀 |
| Great Expectations | github.com/great-expectations/great_expectations | 資料單元測試 | 宣告式規則加自動報告，對應 M6 的完整率門檻 | Python 生態 | Apache-2.0 | 已讀 |
| dbt source freshness | docs.getdbt.com | 資料新鮮度 | warn_after／error_after 門檻，對應 S4 的審閱門檻 | — | Apache-2.0（核心） | 摘要 |
| Backstage Tech Insights | github.com/backstage/backstage | 工程品質評分 | facts → checks → scorecard 三段式 | 需要 Backstage 平台 | 主 repo Apache-2.0；Tech Insights 未查證 | 已讀（README） |
| Guru 驗證週期、Stack Overflow content health | 官方說明頁 | 知識庫腐化 | 過期是「待驗證」而非刪除；「過期且常被查」的優先清單（S4、S5） | 人工驗證者制度 | 閉源 | 摘要 |
| DORA rework rate、SPACE | dora.dev、ACM Queue 2021 | 交付量測 | 不用單一指標；至少一項感知指標（A4） | 部署概念不適用單人本機 | 方法 | 摘要 |

## 真實資料量測

來源：上層在使用者**可攜式匯出檔**匯入的暫存庫上執行 `value-metrics-probe.mjs`（self-check 通過，92 ms）。6 專案、639 筆有效 Session、146 筆 Knowledge。**匯出檔不含讀取稽核（reads = 0）**，所以所有依賴稽核的欄位（提供率、最近清單、干擾率、上下文成本、重疊）都沒有值；這本身就是本輪最重要的發現（結論 4）。

### 按月（2026-07 至 11）

| 指標 | 07 | 08 | 09 | 10 | 11 |
| ---- | -: | -: | -: | -: | -: |
| Session 數 | 10 | 11 | 256 | 194 | 168 |
| 作廢 % | 0 | 0 | 0.8 | 2.5 | 2.3 |
| 變更檔已確認 % | 70 | 54.5 | 97.7 | 100 | 100 |
| 有 commit % | 0 | 0 | 84 | 93.8 | 89.9 |
| 驗證 passed % | 70 | 45.5 | 98.4 | 100 | 100 |
| 每 100 Session 新增 Knowledge | 0 | 0 | 17.2 | 21.1 | 36.3 |
| 新 Knowledge 設 appliesTo % | - | - | 63.6 | 80.5 | 86.9 |
| 新 Knowledge 至今仍 active % | - | - | 38.6 | 68.3 | 98.4 |
| 有路徑機會的 Session % | 0 | 0 | 10.5 | 18 | 63.7 |
| 機會數 | 0 | 0 | 78 | 52 | 312 |
| applied 回報／機會 % | - | - | 1.3 | 13.5 | 1.3 |
| applied 回報數 | 0 | 0 | 10 | 52 | 11 |
| applied 中路徑一致 % | - | - | 10 | 13.5 | 36.4 |
| 72 小時再改動 %（背景資訊） | 0 | 9.1 | 74.6 | 47.9 | 57.7 |
| 新增未結項 | 0 | 0 | 348 | 791 | 611 |
| Agent 結案（皆帶 actor Session） | 0 | 0 | 19 | 515 | 388 |
| Web 手動結案 | 0 | 0 | 0 | 596 | 204 |
| 附依據結案 % | - | - | 100 | 46.4 | 65.5 |

`startedAt` 與 `updatedAt` 各月皆約 100%，`contradicted`、清理提案結案、重開皆為 0。

### 按專案歷史深度

| 指標 | 0–49 | 50–199 | 200–999 |
| ---- | ---: | -----: | ------: |
| Session 數 | 234 | 255 | 150 |
| 有 commit % | 71.8 | 94.1 | 93.3 |
| 每 100 Session 新增 Knowledge | 35 | 12.9 | 20.7 |
| 有路徑機會的 Session % | 24.8 | 18.4 | 42.7 |
| 機會數 | 197 | 77 | 168 |
| applied 回報／機會 % | 2.5 | 7.8 | 0.6 |
| applied 回報數 | 5 | 18 | 50 |
| applied 中路徑一致 % | 100 | 33.3 | 2 |
| 72 小時再改動 % | 53 | 64.3 | 62.7 |
| Agent 結案／Web 手動結案 | 353／189 | 323／488 | 246／123 |
| 附依據結案 % | 65.1 | 39.8 | 66.7 |

沒有 1000 筆以上的桶；200–999 桶只來自 2 個專案。

### 判讀

- **能下的結論**：
  - 記錄完整度在 2026-09 之後穩定在 90–100%（commit、變更檔確認、驗證）。這與產品引導改善的時間吻合，但無法分出「保存當下就有」與「事後補填」（A1 M6）；`startedAt` 近 100% 已知主要來自批次補填。
  - Knowledge 的品質形狀在變好：新 Knowledge 設 appliesTo 的比例 63.6% → 86.9%。但「至今仍 active」由 38.6% 升到 98.4%，大部分只是新記錄還沒老化，不是品質訊號。
  - Agent 的 applied 回報不可用：機會上的回報率 1.3%／13.5%／1.3%，路徑一致只有 10–36%，與上層先前彙總（75 筆中 63 筆無關）一致。主題 B 不採用 Agent 表態的判斷成立。
- **不能下的結論**：
  - 「有路徑機會的 Session」由 10.5% 升到 63.7%，主要反映 Knowledge 數量與 appliesTo 覆蓋的成長，本身不是品質指標。它只是 M2 的分母規模。
  - `--split 2026-11-13` 的 after 桶只有 7 筆，且幾乎全是 1.6.32 安裝前的行為，不能當成 1.6.32 的效果；其附依據結案率 2.3% 是當天 Web 批次結案 172 筆造成的。
  - 深度表的差異與版本、日曆時間共變（A3），目前分不出「用得越久越好」與「產品版本變好」。
- **applied 路徑一致率隨深度由 100% 降到 2%**：分子分母是 5、18、50 筆回報，0–49 桶的 100% 只有 5 筆，沒有意義。200–999 桶 50 筆回報中只有 1 筆與變更檔路徑一致，可能原因有三：
  1. 深專案的 Knowledge 多屬通用流程或規範，本來就不綁這次改的檔案（未設 appliesTo，或範圍寬但不涵蓋）；
  2. 少數 Session 一次回報多筆 applied（敷衍式全選）；
  3. 回報的 Knowledge 與當次工作確實無關。
  雛形目前沒有拆「回報的 K 有沒有設 appliesTo」與「每個 Session 回報幾筆」。這兩個拆分應加進 `eval:value`，才能區分 1 與 2、3。無論哪一種，都不支持把 applied 回報當作再利用的證據。

### 單一使用者、小樣本下的判讀規則

- 每個比例都同時輸出分子與分母；分母少於 30 的格子標為「只看趨勢」，不寫進發行說明的效果宣稱。
- 比例的變化要附 95% Wilson 信賴區間。以 M2 為例：100 個機會上 5% 對 10% 的差距，區間重疊，不能宣稱改善。
- 以目前規模（每月數百 Session、每月數十到數百個機會）來看：
  - **有統計意義**：M6 完整率、M4 結案來源的絕對數、M1 每 100 Session 的 Knowledge 數與 appliesTo 比例。這些每月分母是數百。
  - **只能看趨勢**：M2、M3（機會數每月 50–300，且只在本機有稽核）、applied 相關、各深度桶內的任何版本比較、`--split` 後的小桶。
  - **不判讀**：沒有對照組的效益指標（A4）。
- 有些比較在凍結快照上用新舊程式碼做（例如 1.6.32 的 337 個機會、R2／P5 的重算），樣本是同一批機會、成對比較，比跨時段的比例可信得多。發行說明的效果數字應優先用這類比較。

## 未能查證的事項

- 1.6.33 的內容與「九成命中來自最近 12 筆」：repo 內沒有 1.6.33 文件，數字來自上層。
- github.blog、docs.github.com、arxiv.org、dora.dev、docs.ragas.io、opentelemetry.io 等網域在本環境無法解析；相關內容只看到搜尋摘要（表中標「摘要」）。
- OpenTelemetry GenAI 語意慣例的欄位細節、Aider 與 trec_eval 的授權、LoCoMo 原論文：未查證。
- 20,000 Session 上 `getContext` 回放的實際耗時：沒有量測，只依 5,000 Session 的數字外推。
- 讀取稽核在真實使用下是否常因鎖忙被丟棄（寫入為 best effort）：未量測，會讓 M2 偏低。
- M2／M3／M5 的真實數字：上層的資料是可攜式匯出檔，不含讀取稽核，沒有量到。需要使用者在自己機器上執行。
- R2、P5 的交叉驗證數字取自平行研究，本文未重算。

## 附錄：`value-metrics-probe.mjs`

- 執行：`pnpm build` 後 `node docs/experiments/value-metrics-probe.mjs --db <path> [--split <date> | --by-depth] [--json <新檔>]`；不帶 `--db` 時跑合成 self-check。
- 只讀：`DatabaseSync({ readOnly: true })` 加單一讀取交易；不回放、不寫入；`--json` 拒絕覆寫既有檔案。
- 輸出欄位與 A1 對應：M1 `knowledge*`；M2 `offeredPct`、`offeredByContextOnlyPct`、`offeredPossiblyRecentListPct`、`offeredPctUnambiguous`；M3 `offPathPct`、`unscopedPct`；M4 `agentClosures*`、`proposalClosures`、`webClosures`、`groundedClosurePct`、`reopens`；M5 `readsPerSessionMedian`、`returnedPerSessionMedian`、`contextMsMedian`；M6 `*AtPct`、`filesConfirmedPct`、`commitPct`、`branchPct`、`passedPct`；M7 `voidedPct`、`retouched72hPct`、`contradicted`；參考 `appliedPerOpportunityPct`、`appliedPathConsistentPct`。
- 已知近似：沒有 run id，時間窗內同專案的讀取都算給該 Session（`ambiguousPct` 標出重疊比例，`offeredPctUnambiguous` 排除重疊）；「最近 12 筆」以 `knowledge_audit` 中 `after_json.updatedAt` 重建當時排名，只是近似（未計入 tracked 範圍與跨專案模式）；72 小時再改動是混淆很重的代理。
