# 研究 R2：Knowledge 檢索與生命週期（2026-11）

> 調查階段文件，結論先行。只產出結論與可重複的量測設計，不改產品程式碼。
> 真實數字來源：單一專案的 221 組「任務 × 當時適用的 Knowledge」彙總，以及六專案私有副本在本輪新增探針上的彙總輸出（唯讀、只輸出計數／比例／分位數，不含任何記錄文字）。量測腳本見 `docs/experiments/knowledge-task-recall-gap.mjs`、`docs/experiments/knowledge-lifecycle-probe.mjs`。

## 0. 結論摘要（TL;DR）

產品價值取向：有效沉澱 → 精準再利用 → 持續修正，「越用越好用」最重要。本輪兩個主題分別卡在再利用的入口（找不到對的 Knowledge）與修正的訊號（過時與取代幾乎失去鑑別力）。

**最值得先做的三件事（依對「越用越好用」的貢獻排序）：**

1. **Document expansion：把「來源 Session 標題 + 曾 applied 它的 Session 標題」加進 Knowledge 的 FTS 索引，給低於 title 的欄位權重。** 直接對準「只給任務標題只有 5% 命中」的詞彙落差，用的全是已記錄的關聯，不引入向量或 LLM。〔救回數待真實量測填入〕
2. **過時訊號分級，取代現行二元 possiblyStale。** 現行規則在最需要鑑別力的「路徑命中子集」幾乎全標（138/142），分級後 strong 只佔少數，把注意力導向真正可能失效的少數。只用現有資料即可算。
3. **決策「重複」的合併與常設要求升級，而不是「決策演進／取代」視圖。** 真實資料顯示決策之間的取代極少（人工標註 30 對只有 1 對是真取代），真問題是同一句決策被跨 Session 反覆抄錄（灌水審查佇列）；把反覆出現的使用者常設要求升級成專案層級規則，才對應「有效沉澱」。

**建議先做小實驗、暫不投入產品化：** 檔案共變擴展路徑（(d)，依賴 P5 預測品質，誤報直接進 relevant）、決策取代關係欄位（真實素材太少，ROI 低）。

**不建議做：** 改用 FTS5 原生 `bm25()` 多欄位加權（現行已有等效的 chunk 權重機制，遷移成本高、收益小）；引入向量資料庫或額外 LLM（使用者明定邊界）。

---

## 主題 A：只有任務描述時怎麼找對 Knowledge

### A.1 問題大小（數字與來源）

- 單一專案 221 組「任務 × 當時適用的 Knowledge」：只給任務標題時真的依任務找到的只有 **11 組（5%）**；另有 **98 組**只是剛好出現在「不論問什麼都列出的最近 12 筆 Knowledge」清單（`recentKnowledge`，與 task 無關，按 `updated_at DESC` 取 12 筆），Knowledge 一多就會消失。事後已知實際改了哪些檔時可找到 146 組。
- 現行檢索機制（程式碼核對，附位置）：
  - 查詢字串由 `parseQueryWords`（`packages/storage/src/search-text.ts`）斷詞，CJK 切重疊 bigram、拉丁拆 camelCase/snake_case，各詞以 `OR` 串接，上限 32 詞。
  - FTS 索引欄位只有 title / body / tags / references；**`appliesTo` 不進 FTS**，只在帶 `paths` 時於記憶體比對。只給 task 沒有 paths 時 `appliesTo` 完全不參與。
  - 欄位權重不是 FTS5 原生 `bm25()` 參數，而是每個 chunk 的 `weight` 在 SQL 外相乘（`search-repository.ts`，`FIELD_WEIGHTS`：title 3、tags 2、body 1.5、references 1、raw 0.3）。
  - Knowledge 證據因子：每次 applied +4%（最多 5 次），最新為 contradicted 時 ×0.7。
  - 相關 Knowledge 上限 5 筆；只在有路徑命中時才為 Knowledge 保留最多 3 個名額。只給 task、無路徑時 Knowledge 與 Session 在同一個前 20 池子競爭，Knowledge 少於 5 筆不補位。
  - `recentKnowledge` 12 筆無 query，目前沒有「帶 task 就縮減」的邏輯。
- **P5（1.6.33「由相似 Session 的變更檔依相似度加權、比對 appliesTo」）在目前分支 HEAD 找不到**（git log / docs / CHANGELOG 皆無）。最接近的是 `task-path-replay.mjs` 的 `predict()`（相似 Session 標題 → 變更檔），本研究以它作為「P5-like」基準。量測到的嚴格命中 46–92 組、最激進做法在無適用 Knowledge 任務上多補 72 筆推測指標，為既有實驗結果。

