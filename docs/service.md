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

## 查看狀態

```sh
pnpm service:status
pnpm run doctor
```

`service:status` 唯讀顯示服務管理器、安裝／執行／登入啟用狀態、設定檔、資料庫、備份目錄與日誌路徑。Web「系統狀態」也顯示相同資訊。這些檢查只讀服務設定並查詢作業系統，不會啟動、停止或修改服務。

## 移除

```sh
pnpm service:uninstall
```

移除前會要求確認。它會停止並移除 Work Intelligence 的服務註冊與服務設定檔；資料庫、備份、日誌及其目錄都會保留。這不會刪除 repo 或任何工作記錄。

## 各平台位置

| 平台 | 管理方式 | 使用者層級設定檔 | 日誌 |
| --- | --- | --- | --- |
| macOS | LaunchAgent，登入後啟動並在意外停止後重啟 | `~/Library/LaunchAgents/ai.workintelligence.server.plist` | `~/Library/Logs/Work Intelligence/server.log` |
| Windows | Task Scheduler 登入工作，使用目前登入者與最低權限 | `%LOCALAPPDATA%\Work Intelligence\service\work-intelligence.task.xml` | `%LOCALAPPDATA%\Work Intelligence\logs\server.log` |
| Linux | `systemd --user`，登入時啟動並在非預期停止後重啟 | `${XDG_CONFIG_HOME:-~/.config}/systemd/user/work-intelligence.service` | `${XDG_STATE_HOME:-~/.local/state}/work-intelligence/logs/server.log` |

服務設定內容在安裝時預覽，包含該機器的絕對路徑；分享前請先檢查並遮蔽個人資料夾名稱。

## 疑難排解

- **狀態是「無法判定」**：確認目前使用者的服務管理器可用，再執行 `pnpm service:status` 和 `pnpm run doctor`。Linux 請在已登入的使用者 session 中執行 `systemctl --user status work-intelligence.service`；macOS 可用 `launchctl print gui/$(id -u)/ai.workintelligence.server`；Windows 可在工作排程器查看 `Work Intelligence`。
- **已安裝但沒有執行**：查看上表的服務日誌。也可檢查預設連接埠 `3210` 是否被另一個 Work Intelligence 或其他程式占用；先停止衝突的程序，再執行 `pnpm service:install` 重新載入服務設定。
- **找不到 pnpm 或執行檔**：在安裝 pnpm 的終端機重新執行 `pnpm build` 與 `pnpm service:install`，並確認預覽列出的 Node.js、pnpm 與 repo 路徑存在。
- **不支援的作業系統**：登入自動啟動目前支援 macOS、Windows 與 Linux；其他平台仍可從終端機執行 `pnpm start`。

CI 只在暫存目錄產生設定檔並以假服務管理器驗證；不會安裝或啟動任何 OS 服務。Windows、macOS、Linux 的實機安裝仍需依 [發行驗收清單](release-checklist.md) 由使用者本人驗收。
