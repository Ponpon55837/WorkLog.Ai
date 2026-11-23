# 疑難排解

本頁先列桌面 App 的問題，再列命令列與開發者的問題。App 視窗的「診斷」分頁可以按「匯出診斷資訊…」，存成一個 JSON 檔（路徑已遮蔽，不含工作記錄內容）。回報問題時附上這個檔案即可。

## 桌面 App

### 安裝時出現 Gatekeeper 或 SmartScreen 提示

安裝檔未經簽署（macOS 為 ad-hoc 簽署，Windows 未簽署），這是已知的取捨。出現提示不代表檔案有問題。

- **macOS**：到「系統設定 → 隱私權與安全性」，在下方找到該 App 的提示後選擇允許開啟。
- **Windows**：SmartScreen 顯示「Windows 已保護你的電腦」時，選擇「其他資訊」，再選擇「仍要執行」。

開啟前可先依[使用手冊的核對步驟](user-guide.md#桌面-app-檢查更新)，用發行頁面的 `SHA256SUMS.txt` 核對安裝檔；核對不符時請刪除檔案並重新下載。安裝後你的資料會保留。

### 升級後狀態頁顯示「需要更新資料庫」

升級桌面 App 之後（例如 1.6.63 升到 1.6.64，資料庫結構 34 升到 35），App 自己的資料庫需要先更新才能使用。「狀態」分頁和「資料」分頁的資料庫卡片會寫「資料庫需要更新才能在這個版本使用，更新前會自動備份。」

按「先備份再更新資料庫」。App 會重新檢查檔案、在備份資料夾建立更新前備份、更新資料庫，然後啟動，不需要自己找檔案。這時「重試啟動」是次要按鈕，因為只重試不會更新資料庫。

- **資料庫在雲端同步資料夾、卸除式磁碟，或是硬連結**：這些位置不能直接更新，卡片不會提供「先備份再更新資料庫」，改為提供「複製到本機資料夾後更新」。按下後會先確認，再把資料庫複製到 App 的預設資料夾，更新複本並改用它；原本的檔案不會被改動。已經開著的 Agent 會繼續寫入原本的檔案，重新開啟 Agent 後才會改用新位置。
- **顯示「資料庫需要更新但沒有完成」**：沒有任何資料被改動。再按一次「先備份再更新資料庫」。
- **想回到舊版 App**：到「資料」分頁按「從備份還原」，選更新前備份。
- **顯示「版本不支援」**：資料庫是較新版本的 App 建立的，請先把 App 更新到最新版。
- 若要改用其他資料庫檔案，仍可按「選擇資料庫…」，再選「同意更新資料庫結構，使用這個資料庫並重試」。

**English summary.** After upgrading the desktop App (for example 1.6.63 to 1.6.64, schema 34 to 35), the Status tab and the Data tab show "Needs update": "The database needs an update before this version can use it. It is backed up automatically before the update." Press "Back up and update database". The App checks the file again, saves a pre-migration backup in the backups folder, updates the database and starts. "Retry start" is secondary because retrying alone cannot update.

- If the database is in a cloud sync folder, on a removable disk, or is a hard link, it cannot be updated in place. The card offers "Copy to a local folder and update" instead. After you confirm, the App copies the database to its default data folder, updates the copy and switches to it. The original file is not changed. Agents that are already open keep writing to the original until they are reopened.
- If the card says the update did not finish, nothing was changed. Press "Back up and update database" again.
- To go back to an older App, use the Data tab, "Restore from backup", and pick the pre-migration backup.
- "Unsupported version" means the database was made by a newer App. Update the App.

### 狀態頁出現「上次被中斷的操作」

上次執行時若被強制結束（例如斷電或系統當機），下次啟動時「狀態」分頁會顯示「上次被中斷的操作」，說明 App 已經做了什麼復原。按「知道了」即可關閉，不影響之後的操作。

### 連接埠被占用，狀態頁說明已改用「上次正常運作的連接埠」

設定的連接埠被其他程式占用時，App 會改用上次驗證過的連接埠啟動，並在「狀態」分頁說明。你的設定不會被改寫。原本的連接埠釋放後，重新啟動 App 就會再使用它。上次的連接埠也無法使用時，App 停在「狀態」分頁等你處理，資料不會被更動。

### 偵測到舊的登入服務也在使用同一份資料庫

如果曾在命令列安裝過登入服務，App 會提醒兩個後端同時使用同一份資料庫可能造成問題。在「狀態」分頁按「停用舊的登入服務…」可以停用它，資料庫與備份都會保留。細節見[登入自動啟動服務](service.md#改用桌面-app-時)。

### 還原前提示「請先關閉 Agent」

還原會取代目前的資料庫，Agent 還開著時可能仍在使用資料庫，所以 App 會拒絕開始。

1. 關閉所有會啟動 Work Intelligence MCP 的 Codex 或 Claude Code 對話。
2. 回到「資料」分頁，再按一次「還原這份備份…」。

還原沒有開始或失敗時，原本的資料庫不會被更動。

### 選取的備份檔被拒絕

App 在你確認還原之前就會檢查備份檔。以下檔案會被拒絕，並說明原因：來自較新版本的備份（請先更新 App）、不是 Work Intelligence 的資料庫檔案，或已損壞、無法讀取。被拒絕時目前的資料庫不會被更動，請改選其他備份。

### 換新電腦還原後，專案找不到

還原時，App 會列出備份記錄的專案資料夾中，這台電腦上不存在的資料夾，並請你指定它們現在的位置。若你保留原路徑或取消，那些專案會保留舊路徑，之後可以在專案頁逐一重新指定。選擇資料夾時，App 只檢查資料夾是否存在，不會讀取資料夾內的內容。

### 整理資料庫沒有開始

整理資料庫需要獨占資料庫。以下情況會拒絕開始，請等它們結束，或關閉 Agent 對話後再試：

- 有 Agent 連線中（Agent 對話仍開著會啟動 MCP）；
- 匯入、備份或還原正在進行；
- 另一個操作（例如更換資料庫）正在進行。

整理前 App 會先自動備份。若整理失敗，備份仍保留在備份資料夾。

### 更換備份位置後，舊備份不見了

更換備份位置只影響之後建立的備份。既有的備份不會被移動，仍留在原來的資料夾。若要找回它們，請到原資料夾查看；App 的「設定」分頁會顯示目前的備份位置。

### Agent 卡片顯示「需要重新連線」

升級 App 後，Agent 需要重新連線才會載入新版的 MCP 工具。關閉並重新開啟該 Agent 的對話即可。

### Agent 卡片顯示「設定衝突」

App 無法安全地改寫現有的設定。卡片會用白話說明衝突的原因，常見情況與處理方式如下：

- **有手動加入的 Work Intelligence 註冊**：按「改由桌面 App 管理…」。App 會先顯示差異，確認後把註冊改由 App 管理；復原後檔案會與接手前完全相同。
- **註冊指向另一份資料庫**：App 不會悄悄換成另一份資料庫。卡片會列出那份資料庫，並提供「改用這份資料庫」，由你決定。
- **設定檔已被其他工具改寫**：App 不會覆蓋不認得的內容。依卡片說明手動整理該段設定後，在 App 的 Agent 分頁按「預覽變更」，再按「套用變更」。

### Agent 卡片顯示「已設定，待確認」

App 已寫入設定，但 Agent 還沒有實際使用過 MCP 工具。在 Agent 對話中問一句「這個專案有在 Work Intelligence 記錄嗎？」，之後卡片會更新為「已連線」。

### 系統狀態的「MCP 連線」是 0，或數字比預期少

Web 介面的「系統狀態」頁會說明為什麼是 0：

- **升級前就開著的 Agent 對話不會被計入。** 它們仍使用舊版 MCP。關閉並重新開啟該 Agent 對話，數字就會更新。
- **Agent 已斷線**：重新開啟 Agent 對話。
- **Agent 的 MCP 無法寫入連線記錄資料夾**：頁面會說明；請在「診斷」分頁匯出診斷資訊並回報。
- **Agent 的 MCP 是舊版**：重新開啟 Agent 讓它重新連線；若仍是舊版，請在「Agent」分頁重新設定。

### 檢查更新顯示「無法連線到 GitHub」或逾時

App 只在按下「檢查更新」時連線到 GitHub。離線、網路被防火牆或 proxy 擋住，或連線逾時（10 秒）時，會顯示「無法連線到 GitHub，請確認網路後再試一次。」或「連線逾時，請確認網路後再試一次。」

1. 確認電腦可以上網，並能在瀏覽器開啟發行頁面（「開啟發行頁面」按鈕也需要瀏覽器能連到 GitHub）。
2. 若使用公司網路或 proxy，確認允許連到 `api.github.com`。
3. 不影響已安裝的 App 與資料。網路恢復後再按一次「檢查更新」即可。

### 檢查更新顯示「與 GitHub 的安全連線失敗」

連線到 GitHub 時憑證不受信任，或 TLS 交握失敗，會顯示「與 GitHub 的安全連線失敗。可能是代理伺服器或資安軟體攔截了連線，請檢查後再試一次。」常見原因是公司 proxy 或資安軟體檢查加密連線，或電腦的日期與時間不正確。

1. 確認電腦的日期與時間正確。
2. 若使用會檢查加密連線的 proxy 或資安軟體，請管理者允許 `api.github.com`，或確認它的憑證已安裝在系統中。
3. App 不會略過憑證檢查。仍無法連線時，可按「開啟發行頁面」，改用瀏覽器查看。

### 檢查更新顯示 GitHub 暫時限制查詢次數

GitHub 對這類查詢有配額。超過配額或被限制時，App 會顯示可再試的時間；若無法取得時間，則顯示「請稍後再試」。App 不會自動重試。

### 檢查更新後沒有提供安裝檔

安裝檔只提供 Windows x64 與 macOS（arm64、x64）。在其他平台（例如 Windows arm64、Linux）會顯示「這個平台沒有提供安裝檔，請到發行頁面查看。」請按「開啟發行頁面」，從該版本的檔案清單找到適用的檔案。

## Web 與連線

### Web 顯示「無法連線到 Work Intelligence API」

桌面 App 管理的服務停止，或 App 尚未啟動時，Web 無法連到本機服務。連線恢復後，頁面會自動重新載入目前資料。

1. 確認桌面 App 正在執行，並查看「狀態」分頁的服務狀態。
2. 若「狀態」分頁提示連接埠問題，請依上一節處理。
3. 仍無法連線時，請到「診斷」分頁按「匯出診斷資訊…」，並附在回報中。

## Agent 與 MCP（命令列與開發者）

> **對象：使用命令列或開發模式的人。** 一般使用者可以忽略本節，所有設定都可以在 App 的 Agent 分頁完成。

### 執行環境檢查

```bash
pnpm check
```

`pnpm check` 會唯讀地檢查 Node.js、pnpm、build 產物、資料庫、MCP 註冊、skill 副本與保存提醒 hook，並列出修正方式。請使用 `pnpm check`；不要使用 `pnpm doctor`，pnpm 11 會把它當成套件管理器自己的命令。

### 連接埠被占用（`pnpm start`）

`pnpm start` 遇到連接埠被占用時會顯示「127.0.0.1:<port> 已被占用，Work Intelligence 沒有啟動」並結束。最常見的原因是另一個終端機已經在執行 Work Intelligence：先開啟 <http://127.0.0.1:3210> 確認。若不是 Work Intelligence，請停止占用的程式，或設定 `WORK_INTELLIGENCE_PORT` 為未使用的連接埠再啟動。Web 與 API 使用同一個設定值。

### MCP 沒有載入新工具

MCP 的工具清單在 Agent 建立 stdio 連線時載入。更新後：

1. 在 checkout 目錄執行 `pnpm build`。
2. 關閉並重新開啟 Agent 對話，或重新連線 `work-intelligence` MCP。
3. Codex 可執行 `codex mcp list`、`codex mcp get work-intelligence`；Claude Code 可執行 `claude mcp list`、`claude mcp get work-intelligence`。

若設定路徑或啟動命令已改變，在 App 的 Agent 分頁按「預覽變更」，確認後按「套用變更」即可。

### 保存提醒 hook 沒有觸發

保存提醒 hook 是使用者層級的全域設定，只作用於記錄中的專案。確認：

1. checkout 目錄已執行 `pnpm build`，所需的 `apps/mcp/dist/` 腳本存在。
2. 設定指向這個 checkout 腳本的**絕對路徑**，並位於全域設定檔（Claude Code 的 `~/.claude/settings.json`，Codex 的 `~/.codex/hooks.json`）。
3. Codex 請輸入 `/hooks`，確認 hook 已載入並完成信任；未信任的 hook 會被略過。
4. 確認 Agent 的 `PATH` 找得到 `node`；找不到時，把 hook 指令中的 `node` 改成 Node.js 執行檔的絕對路徑。
5. 出現 `hook timed out` 時，把 hook 的 `timeout` 調成 `10`。Windows 上防毒掃描可能讓每次啟動 `node` 超過 3 秒。
6. 只用 Bash 改檔不會觸發 Codex 的改檔標記。

hook 只在 Work Intelligence 正在記錄的專案中作用，讀不到狀態時會放行。`pnpm check` 只讀取全域設定與 hook 檔案，不會修改任何 Agent 設定。

## 資料與時間

### 工作記錄的時間不對

常見原因是 Agent 自己估計時間，或把本地時間加上 `Z` 當成 UTC（台北時間會差 8 小時）。

- 新的記錄：`completedAt` 晚於伺服器時間超過 5 分鐘會被拒絕；看起來像估計的值會在結果中附上 `timestampWarnings`。
- 修正既有記錄：請 Agent 用 `work_update_session_metadata` 的 `startedAt`、`completedAt` 填入有依據的時間，並帶時區（例如 `+08:00`）。不需要作廢再重建。

### 資料庫忙碌、唯讀或磁碟已滿

這三種錯誤都表示這次寫入沒有保存、已保存的資料沒有變更，不需要從備份還原。

| 代碼 | 原因 | 處理方式 |
| --- | --- | --- |
| `database_busy` | 另一個程序（另一個 Agent 的 MCP 或維護）正在寫入 | 稍候再試；持續發生時在「診斷」分頁查看 |
| `database_read_only` | 資料庫檔案、資料夾或磁碟目前唯讀，或被同步工具鎖定 | 讓檔案與資料夾恢復可寫入後重試；讀取仍可使用 |
| `database_disk_full` | 資料庫所在磁碟沒有空間 | 釋放空間後重試；也可以到 Web 的「專案 → 資料備份」處理較舊的備份 |

### 匯入有衝突

先在 Web 的「專案」頁查看匯入預覽。匯入會新增缺少的資料、略過完全相同的項目，並依原因彙總衝突。預設「只新增」不覆寫既有資料；兩台電腦都在記錄同一專案時，請選「較新者優先」。衝突類別「匯入檔缺少上層資料」表示檔案被手動刪改過，請從來源電腦重新匯出完整檔案。

### 匯入時顯示「無法建立並檢查安全備份」

匯入前必須先寫入並檢查一份備份；寫不出來時匯入不會執行，資料沒有變更。請確認備份資料夾存在、可寫入，且磁碟有足夠空間（約等於資料庫大小），再重試。

### 匯入、預覽或匯出時顯示 `backup_worker_out_of_memory`

背景工作處理的資料超過上限。這次請求沒有變更任何資料，同一份檔案重試也不會成功。請改成一次一個專案分批匯出或匯入。

## 命令列與開發者

> **對象：使用命令列、CLI 或開發模式的人。**

### Windows 的資料庫路徑錯誤（反斜線）

**症狀**：資料看起來「不見了」，或 checkout 目錄多出一個名稱像 `UsersyouDesktop…work-intelligence.sqlite` 的檔案。

**原因**：在 Git Bash 設定 `WORK_INTELLIGENCE_DB=C:\Users\example\data.sqlite` 時，反斜線被當成跳脫字元吃掉，變成 `C:Usersexampledata.sqlite`，Windows 會把它當成磁碟相對路徑。

**修正**：

- Git Bash，單引號包住完整路徑：`WORK_INTELLIGENCE_DB='C:\Users\example\data.sqlite'`
- Git Bash，改用正斜線：`WORK_INTELLIGENCE_DB=C:/Users/example/data.sqlite`
- PowerShell：`$env:WORK_INTELLIGENCE_DB = 'C:\Users\example\data.sqlite'`

現在的版本遇到磁碟相對路徑會拒絕啟動並說明原因，不會悄悄建立新檔。`pnpm check` 會列出 checkout 頂層的 `*.sqlite` 檔名（唯讀）。

### 還原或維護時資料庫仍被開著（命令列）

`pnpm db:restore` 與 `pnpm db:maintain` 需要獨占資料庫。請先停止 `pnpm start` 或 `pnpm dev`，關閉會啟動 `work-intelligence` MCP 的 Agent 對話，等待 Node 程序退出後再重試。CLI 沒有 `--force` 略過這項檢查，也不要手動覆蓋 SQLite 檔案。

### `pnpm db:restore` 顯示 `RESTORE_VERIFY_FAILED`

備份在取代資料庫之前未通過完整性檢查。目前的資料庫沒有被取代，已保存的資料都還在。請改用其他備份檔再執行一次。

### 更新後 API 或 MCP 顯示 `server_restart_required`

另一個程序把資料庫升級到較新的 schema 後，舊的 API server 會拒絕寫入。重新啟動 server 即可，不需要還原。

### 開發模式看到 `Unexpected end of JSON input`

較舊的開發 server 在 Vite／API 重啟期間，proxy 可能回傳空的錯誤本文。請更新程式碼、執行 `pnpm build`，重新啟動 `pnpm dev` 後重試；一般使用可改用 `pnpm start`。

## 仍然無法解決

到桌面 App 的「診斷」分頁按「匯出診斷資訊…」，並附上發生時間與操作步驟。分享前請檢查內容，移除你不希望公開的專案名稱或路徑。
