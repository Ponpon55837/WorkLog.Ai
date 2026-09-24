# REST API

API 固定綁定 `127.0.0.1:3210`，只給本機 Web UI 與本機 client 使用。`Host` 必須是 loopback（或 `WORK_INTELLIGENCE_ALLOWED_ORIGINS` 內的主機），否則回 421；帶 `Origin` 的請求必須在 origin 白名單內，否則回 403。所有寫入要求 `Content-Type: application/json`，並先通過 project policy。

日期參數（`from`、`to`、`date`）是 server 所在系統時區的日曆日期；報告回應的 `timezone` 會標出使用的 IANA 時區。

> 回到 [README](../README.md)

| Method   | Route                                            | 用途                                                                                   |
| -------- | ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| GET      | `/api/health`                                    | API/SQLite health                                                                      |
| GET      | `/api/dashboard`                                 | Dashboard counters + recent sessions（只計算 tracked 專案）                            |
| GET/POST | `/api/projects`                                  | 列出/加入 registry project                                                             |
| PATCH    | `/api/projects/:id`                              | 更新名稱或 tracking status                                                             |
| GET      | `/api/sessions`                                  | Worklog session list（只含 tracked 專案）；可用 `q`、`projectId`、`from`／`to`（YYYY-MM-DD）篩選（系統時區、含頭尾），`voided=include`／`only` 顯示已作廢的 Session |
| GET      | `/api/sessions/:id`                              | Session detail、events、raw handoff                                                    |
| PATCH    | `/api/sessions/:id/metadata`                     | Agent 回填 changed files、verification、Git metadata                                   |
| PATCH    | `/api/sessions/:id/summary`                      | 以 replace／append 更新既有 finalized Session 主摘要（Agent 與 Session 面板「編輯 Session」共用） |
| PATCH    | `/api/sessions/:id/work-summary`                 | 以 replace／patch 更新既有 finalized Session 五段 workSummary（Session 面板只 patch 有改的段落） |
| POST     | `/api/sessions/:id/evidence`                     | 保存 Agent 提供的 evidence reference                                                   |
| PATCH    | `/api/sessions/:id/verification`                 | 修正 verification（`status`：passed／failed／not_run，選填 `summary`），每次變更寫入修改紀錄 |
| POST     | `/api/sessions/:id/links`                        | 建立或更新 Session 關聯（`relatedSessionId`、`relation`：continues／related）            |
| DELETE   | `/api/sessions/:id/links/:relatedId`             | 移除兩筆 Session 之間的關聯                                                           |
| PATCH    | `/api/sessions/:id/void`                         | 作廢（`voided: true` 與必填 `reason`）或還原（`voided: false`）Session，保留作廢紀錄 |
| PATCH    | `/api/evidence/:id/void`                         | 標示 Evidence 為錯誤或還原，保留作廢紀錄                                              |
| GET      | `/api/knowledge`                                 | 搜尋 tracked projects 的 explicit Knowledge                                            |
| POST     | `/api/knowledge`                                 | 保存 Agent 明確提交的 Knowledge                                                        |
| PATCH    | `/api/knowledge/:id`                             | 在 project policy 通過後更新或封存 Knowledge                                           |
| GET      | `/api/knowledge/:id/history?projectRoot=...`     | 讀取 Knowledge audit history；先通過 project policy                                    |
| GET      | `/api/graph`                                     | 讀取 tracked-only deterministic work graph                                             |
| GET      | `/api/context`                                   | Agent context query（含 `pendingRequests`：等待 Agent 的報告整理與 metadata 回補請求）     |
| GET      | `/api/search?q=...`                              | Work history search（與 MCP `work_recall` 同一個排序引擎，只查 Session，最多 20 筆）   |
| GET      | `/api/backfill/metadata/preview?projectRoot=...` | 唯讀掃描 metadata 缺口                                                                 |
| GET/POST | `/api/backfill/metadata-requests`                | 建立或查詢 Agent metadata 回補請求                                                     |
| GET      | `/api/backfill/metadata-requests/:id/context`    | 取得受控 metadata 回補 context                                                         |
| POST     | `/api/backfill/metadata-requests/:id/cancel`     | 取消 pending／processing metadata 回補請求                                             |
| POST     | `/api/backfill/metadata`                         | Agent 回寫已確認的 Session metadata                                                    |
| GET      | `/api/reports?period=week&date=YYYY-MM-DD`       | 日/週/月/季/年工作報告，可加 `projectId`                                               |
| GET/POST | `/api/reports/synthesis-requests`                | 建立或查詢 Agent 報告提煉請求                                                          |
| POST     | `/api/reports/synthesis-requests/:id/cancel`     | 取消 pending／processing 報告提煉請求                                                  |
| POST     | `/api/reports/synthesis-requests/:id/retry`      | 將失敗／逾時的提煉請求建立為新的 pending attempt                                       |
| GET      | `/api/reports/synthesis-requests/:id/context`    | 取得受控、可追溯的提煉 Context                                                         |
| GET      | `/api/reports/summaries`                         | 查詢目前或歷史 Agent 報告摘要                                                          |
| POST     | `/api/reports/summaries`                         | Agent 回寫摘要與來源 Session                                                           |
| DELETE   | `/api/reports/summaries/:id`                     | 移除非目前使用中的歷史報告版本                                                         |
| POST     | `/api/work/finalize`                             | REST 形式的 finalize                                                                   |

## Metadata backfill

當既有 Session 顯示 Verification 待回報、明確 not_run，或沒有 changed-files metadata 時，可以先預覽缺口，再由 Agent 提供已確認的資料批次回填。

- MCP：先呼叫 work_preview_metadata_backfill；可選 projectRoot 與 limit。
- 專案 → Metadata 回補分頁按下「掃描 metadata 缺口」後，若找到缺口，WorkLog 會在中央 SQLite 建立一筆 pending metadata backfill request；不會猜測，也不會直接修改 Session。
- UI 會顯示 Agent 狀態與「複製 Agent 指令」；使用者只需要在目前的 Codex 或 Claude 對話輸入：`請處理我剛在 Work Intelligence 掃描出的 metadata 缺口。` 也可以不掃描，直接請 Agent 補齊；沒有待處理請求時 Agent 會用 `work_request_metadata_backfill` 自己建立一筆。
- MCP Agent 會自動找最新的 pending／processing request，取得 bounded context，依 project policy 檢查對應 tracked project 的 handoff、worktree 或 diff，再呼叫 work_apply_metadata_backfill。使用者不需要提供 requestId、JSON 或工具順序。
- MCP：Agent 檢查對應的 handoff、worktree 或 diff 後，呼叫 work_apply_metadata_backfill，updates 內只放明確確認的 sessionId 與 metadata；帶入 requestId 時，所有缺口完成後 request 才會標為 completed，部分回補則保留為 processing 並回傳 remainingItems。
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
- MCP：呼叫 work_export_report，format 可填 markdown 或 json
- markdown 會包含期間摘要、上一期比較、主要完成事項、Verification、風險、決策、趨勢、專案分布與來源證據。
- json 會保留完整的 WorkReport 結構，適合後續自動化或外部保存。
- 專案範圍仍遵守 tracked-only policy；unregistered、paused、ignored 會安靜回傳 skipped。
