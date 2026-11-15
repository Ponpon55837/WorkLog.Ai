# 檢索可信度五個方向的可行性研究

研究日期：2026-11-15。這是可行性研究，不是實作：沒有改 `packages/`、`apps/`、`tests/` 下的程式碼，沒有升版，也沒有 schema 變更。

## 借鑑來源與授權

- 來源：SelfGraph（github.com/hydra-db/selfgraph，Apache-2.0）。讀的是 commit `8124bee74334e9a5555afa52ce2d05ffc93b89d4`：
  - 文件：README、`docs/trust.md`、`docs/tiers.md`、`docs/maintenance.md`。
  - 實作這五個機制的原始碼：`src/selfgraph/retrieval.py`、`tiers.py`、`_maintenance.py`、`resources/relations.py`、`resources/maintenance.py`。
- 只借觀念，沒有使用、複製或改寫它的程式碼。clone 放在 session 暫存區，沒有進入本 repo，也沒有執行它的任何程式。
- SelfGraph 的儲存層一律是圖資料庫，排序可以選用 embeddings 與 LLM，這些都在本專案的界線外。下文只比較其中確定性、不需模型的部分。

## 資料與量測說明

兩種量測分開標示。

### 合成資料量測

- 用 `retrieval-trust-probe.mjs --self-check` 產生虛構資料庫，在本容器執行。
- 規模：3 個專案，約 80 個 Session。
- 植入的案例：熱門檔案、格式錯誤的變更檔欄位、補登的 finalize、還原舊版、超過 20 檔的 Session 等。
- 只用來證明「機制存在、行為如此」，不代表盛行率。

### 真實資料量測（由協調端執行）

- 協調端在私有副本上跑同一支探針，只回傳彙總數字。本報告不含任何記錄內容。
- 協調端用過的探針版本依序是 commit `47984e9`、`b25a3c8`、之後的上限量測版，以及 `0344ada`（appliesTo 寬度與帶路徑召回）。每次都是 exit 0、沒有錯誤；`0344ada` 那次用 `--sections 1,4 --sample 356`。
- 資料規模：
  - 單一專案，356 個未作廢 Session，第二次全數抽樣。
  - 其中 291 個有變更檔，共 872 條不同路徑；75 個 Session 改動超過 20 個檔案。
  - Knowledge 80 則：active 47 則、archived 33 則；Knowledge 頁 3 個。
- 執行條件：副本中專案狀態是 paused，根路徑在協調端本機不存在，第一次跑出來全部是 0。之後改用探針的 `--treat-all-tracked`，它只在暫存副本上把專案設為 tracked，並把根路徑指到空目錄。
- 限制：
  - 只有一個專案。
  - 部分量測沒有依時間切片，各處另有註明。

### 探針

```
pnpm build
node docs/experiments/retrieval-trust-probe.mjs <資料庫路徑> [--treat-all-tracked] [--sample 200] [--seed 1] [--sections 1,2,3,4,5] [--hub-share 0.2] \
  [--context-sample N] [--related-sample N] [--pair-sample N] [--window-pair-sample N] [--hotspot-limit N]
WORK_INTELLIGENCE_DB=<資料庫路徑> node docs/experiments/retrieval-trust-probe.mjs
node docs/experiments/retrieval-trust-probe.mjs --self-check
```

- 讀取方式：來源以 `readOnly` 開啟，用 `VACUUM INTO` 複製到 0700 暫存目錄。store、migration 與反事實修改都只發生在暫存副本上，結束時（包括出錯）刪除。
- 輸出：只有計數、比例、分位數、直方圖與布林值。印出前會掃描輸出，確認沒有出現資料中的 id、標題、專案名、根路徑或變更檔路徑；發現就以 exit 2 結束，不輸出。
- tracked 專案為 0 時，在 stderr 印固定警告，並在輸出加 `warnings`。
- 前後版比較：回應形狀改版後的欄位（`knowledgeConfidence`、`matchedVia`、`broadChangesSince`、`possiblyStale.reason`、`appliesToBreadth`、`termHitsTruncated`）都以容錯方式讀取，舊版 build 上缺欄位時計為 `(absent)` 或 0，同一支探針可在前後兩版各跑一次；輸出的 `productShape` 是兩個布林值，標明所跑的 build 是否有這些欄位與唯讀的寬度掃描。新增量測在 `answerability`（`knowledgeConfidence` 各分布、`knowledgeSearch.fallbackTermHits`）、`producedBy`（同義詞命中、`matchedInLengthHistogram`）、`protection.stalenessShape` 與 `protection.writeTimeBreadth`；說明見探針檔頭註解。

## 結論摘要

| 方向 | 結論 | 真實資料證據 | 規模 | 建議 |
| --- | --- | --- | --- | --- |
| 1 可回答性檢查 | **需要，但做法要改**。逐詞訊號（`termHits`）已經有了，也正確；問題在 `confidence` 是 Session 與 Knowledge 合算的，無法回答「有沒有這方面的 Knowledge」。不需要 SelfGraph 式的獨立檢查 | Session 自己開工前的查詢中，正例（確實套用過事先存在的 Knowledge）與負例的 `confidence` 分布幾乎一樣；`getContext` 50 次中 41 次沒有 Knowledge，`confidence` 卻全是 high | 小 | 分開回報 Knowledge 的 confidence；修 `termHits` 誤報。實際用過的 Knowledge 約 82% 送不到 Agent，帶不帶路徑都一樣，屬於資料面問題，列為後續題目 |
| 2 結果由哪一級方法產生 | **部分已有**。relaxed、`includedBecause`、`matchedPaths` 都有標；只靠同義詞命中的結果沒有標，MCP 也把 `matchedIn` 裁成只剩一個 | 97% 的命中 `matchedIn` 超過一個欄位，MCP 只給第一個 | 小 | 做最小補標 |
| 3 樞紐節點 | **缺口存在，但真實影響小於預期**。所有用路徑連結 Session 的功能都不依常見程度加權；真實資料中，相關工作結果只靠樞紐的比例是 12–16%。熱點前 10 名被例行檔佔滿，但用頻率分不出例行檔與核心大檔 | 相關工作 12.4%（樞紐門檻 20%）／16.2%（門檻 10%）；排除樞紐路徑，過時從 22 只降到 21；熱點前 10 名中約 6 個是例行檔 | 中 | **先不做**。下修優先度，等有更多專案的資料再評估 |
| 4 人確認過的知識的保護 | **不需要保護機制，但過時判斷本身要修**。確認後仍會被標為可能過時是合理的；真正的問題是過時判斷被大範圍改動淹沒：其他功能都排除超過 20 檔的 Session，只有過時判斷沒有 | 有 appliesTo 的 active Knowledge 中 63% 可能過時；排除超過 20 檔的 Session 後降到 17%（22→6）；被確認過的 7 則降到 2 則 | 小 | **第一版最優先**：兩個訊號並用。超過 20 檔的 Session 不單獨觸發，改回報 `broadChangesSince`；另加 appliesTo 寬度提示，處理被反覆觸發的那一群 |
| 5 健檢清單 | **不需要**。11-07 的真實資料量測為 0，本次也一樣；知識頁來源失效已由 `needsReview` 涵蓋 | 孤立、作廢來源、新舊版衝突、格式錯誤的變更檔都是 0；只有已作廢 Session 的確認紀錄有 2 筆 | 小 | 不做健檢頁。讀取容錯與生命週期缺陷屬於潛在缺陷，可以順手修 |

