# Knowledge 頁面端到端情境（K1 至 K5）

這份文件定義 5 個需要 Agent 判斷力的 Knowledge 頁面維護情境，以及用真實 Agent 執行並評分的手冊。情境都建立在 `fixture.mjs` 的虛構專案 Tidewater（渡輪訂位系統）上，資料全是合成的。

目的：量測「Knowledge 頁面維護慢或貴」的成因是 SQLite、過大的 MCP 回應，還是 Agent 的推理與輸出。`runner.mjs` 已量到 store 端的耗時與回應大小；這裡量的是 Agent 端（turn、token、工具呼叫）。之後只改 Agent 指引的版本，會用同一批情境做 A/B 比較。

## 共同前提

- 每次執行都從全新的資料庫開始：`node docs/experiments/retrieval-baseline/runner.mjs --prepare K1 --db <新路徑>`。資料庫路徑不得已存在，不得指向你自己的資料。
- fixture 的頁面狀態（`--prepare` 前）：
  - `architecture`、`pitfalls`：在第 18 個 Session 之後以同一次讀取存檔（version 1），之後又有 49 個新 Session，所以兩頁落後的是同一批 Session，review 讀取會被截斷（`truncated: true`，約顯示 47 個）。
  - `in-progress`：在最後一個 Session 存檔，是最新狀態（`fresh`）。
  - 頁面內容刻意停在舊狀態，例如 `architecture` 仍寫「由 sweeper 每 60 秒清理過期保留」，而後來已改為 lazy expiry。
- 給 Agent 的提示（prompt）刻意中性：只說要維護哪一頁，不提示該用哪個工具、不提示是否要改寫。A/B 比較的就是指引造成的行為差異。
- 每個情境建議重複 3 至 5 次（每次重新 `--prepare`），報告中位數與範圍。
- 評分分兩層：機械檢查（從資料庫與工具呼叫紀錄判定，必須全過才算 pass）與人工抽查（只在機械檢查通過後做，記錄為備註）。

## 情境 K1：沒有需要修改，只需記錄「已檢查」

- 判斷重點：新增的 Session 與頁面內容無關時，應該用 `work_mark_knowledge_page_checked` 移動檢查游標，不該改寫頁面。
- 前置狀態：`--prepare K1` 在 fixture 之後新增 3 個 Session（更新 CI 快取設定、修正 README 錯字、升級 lint 規則版本），內容都與座位、票價、付款、候補無關。`in-progress` 頁面 version 1、`newSessionCount` 為 3。輸出的 `newSessionIds` 依時間先後排列，最後一個是游標目標。
- 給 Agent 的 prompt：「請維護 Tidewater 專案的 in-progress Knowledge 頁面，讓它反映最新狀況。」
- 預期的工具呼叫：
  1. `work_get_knowledge_page_context`（slug `in-progress`，review 模式，3 個 Session）
  2. `work_mark_knowledge_page_checked`（`throughSessionId` 為最後一個新 Session）
  3. 不應呼叫 `work_save_knowledge_page`。可以不讀 `work_get_session`，因為預覽已足以判斷無關。
- 預期結果：頁面內容與版本都不變，檢查游標前進到最後一個新 Session。
- 評分（機械）：

  | 檢查 | 判定 |
  | --- | --- |
  | 頁面版本不變 | `knowledge_pages.version = 1`，`knowledge_page_versions` 只有 1 筆 |
  | 游標前進 | `checked_through_session_id` 等於 `newSessionIds` 的最後一個 |
  | 沒有改寫 | 工具呼叫中沒有 `work_save_knowledge_page` |
  | 呼叫了檢查工具 | 工具呼叫中 `work_mark_knowledge_page_checked` 至少 1 次 |

  Agent 若在最後另外 `work_finalize_session`，不算違規，也不計分；它帶 `maintainedKnowledgePages: ["in-progress"]` 才是完整做法。
- 人工備註：最終回覆是否清楚說明「沒有需要修改，已記錄檢查」。

## 情境 K2：讀取被截斷，必須分批讀

