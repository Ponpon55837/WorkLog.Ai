# Work Intelligence

## 後續 MCP／資料模型設計與驗收建議

以下需求來自實際用 MCP 回填既有 handoff 的使用經驗，作為目前版本的設計與驗收基準：

1. **分離執行與驗證狀態**：Session 以 `executionStatus: "completed"` 表示 finalize 已完成；它與 verification 分開。changedFiles 非空代表工作曾產生檔案變動，不能因此把驗證誤標成 `not_run`；`not_run` 只表示沒有執行驗證。
2. **保留證據來源**：MVP 已保存每筆 changedFiles 的 `changedFilesProvenance`，可追溯到 Agent、handoff、Git 或 worktree/diff；多 stage／多次 metadata 回報可用 `changedFilesMode: "merge"` 安全 union、dedupe，且不會把目前平行工作的未提交變更自動算進歷史 Session。
3. **固定路徑語意**：MVP 寫入時會把檔案路徑正規化為 tracked project root 的相對 POSIX 路徑，拒絕越界路徑；`changedFileChanges` 另外保存 `added`、`modified`、`deleted` 與 `renamed` 語意，重新命名會保存 `previousPath`。
4. **回填要可預覽**：批次 backfill 應先提供 preview／dry-run，顯示 session、來源、檔案數、狀態與排除原因，再以明確操作寫入；metadata 更新不可改變原本的 idempotencyKey、summary 或 events，也不可建立重複 Session。若 finalized Session 的主摘要需要修正，必須使用獨立且具 idempotency 的 `work_update_session_summary`。
5. **歷史匯入要支援排除**：pending、blocked、planning-only 或使用者明確排除的 handoff 不得只因日期符合就匯入。排除路徑與原因應保留在匯入結果中。
6. **維持 default-deny**：任何 handoff、Git、worktree 或 source 讀取，以及 metadata 回填，都必須先通過 project policy；unregistered、paused、ignored 專案應安靜略過。
7. **穩定的 MCP 回應**：含 Session 的 finalize／metadata update 必須同時提供文字 content（相容既有 client）與 structuredContent，至少包含 outcome、sessionId、changedFilesCount、verification，讓 Agent 能立即檢查寫入結果。
8. **報表要區分缺漏**：報表與 Session detail 必須分開呈現「changed-files metadata 缺漏」、「verification 尚未回報」與「verification 明確 not_run」，並標示歷史回填與證據來源。

本批已先落地 execution status、changed-file provenance、root-relative normalization、向後相容的 SQLite 欄位 migration，以及 MCP response contract tests；reports export、metadata batch backfill、explicit evidence、explicit knowledge、Knowledge audit history 與 deterministic graph read model 已落地。

## Session metadata contract

每筆 finalized Session 都會回傳 `executionStatus: "completed"`。這只表示既有 planning → execution → verification → closing 流程已完成並呼叫 finalize，不代表一定有 Git commit，也不代表 verification 一定通過。

`changedFiles` 會在通過 project policy 後正規化為 project root 相對路徑、使用 `/` 分隔並去除重複項。絕對路徑若位於 tracked project root 內可以使用；越界或空白路徑會被拒絕。可選的 `changedFilesProvenance` 會保存每個檔案的 `sources`（`agent`、`handoff`、`git`、`worktree`）與參考字串。沒有提供 provenance 時，系統只在這次明確提交的路徑上標記為 `agent`；既有 legacy row 會保留空 provenance，不會假造來源。

`changedFileChanges` 用來保存檔案生命週期，不取代 `changedFiles` 的彙總清單，也不代表 Git commit。格式如下；`renamed` 必須提供 `previousPath`。重新命名會把新舊路徑都納入 `changedFiles`，方便報表與 Graph 追溯。

```json
[
  { "path": "src/new-name.ts", "status": "renamed", "previousPath": "src/old-name.ts" },
  { "path": "src/removed.ts", "status": "deleted" }
]
```

既有 SQLite 在下次啟動時只會補上新欄位並套用安全預設值，不會重寫歷史 summary、events、idempotencyKey 或既有檔案清單；歷史資料的來源補齊要透過後續明確的 backfill 流程。

## 一致性與輸入邊界

REST Server 與 MCP stdio 會共用中央 SQLite。Finalize、Knowledge、Evidence、Report synthesis、Metadata backfill 與 Session summary update 的查重及寫入會在 `BEGIN IMMEDIATE` transaction 內完成；跨程序同時重試時會等待既有寫入，再回傳 `duplicate: true`，不會把 SQLite UNIQUE constraint 例外當成一般 500 錯誤。Metadata backfill 的 schema rebuild migration 也在 transaction 內執行。

既有 SQLite 檔案若仍有歷史 `commit_required` 欄位，Work Intelligence 啟動時會以 idempotent migration 移除；公開 Session contract 與新寫入流程不使用此欄位。Git commit 仍是可選的獨立流程。