### A.2 P5 之後的缺口來自哪裡

缺口分類（`knowledge-task-recall-gap.mjs`，互斥、依序判定）：

1. `no_applies_to`：Knowledge 沒有 appliesTo。
2. `applies_to_mismatch`：有 appliesTo 但不涵蓋該任務實際變更檔（太窄／錯）。
3. `vocab_gap_expandable`：任務詞與 Knowledge 文字無交集，但與來源 Session 標題或先前 applied Session 標題有交集（document expansion 可救）。
4. `vocab_gap_unrescuable`：擴展後仍無交集。
5. `ranked_outside_budget`：有詞交集卻排在預算／名額外。

〔各缺口比例待真實量測填入〕

### A.3 借鑑對象整理（只借鑑做法，不引入向量／LLM／大型依賴）

| 對象                                                                 | 網址                               | 解決什麼                                                      | 具體機制                                                                 | 可借鑑的一點                                                                     | 不適用的原因                                            | 授權                      |
| -------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------- |
| doc2query（Document Expansion by Query Prediction, Nogueira et al.） | arXiv 1904.08375（僅搜尋摘要）     | 文件用「可能的查詢」擴展後再 BM25 索引，縮小查詢-文件詞彙落差 | 把預測查詢直接附加到文件後，不加標記                                     | 用已記錄的「實際讓此條目命中的任務／Session 標題」取代模型預測，寫入獨立索引欄位 | 原法需 seq2seq 模型；我們改用歷史記錄，冷啟動無效       | 未查證                    |
| Lucene MoreLikeThis                                                  | apache/lucene 原始碼               | 以一篇文件為種子找相似文件                                    | 預設 minTermFreq=2、minDocFreq=5、maxQueryTerms=25；選詞用 tf×idf 取前 N | 以最佳命中為種子取高 tf×idf 詞做第二輪查詢（PRF）                                | Knowledge 條目短，minTermFreq=2 幾乎過濾全部，需下調    | 未查證（Apache-2.0 專案） |
| RM3 / Pyserini                                                       | castorini/pyserini                 | 偽相關回饋擴展查詢                                            | 取前 fb_docs 篇、前 fb_terms 詞加入查詢，原查詢權重 0.5                  | 零命中時取前 3–10 命中抽高 tf-idf 詞以 0.5 權重併回                              | Lucene 版需 document vectors；FTS5 需自算詞頻           | 未查證                    |
| Elasticsearch/Solr 同義詞                                            | elastic/solr 文件（舊版，僅摘要）  | 查詢端同義詞展開不需重建索引                                  | 查詢端展開改詞表免 reindex；先斷詞再展開會讓多詞同義詞失效               | 手寫「症狀↔解法」詞表，**在 CJK 斷詞前**替換查詢字串                             | 需人工維護詞表；斷詞後展開會失效                        | 未查證                    |
| code-maat                                                            | github.com/adamtornhill/code-maat  | 從 git 歷史算檔案共變（logical coupling）                     | `-a coupling`，預設 min-revs=5、min-coupling=30%、max-changeset-size=30  | 把任務提到的／diff 的檔案擴展到常共變檔，再比對 appliesTo                        | 需 git 歷史；只有標題時無檔案可用；co-change 預測 F≈30% | GPL v3.0                  |
| Aider repo map                                                       | Aider-AI/aider `repomap.py`        | 用圖排序決定放進 context 的程式碼                             | PageRank personalization；提及識別字 ×10、長具體詞 ×10、泛用詞 ×0.1      | 任務詞當種子；泛用詞降權、長具體詞加權，可搬到 Knowledge↔詞 圖                   | 本體針對程式碼符號                                      | 未查證（Apache-2.0 專案） |
| Sentry 事件分組                                                      | getsentry/sentry-docs              | 把相似錯誤歸到同一 issue                                      | 分層鍵：fingerprint → stack（in-app）→ type+value → 去參數化 message     | 症狀比對採分層鍵：錯誤碼／識別字優先，其次類別，最後去參數化訊息                 | AI grouping 需嵌入；非 AI 部分適用                      | 未查證                    |
| Cline Memory Bank                                                    | nickbaumann98/cline_docs（已停維） | 固定檔案集、每次全讀、無檢索                                  | 六個固定 md 檔每次任務全讀                                               | 條目少（數十條內）時零命中 fallback：列全部標題 + 一行摘要                       | 規模大會超出 context                                    | 未查證                    |

