# 專案現況與未結項

目前仍開放的工作，以及最近一次盤點的結果。完成的項目直接從這裡移除；過程細節請看 Git 歷史與 PR。

> 回到 [README](../README.md)

- 最後更新：2026-09-24

## 優先改善：Agent 檢索品質

目標：讓 Agent 透過 MCP 查工作記錄與 Knowledge 時「找得到、放得進 context、敢用」，工作記錄才會成為可靠的幫手。以下是 2026-09-24 在本機以真實 DB 快照做的評估；評估只讀快照副本、沒有修改資料。為保護使用者資料，這裡只記錄彙總數字與機制層面的發現，不收錄任何查詢內容、Session／Knowledge 內容、id 或專案檔名；評估題與腳本只留在本機，不進 repo。

### 評估發現

1. **搜尋幾乎找不到資料**：`work_search` 把整個查詢字串當成一個 `LIKE '%…%'`，Agent 慣用的多關鍵字查詢一律 0 筆；`work_search_knowledge` 同樣如此。36 題評估題中，現行搜尋 hit@5 只有 14%，31 題回傳 0 筆；唯一有命中的檔名題型，是剛好比對到 Knowledge 的 `references` 欄位。
2. **約 69% 的 Session 內容搜不到**：歷史 handoff 匯入的 Session，title 只有 slug，summary 與 events 是固定句，真正內容在 raw snapshot（平均約 4.2 萬字、最大約 20 萬字），完全不在搜尋範圍。重要的事故與決策因此無法被找回。
3. **回傳過大，入口工具本身超出 Agent 上限**：`work_get_context` 單一專案回傳約 107 KB，被用戶端改寫到暫存檔；其中 `recentSessions` 約 49 KB（`changedFilesProvenance`、`changedFileChanges`、`changedFiles` 合計約 27 KB），`metadataFollowUps` 約 17 KB 是回補用資料、與開工無關。`work_search` 單一關鍵字只命中 1 筆也可能回傳 67 KB，因為回傳完整 Session 物件（該筆有近 200 個 changedFiles）。
4. **context 與任務無關**：`recentDecisions` 取最近 8 個 `note`／`closing` 事件，實際內容多是 commit、工作區狀態這類流程記錄，不是技術決策；真正的決策在 `workSummary.decisions`（只有約 10% 的 Session 有填），context 沒有回傳。`recentKnowledge` 只依更新時間取 12 筆，與要做的工作無關。也沒有「我要改這個檔案，過去有什麼記錄」的查法。
5. **Knowledge 量少、路徑格式不一**：active Knowledge 只有個位數。`references` 混用「專案名／相對路徑」、「相對路徑」與絕對路徑三種格式，也夾雜 commit SHA，要先正規化才能做路徑比對。
6. **changedFiles 異常會汙染路徑檢索**：changed files 異常多的 Session 在檔名查詢中經常擠進前 3 名。
7. **Skill 沒有「何時該查」的規則**：只要求在使用者問到過去工作時才查，Agent 不會在開工前或遇到錯誤時主動查。

### 候選檢索策略實測

評估題共 36 題、5 類：K＝找 gotcha／pattern（7）、S＝Session 主題（10）、R＝答案只在 raw handoff（10）、N＝自然語句提問（4）、P＝以檔名／路徑查（5）。指標為 hit@5（答案出現在前 5 筆）、MRR（正確答案排名倒數平均）、0 筆題數。

| 策略 | K | S | R | N | P | 全部 hit@5／MRR／0 筆 | 前 5 筆回傳大小 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S0 現行（整句 LIKE、依時間排序） | 0% | 0% | 0% | 0% | 100% | 14%／0.14／31 | 最大 67 KB |
| S1 拆字 AND ＋ 擴充欄位 | 71% | 100% | 0% | 0% | 100% | 56%／0.49／16 | 約 1.5 KB |
| S2 拆字 OR ＋ 欄位權重排名 ＋ 中文雙字切詞 | 100% | 100% | 30% | 75% | 100% | 78%／0.73／0 | 約 1.3 KB |
| S3 S2 ＋ raw snapshot 整份索引 | 100% | 100% | 90% | 100% | 100% | 97%／0.89／0 | 約 1.2 KB |
| S4 S3 ＋ 路徑正規化比對 | 100% | 100% | 90% | 100% | 100% | 97%／0.91／0 | 約 1.2 KB |
| **S5 S2 ＋ raw 依標題切段 BM25 ＋ 路徑比對** | 100% | 100% | 100% | 100% | 100% | **100%／0.95／0** | 約 1.3 KB |

