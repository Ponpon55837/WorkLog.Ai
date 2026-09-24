# MCP tools 參考

每個 MCP tool 的用途、必填欄位、範例 payload 與 policy 行為。一般使用者不需要記住這些名稱——在 Codex／Claude 對話中用自然語言描述需求即可，Agent 會依 `.agents/skills/work-intelligence` 自行選用。

> 回到 [README](../README.md)

## 工具總覽

| 類別 | Tool | 用途 |
|---|---|---|
| Project | `work_get_project_status` | 唯讀查詢某個 workspace 是否「記錄中」；不能變更記錄狀態 |
| Session | `work_finalize_session` | 完成工作後保存 Session（必填 idempotencyKey、changedFiles、verification、workSummary） |
| Session | `work_update_session_metadata` | 回填既有 Session 的 changed files、verification、Git metadata |
| Session | `work_update_session_summary` | 以 replace／append 修正主摘要 |
| Session | `work_update_session_work_summary` | 以 replace／patch 修正五段 workSummary |
| Session | `work_attach_evidence` | 掛上 Agent 已確認的測試、命令或文件參考 |
| Session | `work_link_sessions` | 連結規劃與實作等相關 Session，檢索找到一筆時帶出另一筆 |
| Session | `work_void_session`<br>`work_void_evidence` | 作廢誤記錄的 Session、標示錯誤的 Evidence（可還原，保留作廢紀錄） |
| Context | `work_get_context` | 取回 tracked 專案的近期 Session、決策、Knowledge、metadata 缺口與待處理的 Agent 請求；帶 `task`／`paths` 時另回傳與這次工作相關的記錄 |
| Context | `work_recall` | 以關鍵字與檔案路徑排序查詢 Session（含 raw handoff 段落）與 Knowledge，開工前、遇到錯誤時使用 |
| Context | `work_list_sessions`<br>`work_get_session` | 依關鍵字、日期、專案分頁列出 Session；讀取單筆 Session 完整內容 |
| Context | `work_search` | 與 `work_recall` 同一個引擎，只查 Session |
| Knowledge | `work_record_knowledge`<br>`work_search_knowledge` | 明確提交與搜尋 Knowledge |
| Knowledge | `work_update_knowledge` | 編輯、封存或恢復 Knowledge |
| Knowledge | `work_get_knowledge_history` | 查詢 Knowledge 的不可變變更紀錄 |
| Graph | `work_get_graph` | 讀取 deterministic 工作圖譜 |
| Report | `work_get_report`<br>`work_export_report` | deterministic 報告與 Markdown／JSON 匯出 |
| Report | `work_request_report_synthesis`<br>`work_list_report_synthesis_requests`<br>`work_get_report_context`<br>`work_save_report_summary` | AI 報告整理流程（建立或找請求 → 取 context → 回寫） |
| Report | `work_retry_report_synthesis`<br>`work_cancel_report_synthesis` | 重試逾時請求或取消整理 |
| Backfill | `work_preview_metadata_backfill`<br>`work_request_metadata_backfill`<br>`work_list_metadata_backfill_requests`<br>`work_get_metadata_backfill_context`<br>`work_apply_metadata_backfill`<br>`work_cancel_metadata_backfill` | metadata 缺口掃描與 Agent 回補流程（見 REST API 文件的 Metadata backfill） |
| Import | `work_preview_handoff_import`<br>`work_import_handoffs` | 歷史 handoff 預覽與匯入 |

## `work_finalize_session`

在既有 closing handoff 完成後呼叫。`idempotencyKey`、`changedFiles`、`verification` 與固定格式的 `workSummary` 必填；Agent 必須先檢查工作樹／diff，沒有檔案變更時才傳 `changedFiles: []`。`verification.status` 必須明確是 `passed`、`failed` 或 `not_run`。`workSummary` 固定包含 `outcomes`（成果）、`scope`（範圍）、`decisions`（決策）、`verification`（驗證）、`nextSteps`（API 相容欄位，畫面標示「狀態／未結項」）五個陣列；每個元素是一件已確認的短句，沒有證據時傳空陣列，不使用 `##` Markdown 標題。`nextSteps` 只能記錄已知限制、未完成項目、證據缺口或未驗證情境，不可寫建議或未來計畫。Git 狀態另由可選 metadata 記錄。這讓 工作歷程、Session 面板 與 Agent context 都能用緊湊且一致的方式呈現。同一個 key 重試會得到原本 session，`duplicate: true`。`commitSha` 是可選 metadata；工作完成不要求 Git commit。

