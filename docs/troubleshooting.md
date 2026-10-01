# 疑難排解

> 執行只讀環境檢查：`pnpm run doctor`。不要使用 `pnpm doctor`；pnpm 11 會執行套件管理器自己的 doctor，而不是 Work Intelligence 診斷。

## Web 顯示無法連線到 API

正式模式的 Web 與 API 共用 `127.0.0.1:3210`。API 離線時頁面會顯示「無法連線到 Work Intelligence API」；連線恢復後，頁面會自動重新載入目前資料。

1. 確認啟動 server 的終端機仍在執行，並查看是否顯示 `Work Intelligence API listening`。
2. 在另一個終端機執行 `pnpm run doctor`，查看 API 狀態、連接埠與 build 檔案檢查結果。
3. 確認正式模式已先執行 `pnpm build`，再執行 `pnpm start`。
4. 若預設連接埠已被其他程式占用，停止該程式，或設定 `WORK_INTELLIGENCE_PORT` 並重新啟動 Work Intelligence；不需要重新 build，Web 與 API 會一起改用新連接埠。
5. 開發模式請執行 `pnpm dev`。Web 使用 5966，API 使用 3210；不要同時啟動兩份指向同一個 port 的 server。

## API port 被占用

`pnpm start` 遇到 port 被占用時會顯示「127.0.0.1:<port> 已被占用，Work Intelligence 沒有啟動」並結束。最常見的原因是另一個終端機已經在執行 Work Intelligence：先開啟 <http://127.0.0.1:3210> 確認。

`pnpm run doctor` 會區分可用、Work Intelligence 正常回應、以及被其他程式占用的 port。若不是 Work Intelligence，請停止占用程式，或設定 `WORK_INTELLIGENCE_PORT` 為未使用的連接埠再啟動。正式模式的 Web 與 API 使用同一個設定值。

## MCP 需要重新連線，或建置狀態未知

`work_get_project_status` 與 `work_get_context` 會比較目前磁碟建置和該 MCP 程序的 startup fingerprint 及相容性識別（schema 版本、工具清單、完整 operation 契約資源）；doctor 與「系統狀態」則彙總 OS 暫存目錄中的 heartbeat leases。首次安裝這項偵測時，先前第八輪 A2 MCP 沒有 heartbeat lease 與新的 server status 欄位；請手動重連一次 Work Intelligence MCP，讓新程序建立 lease，之後 Doctor/Web 才能偵測該程序及後續過期版本。只改實作時顯示「有新版可用」，原連線可繼續讀寫，收尾再重連即可；系統狀態分開列出兩種程序數。schema／契約改變或無法判定相容性時要求重連，寫入前會攔下舊程序。若畫面指出需要重新連線，請在 Codex／Claude 的 MCP 面板中重連 Work Intelligence MCP，之後重新整理「系統狀態」。若 build 狀態未知，先等 `pnpm build` 完成並確認 runtime registry 可讀寫，再重新整理；不要把未知狀態當成目前版本。Registry 可用但尚無 heartbeat 時，Doctor 會提醒尚無可監測連線，Web 以中性狀態顯示尚無連線；registry 不可用或 build 未完成時兩者都顯示無法確認。

MCP 註冊及系統狀態讀取會自動清理同一安裝 scope 的過期 lease：預設心跳 TTL 為 30 秒，再留 60 秒緩衝，因此超過 90 秒才可清理。`.json` 的心跳與檔案修改時間都必須超過門檻；損毀的 `.json` 與遺留 `.tmp` 依修改時間判斷。每次最多嘗試刪除 64 個檔案，註冊最多檢查 512 個目錄項目；大量舊檔會隨後續讀取逐步清理。只處理目前 scope 內符合 UUID v4 命名的一般檔案，保留其他檔名、子目錄、符號連結與其他 scope；刪除失敗靜默略過，不中斷記錄。

Workspace build 中斷時 `.work-intelligence-build-in-progress` 會保留，避免混合 dist 被誤判為有效版本。確認 marker 記錄的 PID 已退出後，移除該 marker 並重新執行完整 `pnpm build`；不要在 build process 仍執行時刪除。

