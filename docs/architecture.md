# 架構、資料契約與設計原則

Work Intelligence 的資料模型、Session metadata 契約、一致性保證、Project Recording Policy 與設計驗收基準。欄位格式與報告粒度的正式定義見 [Work record and report format v1](work-record-and-report-format.md)。

> 回到 [README](../README.md)

## 功能範圍

- Vue 3 + TypeScript + Vite Dashboard
- Node.js + TypeScript REST API
- Node 24 內建 `node:sqlite` SQLite 儲存，避免額外 native binding
- MCP stdio server：31 個工具與 2 個 prompts（`finalize-work`、`synthesize-report`），涵蓋專案記錄狀態、Session 保存／查詢／修正、Evidence、Knowledge、Graph、報告與 AI 報告整理、metadata 回補與 handoff 匯入；完整清單與 annotations 見 [mcp-tools.md](mcp-tools.md)
- Reports：日報／週報／月報／季報／年報（日曆日期依 server 所在系統時區，回應附 `timezone`），包含期間摘要、上一期比較、主要完成事項、Verification、風險／決策、活動趨勢與來源證據；季報／年報以月份聚合趨勢
- 報告匯出：MCP 的 work_export_report 與 REST 的 /api/reports/export，可輸出 Markdown 或 JSON
- 工作圖譜提供 tracked project 篩選、節點類型／預覽量／資料載入上限控制、節點詳細資料，以及依 viewport 渲染的 SVG virtualization
- 工作歷程可依關鍵字、專案與完成日期區間（系統時區）篩選；Session 面板可就地編輯主摘要與五段 workSummary
- 工作歷程、Knowledge 與報告來源證據支援 10／20／50／100／All；All 仍由 server cap（Session／證據 100、Knowledge 200），回應會以 `pageInfo.truncated` 明確標示並保留分頁導覽，前端清單則以 `VirtualList` 限制 DOM 渲染量
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

## 設計原則與驗收基準

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

新的 schema 變更改用版本化 migration（`packages/storage/src/schema-migrations.ts`）：套用過的版本記在 `schema_migrations`，每個 migration 只在啟動時的 transaction 內執行一次。目前的 migration 1 建立檢索索引（`search_chunks`、FTS5 `search_fts`、`search_paths`、`search_dirty` 與標記用 trigger），並把既有 Session／Knowledge 全部標記為待索引。檢索邏輯在 `search-repository.ts`，tokenizer 與路徑正規化在 `search-text.ts`，詳見 [MCP tools 的 `work_recall`](mcp-tools.md#work_recall)。

既有 SQLite 檔案若仍有歷史 `commit_required` 欄位，Work Intelligence 啟動時會以 idempotent migration 移除；公開 Session contract 與新寫入流程不使用此欄位。Git commit 仍是可選的獨立流程。

Processing 中的 report synthesis 與 metadata backfill 請求超過 30 分鐘會標記為 `failed`，保留原始資料並允許後續 Agent／UI 重新處理。更新 Session metadata、verification 與 summary 時，Session 與 Project timestamp 會一起原子更新。

REST API 只接受 loopback `Host`（`127.0.0.1`、`localhost`、`[::1]`，以及 `WORK_INTELLIGENCE_ALLOWED_ORIGINS` 內的主機），其他一律回 421，避免 DNS rebinding 的網頁在同源情況下讀取資料；帶 `Origin` 的請求還必須在 origin 白名單內。

日期邊界：timestamp 一律以 UTC ISO 保存；報告區間、趨勢分桶與 `from`／`to` 篩選把日曆日期換算成 server 所在系統時區的當地午夜，所以凌晨完成的工作會算在使用者看到的那一天。Session 列表與 Knowledge 搜尋的關鍵字中，`%`、`_`、`\` 照字面比對。

主摘要、五段 workSummary 與 verification 可以由 Agent（MCP）或 Web UI（Session 面板「編輯 Session」）就地更新，都會留下 audit row（verification 的前後值與來源記在 `session_verification_updates`）；Session 與 Evidence 可作廢／還原（`void_audit`）；changed files、events 與 evidence 內容在 UI 維持唯讀。

REST JSON 寫入要求 `Content-Type: application/json`，HTTP body 與 MCP stdio payload 都限制為 1.5 MB；單次 finalize 或 metadata update 的 changed-files、provenance 與 lifecycle change 陣列最多 200 筆。所有即將讀取的既有 source、handoff 或 Git path 都會在 policy gate 後再次解析 real path，避免透過 symlink 逃離 tracked project root；metadata 中的 deleted／尚未建立路徑仍只做 lexical normalization，不會被當成檔案讀取。

## Project Recording Policy

1. 在 UI 的「專案」頁按「加入專案」。加入後一定是 `unregistered`。
2. 使用者明確把狀態切成 `tracked`，才授權 Work Intelligence ingest。
3. `paused`、`ignored`、`unregistered` 都會安靜回傳 `outcome: "skipped"`，不讀 handoff、Git、source，也不建立 session/events。
4. `tracked` 專案的 handoff path 會限制在 project root 內；越界 path 不會被讀取。同步 storage 流程使用既有 `createProjectPathResolver`；非同步檔案流程可使用 `createAsyncProjectPathResolver` 的保序批次 API，所有結果仍採相同 lexical／realpath boundary。
5. registry 位於中央 SQLite；side project 不會因 MCP 連線而自動被記錄。
6. Agent 可以用 `work_get_project_status` 唯讀查詢記錄狀態，但沒有任何 MCP 工具能變更它；切換為 `tracked` 只能由使用者在 Web UI 確認。

任何需要專案檔案的程式路徑都必須先呼叫同一個 `ProjectPolicyGate`。`work_get_context`、project-scoped `work_recall`／`work_search`、Knowledge 的讀寫也會先檢查狀態，避免把未授權專案資料交給 Agent。

## 後續擴充邊界

`packages/core/src/index.ts` 提供 reports、evidence、knowledge、graph 的公開型別與契約；目前已落地 reports、evidence、explicit knowledge（含維護、封存與 audit history）、deterministic graph read model、Graph 節點詳細面板、metadata backfill 的明確 replace／merge contract，以及 deleted／renamed path history。Graph 目前刻意維持 read-only，不做未確認的語意推論；原始 session/event/handoff snapshot、明確附加的 evidence 與 Agent 明確提交的 Knowledge 仍是可信來源，不讓 LLM 取代原始資料保存與 policy decision。後續可再加入受控的 report／knowledge automation。
