# REST API

API 預設綁定 `127.0.0.1:3210`，只給本機 Web UI 與本機 client 使用。正式模式用同一個 port 提供 `apps/web/dist` 與 API；同源請求（帶或不帶 `Origin`）都由 `Host` loopback 檢查保護，不需要 CORS。`Host` 必須是 loopback（或 `WORK_INTELLIGENCE_ALLOWED_ORIGINS` 內的主機），否則回 421；不同源且未列入白名單的 `Origin` 回 403。所有寫入要求 `Content-Type: application/json`，並先通過 project policy。

正式模式的 Web 靜態檔使用 SPA fallback；`index.html` 不快取，Vite 雜湊 assets 可長期快取。CSP 禁止 inline／eval script，限定外部資源為同源（Vue 動態版面需要的 style attribute 另行允許）；另設 `X-Content-Type-Options`、`Referrer-Policy` 與禁止 frame 嵌入的標頭。靜態請求會拒絕 dot-segment、編碼後 traversal 與解析到 Web 根目錄之外的 symlink。

日期參數（`from`、`to`、`date`）是 server 所在系統時區的日曆日期；報告回應的 `timezone` 會標出使用的 IANA 時區。

本文提到的 `work_*` MCP 名稱是 operation id；目前 MCP `tools/list` 公告四個 dispatcher，呼叫時要依 [MCP 工具參考](mcp-tools.md) 將 operation 與輸入包進 dispatcher envelope。

## 收尾與未結項

