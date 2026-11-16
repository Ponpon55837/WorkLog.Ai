# Work Intelligence 桌面版 V1：正式設計規劃與全面風險盤查（R3）

**狀態：工程實作前設計基線（未通過實機驗收）；修訂日期：2026-11-15。文件版本：R3。** 本文件供產品、實作、安全與發行審查使用。除特別註明「現況已確認」的部分，流程、功能與門檻仍為**待實作／待驗證的要求**。


## 執行摘要與決策結論

**決策：有條件採用原架構，立即開始階段 0／階段 1 的可驗證工程工作；不得直接整包交付完整桌面版實作，也不得將本稿視為功能已完成。** Electron + 既有 Vue Dashboard + 獨立標準 Node runtime + SQLite + 既有 MCP/CLI 是合理的方向。桌面版負責安裝、服務、整合和更新的使用者體驗，不重新發明工作記錄與備份核心。

本次根據原始規劃、WorkLog.Ai 在審查基準 commit `7723b72ace798476bc347ca99ca90503980759d2` 的原始碼，以及外部公開實作與官方文件，確認了既有能力及實作差距。**共盤查 34 項設計風險：15 項 P0、17 項 P1、2 項 P2。** 數字代表尚待防範與驗證的風險項目，**不代表已發現 34 個程式 bug**。

### 五個必須先鎖定的跨程式契約

| 優先級 | 契約 | 完成條件（摘要） |
|---|---|---|
| P0 | DB 來源與 schema 相容 | 不開錯庫；舊 MCP 長連線在不相容 migration/restore 時不會繼續寫入；備份可還原 |
| P0 | 服務管理者與中斷接管 | 不 kill 無法辨識的程序；沒有第二個受管理 listener；接管失敗可查、可修復 |
| P0 | 固定 Agent launcher 與 Node runtime | 不依賴系統 Node／Electron GUI；Windows 鎖檔與更新切換不中斷現有工作 |
| P0 | Web 到桌面管理的安全邊界 | 不能僅依賴 loopback、CORS、Origin；有能力授權、私有 IPC 與高風險本機確認 |
| P0 | 可信更新與修復 | 鎖工具版本與簽署機制；正式安裝包 N→N+1 實測；DB 變更不可盲目回退 |

### 發行策略與工程順序

**執行順序：** 階段 0「契約／測試基座」→ 階段 1「無系統 Node 的封裝原型」→ 階段 2「最小桌面管理與修復」→ 階段 3「Agent 整合」→ 階段 4「既有服務交接」→ 階段 5「可信更新及 DB 維護」→ 階段 6「逐平台發行驗收」。已安裝的舊 checkout、standalone、plugin、MCPB 均不應因新桌面版而被強制改動。

**決策尚未完成：** 首發 OS 與簽章能力、Electron／Node／updater 實際鎖定版本、SQLite bundled 版本及 WAL 修補證據、跨程序 schema 屏障方案、OS 使用者間 API 存取政策。這些是開發起點或發行前置條件，不能在 UI 文案中當作已支援項目。

**驗收原則：** 只有通過真實 OS、真實 Agent 宿主、實際簽章安裝包、資料備份復原和安全回歸測試的功能，才可以宣稱支援；試作或單元測試通過不得等同公開發行完成。

---

## 0. 審查範圍、證據等級與必守原則

### 0.1 本次做了什麼、沒有做什麼

- **原始需求**：保留原提案的桌面端產品目標、使用者旅程、checkout/standalone/plugin 可獨立使用的界線，補足其隱含契約與失敗處理，並提出可逐步驗收的實作順序。
- **已查證程式碼**：`Ponpon55837/WorkLog.Ai` 的 `main`，審查時 head `7723b72ace798476bc347ca99ca90503980759d2`（GitHub 顯示 2026-11-14 提交）；主要看過 server 啟動／關閉、資料庫位置／只讀診斷／初始化／schema migration／備份、Agent 設定、plugin、service、standalone 及發行說明。詳細連結見文末附錄。
- **已查證外部案例**：GitHub 的 Actual Budget、Rancher Desktop、electron-builder 原始碼／文件，以及 Electron、SQLite 官方文件。可借鑑的是「模式」，不是保證照抄就安全。
- **未做**：未修改 repository、未執行 `pnpm test`、未產生可安裝 Electron app、未完成 macOS/Windows/Linux 實機與安全滲透測試。CI／E2E／實機通過狀態不得由此設計審查推論。

**證據標籤**：`[R]` 已從目前 repo 確認；`[U]` 外部官方文件或 GitHub 原始碼可直接支持；`[D]` 本規劃提出的設計決策；`[T]` 必須以原型或實機確認的假設。正式工程任務需附相對應的證據連結及測試結果。

### 0.2 七條不可妥協的產品不變條件（Invariants）

1. **資料不因安裝而改變**：未選定來源、未核對 schema、無權限或有來源歧義時，不能啟動可能建立／遷移資料庫的正式後端。[D]
2. **不假冒管理權**：一個使用者只有一個桌面主程序；不能僅憑 API health、port、PID 或同版本宣稱控制其他程序。[D]
3. **Agent 不依賴桌面 GUI 存活**：由宿主啟動的 MCP/hook 即使 App 關閉也能正常啟動；更新、解除安裝、runtime 清理不得破壞正在執行的 Agent。[D]
4. **無法確認相容就停止危險變更**：資料庫 schema 變更、restore、寫入端切換一律先驗證並採 fail-closed；一般讀取及診斷盡量維持可用。[D]
5. **所有外部設定尊重所有權**：手寫設定、plugin/MCPB 擴充、其他專案與未受控的 OS 服務不能被無聲取代、刪除或回滾。[D]
6. **管理權限須明確授權**：可看一般 Dashboard 不代表可以管理登入服務、改 DB、安裝更新、寫 Agent 設定或啟動本機命令。[D]
7. **發行聲明只涵蓋通過的安裝包**：源碼測試與 smoke test 不能替代實際安裝、升級、修復、解除安裝驗收。[D]

### 0.3 進入開發前的決策狀態

| 決策 | 暫定設計 | 狀態 |
|---|---|---|
| 桌面框架 | Electron Main 管理系統與服務，現有 Vue Dashboard 仍用外部瀏覽器 | **暫定採用**；原型可反證 |
| runtime | 搭配可離線啟動的標準 Node，Agent 指向固定 launcher | **待原型實測**：大小、FTS5、worker、各平台權限 |
| DB | 沿用既有 SQLite 與 `VACUUM INTO` 備份，不新增第二個儲存引擎 | **沿用現況**；新增相容性／管理維護契約 |
| 首發 OS | 先逐一通過 macOS，再視簽章與驗收能力開放 Windows；Linux 分開發布 | **產品決策待定**；不能宣稱先前已驗收 |
| 自動更新 | GitHub 固定來源、具可信任驗證的 metadata 與安裝包、失敗可修復 | **方案待鎖版本**；不同 electron-builder 版本能力不同 |

### 0.4 範圍負面清單

本案**不**順便替換 SQLite、不重寫 Web/API、不新增外部 SaaS、不導入遠端管理、不強制統一既有 agent plugin 為桌面管理、不預設收集遙測，也不把既有 checkout/standalone 的使用者變成必須安裝 Electron。任何修改涉及原有資料模型、MCP tool contract 或 CLI 行為時，須有獨立回歸測試及設計變更紀錄。

## 1. 使用者裝完後應該得到什麼

使用者下載安裝包，點開 Work Intelligence，就能在預設瀏覽器看到自己的 Dashboard。新使用者可以直接選第一個專案，舊使用者可以核對原本的記錄。關閉網頁後，選單列或系統匣保留一個圖示。點圖示可以再開 Dashboard，即使 Web 服務啟動失敗，圖示也能開啟修復畫面。一般使用流程無須開終端機、安裝 Node.js、尋找 repo 或設定環境變數。

| 操作 | 第一版預期體驗 |
|---|---|
| 手動開啟 App／再次點 App | 同一使用者只啟動一個桌面主程序。就緒後開目前的網址，合併連點造成的重複請求。外部瀏覽器自行決定重用或新增分頁。 |
| 關閉分頁／退出瀏覽器 | API 與每日備份繼續運作。收到瀏覽器斷線或 SSE 中斷不會觸發關機。 |
| 登入作業系統 | 啟用「登入時在背景執行」才啟動，成功時只顯示圖示。手動點 App 仍開啟網頁。 |
| 點系統匣 | 可開 Dashboard、查看服務狀態、修復設定、結束 App。無法控制平台圖示單擊行為時，選單第一項固定為「開啟 Dashboard」。 |
| 點「結束 Work Intelligence」 | 關閉桌面管理的 Web/API 和排程，等目前工作收尾再結束。由各 Agent 啟動的 stdio MCP 仍由其宿主管理。下次手動開啟或依使用者的登入設定啟動。 |
| 在 Web 變更設定或更新 | 沿用「系統狀態」頁。顯示目前生效的 port、實際版本、資料位置和服務管理方式。**只有通過可信更新管道與實機驗收的平台**才提供「下載並更新」；其他平台顯示官方 Releases 的受驗證安裝方式。 |

第一版保留 checkout、standalone 和 plugin 的獨立用法。桌面模式只管理本機目前使用者的服務。多資料庫切換、遠端管理與內嵌 Dashboard 視窗留待後續需求。安裝桌面程式不會改變任何專案的追蹤狀態。

### 1.1 「安裝成功」應以一筆真實可查的工作記錄為準

**主線成功準則**：乾淨離線安裝包 → 選 DB（或同意建立新庫）→ 開 Dashboard → 由使用者選資料夾並啟用追蹤 → 連接選定 Agent → 完成一筆真實工作並保存 → Dashboard 顯示該筆 Session。允許跳過 Agent，但此時只能算「Dashboard 已可用」，不能宣稱「Agent 已連接」。

**退出語意**：關瀏覽器不停止 API/每日備份；「結束 App」停止其管理的 API 與排程，**由各 Agent 自啟的 MCP 仍可工作，但 App 的每日備份排程不再執行**。介面需用清楚文字呈現，不得暗示「退出後仍每天備份」。其他外部管理服務的停止權仍屬原管理者。

**無視窗備援**：tray 不可用（Linux 桌面不支援系統匣、桌面環境異常、圖示未顯示）時，再次點 App 必須可開啟本機修復視窗；登入背景啟動不能反覆跳錯誤彈窗。[D]

## 2. 沿用現有行為，改變安裝責任

| 目前入口 | 桌面版的對應設計 |
|---|---|
| `bootstrap` 檢查 Node／pnpm、安裝依賴、build | 發行端完成。安裝包攜帶已驗證的 runtime、Web、server、backup worker、MCP 與必要資源。第一次啟動離線也能使用本機功能。[啟動流程](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/scripts/bootstrap.mjs) |
| `pnpm start`、`pnpm dashboard` | 桌面主程序啟動及辨識自己的後端。現有 dashboard script 以 HTTP health 判斷能否開頁，適合借用就緒判斷，管理程序還要驗證身分。[現有入口](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/scripts/dashboard.mjs) |
| `pnpm service:install`、`service:restart` | 桌面版提供登入開關與重新啟動。舊的 LaunchAgent、Windows 排程、systemd 使用者服務有獨立的辨識與接管流程。[服務說明](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/docs/service.md) |
| `pnpm setup:agents`、plugin、保存提醒 | 保留偵測、預覽、備份、衝突處理與按來源移除等語意。standalone 目前沒有 setup 或 service 子命令，桌面設定流程須另外接入這些能力。[Agent 設定](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/docs/agent-setup.md) · [獨立套件](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/docs/standalone.md) |
| `pnpm check`、Web 首次使用清單 | 桌面呈現可採取行動的診斷。Web 繼續負責「加入專案、啟用追蹤、連接 Agent、第一筆工作記錄」；桌面精靈處理安裝與接管，兩處讀同一個實際結果。[首次使用清單](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/apps/web/src/components/domain/FirstRunChecklist.vue) |

### 2.1 已確認現況與新增接縫