```json
{
  "projectRoot": "C:\\work\\assistant",
  "idempotencyKey": "assistant-2026-09-16-session-001",
  "title": "Add project recording policy",
  "summary": "Implemented explicit opt-in tracking and verified skipped states.",
  "workSummary": {
    "outcomes": ["Implemented explicit opt-in tracking."],
    "scope": ["Updated the MCP contract and central SQLite registry."],
    "decisions": ["Kept Agent work completion independent from Git commit."],
    "verification": ["Unit tests and typecheck passed."],
    "nextSteps": ["Firefox/WebKit 尚未驗證。"]
  },
  "handoffPath": ".openspec/handoffs/closing.md",
  "changedFiles": ["packages/project-policy/src/index.ts"],
  "changedFilesProvenance": [
    {
      "path": "packages/project-policy/src/index.ts",
      "sources": ["agent", "git"],
      "references": ["git diff --name-only"]
    }
  ],
  "verification": {
    "status": "passed",
    "summary": "Unit tests and typecheck passed."
  },
  "events": [
    { "type": "planning", "summary": "Defined default-deny policy." },
    { "type": "verification", "summary": "Confirmed paused and ignored projects are skipped." }
  ]
}
```

MCP client 的 stdio 設定可使用：

```json
{
  "mcpServers": {
    "work-intelligence": {
      "command": "pnpm.cmd",
      "args": ["--dir", "C:\\path\\to\\WorkLog.Ai", "start:mcp"],
      "env": {
        "WORK_INTELLIGENCE_DB": "C:\\path\\to\\WorkLog.Ai\\data\\work-intelligence.sqlite"
      }
    }
  }
}
```

## `work_get_context`

傳入 `projectRoot` 時只回傳該 tracked project 的內容；不傳則涵蓋所有 tracked projects。回傳的是精簡摘要（digest），讓一次呼叫能放進 Agent 的 tool-result 上限，完整內容再用對應工具讀取：

| 欄位 | 內容 | 讀取完整內容 |
| --- | --- | --- |
| `recentSessions` | 最近 12 筆 Session 的 id、標題、摘要（超過 400 字截斷）、完成時間、branch、verification 狀態、changed files 數量，以及前 3 項 `openItems`（`workSummary.nextSteps`） | `work_get_session` |
| `recentDecisions` | 最近 Session 的 `workSummary.decisions`（最多 12 條），每條附 `sessionId`、Session 標題與完成時間，方便引用來源 | `work_get_session` |
| `recentKnowledge` | 最近 12 筆 active Knowledge 的 id、kind、標題、tags 與 `excerpt`（本文超過 400 字截斷） | `work_search_knowledge` |
| `metadataFollowUps` | 只有筆數：`needsBackfill`、`changedFilesMissing`、`verificationMissing`、`verificationNotRun` | `work_preview_metadata_backfill` |

`recentDecisions` 不取 note／closing 事件，因為那些多半是 commit、工作區狀態等流程記錄。metadata 缺口指 verification 尚未回報／明確 `not_run`，或 changed-files metadata 缺漏的已完成 Session；Agent 應以 preview 取得明細、檢查對應 worktree、diff 或 handoff，再用 metadata tool 回填已確認的內容，系統不會自行猜測檔案變更。

`pendingRequests.reportSynthesis`／`pendingRequests.metadataBackfill` 列出 pending 或 processing、等待 Agent 處理的請求（新到舊，各最多 5 筆）。指定專案時也包含「所有專案」範圍的請求。

開工前可再傳 `task`（這次要做什麼，最多 500 字）與 `paths`（預計修改的檔案，最多 20 筆），回傳會多一個 `relevant`，依序是：

| 欄位 | 內容 |
| --- | --- |
| `relevant.knowledge` | 與 task／paths 最相關的 active Knowledge（最多 5 筆，gotcha、pattern、decision 等），格式同 `work_recall` 的 hit |
| `relevant.decisions` | 相關 Session 的 `workSummary.decisions`，每條附來源 `sessionId` |
| `relevant.sessions` | 相關 Session（最多 5 筆，包含改過同批檔案的 Session），附 `openItems` |
| `relevant.termHits` | 有關鍵字完全沒命中時才出現，列出每個關鍵字的命中筆數 |