Processing 中的 report synthesis 與 metadata backfill 請求超過 30 分鐘會標記為 `failed`，保留原始資料並允許後續 Agent／UI 重新處理。更新 Session metadata、verification 與 summary 時，Session 與 Project timestamp 會一起原子更新。

REST JSON 寫入要求 `Content-Type: application/json`，HTTP body 與 MCP stdio payload 都限制為 1.5 MB；單次 finalize 或 metadata update 的 changed-files、provenance 與 lifecycle change 陣列最多 200 筆。所有即將讀取的既有 source、handoff 或 Git path 都會在 policy gate 後再次解析 real path，避免透過 symlink 逃離 tracked project root；metadata 中的 deleted／尚未建立路徑仍只做 lexical normalization，不會被當成檔案讀取。

Work Intelligence 是一個 Local-first Developer Work Intelligence MVP：Agent 完成既有的 planning → execution → verification → closing handoff 後，呼叫 `work_finalize_session`，系統把可追溯的工作資料保存到中央 SQLite，供 Dashboard、Worklog 與後續 Agent context/search 使用。

它不取代既有 handoff 流程，也不把 finalize 當成 Git commit。一次工作可以沒有 commit，也可以由人工之後再 commit。

## MVP 能力

- Vue 3 + TypeScript + Vite Dashboard
- Node.js + TypeScript REST API
- Node 24 內建 `node:sqlite` SQLite 儲存，避免額外 native binding
- MCP stdio server：`work_finalize_session`、`work_update_session_metadata`、`work_update_session_summary`、`work_attach_evidence`、`work_record_knowledge`、`work_search_knowledge`、`work_update_knowledge`、`work_get_knowledge_history`、`work_get_graph`、`work_preview_metadata_backfill`、`work_list_metadata_backfill_requests`、`work_get_metadata_backfill_context`、`work_cancel_metadata_backfill`、`work_apply_metadata_backfill`、`work_preview_handoff_import`、`work_import_handoffs`、`work_get_context`、`work_search`、`work_get_report`、`work_export_report`、`work_list_report_synthesis_requests`、`work_cancel_report_synthesis`、`work_retry_report_synthesis`、`work_get_report_context`、`work_save_report_summary`
- Reports：日報／週報／月報／季報／年報，包含期間摘要、上一期比較、主要完成事項、Verification、風險／決策、活動趨勢與來源證據；季報／年報以月份聚合趨勢
- 報告匯出：MCP 的 work_export_report 與 REST 的 /api/reports/export，可輸出 Markdown 或 JSON
- Worklog 可依關鍵字、專案與完成日期區間篩選
- Worklog、Knowledge 與報告來源證據支援 10／20／50／100／All；All 仍由 server cap（Session／證據 100、Knowledge 200），回應會以 `pageInfo.truncated` 明確標示並保留分頁導覽
- 歷史 handoff 可先 preview/dry-run，再由使用者明確選取套用；pending、blocked、planning-only 不會自動匯入
- 中央 project registry：不往任何專案 repo 寫設定檔
- Explicit opt-in / default deny：`unregistered`、`tracked`、`paused`、`ignored`
- policy gate 先於 handoff、Git、source 讀取
- raw handoff snapshot、events、changed-files metadata、changed-file lifecycle history、verification metadata
- explicit Knowledge：decision、pattern、gotcha、procedure、skill；可連結來源 Session、tags 與 references
- Knowledge audit history：保存 Knowledge 建立、更新、封存、恢復的不可變前後狀態快照與變更欄位
- deterministic Graph read model：Project、Session、Knowledge、Evidence、Changed File 節點與可追溯關聯
- Knowledge 維護：可編輯內容、標籤、references、類型，並可封存／恢復；封存不刪除資料，只從預設搜尋與 Graph 隱藏
- Graph UI：以關係圖、節點分布與關係類型呈現 tracked-only graph，並可從 Session／Knowledge 節點回到來源
- `idempotencyKey` 保證 finalize retry 不會重複建立 session
- 預留 reports、evidence、knowledge、graph extension interfaces

## 專案結構

```text
apps/
  web/       Vue 3 UI
  server/    REST API + SQLite application host
  mcp/       MCP stdio server
packages/
  core/            domain types + extension interfaces
  schema/          Zod input contracts
  storage/         SQLite schema and work/session service
  project-policy/  explicit opt-in policy gate and safe paths
  shared/          shared constants and helpers
data/              local SQLite database (ignored by Git)
```

## 啟動

需求：Node.js 22.5+（建議 Node 24+，使用內建 `node:sqlite`）與 pnpm。

```powershell
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm dev
```

啟動後：

- Web UI：<http://127.0.0.1:5966>
- REST API：<http://127.0.0.1:3210/api/health>
- SQLite：`data/work-intelligence.sqlite`