| repo 現況（查證） | 本次桌面化的正確做法 | 不應該做 |
|---|---|---|
| `[R] start-api.ts` 在 `listen()` 前就建構 `WorkIntelligenceStore`，可能觸發 migration | 另加**完全唯讀** preflight、設定來源核准與管理者確認；通過後才派生後端 | 先試開 Web，port 失敗才回頭找 DB |
| `[R] database-inspection.ts` 使用 `DatabaseSync(...,{readOnly:true})` 做 schema/完整性可選檢查 | 重用其能力但增加來源、檔案身分與錯誤類別；慢速 `integrity_check` 不阻擋普通初次啟動 | 為預覽偷偷開可寫 store |
| `[R] database-initialization.ts` 已拒絕較新 schema 並在 migration 前備份 | 加入**跨進程維護窗口**與「已開啟舊 MCP」的版本契約；重新審查其他開發入口 | 誤以為「啟動時檢查一次」足以保證長期運作中的舊 MCP 安全 |
| `[R] backup.ts` 使用 `VACUUM INTO`、私人 staging、驗證與 no-clobber 公開快照 | 在升級／還原時重用而非複製；用測試樣本驗證 WAL 已提交資料 | 在線複製單一 `.sqlite` 檔作為可驗證備份 |
| `[R] agent-setup.ts` 有 `AgentSetupPlan`、`mutations`、conflicts 與安裝 manifest | 擷取為無互動的 plan/apply/verify/compensate 共享 API，保留 CLI 原行為 | Electron 另寫一套 JSON/TOML 字串改寫器 |
| `[R] standalone.md` 表明已有不需 pnpm 的 JS bundle，但需要 Node | 延用 bundle，另外測試 bundled Node 與安裝資源的配合 | 假設 Electron 自帶 Node 能被外部 stdio MCP 直接當作標準 node 使用 |

Desktop 相關 package 應位於獨立界線（建議 `apps/desktop`），核心 `packages/storage`、`apps/server`、`apps/mcp` **不得引入 Electron runtime 作為必要依賴**；共享設定、Agent plan/apply 與 desktop protocol 應以小型純 TypeScript module 表達並同時測試 CLI 路徑。

## 3. 首次安裝與設定

### 一條短路徑，三種起點

1. **全新安裝。** 開 App 後先做限定範圍的唯讀偵測。歡迎頁顯示「使用預設設定開始」，摘要列出資料位置、本機網址及登入選項，可展開變更，也可選「使用已有的資料庫」。採用預設後立即開 Dashboard。Agent 和保存提醒可以現在連接，也可之後從同一個設定入口完成。
2. **找到唯一且一致的既有安裝。** 首頁改顯示「沿用現有資料」，列出資料庫、備份位置、現有服務與 Agent 來源。若有舊登入服務，提供「交由桌面版管理」及「繼續使用原服務」。選後者可開既有 Dashboard，桌面設定清楚標示其受外部管理。
3. **發現多個來源或讀不到舊資料。** 並列已知來源、完整路徑、唯讀取得的 schema 和可取得的專案數，標出哪個服務或 Agent 指向哪一份。讓使用者選擇、瀏覽其他位置或稍後處理。磁碟未掛載、權限不足、schema 過新或無法辨識時顯示原因，避免因 fallback 建出空庫。未發現既有來源時仍保留手選入口。

唯讀偵測範圍限於目前使用者的 App 設定、既有服務定義、產品已知 config／plugin link、可辨識的 Agent 整合與使用者明確選的路徑。預覽舊 DB 使用唯讀連線，避免觸發建立檔案、migration、備份輪替或資料修剪。Finder 或開始功能表啟動時，shell 的 PATH 與環境變數可能缺席。所有路徑都顯示解析後的值和來源。

### 設定清單與預設值

| 設定 | 新安裝預設／舊安裝沿用 | 使用者何時需要操作 |
|---|---|---|
| 資料庫與設定根目錄 | 新安裝採 standalone 的使用者資料目錄。偵測 `WORK_INTELLIGENCE_CONFIG_DIR`、`WORK_INTELLIGENCE_DB`、`WORK_INTELLIGENCE_HOME`、plugin link 和舊服務的實際設定。checkout 與 standalone 的相對路徑各依原規則解析。 | 找到舊資料先展示，來源不一致時選擇。首次設定保存絕對路徑，後續即使 shell 或工作目錄改變也要開同一庫。 |
| 備份 | 預設備份在 DB 旁的 `backups/`，沿用現有自動備份與保留規則。匯入既有服務時帶入可證實的目錄、保留份數與自動備份開關。 | 自訂位置不可寫、空間不足或舊值無法辨識時明示。關閉每日備份仍須完成必要的 migration 前備份。 |
| Port／瀏覽器 | 預設 `127.0.0.1:3210`，接管時記住既有 port。使用系統預設瀏覽器。 | 衝突才顯示替代 port 選擇。瀏覽器開啟失敗提供複製一般網址及重開，不影響服務。 |
| 登入時背景執行 | 新安裝預設關閉。接管有登入服務的舊安裝時，以原有效狀態預填。 | 可於首次摘要或之後切換。顯示作業系統回讀的狀態；若被系統設定禁止，顯示對應修正入口。 |
| 專案與追蹤 | 沿用現有專案清單，以及記錄中、暫停、忽略等狀態。新安裝預設沒有已授權的專案。 | 由使用者在 Web 選資料夾並明確啟用追蹤。安裝程式不代建測試記錄。 |
| Agent／skill／保存提醒 | 逐一偵測 Codex、Claude Code、Claude Desktop，以及手動註冊、plugin、擴充的來源。沒有安裝 Agent 也可以用 Web。 | 使用者只選想連接的 Agent，看到會變更的項目後套用；提醒可選。已有設定符合時顯示「沿用」。詳見下一節。 |
| 更新 | 穩定版、固定 GitHub Releases 來源。可手動檢查，新安裝預設在背景低頻檢查版本，離線照常工作。 | 可關閉背景檢查。只有通過簽章、metadata 與實機升級驗收的平台提供 App 內安裝；否則只提示官方下載連結。發現版本時顯示可延後提示，不因一般退出而無意安裝。 |
| 進階環境與權限 | 沿用必要的顯式路徑及目前使用者權限。桌面管理限定 loopback。自訂 CORS、開發 Web 路徑等列為特殊部署。 | 特殊部署預設保留外部管理，先列出無法等價轉移的項目。診斷不傾印整份環境或 Agent 設定。 |

路徑解析與備份預設的依據見[資料庫位置規則](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/packages/shared/src/database-location.ts)、[備份與還原](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/docs/user-guide.md)及[既有服務](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/docs/service.md)。

**第一次開啟的畫面順序。** 一般新使用者在「開始使用」選預設即可進 Dashboard。接著由既有首次使用清單引導「選專案資料夾 → 開啟記錄 → 選要連接的 Agent」。專案選擇可以稍後再做。只有勾選 Agent 的人會看到該 Agent 的變更預覽；port、備份保留份數與自訂設定目錄收在進階區。舊使用者第一個主要按鈕改為「沿用這份資料」，在寫入前即可看到熟悉的專案名稱。首次設定被中斷時，再次開啟從仍待處理的選擇開始；已確認的資料來源與已完成的 Agent 不必重選。

**典型的既有安裝。** 假設 macOS 登入服務和 Codex plugin 指向 A 資料庫，Claude Desktop 則明確指向 B。精靈應列出「開啟 A 可看到哪些專案」「Codex 已指向 A」「Claude Desktop 使用 B」。使用者可以先沿用 A 並接管服務，保留 Claude Desktop 的 B 設定；日後選「讓 Claude Desktop 使用 A」才在宿主設定流程中處理。切換指向不會合併 A、B 的記錄。結果頁分別報告服務接管及兩個 Agent 的實際狀態。

### Agent 整合必須能安裝、驗證、修復與移除

| 對象 | 桌面設定中心的處理方式 |
|---|---|
| Codex | 辨識 MCP、plugin、canonical skill、legacy skill、hook 檔與 hooks 開關，尊重自訂 `CODEX_HOME`。已啟用 plugin 時沿用該管道。停用、尚未信任或無法確認的 hook 各自說明；需要信任時引導使用者在 Codex 的 `/hooks` 完成。 |
| Claude Code | 辨識使用者層 MCP、plugin、skill 與保存提醒，區分 `CLAUDE_CONFIG_DIR` 與使用者 MCP 的實際設定位置。沿用既有 CLI／註冊邏輯；GUI 的 PATH 找不到 CLI 時可定位程式或先略過。 |
| Claude Desktop | 將既有 MCPB 擴充與手動 stdio 設定視為不同來源。已安裝則核對 DB 位置、宿主 runtime 和版本；未安裝則提供受支援的擴充安裝指引或桌面提供的 stdio 入口，安裝與授權由宿主完成。 |
| 同機有多個 Agent | 每個 Agent 各列狀態與有效 DB。允許 A 已連接、B 尚未安裝；同一個 Agent 有重複註冊或指向不同 DB 時，先預覽整理方式。保留其他工具與其他專案設定。 |

- **落盤前。** 逐項列出 MCP、skill、hook 將新增／沿用／更新／略過的路徑、作用範圍、原因與 DB。讀取時只處理本產品相關欄位。Agent 設定若有語法錯誤、已遭修改或自訂命令無法辨識，只提供檢視衝突與稍後修復。沿用既有檢測與安裝邏輯，拆出非互動的「預覽／套用」，供 CLI 和桌面共用。[目前註冊行為](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/docs/agent-setup.md) · [plugin 安裝差異](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/docs/plugins.md)
- **套用與重試。** 每次套用先重新驗證預覽時的檔案指紋，保存原始備份與本次操作清單。以此次選定的變更集為單位，任一步失敗就撤銷這批已完成且仍由 App 擁有的變更。重開後從實際檔案及操作結果恢復，重試只補缺項；其他程序其間修改的內容交給使用者檢視。
- **穩定入口。** 桌面管理的 MCP 和 hook 註冊指向目前使用者固定位置的啟動器，傳參數陣列和明確的 DB 路徑。即使 App 已退出、版本目錄換名或沒有全域 Node，也可執行。MCP 的 stdout 僅供 stdio 協定，診斷走 stderr；hook 遇到不可用的 runtime 應放行 Agent。保留正在使用的 runtime 至相關程序離開，Windows 檔案鎖也要驗證。外部 plugin 與 MCPB 仍由原管道更新。
- **Agent 打開 Dashboard。** 現有 plugin 可能執行 checkout 的 dashboard script。接管後，受支援的 script／skill 要從使用者層級的管理設定找到桌面 App 和已生效的 port，將開頁要求交給 App。遷移預覽需指出仍會自行啟動 server 的舊 plugin，提供更新或從 tray 開啟的方式。驗收包含換 port、退出 App 後從 Agent 開 Dashboard，確認沒有啟動第二個 checkout server。[現有 Dashboard 入口](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/docs/plugins.md)
- **結果分級。** 「已寫入設定」「桌面測試可啟動 MCP」「已觀察到 Agent 連線」「提醒待信任」分別顯示。自測使用暫存資料或唯讀握手；使用者可以重新檢查、修復、暫略或撤銷。偵測不到宿主實際載入時顯示「待確認」。更新後若需要重新連線或信任，只提示受影響的 Agent。
- **第一筆工作。** 設定完成後回到 Web 的首次使用清單。讓使用者從已啟用追蹤的專案，在選定 Agent 中完成一次真實工作並查看結果。只想瀏覽資料的人可以收起引導，之後再從系統狀態繼續。

### 3.1 來源發現、選擇與開庫的判定演算法（P0）

本稿將「預設沿用」改成可重現的有限狀態程序，不以第一個找到的檔案為答案：

1. **收集候選來源（不寫入）**：桌面已提交設定、使用者顯式選擇、OS 舊服務實際定義、受支援的 plugin link、可安全辨識的 Agent MCP 設定、standalone 預設、checkout 預設。候選必須紀錄來源類型、原字串、解析基準、展開後絕對路徑、是否受當前使用者管理。[D]
2. **辨識有效性（不寫入）**：保留 `missing`（不存在）、`offline`（卸載）、`denied`、`unreadable`、`unsupported-schema`、`ok`、`conflict` 等互不混淆的狀態。透過 read-only DB 讀取得到的 schema／專案數僅做「預覽」，不能取代 DB 唯一身分。[D]
3. **判定唯一性**：一個路徑可能是符號連結，兩個路徑可能指向同一檔；需比較正規化路徑、可取得的 OS 檔案身分（POSIX dev/inode、Windows 檔案識別）與 DB 自身識別。**DB 唯一身分策略仍需設計與測試**，不得僅以路徑字串或 project count 判定。[T]
4. **選擇**：只有唯一且多來源一致、DB 可讀且 schema 受支援，才能建議「沿用」。如有已知衝突、無法證實來源或外接來源遺失，不自動 fallback 建空庫。新建只能在使用者明確接受的新位置進行。[D]
5. **提交前重驗**：取得使用者明確同意 → 確認目標位置和檔案身分在預覽後未被替換（TOCTOU）→ 確認 port/服務所有權 → 必要的備份及 schema 前置條件 → 首次允許正式後端打開 DB。[D]
6. **新建 DB**：先檢查父目錄可用性、容量與權限，明確記錄這是「建立」而非「恢復」；任何失敗都保留使用者已選定的路徑，切勿默默換到另一個預設值。[D]