擴充欄位＝title、summary、workSummary 五段、changedFiles、branch、events，以及 Knowledge 的 title、body、tags、references。欄位權重：title 3、Knowledge tags 2、summary／workSummary／Knowledge body 1.5、其他 1、raw 0.6（S5 的 raw 段落分數 ×0.5 加權）；分數再乘上「命中關鍵字比例的平方」，偏好命中多數關鍵字的結果。

從實測得到的設計結論：

- **raw snapshot 必須切段索引**：整份索引時，超長文件幾乎包含所有字詞，會把正確答案擠下去。依 `#`～`###` 標題切段（每份平均約 70 段）並以 BM25 做長度正規化後修正，結果也能附上命中的段落標題。
- **FTS5 trigram 不能單獨使用**：trigram 至少要 3 個字元，實測兩字中文詞 trigram 0 筆、LIKE 有結果。兩字中文詞要退回 LIKE 或另做雙字切詞；超過 3 字的中文連續字串切成雙字 token。
- **路徑查詢要先正規化**：去掉專案名前綴與絕對路徑前段後比對尾端，P 類 MRR 由 0.87 提升到 1.00。
- **限制**：評估題是看過資料後撰寫，絕對數字偏樂觀、題數也少；適合比較方案間的相對差異。

### 改善計畫

**第一階段：找得到、放得進 context**（已完成實作，見下方「最近完成」）

剩下的項目：

- 以本機真實 DB 快照重跑上面 36 題評估，確認實作後的 hit@5／MRR 與 S5 預期一致；評估題與腳本仍只留在本機。
- `work_search_knowledge` 與 Web 的 Session 列表／Knowledge 搜尋仍是整句 LIKE（UI 需要分頁與時間排序）；Agent 改用 `work_recall`，UI 是否改用排序檢索另外評估。

**第二階段：可信度與回饋**

- 併入下方「Session 關聯」：找到規劃 Session 時帶出實作 Session。（Session 作廢已完成。）
- Knowledge 加 `appliesTo`（路徑／glob）、`lastConfirmedAt`／`lastConfirmedSessionId`、`supersedes`；`appliesTo` 的檔案在確認時間後被其他 Session 改過時，標示 `possiblyStale`（規則判斷，不靠推測）。
- `work_finalize_session` 可選回報 `appliedKnowledgeIds`／`contradictedKnowledgeIds`：用過且有效的更新確認時間，被推翻的在 Knowledge 頁與 context 提示更新或封存。
- 以 Agent 請求流程（比照 metadata backfill）從 raw snapshot 整理 Knowledge 候選，經確認後才寫入，維持 Knowledge 必須明確提交的原則。

## 未結項

| 項目 | 狀態 | 說明 |
| --- | --- | --- |
| TypeSafe Adapter（Insight Provider Phase 2） | BLOCKED：等待外部契約 | Provider abstraction、No-op 與 optional injection 已完成，`WorkIntelligenceStore` 預設使用 No-op。開始實作前需要 TypeSafe／產品方先定稿：SDK 或 HTTP endpoint 與版本；backend-only credential 注入、日誌遮罩與資料外送規則；evaluation request／response／error schema（signal、confidence、usage、timeout）；timeout、retry、circuit-breaker 契約；egress guard 的呼叫邊界。這些到位前不新增依賴、網路呼叫、設定開關或假 adapter。 |
| Async path resolver | 刻意延後 | 2026-09-22 以 200 個 changed-file paths 量測，中位數約 205 ms。只有在提高 metadata 上限、加入批次 ingest，或實測到 server／UI 阻塞時，才用真實資料重新量測並評估 async 重構。 |
| Graph 總數計算 | 觀察中 | Graph 會載入所有 tracked Session 來計算節點總數；5,000 筆合成資料約 53 ms，目前不是瓶頸。 |
| 自訂期間報告 | 提案 | `work_get_report`／報告頁只支援日／週／月／季／年；sprint 或「上次 release 到現在」這類 `from`／`to` 區間尚未支援。 |
| Session 關聯 | 提案（併入 Agent 檢索第二階段） | 規劃與實作常拆成兩筆 Session 且沒有關聯；可加 `relatedSessionIds`／`parentSessionId`，檢索找到一筆時帶出另一筆，圖譜也能畫出工作流。 |
| changedFiles 品質 | 提案（檢索降權在第一階段） | 有「唯讀盤點」Session 記到 41 個 changed files，疑似把既有 dirty worktree 算進去，檢索評估中已實際擠進檔名查詢前 3 名。第一階段先在排序時降權；根本解法仍是在 finalize 記錄 baseline，或在 UI 標示異常。 |
| finalize 提醒 | 提案 | 目前完全依賴 Agent 記得 finalize；可提供 Claude Code Stop／SessionEnd hook 範例提醒保存。 |
| 工程整理 | 提案 | `store.ts` 仍約 4,300 行（report、synthesis、backfill、context 可再拆 service）；Web 沒有單元測試；server／mcp／web 沒有 coverage 門檻；沒有 DB 備份。schema 版本表已加入（`schema_migrations`），既有的欄位補齊檢查仍留在 `store.ts`。 |