```json
{ "projectRoot": "C:\\work\\assistant", "task": "修正報表時區", "paths": ["src/report/range.ts"] }
```

## `work_get_project_status`

唯讀查詢一個 workspace root 的記錄狀態：`tracked`、`paused`、`ignored` 或 `unregistered`，以及 `tracked: boolean` 與已註冊時的專案資料。Agent 在準備 finalize payload 前先呼叫，非「記錄中」就不要整理或保存工作。這個工具**不能**變更記錄狀態；授權只能由使用者在 Web UI 操作。

```json
{ "projectRoot": "C:\\work\\assistant" }
```

## `work_list_sessions` / `work_get_session`

`work_list_sessions` 依完成時間新到舊分頁列出 tracked 專案的 Session。可選 `q`（標題、摘要、事件關鍵字）、`from`／`to`（含頭尾的日曆日期，依 server 系統時區）、`projectRoot` 或 `projectId`、`page`、`pageSize`（1–100，預設 20）；回傳 `items` 與 `pageInfo.total`。非 tracked 的範圍會回傳 `skipped`。

`work_get_session` 用 `sessionId` 讀取單筆 Session：五段 workSummary、changed files、verification、events、evidence 與關聯 Knowledge。raw handoff snapshot 預設只回傳 `contentLength`，要全文時傳 `includeRawSnapshots: true`。Session 不存在回傳 `not_found`；所屬專案不是 tracked 則回傳 `skipped`。

```json
{ "projectRoot": "C:\\work\\assistant", "from": "2026-09-21", "to": "2026-09-27", "pageSize": 20 }
```

## `work_recall`

排序檢索 tracked 專案的 Session 與 active Knowledge，Agent 開工前（`q` 描述任務、`paths` 帶要改的檔案）、遇到錯誤時（`q` 帶錯誤訊息）或使用者問到過去的工作時使用。`q` 與 `paths` 至少提供一個；可選 `projectRoot`（先過 policy gate）與 `limit`（1–30，預設 8）。

- **索引範圍**：Session 的 title、summary、五段 workSummary、changed files、branch、events，以及 raw handoff snapshot 依 `#`～`###` 標題切成的段落；Knowledge 的 title、body、tags、references。
- **查詢**：以空白分隔的每個詞獨立比對，不需要整句完全相符；英文識別字會拆成 camelCase／snake_case 各段，中文以雙字切詞（兩字中文詞可直接查），常見虛詞（the、what、為什麼、如何…）會略過。
- **排序**：BM25 × 欄位權重（title 3、tags 2、summary／workSummary／Knowledge 本文 1.5、其他 1；raw handoff 只取最相關的一段並 ×0.5），再乘上「命中關鍵字比例（依 IDF 加權）的平方」，命中越多關鍵字的記錄排越前面，最後加上溫和的時間權重。changed files 超過 20 個的 Session，其檔案欄位與路徑命中會依比例降權。
- **路徑**：`paths` 可用絕對路徑、`專案名/相對路徑` 或相對路徑，比對前會去掉專案根目錄與專案名前綴；完全相同、檔名或路徑尾段相同、位於查詢的目錄下都算命中。Knowledge `references` 裡的 commit SHA 與 URL 會分開處理，不參與路徑比對。

每筆 hit 只包含 `type`（`session`／`knowledge`）、`id`、專案、標題、Knowledge `kind`、日期、`matchedIn`（命中欄位，路徑命中為 `path`）、raw 段落標題 `section`、約 220 字的 `excerpt`、`matchedPaths`、`score`，以及 Session 的關聯 Session `related`（id、標題、關係）。完整內容再用 `work_get_session` 或 `work_search_knowledge` 讀取，並在回覆中引用所依據的 `sessionId`／`knowledgeId`。有關鍵字完全沒命中時會附上 `termHits`（每個詞的命中筆數），Agent 可據此換詞重查。

```json
{ "q": "排程 重複執行 lock", "paths": ["src/scheduler/queue.ts"], "projectRoot": "C:\\work\\assistant" }
```

索引存在同一個 SQLite：寫入時由 trigger 標記變動的 Session／Knowledge，下一次查詢前才重建那幾筆，所以 REST、MCP 與 Web UI 的任何修改都會反映在檢索結果。第一次啟動新版本時會把既有資料全部標記，於第一次查詢時建立索引。