整體建議放在最後一節。

---

## 方向 1：可回答性檢查

### SelfGraph 的做法（讀原始碼確認）

- 問題的處理（`retrieval.py` `_question_terms`）：
  - 先正規化（NFC、casefold），再切詞，去掉停用詞與填充詞。
  - 能對上已存名稱的多字片語，先合併成一個詞。
- 每個詞依序比對實體名稱或別名、類型、定義、關係類型、屬性鍵。比對方式是詞幹相等或子字串（`_covers`），沒有模糊比對。
- 判定沒有分數門檻：
  - 全部詞都缺：`not_answerable`。
  - 部分缺：`partial`。
  - 實體之間在 3 跳內不連通，或只經由樞紐相連：`uncertain`。
  - 其餘：`answerable`。
- 整條路徑不用 LLM 或 embeddings。
- 它本身的問題：
  - 子字串比對很寬，例如「Ann」會對上「Joanna」。
  - 只靠類型對上的詞不檢查連通性。

### 本專案現況

| 工具 | 查不到或查到很少時，Agent 拿到的訊號 | 程式位置 |
| --- | --- | --- |
| `work_recall`、`work_search` | `confidence`（`none`／`low`／`high`）；只要有任一詞在範圍內 0 筆，就附上全部詞的 `termHits[{term, count}]` | `search-repository.ts` `recall`（約 455–492 行） |
| `work_get_context` | 帶 `task` 或 `paths` 時：`relevant.confidence`、`relevant.termHits`、`omitted[].entries`、`relevant.supplements[].includedBecause` | `context-recall-service.ts` 約 1159–1290 行 |
| `work_search_knowledge`（`searchKnowledgeForAgent`） | `match`（`strict`／`relaxed`／`none`）；零命中時最多 3 筆 `relaxedMatches`，各帶 `matchedTerms`；另有 `otherStatusMatches`、`hint`。**沒有逐詞計數** | `knowledge-search-service.ts` 約 64–155 行 |

`confidence` 的定義是對所有命中合算的：任一筆有路徑命中，或結構化欄位的 IDF 覆蓋率 ≥ 0.5，就是 `high`。`relevant.confidence` 直接沿用 recall 對 Session 加 Knowledge 的結果（`context-recall-service.ts` 約 1253 行），不是 Knowledge 專屬。

### 真實資料量測

**查詢設計**：用 Session 標題（去掉路徑詞）當查詢。

- 第一版沒有排除「查詢自己的 Session 也在索引裡」：196 次全部是 `high`，每次都有 6 筆以上命中。這個設計量不到「查不到」的情況。
- 第二版改用 `to` 篩到該 Session 開始前一天（`answerability.pastOnly`），近似「Agent 在這件工作還不存在時發問」。
- 再依「這個 Session 套用過事先存在的 Knowledge」分成正例與負例。

| 量測（350 次查詢） | 正例（33） | 負例（317） |
| --- | --- | --- |
| `confidence` high／low／none | 3／29／1 | 32／247／38 |
| 有任何 Knowledge 命中 | 3.0% | 1.3% |
| 命中的 Knowledge 就是它實際套用的那則（hit@8） | 1／33（3.0%） | — |

整體上：

- 命中共 2,448 筆 Session、5 筆 Knowledge。
- 有 35 次 Knowledge 為 0，但 `confidence` 是 `high`。
- `termHitsPresentShare` 86%：多數查詢至少有一個詞在過去的資料中完全沒出現。

對照組：

- 只含虛構詞的查詢 196／196 都回 `none`，而且全部詞的 `count` 都是 0。
- 在原標題加 3 個虛構詞時，2／196 失去全部命中，表示未知詞稀釋確實存在但很少。

**量測的限制**：

- recall 的 `to` 以 Knowledge 的 `updated_at` 篩選，之後被人工確認或編輯過的 Knowledge 會被排除。33 個正例中，14 個的正解 Knowledge 全部在開始後被更新過。所以又補量了上限：不篩日期、只排除查詢自己的 Session。
  - limit 8 的 hit@8：0／33。
  - limit 20 的 hit@20：1／33（3%）。
  - 結論：3% 不是時間篩選造成的低估，而是用詞落差。不篩日期時，正例與負例的 `confidence` 全是 `high`，同樣分不開。
- 標題不等於 Agent 實際的查詢，而且 recall 只看文字，不含 `getContext` 的 P5 推測路徑。
- 只有一個專案。

### 判讀

1. **`termHits` 本身是對的**。它正確標出不存在的詞，對照組 100% 正確。這已經就是 SelfGraph 的「缺了哪些詞」。
2. **`confidence` 無法回答「有沒有這方面的 Knowledge」**。
   - 正例與負例的分布幾乎一樣：high 占 9% 對 10%，none 占 3% 對 12%。
   - 原因：Session 幾乎總會命中，87% 的查詢有 6 筆以上，而 `confidence` 是合算的。
   - `getContext` 50 次中 41 次 `relevant.knowledge` 為 0，`relevant.confidence` 卻全是 `high`。Agent 很容易把它讀成「這個任務有可用的知識」。這是真實的誤導。