## 最近完成（2026-09-23～24）

- **Verification 可在 UI 修正**：Session 面板的「編輯 Session」對話框新增 Verification 狀態（通過／失敗／未執行；未回報只能維持不變）與說明，只在有變更時送出 `PATCH /api/sessions/:id/verification`。migration 3 新增 `session_verification_updates`，Web 修正與 Agent 的 metadata 回填改動 verification 時都會留下前後值與來源，Session 詳情以「Verification 修改紀錄」顯示。
- **Session 作廢與 Evidence 更正**（Agent 檢索第二階段）：migration 2 為 Session 與 Evidence 加上 `voided_at`／`void_reason`，並新增 `void_audit` 作廢紀錄。作廢的 Session 從 Session 列表、Dashboard、報告、圖譜、metadata 缺口、近期決策、context 與檢索排除，詳情仍可開啟並顯示原因與作廢紀錄；標示錯誤的 Evidence 保留在詳情但不進報告與圖譜。MCP 新增 `work_void_session`／`work_void_evidence`，REST 新增 `PATCH /api/sessions/:id/void`、`PATCH /api/evidence/:id/void`，Session 列表可用 `voided` 篩選。Web：Session 面板可作廢（對話框必填原因）與還原（確認框），Evidence 可逐筆標示錯誤／還原，工作歷程新增「作廢」篩選，列表與面板顯示「已作廢」標籤。
- **Agent 檢索第一階段：排序檢索與 `work_recall`**：新增 `schema_migrations` 版本表；migration 1 建立 FTS5 檢索索引，涵蓋 Session 的 title、summary、五段 workSummary、changed files、branch、events 與 raw handoff（依 `#`～`###` 標題切段），以及 Knowledge 的 title、body、tags、references，既有資料在第一次查詢時回填。英文識別字拆成 camelCase／snake_case 各段、中文以雙字切詞；排序為 BM25 × 欄位權重 × 命中關鍵字比例平方 × 時間權重，changed files 超過 20 個的 Session 降權。新增 MCP `work_recall(q, paths, projectRoot, limit)` 回傳 Session＋Knowledge 混合的精簡 hit，有關鍵字沒命中時附 `termHits`；`work_search`（與 REST `/api/search`）改走同一個引擎、只查 Session、上限 20 筆；`work_get_context` 可帶 `task`／`paths`，回傳 `relevant`（相關 Knowledge、相關 Session 的決策、改過同批檔案的 Session 與未結項）。Knowledge `references` 在索引時把 commit SHA、URL 與路徑分開，路徑去掉專案根目錄與專案名前綴後比對。索引由 SQLite trigger 標記變動、查詢前重建，涵蓋 REST、MCP 與 UI 的所有寫入。以 60 筆各含 4.2 萬字 handoff 的合成資料量測：第一次建立索引約 0.74 秒，之後每次查詢約 38 ms，8 筆結果約 4 KB。另修正 storage coverage 設定沒有固定 `TZ=UTC`，在非 UTC 機器上日期邊界測試會失敗的問題。
- **Agent context 與搜尋改為精簡回傳**（Agent 檢索第一階段）：`work_get_context` 的 Session、Knowledge 改回傳 digest（摘要與 Knowledge 本文超過 400 字截斷、不含 changed files 清單與 provenance），Session 附前 3 項未結項；`recentDecisions` 改取 `workSummary.decisions` 並附來源 `sessionId`；`metadataFollowUps` 只回傳筆數，明細改用 `work_preview_metadata_backfill`。`work_search` 的每筆結果也改成同樣的 Session digest。以本機資料量測，單一專案 context 由約 107 KB 降到約 12.6 KB，單一關鍵字搜尋由 67 KB 降到約 0.5 KB。原本給 note／closing 事件用的近期決策 partial index 已不再使用並移除。
- **報告日期改用系統時區**（PR #10）：報告、趨勢與工作歷程日期篩選改依 server 所在系統時區計算，報告回傳 `timezone`，報告頁頁首顯示時區名稱。另外修正搜尋把 `%`、`_` 當萬用字元的問題，API 拒絕非 loopback 的 `Host`（防 DNS rebinding），Prettier 改為檢查全專案。
- **Session 摘要可在 UI 編輯**：Session 面板新增「編輯摘要」，可修改主摘要與五段 workSummary（每行一項）；只送出有變更的欄位，同一筆 Session 就地更新並留下 audit，其他欄位維持唯讀。
- **MCP 補強**（PR #11）：新增 `work_get_project_status`（唯讀記錄狀態）、`work_list_sessions`、`work_get_session`、`work_request_report_synthesis`、`work_request_metadata_backfill`；`work_get_context` 多回傳 `pendingRequests`。所有工具加上 MCP annotations，新增 `finalize-work`／`synthesize-report` prompts。Server instructions 精簡為路由規則（原本會被用戶端截斷），三份 contract 只附在負責寫入的工具上。
- **只顯示 tracked 專案的 Session**：Dashboard 的 Session／事件計數、最近完成的工作與工作歷程列表（`/api/sessions`）都排除已暫停、忽略的專案；資料仍保留在 SQLite，恢復記錄中後會再出現。這也修正了列表會列出、但點進去詳情卻 404 的不一致。
- **圖譜節點面板改為覆蓋**：面板覆蓋在圖譜右側，不再把圖譜往左推，欄寬維持不變；畫布右側多出可捲動空間，選取的節點會自動捲到面板左側。
- **資料盤點**：2 個 tracked 專案（DevTools、Assistant）共 62 筆 Session 全部有五段 workSummary。修正 5 筆重複或放錯區段的內容，只重新安排既有句子，沒有加入新內容。報告摘要目前有 3 份現行版本，全部是 `report-synthesis-v3`，每個區塊都有可對應的 `sourceSessionIds`。
- **CI**：Quality（Linux + Windows：build、test、typecheck、coverage）與 E2E（Linux Chromium），每個 PR 與 `main` push 都會執行，目前全綠。第一次執行失敗的兩個原因已修正（PR #4）：workspace 套件透過 `dist/` 互相引用，所以要先 build 再測試；Windows runner 預設 `autocrlf=true` 會讓 Prettier 看到 CRLF，現在以 `.gitattributes` 的 `eol=lf` 統一換行。使用的 Actions 已升到 Node 24 版本（`checkout` v7、`setup-node` v7、`pnpm/action-setup` v6、`upload-artifact` v7），不再出現 Node 20 過時警告。
- **工作圖譜改版**（PR #6）：分層排版讓知識、證據、檔案排在所屬 Session 旁邊，連線改為曲線；選取節點時淡化無關節點並自動捲到該節點；新增節點搜尋（`?q=`，Enter 選取第一筆）；欄寬隨容器調整；檔案節點改顯示檔名與目錄，Session 副標題改用 verification 中文標籤。
- **右側面板加大且可調整寬度**（PR #6）：Session 760、Knowledge 變更紀錄 640、圖譜節點 460px；拖曳左緣或用方向鍵調整，寬度依面板各自記住。
- **Storage 讀取效能**：新增 `completed_at` 全域索引與近期決策 partial index；日期條件改為可使用索引的寫法；報告與提煉的 IN 列表查詢固定 join 順序；metadata 預覽先在 SQL 預篩。以 5,000 筆合成資料量測（`packages/storage/bench/read-paths.bench.mjs`，見 [testing.md](testing.md)）：

  | 讀取路徑 | 修改前 | 修改後 |
  | --- | ---: | ---: |
  | Session 列表 | 9.6 ms | 0.6 ms |
  | Dashboard | 7.4 ms | 0.1 ms |
  | 週報 | 20.1 ms | 3.9 ms |
  | 年報 | 30.4 ms | 16.7 ms |
  | Agent context | 84.1 ms | 29.8 ms |
  | metadata 預覽 | 58.0 ms | 17.6 ms |

## 已完成、不要再列為待辦

UI 改版 P0–P4（六頁、共用 UI、App.vue 拆解、a11y、Ctrl／⌘ K）；集中 API client 與 AbortController；`store.ts` 拆出 repository；ESLint／Prettier；coverage 門檻（schema、storage handoff parser）；Graph server-side cursor 與 viewport culling；列表 virtual list；Provider + No-op；跨行程 idempotency 與 migration 交易保護；Content-Type 與 payload 上限；symlink real-path 二次檢查；`commit_required` 移除；handoff parser 單元測試與輸出邊界。