- 判斷重點：`truncated: true` 代表只看到一部分 Session。只能把「讀過」的 Session 當作已處理，剩下的要再讀一輪，不能一次存檔就當全部涵蓋。
- 前置狀態：`--prepare K2`，不做額外修改。`architecture` 為 review 模式，落後 49 個 Session，第一次讀取只會回 47 個。
- 給 Agent 的 prompt：「請更新 Tidewater 專案的 architecture 頁面，納入最近的變更。」
- 預期的工具呼叫：
  1. `work_get_knowledge_page_context`（第一批，`truncated: true`，帶回 `reviewToken`）
  2. 視需要 `work_get_session` 查看關鍵 Session 的細節
  3. `work_save_knowledge_page`（帶第一批的 `reviewToken`）
  4. 再一次 `work_get_knowledge_page_context`（取得被截掉的剩餘 Session），必要時再存檔或 `work_mark_knowledge_page_checked`
  所以 `work_get_knowledge_page_context` 至少 2 次。
- 預期結果：所有 49 個 Session 都被讀過，頁面反映最新狀態（座位保留改為 lazy expiry、票價不快取、付款改輪詢加 webhook、候補 FIFO 與上限 30 人）。
- 評分（機械）：

  | 檢查 | 判定 |
  | --- | --- |
  | 沒有遺漏 | 結束時 `architecture` 的 `newSessionCount` 為 0（不計 Agent 自己 finalize 的 Session） |
  | 確實分批 | `work_get_knowledge_page_context` 對 `architecture` 呼叫至少 2 次 |
  | 有存新版本 | `knowledge_pages.version` 至少 2 |
  | 來源有效 | 每個新版本引用的 Session 都存在且未作廢（產品會以 `invalid_sources` 擋下，所以只要存檔成功即成立） |

  `newSessionCount` 大於 0 但最終回覆明確說出尚有多少未處理，記為 partial（不算 pass，單獨統計）。
- 人工抽查：`座位保留` 段落不再把 sweeper 寫成現行做法；引用的 Session 與內容相符。

## 情境 K3：多個頁面共用同一批 Session

- 判斷重點：`architecture` 與 `pitfalls` 落後同一批 Session。好的做法是不重複逐一檢視同一批 Session 的細節，並且兩頁都要處理完，不能只處理一頁就結束。
- 前置狀態：`--prepare K3`，不做額外修改。兩頁都是 version 1，都落後 49 個 Session，兩頁的 review 讀取都會被截斷。
- 給 Agent 的 prompt：「請同步維護 Tidewater 的 architecture 與 pitfalls 兩個 Knowledge 頁面。」
- 預期的工具呼叫：每頁各自 `work_get_knowledge_page_context`（至少各 2 次，因為都被截斷），各自 `work_save_knowledge_page`（帶該頁自己的 `reviewToken`）或 `work_mark_knowledge_page_checked`。可以用 `query` 或 `headings` 做聚焦讀取，避免重複讀取整頁。
- 預期結果：兩頁都處理到最新，兩頁內容各自反映與主題相關的變更，不互相混用。
- 評分（機械）：

  | 檢查 | 判定 |
  | --- | --- |
  | 兩頁都不落後 | 結束時 `architecture` 與 `pitfalls` 的 `newSessionCount` 都是 0 |
  | 兩頁都有處理 | 每頁 `version` 增加，或 `checked_through_session_id` 不為空 |
  | token 沒有混用 | 沒有 `invalid_review_token` 的錯誤（可由 MCP tool_result 內容或 Agent 回覆觀察；產品也會拒絕混用） |
  | 內容時效 | `pitfalls` 的 `保留與過期清理` 段落提到 lazy expiry 或「讀取時判斷」，不再把 sweeper 當成現行做法 |

- 效率指標（不計 pass/fail，只比較）：兩頁合計的 turn、token、`work_get_session` 次數、MCP tool_result 字元數。
- 人工抽查：兩頁的修改是否各自切題。

## 情境 K4：使用者要求完整改寫（full 模式）

