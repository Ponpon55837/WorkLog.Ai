# Work Intelligence 使用手冊

Work Intelligence 是本機優先的工作記憶工具。它提供 Web Dashboard、REST API 與供 Codex／Claude 使用的本機 MCP server；只有你明確設為「記錄中」的專案才會被讀取與保存。

## 安裝與正式模式

需求：Node.js 22.5 以上（建議 Node.js 24）與專案指定版本的 pnpm。請在 WorkLog.Ai 專案根目錄執行：

```sh
pnpm install
pnpm build
pnpm start
```

預設在 <http://127.0.0.1:3210> 開啟 Web UI；REST API 也在同一個連接埠，例如 <http://127.0.0.1:3210/api/health>。終端機保持執行，按 `Ctrl+C` 停止。開發時才使用 `pnpm dev`；開發模式的 Web 使用 5966，API 使用 3210。

第一次檢查環境可執行：

```sh
pnpm run doctor
```

請使用 `pnpm run doctor`，不要使用 `pnpm doctor`：pnpm 11 將 `doctor` 保留為套件管理器自己的命令，`pnpm doctor` 不會執行 Work Intelligence 診斷。

資料預設放在 `data/work-intelligence.sqlite`，也可設定 `WORK_INTELLIGENCE_DB` 指定位置。常用設定如下：

| 環境變數 | 用途 |
| --- | --- |
| `WORK_INTELLIGENCE_DB` | 共用 SQLite 檔案位置，API、MCP 與 CLI 應使用同一個檔案 |
| `WORK_INTELLIGENCE_PORT` | Web 與 API 共用的本機連接埠，預設 `3210` |
| `WORK_INTELLIGENCE_BACKUP_DIR` | 備份目錄，預設為資料庫旁的 `backups/` |
| `WORK_INTELLIGENCE_BACKUP_KEEP` | 手動備份保留份數，預設 14；自動備份另行保留 14 份 |
| `WORK_INTELLIGENCE_BACKUP=off` | 停用每日自動備份 |

設定 MCP 與全域保存提醒 hook 的方式見[連接 Agent](agent-setup.md)。MCP 使用 stdio，由 Codex／Claude 分別啟動；它不使用 Dashboard 的 HTTP 連接埠。

## 第一次使用

1. 在左側選單開啟「專案」，選「加入專案」，選擇或輸入 workspace 路徑。
2. 新增專案預設為「未註冊」。只有你明確將狀態切換為「記錄中」，Work Intelligence 才會讀取該專案允許範圍內的 handoff、Git 或來源檔案並保存工作記錄。
3. 依[連接 Agent](agent-setup.md)註冊本機 MCP，並在 Agent 對話中確認可連線。
4. 開工前可請 Agent 查詢 Work Intelligence 的相關工作與 Knowledge；完成後請它保存本次工作。

`paused`、`ignored`、`unregistered` 專案不會被讀取或記錄。Agent 不能代替你把專案切換為「記錄中」。

### 永久刪除專案資料

在「專案 → 專案清單」點選專案旁的垃圾桶按鈕，閱讀刪除範圍並輸入完整專案名稱，才可確認永久刪除。WorkLog 會先建立並驗證一份完整 SQLite 備份；備份失敗時不會刪除。完成後會顯示備份檔名。

刪除會移除中央資料庫中該專案的工作記錄、handoff、Evidence、Knowledge、稽核與搜尋資料，以及引用目標 Session 的共享請求和報告。專案資料夾與檔案不會被刪除。刪除前備份是整份資料庫快照，並依手動備份的保留規則管理；它可透過 `pnpm db:restore <備份檔.sqlite>` 還原，但還原會取代目前整份資料庫。MCP 不提供專案刪除工具。

## 日常流程

- **開工前**：描述任務，請 Agent 查詢相關過往工作或指定檔案的紀錄；遇到錯誤時也可直接貼上錯誤訊息讓它檢索。
- **工作中**：照常使用 Agent。Work Intelligence 不會替 Agent 推測驗證結果，也不會自動把 Knowledge 候選寫成正式 Knowledge。
- **完成時**：請 Agent 保存這次工作。每筆 Session 會分開保存成果、範圍、決策、驗證與狀態／未結項。
- **回顧時**：到「工作歷程」搜尋 Session，或到「工作知識」檢視已接受的決策、模式、注意事項、流程與技能。