## `work_search`

與 `work_recall` 使用同一個引擎，但只查 Session，最多 20 筆；每筆包含 Session digest、命中欄位 `matchedIn`、raw 段落標題 `section` 與片段。需要 Knowledge 或路徑比對時改用 `work_recall`。結果只來自 tracked projects；project-scoped search 會再次通過 policy gate。

## Tool annotations 與 prompts

每個工具都有 MCP annotations，讓用戶端可以自動核准唯讀操作：

- `readOnlyHint: true`：查詢類（status、context、list、search、report、graph、preview、history）。
- `destructiveHint: true`：可能取代既有值的更新（摘要、workSummary、metadata、Knowledge、metadata 回補）；變更前的狀態依各工具說明保留在 audit。
- `idempotentHint: true`：相同 payload 重試不會再產生變化（finalize、evidence、Knowledge、摘要回寫等）。

另外提供兩個 MCP prompts：`finalize-work`（把這次工作記錄下來）與 `synthesize-report`（可選 `period`，整理報告）。

Server instructions 只放路由規則；Work record、Report synthesis、Metadata backfill 三份 contract 只附在負責寫入該資料的工具說明上，避免用戶端截斷過長的 instructions。

## `work_get_report`

建立可重複驗證的日、週、月、季或年報告。`period` 可用 `day`、`week`、`month`、`quarter`、`year`；`date` 是 server 所在系統時區的日曆日期，省略時使用 server 當下日期；`projectId` 可選，且指定專案必須是 `tracked`。季報與年報的 `trends` 以月份為單位，其他區間以日期為單位。

```json
{
  "period": "week",
  "date": "2026-09-16",
  "projectId": "optional-project-id"
}
```

回傳會包含：

- `periodSummary`：該期間的 deterministic 摘要
- `range`、`previousRange`：本期與上一期的日曆範圍（系統時區，名稱見 `timezone`）
- `comparison`：Sessions、Events、Changed Files 的 current/previous/delta/direction
- `completedWork`：主要完成事項（可由 Agent/UI 追到原始 Session）
- `totals.verification`（`not_supplied` 代表 Agent 尚未回報，不等同 `not_run`）、`risks`、`decisions`、`trends`
- `evidence`、`sessions`、`sourceSessionIds`：來源證據與完整 provenance

報告只聚合 tracked projects；指定 `unregistered`、`paused`、`ignored` 或不存在的 project 會回傳 `outcome: "skipped"`，不會讀取專案檔案。若 legacy caller 沒有提供 verification 或 changedFiles，finalize 回應會附上 `verificationFollowUp`／`changedFilesFollowUp`，要求 Agent 檢查後用 metadata tool 補回。

## `work_update_session_metadata`

用於既有 Session 的資料回填，不會建立新的 Session，也不會改變 `idempotencyKey`。Agent 應在完成工作後檢查實際 worktree/diff，再傳入確認過的 `changedFiles`；`verification` 可同時補回。沒有檔案變更時必須明確傳 `[]`，不能省略來讓系統猜測。`changedFilesMode` 預設為 `"replace"`；若是同一 Session 的另一個已獨立驗證 stage／commit，使用 `"merge"` 將新路徑與 provenance 與既有資料 union、dedupe。merge 只合併 Agent 明確提供的本次清單，不會讀取 Git 或自動吸收其他工作。

```json
{
  "sessionId": "session-id-from-work_finalize_session",
  "changedFiles": ["src/feature.ts", "README.md"],
  "changedFilesMode": "replace",
  "changedFilesProvenance": [
    { "path": "src/feature.ts", "sources": ["agent", "worktree"], "references": ["git diff --stat"] }
  ],
  "changedFileChanges": [{ "path": "src/feature.ts", "status": "modified" }],
  "verification": {
    "status": "passed",
    "summary": "Agent confirmed the verification result."
  }
}
```

## `work_update_session_summary`

修正已 finalized Session 的主摘要時，使用原本的 `sessionId`，不會建立平行 Session。這是與 `work_update_session_metadata`、`work_attach_evidence` 分開的正式契約：

