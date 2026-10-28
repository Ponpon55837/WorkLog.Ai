# WorkLog.Ai — 高優先級改善計畫（P0 Roadmap）

> **產品定位：** Local-first Developer Work Intelligence
> **規劃基準：** WorkLog.Ai v1.6.3（2026-10-27），main `402d214`，schema 30
> **文件狀態：** 執行計畫；PR 1 的證據、決策與驗收結果由 PR 和上位路線圖記錄
> **修訂：** 2026-10-28 依 repo 現況核對修正（P0-1 對象改為 Session；補入既有機制與既有結論；加入停止條件）
> **核心原則：** Save What Matters · Retrieve What Matters · Learn What Works
> **使用者體驗原則：** Intelligence without maintenance burden（不把知識維護轉嫁給使用者）
> **上位文件：** [`docs/knowledge-quality-roadmap.md`](knowledge-quality-roadmap.md)。本計畫是其 Phase 2 收尾與 Phase 3 C1 的具體執行版；兩者衝突時以較新的實測結果為準，並回寫該文件的進度段落。

---

## 1. 執行摘要

下一輪不以新增功能數量為目標，優先處理 **知識有效性、Raw-only 資訊可發現性、搜尋答案充分性與保存品質**。

1. **找得對：** 避免過時、被推翻的歷史決策優先影響 Agent。
2. **找得到：** 只存在 Raw Handoff 的有用資訊，在大量歷史資料中也能被找到。
3. **用得可靠：** 區分「文字相似」與「足以支持答案」。
4. **存得有價值：** 保存真實成果、必要證據與值得重用的經驗，不製造低價值 Knowledge。
5. **不增加心智負擔：** 系統能處理的由系統處理；預設不產生新的待審工作。

**執行順序：**

1. **PR 1（P0-1）**：先寫合成回歸測試，重現「兩筆 Session 沒有連結、舊準則排在推翻它的新 Session 前面」，並評估是否存在可靠的判斷依據。有依據才做最小修正；沒有就記錄結論並停止。
2. **PR 2（P0-2 實驗 A）**：Raw-only 補充候選。目前合成資料中 raw-only 答案在 1,000 筆時已找不到，收益最明確。
3. **PR 3（P0-3）**：只補題庫與 Agent 端到端驗證；confidence 的語義說明已在 1.6.3 完成。
4. **分析 4（P0-4）**：沿用 2026-10-23 的 Phase 1 結論（沒有保存類失敗）；只在出現新的保存類失敗時重新抽樣。

---

## 2. 目前已確認的基線與現況

數字來自 `docs/knowledge-quality-roadmap.md`（Phase 0／Phase 2，2026-10-22～23 量測）與 `docs/releases/1.6.3.md`；不是本計畫重新執行的結果。私有題庫數字是 PR #261～#263 合併後重跑的值。**各 PR 做前後比較時，必須在同一資料庫快照上重新產生基線，不直接沿用本表。**