3. **用任務標題找回 Knowledge 的召回率很低，但這不是本方向能解決的**。
   - 產品實際路徑也量了：`getContext` 只帶任務文字，含 P5 推測路徑與一層補充，未依時間切片，數字偏樂觀。33 個正例中：
     - 正解在 `relevant.knowledge`：1 個。
     - 在補充結果（全部是 `applied_knowledge`，也就是相關 Session 套用過的 Knowledge）：5 個。
     - 哪裡都沒有：27 個（82%）。
   - 也就是說，只給任務文字時，實際用過的 Knowledge 約八成送不到 Agent 手上。
   - 再量帶路徑的情況（`pathRecallBaseline`：`getContext` 帶任務文字加該 Session 的變更檔，同樣未依時間切片）：
     - 33 個正例中，正解有 appliesTo 的只有 6 個（18%）；appliesTo 涵蓋該 Session 變更檔的只有 2 個（6%）。
     - 正解在 `relevant.knowledge`：2 個；在補充結果（全部是 `applied_knowledge`）：4 個；哪裡都沒有：27 個（82%），和只帶文字完全相同。
     - 負例 50 次中，`relevant.knowledge` 非空的比例從只帶文字時約 22% 升到 74%（37／50）。這些都是該 Session 沒有用到的 Knowledge，是路徑比對的雜訊代價。來源和方向 4 的寬 appliesTo 相同：19% 的 appliesTo 條目很寬，29% 的 Knowledge 至少有一條。
   - 所以缺口不在 Agent 有沒有帶路徑，而在資料：被實際用到的 Knowledge 大多沒有 appliesTo，或 appliesTo 和實際使用的場景不重疊。見「整體建議」的後續題目。
   - R2（`research-2026-11-knowledge-retrieval-lifecycle.md`）的量測一致：只給標題時是 11／221（5%），漏掉的配對與 Knowledge 的共同詞中位數只有 1 個。
   - Knowledge 寫的是解法與規則，任務標題寫的是要做什麼，兩邊用詞不同。
   - R2 量到 P5 推測路徑把嚴格命中從 11 拉到 60，但本次在 Agent 開工前的情境下，帶路徑沒有讓正解多出現一個。原因如上：路徑比對只能找到 appliesTo 寫對的 Knowledge。
   - 真實資料中有 12 則 active Knowledge 沒有 appliesTo（decision 3、gotcha 3、pattern 2、procedure 4），只能靠文字或最近清單被看見。
4. SelfGraph 式的「逐詞比對後判定可回答」，在本專案只會更常說「沒有」，因為問題本來就在用詞不同。它能做的最多是誠實地說「文字上沒有對上」，而這件事 `termHits` 已經做到了。

### 若要做的最小做法

1. **分開回報 Knowledge 的信心**：
   - recall 與 `getContext` 加 `knowledgeConfidence`（同樣的 none／low／high 規則，只對 Knowledge 命中計算）。
   - `getContext` 在 Knowledge 為 0 時附一句固定提示：「沒有 Knowledge 的文字符合這個任務；改帶 `paths` 或 `projectRoot` 可用路徑找」。
   - 改 `search-repository.ts` 的 `recall` 回傳與 `context-recall-service.ts`。
2. **修 `termHits` 誤報**：
   - 查詢詞只取前 32 個，超出的會被報成 0。改為不列入，並加截斷旗標。
   - 非 CJK 的複合詞要求全部子詞，與 OR 排序不一致。
3. **`work_search_knowledge` 零命中時附逐詞計數**：
   - 真實資料 350 次中，`none` 70 次、`relaxed` 277 次、`strict` 只有 3 次。strict 少是因為完整標題有 10 個以上的詞，strict 要求每個詞都出現。
   - `relaxed` 為空時，hint 要明說「scope 內沒有任何紀錄含這些詞」。

影響評估：

- 不需要 schema 變更；排序不變。
- 回應只多幾個欄位，`knowledgeConfidence` 約 25 字元，提示約 80 字元。
- 不增加查詢，逐詞計數已經在 `scoreTerms` 算好。

風險：Agent 可能把 `knowledgeConfidence: none` 當成「沒有適用的 Knowledge」而不再帶路徑查。所以提示要指向路徑查詢。

**規模**：小。

**建議**：做，放進第一版。未知詞稀釋（2／196）不改排序。

### 附：`work_search_knowledge` relaxed 結果品質的代理量測

| 量測（真實資料） | 數字 |
| --- | --- |
| 查詢的 Session 有對應 Knowledge（自己建立或套用）的次數 | 56 |
| 其中 relaxed 的 hit@1／hit@3 | 21／46（46%）、25／46（54%） |
| relaxed 最高命中的詞覆蓋率中位數 | 24% |
| 查詢詞數 ≥ 10 的比例 | 77% |

限制：

- 查詢是完整標題，比 Agent 實際的查詢長很多，會壓低 strict、拉低覆蓋率。
- 沒有依時間切片，自己建立的 Knowledge 文字與標題本來就相近，會抬高 hit@k。
- 正解只計「自己建立或套用」，其他也相關的 Knowledge 會被算成錯誤。

所以 46% 既不是上限也不是下限，只能說明：relaxed 結果約一半時間把對的 Knowledge 排第一，但它和查詢只共用約四分之一的詞。Agent 從 `match: "relaxed"` 與 `matchedTerms` 看得到這一點：MCP 會透傳兩者（`apps/mcp/src/server.ts` 約 1076 行）。

---

## 方向 2：回報結果是哪一級方法產生的

### SelfGraph 的做法

- 回傳只有整體的 `tiers: {seeds, traversal}`，每筆結果沒有「由哪一級產生」的標記。
- 只要有 schema 就報 `synonyms`，即使實際沒有擴展任何詞。
- 經由樞紐的結果在 context 行上標 `(via hub)`。

### 本專案現況

| 檢索路徑 | 位置 | 結果有沒有標 |
| --- | --- | --- |
| 原詞 FTS（OR＋IDF 覆蓋） | `search-repository.ts` `scoreTerms` | 有：`matchedIn`、`termHits` |
| 固定同義詞擴展（6 組） | `SOFTWARE_TERM_GROUPS`、`scoreSynonyms` | **沒有**；分數併入 `matchedIn` |
| changed files／references 路徑 | `scorePaths` | 有：`matchedIn` 含 `path`、`matchedPaths`；分不出是哪一種 |
| Knowledge appliesTo | `scoreAppliesTo` | 有：`matchedPaths` |
| 路徑保留名額、延續 Session 上移、Knowledge 移到來源 Session 前 | `reserveKnowledgeSlots` 等 | 沒有（只是重排，影響小） |
| `work_search_knowledge` relaxed 後備 | `knowledge-search-service.ts` | 有：`match`、`matchedTerms` |
| P5 推測路徑、一層相關 Session、已套用 Knowledge | `context-recall-service.ts` | 有：`includedBecause.kind` |
| 最近 12 筆 | `recentSessions`／`recentKnowledge` | 區塊本身就是標籤 |