**唯讀連線也要做副作用測試**：SQLite 在 WAL 模式下，即使用唯讀方式開庫，也可能需要已有的 `-wal/-shm` 或在可寫的資料夾建立這些 sidecar 檔。故「readOnly」是**不修改業務資料的預設意圖**，不代表 OS 層必然 0 寫入；使用唯讀檢測時要用檔案系統監測測試具體行為，不能在使用者未同意前刪掉或搬動 WAL/SHM。對**活躍**資料庫禁止使用 `immutable=1` 假裝完全唯讀，因它會跳過變更偵測。[U][T]

**檔案系統政策**：軟連結、硬連結、UNC/SMB/NFS、可移除裝置及會自行同步檔案的雲端資料夾都需標成風險來源。SQLite WAL 官方不支援多主機網路檔案系統上的共享記憶體模式；V1 對不可靠的網路共享 DB 應**禁止自動接管／遷移**，僅供診斷與轉存建議。唯讀開庫不可使用會將變動中的資料視為永不改變的 `immutable=1` 假設。[U][D]

**設定優先序**：顯式且已提交的桌面選擇 > 使用者當次人工選擇 > 唯一且一致的受支援舊設定 > 新安裝預設。這是「選擇」優先序，**不是**「遇到錯誤就往下遞補」的 fallback 鏈。從 Finder/開始功能表啟動時環境變數可能不同；桌面端應保存明確的解析後值，並展示來源而非讀取某次 shell 的偶然值。[D]

### 3.2 Agent 整合的狀態、所有權與相容性

每個 Agent/來源都需保存 `source`（desktop-managed／manual／plugin／MCPB／unknown）、`effectiveDb`、`launcherKind`、`manifestOwner`、`lastVerifiedAt` 與 `verificationLevel`。一個 Agent 可「已設定但未驗證宿主載入」，不可直接顯示「已連接」。

| 顯示狀態 | 最低驗證證據 | 下一步 |
|---|---|---|
| 已觀察到連線 | Agent host 的 handshake 或明確檢測（不是只有檔案已寫入） | 可測試真實任務 |
| 已配置、待確認 | 目標設定已寫入且 hash 符合 | 引導重開 Agent／檢查 MCP |
| 需要信任／授權 | host hook 未信任、CLI 權限待確認 | 在原宿主完成 |
| 外部管理 | plugin/MCPB 或手動來源，桌面無權覆寫 | 只顯示狀態、提供相應入口 |
| 設定衝突 | 同名工具重複、路徑不同、語法錯誤、外部改動 | 先 diff，勿自動修復 |
| runtime 不相容 | launcher/DB/schema 版本不支援 | 升級或要求重新連線 |

**設定交易不是 OS 級原子交易**：一批 Agent 設定橫跨 JSON/TOML、skill/hook 檔及 host CLI 時，無法保證全部同步成功。應使用「計畫 → 每項指紋重新驗證 → 備份與原子寫入（可行處）→ 寫操作日誌 → 檢查 → 只對仍歸 App 所有且未被外部修改的項目做補償回復」。在回復途中發現外部異動時停止並要求人工處理；不宣稱能回滾第三方 plugin 或 MCPB 宿主管理器。[D]

**不可壟斷外部更新**：已由 plugin/MCPB 管理的 MCP，桌面只檢查和給出指引；不替它改版本或偷換命令。桌面更新本身不表示 host 會重新載入 MCP 工具清單。若 MCP 契約更新，要顯示「需重新連線」而不是一律判定已同步。[R][D]

### 3.3 固定 launcher／可攜 Node 的契約（P0）

- 發行包需包含**標準 Node 可執行檔**、後端、MCP、hook、worker、靜態 Web 與所需 runtime 資源。放在實際可執行的檔案系統路徑（例如 `extraResources`）；不假設能直接從 ASAR 內 `spawn()` 任意 binary。[D][T]
- Agent 的 `command` 指向使用者層級固定 launcher；launcher 解析一個**已驗證、原子提交**的 runtime manifest（實際版本、checksum、有效 DB 絕對路徑、宿主類型），以 argv array 啟動，避免經 shell 拼接字串。僅允許指定的固定動作（`mcp`、`codex-finalize-reminder` 等）。[D]
- runtime 目錄以不可覆寫的版本或內容識別管理；更新只改 manifest 指向新的版本。已有程序可能仍佔用舊 runtime，清理須延後並重試，不因 Windows 鎖定而破壞更新。launcher 檢查所有權/ACL，拒絕指到不可信或 world-writable 目錄。[D][T]
- App 關閉後必須能啟動 MCP/hook，不依賴 Electron GUI、Node PATH 或 repo；MCP stdout 僅有 MCP protocol，錯誤走 stderr；hook 找不到 runtime **放行**，但提供後續可修復的診斷，避免靜默長期失效。[D]
- 驗收涵蓋無 Node/PATH、中文與空格路徑、Windows 防毒／鎖定、macOS quarantine、離線、更新中既有 MCP、解除安裝未清乾淨 hook。每個組合都需真實 `initialize`／`tools/list`／讀寫合成 DB 測試。[T]

## 4. 從既有服務交接

1. **辨識管理者。** 從 OS 註冊範圍、服務名稱、命令及 runner 的正規化路徑交叉辨識；另核對 DB、備份、port 和目前執行版本。區分已安裝但停止、已停用登入、手動啟動、其他 checkout、其他使用者與其他軟體。HTTP 回應、相同版本、程序名稱或 PID 只可作為線索。
2. **預覽接管。** 列出哪一份服務會停、哪些登入設定會切換、資料與備份將沿用哪裡、哪些 Agent 可能要重新連線。提供「沿用外部管理」和「取消」。手動跑的終端機服務請使用者從原處停止。無法可靠辨識的服務不得代為終止。
3. **執行交接。** 確認後保存可還原的服務定義、啟用狀態與原運作狀態。暫停舊服務自動拉起，正常關閉其已驗明的程序樹，確認 port 釋放。接管前先檢查 schema 相容性、其他寫入端及必要備份，通過後才用絕對路徑開舊 DB。桌面就緒再提交管理權，依原選擇啟用桌面登入項。
4. **驗證與回復。** 檢查就緒版本、DB、原專案與備份清單、單一 listener 和登入項，下次登入再次驗證。失敗時先停桌面子程序；若 DB 相容，就恢復舊註冊與原先執行狀態。若 schema 已升級則進入資料復原流程，舊程式不得自動重開新版 DB。交接中閃退時按持久化階段與現況續辦。

Windows 必測停止登入排程後 runner 的子孫程序仍占 port 的案例。不同 OS 使用各自的服務管理 API 或已驗證的 adapter。所有接管資料只存本機。[已知服務行為](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/docs/service.md)

### 4.1 管理權轉移狀態機與不可越界的轉移

**區分兩種權限**：`ServiceOwner` 控制某個 HTTP/API 子程序的啟停；`DatabaseAccess` 表示不同 CLI/MCP 是否能在相容契約內讀寫同一 SQLite。桌面 App 可以是唯一的受管理 Web/API owner，**不等於 DB 可被桌面完全獨占**。進行 schema migration/restore 時，需另建立維護協調／版本屏障。[D]

| 狀態代碼 | 意義 | 允許動作 | 禁止動作 |
|---|---|---|---|
| `UNCONFIGURED` | 未確認 DB 或首次設定未完 | 唯讀偵測、選來源 | 啟動會建立 DB 的正式 API |
| `EXTERNAL` | 舊服務／手動 server 受外部管理 | 開既有 Dashboard、顯示診斷、預覽接管 | 代替使用者停止無法證實歸屬的程序 |
| `PREPARING` | 已要求接管，尚在預檢／備份 | 拒絕新的管理寫入；完成 preflight | 把新版 DB 交還舊程式 |
| `QUIESCING` | 已停舊登入自動拉起並等待舊程序關閉 | 可取消並按記錄恢復 | 啟兩份相同 port 的 server |
| `STARTING` | 新桌面後端啟動與身分驗證 | 驗證 IPC、DB/版本、HTTP | 只因 health 成功就提交所有權 |
| `MANAGED` | 桌面控制的服務可用 | 管理授權操作、查看狀態 | 超出已授權 DB 的隱式切換 |
| `NEEDS_REPAIR` | 接管中斷、衝突、DB 相容性問題 | 開內建修復 UI、重試/轉回外部模式 | 自動開空庫或覆蓋資料 |

每次轉移持久化 `operationId`、`phase`、`previousOwner`、`selectedDb`、`oldServiceDefinition`、`oldEnabledState`、`oldRunningState`、`lastKnownGood`、`migrationStarted` 與 `recoveryPolicy`（不保存密鑰）。寫入本機操作日誌必須具備 **idempotent replay**：同一操作 ID 重試回傳狀態；失敗後依真實 OS 服務狀態與已寫入的 DB/schema 重建現況，不可只依賴舊 phase 文字。[D]

**回復分岔**：若資料庫 schema 尚未變更且舊版相容，可預覽並恢復外部登入服務的先前狀態；一旦 migration 開始或 DB 身分不確定，**禁止自動重啟舊服務**，只能進入相容性修復／選擇備份的流程。手動 CLI 背景程序不受桌面強制管理。[D]

### 4.2 服務辨識證據層級

**弱線索**：相同程式名稱、PID、port、HTTP `/api/health`、版本號、命令列文字。**較強線索**：目前使用者 OS service 註冊識別、服務定義的 canonical runner、process start-time、可驗證的父子關係、專用 IPC 啟動 nonce、DB 身分、服務 manifest。單一證據均不應被視為足夠；不同 OS 需用實機驗證其可靠性。[D][T]

當另一個使用者／未辨識程序已占用 port，應維持 `EXTERNAL` 或 `NEEDS_REPAIR`，提供換 port、提示手動處理；不得根據同名程序直接 kill。Windows Task Scheduler 的 `conhost`/runner 子孫程序尤其必須逐步驗證。[R][T]

## 5. 桌面架構與操作契約