- `mode: "replace"` 取代完整主摘要；`mode: "append"` 在既有摘要後加入一個以空行分隔的後續段落。
- 必須使用這次摘要更新自己的 `idempotencyKey`。相同 key、相同 payload 重試會回傳 `duplicate: true`，append 不會重複追加；相同 key 搭配不同 Session、模式或內容會回傳 conflict。
- 只更新 `sessions.summary` 與摘要更新 audit row，保留 `changedFiles`、`changedFilesProvenance`、`changedFileChanges`、`verification`、`git`、`events`、raw handoff snapshot、evidence、Knowledge 與原 Session id。
- 仍先通過 tracked project policy；`unregistered`、`paused`、`ignored` 會安靜回傳 `outcome: "skipped"`，不讀取或寫入受保護的專案資料。
- 如果 `work_finalize_session` 收到已使用過的 `idempotencyKey` 但 summary 不同，會回傳 `outcome: "idempotency_conflict"`，並提示改用本工具，不會假裝 duplicate 已更新摘要。

```json
{
  "sessionId": "session-id-from-existing-session",
  "idempotencyKey": "summary-update-2026-09-18-knowledge-save-label",
  "mode": "append",
  "summary": "補充 knowledgeChunkViewer 編輯態的確定按鈕已改為儲存，並同步 zh-TW、zh-CN、en-US 與 aria-label。"
}
```

## `work_update_session_work_summary`

修正已 finalized Session 的結構化五段工作摘要時，使用原本的 `sessionId`，不會建立平行 Session，也不需要重新 finalize：

- `mode: "replace"` 必須提供完整的 `outcomes`、`scope`、`decisions`、`verification`、`nextSteps` 五個陣列，取代整份 workSummary。
- `mode: "patch"` 可只提供一個或多個已確認的 section；未提供的 section 保留原值，明確傳入 `[]` 代表清空該 section。legacy Session 沒有 workSummary 時，patch 會從五個空陣列開始合併。
- 必須使用獨立的 workSummary 更新 `idempotencyKey`。相同 key、相同 Session／模式／內容重試會回傳 `duplicate: true`，不會重複追加或建立新 Session；不同內容會回傳 conflict。
- 只更新 `sessions.work_summary_json` 與 audit row，保留 Session id、原 idempotencyKey、summary、changedFiles、verification、Git metadata、events、raw handoff snapshot、evidence 與 Knowledge。
- 仍先通過 tracked project policy；`unregistered`、`paused`、`ignored` 會安靜回傳 `outcome: "skipped"`，不讀取或寫入受保護的專案資料。

```json
{
  "sessionId": "session-id-from-existing-session",
  "idempotencyKey": "work-summary-update-2026-09-18-knowledge-save-label",
  "mode": "patch",
  "workSummary": {
    "nextSteps": ["已完成後續修正，無待辦。"]
  }
}
```

## `work_link_sessions`

連結兩筆 tracked Session（`sessionId`、`relatedSessionId`、`relation`、`linked`）。`relation: "continues"` 表示 `sessionId` 接續 `relatedSessionId` 的工作（例如實作接續規劃）；`related` 是一般關聯。同一對 Session 只有一個關聯，新的 relation 會取代舊的；`linked: false` 移除。finalize 時也可以直接帶 `parentSessionId`（這筆接續的 Session）與 `relatedSessionIds`；無法建立的關聯（不存在、非 tracked、自己連自己）會列在回傳的 `linkWarnings`，不影響 Session 保存。

關聯會出現在 `work_get_session` 的 `links`（從該 Session 看是 `continues`／`continued_by`／`related`，已作廢的會標 `voided`）、`work_recall` Session hit 的 `related`（不含已作廢）與圖譜的 `session_link` 連線（兩端 Session 需在同一次回傳中）。只在使用者或記錄本身能確認關係時才連結。

```json
{ "sessionId": "implementation-session-id", "relatedSessionId": "planning-session-id", "relation": "continues" }
```

## `work_void_session` / `work_void_evidence`

作廢誤記錄或測試用的 Session（`sessionId`、`voided`、`reason`），或把錯誤的 Evidence 標示為錯誤（`evidenceId`、`voided`、`reason`）。`voided` 預設 `true`，作廢時必須提供 `reason`；傳 `voided: false` 則還原。兩者都是可還原的 soft-delete，每次變更都寫入作廢紀錄（Session 詳情的 `voidHistory`）。只在使用者要求或確認時作廢，不能用來隱藏真實但不想要的工作。

