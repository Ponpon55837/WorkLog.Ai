# Work Intelligence

[English](README.md) | **繁體中文**

**給開發者的本機優先工作記憶。** Codex 或 Claude Code 這類 Agent 完成一段工作後，會把做了什麼、改了哪些檔案、驗證結果如何，寫進你電腦上的一個 SQLite 檔案。你在桌面 App 裡回顧這些紀錄；開始新工作或遇到錯誤時，Agent 也能從同一份紀錄查出過去的工作與 Knowledge。

- **預設什麼都不記錄。** 只有你設為「記錄中」的專案會被讀取與保存。
- **資料留在你的電腦。** App 內的本機服務只聽 `127.0.0.1`，不會把資料傳到其他地方。
- **可以追溯。** 每一筆摘要都連回它的 Session、檔案與證據。
- **備份由你掌控。** 自動與手動備份、在 App 內還原，以及整理資料庫的工具。

---

## 目錄

- [下載與安裝](#下載與安裝)
- [第一次設定](#第一次設定)
- [用 App 設定 Agent](#用-app-設定-agent)
- [日常使用](#日常使用)
- [資料、備份與換新電腦](#資料備份與換新電腦)
- [可以調整的設定](#可以調整的設定)
- [安全與隱私](#安全與隱私)
- [給開發者與命令列使用者](#給開發者與命令列使用者)
- [文件](#文件)
- [授權](#授權)

## 下載與安裝

Work Intelligence 是桌面 App，提供 **Windows 11（x64）** 與 **macOS（Apple Silicon 與 Intel）** 版本。安裝檔已內含 App 需要的一切，包括 Node.js，你不需要另外安裝。

1. 到 [GitHub Releases](https://github.com/Ponpon55837/WorkLog.Ai/releases) 頁面，下載最新版本中適合你系統的安裝檔：
   - Windows：`Work-Intelligence-<版本>-win-x64-setup.exe`
   - macOS：`Work-Intelligence-<版本>-mac-arm64.dmg`（Apple Silicon）或 `Work-Intelligence-<版本>-mac-x64.dmg`（Intel）
2. 執行安裝檔，開啟 **Work Intelligence**。

安裝檔**沒有程式碼簽章**，第一次開啟時系統可能會跳出警告。這不代表檔案有問題。

- **macOS**：若 Gatekeeper 阻擋開啟，請到「系統設定 → 隱私權與安全性」，在下方找到 Work Intelligence 的提示，選擇仍要開啟。
- **Windows**：若 SmartScreen 顯示「Windows 已保護你的電腦」，請選擇「其他資訊」，再選擇「仍要執行」。

要確認下載的檔案完整，可以把它的 SHA-256 與同一個發行頁面的 `SHA256SUMS.txt` 比對。步驟見[使用手冊](docs/user-guide.md#桌面-app-檢查更新)。

App 只在你於「設定」分頁按下「檢查更新」時才會查詢新版，不會在背景檢查，也不會替你安裝更新。

## 第一次設定

1. 開啟 App。第一次執行時，選擇「使用預設設定開始」。若 App 找到既有的資料庫，可以改選「沿用這份資料」。
2. 進入「專案」，按「加入專案」，選擇要記錄的資料夾。
3. 把專案狀態設為「記錄中」。新加入的專案預設是「未註冊」，Agent 無法替你切換。
4. 依下一節設定 Agent，然後在 Codex 或 Claude Code 開新的對話；工作完成時請 Agent 保存這次工作。

Web 儀表板會列出一份簡短的檢查清單，直到你有一個記錄中的專案與一筆保存的 Session 為止。

## 用 App 設定 Agent

在 App 中打開「Agent」分頁（首次執行頁也有「設定 Agent」按鈕）。分頁會為 Codex 與 Claude Code 各顯示一張卡片。

- **先預覽。** 「預覽變更」會列出 App 將會修改的每個檔案，確認之前不會寫入任何東西。
- **套用與復原。** 「套用變更」寫入剛才預覽的那份計畫，並記錄下來。「復原上次變更」會把檔案還原成套用前的樣子。
- **測試連線。** 卡片可以測試 Work Intelligence MCP 伺服器能否啟動並回應。
- **已經手動註冊過？** 如果你自己加過 Work Intelligence 的設定，卡片會顯示「由其他方式管理」並提供「改由桌面 App 管理…」。預覽後 App 會接手這份註冊；復原後檔案會與接手前完全相同。
- **移除。** 「移除 Agent 設定」使用與設定相同的預覽與確認步驟。

每張卡片都會顯示 Agent 的連線狀態：

- **已連線**：Agent 已經使用過 Work Intelligence 的工具。
- **已設定，待確認**：設定已寫入，但 Agent 還沒有使用過工具。對一個記錄中的專案問一句話即可確認。
- **需要重新連線**：Agent 載入的是舊版伺服器。關閉該 Agent 的對話後重新開啟。
- **設定衝突**：App 無法安全地改寫現有設定。卡片會說明原因與處理方式。

Web 介面的「系統狀態」頁會顯示 **MCP 連線**。如果數字是 0 或比預期少，頁面會說明原因。升級後常見的情況是：**升級前就已經開著的 Agent 對話仍在使用舊版 MCP 伺服器，不會被計入。** 關閉並重新開啟那些對話，數字就會更新。

## 日常使用

你用自然語言和 Agent 說話，工具呼叫由 Agent 處理。

| 想做的事 | 對 Agent 說 |
|---|---|
| 確認專案有沒有被記錄 | 「這個專案有在 Work Intelligence 記錄嗎？」 |
| 保存剛完成的工作 | 「完成了，請把這次工作記錄到 Work Intelligence。」未記錄的專案會被略過。 |
| 查過去的工作或錯誤 | 「我們之前處理過報表時區的問題嗎？」或直接貼上錯誤訊息。 |
| 回復專案脈絡 | 「先在 Work Intelligence 查這個專案最近發生了什麼。」 |
| 產生報告 | 「幫我整理這週的 Work Intelligence 報告。」 |
| 整理未結項 | 「請整理這個專案的未結項。」 |

大多數事也可以直接在 App 裡做：

- **工作歷程**：搜尋 Session、編輯摘要、連結或作廢 Session、檢視未結項。
- **工作報告**：日、週、月、季、年與自訂區間的報告，可匯出 Markdown 或 JSON。
- **工作知識**：已接受的 Knowledge、知識頁與候選。候選只有在你接受後才會成為 Knowledge。
- **專案**：加入、記錄、暫停或刪除專案。

每筆 Session 都有一句話摘要，以及五個固定段落：**成果、範圍、決策、驗證，以及狀態與未結項**。驗證有五種狀態：通過、失敗、進行中、未執行、未回報。開始工作本身不代表通過。

## 資料、備份與換新電腦

所有資料都在同一個 SQLite 資料庫裡。App 的**「資料」分頁**負責還原與資料庫維護；Web 的**「專案」頁**負責備份清單、手動備份、匯出與匯入。

- **立即備份**（Web 的「專案 → 資料備份」）會建立一份手動備份。自動備份每天執行一次，App 會保留每種最近的幾份。
- **從備份還原**（App 的「資料」分頁）會用你選的備份取代資料庫。開始前，App 會請你先關閉 Agent 對話，並先備份目前的資料。備份沒有通過檢查時會被拒絕，目前的資料不會被更動。
- **換新電腦。** 在新電腦上還原時，若備份記錄的專案資料夾在這台電腦上不存在，App 會問你它們現在在哪裡。選一個資料夾，App 會找出底下同名的專案資料夾並對應路徑。你可以重複選擇資料夾、讓其餘專案保留原路徑，或取消。
- **整理資料庫…**（App 的「資料」分頁）會先備份，然後檢查完整性、壓縮資料庫檔案、重建搜尋索引，並顯示回收了多少空間。**檢查完整性**只讀取，不改任何東西。當有 Agent 連線、或匯入、備份、還原進行中時，整理不會開始。
- **匯出與匯入**以 JSON 搬移專案；寫入前會先預覽。匯出檔沒有加密，請妥善保存。
- **刪除專案**前會先建立完整備份。刪除紀錄只保留時間、專案 ID 與筆數。在備份被輪替掉或你自行刪除之前，較舊的備份仍然包含該專案。

備份與匯出都沒有加密，請用可信任的方式保存與搬移。

## 可以調整的設定

「設定」分頁包含：

- **登入時自動啟動**。一個開關，可以隨時開關（Windows 與 macOS）。開關顯示系統實際的狀態；若系統的啟動項目被改過，或 macOS 還在等待你核准，卡片會說明。
- **備份位置**。可以改用其他資料夾。App 會確認資料夾可寫入；網路磁碟不能使用，外接磁碟或雲端同步資料夾會先請你確認。已存在的備份不會被移動。
- **更新**。需要時手動檢查新版。

如果你設定的連接埠已被占用，App 會改用上次能正常運作的連接埠啟動，並在「狀態」分頁說明。你的設定不會被改掉。

「診斷」分頁會先顯示預覽，再按「匯出診斷資訊…」存成一個 JSON 檔，可以附在問題回報中。檔案會遮蔽檔案路徑、授權碼、權杖與電子郵件，不包含工作記錄內容；App 不會自動上傳。

## 安全與隱私

- 本機服務只聽 `127.0.0.1`，並檢查 `Host` 與 `Origin` 標頭。
- 寫入文字前會檢查已知格式的憑證；包在 `<private>…</private>` 裡的內容會被換成 `[REDACTED:private_block]`。
- 備份與匯出沒有加密，請妥善保管。
- Agent 使用 Work Intelligence 時，Agent 所在的 host 可能會依其自身政策，把工具結果傳給遠端模型。
- 成功的 MCP 讀取只會在本機記錄 ID 與筆數，不記錄查詢內容或紀錄內容。

威脅模型與回報安全問題的方式見 [SECURITY.md](SECURITY.md)。

## 給開發者與命令列使用者

> **對象：開發者與習慣在終端機工作的人。** 本節所有內容都是選用的。一般使用時，桌面 App 已經能完成全部功能。

從 checkout 執行需要 Node.js 22.16 以上的 22.x，或 24 以上（不支援 23.x），以及 pnpm 11.16 以上。

```bash
git clone https://github.com/Ponpon55837/WorkLog.Ai && cd WorkLog.Ai
pnpm bootstrap
pnpm start
```

`pnpm bootstrap` 會安裝、建置，預覽 Agent 與登入自動啟動的設定，並在寫入全域設定前要求確認。`pnpm start` 會在 <http://127.0.0.1:3210> 提供 Web 介面與 API。`pnpm check` 執行唯讀的環境診斷。

命令列工具、獨立套件與 plugin 安裝說明在以下文件：

- [命令列與開發流程](docs/user-guide.md#給開發者與命令列使用者安裝與正式模式)
- [Agent 設定與保存提醒 hook](docs/agent-setup.md)
- [Claude Code 與 Codex plugin](docs/plugins.md)
- [獨立套件（不需要 checkout）](docs/standalone.md)
- [命令列設定登入自動啟動](docs/service.md)

常用環境變數：

| 變數 | 用途 |
|---|---|
| `WORK_INTELLIGENCE_DB` | 資料庫位置。相對路徑以 repo 根目錄為基準。 |
| `WORK_INTELLIGENCE_PORT` | 本機連接埠，預設 `3210`。 |
| `WORK_INTELLIGENCE_BACKUP_DIR` | 備份資料夾，預設為資料庫旁的 `backups/`。 |
| `WORK_INTELLIGENCE_BACKUP=off` | 停用每日自動備份。 |

開發指令：

```bash
pnpm dev                 # Web 使用 5966（Vite），API 使用 3210
pnpm build               # 正式建置
pnpm test                # lint、格式檢查與單元測試
pnpm typecheck           # packages、Vue 與 E2E 的型別
pnpm test:e2e            # build 後執行 Playwright 端對端測試
```

目錄結構：

```text
apps/
  desktop/     桌面 App（Electron 外殼與安裝檔）
  web/         Vue 3 + Vite Web 介面
  server/      REST API、正式模式靜態檔、CLI（db:*）與診斷
  mcp/         MCP stdio 伺服器、Agent 連線用的 launcher，以及保存提醒 hook
packages/
  core/、schema/、storage/、project-policy/、shared/、desktop-core/、agent-setup/、ui-tokens/
tests/         單元、整合與 E2E 測試
docs/          使用手冊、發行說明與設計紀錄
```

## 文件

| 文件 | 內容 |
|---|---|
| [docs/user-guide.md](docs/user-guide.md) | 日常使用、報告、Knowledge、備份、換電腦與更新 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 桌面 App 與命令列的常見問題 |
| [docs/agent-setup.md](docs/agent-setup.md) | 用 App 設定 Agent、Agent 分頁與保存提醒 hook |
| [docs/service.md](docs/service.md) | 登入自動啟動 |
| [docs/standalone.md](docs/standalone.md) | 給命令列使用者的獨立套件 |
| [docs/release.md](docs/release.md) | 發行與升級（給維護者） |
| [docs/plugins.md](docs/plugins.md) | Claude Code 與 Codex plugin |
| [docs/mcp-tools.md](docs/mcp-tools.md) | MCP 工具、欄位與政策行為 |
| [docs/rest-api.md](docs/rest-api.md) | REST 端點與錯誤代碼 |
| [docs/architecture.md](docs/architecture.md) | 資料契約、一致性與記錄政策 |
| [docs/status.md](docs/status.md) | 目前狀態與未結項 |
| [CHANGELOG.md](CHANGELOG.md)、[docs/releases/](docs/releases/) | 版本紀錄與各版更新說明 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 開發流程與 PR 規則 |
| [SECURITY.md](SECURITY.md) | 威脅模型與私下回報安全問題的方式 |

## 授權

[MIT](LICENSE)