| 元件 | 責任與界線 |
|---|---|
| Electron 主程序（TypeScript） | 取得每使用者單一執行鎖，管理 tray、登入項、瀏覽器、後端子程序、安裝設定與 updater。保存操作進度。服務壞掉時仍能開啟內建的本機修復視窗。[Electron App](https://www.electronjs.org/docs/latest/api/app) · [Tray](https://www.electronjs.org/docs/latest/api/tray) |
| Node 後端與 worker | 重用 standalone 的 server、Vue 靜態檔與同目錄 backup worker。具體建議為後端、MCP、hook 共用隨安裝包配送的標準 Node runtime，避免外部 Agent 依賴 Electron GUI 或系統 Node。代價是安裝包另外攜帶 runtime。原型需與 Electron 內建 Node 的子程序實測大小、啟動耗時、SQLite／FTS5 與 worker 相容性，才鎖定發行方式。[Standalone 配置](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/docs/standalone.md) · [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process) |
| 瀏覽器 Dashboard | 沿用既有 Web/API、語系和佈景。新增服務設定、Agent 設定進度與更新操作。只有桌面管理的實例能使用相關控制，其他模式顯示其管理方式。 |
| 子程序控制通道 | 主程序建立私有父子 IPC。啟動就緒訊息含該次啟動識別、實際 port、版本和已開啟的 DB 身分，配合 HTTP health、首頁與必要資源驗證。關閉時經 IPC 呼叫可等待的收尾程序，跨平台驗證完成與 port 釋放。[API 啟動](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/apps/server/src/start-api.ts) · [既有關閉順序](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/apps/server/src/shutdown.ts) |
| 設定與操作狀態 | 版本化的使用者設定與操作日誌置於使用者可寫的固定目錄，和 App 安裝位置分離。DB、備份、Agent 設定各有自身所有權。記錄已生效設定、待套用值、操作階段與最後成功版本，以暫存檔加原子替換提交。 |

**從瀏覽器發出控制命令。** 正常開啟由 App 產生短效、一次性的授權碼，透過 URL fragment 在同源頁面交換限時桌面會話，隨即清除 fragment。交換與管理操作驗證精確的 loopback Host、含 port 的 Origin、JSON、當次實例及防 CSRF 憑證。每次切換 port 或實例重建授權，憑證不可跨 port 共用；排除 URL query、日誌及持久化瀏覽器儲存。書籤／手輸網址仍可用既有 Dashboard，進入管理時引導從 tray 開啟。Web 只能送固定動作和經 schema 驗證的值；特權資料夾選擇、敏感設定預覽與授權採本機視窗。不得替網頁執行任意指令、開任意 URL、指定更新源或改寫任意路徑。修復視窗只載入內附資源，採隔離、sandbox 與最小 preload API。[既有 HTTP 防護](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/apps/server/src/server.ts) · [Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security)

**並行與中斷。** 接管、重啟、換 port、套用整合與安裝更新共用操作鎖。動作帶操作 ID，重送取得同一次結果；不同分頁收到忙碌狀態與操作名稱。先回應已受理再關閉 HTTP。服務狀態依序區分啟動中、可用、停止中、外部管理與需要處理；更新下載可在服務可用時進行。父程序失聯時子程序自行收尾。下次啟動須檢查前次中斷、實際 listener 和 OS 登入設定。

### 5.1 啟動先後順序與可驗證的控制通道（P0）

**強制順序**：`load validated desktop config` → `read-only DB/source & schema preflight` → `verify service ownership / port` → `acquire operation coordination` → `spawn child with explicit argv/env` → `child confirms opened DB identity via private IPC` → `HTTP readiness with exact instance nonce/version` → `commit active service state` → `open browser`。一律不得在 preflight 前呼叫可能建立／migration 的 `WorkIntelligenceStore`。既有 `startApi()` 須提供桌面專用 bootstrap/entry-point 或可安全注入已驗證的 DB config，原 CLI 仍維持既有行為。[R][D]

- 控制 IPC 限父子已驗證通道，不以 HTTP health 作為授權。child readiness 至少回報 `runId`、port、version、schemaVersion、DB 身分、build hash；parent 比對後才宣布 ready。`runId` 不可當成憑證泄漏在一般 health endpoint。[D]
- Electron Main 的操作對象必須是**自己啟動且仍能證明身分的子程序**；PID 可能重用，跨作業系統需要檢查 handle、建立時間與 process tree。不要呼叫非受控系統程序的通用 kill API。[D][T]
- 停止順序：不受理新的管理變更 → 停背景排程 → 排空/取消長工作（依法定義 deadline）→ 關閉 SSE、HTTP → worker drain → 關 SQLite → child 已退出與 port 釋放。正常退出不進崩潰重啟；超時由 App 顯示「正在等待 X」，避免假裝已成功。[R][D]
- 環境變數需**明確 allowlist**（尤其 `WORK_INTELLIGENCE_DB`、PORT、BACKUP_DIR）；不可把開發者 shell 中自訂 Node 選項、不可信 PATH、ELECTRON flags 不經處理傳給正式後端。以 `spawn(...,{shell:false})` + argv array 避免 shell injection。[D]

### 5.2 管理控制威脅模型（P0）

| 攻擊者或故障來源 | 能做的事 | 必備控制 | 還要測什麼 |
|---|---|---|---|
| 惡意網站／CSRF／DNS rebinding | 透過 loopback API 向本機 App 發送請求 | 精確 Host（包含 port）、同源 Origin、nonce 會話、CSRF、嚴格 content type；**授權與 Origin 必須同時成立** | 假 Host、無 Origin、跨 port、重播與過期 |
| 同機未受信任本機程序 | 可自行送 HTTP、不受瀏覽器 CORS 限制 | Desktop 管理 API 使用不可猜測的會話授權與 OS 層私有 IPC；普通 API 是否另加 auth 是兼容性決策 | curl/CLI 偽造 headers、非 App PID 操作 |
| 同機其他使用者 | 可能連到 `127.0.0.1` 上的 server（loopback 不是 per-user 權限邊界） | 對資料 API 的跨使用者威脅需獨立評估，不能只保護管理 API | 不同 OS 帳號連線讀寫試驗 |
| 瀏覽器擴充、XSS 或被替換 Web 資源 | 讀取網頁狀態、濫用管理 UI | Native 視窗進行危險操作確認；嚴格 CSP、受控前端資產、限時最小權限 token | XSS、fragment/history/extension 可見性 |
| 外部設定／磁碟連結／更新源 | 將操作指向任意檔案或執行檔 | 路徑 allowlist、realpath/檔案身分重驗、簽章和完整性、設定所有權檢查 | symlink swap、硬連結、zip slip/路徑穿越 |
| 偽造或錯誤更新 | 偽造 manifest 或下載到錯架構程式 | 已信任 metadata 驗證與 code signing；工具版本綁定 | manifest 替換、release tag 變更、key rotation |

**會話授權設計**：原提案的 URL fragment 一次性授權碼可以作為 *候選方案*，但它仍可在瀏覽器歷史、擴充或畫面分享中暴露，不能當作高風險操作的唯一防護。須限制 TTL、一次使用、綁 `runId + origin + exact port`，頁面載入時立即 `history.replaceState` 清除，管理授權只存記憶體；手輸網址/書籤只能讀一般 Dashboard。恢復登入服務、刪除/還原 DB、變更路徑、更新安裝或 Agent 配置仍須回到 app 受控的本機修復／確認視窗。禁止任意 `exec`、任意 URL、任意檔案位置及攜帶秘密的自動導覽。[D][T]

**Electron 修復視窗**：僅載入 app 隨附資源與固定 scheme，`nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`；最小 preload API、逐項驗證 IPC sender、拒絕未知 navigation/webview/window.open、default-deny permissions、CSP。Electron 官方把 `shell.openExternal` 的任意 URL 及未校驗 IPC 視為風險；不得把從 Web 帶入的字串直接交給 `shell.openExternal`。[U]

**資料 API 的兼容性決策**：目前普通 Dashboard/API 的 loopback 存取契約與 MCP stdio 不同。這次先新增獨立的桌面管理授權，不應悄悄令現有 CLI、checkout 和第三方腳本的 API 失效；但應另開安全議題評估跨 OS 使用者可存取 local API 的風險，並在發行說明中清楚界定。[D]

### 5.3 設定與操作日誌的耐久性

- 版本化設定 `configVersion`、明確已提交 active/desired config、operation log、最後可用 runtime，都在目前 OS 使用者可寫且其他帳號不可寫的固定根目錄；安裝 binary 不混放資料。[D]
- 寫入以同目錄暫存 → 完整內容及 schema 驗證 → flush/fsync（視平台支援）→ 原子 replace/rename → 需要時 fsync parent directory；若磁碟或虛擬化 FS 無法保證原子替換，則建立可驗證復原副本，**不能無保護地就地覆寫唯一配置**。[D][T]
- 讀取失敗不能當成「全新安裝」並覆寫原狀：保存原檔，載入最後有效副本或進修復；只有確定 `ENOENT` 且沒有既有來源才可按新用戶處理。[D]
- 可借鑑 Actual Budget 的 `global-store.json` 暫存檔與復原副本邏輯，但不能直接照抄其所有 fallback：對會決定 DB/管理權的 config，無法保證安全寫入時應**中止提交**。[U][D]

## 6. 重新啟動、換 port 與服務故障

1. 「重新啟動」沿用目前設定。「套用並重新啟動」先驗證十進位整數 1–65535、作業系統權限、瀏覽器限制及 loopback 綁定。舊值相同則結束。新 port 占用時直接留在原頁；預檢通過仍以實際 bind 結果為準。
2. 舊頁先顯示操作進度，提供原／新網址及 tray 備援。停止接新工作，結束 SSE、排空 HTTP、等待 worker 與 SQLite 關閉。進行中的匯入、還原、備份或 migration 須完成或安全延後操作。桌面程序獨立等待釋放；逾時顯示正在等什麼，可重新檢查。
3. 新服務通過 IPC 身分、DB 與 HTTP 驗證後，提交新 port。相同 port 的頁面自動重連，換 port 由 App 開啟新網址。保留可安全還原的頁面路徑；有未儲存編輯先提示儲存。跨 port 的瀏覽器儲存屬於不同 origin，語言與佈景等偏好應從已知偏好還原。
4. 新服務未就緒則以最後成功設定復原；原 port 也被占用時，tray 的「修復連線」可直接選別的 port、重試、看日誌。啟動期間崩潰採有上限的退避重試，例如兩分鐘內三次後轉為待處理；權限、格式、schema 等確定錯誤直接進修復。睡眠喚醒時重查現況。確保正常結束不觸發自動重啟。

現有 server 在 listen 前已開啟 store，開錯 DB 可能先觸發 migration。因此所有來源選擇與相容檢查必須在首次寫入前完成，不能以「port 啟動失敗」推定資料尚未變更。[啟動順序](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/apps/server/src/start-api.ts)

### 6.1 操作佇列、取消與回復的契約

所有會影響管理權的動作（接管、換 DB、換 port、套用 Agent、重啟、還原、更新安裝）由單一全域 `OperationCoordinator` 協調。提交時產生具來源、參數摘要、預期狀態、階段及完成結果的 `operationId`；**重送同 ID 只回傳同一操作**，不同 ID 的互斥變更回 `BUSY` 並附目前操作。讀取診斷可在安全處並行。[D]

- **可取消**：尚未切換 owner、尚未進入 schema migration、尚未由 installer 接管之前通常可取消並清 staging。[D]
- **不可立即取消**：正在執行不可中斷的 SQLite 寫入／安裝器交接時，UI 顯示「已進入不可中斷階段」並待其安全收尾；不得把取消等同 `kill -9`。[D]
- **瀏覽器中斷**：HTTP 回應只證明已受理，實際操作由 Electron Main 持續維護；頁面刷新後以 ID 查詢。不依賴原 HTTP request 存活。[D]
- **失敗復原**：確認當前 DB/schema/OS 服務/runtime 狀態與上次持久化階段一致後，才重試或回復；無法確認時進修復模式。[D]

### 6.2 換 port 的額外限制

1. 監聽只允許 loopback；`1–65535` 是數學合法值，不代表目前使用者能 bind，也不代表所有瀏覽器都允許導航。低埠與瀏覽器保留埠按實際平台測試。[T]
2. port 空閒預檢只是一項提示，**實際 bind 才是準據**；任何 port 失敗不得先建立另一份空 DB（見 5.1）。[R][D]
3. `127.0.0.1:3210` → 新 port 時 `localStorage`/cookie 的 origin 已改。跨 port 偏好只搬運白名單的非秘密值；不移轉管理會話或 DB path token。[D]
4. 既有 App 書籤/Agent 舊 dashboard script 可能指向 3210；給固定 launcher 的 `dashboard` 命令，詢問管理者當前 port，不要因舊 script 的 health 檢查重啟 checkout server。[R][D]

## 7. GitHub 更新、資料保護與復原

**發行提案。** 使用 electron-builder 打包及 electron-updater，延用產品根目錄版本與同一個 release commit。macOS 產生簽署、公證的 App、DMG 與更新 ZIP；Windows 產生目前使用者安裝的簽章 NSIS；Linux 桌面候選採 AppImage。各架構的安裝包、更新描述、校驗值及該工具版本需要的附檔必須互相匹配。固定官方 GitHub 倉庫、穩定通道、可信任發布者／簽章公鑰；驗證更新清單簽章、檔案雜湊和平台支援的發行者驗證。Linux 尤須驗證由 App 內建信任金鑰簽署的更新清單。客戶端不用 GitHub token。[現行發行程序](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/docs/release.md) · [更新套件與平台格式](https://www.electron.build/docs/features/auto-update/) · [更新清單簽章](https://www.electron.build/docs/features/signed-update-manifests/)

| 階段 | 成功條件 | 中斷或失敗的處理 |
|---|---|---|
| 查詢與下載 | 顯示目前版、目標版、大小、版本說明、下載進度。背景檢查有間隔，手動可立即查。 | 離線、代理、限流或 GitHub 暫停不影響本機服務。顯示上次檢查時間和稍後重試。下載可取消；毀損快取可重抓。 |
| 驗證與安裝前檢查 | 目標 OS／架構、信任簽章與雜湊正確。確認空間、安裝位置可寫、資料位置、待完成工作、可驗證的升級前備份及可用的復原安裝包。 | 驗證失敗保留舊版與原服務。安裝位置唯讀或 macOS 尚從 DMG 執行時，說明移到可更新位置的步驟。備份失敗顯示可重試的具體原因。 |
| 切換版本 | 保存目標、上次成功版本及前景／背景狀態；排空服務。schema 要變更時，確認舊 MCP、CLI 等寫入端已退出，並在遷移期間排除重新開啟。 | 無法約束外部寫入端時暫緩安裝，說明需關閉哪類連線。下載完成不等於已安裝；使用者選擇延後時，一般退出不得意外安裝。 |
| 新版驗證 | 比對桌面、實際 API、Web 資源與 schema，核對 DB 身分、備份 worker 和管理入口。依先前狀態返回 Dashboard 或靜默回到 tray。 | 下次開啟從持久化階段判定結果。新版開不起來時透過獨立的安裝包／修復入口可重裝同版或較新修正版，保留設定與資料。 |
| 復原與停止派送 | 維護者可撤下問題更新，發行更高版本修正。更新簽章金鑰或發行者變更須先驗證從已安裝舊版的過渡路徑。 | 只在原 schema 相容時回退程式。若已 migration，優先修復程式；需要還原 DB 時先停止所有存取、保留當前 DB 快照、列出備份時間和此後可能失去的工作，再由使用者選擇。禁止自動覆蓋工作記錄。 |

沿用 storage 原有的 migration 前備份與舊程式拒開較新 schema 規則。複製 DB 或製作一致快照應使用既有備份／還原機制，需涵蓋 WAL 資料。一旦某版可能改變 schema，CI 必須以舊版建立的樣本測試升級、中斷及還原。[升級語意](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/docs/release.md) · [備份與還原](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/docs/user-guide.md)

### 7.1 發行工具版本：v26 與 v27 的差異不能混淆（新增 P0）

截至審查日，electron-builder 官網 **v27 `Security & Hardening` 文件明示 v27 仍屬 next**，有別於穩定版 v26。v27 文件描述 Ed25519 signed `latest*.yml`、信任公鑰與額外 updater 強化；**若實作鎖在 v26，不可宣稱單靠 `sha512` 即保護 manifest 本身，也不可假定具有 v27 專屬 API**。[U]

**規則**：在 A 階段先鎖定精確 `electron` / `electron-builder` / `electron-updater` 版本，對照實際程式庫與產物證明：

- 如果使用已實測的 v27 能力，簽名私鑰放 CI secret，app 嵌入信任公鑰，測試篡改／漏簽／錯 key／key rotation 及 metadata 與安裝資產 一致；不採 `updateManifest:false` 逃避要求。[U][T]
- 如果正式環境仍用 v26，必須提出並實測**等價的 metadata 來源驗證方案**，或先改為「手動前往官方 Releases 下載經平台驗證的安裝包」，**不要把不可靠的 auto-update 當 V1 已完成**。[D]
- 更新來源固定官方倉庫與 release asset（禁止使用者輸入鏡像 URL 交給特權安裝器）；release tag、版本及平台檔案之間的映射以實際可重現發行流程驗證。[D]
- electron-updater v27 文件亦說明 Windows/Linux 「退出時安裝」可能與 OS session 結束競爭。應實測 `autoInstallEvent` 可用性與 `manual`／`onNextLaunch` 等策略；若未能證明無意外退出安裝，採**使用者明確按下安裝並先排空後端**的方式，且必須備有外部可啟動的修復安裝包。[U][T]

### 7.2 更新、schema 與 runtime 的三階段成功定義

更新畫面不得只有一個「成功」布林值：

| 部分 | 完成條件 | 失敗後策略 |
|---|---|---|
| `desktopInstalled` | 安裝器已切換到新 App，簽章／版本確認 | 機器上的修復安裝包或官方下載 |
| `backendReady` | 指定 runtime/web/API/worker/管理 IPC 驗證通過 | 留在 tray 修復，不偷用其他 checkout 代替 |
| `dataCompatible` | 選定 DB/schema 正確，必要 migration 前備份驗證，Agent 寫入端按契約轉移 | 阻止舊程式讀寫不相容 DB；優先修正版前進修復 |

在任何 schema 會改變的更新前需通知使用者關閉會持續讀寫的 Agent/CLI。**「有舊 MCP 程序尚在」不是單靠 `sqlite_busy` 能推定的**：長連線可能閒置後才寫入。必須有 per-operation schema/capability 檢查、世代屏障或可驗證的更新窗口；若現有 MCP 只能在啟動檢查 schema，則屬於阻斷 schema 更新的未完成事項。[R][D]

### 7.3 DB schema 相容政策（P0）

| 相容等級 | 新桌面與現役舊客戶端 | 規則 |
|---|---|---|
| `READ_WRITE_COMPATIBLE` | 已驗證可共用契約 | 才允許並行寫入 |
| `READ_ONLY_COMPATIBLE` | 舊客戶端可讀但不應寫 | 舊寫入端進只讀／拒寫提示（需程式支援） |
| `RECONNECT_REQUIRED` | 契約工具、schema 或 launcher 需要重新載入 | 停止新動作並顯示在原 Agent 重新連線 |
| `INCOMPATIBLE` | 不可安全共存 | 延後升級或進維護模式並排除舊端 |
| `UNKNOWN` | 無法證明 | 預設視為不允許破壞性 migration |

每次 MCP 工具寫入與長任務提交前都應重新評估必要的 schema/capability/epoch；這是**新增需求，不代表現有程式已做到**。客戶端若無法識別屏障，遷移流程就必須確保它不能在遷移後再次寫入。單一 lockfile 只能做協調，不等同強制隔離任意不受控程序。[D]

### 7.3.1 實際內含 SQLite 的安全版本（新增 P0）

**SQLite 官方於 2026-03 公告 WAL-reset 資料損毀問題**：SQLite 3.51.2 及更早的相關版本可能在極少數 WAL 多連線寫入／checkpoint 競態下出現資料損毀；官方指出 3.51.3 起已修復，亦有 3.50.7、3.44.6 的回補版。這是**外部已確認的版本風險**，不是已證實 WorkLog.Ai 現有資料庫發生損毀，也不是說所有較低版號都未包含 backport。[U]

- 打包規格除了 Node.js major 版本和 FTS5，**必須記錄 shipped Node 內建 `node:sqlite` 的實際 `SELECT sqlite_version()`，檢查 upstream 修補狀態**；版本字串若落在疑似受影響區間，須取得供應鏈已回補的證據，否則不得做公眾發行的多寫入端桌面 runtime。[D][T]
- 不能假設「Node 24」或「Node 22.16+」就一定含修補：精確 Node patch 版及所含 SQLite 版由 release artifact 自動列印與檢驗。若考慮換一份可攜 Node，仍須測試和現有 `node:sqlite`、FTS5、worker、schema 相容。[D][T]
- 跨不同 runtime（Agent plugin 可能仍指向其他 Node）的混用要列入診斷：桌面 App 的修補不代表未受控的外部 Node 已被更新。不可為防範少見競態而強制殺掉任意外部 Agent，但可以限制 schema 變更、顯示相容性風險並要求選定受管理入口。[D]
- 採安全版本後仍需做 WAL 并發壓力與 `integrity_check`/可還原樣本測試；壓力測試**不能**單獨取代官方修補版本證據。[D]

官方來源：[SQLite WAL-reset bug 與修補條件](https://www.sqlite.org/wal.html#the_wal_reset_bug)、[SQLite 3.51.3 release](https://sqlite.org/releaselog/3_51_3.html)。

### 7.4 備份的真實保護範圍

`[R]` WorkLog.Ai 現行 `writeSnapshot()` 用 `VACUUM INTO` 取得一致快照，私有 staging 驗證後才對外發布，這優於單純複製 WAL 模式下的主 `.sqlite` 檔。[U] SQLite 官方亦建議 Online Backup API 或 `VACUUM INTO` 作 live DB 快照。

新增保護：

- migration/restore 必須檢查目標 DB、可用空間、備份目錄及**可實際讀回的快照**；以合成資料至少驗證 `PRAGMA integrity_check`、代表性 Session／專案 ID，重大還原演練另驗 `foreign_key_check`。[D][T]
- 備份後進行破壞性 migration，應保留操作前快照、schema 版本與使用者選擇；不得把保留三份自動備份視為跨磁碟事故或 ransomware 的恢復策略。可提醒使用者另存備份，不預設上傳。[D]
- DB 位在外接磁碟、雲端同步目錄或不支援 WAL 的 FS，顯示限制並避免自動接管；避免資料庫與備份都放在同一易遺失的磁碟而不提示。[U][D]
- `restore` 一定要先讓所有相容性可疑的 API/MCP 退出或被可靠阻擋；不能以備份 copy 直接覆蓋正在使用且附有 `-wal/-shm` 的活躍 SQLite。[U][D]
- 對非可逆 schema 變更，不以「程式降版」當資料回復；若使用者選擇還原備份，先保存當前 DB 的快照、揭露備份時點以後可能流失的 Session，再執行。[D]

## 8. 日常設定、診斷與解除安裝

- **同一處找得到。** Web「系統狀態」分成服務、資料與備份、Agent 連線、版本更新；可從 tray 直達。基本畫面先顯示運作結果，需要處理才顯示下一個動作，進階區才列路徑與細節。支援既有繁中／英文、鍵盤操作、深淺色；狀態用文字說明。背景登入遇錯時提供單次系統通知或 tray 提示，避免反覆開視窗。
- **資料來源遺失。** 已知 DB 消失、外接碟卸載、路徑移動或權限改變時，保留原設定並提供重新定位。重新定位先唯讀預覽，核對資料與各 Agent 路徑後才套用。設定檔毀損時保留原檔，從最後有效設定或使用者確認的路徑復原。
- **本機診斷。** 顯示最近一次操作、失敗階段、時間、版本、服務歸屬及可用動作。例如「3210 已被其他程序使用，原設定已保留」。日誌輪替；匯出診斷前預覽並遮蔽授權碼、個資路徑、工作內容與其他工具設定。無預設遙測或自動上傳。
- **解除連接與移除。** 設定中心先列出 App 管理的登入項、Agent／skill／hook、穩定啟動器及外部整合。依安裝清單與目前指紋選擇性移除，保留使用者修改及其他來源項目。一般移除保留 DB、備份及設定，顯示實際位置。已接管使用者可在 schema 相容並預覽原登入狀態後交回舊服務。
- **平台差異。** Windows 解除安裝器整合可用的清理流程。macOS 拖進垃圾桶及 Linux 刪 AppImage 可能略過清理，提供「移除桌面整合」入口、手動復原說明與重裝後清理。重新安裝必須能找回原資料；留存的 hook 即使找不到 App 也應放行。

### 8.1 錯誤處理、隱私與支援界線

診斷應區分 `DB_MISSING`、`DB_OFFLINE`、`DB_PERMISSION`、`SCHEMA_TOO_NEW`、`SCHEMA_MIGRATION_BLOCKED`、`PORT_OCCUPIED_BY_OTHER`、`SERVICE_OWNER_UNKNOWN`、`RUNTIME_MISSING`、`HOOK_UNTRUSTED`、`UPDATE_UNVERIFIED`、`REPAIR_REQUIRED`，每個錯誤連到**唯一可執行下一步**。錯誤日誌不得將整份 Agent config、MCP 工具輸入輸出、Session 工作內容、home 路徑、完整環境、API 授權碼與 webhook/token 原樣傾印。[D]

對診斷封包實施 dry-run 檢查、個資路徑遮蔽與秘鑰掃描；只有使用者主動匯出才寫檔，**不得預設向 GitHub Issue 或遠端 API 上傳**。解除安裝對外部 plugin/MCPB 不得擅自卸除。Mac 拖 App 至垃圾桶、Linux 刪 AppImage 都可能跳過整合清理，必須提供 App 內清理及再安裝後恢復入口。[D]

### 8.2 退出 App、休眠與排程的可預期行為

- 關瀏覽器：後端仍在，App 的每日備份維持。[R][D]
- 在 tray 「結束 App」：受管理 API/排程停止；Agent 自啟 MCP 仍可按其宿主使用 DB，但**沒有桌面排程保證**。要定期備份，使用者需維持背景服務或啟用明確獨立的備份方式（V1 不隱式新增）。[D]
- 睡眠／休眠：醒來後檢查舊子程序、port、DB 外接來源與登入項狀態，不盲目重啟；必要時進 `NEEDS_REPAIR`。[D]
- 系統登出與強制關機：不得期待無限時間的 drain，資料庫有自己的 transaction 保護；下次啟動依持久化操作 log 與實際狀態恢復，並驗證未完成快照。[D][T]

## 9. 平台、實作順序與發行驗收

**候選支援矩陣（不是承諾同日上線）。** macOS Apple Silicon／Intel、Windows 11 x64 分別作為正式驗收候選；Linux 另設 Ubuntu GNOME x64 的 AppImage、桌面圖示與登入項驗收。通過哪個 OS／架構的完整 gate 才對外列為支援。Linux 圖示不可用時，再次開啟 App 也能進設定、修復與結束。Windows ARM、其他 Linux 桌面或封裝格式須另驗證。實作起始時按所鎖定的 Electron、updater 與作業系統實測結果列出最低 OS、小版本及支援架構；對外只列通過的組合，原有 CLI 的平台支援獨立維持。

| 階段 | 開發產出 | 進入下一階段的證據 |
|---|---|---|
| A．封裝可行性 | 在各候選平台，以乾淨使用者安裝可攜 runtime、Web、worker、MCP 與資源。比較兩種 runtime 配置，鎖定 Electron／Node／updater 版本及更新金鑰流程。 | 無 Node、pnpm、git 的機器可離線開頁、寫測試 DB、搜尋 FTS5、備份及做 stdio 握手。記錄安裝大小、冷啟動和閒置資源基準。 |
| B．安裝與交接 | 實作首次設定、路徑解析、整合預覽／套用／撤銷、外部管理模式、舊服務交接。 | 通過下表「安裝」「既有使用者」「Agent」案例，含中途取消與斷電。 |
| C．日常控制 | 完成單例、登入、tray、瀏覽器授權、重啟、換 port、診斷與離線修復。 | 前景／背景、競態、安全與收尾案例通過，舊 CLI 與普通瀏覽器入口仍可用。 |
| D．發行演練 | 在隔離的預發通道使用同一個正式打包流程，從簽署過的 N 安裝包升到 N+1，包含 schema 變更。 | 每個宣告支援的 OS／架構均有簽章、實際下載安裝、還原與解除安裝結果；確認預發 App 無法污染正式 DB 或登入項。 |

### 9.1 建議重排開發順序與嚴格的階段出入口

原 A/B/C/D 可作為交付摘要，但實際 coding 任務應依以下先後，避免 UI 先行掩蓋安全基礎：

| 階段 | 產物 | 必通過的 gate |
|---|---|---|
| 0. 契約與測試基座 | ServiceOwner、DB compatibility、runtime manifest、OperationCoordinator、合成資料與假 home/Agent | 狀態機、恢復/不變條件單元測試全綠 |
| 1. Runtime spike | App/Node/worker/Web/MCP/hook 封裝，無 Node 離線測試 | 各候選平台實測 SQLite/FTS5、MCP stdio、hook、大小與閒置資源；選出封裝方式 |
| 2. 安全最小桌面 | Electron main、單例、tray、唯讀 preflight、API child、repair window | 不開錯 DB、不雙開、不依賴 browser 才能修復 |
| 3. Agent 整合 | 非互動 plan/apply/compensate，固定 launcher，來源辨識 | host 真正 handshake、hook fail-open、更新後 runtime 不失效 |
| 4. 接管與改設定 | OS service adapter、管理者轉移、換 port、設定日誌 | 手動/外部服務不被 kill；每一中斷階段可恢復 |
| 5. 自動更新與 schema | 固定發布鏈、簽章驗證、DB migration/restore 屏障 | 簽署的 N→N+1、篡改拒絕、斷電復原演練 |
| 6. 平台發行 | macOS/Windows/Linux 分開簽署與真正安裝包測試 | 只公開完成對應 gate 的 OS/架構，其他平台仍可用 CLI |

不得用 mock 服務管理器／fake Agent 的成功取代最後的 OS/host 實測。CI 用 fake home 的測試是必要條件，**不是**充分條件。

### 9.2 發行阻斷的定量／可觀察證據

以下每一測試保存：OS build/CPU 架構、App/Node/Electron/updater 版、安裝包 SHA-256、DB 身分與 schema、operation ID、舊／新服務狀態、測試輸入、實際輸出、日誌遮蔽結果、復測連結。[D]

- `G-DB-01`：多來源 DB／相同路徑不同檔案／symlink swap／外接裝置卸載，都不會默默產生新 DB；read-only 預覽不因 `-wal/-shm` sidecar 造成未預期的資料破壞。
- `G-DB-02`：舊 API/stdio MCP 閒置中進行 schema 升級，必須被阻擋或在契約上可靠拒寫；模擬中斷後可識別最後 DB 版本。
- `G-DB-03`：已提交 Session 留在 WAL、磁碟滿、read-only、備份途中斷電；備份驗證/restore 不丟已提交資料且不覆蓋唯一可恢復庫。並驗 bundled Node 的 SQLite 版本／WAL-reset 修補證據，搭配多程序 WAL 寫入與 checkpoint 壓力測試。
- `G-SVC-01`：舊 OS 登入服務與桌面同時存在；不 kill 未授權程序，管理權只能有一位有效 owner，失敗可回 external/repair。
- `G-SVC-02`：多次點 App、兩個瀏覽器分頁同時重啟、重送 operation ID、服務 crash/睡醒；沒有第二 listener 或孤兒 process。
- `G-MCP-01`：無 Node、App 已退出、App 升級中、Windows runtime 檔案遭鎖，bundle SQLite 版本經驗證，已連結 Agent 仍正確 `initialize`、`tools/list`，更新契約時明確要求重連。
- `G-SEC-01`：惡意 Origin/Host、本機 curl 假冒 headers、跨 port session、重播/過期 token、XSS/URL injection、任意設定路徑，未授權高權限操作皆無副作用。
- `G-UPD-01`：同一簽名管道的 N→N+1 真實安裝，manifest 篡改/錯 key/錯架構/版本回退皆拒絕，失敗可透過 app 以外的修復路徑救回。
- `G-UX-01`：安裝→選 project→連 Agent→真實記錄；鍵盤、繁中/英文、深淺色、無 tray 場景仍能完成或修復。

**以上是門檻規格，不是目前已通過的測試結果。**

### 第一版驗收案例

以暫存 home、假 Agent 根目錄和合成 DB 執行自動化。真人驗收使用測試帳號、實際安裝檔及真實 OS 服務管理器，記錄版本、架構、案例、預期／實際值、失敗日誌與復測結果。下表是待執行案例。

| 測試群組 | 至少必測的情境 | 通過條件 |
|---|---|---|
| 安裝與引導 | 乾淨機、離線、非管理員、中文／空格路徑、無 Agent、跳過設定、中途取消、重開及重裝 | 可完成首次開頁；可略過／續做；全程不要求 pnpm。沒有產生未授權的整合或追蹤記錄。 |
| 既有使用者 | checkout／standalone／plugin link、自訂 DB 與備份、兩個 checkout、外接碟、舊服務執行／停止／停用、手動 start | 前後比較同一 DB、既有專案 ID、Session 數與備份清單。登入後恰一個管理者。失敗可回舊服務或進明確的相容性復原。 |
| Agent | 各宿主首次連接、plugin 與手動並存、自訂 roots、停用／未信任 hook、宿主未裝、設定衝突、部份寫入失敗 | 一個 Agent 僅有預期註冊，保留原設定；可修復／撤銷。App 關閉、換 port、更新後從真實 Agent 做 stdio 握手，在合成追蹤專案完成讀寫並於 Dashboard 核對。 |
| 背景與控制 | 快速連點、多分頁同時操作、關頁、手動退出、登入、睡眠喚醒、OS 結束、主／子程序崩潰、系統無預設瀏覽器 | 無重複 listener、無失控重啟或孤兒程序。手動開啟與登入有各自正確的開頁行為，修復入口可用。 |
| Port 與重啟 | 假冒 health、其他帳號／軟體占 port、預檢後被搶占、原 port 也被占用、SSE、長時間備份、操作途中關頁或斷電 | 原操作只執行一次。可回到有效 port 或由 tray 修復，不殺外部程序。不遺失已提交寫入。 |
| Web 管理安全 | 惡意 Origin／Host、跨 port 憑證重用、過期授權、重播、跨站表單、手輸網址、任意檔案及更新 URL 注入 | 未授權操作無副作用；管理憑證不進日誌，原本支援的非桌面 API 行為有回歸測試。 |
| 資料與復原 | DB 不可寫／遺失、磁碟滿、WAL 有已提交寫入、舊／較新 schema、備份鎖定、Agent 持續寫入、設定檔毀損 | 不誤開空庫，備份失敗不遷移；可從診斷找到原檔及復原步驟。用還原樣本核對內容與完整性。 |
| GitHub 更新 | 無新版、忽略預發版、離線／限流、下載中斷、錯架構、錯誤簽章、安裝無權限、更新中強制退出、N → N+1 | 下載可重試；不接受錯版或偽造檔。成功以執行版本為準。失敗仍可用舊服務或修復安裝包，資料可驗證。 |
| 解除安裝與可用性 | 用過整合後移除、使用者已手改 hook、重裝、舊服務交回、鍵盤／螢幕閱讀器、兩種語系與佈景 | 可辨識每項設定是否保留或移除，重裝讀回原資料。主要流程僅用鍵盤可完成，錯誤有動作可選。 |

**公開發行門檻。** 維持現有 repo 的品質、E2E 與 release 檢查，另驗證本次要上傳的桌面安裝包及更新 metadata。Release 先暫存全部 OS／架構產物，確定完整且可驗證才一次公開，避免使用者先收到缺附件的更新。任一宣告支援的平台發生資料遺失、錯庫、未授權改設定、無法由正式安裝包升級、背景重複啟動或服務掛掉後無修復入口，即停止該版公開發行。[專案發行驗收清單](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/docs/release-checklist.md)

**進入實作前要定案的三件事。** 確認首發平台與可提供的簽章身分；用實際安裝包決定共用 Node runtime 的配送方式；以舊服務加現役 Agent 的合成環境證明資料庫接管、schema 遷移與失敗還原能成立。其他設定的預設行為已列在上表，可直接作為第一版設計審查依據。


## 10. 跨程式契約：工程規格草案（新增，P0）

### 10.1 `DesktopSettingsV1`（不與舊 Agent 設定混用）

以下為**語意草案**，JSON 例子僅示意欄位，不是已實作檔案格式：

```json
{
  "configVersion": 1,
  "installId": "generated-per-user-install-id",
  "desired": {
    "databasePath": "/absolute/path/work-intelligence.sqlite",
    "port": 3210,
    "launchAtLogin": false,
    "backupDirectory": "/absolute/path/backups"
  },
  "active": {
    "databaseIdentity": "opaque-verified-identity",
    "port": 3210,
    "runtimeVersion": "validated-runtime-id",
    "serviceOwner": "desktop"
  },
  "lastKnownGood": {
    "databaseIdentity": "opaque-verified-identity",
    "port": 3210,
    "runtimeVersion": "validated-runtime-id"
  }
}
```

規則：

- `desired` 可能尚未生效，絕不可顯示成「目前使用中」；`active` 是完成 IPC/API/schema 驗證後提交的結果。
- `installId` 不能當授權密鑰；存放路徑及其 ACL 是另一層安全問題。
- `databaseIdentity` 是待確認的策略，不應直接用純路徑或專案數。若要新增 DB 內 UUID 必須避免預覽舊庫時寫入；可以新庫建立時產生、舊庫在授權 migration 才補上，並搭配檔案身分／schema 確認。
- `runtimeVersion` 不能只用 marketing 版本字串；應綁定 build hash、runtime binary/node 能力與 package manifest。
- 設定格式升級要支援讀舊版本與 fail-closed；設定壞掉時優先修復，不得開空庫。

### 10.2 `RuntimeManifest` 與 launcher

```json
{
  "manifestVersion": 1,
  "activeRuntimeId": "1.6.x-buildhash-os-arch",
  "allowedActions": ["mcp", "codex-finalize-reminder", "claude-finalize-reminder"],
  "targetDatabaseIdentity": "opaque-verified-identity",
  "targetDatabasePath": "/absolute/path/work-intelligence.sqlite",
  "files": [
    { "relativePath": "node/bin/node", "sha256": "sha256-of-shipped-file" },
    { "relativePath": "mcp/index.js", "sha256": "sha256-of-shipped-file" }
  ]
}
```

- manifest 及 binary 位於安裝者預期的使用者可控目錄，但要檢查檔案所有權／ACL，尤其不能被其他 OS 使用者更改。路徑與 hash 範例不是建議固定字串。[D]
- launcher 必須在讀 manifest 後驗證檔案、schema 與必要的 action，並採 `exec`/`spawn` argv 模式，禁止 shell interpretation；秘密不放 CLI argv 或記錄中。
- 更新時先安裝新 runtime、驗證完整性，再 atomically 切換 manifest；舊 runtime 的清理由「無現役連線＋可安全刪除」共同決定，不能僅以 PID 不存在作準（可能重用）。
- 外部 plugin/MCPB 的 launcher 不一定由本 App 管理；絕不強制替換。舊 plugin 仍可維持原 checkout 行為，但 desktop setup 必須顯示其不同 DB／runtime 來源。

### 10.3 `BackendReady` 與管理 IPC

```json
{
  "protocolVersion": 1,
  "type": "ready",
  "runId": "per-spawn-unpredictable-id",
  "port": 3210,
  "appVersion": "1.6.x",
  "buildHash": "sha256-of-bundle",
  "schemaVersion": 31,
  "databaseIdentity": "opaque-verified-identity"
}
```

這個例子的 schema/version **只供欄位形狀示意，不宣稱目前正式 schema 值**。child/parent 的 protocol version 不合時進 `NEEDS_REPAIR`；不能退回使用無身分證明的 HTTP health。唯有 parent 啟動當次建立的受控 IPC handle，才可提交管理權。HTTP `/api/health` 是就緒輔助而非身分授權。

### 10.4 DB 協調與相容性矩陣

實作前必須針對「**已連線的舊版 MCP**」做一個小型實驗：在兩個 Node 程序同時連到 WAL SQLite，讓舊 MCP 長連線保持閒置，另一個 process 複製快照並執行 schema migration，然後觸發舊 MCP 工具寫入。記錄 schema version、回應、SQLite 例外與是否誤寫，證明具體攔截位置。

候選方案（尚未定案）：

1. 所有受支援的 MCP 寫入 API 在每次交易邊界讀取 schema epoch/capability；不符合即拒絕（對新版受控客戶端可靠）。
2. schema-breaking migration 要求**已知**連線完成並退出，並以桌面維護態阻擋從固定 launcher 新開舊 MCP；對未知外部 client，不能假設有權強制中斷。
3. 若無法安全排除外部寫入端，將更新分成「安裝 App」與「稍後升級資料庫」，暫時維持原相容 backend 或修復模式；絕不可自行硬升 DB。

驗收以新/舊 CLI、standalone、Codex plugin、Claude Code plugin、MCPB、未經 launcher 的手動 stdio 設定各跑一次。**方案 1 與 2 並非萬靈丹；要用實際程序組合證明可靠性。**

## 11. 風險清冊（新增；含阻斷級別）

`P0`：可能遺失或誤操作資料、無授權權限提升、無法修復的更新／接管失敗；公開發行前必須驗證。`P1`：嚴重功能可靠性、可用性或相容性問題；支持的平台必須解決。`P2`：改善體驗與維運，可排入後續版本。這是設計風險優先序，**不是已偵測到的 bug 計數**。

| ID | 級別 | 風險／觸發 | 預防、偵測與復原 | 對應 Gate |
|---|---|---|---|---|
| R01 | P0 | 多 DB／舊 config 衝突，預設連到空庫 | 唯讀候選來源、身份重驗、手動選擇、禁止 error fallback | G-DB-01 |
| R02 | P0 | server `listen` 失敗前已觸發 DB migration | 在 `WorkIntelligenceStore` 前做完全唯讀 preflight，重新校驗 | G-DB-01/G-SVC-01 |
| R03 | P0 | 已開舊 MCP 在 schema 升級後再寫入 | schema capability/epoch 契約、維護窗口、實測拒寫 | G-DB-02 |
| R04 | P0 | 錯誤備份／手動複製漏 WAL | 重用 VACUUM INTO + staging + snapshot integrity 驗證 | G-DB-03 |
| R05 | P0 | 接管時殺掉另一個 checkout／使用者服務 | OS service 身分、runner/port/DB 多證據；陌生程序不 kill | G-SVC-01 |
| R06 | P0 | 接管已 migration 卻自動恢復舊服務 | phase journal，DB schema 相容才允許回復 | G-SVC-01/G-DB-02 |
| R07 | P0 | 無 Node 環境 Agent MCP 失效 | bundle Node + fixed launcher，App 退出獨立運作 | G-MCP-01 |
| R08 | P0 | 更新刪除使用中的 runtime（Windows 鎖） | 版本化 runtime 與延後 GC，manifest 原子切換 | G-MCP-01 |
| R09 | P0 | 本機網站偽造管理 API 請求 | 精確 host/origin、短期授權、CSRF、native confirmation | G-SEC-01 |
| R10 | P0 | 同機程序偽造 Origin/Host 使用管理 API | 不只靠 CORS/Origin；需要能力憑證與私有 IPC | G-SEC-01 |
| R11 | P0 | 更新 manifest 被替換，只有 hash 無來源可信性 | 鎖工具版本，metadata 簽署或禁用不安全自動更新 | G-UPD-01 |
| R12 | P0 | 資料庫 restore 覆寫活躍 DB 或遺失新 Session | 停寫入端、保存目前快照、明示資料損失窗口 | G-DB-03 |
| R13 | P0 | 被竄改 runtime/launcher 或設定路徑 | 只允許受信任 manifest、ACL、checksum、絕對路徑 | G-MCP-01/G-SEC-01 |
| R14 | P0 | 更新成功但新後端無法啟動且修復入口也壞 | App-independent repair installer、tray 修復、分階段提交 | G-UPD-01 |
| R15 | P1 | Agent plugin + manual 重複 tools/hooks | 分來源偵測、plan preview、按所有權修復 | G-MCP-01 |
| R16 | P1 | 使用者在 plan 之後改 Agent 設定 | apply 前逐項指紋重驗，不覆蓋外部異動 | G-MCP-01 |
| R17 | P1 | 多檔案 Agent 設定只套用了一部分 | 操作日誌、補償回復、每項驗證，必要時人工衝突修復 | G-MCP-01 |
| R18 | P1 | Linux tray 不可用／Windows 登入任務無視窗 | 再次開啟 App 的 repair window、清楚 UX、實機驗收 | G-UX-01 |
| R19 | P1 | port 競態與健康檢查誤辨身分 | IPC runId + DB identity + HTTP readiness，多層驗證 | G-SVC-02 |
| R20 | P1 | Browser 切 port 失去 preferences 或管理 token | 白名單搬非秘密偏好、重新授權、不跨 origin 復用 | G-SEC-01 |
| R21 | P1 | OS session-end 時自動安裝中斷 | 受控安裝時機、外部修復包與逐平台測試 | G-UPD-01 |
| R22 | P1 | SQLite 放在 SMB/NFS／同步資料夾 | 偵測疑似不支援環境、禁止自動 upgrade/restore、顯示理由 | G-DB-03 |
| R23 | P1 | 資料源 path 被 symlink 替換／TOCTOU | 預覽與提交前重驗 realpath/OS file identity | G-DB-01 |
| R24 | P1 | 停 App 後 MCP 還寫入，使用者誤認每日備份仍運作 | 退出提示及備份最後成功時間，允許 user opt-in login service | G-UX-01 |
| R25 | P1 | Browser 或 local API 不隔離其他 OS 帳號 | 安全設計議題、跨使用者測試與相容性政策 | G-SEC-01 |
| R26 | P1 | macOS App 從 DMG 執行，無法安裝更新 | 開始時檢測 app 位置、導引移至 Applications | G-UPD-01 |
| R27 | P1 | Windows NSIS uninstaller 清掉未管理的資料 | 卸載只移除 app-owned entries，DB/backup 保留 | G-UX-01 |
| R28 | P1 | 陳舊 Agent skill／MCP schema 顯示為已就緒 | 實際 host handshake、版本契約與 re-connect 狀態 | G-MCP-01 |
| R29 | P1 | 設定檔半寫入或無法解析時視為全新安裝 | atomic replacement + recovery copy + repair mode | G-DB-01 |
| R30 | P1 | 機器關機、睡眠、斷電導致 operation phase 與真實狀態不同 | 恢復時重讀 OS/DB/manifest 並重建狀態；不只依賴 journal | G-SVC-02/G-UPD-01 |
| R31 | P2 | 安裝包肥大、冷啟慢、閒置記憶體高 | A 階段原型比較標準 Node 與 utilityProcess；記錄基準 | G-UX-01 |
| R32 | P2 | 完整診斷匯出洩漏個資路徑／secret | 預覽、掃描、遮蔽、手動匯出，不自動上傳 | G-SEC-01 |
| R33 | P0 | bundled Node 的 SQLite 未修補 2026 WAL-reset 競態，可能導致 DB 損毀 | 發行產物檢查 `sqlite_version()` 與 backport 證據；多程序 WAL 壓力與還原測試 | G-DB-03/G-MCP-01 |
| R34 | P1 | 唯讀 DB 預覽在 WAL 中建立 `-shm/-wal` 或誤用 `immutable=1` | 檔案系統副作用測試；不刪 sidecars、不對活躍 DB 使用 immutable | G-DB-01 |

R01–R14 與 R33 如設計契約未通過，**不得宣稱 V1 可公開自動更新／接管舊資料**。R15–R30 與 R34 對宣告支援的平台須有通過案例或明確關閉相關功能與發行聲明。

## 12. 借鑑 GitHub 開源實作：有證據的採用與不採用（新增）

### A. Actual Budget — 設定落盤、後端程序、E2E

- **可查證**：[`actualbudget/actual/packages/desktop-electron/index.ts`](https://github.com/actualbudget/actual/blob/master/packages/desktop-electron/index.ts) 包含 `global-store.json` 的暫存檔替換、備援 `.bak` 和錯誤復原（約 166–293 行），以及 `utilityProcess.fork()` 啟動 loopback Sync Server（約 383–488 行）。[`security.ts`](https://github.com/actualbudget/actual/blob/master/packages/desktop-electron/security.ts) 限制 webview、navigation 與 permission；[`e2e/navigation-security.test.ts`](https://github.com/actualbudget/actual/blob/master/packages/desktop-electron/e2e/navigation-security.test.ts) 對外部連結和 redirect 做了 Electron E2E；[`e2e/startup-errors.test.ts`](https://github.com/actualbudget/actual/blob/master/packages/desktop-electron/e2e/startup-errors.test.ts) 驗證資料目錄無法使用時的修復 UI。[U]
- **適用**：Work Intelligence 的 desktop settings 持久化、主程序／子程序就緒、修復畫面、導航安全與真實壞掉的檔案系統 E2E。[D]
- **不要照抄**：Actual 的同步後端可由 Electron 管理，但本專案的 **stdio MCP 必須在 Electron 退出後仍能由 Agent 啟動**，因此需要另一條標準 Node + fixed launcher 路徑；另外對 DB 路徑與 owner 的關鍵 config，落盤失敗要更偏向中止而非就地覆寫。[D]

### B. Rancher Desktop — tray 顯示真實背景狀態

- **可查證**：[`rancher-sandbox/rancher-desktop/pkg/rancher-desktop/main/tray.ts`](https://github.com/rancher-sandbox/rancher-desktop/blob/main/pkg/rancher-desktop/main/tray.ts) 用獨立 Tray 類別管理後端狀態、網路狀態、選單中的 Dashboard／偏好設定／結束操作。[U]
- **適用**：tray 不只是「一個圖示」，它應反映 `STARTING/MANAGED/EXTERNAL/NEEDS_REPAIR` 等真實狀態，並用明確可用／禁用項目避免錯誤操作。[D]
- **不要照抄**：Rancher Desktop 是 VM/container 背景服務，與 Work Intelligence 的 SQLite/MCP 所有權不同，**不能拿它的 backend kill 或服務策略作為 SQLite 接管證據**。[D]

### C. electron-userland/electron-builder — 更新 metadata 真實驗證

- **可查證**：[`electron-builder` v27 signed update manifests](https://github.com/electron-userland/electron-builder/blob/master/website/docs/features/signed-update-manifests.md) 對 Ed25519 metadata 簽名、公鑰嵌入、key rotation 和 `verify` 有詳細規格。官方 [`Auto Update`](https://www.electron.build/docs/features/auto-update/) 提到 session-end 時 on-quit install 中斷的風險與 newer updater 的安裝時機策略。[U]
- **適用**：CI 生成完整帶簽章 release、正式安裝包內公鑰、故意破壞 manifest 測試，以及已發行版本的公鑰輪替測試。[D]
- **版本陷阱**：官方 [`Security & Hardening`](https://www.electron.build/docs/features/security/) 在本審查時明示 v27 是 *next*；**不可把 v27 特性寫成 v26 已有**，先鎖版本再下 API 可用性的結論。[U]

### D. Electron 官方 — 單例、修復視窗與 IPC 的安全底線

- [`app.requestSingleInstanceLock()`](https://www.electronjs.org/docs/latest/api/app) 與 `second-instance` 是同一 App 多開時的機制，**不是**偵測所有外部 API/checkout 程序的機制。[U][D]
- [`utilityProcess`](https://www.electronjs.org/docs/latest/api/utility-process) 可作為受 Electron 管理的後端子程序候選，但不滿足「GUI 關閉後 Agent stdio 能自行啟動」的要求。[U][D]
- [`Electron Security Checklist`](https://www.electronjs.org/docs/latest/tutorial/security) 要求 context isolation、sandbox、Navigation/IPC sender 驗證及限制外部 URL。修復視窗應只載入封裝資源，而非把任何瀏覽器網址當成管理 UI。[U][D]

### E. SQLite 官方 — WAL 與一致快照的事實基礎

- [`Online Backup API`](https://sqlite.org/backup.html) 說明線上快照的機制，並承認 `VACUUM INTO` 是可行替代方式；[SQLite WAL](https://www.sqlite.org/wal.html) 說明 WAL 的本機共享記憶體與網路 FS 限制；[`PRAGMA integrity_check`](https://www.sqlite.org/pragma.html) 不能取代 `foreign_key_check`。[U]
- **適用**：重用現有 `backup.ts`，補上「備份之後真的能還原」「migration/restore 不對活躍 DB 直接覆寫」的實機驗證。[R][D]

**借鑑原則**：只擷取小而清楚的機制，保留各專案 licence 聲明；若真正複製開源程式碼，必須再確認對應檔案的 license、相依套件及再散布義務。本稿只研究模式，未引入外部程式碼。

## 13. 工程拆票與依賴關係（新增）

| Epic / Task | 產出邊界 | 相依 | 完成證據 |
|---|---|---|---|
| E0-01 DB source resolver | 唯讀候選、path 來源、身份、衝突策略 | 無 | synthetic old checkout + standalone + plugin 流程 |
| E0-02 compatibility gate | schema/epoch/agent runtime contract | E0-01 | old MCP stale-write 測試 |
| E0-03 owner protocol | ServiceOwner state machine、operation journal、test doubles | E0-01 | 不會 kill external，操作重送等冪 |
| E1-01 packaging spike | 標準 Node、server/web/MCP/worker/skill 打包 | E0-02 | 無 Node 離線 FTS5 + MCP + backup |
| E1-02 launcher prototype | per-user 固定入口、versioned runtime manifest、驗證 | E1-01 | App 退出、runtime 更新中仍可 MCP |
| E2-01 Electron shell | tray、single instance、login item、repair view | E0-03,E1-01 | GUI crash/再開修復成功 |
| E2-02 child lifecycle | preflight、IPC ready、graceful drain、port | E0-01,E0-03 | 不開錯庫／不雙啟／關閉可驗證 |
| E2-03 secure control | management auth、native confirm、threat tests | E2-01,E2-02 | CSRF / fake host / replay 測試 |
| E3-01 Agent adapters | 共用 plan/apply/verify/compensate | E1-02 | Codex/Claude host 實際握手 |
| E3-02 desktop dashboard bridge | Agent 調度現在實際 port，不自啟 checkout server | E2-02,E3-01 | 換 port／App 離線後開頁測試 |
| E4-01 takeover | OS service adapters、external mode、journal recovery | E2-02,E3-01 | 服務交接中斷/撤銷矩陣 |
| E4-02 migration/restore gate | 維護模式、backup snapshot verification | E0-02,E4-01 | stale MCP/磁碟滿/斷電測試 |
| E5-01 signing/release pipeline | 平台簽章、公證、manifest sign/verify、CI staging | E1-01,E4-02 | 真實安裝包 N→N+1 |
| E5-02 repair & uninstall | 失敗修復、解除桌面整合、保留資料 | E2-01,E5-01 | 破壞安裝/OS uninstall 驗收 |

**CI 分層**：純邏輯 unit → 包裝好的 runtime smoke → fake home/Agent integration → Electron Playwright E2E → 實際 OS service/host 測試 → 正式簽署的 N→N+1 release install/repair 測試。任何佔用使用者真實 `$HOME`、真實 Codex/Claude 根目錄或預設 3210 的自動化測試必須改為隔離環境，不觸碰使用者的實際工作庫。

## 14. 待決策問題、非目標與封版檢核（新增）

### 14.1 進入首輪 coding 前須定案

| 問題 | 目前建議 | 驗證方式 | Owner |
|---|---|---|---|
| 是否先支援 macOS 再 Windows？ | 有合適簽章/公證能力者先發，Windows 另 gate | 兩平台完整安裝／更新／修復紀錄 | 產品＋發行 |
| Node runtime 如何帶進 App？ | 優先標準 Node + versioned resources，不仰賴 Electron GUI | Node/FTS5/worker/MCP/size/Windows lock 基準 | Runtime |
| DB 身分定義與變更屏障？ | 正規化路徑＋OS 檔案身分＋DB 自身 identity，實測 old MCP | 長連線 schema change、restore race | Storage/MCP |
| 管理授權如何與普通 API 隔離？ | 限時只讀可見性分級、native high-risk confirmation | curl 假 headers、Web XSS、cross-user | Security/Web |
| 自動更新是否要在 V1 宣告？ | 若 metadata 可信驗證未成，先只提供手動下載官方安裝包 | 鎖工具版與篡改測試 | Release |
| 外部管理模式是否只提供連結？ | 是；不控制無法證明身分的服務 | 接管混合安裝／多 checkout | Desktop |

### 14.2 非目標

多 DB 同時切換／合併、遠端 API 管理、雲端同步、重新設計報表/搜尋、Agent 自主安裝或修改其他專案 hooks、強制替換 plugin/MCPB、全面管理其他 OS 使用者的服務、內嵌完整 Dashboard、服務常駐的外部 daemon 架構，均非桌面 V1 範圍。若新增，必須另經設計審查與資料安全評估。

### 14.3 封版 checklist

- [ ] 鎖定 repo commit、Electron/Node/electron-builder/electron-updater 版本與其 license。
- [ ] 規格 0 的七條 invariants 有自動測試映射。
- [ ] DB source/identity/TOCTOU/多來源衝突矩陣通過。
- [ ] 舊 MCP 於 schema migration/restore 期間的寫入已被實測安全阻斷。
- [ ] 無 Node、GUI 退出、Agent/MCP/hook launch、Windows runtime lock 測試通過。
- [ ] OS service ownership、切換、失敗回復、正常退出不重啟測試通過。
- [ ] 本機控制 API threat model（包含非瀏覽器本機程序）測試通過。
- [ ] App 修復視窗不依賴 Web/API 存活，OS 無 tray 下仍可進入。
- [ ] 備份可檢驗且可還原，schema 升級與失敗回復不覆蓋唯一副本。
- [ ] 發布 metadata/安裝包具對應工具版本的實際可信驗證機制。
- [ ] 每個公開 OS/架構都使用**同一批欲上傳**正式簽章安裝包完成 N→N+1 與解除安裝演練，並輸出 `sqlite_version()` 修補證據。
- [ ] CLI/standalone/plugin 不安裝桌面 App 也能按既有方式使用。
- [ ] Release 來源、更新 key rotation、發行失敗停止派送與修復安裝包程序就緒。

## 附錄：審查的具體程式碼／外部文件索引

### Repo 基準（2026-11-15 審查，不代表未來 main 一定相同）

- Commit：[WorkLog.Ai `7723b72ace79`](https://github.com/Ponpon55837/WorkLog.Ai/commit/7723b72ace798476bc347ca99ca90503980759d2)。
- 資料庫啟動：[apps/server/src/start-api.ts](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/apps/server/src/start-api.ts)（建構 store 在 listen 前）。
- DB 位置：[packages/shared/src/database-location.ts](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/packages/shared/src/database-location.ts)。
- DB 預覽：[apps/server/src/database-inspection.ts](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/apps/server/src/database-inspection.ts)（readOnly metadata）。
- 初始化與 migration：[packages/storage/src/database-initialization.ts](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/packages/storage/src/database-initialization.ts)；[schema-migrations.ts](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/packages/storage/src/schema-migrations.ts)。
- 備份：[packages/storage/src/backup.ts](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/packages/storage/src/backup.ts)（`VACUUM INTO`＋staging）。
- Agent plan/apply：[apps/server/src/agent-setup.ts](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/apps/server/src/agent-setup.ts)。
- Dashboard 啟動：[scripts/dashboard.mjs](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/scripts/dashboard.mjs)（HTTP health 探測）。
- API 安全：[apps/server/src/server.ts](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/apps/server/src/server.ts)；子程序關閉：[shutdown.ts](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/apps/server/src/shutdown.ts)。
- 平台登入：[apps/server/src/user-service.ts](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/apps/server/src/user-service.ts)；[docs/service.md](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/docs/service.md)。
- standalone、Agent/plugin、發行：[standalone.md](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/docs/standalone.md)、[agent-setup.md](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/docs/agent-setup.md)、[plugins.md](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/docs/plugins.md)、[release.md](https://github.com/Ponpon55837/WorkLog.Ai/blob/7723b72ace798476bc347ca99ca90503980759d2/docs/release.md)。

### 外部參考（版本/行號可能變動，採用前應鎖 commit）

- Actual Budget：[Electron entry](https://github.com/actualbudget/actual/blob/master/packages/desktop-electron/index.ts)、[security](https://github.com/actualbudget/actual/blob/master/packages/desktop-electron/security.ts)、[navigation-security E2E](https://github.com/actualbudget/actual/blob/master/packages/desktop-electron/e2e/navigation-security.test.ts)、[startup-errors E2E](https://github.com/actualbudget/actual/blob/master/packages/desktop-electron/e2e/startup-errors.test.ts)。
- Rancher Desktop：[Tray](https://github.com/rancher-sandbox/rancher-desktop/blob/main/pkg/rancher-desktop/main/tray.ts)。
- electron-builder：[signed manifest](https://www.electron.build/docs/features/signed-update-manifests/)、[v27 migration](https://www.electron.build/docs/migration/v27-build-changes/)、[auto-update](https://www.electron.build/docs/features/auto-update/)、[Security & Hardening](https://www.electron.build/docs/features/security/)。
- Electron：[app single instance](https://www.electronjs.org/docs/latest/api/app)、[utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)、[security](https://www.electronjs.org/docs/latest/tutorial/security)。
- SQLite：[backup](https://sqlite.org/backup.html)、[WAL（含 2026 WAL-reset 修補）](https://www.sqlite.org/wal.html)、[SQLite 3.51.3 修補紀錄](https://sqlite.org/releaselog/3_51_3.html)、[URI immutable 注意事項](https://www.sqlite.org/uri.html)、[PRAGMA](https://www.sqlite.org/pragma.html)。

**審查結論**：可保留現有桌面版產品方向，但需先完成 DB 身分與 schema 相容契約、受控服務身分、Agent 獨立 runtime、管理 API 授權、可信更新管道五大 P0 合約，才適合分工實作。外部開源案例只支持具體模式，不能代替本專案在各支援平台做完整系統驗證。


---

**文件控制說明：** R3 係以使用者提供的 R2 全文整理為工程實作前設計基線，新增執行摘要、決策順序及格式統一；保留 R2 原有風險項目、驗收 Gate 與參考來源。本文不代表 repository 已套用任何變更，亦不代表自動更新、平台支援或安全測試已通過。