recall 本身沒有 relaxed 模式。放寬後才出現的結果只存在於 `work_search_knowledge`，而那裡有標。

### 真實資料量測

- 1,373 筆命中中，97.3% 的 `matchedIn` 超過一個欄位，常見組合如 `summary+title+workSummary`。
- MCP `work_recall` 只保留第一個（`apps/mcp/src/server.ts` 約 839 行 `matchedIn: hit.matchedIn.slice(0, 1)`）。路徑命中仍可從 `matchedPaths` 看出。
- `getContext` 的補充結果中：
  - related_session：12 筆，分布在 6 次回應。
  - inferred_path：3 筆，分布在 2 次。
  - applied_knowledge：2 筆，分布在 2 次。
- 只靠同義詞命中的比例無法從回應判斷，**未量測**。

### 若要做的最小做法

- 命中只來自同義詞時，在 hit 加 `expandedFrom`，或在 `matchedIn` 加 `synonym`。
- MCP 保留完整的 `matchedIn`，最多 4 個欄位名。20 筆命中多不到 400 字元。
- 不需要 schema 變更；效能不變；只加欄位。

**規模**：小。

**建議**：做，放進第一版，優先度低於方向 1 與 4。不做 SelfGraph 式的整體 tier 報告：各條路徑已分在不同欄位或區塊，整體標記反而失去逐筆資訊。

---

## 方向 3：樞紐節點

### SelfGraph 的做法

- 關係數 ≥ 50（`HUB_DEGREE`）的實體是樞紐。
- `skip_hubs` 時樞紐保留但不展開，context 標 `(via hub)`；只經由樞紐連通的問題判為 `uncertain`。
- 排序不依度數降權。

### 本專案現況（讀程式碼確認）

| 功能 | 檔案如何連結 Session | 現有抑制 | 依常見程度加權 |
| --- | --- | --- | --- |
| 相關工作 | `related-work-service.ts`：共用路徑數，再依 Jaccard、時間 | 只看已確認變更檔、1–20 檔的 Session；每路徑 1,000 筆 posting；前 5 | 沒有 |
| 圖路徑 `work_get_graph_path` | `graph-builder.ts` `findPath`：不加權 BFS | 最新 50 個 Session、500 節點、1,000 邊 | 沒有 |
| 衍生共變邊 | `graph-derivation.ts` `coChangedEdges` | 跳過超過 20 檔的 Session；門檻 3；前 300 | 沒有 |
| 熱點 | `hotspot-repository.ts`：依 Session 數 | 排除超過 20 檔的 Session | 沒有 |
| Knowledge 過時 | `knowledge-service.ts` `knowledgeStaleness` | **沒有 20 檔上限** | 沒有 |
| P5 推測路徑 | `inferred-task-paths.ts`：分數 ÷ √檔案數 | 超過 20 檔排除；至少 2 個來源；前 3 | 沒有 |
| 未結項相關度 | `outstanding-item-relevance.ts`：每個符合路徑 +10 | 無 | 沒有 |

repo 內沒有任何鎖檔、changelog 或 manifest 的忽略清單。

### 量測

| 量測 | 合成資料（刻意植入 50% 共用檔） | 真實資料 |
| --- | --- | --- |
| 被 ≥10%／≥25%／≥50% 的 Session 改過的路徑數 | — | 23／7／2（共 872 條） |
| 最常見路徑的 Session 占比 | 約 50% | 52.6% |
| 樞紐類別（≥10%） | manifest | other 18、status_doc 3、changelog 1、manifest 1 |
| 相關工作結果中只靠樞紐的比例（門檻 20%／10%） | 95.7% | 12.4%／16.2% |
| 所有結果都只靠樞紐的 Session | 9／11 | 3／61、4／61 |
| 可能過時中觸發路徑全是樞紐 | 1／1 | 3／22（門檻 10% 時 4／22） |
| 排除樞紐路徑後的可能過時數 | — | 22 → 21 |
| 熱點前 10 名是樞紐 | 1／14 | 10／10 |

協調端人工判讀熱點前 10 名（只回結論）：約 4 個是程式碼（3 個是各套件的核心大檔、1 個是主要 E2E 測試檔），其餘 6 個是狀態文件、changelog、說明文件與版本檔。核心大檔本身也是「幾乎每個功能都會碰」的檔案，資訊量有限。

### 判讀

- 合成資料的 95.7% 只證明機制會造成這種結果。真實資料是 12–16%，而且 61 個有結果的 Session 中只有 3–4 個整組結果都只靠樞紐。相關工作大多共用 3 個以上路徑（`sharedLength` 4 以上的有 164／290）。
- 過時判斷的問題來自大範圍改動，不是樞紐（見方向 4）。排除樞紐路徑幾乎沒效果。
- 熱點被例行檔佔滿是真的，但例行檔的 Session 占比是 12–31%，與核心大檔重疊。用文件頻率門檻分不開兩者；要分開只能靠檔案類型規則，而那是依語言與專案而異的忽略清單，維護成本高。熱點目前只用於顯示與報告的風險段落，影響有限。

### 若要做的最小做法（目前不建議做）

- 用專案內文件頻率定義樞紐，相關工作依 IDF 加總，只靠樞紐的結果標 `viaHub`。
- 不需要 schema 變更，但要改 4–6 個 storage 模組、補含熱門檔案的 benchmark 種子。

**規模**：中。

**建議**：**先不做**。真實影響小，量測只有一個專案。等有更多專案的資料，或使用者回報相關工作被例行檔干擾時再評估。熱點的例行檔問題也先不處理。

### 圖路徑：與樞紐無關，但比樞紐更根本的限制

| 量測（真實資料） | 數字 |
| --- | --- |
| 隨機 100 對 Session | 端點在搜尋範圍外 99、找不到路徑 1、找到 0 |
| 最新 50 個 Session 內的 100 對 | 找到 55（全部 2 跳，24% 經過樞紐）、找不到路徑 37、端點在範圍外 8 |
| 搜尋用的圖 | 每次都達 500 節點上限；最新 50 個 Session 中只有 47 個放得進去；節點與邊都被截斷 |

