# 檢索與 Knowledge 頁面基準

用來回答：Knowledge 頁面維護與檢索變慢、變貴，是因為 SQLite、過大的 MCP 回應，還是 Agent 的推理與輸出。資料全是虛構的渡輪訂位專案，不含任何真實資料。

## 檔案

- `fixture.mjs`：決定性的合成專案（約 68 個 Session、4 條以上的 continues 鏈、19 則 Knowledge、3 個頁面）與 `seedFixture(store, root)`。每個實體都有固定的 fixture key，會回傳 key 對應 id 的表。
- `questions.mjs`：30 題檢索題的手寫 gold（A 直接搜尋 6、B 決策原因 8、C 歷史演進 6、D 衝突過時 6、E 負例 4），以及 5 個必須 100% 通過的政策案例（`policyCases`）。gold 只依 fixture 設計撰寫，不看檢索結果。
- `runner.mjs`：建立暫存資料庫並植入 fixture，直接呼叫 store 的讀取函式，量測耗時、回應字元數與命中率，並執行政策案例。
- `knowledge-page-e2e.md`：5 個需要 Agent 判斷的頁面維護情境（K1 至 K5）、評分標準與用真實 Agent 執行的手冊。
- `baseline.results.json`：目前版本的基準結果。
- `baseline-report.md`：基準報告，含方法、限制、彙總數字與 A/B 的判斷原則。
- `ab-results.json`：階段三 Agent 指引 A/B 的彙總數字（不含逐筆回答與 id）。
- `ab-report.md`：階段三 A/B 報告，含方法、限制與結論；決策紀錄在 `docs/decisions/2026-11-agent-guidance-ab.md`。

## 執行

先 `pnpm build`，再：

```
node docs/experiments/retrieval-baseline/runner.mjs [--json <新檔案>] [--repeat 5]
node docs/experiments/retrieval-baseline/runner.mjs --prepare <K1..K5|BASE> --db <新的資料庫路徑>
```

- 預設會印出各類別與整體的通過率、耗時（平均、中位數、p95）與回應大小（平均、中位數、最大），以及頁面讀取與政策案例結果。
- `--json` 不會覆蓋既有檔案。`--repeat` 是每題重複次數，取暖機一次後的中位數。
- 任何政策案例失敗時結束碼不是 0。
- `--prepare` 只建立資料庫並套用該情境的前置狀態，然後結束；資料庫路徑必須不存在。

## 判定規則（摘要）

- 命中率 `citeRecall`：gold 的 `mustCite` 有多少比例出現在回傳的結果中。只查 Session 的工具只算 `s.` 開頭的 key，只查 Knowledge 的工具只算 `k.` 開頭的 key。
- `forbiddenHit`：`mustNotCite` 的紀錄被當成結果回傳。若回傳內容本身標示為 archived，或只是 Knowledge 搜尋的 relaxed（部分相符）線索，則不算。
- 通過條件：A、B 需 `citeRecall` 為 1 且沒有 forbiddenHit；C 需 `citeRecall` 至少 0.8；D 另需帶有 `mustFlag` 指定的信任標記（例如 `needsReview`）；E 需信心不是 high（Knowledge 搜尋則不得有 strict 命中），且前 5 筆沒有任何相似但無關的紀錄。
- 回應字元數是 `JSON.stringify(輸出).length`，並套用與 MCP 相同的欄位整理；已知差異：`work_search` 的摘要壓縮以 110 字元截斷近似，`work_get_context` 的 `server` 欄位以固定物件近似。