`pnpm dev` 會同時啟動 API 與 Vite dev server。也可以分開執行：

```powershell
pnpm start:server
pnpm start:mcp
```

若要指定中央 SQLite 位置：

```powershell
$env:WORK_INTELLIGENCE_DB = "C:\\Users\\you\\AppData\\Local\\WorkIntelligence\\work-intelligence.sqlite"
pnpm start:server
```

REST API 預設只接受沒有 `Origin` 的本機 client，以及 `http://127.0.0.1:5966`／`http://localhost:5966` 的 Web UI 請求；不會對任意網站開放 CORS。若 Web UI 使用其他本機來源，請在 `.env` 設定逗號分隔的 `WORK_INTELLIGENCE_ALLOWED_ORIGINS`，不要設定為 `*`。API 仍固定綁定 `127.0.0.1`，不應直接暴露到區域網路或公網。

## Project Recording Policy

1. 在 UI 的 `Projects / Tracking` 加入 workspace。加入後一定是 `unregistered`。
2. 使用者明確把狀態切成 `tracked`，才授權 Work Intelligence ingest。
3. `paused`、`ignored`、`unregistered` 都會安靜回傳 `outcome: "skipped"`，不讀 handoff、Git、source，也不建立 session/events。
4. `tracked` 專案的 handoff path 會限制在 project root 內；越界 path 不會被讀取。
5. registry 位於中央 SQLite；side project 不會因 MCP 連線而自動被記錄。

任何需要專案檔案的程式路徑都必須先呼叫同一個 `ProjectPolicyGate`。`work_get_context`、project-scoped `work_search`、Knowledge 的讀寫也會先檢查狀態，避免把未授權專案資料交給 Agent。

## MCP tools

### `work_finalize_session`