- `findPath` 先建一張有界圖：每個專案最新 50 個 Session、最多 500 節點、1,000 邊。端點不在圖內就回 `found: false` 並說明原因。
- 所以 `work_get_graph_path` 實際上只對最近的工作可用，在這個規模已被截斷。第一版探針的 0／100 是抽樣造成，不是路徑查詢壞了，但「舊 Session 查不到路徑」是真實限制。
- 11-07 的方向研究中，這個工具與其他 4 個少用工具合計只被呼叫 10 次，使用量極低。
- 若要改，做法是以兩個端點為起點向外建圖，而不是取最新的視窗。規模中。**建議**：列入順帶發現，等有使用需求再做。

---

## 方向 4：人確認過的知識的保護

### SelfGraph 的做法

- 人工認證寫在關係本身。
- 自動取代、LLM 判定矛盾、來源替換、修剪、去重時，認證過的保留並發出 `certified_kept` 警告。
- 衰減照算，明確刪除不受保護。
- 它保護的對象是**自動流程**，不是時間或人的明確操作。

### 本專案現況（讀程式碼確認）

| 問題 | 答案 | 證據 |
| --- | --- | --- |
| 確認過的會不會被標為可能過時？ | 會。確認只把基準移到確認時，之後改到 appliesTo 範圍的 Session 都會觸發 | `knowledge-service.ts` `stalenessSince`：`lastConfirmedAt ?? createdAt` |
| 觸發規則 | 完成時間晚於基準、未作廢、改到 appliesTo 範圍內檔案的任一 Session；排除 Knowledge 自己的來源 Session 與最後確認的 Session；**沒有檔案數上限**；回報的是第一個觸發的 Session | `knowledgeStaleness`、`loadLaterSessions` |
| 會不會被自動取代或封存？ | 不會。只有明確帶 `supersedesId` 新增時才封存舊版 | `knowledge-service.ts` 約 502–572 行 |
| 排序會不會下沉？ | 過時不影響排序；推翻（晚於最後確認）乘 0.7；確認最多 +20% | `search-repository.ts` `evidenceFactors` |
| 人工確認與 Agent 套用有沒有分別？ | 只差 `session_id` 是否為空；Agent 也能經由 `work_update_knowledge` 的 `confirm: true` 寫出 `manual_confirm`；沒有記錄確認的是人還是 Agent | `knowledge_feedback` 欄位 |

### 真實資料量測

| 量測 | 數字 |
| --- | --- |
| 有 appliesTo 的 active Knowledge | 35 |
| 其中可能過時 | 22（63%） |
| 第一個觸發的 Session 改動超過 20 檔 | 20／22 |
| 每則可能過時的 Knowledge 被幾個後續 Session 觸發 | 1 個：7 則；2 個：2 則；3–5 個：4 則；6–10 個：3 則；11 個以上：6 則（p50 3、p90 14、max 28） |
| 被確認過的 active Knowledge | 15；其中仍可能過時 7（人工確認 7 則中有 4 則） |
| 確認到第一個觸發 Session 的天數 | p50 3.4 天、p90 35.7 天 |
| feedback 種類 | applied 64、manual_confirm 17 |

反事實（只在暫存副本上修改變更檔欄位，再重算）：

| 變體 | 可能過時 | 其中被確認過 | 其中人工確認 |
| --- | --- | --- | --- |
| 現況 | 22 | 7 | 4 |
| 超過 20 檔的 Session 不算 | **6** | 2 | 2 |
| 樞紐路徑不算（門檻 20%／10%） | 21／21 | 7 | 4 |
| 兩者都不算（門檻 20%／10%） | 5／4 | 2／1 | 2／1 |

合成資料以一個 22 檔的 Session 單獨造成過時，`excludeOver20` 正確移除該標記。

### 判讀

1. **「確認後仍可被標為過時」本身是合理的**。確認的意思是「當時是對的」，之後檔案被改，正是該再看一次的訊號。SelfGraph 也不讓認證抵銷衰減。本專案沒有自動取代或封存，所以 SelfGraph 那種保護沒有對象。**不需要新的保護機制。**
2. **真正的缺陷是過時判斷被大範圍改動淹沒**：
   - 共變、相關工作、熱點、P5 都把超過 20 檔的 Session 視為「多半是被汙染的工作區或例行大改」，不予計入；只有過時判斷沒有（`loadLaterSessions` 沒有這個條件）。
   - 這個專案有 26%（75／291）的 Session 超過 20 檔。
   - 套用同一條規則後，可能過時從 63% 降到 17%。人剛確認過的 Knowledge，幾天內就被一次大改重新標記的情況，大多會消失。
   - 這與 R2 的觀察一致：二元的 possiblyStale 失去鑑別力，主因是熱門檔案與大量 Session。這次量到主因中最大的一塊是大範圍改動。
3. **樞紐加權不是解法**：排除樞紐路徑只少 1 則。

### 20 檔上限會不會漏報

會，風險是真的：

- 一次真正的大重構（例如改名或搬目錄，改了 50 個檔案，其中包括 appliesTo 的檔案）確實可能讓 Knowledge 過時。完全不計入，就失去這個訊號。
- 讀程式碼可以說明的部分：其他功能用同一條規則，是因為超過 20 檔的變更清單通常混入與任務無關的工作區變動（`graph-derivation.ts` 的註解是「likely a polluted worktree」）。這個假設對過時判斷不完全成立。

**協調端的人工判讀（真實資料，只回結論）**：降下來的 16 則逐則看了 Knowledge 標題、appliesTo、觸發 Session 的標題與命中檔案，沒有逐一比對 diff。

- 確定因大範圍 Session 而過時或需要修訂：至少 2 則。一則的做法被之後的大範圍改版以共用元件取代；一則描述的流程限制被之後的版本解除。
- 不確定：2–3 則。觸發的版本確實在改同一個機制，但從標題看不出結論是否改變。
- 不相關：約 11 則。appliesTo 指到幾乎每版都會碰的核心大檔，或大範圍版本順手改了同一檔案的其他部分。
- 觸發型態分兩種：
  - 5 則只被 1 個大範圍 Session 觸發，確定過時的 2 則都在這裡面。
  - 約 8 則被 10 個以上大範圍 Session 觸發，appliesTo 全是核心大檔（每個套件的主要 store 或 server 檔這一類）。
- 觸發的大範圍 Session 檔案數：21–50 檔 9 則、51–100 檔 4 則、101–300 檔 3 則（近似值，只看第一個觸發的 Session）。

