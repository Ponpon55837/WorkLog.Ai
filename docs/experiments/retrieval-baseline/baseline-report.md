# 檢索與知識頁基準報告（只改 Agent 指引前）

這份報告記錄「只改 Agent 指引」之前的基準。要回答的問題是：知識頁維護與檢索又慢又貴，原因在 SQLite、在 MCP 回應太大，還是在 Agent 的推理與輸出。報告只寫彙總數字，逐題結果在 `baseline.results.json`。

## 結論先講

- **SQLite 不是瓶頸。** 30 題檢索的 store 讀取中位數 1.93 ms，p95 9 ms；知識頁 context 讀取 0.2–0.7 ms。這是本機合成資料、68 個 Session 的規模。大規模的讀取路徑另由 `pnpm test:performance`（5,000 個 Session）把關。
- **MCP 回應大小有明顯差距。** `work_get_context` 每次約 9.8k 字元，是 `work_recall`（平均 2.3k）的 4 倍左右。兩個落後同一批 49 個 Session 的知識頁，一次 context 讀取就有 13.2k–13.5k 字元，而且 `truncated` 為 true。Agent 每多呼叫一次，這些字元就再進一次上下文。
- **Agent 推理與輸出的部分，本報告沒有數字。** 這部分要用真實 Agent 跑 `knowledge-page-e2e.md` 的情境，再用 `scripts/agent-usage-report.mjs` 收集 Token，A/B 時兩個版本都要跑。

## 方法

- **合成資料**：`fixture.mjs` 建立一個虛構的渡輪訂位專案，包括：
  - 68 個 Session，其中 1 個已作廢。
  - 18 條 `continues` 連結、3 條 `related` 連結。`continues` 鏈長 5、6、5、4，另有兩條長 2 的短鏈。
  - 19 則 Knowledge：14 則有效、3 則被取代、2 則封存，其中 1 則被 Session 指為矛盾而帶 `needsReview`。
  - 3 個知識頁：其中兩頁共用同一批未看過的 Session，第三頁是最新的。

  時間使用固定時鐘，兩次執行的字元數與判分完全相同，只有毫秒數會變。
- **題庫**：`questions.mjs` 有 30 題，A 直接搜尋 6、B 決策原因 8、C 歷史演進 6、D 衝突過時 6、E 負例 4。標準答案依據（應引用的 fixture key、不可當成現況引用的 key、答案要點）依 fixture 設計手寫，沒有使用任何檢索輸出回填。每題的查詢是 Agent 現在會送的單一次呼叫，這就是基準方法。
- **runner**：`runner.mjs` 在暫存資料夾建立資料庫並植入 fixture，然後直接呼叫 store 的讀取函式。每題先暖機一次，再重複 5 次取中位數。
  - 回應字元數是 `JSON.stringify(輸出).length`，並套用與 MCP 相同的欄位整理。
  - 兩處是近似值：`work_search` 摘要以 110 字元截斷，`work_get_context` 的 `server` 欄位用固定物件。
- **判分**：
  - A、B 題：要引用的依據必須全部命中，且沒有把不可引用的紀錄當成結果。
  - C 題：命中比例至少 0.8。
  - D 題：除了全部命中，還要帶有題目指定的 `needsReview` 標記。
  - E 題：信心不可為 high，前 5 筆不可有相似但無關的紀錄。
  - 結果本身標示為 archived，或只是 Knowledge 搜尋的 relaxed 線索，不算違規命中。完整規則見 `README.md`。
- **Policy／安全案例**：P1–P5 必須 100% 通過，不計入統計。
  - P1：不得捏造或引用無效的來源 id。
  - P2：沒看過的 Session 不可標成已涵蓋。
  - P3：`needsReview` 不可被無故清除。
  - P4：`reviewToken` 不可跨頁或過期使用。
  - P5：`work_mark_knowledge_page_checked` 不接受無效 Session，也不能往回移。

## runner 數字

測量環境是 Node v22.23.5，每題重複 5 次。

| 類別 | 題數 | 通過率 | 平均命中比例 | 違規命中 | 耗時 ms（平均／中位數／p95） | 字元數（平均／中位數／最大） |
|---|---|---|---|---|---|---|
| A 直接搜尋 | 6 | 100% | 1.00 | 0 | 3.27 / 2.33 / 9.43 | 3,344 / 2,287 / 9,636 |
| B 決策原因 | 8 | 100% | 1.00 | 0 | 2.63 / 1.96 / 8.29 | 3,204 / 2,620 / 9,860 |
| C 歷史演進 | 6 | 83% | 0.81 | 0 | 3.04 / 1.96 / 8.27 | 3,693 / 2,784 / 9,846 |
| D 衝突過時 | 6 | 100% | 1.00 | 0 | 1.59 / 1.81 / 2.08 | 1,848 / 1,861 / 2,858 |
| E 負例 | 4 | 75% | — | 1 | 3.17 / 1.72 / 9.00 | 3,528 / 1,998 / 9,851 |
| 整體 | 30 | 93%（28／30） | 0.955 | 1 | 2.70 / 1.93 / 9.00 | 3,102 / 2,492 / 9,860 |