### A.4 可行做法比較（在不引入向量／LLM 的邊界內）

| 做法                                         | 機制                                                                               | 改動範圍                                                                                                                                                    | 複雜度           | 預期效果如何量測                                     | 失敗時的退路                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------- | ---------------------------------------------------------------- |
| **(a) Document expansion**                   | 來源／applied Session 標題加入索引新欄位（如 `origin`），權重低於 title            | `search-repository.ts`（loadKnowledge 加 chunk、prepareIndexReads 加 2 查詢、FIELD_WEIGHTS）；`knowledge_feedback` INSERT 與 `sessions.title` UPDATE 要標髒 | 中               | 重播 hit@5 升幅；`vocab_gap_expandable` 中多少被救回 | 擴展詞權重調低或關閉；派生資料不需動匯出                         |
| **(b) FTS5 bm25 多欄位**                     | 改用 FTS5 原生多欄 bm25                                                            | FTS 表改多欄 + 重建                                                                                                                                         | 高               | —                                                    | **不建議**：現行 chunk 權重已等效，改調 `FIELD_WEIGHTS` 數字即可 |
| **(c) 症狀詞彙表（歷史自動累積）**           | 任務標題 ↔ 最後 applied 的 Knowledge，查詢端即時 join 計算，加最低支持數、濾通用詞 | 先驗證可不建表（查詢端 `knowledge_feedback ⋈ sessions.title`）；產品化需新表 + 匯出入 + 永久刪除                                                            | 查詢端低、建表高 | support=1/2 下救回數與誤報                           | 支持數門檻上調；關閉                                             |
| **(d) 檔案共變擴展路徑**                     | 同 Session 共變檔擴展 queried paths 再比對 appliesTo                               | `scorePaths`/`scoreAppliesTo` 前加展開；依賴 P5 落地                                                                                                        | 中               | P5-like 與共變額外各自救回／誤報                     | **先小實驗**：誤報直接進 relevant，須先量                        |
| **(e) recentKnowledge 帶 task 時降位／縮減** | 命中後才列 recentKnowledge，或縮到 3–5 筆                                          | `context-recall-service.ts` buildContext / fitContextBudget                                                                                                 | 低               | 縮減後「看見」的 Knowledge 變化、重用率              | 保留但降位，不整個拿掉（目前 44% 靠它被看到）                    |

### A.5 建議（做／不做／先做小實驗）

- **做**：(a) document expansion — 最直接對準詞彙落差，資料現成。(e) recentKnowledge 帶 task 時降位（低風險、先量）。
- **先做小實驗**：(c) 症狀詞彙表以查詢端 join 驗證，不先建表；(d) 共變擴展先在重播量誤報。
- **不做**：(b) FTS5 原生多欄 bm25。

---

## 主題 B：Knowledge 的生命週期

### B.1 問題大小（數字與來源）

真實六專案私有副本（本輪探針彙總；全部計數／比例，不含記錄文字）：

- **過時訊號飽和**：active 且有 appliesTo 的 Knowledge 76 筆，基準 possiblyStale 37 筆（**49%**）。在「路徑命中子集」（context 帶 paths、命中該 Session 即將改到的檔案）則是 **138/142**——幾乎必然過時，飽和正好發生在最需要鑑別力的地方。
- **audit 低資訊**：330 筆 audit，updated 145；其中 **confirm_only 104 筆（佔 updated 72%）**，confirm_only 中 75 筆來自 Agent 的 applied 回報、29 筆手動。updated 同時帶確認的有 123 筆。
- **取代幾乎沒用**：`supersedes_id` 全資料只用過 **3 次**；1,298 條決策之間沒有任何取代關係。
- **決策相似度啟發式抓到的是「重複」不是「取代」**：含修訂語彙的決策 158/1298（12%）；相似度門檻 0.3 下疑似取代 53 組，但人工標註 30 對（--reveal，只回計數）只有 **6/30「後者確實修改前者」，其中真正改變做法的只有 1 對**，其餘為細化；24 對是同一決策在相鄰 Session 幾乎原文重述（7 對逐字相同，數對只差版本號）。revision cue 在候選中的比率（7–10%）甚至低於非候選（12%）。

### B.2 要回答的三問

**(1) 如何讓過時訊號恢復鑑別力。** 只用現有資料可算的分級訊號（探針 `signals`／`proposedTiers`）：