所以直接忽略超過 20 檔的 Session 會漏報，16 則中至少 2 則（12% 以上）。雜訊主要不是「Session 太大」，而是「appliesTo 指到高頻的核心大檔」，大範圍 Session 只是最常碰到這些檔案。這和方向 3 的「用頻率分不開例行檔與核心大檔」不衝突：這裡要抑制的正是高頻，不必分辨是哪一種。

### appliesTo 寬度（真實資料）

為了驗證「雜訊來自寬 appliesTo」，探針算了每則 Knowledge 的 appliesTo 寬度：專案內有變更檔的 Session 中，有多少比例碰到它的 appliesTo。`breadthFocused` 只算 20 檔以內的 Session。

| 群組（35 則有 appliesTo 的 active Knowledge） | 則數 | 寬度中位數 | 寬度 p90 |
| --- | --- | --- | --- |
| 全部 | 35 | 0.045 | 0.289 |
| 現況可能過時 | 22 | 0.086 | 0.306 |
| 現況未過時 | 13 | 0.017 | 0.089（最大 0.199） |
| 被 1 個 Session 觸發 | 7 | 0.021 | 0.265 |
| 被 2–9 個 Session 觸發 | 6 | 0.041 | 0.406 |
| 被 10 個以上 Session 觸發 | 9 | 0.223（沒有一則低於 0.05） | 0.705 |

| `breadthFocused` 門檻 | 則數 | 現況可能過時 | 排除超過 20 檔後仍可能過時 |
| --- | --- | --- | --- |
| ≥ 0.1 | 9 | 8 | 5 |
| ≥ 0.2 | 3 | 3 | 3 |

另外，72 條 appliesTo 條目中有 14 條（19%）很寬，10 則 Knowledge（29%）至少有一條很寬的條目。

判讀：

- 寬度假設成立，但只對「被反覆觸發」的那一群成立。被 10 個以上 Session 觸發的 9 則都很寬；只被 1 個 Session 觸發的 7 則大多很窄，人工判讀確定過時的 2 則就在這種「只被 1 個大範圍 Session 觸發」的型態裡。
- 所以兩群要用兩個訊號處理，任一個單獨都不夠：
  - 只靠 20 檔規則：寬 appliesTo 被小 Session 反覆觸發的 5 則仍然留著（`breadthFocused` ≥ 0.1 且排除後仍過時）。
  - 只靠寬度：只被 1 個大範圍 Session 觸發的窄 Knowledge 不會被處理，而真正過時的正是這一群。

### 若要做的最小做法

兩個訊號並用，都只改回報，不刪資料：

1. **大範圍改動分開計數**：
   - 只有超過 20 檔的 Session 觸發時，不設 `possiblyStale`，改回報 `broadChangesSince: <數量>`。
   - 不能靜默丟掉，因為人工判讀中 16 則至少有 2 則是真的過時。Agent 讀 Knowledge 時仍看得到「之後有 N 次大範圍改動碰過它」，注意事項佇列不會洗版。
   - `work_get_file_history` 已有同概念的 `broadChanges` 計數，可以沿用命名。
2. **appliesTo 寬度提示**：
   - 以 `breadthFocused`（20 檔以內的 Session 中碰到 appliesTo 的比例）判斷。門檻建議 0.1–0.2：0.1 涵蓋 9 則，其中 8 則現況可能過時；0.2 涵蓋 3 則，全部可能過時。
   - 用在兩處：
     - 寫入或更新 Knowledge 時，appliesTo 太寬就回一句提示，請 Agent 縮小範圍。這處理的是源頭，也和下方後續題目的「寫入時的 appliesTo 品質」是同一件事。
     - 過時判斷中，寬 appliesTo 的過時標為弱訊號或加註原因（例如 `staleReason: "broad_applies_to"`），不和窄 Knowledge 的過時同等對待。
   - 寬度要掃專案內的 Session 變更檔，成本和現在的過時判斷同級。可以只在過時判斷已經載入的 Session 上順便算，不另開查詢。

影響評估：

- 改 `knowledge-service.ts` 的 `loadLaterSessions`／`knowledgeStaleness`；core 型別加可選欄位；審閱提示（`knowledge-review-hint.ts`）同步；寬度提示可放在新增與更新 Knowledge 的回應。
- 不需要 schema 變更；不改排序（過時本來就不影響排序）。
- 回應大小：每則可能過時的 Knowledge 多一個數字與一個原因字串。
- 依 backend 規則，要更新過時判斷的等價測試與 benchmark，並加「單一大範圍 Session 觸發」「寬 appliesTo 被小 Session 反覆觸發」的測試。
- 相容性：`possiblyStale` 會變少。Web 的注意事項佇列與時間軸要確認顯示是否正常；新欄位用灰色的次要文字。

風險：

- 寬度門檻只在一個專案上量過，0.1–0.2 之間怎麼取要再看第二個專案。
- 與 R2 的過時分級設計要一致，避免一個版本改兩次。這兩個訊號可以直接當作分級的第一步。

**規模**：小到中（大範圍計數是小；寬度提示要多算一個比例，仍不需要 schema）。

**建議**：做，**第一版最優先**。先做大範圍分開計數，寬度提示同一版做；門檻先取 0.15，並把寬度數字一起回報，方便之後調整。

### 合成資料重現、真實資料尚未發生的兩個缺陷

| 缺陷 | 合成資料 | 真實資料 |
| --- | --- | --- |
| 補登的 finalize 把 `last_confirmed_at` 往回推：`applyKnowledgeFeedback` 以 `completedAt` 直接覆寫，沒有取較晚者 | 重現 1 筆 | 0 |
| `updateKnowledge(status: "active")` 還原已被取代的舊版，新舊兩版同時 active：11-07 已提出，未修 | 重現 1 筆 | 0 |
| 已作廢 Session 的確認紀錄仍計入確認次數與排序加分 | — | **2 筆已發生** |

前兩項都是一行到數行的修正：取 `MAX`；還原前檢查有沒有 active 的後繼版本。屬於低風險的預防性修正。第三項是否撤回，要由產品決定，本研究不做建議。

「人與 Agent 確認分開記錄」要加 `actor` 欄位與 migration，現在沒有功能依賴它，**先不做**。

---

## 方向 5：健檢清單

### SelfGraph 的做法

- `lint` 有四個代碼：孤立實體、沒有證據的事實、指向非現行關係的決策步驟、不在 schema 內的類型。
- 每個代碼回報數量與前 5 個 id，只報告、不自動修。

### 本專案現況

