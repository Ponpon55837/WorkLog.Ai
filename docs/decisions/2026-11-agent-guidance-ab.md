# 決策紀錄：知識頁維護與檢索的 Agent 指引（階段三 A/B）

- 日期：2026-11-23
- 狀態：已決定
- 範圍：只改 `work-intelligence` skill 的文字，後端不變
- 證據：[`ab-report.md`](../experiments/retrieval-baseline/ab-report.md)、[`ab-results.json`](../experiments/retrieval-baseline/ab-results.json)

## 背景

階段二的基準（[`baseline-report.md`](../experiments/retrieval-baseline/baseline-report.md)）顯示瓶頸不在 SQLite，問題出在 MCP 回應大小與 Agent 的讀取方式。階段三只改 Agent 指引，看能不能讓知識頁維護和「為什麼／後來怎麼了／現在還適用嗎」這類問題的回答更正確或更省。導航讀模型（Gate 2）要等這一步有結果才決定。

## 選項

每一條都可以單獨開關：

- K-a：「檢查並更新變化」走 `review`，只有完整重寫才要求更新、切成 `full`。
- K-b：context `truncated` 時分批讀完，每批只存看過的 Session 支持的內容。
- K-c：多頁共用同一批 Session 時只讀一次，每頁各自判斷。
- K-d：內容沒變時用 `work_mark_knowledge_page_checked`，不重存同樣的段落。
- R-a：先用 `work_recall` 或 `work_get_context` 取得候選，依 `continues` 與時間排序，再精讀少數幾筆。
- R-b：回答時分開標示有明確連結的、推測的、資料不足的。
- R-c：額外工具呼叫上限 N，超過就用現有結果回答。

## 證據

- 知識頁（K1–K5，每格 2 次）：
  - 通過數 A 7/10、B1 10/10（語意判定；嚴格判定 A 6/10、B1 8/10）。A 的 3 次失敗分別是 K-a、K-b、K-d 針對的行為。
  - 成本沒有下降：token +1.2%，Agent 回合 144 → 141，MCP 呼叫 107 → 117。
  - K-c 看不出讀取次數減少。
- 檢索（13 題，每格 2 次，盲評）：
  - A、B1 都是 26/26，依據標示分數相同（49/52）。
  - token −1.0%，沒有達到改善或變差的門檻。
- 必過項目全部通過：沒有捏造 id；沒有把未讀的 Session 標成已涵蓋；`needsReview` 沒有被無故清除；policyCases P1–P5 全過；`pnpm test:performance` 門檻未改。
- 限制見 `ab-report.md`。其中兩項最重要：每格只有 2 次，以及兩輪用了不同的模型（Opus 5 與 Sonnet 5.5）。

## 決定

- 採用 K-a、K-b、K-d：寫在 `references/knowledge.md` 的「Page maintenance steps」。理由是它們修正了 A 實際出錯的行為，不是因為成本下降。知識頁的成本目標沒有達成，這部分不再為了降成本改寫。
- 不採用 K-c：沒有可測的效益。
- 不採用 R-a、R-b：A 已在天花板，B、C、D 類逐題沒有變好，依停止條件停止。
- 不採用 R-c：沒有跑 B2。建議值 N = 16（A 臂額外呼叫的第 90 百分位，涵蓋 C 類 5/6 的 run）只記錄在報告中。
- 不做導航讀模型（Gate 2）。

## 回退方式

- 刪除 `.agents/skills/work-intelligence/references/knowledge.md` 的「Page maintenance steps」小節，並同步 `plugins/work-intelligence/skills/work-intelligence/references/knowledge.md`（兩份必須逐位元相同，`tests/server/plugin.test.ts` 會檢查）。
- 不需要資料遷移，也不影響已存的知識頁版本。Agent 在下一次讀 skill resource 時就會拿到舊文字。

## 重新評估的條件

- 有新的檢索題能讓 A 臂失敗（例如 C 類長鏈、跨頁衝突），可以重跑 R-a、R-b，以及用 N = 16 的 R-c。
- Agent 實際使用中，若知識頁維護又出現自行切成 `full`、截斷後沒重讀、內容沒變卻重寫等行為，就重新檢查 K-a、K-b、K-d 的寫法。
- 成本仍是問題時，下一步要處理 MCP 回應大小（例如知識頁 context 的 13k 字元），不是再加指引文字。
- 用其他模型或每格至少 5 次重跑時，應更新這份紀錄。