`POST /api/work/finalize` 與 MCP finalize 共用驗證：`resolvedOutstandingItemIds` 只接受本次已確認完成的同專案 pending 項目；`supersededOutstandingItemIds` 只用於本次非空 `workSummary.nextSteps` 明確取代的舊項目。每個陣列最多 200 個非空 id。狀態、逐筆 actor Session 稽核及 Session 在同一交易寫入；衝突、無效、已處理、作廢或跨專案 id 維持原狀並回傳警告。結果含兩種實際變更 id 與最多五筆 `relatedOutstandingItems` 提示（total／omitted、文字最多 400 字、來源標題 160 字）；提示排除本次新項目，排名不能作為完成證據。完整規則見 [MCP 收尾說明](mcp-tools.md#work_finalize_session)。

## 錯誤回應與代碼

由 API 錯誤處理器回覆的錯誤會保留既有 `error` 文字，並新增機器可讀的 `code`；驗證細節有提供時會附在 `details`：

```json
{ "error": "Invalid JSON request body.", "code": "invalid_input" }
```

| HTTP 狀態 | `code` | 說明 |
| --- | --- | --- |
| 400 | `invalid_input` | JSON、查詢參數或輸入資料驗證失敗。 |
| 403 | `origin_not_allowed` | 請求來源不在允許清單。 |
| 404 | `not_found` | 找不到 API 路由或一般資源。 |
| 409 | `conflict` | 一般資源狀態衝突。 |
| 413 | `payload_too_large` | 請求或匯出資料超過大小上限。 |
| 415 | `unsupported_media_type` | 寫入請求未使用 JSON 格式。 |
| 421 | `host_not_allowed` | `Host` 不在允許清單。 |
| 503 | `service_unavailable` | 服務暫時無法完成請求。 |
| 500 | `internal_error` | 未分類的伺服器錯誤；回應不會暴露內部錯誤內容。 |

以下端點使用較具體的代碼；其他欄位與狀態碼維持各端點原有定義：

| `code` | HTTP 狀態 | 說明 |
| --- | --- | --- |
| `database_busy` | 503 | SQLite 回報 `SQLITE_BUSY` 或 `SQLITE_LOCKED`；使用安全的資料庫忙碌訊息。 |
| `backup_unavailable` | 409 | 備份功能或備份檔案目前不可用。備份清單／建立回應仍保留 `outcome` 與 `reason`，並附加 `code` 和相容用的 `error` 欄位。 |
| `project_not_found` | 404 | 專案資料轉移操作找不到指定專案。 |
| `invalid_bundle` | 400 | 可攜式匯入檔與所選匯入範圍不相符或無效。 |
| `unsupported_schema` | 400 | 可攜式匯入檔的 schema 版本不受支援。 |
| `invalid_project_deletion_confirmation` | 400 | 專案刪除確認內容未通過驗證。 |
| `PROJECT_NOT_FOUND` | 404 | 專案刪除操作找不到專案。 |
| `PROJECT_NAME_MISMATCH` | 409 | 專案刪除確認名稱不相符。 |
| `PROJECT_BACKUP_FAILED` | 503 | 專案刪除前無法建立必要備份。 |
| `PROJECT_DELETE_FAILED` | 500 | 專案刪除交易失敗，既有備份仍保留。 |
| `SESSION_NOT_FOUND` | 404 | Session 永久刪除找不到該 Session。 |
| `SESSION_NOT_VOIDED` | 409 | 只有已作廢的 Session 可以永久刪除。 |
| `SESSION_CITED_BY_PENDING_CLEANUP` | 409 | 有待審核的未結項清理建議引用這個 Session 作為證據；先接受或拒絕該建議。 |
| `SESSION_BACKUP_FAILED` | 503 | Session 刪除前無法建立必要備份。 |
| `SESSION_DELETE_FAILED` | 500 | Session 刪除交易失敗，既有備份仍保留。 |

Web `ApiClient` 會把 HTTP 代碼與狀態放在 `ApiError` 上，並依 `code` 顯示目前介面語言（繁體中文或 English）的訊息；`network_error` 與 `malformed_response` 是 client 本地代碼，不會由 REST API 回傳。

> 回到 [README](../README.zh-TW.md)（[English](../README.md)）

| Method   | Route                                            | 用途                                                                                   |
| -------- | ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| GET      | `/api/health`                                    | API/SQLite health                                                                      |
| GET      | `/api/system/status`                             | 唯讀系統摘要：資料庫與備份資訊、SSE 連線數、Codex／Claude Code Agent 註冊及 skill／hook 狀態 |
| GET      | `/api/attention`                                 | 聚合既有提醒，回傳各類完整／部分／失敗覆蓋範圍及原領域入口（詳見下節）                 |
| GET      | `/api/dashboard`                                 | Dashboard counters + recent sessions（只計算 tracked 專案）                            |
| GET/POST | `/api/projects`                                  | 列出/加入 registry project                                                             |
| PATCH    | `/api/projects/:id`                              | 更新名稱、tracking status 或 `repositoryUrl`（只接受不含帳號／token 的 https 網址；`null` 或空字串移除） |
| DELETE   | `/api/projects/:id`                              | 先備份，再永久刪除專案與相關 WorkLog 資料；需傳入專案名稱確認                           |
| GET      | `/api/project-deletion-audits`                   | 列出不含內容的刪除時間、專案 id 與各類刪除筆數                                          |
| POST     | `/api/system/pick-folder`                        | 在本機叫出作業系統的選擇資料夾視窗，回傳選到的路徑（body `{}`）                        |
| GET/POST | `/api/backups`                                   | 列出資料庫備份／立即建立備份（POST body `{}`）                                         |
| POST     | `/api/export`                                    | body `{}` 匯出整份 SQLite 快照；指定 `scope` 時匯出可攜式 JSON（見下方）                 |
| POST     | `/api/import/preview`                            | 驗證可攜式 JSON 並預覽新增、略過、衝突與路徑轉換，不寫入資料                           |
| POST     | `/api/import`                                     | 將可攜式 JSON 的非衝突資料合併寫入目前資料庫                                           |
| GET      | `/api/sessions`                                  | Worklog session list（只含 tracked 專案）；可用 `q`、`projectId`、`from`／`to`（YYYY-MM-DD）篩選（系統時區、含頭尾），`voided=include`／`only` 顯示已作廢的 Session；`agent` 以完全相符篩選寫入該 Session 的 Agent 用戶端（例如 `claude-code`） |
| GET      | `/api/sessions/agents`                           | 回傳 `{ agents: string[] }`：tracked 專案未作廢 Session 中出現過的 Agent 用戶端（去重、排序），供 Web 篩選選單使用 |
| GET      | `/api/agent-reads`                               | 被動稽核：Agent 經 MCP 讀取時回傳過哪些紀錄（只含 tracked 專案與無專案的讀取），新到舊分頁；可用 `projectId`、`agent`、`page`、`pageSize`（1–100）。每筆含 `at`、`tool`、`agentClient`、`projectId`／`projectName`、`returnedCount`、`sessionIds`、`knowledgeIds`（只有 id，每種最多 50 個，超出以 `omitted*Count` 表示）。保留 30 天且最多 5,000 筆 |
| GET      | `/api/sessions/:id/agent-reads`                  | `{ total, items: [{ at, tool, agentClient? }] }`：這個 Session 被 Agent 讀取回傳過的次數與最近 20 筆 |
| GET      | `/api/knowledge/:id/agent-reads`                 | 同上，對象為 Knowledge |
| GET      | `/api/sessions/:id`                              | Session detail、events、raw handoff                                                    |
| PATCH    | `/api/sessions/:id/metadata`                     | Agent 回填 changed files、verification、Git metadata                                   |
| DELETE   | `/api/sessions/:id`                              | 永久刪除**已作廢**的 Session（body `{ "confirm": true }`）：先寫入獨立保留 5 份的 `pre-session-delete-` 備份，再在單一交易刪除它的事件、Evidence、圖表、修改紀錄、關聯與未結項；Knowledge 保留但不再指向它，只留不含內容的刪除紀錄。MCP 沒有對應工具 |
| PATCH    | `/api/sessions/:id/title`                        | 修正 Session 標題（`title`，1–300 字）；原標題記成一筆 `note` 事件，已作廢的 Session 回傳 `skipped` |
| PATCH    | `/api/sessions/:id/summary`                      | 以 replace／append 更新既有 finalized Session 主摘要（Agent 與 Session 面板「編輯 Session」共用） |
| PATCH    | `/api/sessions/:id/work-summary`                 | 以 replace／patch 更新既有 finalized Session 五段 workSummary（Session 面板只 patch 有改的段落） |
| POST     | `/api/sessions/:id/evidence`                     | 保存 Agent 提供的 evidence reference                                                   |
| PATCH    | `/api/sessions/:id/verification`                 | 修正 verification（`status`：passed／failed／in_progress／not_run，選填 `summary`），每次變更寫入修改紀錄 |
| POST     | `/api/sessions/:id/links`                        | 建立或更新 Session 關聯（`relatedSessionId`、`relation`：continues／related）            |
| DELETE   | `/api/sessions/:id/links/:relatedId`             | 移除兩筆 Session 之間的關聯                                                           |
| PATCH    | `/api/sessions/:id/void`                         | 作廢（`voided: true` 與必填 `reason`）或還原（`voided: false`）Session，保留作廢紀錄 |
| PATCH    | `/api/evidence/:id/void`                         | 標示 Evidence 為錯誤或還原，保留作廢紀錄                                              |
| GET      | `/api/knowledge/candidates`                      | 待審核（`status=proposed`，預設）或已處理的 Knowledge 候選與未完成的整理請求；可用 `projectRoot` 篩選 |
| POST     | `/api/knowledge/candidate-requests`              | 建立（或回傳既有的）Knowledge 候選整理請求（`projectRoot`），由 Agent 處理                |
| POST     | `/api/knowledge/candidates/:id/decision`         | 接受（`decision: "accept"`，可帶 `edits`）或拒絕候選；接受時才寫成 Knowledge             |
| GET      | `/api/knowledge`                                 | 搜尋 tracked projects 的 explicit Knowledge                                            |
| POST     | `/api/knowledge`                                 | 保存 Agent 明確提交的 Knowledge                                                        |
| PATCH    | `/api/knowledge/:id`                             | 在 project policy 通過後更新或封存 Knowledge                                           |
| GET      | `/api/knowledge/:id/history?projectRoot=...`     | 讀取 Knowledge audit history；先通過 project policy                                    |
| GET      | `/api/knowledge-pages`                           | 列出 tracked projects 的常駐知識頁（狀態、版本、新 Session 數與引用來源核對提示）；可用 `projectRoot` 篩選 |
| POST     | `/api/knowledge-pages/update-requests`           | 要求 Agent 更新知識頁（`projectRoot`、`slug`；自訂頁另帶 `title`、`question`），不存在時建立 |
| PATCH    | `/api/knowledge-pages/:id`                       | Web 手動編輯（`sections`，可帶 `title`）；每段須列來源 Session 或內容為「資料不足」，儲存為新版本 |
| GET      | `/api/knowledge-pages/:id/versions`              | 最近 50 個版本（新到舊）與引用 Session 的標題                                          |
| GET      | `/api/graph`                                     | 讀取 tracked-only deterministic work graph                                             |
| GET      | `/api/graph/path?from=&to=`                      | 兩個節點間的最短關聯（500 節點內 BFS），逐段附理由；可帶 `projectId`、`includeDerived=true` |
| PATCH    | `/api/diagrams/:id/void`                         | 作廢（`voided: true` 需 `reason`）或還原 Session 圖表；圖表不能刪除                     |
| GET      | `/api/insights/timeline`                         | 時間軸：期間內（預設最近 30 天，最長 366 天）的 Session（開始～完成）、Knowledge 事件與 Session 關聯；可帶 `projectId`、`from`、`to`；超過 2,000 筆 Session 時保留最新並標示 `truncated` |
| GET      | `/api/insights/activity`                         | 工作熱度日曆：`from`、`to`（必填，含頭尾，最長 400 天）期間內每個「伺服器時區本地日」完成的 Session 數，回傳 `{ outcome: "activity", from, to, days: [{ date, sessions }] }`，只列有工作的日期；僅 tracked 專案、排除作廢；可帶 `projectId` |
| GET      | `/api/insights/hotspots`                         | 熱點檔案：被最多 Session 修改的檔案（`groupBy=directory` 依目錄），附失敗／未執行次數與最近 5 筆 Session；可帶 `projectId`、`from`、`to`、`limit`（1–100，預設 20）。排除作廢與改動超過 20 個檔案的 Session |
| GET      | `/api/context`                                   | Agent context query（含 `pendingRequests`：等待 Agent 的報告整理與 metadata 回補請求）     |
| GET      | `/api/outstanding-items`                         | 分頁列出 tracked 專案的未結項；可帶 `projectId`、`status`、`page`、`pageSize`              |
| PATCH    | `/api/outstanding-items/:itemId`                 | Web 更新未結項狀態（pending／completed／not_needed），追加狀態稽核紀錄                   |
| PATCH    | `/api/outstanding-items/batch`                   | 一次更新 1–100 個不同項目；整批同一交易、逐筆稽核，可帶 expectedStatus 保護復原 |
| GET      | `/api/search?q=...`                              | Work history search（與 MCP `work_recall` 同一個排序引擎，只查 Session，最多 20 筆；可帶 `from`／`to`）   |
| GET      | `/api/backfill/metadata/preview?projectRoot=...` | 唯讀掃描 metadata 缺口                                                                 |
| GET/POST | `/api/backfill/metadata-requests`                | 建立或查詢 Agent metadata 回補請求                                                     |
| GET      | `/api/backfill/metadata-requests/:id/context`    | 取得受控 metadata 回補 context                                                         |
| POST     | `/api/backfill/metadata-requests/:id/cancel`     | 取消 pending／processing metadata 回補請求                                             |
| POST     | `/api/backfill/metadata`                         | Agent 回寫已確認的 Session metadata                                                    |
| GET      | `/api/reports?period=week&date=YYYY-MM-DD`       | 日/週/月/季/年工作報告，可加 `projectId`                                               |
| GET      | `/api/reports?from=YYYY-MM-DD&to=YYYY-MM-DD`     | 自訂期間工作報告（最長 366 天，`period` 為 `custom`）；`/api/reports/export` 同樣接受 |
| GET/POST | `/api/reports/synthesis-requests`                | 建立或查詢 Agent 報告提煉請求                                                          |
| POST     | `/api/reports/synthesis-requests/:id/cancel`     | 取消 pending／processing 報告提煉請求                                                  |
| POST     | `/api/reports/synthesis-requests/:id/retry`      | 將失敗／逾時的提煉請求建立為新的 pending attempt                                       |
| GET      | `/api/reports/synthesis-requests/:id/context`    | 取得受控、可追溯的提煉 Context                                                         |
| GET      | `/api/reports/summaries`                         | 查詢目前或歷史 Agent 報告摘要                                                          |
| POST     | `/api/reports/summaries`                         | Agent 回寫摘要與來源 Session                                                           |
| DELETE   | `/api/reports/summaries/:id`                     | 移除非目前使用中的歷史報告版本                                                         |
| POST     | `/api/work/finalize`                             | REST 形式的 finalize                                                                   |

## 敏感資料遮蔽

文字寫入路徑會依固定規則遮蔽常見 API token、私鑰、JWT、連線字串密碼及指定變數值。支援的成功寫入回應可能包含 `redactions: { total, byKind }`；欄位只回報數量，不含原始文字或 token 片段。Session detail/list 則會包含 `redactionCount`。可攜式 JSON 匯出會遮蔽既有內容，匯入時也會再次遮蔽；要整理目前資料庫內的歷史內容，請依[安全政策](../SECURITY.md#敏感資料遮蔽)使用 `pnpm db:redact`。

報告提煉請求與摘要查詢可使用 `period`、`date`、`projectId`／`scopeType`；指定自訂區間時傳入 `period=custom&from=YYYY-MM-DD&to=YYYY-MM-DD`，`from` 與 `to` 必須同時提供且最多 366 天。自訂區間以起訖日期共同識別，Agent 摘要的歷史版本也只會取代相同專案範圍、相同起訖日的目前版本。建立請求的 JSON 格式例如 `{ "period": "custom", "from": "2026-09-01", "to": "2026-09-14" }`。

## 未結項

- `GET /api/outstanding-items` 預設只列 `pending` 項目；可用 `status=pending|completed|not_needed`、`projectId`、`page` 與 `pageSize` 篩選及分頁。省略 `projectId` 時只涵蓋目前 tracked 的專案。
- 每筆資料帶穩定 `id`、文字、狀態、來源 Session id／標題、專案及建立／更新時間。來源 Session 被作廢後不再出現在清單中。
- `from`／`to` 是來源 Session 完成日期的含首尾日篩選（`YYYY-MM-DD`，伺服器時區）；非法日曆日期或倒置範圍回傳 `400 invalid_input`。MCP 既有清單參數保持不變。
- Web 可呼叫 `PATCH /api/outstanding-items/:itemId`，JSON body 為 `{ "status": "completed" }`、`{ "status": "not_needed" }` 或 `{ "status": "pending" }`。狀態轉換會追加稽核事件；恢復為 `pending` 可重新開啟。這個 API 不提供建立或刪除項目的能力。
- 專案不是 tracked 時回傳 `skipped`；無效的篩選或狀態回傳 `400 invalid_input`。找不到項目回傳 `not_found`，不揭露其他專案是否曾有該項目。
- `PATCH /api/outstanding-items/batch` body 為 `{ "itemIds": ["id1", "id2"], "status": "completed" }`。ID 必須非空且不重複，每批最多 100；不存在或來源已作廢時整批回傳 `400 invalid_input`。含未啟用記錄的專案時整批 `skipped`，不讀內容、不部分更新。成功回傳 `outstanding_items_updated`，`updatedItemIds` 僅包含實際變更者；相同狀態不新增稽核。
- 復原可傳 `status: "pending"` 與 `expectedStatus: "completed"`（或 `"not_needed"`）。任何一筆狀態已改變，整批回傳 `409 conflict` 並維持原狀；每筆狀態變更與稽核在同一個交易中完成。

## 未結項整理與人工審核

| 方法 | 路徑 | 參數 |
| --- | --- | --- |
| POST | `/api/outstanding-cleanup/requests` | JSON `{projectId,idempotencyKey}`，建立固定 pending 快照 |
| GET | `/api/outstanding-cleanup/requests` | `projectId?`、`status?`、`page?`、`pageSize?`（1–100） |
| GET | `/api/outstanding-cleanup/requests/:requestId/context` | `itemPage?`／`sessionPage?`，itemPageSize 1–5、sessionPageSize 1–10 |
| GET | `/api/outstanding-cleanup/requests/:requestId/proposals` | `reviewStatus?`（pending／accepted／rejected）、page、pageSize（1–100） |
| POST | `/api/outstanding-cleanup/requests/:requestId/proposals` | `{idempotencyKey,examinedItemIds,proposals}`；path requestId 為準 |
| POST | `/api/outstanding-cleanup/requests/:requestId/decisions` | `{proposalIds,decision}`，decision 為 accept／reject，1–100 筆 |
| POST | `/api/outstanding-cleanup/requests/:requestId/cancel` | JSON `{}`；保留建議與未結項 |

建立與提交成功為 201，policy skipped／not_needed／not_found 為 200；其他讀取與決策成功為 200。相同 key 的建立重試回傳原請求，另一個 key 遇到仍開放請求時回 409。context 無法在保留識別欄位下符合 24,000 字元預算時為 400 `invalid_input`（details.reason 為 `context_too_large`）；格式或 ID／證據不合格為 400 `invalid_input`；stale、already_examined／already_decided、idempotency_conflict、request_closed／active_request_exists 為 409 `conflict`，details 含 reason 與適用的 itemIds／proposalIds／requestId。未知例外固定 500 `internal_error`，不回傳資料庫或 Session 內容。

接受以單一 immediate transaction 重新核對 snapshot／來源／證據；任一無效則 proposal、item、audit 整批維持原狀。拒絕只修改 reviewStatus，不改未結項；同決策重試不增加稽核。取消不刪除記錄，也不改未結項。所有寫入沿用 JSON、Host／Origin 驗證與無資料 SSE changed 通知。提案欄位及時間範圍見 [MCP 整理契約](mcp-tools.md#未結項整理兩個讀取與一個提交-operation)。

pending／awaiting_review 整理快照中的項目受 Agent 寫入防護：finalize 完成／取代與來源 nextSteps 編輯不能直接結案。Web 逐筆／批次人工操作仍可使用；若改動來源或項目，原建議會由版本核對判為過期。取消或完成整理請求後恢復正常 Agent 收尾結案。

新增五個 project-data 表與 audit 關聯參與匯出、匯入、敏感資訊遮蔽與永久刪除；舊 schema bundle 預設空表與 null 關聯。整理理由是審核資料，不加入搜尋索引；原項目與來源仍由 Session 搜尋。遮蔽或重新匯入可能改變指紋，待審建議會保守視為過期，需要重新核對。

## Metadata backfill

當既有 Session 顯示 Verification 待回報、明確 not_run，或沒有 changed-files metadata 時，可以先預覽缺口，再由 Agent 提供已確認的資料批次回填。

- MCP：透過 `work_read` 執行 `work_preview_metadata_backfill` operation；可選 projectRoot 與 limit。
- 專案 → Metadata 回補分頁按下「掃描 metadata 缺口」後，若找到缺口，WorkLog 會在中央 SQLite 建立一筆 pending metadata backfill request；不會猜測，也不會直接修改 Session。
- UI 會顯示 Agent 狀態與「複製 Agent 指令」；使用者只需要在目前的 Codex 或 Claude 對話輸入：`請處理我剛在 Work Intelligence 掃描出的 metadata 缺口。` 也可以不掃描，直接請 Agent 補齊；沒有待處理請求時 Agent 會用 `work_request_metadata_backfill` 自己建立一筆。
- MCP Agent 會自動找最新的 pending／processing request，取得 bounded context，依 project policy 檢查對應 tracked project 的 handoff、worktree 或 diff，再透過 `work_write_overwrite` 執行 `work_apply_metadata_backfill` operation。使用者不需要提供 requestId、JSON 或工具順序。
- MCP：Agent 檢查對應的 handoff、worktree 或 diff 後，透過 `work_write_overwrite` 執行 `work_apply_metadata_backfill` operation，updates 內只放明確確認的 sessionId 與 metadata；帶入 requestId 時，所有缺口完成後 request 才會標為 completed，部分回補則保留為 processing 並回傳 remainingItems。
- REST：GET /api/backfill/metadata/preview?projectRoot=tracked-project-root
- REST：POST /api/backfill/metadata-requests 建立待 Agent 處理請求；GET /api/backfill/metadata-requests 查詢狀態；GET /api/backfill/metadata-requests/:id/context 取得受控 context。
- REST：POST /api/backfill/metadata，body 為 { updates: [...] }。
- UI：專案 → Metadata 回補分頁可以掃描並查看缺口、建立 pending request、複製自然語言指令，再開啟來源 Session；UI 不會替 Agent 猜測或自動寫回。
- 預覽不會讀取或猜測檔案變更；回填逐筆檢查 project policy，不建立新 Session，也不改變原本的 idempotencyKey、summary 或 events。
- 同一批次重複 sessionId 會回報 failure；paused、ignored、unregistered 專案會安靜 skipped。
- 以 `projectId` 建立或查詢 project-scoped 回補時，policy skip 回應會保留 `projectId`；unknown id 也不會被錯誤放進 `projectRoot` 欄位。

## 報告匯出

報告頁可以下載目前選定範圍的 Markdown 或 JSON。匯出內容與報告頁使用同一份 deterministic report data，不會重新推測或修改任何 Session。

- REST：GET /api/reports/export?period=week&date=YYYY-MM-DD&format=markdown
- REST：GET /api/reports/export?period=month&format=json&projectId=tracked-project-id
- MCP：透過 `work_read` 執行 `work_export_report` operation，format 可填 markdown 或 json
- markdown 會包含期間摘要、上一期比較、主要完成事項、Verification、風險、決策、趨勢、專案分布與來源證據。
- json 會保留完整的 WorkReport 結構，適合後續自動化或外部保存。
- `sessionTruncation.currentPeriod` 與 `sessionTruncation.previousPeriod` 分別標示本期及上一期是否超過 200 個 Session；若為 `true`，來源明細、趨勢、風險與決策清單為有界樣本；totals、verification 數量、專案分布與期間比較仍以完整期間計算。Markdown 匯出會附上來源截短提醒。
- 專案範圍仍遵守 tracked-only policy；unregistered、paused、ignored 會安靜回傳 skipped。

## 備份與匯出

- REST：GET /api/backups 列出備份（檔名、種類、時間、大小，及手動／自動各自的保留份數）；POST /api/backups（body `{}`）建立手動備份。
- 自動備份以 server 的本機日曆日為單位每天最多建立一份，預設保留最近 14 份；手動備份另有獨立的 14 份保留額度，不會影響自動備份排程或刪除自動備份。
- REST：POST /api/export（body `{}`）即時產生整份資料的 SQLite 快照，以 `application/vnd.sqlite3` 下載，暫存檔在傳送後刪除。可攜式 JSON 則使用 `{"scope":"all"}`，或 `{"scope":"project","projectId":"<id>"}`；檔案上限為 50 MiB，超過回 413。
- REST：POST /api/import/preview 與 POST /api/import 都接受 `{ "bundle": <可攜式匯出>, "projectId"?: "<id>", "remap"?: [{"from":"<舊路徑>","to":"<新路徑>"}] }`。`projectId` 可從全專案匯出檔挑選單一專案；`remap` 可重複多筆，以完整路徑片段比對、Windows 路徑不分大小寫，並依新路徑轉換分隔符號。只有匯入兩個端點把 request body 上限提高至 50 MiB；超過回 413，格式錯誤回 400。
- Preview 只讀取並回傳各資料表新增／略過／衝突筆數及最多 100 筆衝突明細，不回傳專案路徑。正式匯入會在一個 SQLite 交易中重新計算預覽並合併非衝突資料；不覆寫或刪除既有資料，且重複匯入可冪等略過。新專案以 `paused` 狀態加入，既有專案狀態不變；匯入會留下摘要稽核紀錄並由 SQLite trigger 標記搜尋索引待更新。服務不必停止。
- 可攜式 JSON 未加密，請妥善保管。整份 SQLite 快照與可攜式匯出都要求 `Content-Type: application/json`，跨站表單無法觸發；下載回應只含檔名，不會出現暫存檔路徑。
- in-memory 資料庫回傳 409 `backup_unavailable`。
- 還原不提供 REST：要取代資料庫時不能有其他連線開著它，請用 `pnpm db:restore`（見 README「備份與換電腦」）。

## 系統狀態

- REST：GET `/api/system/status` 回傳程式版本與支援的 schema 版本；`database` 含目前資料庫路徑、檔案大小、可讀狀態與實際 schema 版本；`backups` 含備份可用狀態、最新自動備份、份數與總大小；`maintenance` 含最近一次維護結果與安全錯誤代碼；`userService` 唯讀回報目前使用者的登入服務管理器、安裝／執行／啟用狀態、服務設定路徑、資料庫、備份目錄與日誌路徑；`sseConnections` 是目前開啟的即時更新連線數。 `agents.codex` 與 `agents.claudeCode` 顯示 MCP 註冊狀態（`registered`／`missing`／`unknown`）、skill 複本狀態及 hook 狀態；Codex TOML 無法解析時回報 `unknown`，不會修改設定檔；`mcp.restartRequired` 保留 A3 的重新連線判斷。
- Agent 與登入服務診斷只讀取設定檔或查詢作業系統服務管理器，回傳狀態而不回傳 Agent 設定值或內容；端點不寫入設定、不安裝／啟動／停止服務、不執行 setup 或 hook，也不執行資料庫 `integrity_check`。完整環境診斷請在專案目錄執行 `pnpm run doctor`。
- 端點受到 loopback `Host` 與 `Origin` 檢查保護；只有系統狀態頁需要的 `database.path` 會回傳完整本機路徑，備份資料仍只回傳檔名。

## 永久刪除專案

- REST：DELETE `/api/projects/:id` 接受 JSON body `{ "confirmationName": "<專案名稱>" }`。名稱必須與 registry 中的專案名稱完全相同；輸入錯誤回 409，不存在回 404，輸入格式錯誤回 400。
- 刪除前會建立並檢查整份 SQLite 快照，回應 `backupFileName`；檔案歸類為手動備份，遵循手動備份保留額度。備份失敗回 503 並保留專案；交易失敗回 500 並保留已建立的備份。in-memory database 無法建立必要備份，因此會拒絕刪除。
- 一個 SQLite transaction 會刪除專案、Sessions、events、handoff、Evidence、Knowledge、候選與請求、稽核記錄、verification／summary 修改紀錄、search index，以及任何一端連到目標 Session 的 Session 關聯。共享報告與回補請求只要引用目標 Sessions，也會整筆移除，避免留下相關內容或 ID；刪除筆數會回傳在 `deletedCounts`。
- `project_deletion_audit` 只留下時間、被刪除的 project id 與各類筆數，不保存專案名稱、路徑或被刪資料內容。專案 workspace 資料夾及原始檔案不會被 REST 操作觸及。
- REST：GET `/api/project-deletion-audits` 唯讀回傳依時間排序的紀錄，每筆只有 `deletedAt`、`projectId` 與 `deletedCounts`；不會回傳名稱、路徑或被刪資料內容。
- Web UI 的「專案 → 刪除紀錄」會列出時間、專案 id 與各類刪除筆數；專案清單的刪除動作仍要求輸入完整專案名稱。MCP 沒有刪除專案的工具。

## 選擇專案資料夾

瀏覽器拿不到資料夾的完整路徑，所以「加入專案」的「選擇資料夾」由本機 API server 叫出作業系統的對話框：macOS 用 `osascript`、Windows 用 PowerShell 的 FolderBrowserDialog、Linux 依序嘗試 `zenity` 與 `kdialog`。

- 回應為 `folder_picked`（`path`、`name`）、`folder_pick_cancelled`、`folder_pick_busy`（已有一個視窗開著），或 `folder_pick_unavailable`（沒有桌面環境或找不到對話框程式）。
- 指令與參數都是固定字串、不經過 shell，也不帶入任何請求內容；要求 JSON body，跨站表單無法觸發視窗。
- 視窗 5 分鐘沒有選擇即放棄；同一時間只開一個。

## 匯入位置與重新指定專案位置

- `GET /api/projects` 會附上衍生欄位 `folderStatus`：`found`、`missing` 或 `unavailable`。Server 僅檢查路徑是否為本機絕對路徑及 `stat` 資料夾狀態，不讀取資料夾內容。
- 可攜式匯入預覽會在每個 `selectedProjects` 項目附上 `sourceRootPath`（匯出時路徑）與 `folderStatus`；`rootPath` 是 remap 後的目標路徑。這些資料僅供本機 UI／CLI 預覽，不會用來開啟或讀取資料夾。
- `PATCH /api/projects/:id/location` 接受 `{ "rootPath": "<新資料夾>", "confirmedTrackedScope": true }`。新位置須存在且為目錄；tracked 專案需要 `confirmedTrackedScope: true`，並在一個交易內更新 registry 路徑、同專案 raw snapshot 的路徑前綴與不含路徑的稽核資料。與其他專案根目錄重疊時回 409；需要確認、位置無效與專案不存在分別回傳安全錯誤碼。
- `POST /api/import/preview` 與 `POST /api/import` 的 remap 行為相同；匯入本身仍不會讀取 remap 指向的檔案或資料夾。MCP 沒有重新指定專案位置或刪除工具。

## 即時更新串流

- REST：GET /api/events 回傳 `text/event-stream`。連線時先送出 `: connected`，之後 server 每 2 秒檢查一次 SQLite 的 `PRAGMA data_version`；包括 Agent 的 MCP 在內，任何連線寫入資料後，都會推送 `event: changed`。每 15 秒送一次 `: keep-alive`。
- 事件不帶任何資料或路徑，只是「有變化」的訊號；Web 收到後重新載入目前頁面，分頁在背景時會關閉串流，回到前景再補抓一次。
- 與其他端點一樣檢查 `Host` 白名單與 `Origin`；沒有連線時停止輪詢。


## 版本化架構圖

`diagrams`／`work_attach_diagram` 支援 `kind: "architecture"`、`formatVersion: 1` 與 JSON 字串 `source`。新增寫入只接受明確指定的原生格式與版本；歷史 Mermaid 僅讀取／匯入並顯示原始碼。完整欄位、限制、冪等與資料生命週期見[架構圖格式](architecture-diagram-format.md)；Agent 先讀 `work-intelligence://agent/architecture-diagram-v1`。

## 提醒聚合

`GET /api/attention` 接受 `projectId`、`kind`、`page`（1–100000）、`pageSize`（1–50，預設 20）；未知參數及無效值回 400 `invalid_input`。kind 為 synthesis、backfill、cleanup、decision、knowledge、knowledge_page、outstanding 或 metadata。省略專案時只聚合 tracked 專案；指定不可見專案回 200 `skipped`。全域請求中有任一來源 Session 不存在、作廢或所屬專案不可見，該請求不列出。

回應 `outcome: attention` 包含 `items`、`groups`、`minimumTotal`、`total` 及 `pageInfo`。item 是有界來源指標：穩定 tuple ID、kind／sourceId／projectId、最多 500 字標題、reason、可用數量、updatedAt、sourceRevision 與固定種類 target；沒有任意 URL、workspace root、來源全文或內部例外。查看或聚合都不結案，原領域依既有契約處理審閱／確認／取消。

每類最多 200 筆來源窗口；`groups` 分別回 state（complete／partial／failed）、examined、available 與精確 matching total（未知時 null）。pending 未結項與 metadata 缺口按專案各提供一個入口，count 為該專案項目／Sessions 數；聚合 total 計提醒與專案入口數，並非全專案問題數。Knowledge／知識頁由原服務計算可信度，窗口外未知時只保留 minimumTotal 下限。某類失敗不回錯誤正文，其他類仍可查閱；所有類精確數量已知時 total 才為數字。pageInfo 是可查閱窗口的分頁，不等於全來源匹配數量。

總覽 URL 使用 attentionProject、attentionKind、attentionPage、attentionSize。Knowledge 的來源深連結為 `/knowledge/list?project=<id>&knowledge=<id>`，知識頁使用 knowledgePage，補填頁 `/projects/backfill?project=<id>&backfillRequest=<id>`；原未結項整理的 cleanupRequest 入口保持不變。尚未加入稍後、不顯示或一般解除提醒的寫入 API。

### 相關工作提示

`GET /api/sessions/:sessionId/related` 為唯讀端點；未知 query 被拒絕。限記錄中專案、未作廢來源、已確認且 1–20 個檔案。缺失／停用／作廢來源回傳 `state: unavailable` 與 `reason: source_unavailable`，不洩漏標題。其他 reason 為 `files_unconfirmed`／`no_files`／`too_many_files`。

最多五筆，排序為共同檔數、Jaccard、完成時間、ID；每筆最多三個共同路徑。既有雙向 Session 關聯排除，絕不新增關聯。每條檔案 posting 最多查閱 1,000 筆，`coverage.partial` 明示截短，`examined` 是已檢查候選數，並非全專案總數。沒有新增 MCP 操作。


## 報告段落呈現

`GET /api/reports/summaries/:id/presentation` 回傳 summaryId、revision、state 與最近 20 筆 revision 的 Web 修改歷程。state 包含 pinned（釘選順序）、hidden（隱藏群組）及 overrides（section、原始 ordinal、title、detail）；七種 section 為 themes、highlights、verification、comparison、risks、decisions、nextSteps。沒有修改時 revision 為 0。

`PATCH /api/reports/summaries/:id/presentation` 接受嚴格的 `{expectedRevision,state}` JSON。未知欄位、重複身份、不存在的段落或空群組操作回 400；每筆 title 最多 300、detail 最多 4000 字元，全部改稿合計最多 8000。相同狀態不建立新 revision。版本不符回 409 `conflict`，客戶端保留草稿並取得最新狀態供明確比較及套用。

原始 ReportSummary 與 sourceSessionIds 不受修改。每次讀寫均檢查基底及全部來源存在、未作廢且所屬專案為 tracked；不可見來源或版本回 404，不返回報告內容。仍遵守 JSON Content-Type、Host／Origin 邊界與未知例外遮蔽。


## 報告呈現 Markdown 預覽

`GET /api/reports/summaries/:id/presentation/export?revision=0&locale=zh-TW` 回傳 `outcome`、`summaryId`、`revision`、`filename` 與純文字 `content`。revision 必填且為非負安全整數；locale 為 zh-TW 或 en-US（省略採 zh-TW）；未知欄位回 400。來源核對與呈現讀取使用同一 SQLite read snapshot，避免不同版本混合。來源不存在、作廢或不可見回 404；修訂與請求不同回 409，不偷偷匯出新版。

整理版沿用 UI 的投影，隱藏群組不含正文，改稿標示為使用者改稿；保留每段引用及包含隱藏群組的完整原報告來源。Markdown 語法與 HTML 特別字元以純文字逸出。基本版重用既有 `/api/reports/export`，沒有寫入 Session 或新 MCP 工具。前端先取得預覽，再於獨立點擊中立即呼叫剪貼簿；失敗提供可選取文字與下載。

### 提醒顯示偏好

`GET /api/attention` 可帶 `view=visible|suppressed`（預設 visible）。`total`、`minimumTotal` 與來源 groups 始終代表尚未處理的來源；`pageInfo.total` 只代表本次有界掃描中符合顯示條件的列，`suppressedCount` 是已檢查視窗內的隱藏／稍後筆數，不能視為全域完整計數。

`PATCH /api/attention/preferences` 接受 `projectId`、`kind`、`sourceId`、`sourceRevision`、`expectedRevision` 與 `action=snooze|hide|restore`。七天期限由伺服器時計算。交易內重核 tracked 專案、來源及偏好修訂；過期來源或修訂回 409，無來源回 404，停用專案安靜 skipped。跨專案的全域請求不提供偏好操作。這是 Web 顯示意圖，不會結案、取消或修改來源資料，也沒有對應 MCP 寫入工具。

migration 30 保存每個專案／類型／來源一筆最新偏好；來源 revision 改變或稍後期限到期時查詢重新顯示。來源刪除觸發器與專案 cascade 清除偏好。可攜式匯出保留資料，匯入預設重新顯示，避免把另一個資料庫的來源身分推定為相同事件；舊備份缺表預設空清單。