| 檢查 | 系統狀態頁／doctor／`db:*` | 其他 | 覆蓋 |
| --- | --- | --- | --- |
| 沒有來源 Session 的 Knowledge | 無 | 手動新增時合法；Session 永久刪除後也會變空 | 未涵蓋 |
| 沒有 appliesTo 的 Knowledge | 無 | 永遠不會被標過時 | 未涵蓋（屬於檢索問題，不是資料錯誤） |
| 來源指向已作廢 Session | 無 | 作廢不會動 Knowledge | Knowledge 未涵蓋；知識頁有 |
| 知識頁引用的來源不存在或已作廢 | 無 | `knowledge-page-service.ts` 的 `needsReview`，並進入注意事項佇列 | **已涵蓋** |
| 新舊版同時 active | 無 | 只在新增時防止 | 未涵蓋 |
| 資料庫完整性、schema、備份、維護紀錄、檔案權限 | doctor、狀態頁、`db:maintain` | | 已涵蓋 |

### 真實資料量測

| 項目 | 數字 |
| --- | --- |
| 來源 Session 被刪除而孤立 | 0 |
| 手動建立、沒有來源 Session | 1 |
| 來源指向已作廢 Session | 0 |
| supersedes 指向不存在的紀錄 | 0 |
| 新舊版同時 active | 0 |
| 格式錯誤的變更檔欄位 | 0 |
| 知識頁 needsReview | 0／3 |
| 沒有 appliesTo 的 active Knowledge | 12（decision 3、gotcha 3、pattern 2、procedure 4） |

與 11-07 的健檢研究（`knowledge-health-gap.md` 4.1）一致：資料錯誤類的檢查在真實資料上都是 0。

### 合成資料重現的讀取缺陷（真實資料 0 筆）

- `sessions.changed_files_json` 沒有 CHECK 限制，程式碼註解也承認有舊格式的列。
- 值為 `'not json'`：`getGraph({ includeDerived: true })` 丟 `SyntaxError`（`graph-builder.ts` `derivedEdges` 直接 `JSON.parse`）。
- 值為 `'null'`：`parseJson('null', [])` 回傳 `null`，之後丟 `TypeError`。`getContext`（`digest.ts`）與 `getRelatedWork`（`related-work-service.ts` `paths`）都受影響。
- 這比加一條健檢更值得直接修：非陣列一律當成 `[]`。現有的 `CHANGED_FILES_ARRAY_SQL` 已是這個做法。

**建議**：

- 不做健檢清單或 Knowledge lint。
- 讀取容錯是預防性修正，規模小，可以放進第一版。
- 沒有 appliesTo 的 12 則屬於 R2 的「專案常設規則管道」，不當成健檢項目。

---

## 順帶發現（研究中看到的既有缺陷）

依影響排序。「重現」以合成資料確認；「真實」表示真實資料中已發生；其餘為讀程式碼，未執行。

| # | 缺陷 | 位置 | 狀態 |
| --- | --- | --- | --- |
| 1 | 過時判斷沒有套用「超過 20 檔不算」，與共變、相關工作、熱點、P5 不一致 | `knowledge-service.ts` `loadLaterSessions` | **真實**（22→6） |
| 2 | `relevant.confidence` 是 Session 與 Knowledge 合算，Knowledge 為 0 時仍為 high | `context-recall-service.ts` 約 1253 行 | **真實**（41／50） |
| 3 | `work_get_graph_path` 只在最新 50 個 Session 的有界圖中搜尋，該圖在此規模已被截斷 | `graph-builder.ts` `findPath` | **真實**（隨機對 99／100 在範圍外） |
| 4 | 已作廢 Session 的確認紀錄仍計入確認次數與排序 | `knowledge-service.ts`、`search-repository.ts` `evidenceFactors` | **真實**（2 筆） |
| 5 | MCP `work_recall` 把 `matchedIn` 裁成只剩第一個 | `apps/mcp/src/server.ts` 約 839 行 | **真實**（97% 有多個） |
| 6 | 衍生圖遇到非 JSON 的變更檔欄位丟 `SyntaxError` | `graph-builder.ts` `derivedEdges` | 重現；真實 0 |
| 7 | 變更檔欄位為 `'null'` 時 `getContext` 與 `getRelatedWork` 丟 `TypeError` | `digest.ts`、`related-work-service.ts`、`session-record-codecs.ts` | 重現；真實 0 |
| 8 | 補登的 finalize 會把 `last_confirmed_at` 往回推 | `knowledge-service.ts` `applyKnowledgeFeedback` | 重現；真實 0 |
| 9 | 還原已被取代的 Knowledge，新舊兩版同時 active | `knowledge-service.ts` `updateKnowledge` | 重現；真實 0 |
| 10 | recall 的 appliesTo 比對忽略 `from`／`to`，文字與路徑比對有套用 | `search-repository.ts` `scoreAppliesTo` | 讀碼，可能非刻意 |
| 11 | scoped 的 `work_search_knowledge` MCP 回應沒有透傳 `appliesToScanTruncated` | `apps/mcp/src/server.ts` 約 1078–1091 行 | 讀碼 |
| 12 | `termHits` 對第 32 個以後的詞誤報 0；複合詞要求全部子詞 | `search-repository.ts` `recall` | 讀碼 |
| 13 | `effectiveQuery` 只在零命中分支出現，文件說查詢被截斷時就會帶 | `knowledge-search-service.ts`、`docs/mcp-tools.md` | 讀碼 |
| 14 | `relevant.knowledgePages` 用另一套斷詞（空白切詞加子字串），中文無空白的 task 幾乎不會命中 | `context-recall-service.ts` `contextTerms` | 讀碼 |
| 15 | Agent 能寫入 `manual_confirm`；核心型別註解說只有 Web | `packages/core/src/index.ts` 約 777 行 | 讀碼 |
| 16 | 文件寫過時基準為 `max(createdAt, lastConfirmedAt)`，程式是 `lastConfirmedAt ?? createdAt` | `knowledge-health-gap.md` 第 1 節 | 讀碼 |
| 17 | `work_search` 的 `matchedIn` 為空時硬填 `"title"`（目前不會觸發） | `context-recall-service.ts` 約 618 行 | 讀碼 |

探針本身的發現：

- 專案狀態不是 tracked 時，所有區塊都是空的。已加入警告與 `--treat-all-tracked`。
- 以 `to` 篩選時，Knowledge 依 `updated_at` 判斷，所以「事前存在但之後被確認或編輯」的 Knowledge 會被排除。

## 整體建議