| 面向 | 現況／基線 | 解讀 |
| --- | --- | --- |
| 私有 Recall 題庫 | 71 題（51 題有答案、20 題無答案） | 集合有限；擴充時防止題庫過度貼合既有規則 |
| Recall Hit@1／Hit@5／MRR | 0.884／1.000／0.942 | 改動前後比較基線 |
| Context Hit@1／Hit@5／MRR | 均為 1.000 | 對預算與排名仍需干擾測試 |
| 無答案案例 | 20 題中 3 題回傳 `confidence: high`，無題回傳 `none` | `confidence` 是字面覆蓋程度，不是答案正確率 |
| Raw-only 資訊 | 1,000 筆合成 Session 時答案掉到第 21 名或前 30 名外 | 結構化欄位命中部分詞的紀錄淹沒 raw-only 答案 |
| 大量資料測試 | `pnpm bench:recall-scale`，預設 1k／5k／10k | 50k／100k 未驗證 |
| Knowledge 檢索效能 | 5,000 Sessions、20 Knowledge hits，p90：1,414 → 113 ms（PR #261） | 已有 250 ms 效能門檻 |
| Knowledge 取代 | 以 `supersedesId` 建立新 Knowledge 時，舊 Knowledge 改為 `archived` 並寫 audit（`packages/storage/src/knowledge-service.ts` 約 392 行）；搜尋只回傳 `active` Knowledge（`packages/storage/src/search-repository.ts` 約 673 行）；`KNOWLEDGE_STATUSES` 只有 `active`／`archived` | 「被取代的 Knowledge 被當成有效規則」在現行流程不會發生；但「被取代」與「被推翻」沒有獨立狀態，也不出現在 recall |
| `contradictedKnowledgeIds` | finalize Session 時指向 **Knowledge** 的欄位 | 無法直接表達「Session A 推翻 Session B」 |
| Session 延續排序（PR #262） | 前 100 筆中，延續（`continues`）較舊 Session 且分數 ≥ 舊者 30% 的新 Session 排到舊的前面；真實資料 439 筆中 331 筆（約 75%）有連結 | 沒有連結的 Session 之間無法判斷誰取代誰 |
| Raw 半權重（PR #263） | 只在 raw 命中的詞排序時算一半；recall MRR 0.927 → 0.942 | 已知代價：raw-only 答案排得更後面（200 筆時第 5、7 名 → 第 7、14 名） |
| Windows 效能門檻 | `pnpm test:performance` 在本機 Windows 有多項超過預算；CI 只在 Ubuntu 執行 | 效能驗收以 CI（Ubuntu）或同一台機器的前後對照為準 |
| 資料保護 | Tracked Project 才可記錄與讀取；SQLite 本機優先 | 新功能不得繞過既有 Policy Gate |

既有可沿用能力：SQLite FTS、`work_recall`、`work_get_context`、`work_get_session`、Knowledge 確認／推翻與取代、`possiblyStale`、`needsReview`、Session `continues` 連結、Raw Snapshot、Knowledge Candidates、Evidence、MCP 契約與品質／效能測試工具。

---

## 3. P0-1 — Session 之間沒有連結時的取代關係

**優先等級：最高（但先驗證，可能結論為「不改排序」）**
**問題類型：答案正確性、知識有效性**

### 問題

已知案例：一筆舊的技術準則 **Session** 排在後來推翻它的新 **Session** 前面，兩者之間沒有 `continues` 連結，所以 PR #262 的延續重排不會作用。私有題庫中只有 **1 題**屬於這類，PR #263 後從第 3 名升到第 2 名，仍未排第一。

Knowledge 層的取代已由既有機制處理（`supersedesId` → 舊者 `archived`，搜尋只回傳 `active`），**不是本項的問題**。

### 核心待答問題

> 兩筆 Session 沒有連結時，系統要依據什麼判斷「後者推翻了前者」？

限制：不能只看建立時間較新，也不能只因文字相似就認定互相取代。可評估的既有線索（**皆待驗證，不是結論**）：

1. 新 Session 的 `contradictedKnowledgeIds` 指向的 Knowledge，其來源是舊 Session。
2. 新 Session 透過 Knowledge `supersedesId` 取代的 Knowledge，其來源是舊 Session。
3. Knowledge audit 中可追溯的推翻／取代事件，其來源 Session 對應到這兩筆。
4. 已知案例中兩筆 Session 是否有共同的系列或延續鏈（間接連結，例如經第三筆 Session 相連）。

若上述線索在已知案例與真實資料中都無法可靠成立，結論是：**這是保存品質問題（缺少連結），不改排序**，回到 P0-4／Phase 1 A2 評估如何在 finalize 時補連結，而不是新增推論規則。

### 執行步驟

