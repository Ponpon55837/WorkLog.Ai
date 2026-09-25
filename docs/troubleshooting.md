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

`pnpm run doctor` 會區分可用、Work Intelligence 正常回應、以及被其他程式占用的 port。若不是 Work Intelligence，請停止占用程式，或設定 `WORK_INTELLIGENCE_PORT` 為未使用的連接埠再啟動。正式模式的 Web 與 API 使用同一個設定值。

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
5. Codex 的提醒依 `apply_patch` 與 `work_finalize_session` 標記未保存工作。只用 Bash 編輯檔案不會觸發 Codex 的改檔標記。

hook 只在 Work Intelligence 正在記錄的專案中作用，讀不到狀態時會放行。`pnpm run doctor` 只讀取全域 Claude／Codex 設定檔與 hook dist 檔案，不會讀取 repo 內的 `.codex/hooks.json`，也不會修改任何 Agent 設定。

## 還原時資料庫仍被開著

還原會取代目前的 SQLite，因此必須先釋放其他連線：

1. 在 server 終端機按 `Ctrl+C`，停止 `pnpm start` 或 `pnpm dev`。
2. 關閉會啟動 `work-intelligence` MCP 的 Codex／Claude 對話，或先在用戶端中斷 MCP 連線。
3. 等待相關 Node 程序完全退出，再重試 `pnpm db:restore <檔案>`。

只有在你已確認沒有程式仍使用資料庫時，才使用 CLI 的 `--force` 略過使用中檢查。不要在 API 或 MCP 仍開啟資料庫時手動覆蓋 SQLite 檔案。

## 可攜式 JSON 匯入有衝突

先在 Web UI 或執行 `pnpm db:import <檔案.json> --dry-run` 查看預覽。匯入會新增缺少的資料、略過完全相同的項目，並列出同一識別值但內容不同的衝突；它不會覆寫既有資料。檢查來源檔是否選對、是否選了正確專案，以及換電腦時是否要用 `--remap-root <舊路徑>=<新路徑>`。修正來源或目標狀態後再重試；不要直接修改 SQLite 來消除衝突。

## 開發模式看到 `Unexpected end of JSON input`

較舊的開發 server 在 Vite／API 重啟期間，proxy 可能回傳空的錯誤本文，瀏覽器嘗試解析 JSON 時就會出現這個訊息。#56 已修正 API client：會先讀取文字，妥善處理空本文並顯示連線錯誤。請更新程式碼、執行 `pnpm build`，重新啟動 `pnpm dev` 後重試；一般使用也可用正式模式 `pnpm start`。

若仍然發生，記下發生時間、使用的命令與 server 終端機的錯誤摘要；分享前請移除專案路徑、Session 內容及其他私人資料。