- 作廢的 Session 不會出現在 Session 列表（`work_list_sessions` 可用 `voided: "include"`／`"only"` 找回）、Dashboard、報告、圖譜、metadata 缺口、`work_get_context` 與 `work_recall`／`work_search`；`work_get_session` 仍可讀取，並帶 `session.voided`（時間與原因）。
- 標示錯誤的 Evidence 保留在 Session 詳情並附原因，但不再出現在報告與圖譜。正確的 Evidence 請另外用 `work_attach_evidence` 掛上。

```json
{ "sessionId": "session-id", "reason": "測試 MCP 設定時誤記錄" }
```

## `work_attach_evidence`

將 Agent 已確認的測試結果、命令輸出、文件或 review 參考掛到既有 Session。這個工具只保存呼叫端提供的 `kind`、`reference` 與可選 `summary`，不會自行讀取或推測參考內容；Session 所屬專案仍必須是 `tracked`。相同 Session、kind 與 reference 重試時會回傳 `duplicate: true`，不會建立重複證據。

```json
{
  "sessionId": "session-id-from-work_finalize_session",
  "kind": "test",
  "reference": "pnpm test --filter storage",
  "summary": "Storage and policy tests passed."
}
```

證據會在 Session 面板的 Evidence 區塊 顯示，也會加入報告的來源證據區塊；它不會取代 raw handoff、events 或 verification 原始資料。

## `work_record_knowledge` / `work_search_knowledge`

Knowledge 必須由 Agent 明確提交，不會因為 finalize、handoff 或 source 內容看起來像知識就自動抽取。`kind` 可用 `decision`、`pattern`、`gotcha`、`procedure` 或 `skill`；建議每筆 Knowledge 都提供唯一的 `idempotencyKey`，並在有對應工作時填入 `sessionId`，讓使用者可以回到來源 Session。

```json
{
  "projectRoot": "C:\\work\\assistant",
  "idempotencyKey": "assistant-knowledge-2026-09-17-001",
  "kind": "decision",
  "title": "Registry stays outside repositories",
  "body": "Keep project tracking in the central SQLite registry so side-project repositories receive no Work Intelligence config.",
  "sessionId": "session-id-from-work_finalize_session",
  "tags": ["architecture", "privacy"],
  "references": ["README.md#project-recording-policy"]
}
```

同一專案重試相同 `idempotencyKey` 會回傳原本的 Knowledge，`duplicate: true`；不會覆蓋原文。`work_search_knowledge` 預設只搜尋 `active` Knowledge，並支援 `projectRoot`、`projectId`、`q`、`kind` 與 `status` 篩選。所有結果只來自 tracked projects；unregistered、paused、ignored 專案會安靜回傳 `outcome: "skipped"`。

Knowledge 會出現在 「工作知識」頁、Session 面板的 Knowledge 區塊，也會由 `work_get_context` 以 `recentKnowledge` 提供給後續 Agent。這一層只保存 Agent 明確確認的內容，不讓 LLM 取代 policy decision 或原始資料保存。

### 可信度：`appliesTo`、確認與取代

- `appliesTo`：這筆 Knowledge 針對的專案內路徑或 glob（`*`、`**`、`?`；一般路徑也涵蓋其下的檔案）。從最後確認時間（沒有就用建立時間）之後，同專案未作廢的 Session 改到符合的檔案時，讀取結果會帶 `possiblyStale`（第一筆改動的 Session、路徑與之後共幾筆）。這是規則判斷，不推測內容是否真的過時；建立它的 Session 與最後確認它的 Session 不算。
- `supersedesId`：記錄新 Knowledge 時指定它取代的舊 Knowledge（同專案），舊的會自動封存並留下 audit；找不到時只在 `warnings` 提示，不影響保存。
- finalize 的 `appliedKnowledgeIds`：這次工作用到且仍然有效的 Knowledge，最後確認時間移到這筆 Session，並清除「需要檢視」。`contradictedKnowledgeIds`：這次工作發現已不成立的 Knowledge，會帶 `review`（`contradicted`、Session、時間）。找不到的 id 列在 `knowledgeWarnings`。所有變更都寫入 Knowledge audit。
- `work_get_context` 的 `recentKnowledge` 與 `work_recall` 的 Knowledge hit 會帶 `possiblyStale`／`needsReview` 旗標；使用前應先打開原文確認。