### 第一版：一次合成的小版本

全部不需要 schema 變更，也不改排序。依優先順序：

1. **過時判斷的兩個訊號**（方向 4，順帶發現 1）：
   - 超過 20 檔的 Session 不單獨觸發 `possiblyStale`，另外回報 `broadChangesSince`。真實資料可能過時從 63% 降到 17%（22→6），是本研究最明確的真實效果。
   - 人工判讀降下來的 16 則中至少 2 則是真的過時，所以用計數保留訊號，不靜默丟掉。
   - appliesTo 寬度提示：寫入時提醒縮小範圍；過時判斷中把寬 appliesTo 的過時標成弱訊號。門檻先取 0.15。
2. **Knowledge 專屬的信心與提示**（方向 1，順帶發現 2）：
   - recall 與 `getContext` 加 `knowledgeConfidence`。
   - Knowledge 為 0 時提示改帶路徑。
   - `work_search_knowledge` 零命中時附逐詞計數。
   - 修 `termHits` 的截斷與複合詞誤報。
3. **結果來源補標**（方向 2）：同義詞命中標記；MCP 保留完整 `matchedIn`；透傳 `appliesToScanTruncated`（順帶發現 5、11）。
4. **預防性修正**（真實資料 0 筆，成本低）：
   - 變更檔欄位讀取容錯（順帶發現 6、7）。
   - 確認時間取較晚者、還原前檢查後繼版本（順帶發現 8、9）。

第一版的檢查：

- 依 backend 規則跑完整檢查清單。
- 要加的測試：大範圍 Session 觸發過時、Knowledge 信心為 none 但 Session 有命中、`'null'` 與 `'not json'` 列、補登 finalize、還原衝突、32 詞以上查詢。
- 過時判斷的 benchmark 要確認 p90 不退步。

### 比五個方向都重要的後續題目：實際用過的 Knowledge 送不到 Agent

真實資料中，Session 實際套用的、事先存在的 Knowledge，約 82% 在開工時不會出現在 Agent 拿到的結果裡。只帶文字、加上 P5 推測路徑、或直接帶該 Session 的變更檔，結果都一樣。

這是**資料面**的問題，不是查詢或排序的問題：

- 被實際用到的 Knowledge 大多沒有 appliesTo（只有 18% 有），或 appliesTo 和實際使用的場景不重疊（只有 6% 涵蓋該 Session 的變更檔）。路徑比對找不到它們。
- 反過來，寫得太寬的 appliesTo 把沒用到的 Knowledge 大量帶進來：帶路徑後，負例有 Knowledge 的比例從約 22% 升到 74%。
- 系統已經記錄「這則 Knowledge 曾被哪些 Session 套用」（`applied` feedback 64 筆），但召回時只在補充結果的 `applied_knowledge` 間接用到（找回 4–5 個正例），沒有直接當作召回訊號。

和既有研究的關係：

- R2 A1「專案常設規則管道」：處理不屬於任何檔案的規則，例如真實資料中 12 則沒有 appliesTo 的 active Knowledge。
- P5 推測路徑：只能放大 appliesTo 寫對的 Knowledge，救不回沒寫或寫錯的。
- 方向 4 的寬度提示：寫入時提醒縮小 appliesTo，是同一個資料品質問題的另一面。

建議下一輪研究以這三條為候選：寫入時的 appliesTo 品質（太寬或沒寫時提示）、把「曾被哪些 Session 套用」拿來召回、常設規則管道。以下基準可以直接拿來比較改善：

| 基準（真實資料，正例 33） | 數字 |
| --- | --- |
| `pastOnly` 正例 hit@8 | 1／33 |
| 不篩日期 hit@8／hit@20 | 0／33、1／33 |
| `getContextTaskOnly` 哪裡都沒有 | 82%（補充結果找回 15%） |
| `pathRecallBaseline` 哪裡都沒有 | 82% |
| 正解有 appliesTo／涵蓋 Session 變更檔 | 18%／6% |
| 帶路徑時負例有 Knowledge | 74% |
| 有 appliesTo 的 active Knowledge 可能過時（現況→排除超過 20 檔） | 22→6 |

### 之後再評估

- **R2 的過時分級**：以第一版的 20 檔規則為第一步，再加入「確認後被幾個 Session 觸發」等現有訊號。
- **用任務標題找回 Knowledge 的召回**：見上一節的後續題目。
- **圖路徑改成以端點為起點建圖**：使用量極低，等有需求。

### 不做

- 樞紐加權（方向 3）：真實影響 12–16%，排除樞紐對過時幾乎沒效果。等有更多專案的資料再評估。
- 熱點的例行檔過濾：用頻率分不開例行檔與核心大檔，要做只能靠忽略清單。
- 獨立的「可回答性檢查」工具：`termHits` 已提供同樣資訊，問題在 confidence 合算與用詞落差，另開工具解決不了。
- 確認過的 Knowledge 免於過時標記、自動取代保護：沒有對象，也不合理。
- 人與 Agent 確認分開記錄：先不做，等過時分級需要時再一起做。
- 健檢清單頁與 Knowledge lint：兩次真實資料量測都是 0。
- SelfGraph 的時間衰減、修剪、圖遍歷連通性：已否決或不適用。

## 未驗證與沒做的項目

- 只有一個專案的真實資料。
- `getContextTaskOnly` 與 `pathRecallBaseline` 沒有依時間切片，用的是現在的資料庫，數字偏樂觀；82% 是在偏樂觀條件下仍送不到的比例。
- `staleDroppedByCap` 為近似值，只看第一個觸發 Session 的檔案數。
- 人工判讀只看標題、appliesTo 與命中檔案，沒有逐一比對 diff；「至少 2 則」是下限。
- appliesTo 寬度門檻（0.1–0.2）只在一個專案上量過。
- 只帶文字時負例約 22% 有 Knowledge，是協調端回報的比較值，和本文「50 次中 41 次沒有 Knowledge」來自不同次量測，兩者約 18–22%。
- relaxed 結果品質只是代理量測：查詢比實際長、未依時間切片、正解不完整。
- 只靠同義詞命中的比例：回應中無法辨識，沒有量。
- 方向 3 與圖路徑的改法沒有做原型，效能影響是估計。
- 順帶發現中標「讀碼」的項目沒有執行驗證。
- 本輪沒有改產品程式碼，所以沒有跑 `pnpm test` 等完整檢查清單；只跑了 `pnpm format:check`、`pnpm lint` 與探針的 `--self-check`。