1. 在 `tests/storage/` 建立合成回歸測試，重現已知案例的結構：舊準則 Session、後來推翻它的新 Session、兩者無 `continues` 連結、字面分數接近。先確認測試在現行程式下失敗（新 Session 未排第一）。
2. 依「核心待答問題」的線索，為每一種建立對應的合成變體，確認哪些線索在資料模型中真的存在、可以用既有欄位查到。
3. 在獨立 git worktree、真實資料的唯讀快照上，量測這些線索的覆蓋率（只記錄彙總數字：符合線索的 Session 配對數、已知案例是否符合）。
4. **決策點：**
   - 有可靠線索且已知案例符合 → 以最小衍生規則納入排序（比照 PR #262 的作法：只在前 N 筆內重排、兩筆都保留、有分數比例門檻），不新增 schema。
   - 沒有可靠線索 → 不改排序；把結論與數字回寫 `docs/knowledge-quality-roadmap.md`，本 PR 只合併回歸測試（以 `it.todo` 或標註已知限制的形式），停止。

### 回傳狀態區分（本輪不實作，只做決定）

文件原本要求回傳時區分「目前有效／需要重新核對／已明確取代或推翻」。現況：

- 「需要重新核對」已有 `possiblyStale`、`needsReview`。
- 「已取代或推翻」的 Knowledge 是 `archived`，**不出現在 recall**；歷史可在 Web／Knowledge 頁面查閱。

本輪不改這個行為。若之後要讓被取代者出現在 recall 結果中，需另行評估搜尋過濾條件與回應大小，不在 PR 1 範圍。

### 不做

- 不全域提高新 Session 的權重。
- 不讓模型未經證據核對就自動封存或覆寫正式 Knowledge。
- 不另建平行知識版本資料庫；不新增 schema migration。

### 驗收

1. 已知 Session 案例有合成回歸測試。
2. 若找到可靠依據：該案例排第 1，私有題庫中這 1 題排第 1。若找不到：記錄原因、數字與後續方向，並停止。
3. 沒有足夠依據的 Session 配對不被重排（有負面測試：字面相似但無關的新 Session 不會被提前）。
4. 既有 `archived` 過濾行為、PR #262 延續重排、合成檢索品質五類指標、私有題庫 recall／context 指標都不退步。
5. 不增加日常人工審核工作。

---

## 4. P0-2 — Raw-only 重要資訊的低負擔補充檢索

**優先等級：高**
**問題類型：歷史可發現性、Context 品質**

### 問題

答案只寫在 Raw Handoff、沒有成為結構化欄位或 Knowledge 時，資料量一大就排不上來。直接提高 Raw 全域權重，則會讓長篇、順帶提到很多詞的舊交接壓過精準的正式紀錄。

### 與 PR #263 的關係

PR #263 刻意把「只在 raw 命中的詞」降為半權重：提升了 MRR（3 題進步、0 題退步），但讓 raw-only 答案排得更後面。本項**不得回退 #263 的主排序**；補充候選走獨立欄位，不改主分數。驗收必須同時檢查 #263 改善的 3 題不退步。

### 建議方案

**Structured-first + Raw supplement（結構化優先、Raw 小額補充）**，不改正式 Knowledge 的儲存規則。

1. 原有 `work_recall` 照常檢索 Knowledge、結構化 Session 與相關未結項。
2. 在有界預算內，從既有 SQLite FTS 索引另外取出少數高相關的 Raw Handoff 段落候選。
3. Raw 候選以 Session ID、Raw 標題與小段摘錄表達，明確標示「歷史線索／尚未核對」。
4. 去重：主結果已出現的 Session 不再出現在補充候選。
5. Agent 需要時再以既有工具讀完整 Session／Snapshot；不一次把全部 Raw 加入 Context。
6. 不因取得 Raw 候選就自動新增 Knowledge 或人工待審項目。

**觸發條件：** `confidence` 無法判斷有沒有答案，不能只憑 `confidence: low` 啟用補充檢索；觸發條件須在合成與私有題庫上實測。

### 實施順序