第九輪整理未結項新增 schema 與 Agent 契約，更新主安裝後需要重啟服務並重新連線。若仍看不到整理請求，先確認執行中的服務和 Agent 指向已完成建置的同一安裝，再依[MCP 更新對照](mcp-tools.md#更新與重新連線)確認狀態。

## MCP 沒有載入新工具

MCP tool 清單會在 Codex／Claude 建立 stdio 連線時載入。更新 MCP 程式後：

1. 在 WorkLog.Ai 根目錄執行 `pnpm build`。
2. 關閉並重新開啟 Agent 對話，或重新連線 `work-intelligence` MCP。
3. 用 Codex 可執行 `codex mcp list`、`codex mcp get work-intelligence`；Claude Code 可執行 `claude mcp list`、`claude mcp get work-intelligence`。
4. 若設定路徑或啟動命令已改變，依[Agent 設定說明](agent-setup.md)重新註冊。

## 全域保存提醒 hook 沒有觸發

Work Intelligence hook 只使用使用者的全域設定，不使用單一專案設定。確認：

1. 在 repo 根目錄執行 `pnpm build`，確認所需的 `apps/mcp/dist/` 腳本存在。
2. Claude Code 的 Stop hook 設於全域 `~/.claude/settings.json`；Codex 的 `PostToolUse` 與 `Stop` hook 設於全域 `~/.codex/hooks.json`。指令必須指向這個 repo 內腳本的**絕對路徑**。
3. Codex 請輸入 `/hooks`，確認保存提醒 hook 已載入並完成信任；未信任的 hook 會被略過。
4. 確認 `node` 可以從 Agent 的 `PATH` 找到；若找不到，將 hook 指令中的 `node` 改成 Node.js 執行檔的絕對路徑。
5. 出現 `hook timed out after 3s` 之類的逾時：hook 本身幾乎不花時間，時間主要花在啟動 `node`。Windows 上防毒或端點防護掃描可能讓每次啟動 node 超過 1 秒，再加上 `cmd.exe` 與同時執行的其他 hook，很容易超過 3 秒。請把 Work Intelligence hook 的 `timeout` 調成 `10`（與 Claude Code 範例相同），Codex 需要在 `/hooks` 重新信任修改後的 hook。
6. Codex 的提醒依 `apply_patch` 與 `work_write_idempotent`（operation `work_finalize_session`）標記未保存工作；舊的直接工具名稱仍相容。只用 Bash 編輯檔案不會觸發 Codex 的改檔標記。若全域設定仍有只匹配舊工具名稱的 PostToolUse matcher，請在檢查更新內容後依[Agent 設定說明](agent-setup.md)執行專案更新流程，讓 installer 更新由它管理的 matcher；Doctor 會將舊 matcher 顯示為未完整設定。

hook 只在 Work Intelligence 正在記錄的專案中作用，讀不到狀態時會放行。`pnpm run doctor` 只讀取全域 Claude／Codex 設定檔與 hook dist 檔案，不會讀取 repo 內的 `.codex/hooks.json`，也不會修改任何 Agent 設定。

## 工作記錄的時間不對

常見原因是 Agent 自己估計時間，或把本地時間加上 `Z` 當成 UTC（台北時間會差 8 小時）。

- 新的記錄：`completedAt` 晚於伺服器時間超過 5 分鐘會被拒絕；看起來像估計的值（比伺服器時間早超過 24 小時、開始晚於完成、開始到完成超過 7 天）會在結果中附上 `timestampWarnings`。
- 修正既有記錄：請 Agent 用 `work_update_session_metadata` 的 `startedAt`、`completedAt`，填入有依據的時間（對話紀錄或 commit 時間，並帶時區，例如 `+08:00`）。不需要作廢再重建。修正完成時間時，Session 會多一筆「完成時間由…更正為…」的事件，保留原值。
- 保存提醒 hook 會在提醒中附上這段工作的開始時間（Codex 需要另外設定 `UserPromptSubmit` hook，見[連接 Agent](agent-setup.md)）；Agent 需要現在時間時，可以從 `work_get_project_status` 或 `work_get_context` 回傳的 `clock` 取得。

## 還原時資料庫仍被開著

還原會取代目前的 SQLite，因此必須先釋放其他連線：

1. 在 server 終端機按 `Ctrl+C`，停止 `pnpm start` 或 `pnpm dev`。
2. 關閉會啟動 `work-intelligence` MCP 的 Codex／Claude 對話，或先在用戶端中斷 MCP 連線。
3. 等待相關 Node 程序完全退出，再重試 `pnpm db:restore <檔案>`。

只有在你已確認沒有程式仍使用資料庫時，才使用 CLI 的 `--force` 略過使用中檢查。不要在 API 或 MCP 仍開啟資料庫時手動覆蓋 SQLite 檔案。

## `pnpm db:maintain` 顯示資料庫使用中

維護會執行 `VACUUM` 並重建搜尋索引，需要獨占資料庫。只要 API server 或 MCP 還開著資料庫（即使閒置），就無法取得獨占鎖，維護會在做任何變更前停止：

1. 停止 `pnpm start` 或 `pnpm dev`。
2. 關閉會啟動 `work-intelligence` MCP 的 Codex／Claude 對話。
3. 重新執行 `pnpm db:maintain`，完成後用 `pnpm run doctor` 確認最近一次維護結果。

維護失敗時，維護前備份（`pre-maintenance-…`）會保留在備份目錄，doctor 會顯示失敗代碼。

## 可攜式 JSON 匯入有衝突

先在 Web UI 或執行 `pnpm db:import <檔案.json> --dry-run` 查看預覽。匯入會新增缺少的資料、略過完全相同的項目，並列出同一識別值但內容不同的衝突；它不會覆寫既有資料。換電腦時，Web UI 會顯示匯出路徑與目前資料夾狀態；找不到的資料夾可逐一重新選擇，也可略過，匯入後再從專案頁重新指定位置。CLI 互動匯入也會逐一詢問，直接按 Enter 略過；非互動匯入可使用 `--remap-root <舊路徑>=<新路徑>`。選定位置只會做資料夾狀態檢查，不讀取資料夾內容。修正來源或目標狀態後再重試；不要直接修改 SQLite 來消除衝突。

## 開發模式看到 `Unexpected end of JSON input`

較舊的開發 server 在 Vite／API 重啟期間，proxy 可能回傳空的錯誤本文，瀏覽器嘗試解析 JSON 時就會出現這個訊息。#56 已修正 API client：會先讀取文字，妥善處理空本文並顯示連線錯誤。請更新程式碼、執行 `pnpm build`，重新啟動 `pnpm dev` 後重試；一般使用也可用正式模式 `pnpm start`。

若仍然發生，記下發生時間、使用的命令與 server 終端機的錯誤摘要；分享前請移除專案路徑、Session 內容及其他私人資料。