依工具分組的回應大小與耗時：

| 工具 | 題數 | 平均字元數 | 最大字元數 | 耗時中位數 ms |
|---|---|---|---|---|
| `work_recall` | 17 | 2,338 | 3,066 | 1.94 |
| `work_search_knowledge` | 6 | 1,072 | 1,561 | 1.25 |
| `work_search` | 3 | 2,559 | 3,327 | 2.86 |
| `work_get_context` | 4 | 9,798 | 9,860 | 9.00 |

知識頁 context 讀取：

| 頁面狀態 | 模式 | 字元數 | 顯示的 Session | 新 Session | `truncated` | 耗時 ms |
|---|---|---|---|---|---|---|
| 落後 49 個 Session（第一頁） | review | 13,462 | 47 | 49 | true | 0.66 |
| 落後同一批 49 個 Session（第二頁） | review | 13,171 | 47 | 49 | true | 0.62 |
| 最新 | review | 951 | 0 | 0 | false | 0.19 |
| 第一頁，使用者要求更新 | full | 13,498 | 50 | 49 | true | 0.71 |

Policy／安全案例 P1–P5 全部通過。

基準中失敗的 2 題照實保留，沒有為了通過而調整 fixture 或查詢：

- C3 用 `work_get_context` 問付款流程的演進，信心為 low，付款鏈的 5 個 Session 一個都沒有回來。
- E4 是負例，`work_recall` 的信心是 low，但前 5 筆有一則相似但無關的 Knowledge。

另外有兩件事要記下：

- E3 的通過取決於「relaxed 線索不算違規命中」這條規則。規則在執行前已經定義，但第一版程式套用時不一致，修正後 E3 才從失敗變成通過。
- C2 的命中比例是 0.83，剛好超過 0.8 的門檻。

## 合成資料的限制

- 規模小。68 個 Session 的耗時不能代表真實專案，SQLite 的大規模表現以 `pnpm test:performance` 為準。
- 題目與資料是同一批人依同一份設計寫的，用詞比真實工作紀錄整齊。A、B、D 三類都是 100%，代表這份題庫對現行檢索偏容易。A/B 時要特別看 C、E 兩類和回應大小。
- 題數少。每類 4–8 題，一題的變化就是 12–25 個百分點。
- runner 只量 store 層。MCP 傳輸、JSON 序列化以外的 MCP 包裝，以及 Agent 讀到回應後的推理，都不在 runner 的數字裡。
- 字元數不等於 Token 數。中英混合的 JSON 每個 Token 對應的字元數不固定，Token 一律以 `agent-usage-report.mjs` 從 Agent 紀錄讀出的數字為準。
- 知識頁端到端 5 題（K1–K5）需要 Agent 判斷，本次只驗證了 `--prepare` 能建出前置狀態，還沒有用真實 Agent 跑過。

## A/B 要比較的指標

每個指標都要在基準版與「只改 Agent 指引」版各量一次，兩邊用同一份 fixture、同一個 Agent 與模型、同一份題目。

| 指標 | 來源 | 說明 |
|---|---|---|
| 檢索通過率（整體與各類別） | runner 與 Agent 手冊 | Agent 版要依答案要點人工判分 |
| 違規命中與捏造來源數 | runner 與 Agent 手冊 | 必須為 0 |
| Policy／安全案例 | runner | 必須 100% 通過 |
| 知識頁 K1–K5 通過數 | `knowledge-page-e2e.md` 的機械檢查 | 例如 K1 的頁面版本不變、涵蓋位置前進 |
| 每題 Work Intelligence MCP 呼叫次數（依工具） | `agent-usage-report.mjs` | `workIntelligenceTools` |
| MCP 回應字元數加總 | `agent-usage-report.mjs` | `workIntelligenceToolResultChars` |
| input、output、cache read、cache creation Token | `agent-usage-report.mjs` | 分開比，不只比總和 |
| 回合數與總時間 | `agent-usage-report.mjs` | `turns`、首尾時間 |
| store 讀取耗時 | runner | 只用來確認 SQLite 沒有變成瓶頸 |

## 判斷原則

1. **品質門檻先過，才比速度與 Token。** 新版本的 Policy／安全案例必須 100% 通過，違規命中與捏造來源必須為 0。各類別通過率不得低於基準，K1–K5 通過數也不得低於基準。只要有一項沒過，Token 再省都不算改善。
2. **改善要分布在多數題目。** 如果 Token 或時間的下降只出現在少數幾題，其他題目持平或變差，就不算改善。要看各類別的中位數，不只看總和。
3. **`pnpm test:performance` 的門檻不放寬。** 只改 Agent 指引的版本不應該動到讀取路徑；如果效能測試變慢，先找原因，不調門檻。
4. **分開歸因。** store 耗時、MCP 回應字元數、Agent Token 三者分開記錄。只有回應字元數下降、Token 卻沒下降時，原因在 Agent 推理或輸出，不在 MCP 回應。
5. **同條件重跑。** 每個版本至少跑兩次。結果差異大於版本之間的差距時，先增加次數再下結論。