- 判斷重點：頁面被明確要求更新（`update_requested_at` 有值）時，讀取會進入 full 模式，給最新的 Session 供「完整改寫」；此時不該只做增補，也不該用「已檢查」帶過。
- 前置狀態：`--prepare K4` 對 `architecture` 提出更新請求。讀取為 `mode: "full"`，回傳最新 50 個 Session（`truncated: true`）。
- 給 Agent 的 prompt：「請把 Tidewater 專案的 architecture 頁面依目前所有工作完整改寫。」
- 預期的工具呼叫：`work_get_knowledge_page_context`（full 模式），必要時 `work_get_session`，然後 `work_save_knowledge_page`（帶 `reviewToken`）。不該只呼叫 `work_mark_knowledge_page_checked`。
- 預期結果：頁面以現況完整重寫，涵蓋座位保留、票價、付款、候補四個主題。
- 評分（機械）：

  | 檢查 | 判定 |
  | --- | --- |
  | 有存新版本 | `version` 至少 2 |
  | 更新請求已結清 | `update_requested_at` 為 NULL（存檔會清除） |
  | 主題完整 | 最新版本 `sections_json` 的段落至少 4 段，且文字涵蓋「座位保留、票價、付款、候補」四個主題（比對關鍵字） |
  | 內容是現況 | 座位保留段落含「lazy」或「讀取時」；票價段落不含「04:00」；付款段落含「輪詢」；候補段落含「30」或「FIFO」或「申請時間」 |
  | 沒有取巧 | 該頁沒有被單獨 mark checked 帶過（`version` 有增加） |

- 人工抽查：沒有引用不存在的來源（產品會擋下）；舊結論（sweeper、票價快取）是否被正確改掉。

## 情境 K5：引用的來源被作廢

- 判斷重點：頁面引用的 Session 被作廢後，頁面標為 `needsReview`。`work_mark_knowledge_page_checked` 不會清除這個標記；必須存新版本，且不能再引用已作廢的 Session。
- 前置狀態：`--prepare K5` 作廢 Session「修正航班時間時區顯示錯誤」，它是 `pitfalls` 頁面 `時區` 段落的唯一來源。`pitfalls` 讀取時 `needsReview: true`，`reviewSections` 指出 `source_voided_after_save`。同時它仍落後 49 個 Session。輸出的 `voidedSessionId` 是被作廢的 Session。
- 給 Agent 的 prompt：「請檢查並維護 Tidewater 專案的 pitfalls 頁面。」
- 預期的工具呼叫：`work_get_knowledge_page_context`，辨識 `needsReview` 與被作廢的來源，必要時 `work_get_session` 另找可靠來源，`work_save_knowledge_page`（帶 `reviewToken`）。
- 預期結果：頁面存成新版本，`時區` 段落要嘛改以有效來源重新支撐，要嘛移除或改為「資料不足」且不引用該 Session。
- 評分（機械）：

  | 檢查 | 判定 |
  | --- | --- |
  | 有存新版本 | `version` 至少 2 |
  | 警告已清除 | 讀取頁面（或 `work_get_context` 的 `knowledgePages`）不再有 `needsReview` |
  | 沒有引用作廢來源 | 最新版本 `sections_json` 的 `sourceSessionIds` 不含 `voidedSessionId`（產品會擋下） |
  | 沒有只用檢查帶過 | `version` 有增加；只有 mark checked 而 `needsReview` 仍在，記為 fail |

  `pitfalls` 另外落後的 49 個 Session 不計入 pass，但請記錄最終 `newSessionCount`，與 K2 同一指標比較。
- 人工抽查：`時區` 段落的新內容有可靠來源，沒有憑空保留舊結論。

## Agent 執行手冊

這一節說明如何用真實 Agent 對準備好的資料庫執行情境或檢索題，並收集成本數字。流程只使用合成的暫存資料庫，不碰你自己的 Work Intelligence 資料。本手冊尚未在這次實驗中用真實 Agent 實跑；第一次執行請先用 K1 試跑，確認 MCP 連得上、工具名稱符合預期。

### 1. 準備資料庫

```
node docs/experiments/retrieval-baseline/runner.mjs --prepare K1 --db /tmp/wi-k1-r1/db.sqlite
```

- 情境名稱：`K1` 至 `K5`；30 題檢索題用 `BASE`（只有 fixture，沒有前置修改）。
- 輸出的 JSON 包含 `projectRoot`（Agent 的工作目錄）、`env.WORK_INTELLIGENCE_DB`（資料庫路徑）、各頁面起始狀態，以及 K1、K5 的 Session id。`ids` 是 fixture key 到真實 id 的對照，評分檢索題時用它把 Agent 引用的 id 換回 key。
- 每次重複執行都換新的資料庫路徑。

### 2. 讓 Agent 只連到這份資料庫

MCP 伺服器以環境變數 `WORK_INTELLIGENCE_DB` 決定資料庫（見 `packages/shared/src/database-path.ts`）。以 Claude Code 為例，用獨立的 MCP 設定檔，並以 `--strict-mcp-config` 避免載入你平常的設定：