## `work_update_knowledge`

維護既有的 explicit Knowledge。必須傳入該筆資料所屬 tracked project 的 `projectRoot`；policy gate 會在讀取 Knowledge 前先執行。可以更新 `title`、`body`、`kind`、`tags`、`references`、`appliesTo` 或 `status`，`confirm: true` 表示檢查後仍然有效（更新最後確認時間、清除「需要檢視」，「可能過時」也會重新從這個時間計算），其中 `status: "archived"` 會將內容從預設 active 搜尋與 Graph 隱藏，`status: "active"` 可以恢復。每次建立、更新、封存或恢復都會保存不可變的前後狀態快照，供 audit history 追溯。這不是刪除操作，也不會讀取 source、handoff 或 Git。

```json
{
  "projectRoot": "C:\\work\\assistant",
  "knowledgeId": "knowledge-id-from-work_record_knowledge",
  "title": "Updated title",
  "body": "Keep the confirmed explanation current.",
  "tags": ["architecture", "maintained"],
  "references": ["README.md#project-recording-policy"],
  "status": "active"
}
```

「工作知識」頁提供同樣的編輯、封存與恢復操作；預設只顯示 active Knowledge，切換狀態篩選即可查看已封存內容。

## `work_get_knowledge_history`

查詢單筆 Knowledge 的不可變 audit history。必須提供同一個 tracked project 的 `projectRoot` 與 `knowledgeId`；結果會依最新到最舊回傳建立、更新、封存或恢復事件，包含 `before`、`after` 與 `changedFields`。既有 audit 功能加入前建立的 Knowledge 不會被猜測補造歷史，會從下一次變更開始留下快照；unregistered、paused、ignored 專案會安靜回傳 `outcome: "skipped"`。

「工作知識」頁每筆記錄的「更多」選單都有「變更紀錄」，顯示同一套前後快照。

## `work_get_graph`

以 read-only 方式建立 deterministic graph。節點來自 tracked project 的 Project、finalized Session、explicit Knowledge、attached Evidence 與 changed-file metadata；關聯只包含資料中已存在的 `contains`、`changed_file`、`has_knowledge` 與 `has_evidence`，不會讀取 source／handoff／Git，也不會自行推測相似度或因果關係。可用 `projectRoot`、`projectId` 與 `limit` 限定範圍；未授權專案會安靜略過。

```json
{
  "projectRoot": "C:\\work\\assistant",
  "limit": 50
}
```

回傳包含 `nodes`、`edges`、`sourceProjectIds` 與 `sourceSessionIds`，可供後續視覺化或其他 Agent context 使用；目前不包含自動產生的 LLM graph 摘要。

Graph 也回傳 `totalNodes`、`totalEdges`、`totalNodesByKind` 與 `truncation`。`maxNodes` 預設 180、上限 500；`maxEdges` 預設 360、上限 1,000。這些是 API 載入上限，前端另有畫面預覽配額；當 `nodesTruncated` 或 `edgesTruncated` 為 `true` 時，UI 可以提高載入上限或繼續載入，不會把完整資料誤當成已全部渲染。

大型 Graph 可額外傳 `pageSize`（1–500）啟用 server-side incremental page，並把 response 的 `nextCursor` 原樣傳回下一次 `cursor`。cursor 是 scope-bound opaque token；服務會依序處理 Project、Session 及其 changed files／Knowledge／Evidence 關聯，單一 Session 的關聯資料填滿節點上限時也會以同一個 Session 的 relation offset 續載，不會因為沒有下一個 Session 就誤判完成。`pageInfo.unit` 維持 `sessions` 相容欄位，另以 `pageInfo.phase` 反映目前 traversal phase；response 的節點數仍受 `pageSize`／`maxNodes` 限制。Web UI 會合併已載入頁面並透過 Graph viewport virtualization 控制 DOM 數量，因此資料量超過 500 時不需要一次渲染完整 Graph。

## 報告提煉：使用者只需要自然語言

工作報告頁 AI 報告整理卡上的「請 Agent 整理這份報告」只會在中央 SQLite 建立一筆 pending request，不會由 WorkLog 反向啟動或綁定 Codex、Claude。使用者接著在目前的 Agent 對話輸入：

```text
請處理我剛在 Work Intelligence 建立的報告提煉請求。
```

