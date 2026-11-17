# 登入自動啟動服務

Work Intelligence 可在目前使用者登入後自動執行正式模式 `pnpm start`，並讓本機 Dashboard 與 REST API 共用同一個資料庫。服務是選用功能；一般使用仍可在終端機執行 `pnpm start`。

## 安裝前

在 WorkLog.Ai 專案根目錄安裝依賴並建立正式版：

```sh
pnpm install
pnpm build
pnpm service:install
```

`service:install` 會先顯示將寫入的服務設定檔完整路徑與內容、會建立的目錄、Node.js／pnpm 執行路徑、專案根目錄、資料庫、備份與日誌位置。只有互動終端輸入 `y` 或 `yes` 才會寫入並啟動；其他輸入、EOF 或非互動終端都會取消且不建立目錄。安裝只作用於目前使用者，不需要管理員權限。

服務使用目前工作目錄中的專案與 production build。預設共用 `data/work-intelligence.sqlite`，備份放在同一資料夾下的 `backups/`。如果安裝時設定 `WORK_INTELLIGENCE_DB` 或 `WORK_INTELLIGENCE_BACKUP_DIR`，預覽會顯示解析後的完整路徑，服務會沿用該資料庫與備份位置。Web、MCP、CLI 與自動啟動服務因此可共用同一份記錄。

安裝時會保存當下找到的 Node.js 與 pnpm 絕對路徑。若搬移 repo、更新 Node.js／pnpm 安裝位置，或更改資料庫環境變數，請重新執行 `pnpm service:install` 並確認新的預覽。

## 更新後重啟

```sh
pnpm service:restart
```

`git pull` 並執行 `pnpm bootstrap`（或 `pnpm build`）之後，用 `service:restart` 讓新版生效。它不改寫服務設定，只停止舊的 server 再啟動，並等待 `/api/health` 回報這個 checkout 的版本；30 秒內沒有回應、或回報的版本不同時會以錯誤結束並指出日誌位置。`pnpm bootstrap` 偵測到服務已安裝時只會提醒，不會自動重啟。

Windows 的工作排程器「結束」只會停止工作本身的 conhost，底下的 service runner、pnpm 與 server 仍會占用連接埠，新版因此無法啟動、舊版繼續服務。`service:restart`、`service:install` 與 `service:uninstall` 停止工作後，會另外結束這個 repo 的 `scripts/service-runner.mjs` 程序樹，只比對這個 repo 的 runner 路徑，不會動到手動執行的 `pnpm start`。

## 查看狀態

```sh
pnpm service:status
pnpm check
```

`service:status` 唯讀顯示服務管理器、安裝／執行／登入啟用狀態、設定檔、資料庫、備份目錄與日誌路徑。Web「系統狀態」也顯示相同資訊。這些檢查只讀服務設定並查詢作業系統，不會啟動、停止或修改服務。

## 移除

```sh
pnpm service:uninstall
```

移除前會要求確認。它會停止並移除 Work Intelligence 的服務註冊與服務設定檔；資料庫、備份、日誌及其目錄都會保留。這不會刪除 repo 或任何工作記錄。

### 改用桌面 App 時

桌面 App 會以唯讀方式偵測這個登入服務：

- **警告**：服務可能使用同一個資料庫時，首次執行頁、修復視窗與 Web「系統狀態」頁會顯示「偵測到舊的登入服務（pnpm bootstrap）也在使用這份資料庫；同時執行兩個後端可能造成問題」，並附上可複製的移除指令。
- **移除方式**：在 checkout 目錄執行上面的 `pnpm service:uninstall`。不知道 checkout 時，畫面上會附作業系統的移除指令。
- **服務正在執行**：App 不會在同一個資料庫上自行啟動後端，要按「仍要啟動」並再次確認；這個選擇只在 App 執行期間有效。
- **服務沒有執行、但會在登入時啟動**：App 在登入時於背景啟動的那一次不會啟動後端，工作列會顯示「偵測到舊的登入服務也使用這份資料庫，未自動啟動」，並提供「仍要啟動」與「停用舊的登入服務…」；手動開啟 App 則照常啟動，但持續顯示警告。
- **服務已停用或已移除**：App 照常啟動。
- **連接埠衝突**：連接埠被這個服務占用時，App 會直接說明。
- **在 App 內停用**：辨識得出的服務（內容與 `pnpm service:install` 寫入的一致，且知道 checkout）可以在卡片上按「停用舊的登入服務…」：
  - 先預覽，再以系統對話框確認；
  - 步驟與 `pnpm service:uninstall` 相同，資料庫與備份都會保留；
  - Windows 會立即結束正在執行的舊服務，只結束這個 checkout 的 runner 程序樹；
  - 舊服務看起來正在匯入或備份時會先提醒；
  - 停用後，App 會先以唯讀方式檢查它的資料庫；
  - 停用後不會自行啟動，手動開啟的 App 會提供「立即啟動」。
- **不會自動移除**：沒有按下並確認「停用舊的登入服務…」時，App 不會停止、修改或移除這個服務。

## 各平台位置

| 平台 | 管理方式 | 使用者層級設定檔 | 日誌 |
| --- | --- | --- | --- |
| macOS | LaunchAgent，登入後啟動並在意外停止後重啟 | `~/Library/LaunchAgents/ai.workintelligence.server.plist` | `~/Library/Logs/Work Intelligence/server.log` |
| Windows | Task Scheduler 登入工作，使用目前登入者與最低權限 | `%LOCALAPPDATA%\Work Intelligence\service\work-intelligence.task.xml` | `%LOCALAPPDATA%\Work Intelligence\logs\server.log` |
| Linux | `systemd --user`，登入時啟動並在非預期停止後重啟 | `${XDG_CONFIG_HOME:-~/.config}/systemd/user/work-intelligence.service` | `${XDG_STATE_HOME:-~/.local/state}/work-intelligence/logs/server.log` |

服務設定內容在安裝時預覽，包含該機器的絕對路徑；分享前請先檢查並遮蔽個人資料夾名稱。

## 疑難排解

- **狀態是「無法判定」**：確認目前使用者的服務管理器可用，再執行 `pnpm service:status` 和 `pnpm check`。Linux 請在已登入的使用者 session 中執行 `systemctl --user status work-intelligence.service`；macOS 可用 `launchctl print gui/$(id -u)/ai.workintelligence.server`；Windows 可在工作排程器查看 `Work Intelligence`。
- **已安裝但沒有執行**：查看上表的服務日誌。也可檢查預設連接埠 `3210` 是否被另一個 Work Intelligence 或其他程式占用；先停止衝突的程序，再執行 `pnpm service:restart`。
- **找不到 pnpm 或執行檔**：在安裝 pnpm 的終端機重新執行 `pnpm build` 與 `pnpm service:install`，並確認預覽列出的 Node.js、pnpm 與 repo 路徑存在。
- **不支援的作業系統**：登入自動啟動目前支援 macOS、Windows 與 Linux；其他平台仍可從終端機執行 `pnpm start`。

CI 只在暫存目錄產生設定檔並以假服務管理器驗證；不會安裝或啟動任何 OS 服務。Windows、macOS、Linux 的實機安裝仍需依 [發行驗收清單](release-checklist.md) 由使用者本人驗收。