## 報告與 Knowledge

「工作報告」支援日、週、月、季、年與自訂日期區間；統計依已保存的 Session 計算，AI 整理會保留來源 Session。可以匯出 Markdown 或 JSON。若請 Agent 整理報告，Web 會在請求完成後更新結果。

「工作知識」只顯示明確提交並保存的 Knowledge。Agent 可以提出候選，但須由你接受（可先修改）後才會成為 Knowledge。Knowledge 可以編輯、封存、恢復及查看變更紀錄；封存不會刪除資料。

更完整的資料格式與搜尋行為見[架構與資料契約](architecture.md)及[MCP 工具參考](mcp-tools.md)。

## 備份、匯出與匯入

- API 啟動時會檢查每日自動備份，之後每小時檢查一次；依 server 本機日曆日每天最多一份，預設保留最近 14 份。資料庫有待套用 migration 時，程式會先額外建立標有目標 schema 版本的備份。
- 手動備份可在「專案 → 資料備份」選「立即備份」，或執行 `pnpm db:backup`。
- 資料庫維護會在執行 `VACUUM` 與重建搜尋索引前建立並驗證一份備份。請先停止 `pnpm start`，並關閉會啟動 MCP 的 Codex／Claude 對話，再執行 `pnpm db:maintain`。命令會先檢查資料庫完整性及獨佔鎖，之後整理 SQLite、更新統計資訊、重建搜尋索引；若無法取得鎖或備份失敗，會停止維護。完成或未完成的結果可由 `pnpm run doctor` 唯讀查看。
- 完整 SQLite 快照可在 Web 介面匯出，或使用 `pnpm db:export <檔案.sqlite>`。快照包含所有專案與工作記錄。
- 可攜式 JSON 支援單一或全部專案：`pnpm db:export --project <專案名稱或 id>`、`pnpm db:export --all`。在 Web 匯入或執行 `pnpm db:import <檔案.json> --dry-run`，先查看新增、略過、衝突及路徑轉換，再確認匯入。匯入不會覆寫既有資料；新專案會以暫停狀態加入。
- JSON 匯出未加密。SQLite 快照與備份也應視同包含私人工作記錄，請存放在可信任位置。

## 換電腦與還原

搬移整份資料前，先停止 Work Intelligence server，並關閉會啟動 MCP 的 Codex／Claude 對話，再從備份或舊電腦匯出完整 SQLite 檔案。在新電腦執行：

```sh
pnpm build
pnpm db:restore <匯出檔.sqlite> --remap-root <舊專案上層路徑>=<新專案路徑>
pnpm start
```

若專案路徑沒有改變，省略 `--remap-root`。可以重複指定多組路徑轉換。還原會檢查 SQLite 完整性與 schema 版本，並在取代目前資料前先備份目前資料庫；若偵測到資料庫仍被 server 或 Agent 開啟，會停止還原。完整選項見[REST API 文件](rest-api.md)與 README 的「備份與換電腦」。

## 更新 Work Intelligence

這一輪尚未建立 tag、release 或發行 workflow；目前請依你取得更新版本的方式更新專案原始碼。完成程式碼更新後，在專案根目錄執行：

```sh
pnpm install
pnpm build
pnpm start
```

若新版本需要升級資料庫，Work Intelligence 會在套用 migration 前自動備份。若資料庫 schema 比目前程式新，程式會拒絕開啟並要求先更新 Work Intelligence；不要手動刪除 migration 記錄或直接編輯 SQLite。MCP 工具更新後，也請重新啟動或重新連線 Agent，讓用戶端重新載入工具清單。

版本號與 schema 版本可由 `/api/health` 查看，UI 側欄也會顯示程式版本。變更摘要見 [CHANGELOG](../CHANGELOG.md)。