也可以不開 Web UI，直接說「幫我整理這週的 Work Intelligence 報告」。沒有待處理的請求時，Agent 會用 `work_request_report_synthesis` 自己建立一筆（範圍與去重規則和頁面按鈕相同）。metadata 回補也一樣：沒有待處理請求時，Agent 會用 `work_request_metadata_backfill` 建立；沒有缺口時回傳 `metadata_backfill_not_needed`。

Agent 會自行完成以下 implementation detail，使用者不需要知道工具名稱、requestId、JSON 或呼叫順序：

1. 找到最新的 pending report synthesis request。
2. 取得該期間與專案範圍的 deterministic report context。
3. 依 `report-synthesis-v3` contract 直接從來源 Session 產生符合日／週／月／季／年資訊粒度的繁體中文報告。
4. 將摘要、Agent／model／prompt metadata 與每個結論的 `sourceSessionIds` 回寫。

摘要至少要包含：

- 期間、專案範圍與一句話結論
- 工作主題／工作流與主要完成成果
- Verification：`passed`、`failed`、`not_run`、`not_supplied` 必須分開
- 與上一期的差異、風險／需要協助、技術決策與原因
- 目前已知狀態、未結項與限制；不生成未來計畫；每個主要結論可追溯至來源 Session

Agent 不得把「有 changed files」當成 Git commit，也不得從不足的 context 推測；沒有證據時要明確寫 `資料不足`。報告依日／週／月／季／年的時間尺度重新聚類，呈現成果、工作主題、決策、驗證與當下限制；不按日期寫流水帳，也不新增來源未提供的未來計畫。

若早上已完成一次提煉、下午又有新 Session，直接在工作報告頁按「重新整理」即可建立新 request。上一版摘要會保留到新的 Agent 摘要完成，再由新版本取代；每次回寫都保留歷史版本，pending request 沒有 Agent 處理時也不會遺失。

如果 Agent 在取得 Context 後中斷，WorkLog 不會讓舊 Agent 在稍後覆蓋新結果。processing 請求超過 30 分鐘會自動標記為可重試；工作報告頁會顯示失敗原因與「重試這次整理」，重試會建立新的 pending attempt 並保留舊請求歷史。MCP Agent 遇到逾時或中斷的 request 時，也應先使用 `work_retry_report_synthesis`，再取得新的 report context。尚未逾時的 processing request 不允許平行重試，以避免重複產生報告。

如果使用者不想繼續目前的 pending／processing 提煉，工作報告頁可以「取消這次整理」，也可以由 Agent 在自然語言請求中自行取消；取消只停止該次 Agent attempt，既有 deterministic report、摘要與歷史版本都保留。取消後的 context／save 操作會被拒絕，重新提煉會建立新的 request。歷史摘要清單只允許移除非目前版本，避免刪掉當前可讀報告。

## `work_preview_handoff_import` / `work_import_handoffs`

歷史 handoff 匯入採兩階段流程。預設掃描 tracked project root 下的 `.openspec/handoffs`（含子目錄）Markdown 文件；也可以傳入 `handoffDirectory`、`excludePaths` 與 `maxFiles`。preview 是唯讀 dry-run，會列出每個來源檔案的標題、日期、Verification、changed files 數量、是否可匯入與排除原因。

只有明確找到 `complete`、`accepted`、`resolved`、`done` 或 `implemented` 等完成狀態的 handoff 會標成 `eligible`。`blocked`、`pending`、`planning-only`、缺少明確完成狀態、無法讀取的文件都會保留在 preview，但不會被自動建立 Session。找不到 handoff 目錄時會回傳空 preview，不會掃描 project root 以外的 parent workspace。

確認 preview 後，將選取的 `sourcePaths` 傳給 `work_import_handoffs`。套用會保存 raw handoff snapshot、解析到的日期／Verification／changed files，並使用穩定 idempotency key；同一個來源檔案重試只會回傳 `already_imported`，不會建立重複 Session。Importer 不會執行測試或 Git commit；沒有在 handoff 中找到 changed files 時，Session 仍可匯入，但會保留 metadata 缺漏訊號供 Agent 後續用 `work_update_session_metadata` 補回。

REST 對應端點是 `GET /api/imports/handoffs/preview` 與 `POST /api/imports/handoffs`。專案 → Handoff 匯入分頁的「預覽 handoff」按鈕會使用同一套 preview → 勾選 → 套用流程。