- **實驗 A：** 不改主檢索分數，以獨立 Raw 候選欄位呈現少量補充線索（建議上限 3 筆、每筆摘錄有字元上限）。
- **實驗 B：** 只在特定查詢或低覆蓋情況下才附上 Raw 候選。
- **合併判斷：** 比較正確率、P95 延遲、回應大小、Agent 取得來源所需的 MCP 呼叫數；沒有明確收益就不合併產品功能，只保留 bench 與結論。

### 驗收

1. `pnpm bench:recall-scale` 中的 raw-only 題目在 1k／5k／10k 下，目標 Session 穩定出現在主結果前五或補充候選區。
2. 主結果的 Knowledge 與結構化 Session 命中率／排序不退步，包含 #263 改善的 3 題。
3. Raw 候選不被包裝成已驗證 Knowledge；MCP 契約與 skill 說明其性質。
4. 回應大小在既有上限內（`pnpm test:response-size` 通過，必要時新增補充欄位的大小測試）；P95 延遲變化有說明。
5. 預設不新增任何人工審核步驟。

---

## 5. P0-3 — 區分「文字相似」與「確實有答案」

**優先等級：高（範圍已縮小）**
**問題類型：搜尋可靠性、錯誤資訊採用**

### 已完成的部分

1.6.3 已決定**不改 confidence 計算**，並在工具契約、Agent skill 與 `docs/mcp-tools.md` 說明 `high`／`low` 只代表字面相符，引用前必須讀完整紀錄。理由見 `docs/knowledge-quality-roadmap.md`「confidence 只代表字面相符」段。本項不重做這個分析。

### 本輪範圍

- 擴充合成 Golden Query 題庫（`tests/storage/retrieval-quality.test.ts` 或其旁的新測試）：字面高度相似但無答案、部分相關、證據互相矛盾、來源已作廢（`archived`）等案例。
- 設計 Agent 端到端使用測試：搜尋 → 讀取來源 → 是否正確引用或表示資料不足。先以可重複執行的腳本或測試描述流程；若需要真的呼叫模型，先在本機以私有方式評估，不放進 CI。
- 先檢查現有 MCP 描述、Skill 與讀取流程能否約束 Agent，不急著新增模型評分器或 operation。
- 若測試證實仍有系統性錯誤，再評估獨立的 **answer sufficiency** 訊號；必須與 `confidence` 分開，且能指出判斷依據。

### 驗收

1. 無答案／錯誤來源題庫可重複執行。
2. Agent 不直接把搜尋命中摘要當成已確認事實。
3. 無來源支持時，結果能表達未知與待核對。
4. 不因嚴格過濾而丟棄真正的低字面相似答案。
5. 不增加沒有收益的模型呼叫。

---

## 6. P0-4 — 任務完成後的高價值資料保存品質

**優先等級：高（先量測，不預設改程式）**
**問題類型：長期資料價值、儲存品質**

### 既有結論

`docs/knowledge-quality-roadmap.md` Phase 1（2026-10-23）已做過一次判斷：Phase 0 第 4 步沒有找到保存或候選召回的失敗，排錯的題目答案都在前 8 名內；約 75% Session 有連結。結論為暫不開 PR。**本項不重複這次分析。**

### 何時重新抽樣

只在下列任一情況發生時才重新抽樣：

- P0-1 的結論是「缺少 Session 連結導致排錯」（保存品質問題）。
- 擴充後的題庫出現「答案沒有被記錄」或「只在 Raw 出現但應屬正式成果」的失敗。
- 日常使用中發現重複 Session、把推測寫成驗證完成等具體案例。

### 重新抽樣時的作法

- 只在本機、獨立 worktree、唯讀快照上使用私有資料；不上傳、不加入 repo。
- 檢查五段 workSummary 是否保留成果、決策、驗證、限制與未結項；辨識僅在 Raw 出現的正式成果、重複 Session、重複 Knowledge、推測寫成驗證完成、只描述操作沒有結果。
- 既有 Session 的事實遺漏，優先用既有 `work_update_session_work_summary` 與 Audit 修正，不建立新 Session。
- 可重用經驗才評估進入 Knowledge；不讓人工候選審核變成每次任務的預設工作。

### 驗收