```
{
  "mcpServers": {
    "work-intelligence": {
      "command": "node",
      "args": ["<checkout 完整路徑>/apps/mcp/dist/index.js"],
      "env": { "WORK_INTELLIGENCE_DB": "/tmp/wi-k1-r1/db.sqlite" }
    }
  }
}
```

在 `projectRoot`（步驟 1 輸出）下啟動 Agent，prompt 使用該情境的 prompt：

```
cd <projectRoot>
claude -p "<該情境的 prompt>" --mcp-config <上面的設定檔> --strict-mcp-config
```

注意事項：

- 這個 Agent 只應該連 Work Intelligence 的 MCP，不要讓它改動 checkout 的檔案；工作目錄是空的暫存資料夾。
- 檢索題的 prompt 建議：「請只根據 Work Intelligence 的記錄回答這個問題，並列出你引用的 Session 與 Knowledge id：<題目>」。每題用全新的 Agent 對話，資料庫可重用 `BASE`（檢索題是唯讀）。
- 記下執行開始前的時間（ISO 格式），下一步的 `--since` 要用。

### 3. 收集 token 與工具呼叫

Agent 的對話紀錄是 Claude Code 的 session jsonl（預設在 `~/.claude/projects/<工作目錄編碼>/` 下，以最新修改的檔案為準）：

```
node scripts/agent-usage-report.mjs <session jsonl> --since <開始時間 ISO> --json
```

輸出每個 session 的：turn 數、各工具呼叫次數（Work Intelligence MCP 的工具另外列出）、input、output、cacheRead、cacheCreation token，以及 MCP tool_result 的字元數。它不輸出訊息內容或工具輸入，所以看不到 `reviewToken` 或 slug；需要這類資訊時改看資料庫狀態。

Codex 的本機紀錄（`~/.codex/sessions/**/*.jsonl`）是實驗性支援：解析規則依 Codex 原始碼整理，還沒有用真實紀錄核對過。使用前先跑 `--debug-shape` 確認格式，並拿一個 session 的 Token 總數和 Codex 的 `/status` 比對；輸出中的 `codexTokenMismatches` 不是 0 時，不要採用這份數字。Codex 的 input 已換算成不含 cache 的定義，和 Claude Code 一致。

### 4. 檢查資料庫狀態

Agent 結束後，用 Node 直接讀資料庫（唯讀）：

```
node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1], { readOnly: true });
console.log(db.prepare("SELECT slug, version, checked_through_session_id, covered_through_session_id, update_requested_at FROM knowledge_pages ORDER BY slug").all());
console.log(db.prepare("SELECT p.slug, v.version, v.author, v.sections_json FROM knowledge_page_versions v JOIN knowledge_pages p ON p.id = v.page_id ORDER BY p.slug, v.version").all());
' /tmp/wi-k1-r1/db.sqlite
```

`newSessionCount` 與 `needsReview` 是讀取時計算的，不存在資料庫欄位；要看它們，請讓 Agent 結束後由你以相同資料庫再執行一次唯讀讀取（例如重新啟動 MCP，呼叫 `work_get_knowledge_page_context` 或 `work_get_context`）。

### 5. 記錄結果

每次執行記一列：情境或題目 id、第幾次、pass/partial/fail、turn、各類 token、Work Intelligence 工具呼叫次數與名稱、MCP tool_result 總字元數、備註。A/B 比較時，兩邊使用相同的 fixture、相同的 prompt、相同的重複次數，只改 Agent 指引。

### 檢索題的評分

- `citeRecall`：Agent 引用的 id 換回 fixture key 後，包含多少比例的 `gold.mustCite`。
- 「引用」不能只看 Agent 讀到什麼，要看它最終回答中引用了什麼；回答若採用了 `mustNotCite` 的內容當作現行結論，記為 forbidden。
- 負例（E 類）的正確行為是回答「查無相關資料」。
- `gold.points` 的要點涵蓋度由人工或另一個盲評流程判斷，與 `runner.mjs` 的檢索指標分開記錄。
- `runner.mjs` 的檢索結果代表「基準方法：一次 plain 查詢」能不能找到答案；真實 Agent 可以改寫查詢、多次查詢與逐筆閱讀，兩者的差距就是 Agent 推理所貢獻的部分。