在既有 closing handoff 完成後呼叫。`idempotencyKey`、`changedFiles`、`verification` 與固定格式的 `workSummary` 必填；Agent 必須先檢查工作樹／diff，沒有檔案變更時才傳 `changedFiles: []`。`verification.status` 必須明確是 `passed`、`failed` 或 `not_run`。`workSummary` 固定包含 `outcomes`（成果）、`scope`（範圍）、`decisions`（決策）、`verification`（驗證）、`nextSteps`（後續）五個陣列，沒有內容時傳空陣列；每個元素是一件已確認的短句，不使用 `##` Markdown 標題。這讓 Worklog、Session Detail 與 Agent context 都能用緊湊且一致的方式呈現。同一個 key 重試會得到原本 session，`duplicate: true`。`commitSha` 是可選 metadata；工作完成不要求 Git commit。

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
    "nextSteps": ["Review the implementation in the next agent session."]
  },
  "handoffPath": ".openspec/handoffs/closing.md",
  "changedFiles": ["packages/project-policy/src/index.ts"],
  "changedFilesProvenance": [
    { "path": "packages/project-policy/src/index.ts", "sources": ["agent", "git"], "references": ["git diff --name-only"] }
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

### `work_get_context`

傳入 `projectRoot` 時只會回傳該 tracked project 的近期 sessions、decisions、`recentKnowledge` 與 `metadataFollowUps`；不傳則回傳所有 tracked projects 的摘要、最近的 explicit Knowledge 與最多 12 筆 metadata 缺口。`metadataFollowUps` 會列出 verification 尚未回報／明確 `not_run`，或 changed-files metadata 缺漏的已完成 Session。Agent 取得 context 後應檢查對應 worktree、diff 或 handoff，再用 metadata tool 回填已確認的內容；系統不會自行猜測檔案變更。

### `work_search`

搜尋已保存的 title、summary、events。結果只來自 tracked projects；project-scoped search 會再次通過 policy gate。

### `work_get_report`

建立可重複驗證的日、週、月、季或年報告。`period` 可用 `day`、`week`、`month`、`quarter`、`year`；`date` 是 UTC 日曆日期，省略時使用 server 當下日期；`projectId` 可選，且指定專案必須是 `tracked`。季報與年報的 `trends` 以月份為單位，其他區間以日期為單位。

```json
{
  "period": "week",
  "date": "2026-09-16",
  "projectId": "optional-project-id"
}
```

回傳會包含：

- `periodSummary`：該期間的 deterministic 摘要
- `range`、`previousRange`：本期與上一期的 UTC 日曆範圍
- `comparison`：Sessions、Events、Changed Files 的 current/previous/delta/direction
- `completedWork`：主要完成事項（可由 Agent/UI 追到原始 Session）
- `totals.verification`（`not_supplied` 代表 Agent 尚未回報，不等同 `not_run`）、`risks`、`decisions`、`trends`
- `evidence`、`sessions`、`sourceSessionIds`：來源證據與完整 provenance

報告只聚合 tracked projects；指定 `unregistered`、`paused`、`ignored` 或不存在的 project 會回傳 `outcome: "skipped"`，不會讀取專案檔案。若 legacy caller 沒有提供 verification 或 changedFiles，finalize 回應會附上 `verificationFollowUp`／`changedFilesFollowUp`，要求 Agent 檢查後用 metadata tool 補回。

### `work_update_session_metadata`

用於既有 Session 的資料回填，不會建立新的 Session，也不會改變 `idempotencyKey`。Agent 應在完成工作後檢查實際 worktree/diff，再傳入確認過的 `changedFiles`；`verification` 可同時補回。沒有檔案變更時必須明確傳 `[]`，不能省略來讓系統猜測。`changedFilesMode` 預設為 `"replace"`；若是同一 Session 的另一個已獨立驗證 stage／commit，使用 `"merge"` 將新路徑與 provenance 與既有資料 union、dedupe。merge 只合併 Agent 明確提供的本次清單，不會讀取 Git 或自動吸收其他工作。

```json
{
  "sessionId": "session-id-from-work_finalize_session",
  "changedFiles": ["src/feature.ts", "README.md"],
  "changedFilesMode": "replace",
  "changedFilesProvenance": [
    { "path": "src/feature.ts", "sources": ["agent", "worktree"], "references": ["git diff --stat"] }
  ],
  "changedFileChanges": [
    { "path": "src/feature.ts", "status": "modified" }
  ],
  "verification": {
    "status": "passed",
    "summary": "Agent confirmed the verification result."
  }
}
```

### `work_update_session_summary`

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

### `work_attach_evidence`

將 Agent 已確認的測試結果、命令輸出、文件或 review 參考掛到既有 Session。這個工具只保存呼叫端提供的 `kind`、`reference` 與可選 `summary`，不會自行讀取或推測參考內容；Session 所屬專案仍必須是 `tracked`。相同 Session、kind 與 reference 重試時會回傳 `duplicate: true`，不會建立重複證據。

```json
{
  "sessionId": "session-id-from-work_finalize_session",
  "kind": "test",
  "reference": "pnpm test --filter storage",
  "summary": "Storage and policy tests passed."
}
```

證據會在 Session Detail 的 `ATTACHED EVIDENCE` 顯示，也會加入報告的來源證據區塊；它不會取代 raw handoff、events 或 verification 原始資料。

### `work_record_knowledge` / `work_search_knowledge`

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

Knowledge 會出現在 Dashboard 的 `Knowledge` 頁面、Session Detail 的 `LINKED KNOWLEDGE`，也會由 `work_get_context` 以 `recentKnowledge` 提供給後續 Agent。這一層只保存 Agent 明確確認的內容，不讓 LLM 取代 policy decision 或原始資料保存。

### `work_update_knowledge`

維護既有的 explicit Knowledge。必須傳入該筆資料所屬 tracked project 的 `projectRoot`；policy gate 會在讀取 Knowledge 前先執行。可以更新 `title`、`body`、`kind`、`tags`、`references` 或 `status`，其中 `status: "archived"` 會將內容從預設 active 搜尋與 Graph 隱藏，`status: "active"` 可以恢復。每次建立、更新、封存或恢復都會保存不可變的前後狀態快照，供 audit history 追溯。這不是刪除操作，也不會讀取 source、handoff 或 Git。

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

UI 的 Knowledge 頁面提供同樣的編輯、封存與恢復操作；預設只顯示 active Knowledge，切換狀態篩選即可查看已封存內容。

### `work_get_knowledge_history`

查詢單筆 Knowledge 的不可變 audit history。必須提供同一個 tracked project 的 `projectRoot` 與 `knowledgeId`；結果會依最新到最舊回傳建立、更新、封存或恢復事件，包含 `before`、`after` 與 `changedFields`。既有 audit 功能加入前建立的 Knowledge 不會被猜測補造歷史，會從下一次變更開始留下快照；unregistered、paused、ignored 專案會安靜回傳 `outcome: "skipped"`。

UI 的 Knowledge 頁面每筆記錄都有「變更紀錄」入口，顯示同一套前後快照。

### `work_get_graph`

以 read-only 方式建立 deterministic graph。節點來自 tracked project 的 Project、finalized Session、explicit Knowledge、attached Evidence 與 changed-file metadata；關聯只包含資料中已存在的 `contains`、`changed_file`、`has_knowledge` 與 `has_evidence`，不會讀取 source／handoff／Git，也不會自行推測相似度或因果關係。可用 `projectRoot`、`projectId` 與 `limit` 限定範圍；未授權專案會安靜略過。

```json
{
  "projectRoot": "C:\\work\\assistant",
  "limit": 50
}
```

回傳包含 `nodes`、`edges`、`sourceProjectIds` 與 `sourceSessionIds`，可供後續視覺化或其他 Agent context 使用；目前不包含自動產生的 LLM graph 摘要。

Graph 也回傳 `totalNodes`、`totalEdges`、`totalNodesByKind` 與 `truncation`。`maxNodes` 預設 180、上限 500；`maxEdges` 預設 360、上限 1,000。這些是 API 載入上限，前端另有畫面預覽配額；當 `nodesTruncated` 或 `edgesTruncated` 為 `true` 時，UI 可以提高載入上限或繼續載入，不會把完整資料誤當成已全部渲染。

### 報告提煉：使用者只需要自然語言

Reports 頁面上的「請 Agent 提煉」只會在中央 SQLite 建立一筆 pending request，不會由 WorkLog 反向啟動或綁定 Codex、Claude。使用者接著在目前的 Agent 對話輸入：

```text
請處理我剛在 Work Intelligence 建立的報告提煉請求。
```

Agent 會自行完成以下 implementation detail，使用者不需要知道工具名稱、requestId、JSON 或呼叫順序：

1. 找到最新的 pending report synthesis request。
2. 取得該期間與專案範圍的 deterministic report context。
3. 依 `report-synthesis-v2` contract 產生可掃讀、以結果為中心的繁體中文報告。
4. 將摘要、Agent／model／prompt metadata 與每個結論的 `sourceSessionIds` 回寫。

摘要至少要包含：

- 期間、專案範圍與一句話結論
- 工作主題／工作流與主要完成成果
- Verification：`passed`、`failed`、`not_run`、`not_supplied` 必須分開
- 與上一期的差異、風險／需要協助、技術決策與原因
- 具體下一步，以及每個主要結論可追溯的來源 Session

Agent 不得把「有 changed files」當成 Git commit，也不得從不足的 context 推測；沒有證據時要明確寫 `資料不足`。這種結構符合工作週報常見的結果、阻礙／需要協助、下一期重點、決策與風險分段設計，可參考 [Atlassian Weekly Status Report](https://www.atlassian.com/software/confluence/templates/end-of-week-status-report) 與 [Atlassian Project Status Report Guide](https://www.atlassian.com/agile/project-management/status-report)。

若早上已完成一次提煉、下午又有新 Session，直接在 Reports 頁按「重新提煉本報告」即可建立新 request。上一版摘要會保留到新的 Agent 摘要完成，再由新版本取代；每次回寫都保留歷史版本，pending request 沒有 Agent 處理時也不會遺失。

如果 Agent 在取得 Context 後中斷，WorkLog 不會讓舊 Agent 在稍後覆蓋新結果。processing 請求超過 30 分鐘會自動標記為可重試；Reports 頁會顯示失敗原因與「重試這次提煉」，重試會建立新的 pending attempt 並保留舊請求歷史。MCP Agent 遇到逾時或中斷的 request 時，也應先使用 `work_retry_report_synthesis`，再取得新的 report context。尚未逾時的 processing request 不允許平行重試，以避免重複產生報告。

如果使用者不想繼續目前的 pending／processing 提煉，Reports 頁可以「取消這次提煉」，也可以由 Agent 在自然語言請求中自行取消；取消只停止該次 Agent attempt，既有 deterministic report、摘要與歷史版本都保留。取消後的 context／save 操作會被拒絕，重新提煉會建立新的 request。歷史摘要清單只允許移除非目前版本，避免刪掉當前可讀報告。

### `work_preview_handoff_import` / `work_import_handoffs`

歷史 handoff 匯入採兩階段流程。預設掃描 tracked project root 下的 `.openspec/handoffs`（含子目錄）Markdown 文件；也可以傳入 `handoffDirectory`、`excludePaths` 與 `maxFiles`。preview 是唯讀 dry-run，會列出每個來源檔案的標題、日期、Verification、changed files 數量、是否可匯入與排除原因。

只有明確找到 `complete`、`accepted`、`resolved`、`done` 或 `implemented` 等完成狀態的 handoff 會標成 `eligible`。`blocked`、`pending`、`planning-only`、缺少明確完成狀態、無法讀取的文件都會保留在 preview，但不會被自動建立 Session。找不到 handoff 目錄時會回傳空 preview，不會掃描 project root 以外的 parent workspace。

確認 preview 後，將選取的 `sourcePaths` 傳給 `work_import_handoffs`。套用會保存 raw handoff snapshot、解析到的日期／Verification／changed files，並使用穩定 idempotency key；同一個來源檔案重試只會回傳 `already_imported`，不會建立重複 Session。Importer 不會執行測試或 Git commit；沒有在 handoff 中找到 changed files 時，Session 仍可匯入，但會保留 metadata 缺漏訊號供 Agent 後續用 `work_update_session_metadata` 補回。

REST 對應端點是 `GET /api/imports/handoffs/preview` 與 `POST /api/imports/handoffs`。Projects / Tracking 頁面上的「預覽 handoff」按鈕會使用同一套 preview → 勾選 → 套用流程。

## 註冊到 Codex 與 Claude

這個 MCP 是本機 stdio server。`http://127.0.0.1:5966` 是 Dashboard，不是 MCP endpoint；Codex 與 Claude 會各自啟動 `pnpm.cmd`，並共用同一個中央 SQLite。

### 共用準備

在註冊 MCP 前，先安裝依賴並建立 MCP 的 production build：

以下範例的 `C:\path\to\WorkLog.Ai` 請替換成實際專案目錄。

```powershell
cd C:\path\to\WorkLog.Ai
pnpm install
pnpm build
```

建議所有 client 都明確指定同一個 database path：

```text
C:\path\to\WorkLog.Ai\data\work-intelligence.sqlite
```

### Codex CLI

使用 `codex mcp add` 註冊本機 stdio server：

```powershell
codex mcp add work-intelligence --env "WORK_INTELLIGENCE_DB=C:\path\to\WorkLog.Ai\data\work-intelligence.sqlite" -- pnpm.cmd --dir "C:\path\to\WorkLog.Ai" start:mcp
```

確認設定：

```powershell
codex mcp list
codex mcp get work-intelligence
```

如果已經存在同名設定，可以先移除再重新加入：

```powershell
codex mcp remove work-intelligence
```

### Claude Code

使用 `user` scope，讓 Claude Code 在不同 workspace 都能使用這個工具：

```powershell
claude mcp add --scope user --transport stdio work-intelligence --env "WORK_INTELLIGENCE_DB=C:\path\to\WorkLog.Ai\data\work-intelligence.sqlite" -- pnpm.cmd --dir "C:\path\to\WorkLog.Ai" start:mcp
```

確認設定與連線狀態：

```powershell
claude mcp list
claude mcp get work-intelligence
```

進入 Claude Code 後，也可以輸入 `/mcp` 查看 server 和 tools。若同名設定已存在：

```powershell
claude mcp remove work-intelligence
```

Claude Code 的 `--` 後方是實際啟動 MCP server 的 command；`--scope user` 會將設定套用到使用者層級。詳見 [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp)。

### Claude Desktop

如果使用的是 Claude Desktop GUI，將以下內容合併到 Windows 設定檔：

```text
%APPDATA%\Claude\claude_desktop_config.json
```

```json
{
  "mcpServers": {
    "work-intelligence": {
      "command": "pnpm.cmd",
      "args": [
        "--dir",
        "C:\\path\\to\\WorkLog.Ai",
        "start:mcp"
      ],
      "env": {
        "WORK_INTELLIGENCE_DB": "C:\\path\\to\\WorkLog.Ai\\data\\work-intelligence.sqlite"
      }
    }
  }
}
```

如果檔案原本已有其他 `mcpServers`，只加入 `work-intelligence`，不要整份覆蓋。儲存後重新啟動 Claude Desktop，再從聊天框的 `+` → `Connectors` 確認 tools。Claude Desktop 的 local MCP 與 Claude.ai/Cowork 的 remote connector 是不同機制；目前這個 MVP 適用於 Claude Desktop 與 Claude Code，不能直接從 Claude.ai 使用本機 stdio server。詳見 [Claude Desktop local MCP guide](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop) 與 [Claude custom connector notes](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)。

### 第一次使用

先啟動 Dashboard 與 REST API：

```powershell
cd C:\path\to\WorkLog.Ai
pnpm dev
```

開啟 <http://127.0.0.1:5966>，進入 `Projects / Tracking`：

1. 加入要記錄的 workspace。
2. 將該專案狀態切換成 `記錄中`。
3. 在 Codex 或 Claude Code 中測試 `work_get_context`。
4. Agent 完成既有 planning → execution → verification → closing 後，呼叫 `work_finalize_session`。

可以用以下提示測試：

```text
請使用 work_get_context，projectRoot 為
C:\path\to\WorkLog.Ai
```

完成工作時：

```text
完成這次工作後，請呼叫 work_finalize_session。
projectRoot 為 C:\path\to\WorkLog.Ai，
請提供唯一的 idempotencyKey、title、summary、workSummary（成果／範圍／決策／驗證／後續五個陣列）、changedFiles 與 verification。
```

如果專案還是 `unregistered`、`paused` 或 `ignored`，MCP 會回傳 `outcome: "skipped"`，不會讀取或保存 handoff、Git、source 資料；這是 default-deny 的預期行為。

## REST API

| Method | Route | 用途 |
| --- | --- | --- |
| GET | `/api/health` | API/SQLite health |
| GET | `/api/dashboard` | Dashboard counters + recent sessions |
| GET/POST | `/api/projects` | 列出/加入 registry project |
| PATCH | `/api/projects/:id` | 更新名稱或 tracking status |
| GET | `/api/sessions` | Worklog session list；可用 `q`、`projectId`、`from`、`to`（日期格式 `YYYY-MM-DD`）篩選 |
| GET | `/api/sessions/:id` | Session detail、events、raw handoff |
| PATCH | `/api/sessions/:id/metadata` | Agent 回填 changed files、verification、Git metadata |
| PATCH | `/api/sessions/:id/summary` | 以 replace／append 更新既有 finalized Session 主摘要 |
| POST | `/api/sessions/:id/evidence` | 保存 Agent 提供的 evidence reference |
| GET | `/api/knowledge` | 搜尋 tracked projects 的 explicit Knowledge |
| POST | `/api/knowledge` | 保存 Agent 明確提交的 Knowledge |
| PATCH | `/api/knowledge/:id` | 在 project policy 通過後更新或封存 Knowledge |
| GET | `/api/knowledge/:id/history?projectRoot=...` | 讀取 Knowledge audit history；先通過 project policy |
| GET | `/api/graph` | 讀取 tracked-only deterministic work graph |
| GET | `/api/context` | Agent context query |
| GET | `/api/search?q=...` | Work history search |
| GET | `/api/backfill/metadata/preview?projectRoot=...` | 唯讀掃描 metadata 缺口 |
| GET/POST | `/api/backfill/metadata-requests` | 建立或查詢 Agent metadata 回補請求 |
| GET | `/api/backfill/metadata-requests/:id/context` | 取得受控 metadata 回補 context |
| POST | `/api/backfill/metadata-requests/:id/cancel` | 取消 pending／processing metadata 回補請求 |
| POST | `/api/backfill/metadata` | Agent 回寫已確認的 Session metadata |
| GET | `/api/reports?period=week&date=YYYY-MM-DD` | 日/週/月/季/年工作報告，可加 `projectId` |
| GET/POST | `/api/reports/synthesis-requests` | 建立或查詢 Agent 報告提煉請求 |
| POST | `/api/reports/synthesis-requests/:id/cancel` | 取消 pending／processing 報告提煉請求 |
| POST | `/api/reports/synthesis-requests/:id/retry` | 將失敗／逾時的提煉請求建立為新的 pending attempt |
| GET | `/api/reports/synthesis-requests/:id/context` | 取得受控、可追溯的提煉 Context |
| GET | `/api/reports/summaries` | 查詢目前或歷史 Agent 報告摘要 |
| POST | `/api/reports/summaries` | Agent 回寫摘要與來源 Session |
| DELETE | `/api/reports/summaries/:id` | 移除非目前使用中的歷史報告版本 |
| POST | `/api/work/finalize` | REST 形式的 finalize |

### Metadata backfill

當既有 Session 顯示 Verification 待回報、明確 not_run，或沒有 changed-files metadata 時，可以先預覽缺口，再由 Agent 提供已確認的資料批次回填。

- MCP：先呼叫 work_preview_metadata_backfill；可選 projectRoot 與 limit。
- Projects / Tracking 頁按下「掃描 metadata 缺口」後，若找到缺口，WorkLog 會在中央 SQLite 建立一筆 pending metadata backfill request；不會猜測，也不會直接修改 Session。
- UI 會顯示 Agent 狀態與「複製 Agent 指令」；使用者只需要在目前的 Codex 或 Claude 對話輸入：`請處理我剛在 Work Intelligence 掃描出的 metadata 缺口。`
- MCP Agent 會自動找最新的 pending／processing request，取得 bounded context，依 project policy 檢查對應 tracked project 的 handoff、worktree 或 diff，再呼叫 work_apply_metadata_backfill。使用者不需要提供 requestId、JSON 或工具順序。
- MCP：Agent 檢查對應的 handoff、worktree 或 diff 後，呼叫 work_apply_metadata_backfill，updates 內只放明確確認的 sessionId 與 metadata；帶入 requestId 時，所有缺口完成後 request 才會標為 completed，部分回補則保留為 processing 並回傳 remainingItems。
- REST：GET /api/backfill/metadata/preview?projectRoot=tracked-project-root
- REST：POST /api/backfill/metadata-requests 建立待 Agent 處理請求；GET /api/backfill/metadata-requests 查詢狀態；GET /api/backfill/metadata-requests/:id/context 取得受控 context。
- REST：POST /api/backfill/metadata，body 為 { updates: [...] }。
- UI：Projects / Tracking 的「需要 Agent 回補的 Session」可以掃描並查看缺口、建立 pending request、複製自然語言指令，再開啟來源 Session；UI 不會替 Agent 猜測或自動寫回。
- 預覽不會讀取或猜測檔案變更；回填逐筆檢查 project policy，不建立新 Session，也不改變原本的 idempotencyKey、summary 或 events。
- 同一批次重複 sessionId 會回報 failure；paused、ignored、unregistered 專案會安靜 skipped。
- 以 `projectId` 建立或查詢 project-scoped 回補時，policy skip 回應會保留 `projectId`；unknown id 也不會被錯誤放進 `projectRoot` 欄位。

### 報告匯出

報告頁可以下載目前選定範圍的 Markdown 或 JSON。匯出內容與報告頁使用同一份 deterministic report data，不會重新推測或修改任何 Session。

- REST：GET /api/reports/export?period=week&date=YYYY-MM-DD&format=markdown
- REST：GET /api/reports/export?period=month&format=json&projectId=tracked-project-id
- MCP：呼叫 work_export_report，format 可填 markdown 或 json
- markdown 會包含期間摘要、上一期比較、主要完成事項、Verification、風險、決策、趨勢、專案分布與來源證據。
- json 會保留完整的 WorkReport 結構，適合後續自動化或外部保存。
- 專案範圍仍遵守 tracked-only policy；unregistered、paused、ignored 會安靜回傳 skipped。

## 測試與驗證

```powershell
pnpm test       # source-only unit/integration tests across policy, schema, storage, server and MCP
pnpm test:coverage # schema/storage coverage with enforced minimum thresholds
pnpm typecheck  # packages + Vue template + E2E test/config types
pnpm build      # all packages + server/mcp + Vite production bundle
pnpm test:e2e   # isolated Playwright browser regression suite
```

`pnpm test:coverage` 使用 V8：schema 的 statements／branches／functions／lines 門檻為 90%，storage handoff parser 的門檻為 85%／70%／90%／85%；coverage 輸出只寫入被 `.gitignore` 排除的 `coverage/` 目錄。

`pnpm test:e2e` 會先建置 production packages，再以獨立的暫存 SQLite、API `3211` 與 Web `5967` 啟動測試服務，不會讀寫目前使用中的 `data/work-intelligence.sqlite` 或 `5966` 開發畫面。測試涵蓋報告提煉收合、Worklog／Knowledge 每頁筆數、Graph 篩選與節點詳情，以及 390px 寬度的 Session 詳情彈窗。

測試涵蓋：

- unknown/unregistered、paused、ignored 不會建立 session
- tracked 才能讀 source 與 handoff snapshot
- raw handoff、events、changed files、verification 會保存；缺少結構化欄位時會要求 Agent follow-up
- 同一 `idempotencyKey` finalize 不重複寫入
- 兩個 SQLite store connection 同時使用相同 finalize key 仍只保存一筆 Session
- metadata backfill processing timeout recovery、Session metadata／verification transaction 與 MCP payload boundary
- schema 的 changed-files／metadata backfill 陣列上限
- REST 不接受非 JSON Content-Type，malformed JSON 會回傳安全的 4xx 錯誤
- tracked-only context/search 行為
- tracked-only day/week/month/quarter/year 完整報告、上一期比較、趨勢、風險與 source evidence provenance
- changed-file lifecycle history 的新增／修改／刪除／重新命名、路徑正規化、merge dedupe 與 metadata follow-up
- Markdown／JSON 報告匯出與 paused/unregistered project skip
- metadata backfill preview、明確批次更新、duplicate sessionId protection 與 policy skip
- tracked session evidence 的保存、去重、Session Detail／報告呈現與 policy skip
- explicit Knowledge 的 Session provenance、idempotent record、搜尋、context／Session Detail／UI 呈現與 policy skip
- Knowledge update、封存／恢復、預設 active 搜尋與 policy skip
- Knowledge audit history 的 immutable before／after snapshots、changed fields、REST／MCP／UI 與 policy skip
- metadata backfill 的明確 replace／merge 模式、多 stage 路徑 union、provenance dedupe 與 legacy provenance 保留
- tracked-only deterministic graph 的節點／邊、Knowledge／Evidence／changed-file 關聯與 project policy skip
- Graph UI 的 scope filter、節點類型切換、畫面預覽量、資料載入上限、節點／關係統計、可讀預覽與 Session／Knowledge source navigation
- Agent report synthesis request 的建立、bounded context、sourceSessionIds 驗證、摘要回寫、重試 idempotency 與歷史版本保留
- Agent report synthesis request 的逾時回收、舊 Agent 寫入隔離、失敗請求 retry 與 UI 恢復流程
- Reports 的 Evidence 類型／關鍵字篩選只更新證據區塊，不重新渲染整份報告；原始工作紀錄與來源證據提供 10／20／50／100／All 的局部分頁控制
- project root 之外的 source path 會被拒絕

## 後續擴充邊界

`packages/core/src/modules.ts` 已提供 reports、evidence、knowledge、graph 的接口；目前已落地 reports、evidence、explicit knowledge（含維護、封存與 audit history）、deterministic graph read model、Graph 節點詳細面板、metadata backfill 的明確 replace／merge contract，以及 deleted／renamed path history。Graph 目前刻意維持 read-only，不做未確認的語意推論；原始 session/event/handoff snapshot、明確附加的 evidence 與 Agent 明確提交的 Knowledge 仍是可信來源，不讓 LLM 取代原始資料保存與 policy decision。後續可再加入受控的 report／knowledge automation。