- `structural`：後續變更把命中檔案 deleted/renamed（強訊號）。
- `identifierHit`：Knowledge 文字中的識別字（backtick/camelCase/snake_case token）出現在後續變更 Session 的標題／摘要／決策（「觸及引用符號」代理）。
- `allBroad`：每個後續變更 Session 都是大範圍掃改（≥21 檔），弱訊號。
- `lineage`：變更來自同一輪工作（session_links 或 24 小時內），弱訊號。
- 分級提案：strong = 刪除/改名或符號命中；weak = 僅大範圍掃改或僅同脈絡；其餘 moderate。真實分布 strong 9 / moderate 16 / weak 12。
- **需新記錄才能算**：變更行數/幅度、變更是否真的碰到被引用符號（需 diff/symbol 層級）。
- 反事實（探針擴充中）：若 applied 須帶路徑證據才推進確認基準、或只有 manual_confirm 推進，過時比例與分級分布各是多少。這關係到「以 applied 宣稱延後過時判斷是否反而讓訊號失真」——R1 量測顯示 applied 與適用路徑一致比例在專案累積 200 筆以上時僅 2%，confirm_only 又佔 updated 72%，確認幾乎全靠低一致性的 applied 宣稱推動。

**(2) 降低確認/修訂/取代/淘汰成本且不污染（Evidence-first）。** 現有介面成本（程式核對）：

- 確認：`work_update_knowledge {confirm:true}` 1 呼叫 3 欄位；或 finalize 的 `appliedKnowledgeIds`（零額外呼叫，但這正是 confirm_only 灌水來源）。
- 修訂：`work_update_knowledge` 帶新內文，存 before/after 完整 snapshot。
- 取代：`work_record_knowledge {supersedesId}`，建新條目並自動封存舊條目——Agent 須主動帶 id。
- 淘汰：`work_update_knowledge {status:"archived"}`。
- **沒有程式層阻擋已確認 Knowledge 被改寫**：保護靠 skill 規範與不可變 audit，任何 Agent 可直接 update 內文。
- Evidence-first 的落點：applied 宣稱不等於證據——建議「applied 推進確認基準」須有路徑一致性佐證（反事實量測後決定）。

**(3) 決策取代關係。** 真實資料顯示素材太少：30 對疑似只有 1 對真取代，其餘是重複。因此：

- 決策演進／時間線視圖在目前資料上**缺乏素材，ROI 低**。
- 更有價值的是：(a) 重複決策的合併／去重呈現；(b) 把跨 Session 反覆出現的使用者常設要求辨識出來、升級成專案層級常設規則（對應「有效沉澱」，也是高價值 Knowledge 來源）。探針擴充 `decisionDuplication` 量測逐字/版本號正規化群、近重複群、跨 ≥3 Session 的 user_requested 群。

### B.3 借鑑對象整理

| 對象                          | 網址                       | 解決什麼                         | 具體機制                                                                                          | 可借鑑的一點                                                 | 不適用的原因                                   | 授權           |
| ----------------------------- | -------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------- | -------------- |
| Swimm auto-sync               | swimm.io（僅摘要）         | 程式碼改動時偵測文件過期         | 驗證檢查被引用的 snippet/token/path 是否仍對應；改名刪除可追蹤；演算法判斷變更是否「重要」        | 以「被引用符號是否變動」為觸發，而非「檔案有沒有被改」       | 演算法未公開、依賴 AI/靜態分析                 | 商業，未查證   |
| difftastic                    | Wilfred/difftastic         | 比語法結構而非逐行               | 以語法樹比較，可辨識空白是否有語意                                                                | 判斷「改動是否影響規則」前先過濾純排版變動                   | CLI 工具，需二次解析 diff；大改動效能差        | MIT            |
| GumTree                       | GumTreeDiff/gumtree        | 語法感知差異，偵測 moved/renamed | 語法樹 edit action                                                                                | 把「移動/改名」與「刪除+新增」分開                           | edit action 類型未在 README 列全               | 未查證         |
| Stack Overflow Content Health | stackoverflow.co（僅摘要） | 可能過時內容排成審查佇列         | 依年齡與使用量排序；設日期門檻與健康門檻                                                          | 把「過期」改為**排序與佇列**而非布林旗標，按使用量排序       | 商業產品                                       | 未查證         |
| Guru verification             | getguru.com（僅摘要）      | 卡片驗證週期                     | 每卡有 verifier + 驗證間隔（不過期～1年），到期才提醒                                             | 驗證由「時間+負責人」驅動，確認後延長間隔                    | 商業，有人工成本                               | 未查證         |
| GitHub CODEOWNERS             | github/docs                | 路徑綁負責人觸發審查             | 改指定路徑自動請求審查（不阻擋合併），最後匹配規則為準                                            | 把「誰負責這塊知識」綁路徑，觸發**通知負責人**而非標過期     | 需搭配 branch protection 才強制                | 未查證         |
| adr-tools                     | npryce/adr-tools           | ADR 建立與取代                   | `adr new -s 9 <標題>` 一動作完成：新檔標記取代 9、舊檔狀態改已取代                                | 取代由「建立新紀錄」同一動作完成，寫入成本極低，責任在建立者 | 只更新前後兩份，不處理其他引用舊 ADR 者        | 未查證         |
| Kubernetes KEP                | kubernetes/enhancements    | ADR 狀態與雙向取代               | status 七值含 replaced，須搭 superseded-by；新 KEP 用 replaces，舊的 superseded-by 指回，雙向連結 | 雙向欄位 + 有限狀態列舉可被機器檢查                          | 未規定由誰負責把舊 KEP 改 replaced（流程缺口） | 未查證         |
| MADR                          | adr/madr                   | ADR 模板                         | status: superseded by（README 未含，不引用細節）                                                  | —                                                            | README 未含取代語法                            | MIT OR CC0-1.0 |
| log4brains                    | thomvaill/log4brains       | ADR 管理                         | ADR 基本不可變，只有狀態可變                                                                      | ADR 內容不可變、只改狀態的原則                               | 無自動建立連結或取代提示                       | Apache-2.0     |