1. 能以樣本與明確分類說明是否存在保存品質缺口。
2. 不要求每次 finalize 產生 Knowledge。
3. 不虛構驗證結果。
4. 不增加每次任務後的日常人工審核。
5. 抽樣沒有顯示系統性問題時，不修改 finalize。

---

## 7. 實施 PR 順序

| 順序 | 預期交付 | 決策條件 | 停止條件 |
| --- | --- | --- | --- |
| PR 1 | Session 層級無連結取代案例的合成回歸測試＋判斷依據評估；有可靠依據才做最小修正 | 已知案例能重現；線索在真實資料中有足夠覆蓋 | 找不到可靠依據 → 只合併測試與結論，轉回保存品質 |
| PR 2 | Raw-only 補充候選（實驗 A）與規模基準 | raw-only 題在 1k／5k／10k 進入前五或補充區，主排序不退步 | 沒有明確收益 → 只保留 bench 與結論，不合併產品功能 |
| PR 3 | 無答案與來源核對題庫、Agent 使用行為測試 | 能證明減少不實引用、不造成過度拒答 | 現有契約已足夠 → 只合併題庫 |
| 分析 4 | 保存品質重新抽樣（條件觸發） | 第 6 節的觸發條件成立 | 未觸發 → 不執行 |

### 各 PR 最低交付要求

1. 問題描述與可重現案例（合成測試）。
2. 使用現有架構的最小變更範圍。
3. 合成檢索品質與私有題庫的前後數據；私有內容不進 repo，只寫彙總數字。
4. 與改動相關時，1k／5k／10k 干擾測試（`pnpm bench:recall-scale`）。
5. MCP 回應大小、效能與 Policy Gate 驗證；效能比較以 CI（Ubuntu）或同一台機器前後對照為準。
6. 已知限制、負面案例與回退方式。
7. 完成後回寫 `docs/knowledge-quality-roadmap.md` 的進度段落。

---

## 8. 暫不納入

- 完整 Agent Telemetry 平台；把外部產品當作追趕目標或整合前提。
- 全量掃描歷史 Raw Handoff 並自動大量生成永久 Knowledge。
- 讓使用者每次完成任務後都必須審核 Knowledge。
- 獨立的 Historical Knowledge 資料庫、管理中心或第二套版本機制。
- 缺少量化證據時引入 Embedding、向量資料庫或額外 LLM 審核。
- 以「搜尋分數高」、「較新」、「Agent 聲稱成功」直接推論事實已被驗證。
- 尚未確認問題前全面重構 SQLite FTS、MCP 或 Session 模型。
- 新增 Knowledge 狀態或 schema migration（P0-1 證明必要前）。

---

## 9. 跨項目必守原則與指標

### 資料安全與可信度

- Project Recording Policy 必須在資料讀寫與檢索前生效。
- Raw、Evidence、Session 與正式 Knowledge 的資料性質不得混淆。
- 歷史來源不可被靜默改寫；來源變更時，衍生結果應重新核對或重建。
- **真實資料規則**（同 `docs/knowledge-quality-roadmap.md` 第 7 節）：真實工作紀錄只在本機、獨立 git worktree、唯讀快照上評估；`pnpm eval:recall` 以 `--db` 指定資料庫；題庫、評估結果與中間檔案放在 repository 以外；文件與 PR 只寫機制層面的發現與彙總數字，不寫查詢文字、內容、id、檔名或專案名稱。
- **不得修改或刪除** repo 內的 `data/` 與根目錄 `*.sqlite`（真實使用者資料）；repo 內測試一律使用暫存資料庫與虛構資料。

### 對使用者的負擔

- 日常額外人工審核目標：0 次（高風險決策另計）。
- 不自動生成不斷堆積的待審清單；不自動替使用者建立 Agent 工作。
- 提醒需有實際行動價值。

### 品質與資源指標

| 指標 | 基本方向 |
| --- | --- |
| Recall／Context Hit@1、Hit@5、MRR | 不低於同快照重跑的基線；退步須逐題說明 |
| 合成檢索品質五類指標 | 不退步（`pnpm test:retrieval-quality`） |
| Raw-only 可發現性 | 指定題目進入前五或補充候選區 |
| 無答案錯誤引用 | 逐步降低，不犧牲有效答案 |
| 失效／被推翻資訊誤用 | 逐步降低 |
| P95 檢索延遲 | 同環境、同規模對比；不接受無說明的重大退步 |
| MCP 回應大小 | 有界（`pnpm test:response-size`） |
| 額外人工維護次數 | 日常預設 0 |
| 重複／低價值 Knowledge | 不因自動化而增加 |

---

## 10. 第一輪執行步驟（給執行者）

**PR 1：Session 層級無連結取代案例**

1. 確認分支由 `main` 的 `402d214`（v1.6.3、schema 30）開始；在 PR 1 一併納入本計畫文件。
2. 完整閱讀 `docs/knowledge-quality-roadmap.md` 與本文件，核對 Phase 0 第 4 步、Phase 2 未解問題及第 3 節停止條件。檢查排序、Knowledge 取代／audit 與 finalize 對 `contradictedKnowledgeIds` 的實際實作；寫程式前遵守 `worklog-backend`、`worklog-code-layout`。
3. 先只用暫存 SQLite 與虛構資料，在 `tests/storage/` 建立無 `continues` 關係的排序回歸；確認新 Session 未排第一後，再補四種既有線索的合成覆蓋與無關近似項負面案例。不得把真實資料帶入測試。
4. 在獨立 git worktree 以固定的定稿私有題庫與真實資料唯讀快照建立基線，使用 `pnpm eval:recall <repo 外題庫路徑> --db <唯讀資料庫路徑> --out <repo 外結果路徑>`。只在本機產生結果；文件與 PR 僅記彙總數字。彙總四種線索的配對覆蓋與已知失敗類別是否命中，不查看或記錄查詢、內容、識別碼、檔名或專案名稱。
5. **決策閘門：** 只有既有線索能在已知失敗配對上建立可核對的方向關係，且合成正例／負例及私有題庫結果支持低誤判風險時，才加入最小衍生重排；保留 PR #262 的候選範圍、兩筆紀錄與分數門檻，也保留 PR #263 的 raw 半權重。不以建立時間或文字相似度單獨推斷取代，不新增 schema。若線索沒有命中已知配對或證據不足，將排序期望標成 `it.todo`、`it.fails` 或明確的已知限制，不改排序程式，回寫知識品質路線圖並完成 PR 1 後停止該排序議題。
6. 使用相同的 repo 外唯讀快照與相同題庫跑改動後評估，產生 repo 外的新結果檔；私有題庫前後數字並列比較。不得覆寫題庫或既有結果。若 PR 1 僅合併測試與結論，亦記錄前後數字相同及原因。
7. 執行全部驗證：`pnpm test:retrieval-quality`、`pnpm bench:recall-scale`、`pnpm test:performance`、`pnpm test:response-size`、`pnpm typecheck`、`pnpm test`。Windows 本機既有超預算項目須與變更分開說明；效能結論以 CI Ubuntu 或同一台機器的前後對照為準。
8. 依第 7 節最低交付要求更新 `docs/knowledge-quality-roadmap.md`，建立 PR，僅包含彙總數字與機制層級說明。等待 CI 通過後才合併；無可靠線索時仍依停止分支合併測試與結論，不要求排序品質收益。
9. PR 1 完成且第 3 節的結論成立後，再從 §4 的實驗 A 開始獨立 PR 2；不把 Raw 候選實驗併入 PR 1，也不建立人工審核流程或自動 Knowledge。

---
## 11. 最終判準

> **開發工作累積得越久，Agent 越能以更少時間、更少 Token 找到正確、目前適用且有來源支持的資訊；使用者則不需要花更多心力維護系統。**

**一句話總結：讓資訊更可靠、檢索更精準、使用者更輕鬆。**