備註：adr.github.io、rfc-editor.org、peps.python.org、martinfowler.com、Swimm/Guru/SO 官方頁在本輪 session 網路無法直接讀取，標「僅摘要」者來自搜尋摘要；「ADR 應不可變」的 Nygard 原句未查證。

### B.4 建議（做／不做／先做小實驗）

- **做**：過時訊號分級（B.2-1，只用現有資料，取代二元 possiblyStale）；決策重複的去重呈現 + 常設要求升級（B.2-3 的 a、b）。
- **先做小實驗**：以「applied 須帶路徑證據」調整確認基準（先跑反事實量測，確認能恢復多少鑑別力再動）。
- **不做／暫緩**：決策取代關係欄位與決策演進視圖（真實素材 30:1，ROI 低）；自動改寫已確認 Knowledge（違反 Evidence-first）。

---

## 附錄：建議項目的範圍、風險、驗收指標、工作量

〔待真實檢索缺口數字回填後補完每項的驗收門檻與工作量估計〕

| 建議                       | 範圍                              | 風險                           | 驗收指標                                                           | 預估工作量           |
| -------------------------- | --------------------------------- | ------------------------------ | ------------------------------------------------------------------ | -------------------- |
| A-(a) document expansion   | search-repository 索引欄位 + 標髒 | 泛用標題污染、索引未標髒讀舊值 | 重播 hit@5 相對提升；vocab_gap_expandable 救回比例；無新誤報進前 5 | 中（1–2 人日含測試） |
| A-(e) recentKnowledge 降位 | context-recall-service            | 降低「偶然看見」的重用         | 帶 task 時命中優先；重用率不下降                                   | 小（0.5 人日）       |
| B 過時分級                 | knowledge-service staleness 計算  | 分級規則需校準                 | strong 子集精確率；possiblyStale 飽和下降                          | 中                   |
| B 決策去重/常設升級        | session-decision + 新呈現         | 去重誤判合併不同決策           | 重複群數下降；常設規則產出數                                       | 中                   |

## 附錄：量測腳本

- `docs/experiments/knowledge-task-recall-gap.mjs`：唯讀、單一 read transaction、時間序重播，缺口分類與 (a)(c)(d) 救回／誤報估計；`--self-check` 以合成資料驗證且斷言輸出無記錄文字。
- `docs/experiments/knowledge-lifecycle-probe.mjs`：唯讀；過時分級訊號、audit 型態、決策取代／重複啟發式；`--reveal` 僅限資料擁有者本機、輸出不可回傳。

## 未能查證的事項

- P5 / 1.6.33 的實際實作不在本分支 HEAD，所有「P5 之後」評估以 task-path-replay 的 predict() 為代理。
- 「221 組」定義取自 task-path-replay.mjs 腳本，非文件明述。
- 多個借鑑來源官方頁無法直接讀取，標「僅摘要」。
- 檢索缺口的真實分類比例與各做法救回數，待私有副本執行後回填。
