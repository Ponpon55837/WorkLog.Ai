# Work Intelligence 桌面版 V1：正式設計規劃與全面風險盤查（R4）

**狀態：工程實作前設計基線（未通過實機驗收）；修訂日期：2026-11-16；文件版本：R4；基準 commit：`d464ea5`（main，1.6.40，Merge PR #361）；目標修補版：1.6.41。** 除標示 `[R]` 或「現況已確認」的部分，流程、功能與門檻仍為**待實作／待驗證的要求**。

配套文件：[風險・Gate・工程票對應](desktop-v1-risk-gate-ticket-matrix.md)（R01–R34 全表）、[元件契約](desktop-v1-component-contracts.md)、[決策紀錄（ADR）](desktop-v1-adr.md)、[索引與 R3→R4 修訂紀錄](README.md)。

---

## 執行摘要與決策結論

**決策：有條件採用原架構，立即開始階段 0／階段 1 的可驗證工程工作；不得直接整包交付完整桌面版，也不得將本稿視為功能已完成。** Electron 管理系統與服務、既有 Vue Dashboard 仍由外部瀏覽器開啟、隨包標準 Node、SQLite 與既有 MCP/CLI 是合理方向。桌面版負責安裝、服務、整合與更新的體驗，不重寫工作記錄與備份核心。

**首發平台（R4 產品決策）：Windows 11 x64 與 macOS 同批發行。** Linux 不在 V1；Windows ARM 排除為推論（待確認）。任一首發平台未通過其完整 gate，整個版本不公開（ADR-02、ADR-03）。

本次以 R3 的審查基準 `7723b72` 為起點，於 `d464ea5` 重新核對關鍵程式碼。盤查 34 項設計風險：15 項 P0、17 項 P1、2 項 P2。**數字代表待防範與驗證的風險項目，不代表已發現 34 個程式 bug。**

### 五個必須先鎖定的跨程式契約

| 優先級 | 契約 | 完成條件（摘要） |
|---|---|---|
| P0 | DB 來源與 schema 相容 | 不開錯庫；不相容的寫入端在 migration／restore 後不得再寫入；備份可還原。MCP 每次寫入的閘門已存在 `[R]`，缺口在 HTTP API 與長駐 CLI 寫入端（§7.3） |
| P0 | 服務管理者與中斷接管 | 不 kill 無法辨識的程序；沒有第二個受管理 listener；接管失敗可查、可修復 |
| P0 | 固定 Agent launcher 與 Node runtime | 不依賴系統 Node 或 Electron GUI；Windows 檔案鎖與更新切換不中斷現有工作 |
| P0 | Web 到桌面管理的安全邊界 | 不能僅依賴 loopback、CORS、Origin；需要能力授權、私有 IPC 與高風險本機確認 |
| P0 | 可信更新與修復 | 鎖定工具版本與簽署機制；正式安裝包 N→N+1 實測；DB 變更不可盲目回退 |

### 發行策略與工程順序

執行順序：階段 0「契約／測試基座」→ 階段 1「無系統 Node 的封裝原型」→ 階段 2「最小桌面管理與修復」→ 階段 3「Agent 整合」→ 階段 4「既有服務交接」→ 階段 5「可信更新及 DB 維護」→ 階段 6「Windows 11 x64 與 macOS 同批發行驗收」。已安裝的舊 checkout、standalone、plugin、MCPB 均不應因新桌面版而被強制改動。

**尚未完成的決策：** Electron／Node／updater 實際鎖定版本、簽章身分與憑證、發行產物內 bundled Node 的 SQLite 版本證據、跨程序 schema 屏障的實測結果、OS 使用者間 API 存取政策（V1 以發行聲明排除，ADR-33）。這些是開發起點或發行前置條件，不能在 UI 文案中當作已支援項目。

**驗收原則：** 只有通過真實 OS、真實 Agent 宿主、實際簽章安裝包、資料備份復原與安全回歸測試的功能，才可以宣稱支援；試作或單元測試通過不得等同發行完成。

---

## 0. 審查範圍、證據與必守原則

### 0.1 本次做了什麼

- **R3 已查證**（基準 `7723b72`）：server 啟動與關閉、DB 位置、唯讀診斷、初始化與 migration、備份、Agent 設定、plugin、服務與 standalone、發行說明；外部案例為 Actual Budget、Rancher Desktop、electron-builder，以及 Electron、SQLite 官方文件。
- **R4 已重新核對**（基準 `d464ea5`，唯讀，未改程式）：
  - `packages/storage/src/store.ts` 的 `withCompatibleSchema()` 與 `apps/mcp/src/server.ts` 寫入工具路徑，錯誤碼 `MCP_RESTART_REQUIRED` `[R]`。
  - `apps/server/src/server.ts` 的 `isAllowedHost()` 只比對 hostname，未比對 port `[R]`。
  - `apps/server/src/folder-picker.ts`：Windows 為 WinForms `FolderBrowserDialog`，macOS 為 `osascript choose folder`，Linux 為 zenity／kdialog `[R]`。
  - `apps/server/src/doctor.ts` 的 `probeSqlite()`；`packages/storage/src/data-revision-cache.ts` 以 `pragma_schema_version` 作快取鍵 `[R]`。
  - `package.json`：版本 1.6.40；`engines` 為 `>=22.16.0 <23 || >=24.0.0` `[R]`。
  - `docs/release-checklist.md` 已有 Windows 原生資料夾選擇、備份還原、Codex hook、登入自動啟動服務等未執行條目 `[R]`。
  - 開發機 Node v22.23.4 的 `node:sqlite` 回報 `sqlite_version()` = 3.53.4，為本機量測 `[T]`（§7.3.1）。
- **未做**：本次修訂未修改程式、未執行完整測試、未產生安裝包、未完成實機與安全滲透測試。1.6.41 的 T1–T4 已提交到分支（commit 見各節），本文凡涉及者標示「**1.6.41 已實作（commit …）**」；實機驗收為「**待實機驗收**」。

**證據標籤**：`[R]` 已從目前 repo 確認；`[U]` 外部官方文件或 GitHub 原始碼可直接支持；`[D]` 本規劃提出的設計決策；`[T]` 須以原型、CI 或實機確認的假設（含僅在開發機量測、尚未進入發行產物者）。標籤定義亦見 [README](README.md)。

### 0.2 七條不可妥協的產品不變條件（Invariants）

1. **資料不因安裝而改變**：未選定來源、未核對 schema、無權限或來源歧義時，不啟動可能建立或遷移資料庫的正式後端。[D]
2. **不假冒管理權**：每位使用者只有一個桌面主程序；不能僅憑 API health、port、PID 或同版本宣稱控制其他程序。[D]
3. **Agent 不依賴桌面 GUI 存活**：由宿主啟動的 MCP／hook 即使 App 關閉也能正常啟動；更新、解除安裝、runtime 清理不得破壞正在執行的 Agent。[D]
4. **無法確認相容就停止危險變更**：schema 變更、restore、寫入端切換一律先驗證並 fail-closed；一般讀取與診斷盡量維持可用。[D]
5. **所有外部設定尊重所有權**：手寫設定、plugin／MCPB 擴充、其他專案與未受控的 OS 服務，不能被無聲取代、刪除或回滾。[D]
6. **管理權限須明確授權**：可看一般 Dashboard 不代表可以管理登入服務、改 DB、安裝更新、寫 Agent 設定或啟動本機命令。[D]
7. **發行聲明只涵蓋通過的安裝包**：源碼測試與 smoke test 不能替代實際安裝、升級、修復、解除安裝驗收。[D]

### 0.3 進入開發前的決策狀態

| 決策 | 設計 | 狀態 |
|---|---|---|
| 桌面框架 | Electron Main 管理系統與服務；Dashboard 仍用外部瀏覽器 | 暫定採用（ADR-01） |
| 首發平台 | Windows 11 x64 與 macOS 同批發行；Linux 排除；Windows ARM 排除（推論，待確認）；macOS 架構範圍待確認 | **產品決策已定（ADR-02）**；實機驗收未完成 |
| runtime | 隨包標準 Node，供後端、MCP、hook 共用 | 待原型實測：大小、FTS5、worker、各平台權限（ADR-04） |
| DB | 沿用既有 SQLite 與 `VACUUM INTO` 備份 | 沿用現況；schema 相容契約為新增要求（ADR-05、ADR-17） |
| 自動更新 | GitHub 固定來源、可信驗證 metadata 與安裝包、失敗可修復 | 待鎖版本；未通過前改為手動下載官方安裝包（ADR-25） |
| Windows 資料夾選擇 | `IFileOpenDialog`（取代 WinForms） | 1.6.41 已實作（commit 1257d3a），實機待實機驗收（ADR-31） |

### 0.4 範圍負面清單

本案**不**替換 SQLite、不重寫 Web/API、不新增外部 SaaS、不導入遠端管理、不強制統一既有 agent plugin 為桌面管理、不預設收集遙測，也不要求 checkout／standalone 使用者安裝 Electron。

**V1 不做，並於發行聲明排除**：Linux 桌面（AppImage、系統匣、登入項）、Windows ARM（推論，待確認）、資料 API（非管理 API）的跨 OS 使用者隔離、多資料庫切換、遠端管理、內嵌 Dashboard 視窗。任何修改涉及資料模型、MCP tool contract 或 CLI 行為時，須有獨立回歸測試與設計變更紀錄。

---

## 1. 使用者裝完後應該得到什麼

使用者下載 Windows 11 x64 或 macOS 的安裝包，點開 Work Intelligence，就能在預設瀏覽器看到自己的 Dashboard。新使用者可以直接選第一個專案，舊使用者可以核對原本的記錄。關閉網頁後，系統匣（Windows 通知區）或選單列（macOS）保留一個圖示；點圖示可再開 Dashboard。即使 Web 服務啟動失敗，圖示也能開啟修復畫面。一般使用流程無須開終端機、安裝 Node.js、尋找 repo 或設定環境變數。

| 操作 | 第一版預期體驗 |
|---|---|
| 手動開啟 App／再次點 App | 同一使用者只啟動一個桌面主程序。就緒後開目前的網址，合併連點造成的重複請求。外部瀏覽器自行決定重用或新增分頁。 |
| 關閉分頁／退出瀏覽器 | API 與每日備份繼續運作。收到瀏覽器斷線或 SSE 中斷不會觸發關機。 |
| 登入作業系統 | 啟用「登入時在背景執行」才啟動，成功時只顯示圖示。手動點 App 仍開啟網頁。 |
| 點系統匣／選單列 | 可開 Dashboard、查看服務狀態、修復設定、結束 App。無法控制圖示單擊行為時，選單第一項固定為「開啟 Dashboard」。 |
| 點「結束 Work Intelligence」 | 關閉桌面管理的 Web/API 和排程，等目前工作收尾再結束。由各 Agent 啟動的 stdio MCP 仍由其宿主管理。 |
| 在 Web 變更設定或更新 | 沿用「系統狀態」頁，顯示生效的 port、實際版本、資料位置與服務管理方式。**只有通過可信更新管道與實機驗收的平台**才提供「下載並更新」；其他情況顯示官方 Releases 的受驗證安裝方式。 |

多資料庫切換、遠端管理與內嵌 Dashboard 視窗留待後續需求。安裝桌面程式不會改變任何專案的追蹤狀態。

### 1.1 「安裝成功」以一筆真實可查的工作記錄為準

**主線成功準則**：乾淨離線安裝包 → 選 DB（或同意建立新庫）→ 開 Dashboard → 由使用者選資料夾並啟用追蹤 → 連接選定 Agent → 完成一筆真實工作並保存 → Dashboard 顯示該 Session。允許跳過 Agent，但此時只能宣稱「Dashboard 已可用」，不能宣稱「Agent 已連接」。

**退出語意**：關瀏覽器不停止 API 與每日備份。「結束 App」停止其管理的 API 與排程；**由各 Agent 自啟的 MCP 仍可讀寫 DB，但 App 的每日備份排程不再執行**。介面需以清楚文字呈現，不得暗示「退出後仍每天備份」（ADR-26）。其他外部管理服務的停止權仍屬原管理者。

**無視窗備援**：圖示不可用（Windows 通知區被隱藏、macOS 選單列圖示被系統設定隱藏、桌面環境異常）時，再次點 App 必須可開啟本機修復視窗；登入背景啟動不能反覆跳出錯誤彈窗。[D]

---

## 2. 沿用現有行為，改變安裝責任

| 目前入口 | 桌面版的對應設計 |
|---|---|
| `bootstrap` 檢查 Node／pnpm、安裝依賴、build `[R]` [scripts/bootstrap.mjs](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/scripts/bootstrap.mjs) | 發行端完成。安裝包攜帶已驗證的 runtime、Web、server、backup worker、MCP 與必要資源；第一次啟動離線也能使用本機功能。 |
| `pnpm start`、`pnpm dashboard` `[R]` [scripts/dashboard.mjs](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/scripts/dashboard.mjs) | 桌面主程序啟動並辨識自己的後端。現有 dashboard script 以 HTTP health 判斷能否開頁，可借用其就緒判斷，但管理程序還要驗證身分。 |
| `pnpm service:install`、`service:restart` `[R]` [docs/service.md](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/docs/service.md) | 桌面版提供登入開關與重新啟動。舊的 LaunchAgent、Windows 排程、systemd 使用者服務有獨立的辨識與接管流程（Linux 不在 V1）。 |
| `pnpm setup:agents`、plugin、保存提醒 `[R]` [docs/agent-setup.md](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/docs/agent-setup.md) | 保留偵測、預覽、備份、衝突處理與按來源移除的語意。standalone 目前沒有 setup 或 service 子命令，桌面設定流程另行接入（`docs/standalone.md`）。 |
| `pnpm check`、Web 首次使用清單 `[R]` [FirstRunChecklist.vue](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/apps/web/src/components/domain/FirstRunChecklist.vue) | 桌面呈現可採取行動的診斷。Web 繼續負責「加入專案、啟用追蹤、連接 Agent、第一筆工作記錄」；桌面精靈處理安裝與接管，兩處讀同一個實際結果。 |

### 2.1 已確認現況與新增接縫

| repo 現況 | 本次桌面化的做法 | 不應該做 |
|---|---|---|
| `[R]` `start-api.ts` 在 `listen()` 前建構 `WorkIntelligenceStore`，可能觸發 migration | 另加**完全唯讀** preflight、來源核准與管理者確認；通過後才派生後端 | 先試開 Web，port 失敗才回頭找 DB |
| `[R]` `database-inspection.ts` 以 `DatabaseSync(...,{readOnly:true})` 做 schema／完整性可選檢查 | 重用其能力，增加來源、檔案身分與錯誤類別；慢速 `integrity_check` 不阻擋一般初次啟動 | 為預覽偷偷開可寫 store |
| `[R]` `database-initialization.ts` 已拒絕較新 schema，並在 migration 前備份 | 加入**跨程序維護窗口**與「已開啟舊 MCP」的版本契約 | 誤以為「啟動時檢查一次」足以保證長期運作的舊 MCP 安全 |
| `[R]` `backup.ts` 使用 `VACUUM INTO`、私有 staging、驗證與 no-clobber 公開快照 | 升級與還原時重用而非複製；以測試樣本驗證 WAL 已提交資料 | 在線複製單一 `.sqlite` 檔作為可驗證備份 |
| `[R]` `agent-setup.ts` 有 `AgentSetupPlan`、`mutations`、conflicts 與安裝 manifest | 擷取為無互動的 plan／apply／verify／compensate 共享 API，保留 CLI 原行為 | Electron 另寫一套 JSON／TOML 字串改寫器 |
| `[R]` `standalone.md` 表明已有不需 pnpm 的 JS bundle，但需要 Node | 延用 bundle，另測 bundled Node 與安裝資源的配合 | 假設 Electron 自帶 Node 能被外部 stdio MCP 直接當作標準 node 使用 |

Desktop 相關 package 應位於獨立界線（建議 `apps/desktop`），核心 `packages/storage`、`apps/server`、`apps/mcp` **不得引入 Electron runtime 作為必要依賴**。共享設定、Agent plan/apply 與 desktop protocol 應以小型純 TypeScript module 表達，並同時測試 CLI 路徑。

---

## 3. 首次安裝與設定

### 3.0 一條短路徑，三種起點

1. **全新安裝。** 開 App 後先做限定範圍的唯讀偵測。歡迎頁顯示「使用預設設定開始」，摘要列出資料位置、本機網址及登入選項，可展開變更，也可選「使用已有的資料庫」。採用預設後立即開 Dashboard。Agent 與保存提醒可現在連接，也可之後從同一設定入口完成。
2. **找到唯一且一致的既有安裝。** 首頁顯示「沿用現有資料」，列出資料庫、備份位置、現有服務與 Agent 來源。若有舊登入服務，提供「交由桌面版管理」及「繼續使用原服務」；後者可開既有 Dashboard，並清楚標示其受外部管理。
3. **發現多個來源或讀不到舊資料。** 並列已知來源、完整路徑、唯讀取得的 schema 與可取得的專案數，標出哪個服務或 Agent 指向哪一份。讓使用者選擇、瀏覽其他位置或稍後處理。磁碟未掛載、權限不足、schema 過新或無法辨識時顯示原因，避免因 fallback 建出空庫。未發現既有來源時仍保留手選入口。

唯讀偵測範圍限於目前使用者的 App 設定、既有服務定義、產品已知 config／plugin link、可辨識的 Agent 整合與使用者明確選的路徑。Finder 或開始功能表啟動時，shell 的 PATH 與環境變數可能缺席；所有路徑都顯示解析後的值與來源。

### 設定清單與預設值

| 設定 | 新安裝預設／舊安裝沿用 | 使用者何時需要操作 |
|---|---|---|
| 資料庫與設定根目錄 | 新安裝採 standalone 的使用者資料目錄。偵測 `WORK_INTELLIGENCE_CONFIG_DIR`、`WORK_INTELLIGENCE_DB`、`WORK_INTELLIGENCE_HOME`、plugin link 與舊服務的實際設定。checkout 與 standalone 的相對路徑各依原規則解析。 | 找到舊資料先展示，來源不一致時選擇。首次設定保存絕對路徑，之後即使 shell 或工作目錄改變，也要開同一庫。 |
| 備份 | 預設在 DB 旁的 `backups/`，沿用現有自動備份與保留規則。匯入既有服務時帶入可證實的目錄、保留份數與自動備份開關。 | 自訂位置不可寫、空間不足或舊值無法辨識時明示。關閉每日備份仍須完成必要的 migration 前備份。 |
| Port／瀏覽器 | 預設 `127.0.0.1:3210`，接管時記住既有 port。使用系統預設瀏覽器。 | 衝突才顯示替代 port 選擇。瀏覽器開啟失敗時提供複製一般網址及重開，不影響服務。 |
| 登入時背景執行 | 新安裝預設關閉。接管有登入服務的舊安裝時，以原有效狀態預填。 | 可於首次摘要或之後切換。顯示作業系統回讀的狀態；若被系統設定禁止，顯示對應修正入口。 |
| 專案與追蹤 | 沿用現有專案清單，以及記錄中、暫停、忽略等狀態。新安裝預設沒有已授權的專案。 | 由使用者在 Web 選資料夾並明確啟用追蹤。安裝程式不代建測試記錄。 |
| Agent／skill／保存提醒 | 逐一偵測 Codex、Claude Code、Claude Desktop，以及手動註冊、plugin、擴充來源。沒有安裝 Agent 也可以用 Web。 | 使用者只選想連接的 Agent，看到會變更的項目後套用；提醒可選。已有設定符合時顯示「沿用」。見 §3.4。 |
| 更新 | 穩定版、固定 GitHub Releases 來源。可手動檢查；新安裝預設在背景低頻檢查版本，離線照常工作。 | 可關閉背景檢查。只有通過簽章、metadata 與實機升級驗收的平台提供 App 內安裝，否則只提示官方下載連結。發現版本時可延後提示，一般退出不會意外安裝。 |
| 進階環境與權限 | 沿用必要的顯式路徑及目前使用者權限。桌面管理限定 loopback。自訂 CORS、開發 Web 路徑等列為特殊部署。 | 特殊部署預設保留外部管理，先列出無法等價轉移的項目。診斷不傾印整份環境或 Agent 設定。 |

路徑解析與備份預設的依據見[資料庫位置規則](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/packages/shared/src/database-location.ts)、[備份與還原](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/docs/user-guide.md)及[既有服務](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/docs/service.md)。

**第一次開啟的畫面順序。** 新使用者在「開始使用」選預設即可進 Dashboard，接著由既有首次使用清單引導「選專案資料夾 → 開啟記錄 → 選要連接的 Agent」。專案選擇可稍後再做。只有勾選 Agent 的人會看到該 Agent 的變更預覽；port、備份保留份數與自訂設定目錄收在進階區。舊使用者的第一個主要按鈕為「沿用這份資料」，寫入前即可看到熟悉的專案名稱。首次設定被中斷時，再次開啟從仍待處理的選擇開始；已確認的資料來源與已完成的 Agent 不必重選。

**典型的既有安裝。** 假設 macOS 登入服務與 Codex plugin 指向 A 資料庫，Claude Desktop 明確指向 B。精靈應列出「開啟 A 可看到哪些專案」「Codex 已指向 A」「Claude Desktop 使用 B」。使用者可先沿用 A 並接管服務，保留 Claude Desktop 的 B 設定；日後選「讓 Claude Desktop 使用 A」才在宿主設定流程中處理。切換指向不會合併 A、B 的記錄。結果頁分別報告服務接管及兩個 Agent 的實際狀態。

### 3.1 來源發現、選擇與開庫的判定演算法（P0）

本稿將「預設沿用」改成可重現的有限狀態程序，不以第一個找到的檔案為答案：

1. **收集候選來源（不寫入）**：桌面已提交設定、使用者顯式選擇、OS 舊服務實際定義、受支援的 plugin link、可安全辨識的 Agent MCP 設定、standalone 預設、checkout 預設。候選須紀錄來源類型、原字串、解析基準、展開後絕對路徑與是否受當前使用者管理。[D]
2. **辨識有效性（不寫入）**：保留 `missing`、`offline`（卸載）、`denied`、`unreadable`、`unsupported-schema`、`ok`、`conflict` 等互不混淆的狀態。唯讀取得的 schema／專案數僅作「預覽」，不能取代 DB 唯一身分。[D]
3. **判定唯一性**：比較正規化路徑、可取得的 OS 檔案身分（POSIX dev/inode、Windows 檔案識別）與 DB 自身識別。**DB 唯一身分策略已於 1.6.42 定案，見 [ADR-36](desktop-v1-adr.md)**：正規化路徑、檔案 ID 與唯讀血統指紋並用，不得僅以路徑字串或專案數判定。[D] Windows 檔案 ID 的實機行為仍待驗證。[T]
4. **選擇**：只有唯一且多來源一致、DB 可讀且 schema 受支援，才能建議「沿用」。有已知衝突、無法證實來源或外接來源遺失時，不自動 fallback 建空庫。新建只能在使用者明確接受的新位置進行。[D]
5. **提交前重驗**：取得明確同意 → 確認目標位置與檔案身分在預覽後未被替換（TOCTOU）→ 確認 port 與服務所有權 → 必要的備份與 schema 前置條件 → 才允許正式後端開啟 DB。[D]
6. **新建 DB**：先檢查父目錄的可用性、容量與權限，明確記錄這是「建立」而非「恢復」。任何失敗都保留使用者已選定的路徑，切勿默默換到另一個預設值。[D]

**設定優先序**：顯式且已提交的桌面選擇 > 使用者當次人工選擇 > 唯一且一致的受支援舊設定 > 新安裝預設。這是「選擇」的優先序，**不是**「遇到錯誤就往下遞補」的 fallback 鏈。桌面端應保存明確的解析後值，並展示來源，而非讀取某次 shell 的偶然值。[D]

#### 3.1.1 唯讀預覽與檔案系統政策

- **唯讀不等於 0 寫入。** SQLite 在 WAL 模式下，即使以唯讀方式開庫，仍可能需要既有的 `-wal`／`-shm` 或在可寫資料夾建立這些 sidecar。「readOnly」是不修改業務資料的意圖；檢測時須以檔案系統監測驗證實際行為，且**未經使用者同意不得刪除或搬動 WAL/SHM**。[U][T]
- **活躍資料庫禁止 `immutable=1`**：它會跳過變更偵測，等於假設資料永不改變。[U]
- **風險來源**：軟連結、硬連結、UNC/SMB/NFS、可移除裝置與會自行同步的雲端資料夾都標示為風險來源。SQLite WAL 官方不支援多主機網路檔案系統上的共享記憶體模式；V1 對不可靠的網路共享 DB **禁止自動接管與遷移**，僅提供診斷與轉存建議。[U][D]
- **1.6.42 觀察（本機 Node 22.23.4／SQLite 3.53.4，`[T]`，非發行產物）**：唯讀開啟已正常關閉的 WAL 資料庫，會在同一資料夾建立並保留 `-wal`、`-shm`；主檔的 SHA-256、mtime 與業務資料列皆不變。另一寫入端持續寫入且 WAL 非空時，preflight 不改變 sidecar，並讀得到只存在於 WAL 中的資料列。因此「唯讀不等於 0 寫入」已確認，預覽不刪除任何 sidecar；Windows 行為待實機驗證。詳見 [ADR-07](desktop-v1-adr.md)。

### 3.2 Agent 整合：安裝、驗證、修復與移除

| 對象 | 桌面設定中心的處理方式 |
|---|---|
| Codex | 辨識 MCP、plugin、canonical skill、legacy skill、hook 檔與 hooks 開關，尊重自訂 `CODEX_HOME`。已啟用 plugin 時沿用該管道。停用、尚未信任或無法確認的 hook 各自說明；需要信任時引導使用者在 Codex 的 `/hooks` 完成。 |
| Claude Code | 辨識使用者層 MCP、plugin、skill 與保存提醒，區分 `CLAUDE_CONFIG_DIR` 與使用者 MCP 的實際設定位置。沿用既有 CLI／註冊邏輯；GUI 的 PATH 找不到 CLI 時可定位程式或先略過。 |
| Claude Desktop | 將既有 MCPB 擴充與手動 stdio 設定視為不同來源。已安裝則核對 DB 位置、宿主 runtime 與版本；未安裝則提供受支援的擴充安裝指引或桌面提供的 stdio 入口，安裝與授權由宿主完成。 |
| 同機多個 Agent | 每個 Agent 各列狀態與有效 DB。允許 A 已連接、B 尚未安裝；同一 Agent 有重複註冊或指向不同 DB 時，先預覽整理方式。保留其他工具與其他專案設定。 |

- **落盤前。** 逐項列出 MCP、skill、hook 將新增／沿用／更新／略過的路徑、作用範圍、原因與 DB。Agent 設定若有語法錯誤、已遭修改或自訂命令無法辨識，只提供檢視衝突與稍後修復。[目前註冊行為 `[R]`](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/docs/agent-setup.md) · [plugin 安裝差異 `[R]`](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/docs/plugins.md)
- **套用與重試。** 每次套用前重新驗證預覽時的檔案指紋，保存原始備份與本次操作清單。以選定的變更集為單位，任一步失敗即撤銷這批已完成且仍由 App 擁有的變更。重開後從實際檔案與操作結果恢復，重試只補缺項；其他程序在其間修改的內容交給使用者檢視。**Agent 設定交易不是 OS 級原子交易**：多檔案寫入無法保證全部同步成功，因此採「計畫 → 指紋重驗 → 備份與原子寫入 → 操作日誌 → 檢查 → 只對仍歸 App 所有且未被外部修改的項目做補償回復」。回復途中發現外部異動即停止並要求人工處理；不宣稱能回滾第三方 plugin 或 MCPB 宿主管理器。[D]
- **不可壟斷外部更新。** 已由 plugin／MCPB 管理的 MCP，桌面只檢查並給出指引，不替它改版本或偷換命令。桌面更新本身不表示 host 會重新載入 MCP 工具清單；MCP 契約更新時須顯示「需重新連線」。[R][D]
- **穩定入口。** 桌面管理的 MCP 與 hook 註冊指向使用者層固定位置的 launcher（§3.3）。hook 遇到不可用的 runtime 應放行 Agent。外部 plugin 與 MCPB 仍由原管道更新。
- **Agent 打開 Dashboard。** 接管後，受支援的 script／skill 從使用者層管理設定找到桌面 App 與已生效的 port，並把開頁要求交給 App（ADR-28）。遷移預覽需指出仍會自行啟動 server 的舊 plugin，提供更新或從 tray 開啟的方式。驗收須包含換 port、退出 App 後從 Agent 開 Dashboard，並確認沒有啟動第二個 checkout server。[現有 Dashboard 入口 `[R]`](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/docs/plugins.md)

Agent 的顯示狀態與最低證據見 §3.2.1；決策見 ADR-14（寫入交易）與 ADR-34（顯示分級）。

#### 3.2.1 Agent 顯示狀態與最低證據

每個 Agent／來源保存 `source`（desktop-managed／manual／plugin／MCPB／unknown）、`effectiveDb`、`launcherKind`、`manifestOwner`、`lastVerifiedAt` 與 `verificationLevel`。**「已設定但未驗證宿主載入」不可顯示為「已連接」。**

| 顯示狀態 | 最低驗證證據 | 下一步 |
|---|---|---|
| 已觀察到連線 | Agent host 的 handshake 或明確檢測（不是只有檔案已寫入） | 可測試真實任務 |
| 已配置、待確認 | 目標設定已寫入且 hash 符合 | 引導重開 Agent 或檢查 MCP |
| 需要信任／授權 | host hook 未信任、CLI 權限待確認 | 在原宿主完成 |
| 外部管理 | plugin／MCPB 或手動來源，桌面無權覆寫 | 只顯示狀態，提供相應入口 |
| 設定衝突 | 同名工具重複、路徑不同、語法錯誤、外部改動 | 先 diff，勿自動修復 |
| runtime 不相容 | launcher／DB／schema 版本不支援 | 升級或要求重新連線 |

**結果分級。** 「已寫入設定」「桌面測試可啟動 MCP」「已觀察到 Agent 連線」「提醒待信任」分別顯示。自測使用暫存資料或唯讀握手。偵測不到宿主實際載入時顯示「待確認」。

- **第一筆工作。** 設定完成後回到 Web 的首次使用清單，讓使用者從已啟用追蹤的專案，在選定 Agent 中完成一次真實工作並查看結果。只想瀏覽資料的人可以收起引導，之後再從系統狀態繼續。

### 3.3 固定 launcher 與可攜 Node 的契約（P0）

- 發行包須包含**標準 Node 可執行檔**、後端、MCP、hook、worker、靜態 Web 與所需資源，放在實際可執行的檔案系統路徑（例如 `extraResources`），不假設能直接從 ASAR 內 `spawn()` 任意 binary。[D][T]
- Agent 的 `command` 指向使用者層固定 launcher。launcher 解析一個**已驗證、原子提交**的 runtime manifest（實際版本、checksum、有效 DB 絕對路徑、宿主類型），以 argv array 啟動，避免經 shell 拼接字串。只允許指定的固定動作（`mcp`、`codex-finalize-reminder` 等）。[D]
- runtime 目錄以不可覆寫的版本或內容識別管理；更新只改 manifest 指向新版本。仍被舊程序占用的 runtime 延後清理（ADR-16）。launcher 檢查所有權與 ACL，拒絕指向不可信或 world-writable 目錄。[D][T]
- App 關閉後必須能啟動 MCP／hook，不依賴 Electron GUI、Node PATH 或 repo。MCP stdout 只有 MCP protocol，錯誤走 stderr；hook 找不到 runtime 時**放行**，並提供後續可修復的診斷，避免靜默長期失效。[D]
- 驗收涵蓋：無 Node 與無 PATH、中文與空格路徑、Windows 防毒與檔案鎖、macOS quarantine、離線、更新中既有 MCP、解除安裝未清乾淨的 hook。每個組合都需真實 `initialize`、`tools/list` 與讀寫合成 DB 測試。[T]
- **階段 1 進度與選定的 layout（1.6.43）**：runtime 選 B，隨包官方 Node.js（ADR-04）。實作的 layout 為：`<root>/bin/work-intelligence-launcher`（Windows 另有 `.cmd`）為固定 shim；`<root>/current` 為單行 runtime id 指標，是唯一的原子切換點；`<root>/runtimes/<id>/` 內含 `runtime-manifest.json`（v1）、`runtime-launch.txt`（單行，記錄可執行檔的相對路徑）、`launcher.mjs`、`.verified.json`（stat 指紋快取，只加速、不作為信任依據）與官方 Node.js 執行檔。shim 只讀取 `current` 與 `runtime-launch.txt` 後執行 launcher；manifest 解析、逐檔 SHA-256、拒絕未列出的檔案與 symlink、路徑與權限檢查、動作白名單與錯誤碼都在共用的 TypeScript 中（`packages/desktop-core/src/runtime`）。已實作：runtime 目錄不可覆寫、指標原子切換、無 Node 的離線煙霧測試（CI）。未實作：Windows ACL 檢查（回報 `not-implemented`）、舊 runtime 清理（DT-24）、Agent 設定接線。[T]

---

## 4. 從既有服務交接

1. **辨識管理者。** 從 OS 註冊範圍、服務名稱、命令與 runner 的正規化路徑交叉辨識，並核對 DB、備份、port 與目前執行版本。區分「已安裝但停止」「已停用登入」「手動啟動」「其他 checkout」「其他使用者」與「其他軟體」。HTTP 回應、相同版本、程序名稱與 PID 只可作為線索（§4.2）。
2. **預覽接管。** 列出哪一份服務會停、哪些登入設定會切換、資料與備份沿用哪裡、哪些 Agent 可能要重新連線。提供「沿用外部管理」與「取消」。手動跑的終端機服務請使用者從原處停止。無法可靠辨識的服務不得代為終止。
3. **執行交接。** 確認後保存可還原的服務定義、啟用狀態與原運作狀態。暫停舊服務的自動拉起，正常關閉已驗明的程序樹，確認 port 釋放。接管前先檢查 schema 相容性、其他寫入端與必要備份，通過後才以絕對路徑開舊 DB。桌面就緒後才提交管理權，並依原選擇啟用桌面登入項。
4. **驗證與回復。** 檢查就緒版本、DB、原專案與備份清單、單一 listener 與登入項，下次登入時再次驗證。失敗時先停桌面子程序；若 DB 相容，恢復舊註冊與原執行狀態。若 schema 已升級，進入資料復原流程，舊程式不得自動重開新版 DB（ADR-22）。交接中閃退時，依持久化階段與現況續辦。

Windows 必測「停止登入排程後，runner 的子孫程序仍占 port」的案例（DT-13）。不同 OS 使用各自的服務管理 API 或已驗證的 adapter。所有接管資料只存本機。[已知服務行為 `[R]`](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/docs/service.md)

### 4.1 管理權轉移狀態機

**區分兩種權限**：`ServiceOwner` 控制某個 HTTP/API 子程序的啟停；`DatabaseAccess` 表示各 CLI／MCP 是否能在相容契約內讀寫同一 SQLite。桌面 App 可以是唯一的受管理 Web/API owner，**但不等於 DB 可被桌面獨占**。進行 schema migration／restore 時，需另建立維護協調與版本屏障。[D]

| 狀態代碼 | 意義 | 允許動作 | 禁止動作 |
|---|---|---|---|
| `UNCONFIGURED` | 未確認 DB 或首次設定未完成 | 唯讀偵測、選來源 | 啟動會建立 DB 的正式 API |
| `EXTERNAL` | 舊服務或手動 server 受外部管理 | 開既有 Dashboard、顯示診斷、預覽接管 | 代替使用者停止無法證實歸屬的程序 |
| `PREPARING` | 已要求接管，尚在預檢或備份 | 拒絕新的管理寫入；完成 preflight | 把新版 DB 交還舊程式 |
| `QUIESCING` | 已停舊登入自動拉起，並等待舊程序關閉 | 可取消並依記錄恢復 | 啟動兩份相同 port 的 server |
| `STARTING` | 新桌面後端啟動與身分驗證 | 驗證 IPC、DB／版本、HTTP | 只因 health 成功就提交所有權 |
| `MANAGED` | 桌面控制的服務可用 | 管理授權操作、查看狀態 | 超出已授權 DB 的隱式切換 |
| `NEEDS_REPAIR` | 接管中斷、衝突、DB 相容性問題 | 開內建修復 UI、重試或轉回外部模式 | 自動開空庫或覆蓋資料 |

每次轉移持久化 `operationId`、`phase`、`previousOwner`、`selectedDb`、`oldServiceDefinition`、`oldEnabledState`、`oldRunningState`、`lastKnownGood`、`migrationStarted` 與 `recoveryPolicy`（不保存密鑰）。操作日誌必須具備 **idempotent replay**：同一操作 ID 重試回傳同一狀態；失敗後依真實 OS 服務狀態與已寫入的 DB／schema 重建現況，不可只依賴舊 phase 文字（ADR-21）。

**回復分岔**：schema 尚未變更且舊版相容時，可預覽並恢復外部登入服務的先前狀態。一旦 migration 開始或 DB 身分不確定，**禁止自動重啟舊服務**，只能進入相容性修復或選擇備份的流程。手動 CLI 背景程序不受桌面強制管理。[D]

### 4.2 服務辨識證據層級

**弱線索**：相同程式名稱、PID、port、HTTP `/api/health`、版本號、命令列文字。**較強線索**：目前使用者的 OS service 註冊識別、服務定義的 canonical runner、process start-time、可驗證的父子關係、專用 IPC 啟動 nonce、DB 身分、服務 manifest。單一證據均不足以視為歸屬；各 OS 的可靠性須以實機驗證。[D][T]

當另一個使用者或未辨識程序已占用 port，維持 `EXTERNAL` 或 `NEEDS_REPAIR`，提供換 port 與手動處理提示；**不得根據同名程序直接 kill**。Windows 的 Task Scheduler runner 與 `conhost` 子孫程序須逐步驗證（DT-13）。[R][T]

---

## 5. 桌面架構與操作契約

| 元件 | 責任與界線 |
|---|---|
| Electron 主程序（TypeScript） | 取得每使用者單一執行鎖，管理系統匣／選單列、登入項、瀏覽器、後端子程序、安裝設定與 updater。保存操作進度。服務壞掉時仍能開啟內建的本機修復視窗。[Electron App](https://www.electronjs.org/docs/latest/api/app) · [Tray](https://www.electronjs.org/docs/latest/api/tray) |
| Node 後端與 worker | 重用 standalone 的 server、Vue 靜態檔與同目錄 backup worker。後端、MCP、hook 共用隨安裝包配送的標準 Node runtime，避免外部 Agent 依賴 Electron GUI 或系統 Node。代價是安裝包另外攜帶 runtime；原型需與 Electron 內建 Node 的子程序實測大小、啟動耗時、SQLite／FTS5 與 worker 相容性，才鎖定方式（ADR-04）。[Standalone 配置 `[R]`](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/docs/standalone.md) · [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process) |
| 瀏覽器 Dashboard | 沿用既有 Web/API、語系與佈景。新增服務設定、Agent 設定進度與更新操作。只有桌面管理的實例能使用相關控制，其他模式顯示其管理方式。 |
| 子程序控制通道 | 主程序建立私有父子 IPC。就緒訊息含該次啟動識別、實際 port、版本與已開啟的 DB 身分，並配合 HTTP health、首頁與必要資源驗證。關閉時經 IPC 呼叫可等待的收尾程序，驗證完成與 port 釋放。[API 啟動 `[R]`](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/apps/server/src/start-api.ts) · [既有關閉順序 `[R]`](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/apps/server/src/shutdown.ts) |
| 設定與操作狀態 | 版本化的使用者設定與操作日誌，置於使用者可寫的固定目錄，與 App 安裝位置分離。DB、備份、Agent 設定各有自身所有權。以暫存檔加原子替換提交（§5.3）。 |

### 5.1 啟動順序與可驗證的控制通道（P0）

**強制順序**：`load validated desktop config` → `read-only DB/source & schema preflight` → `verify service ownership / port` → `acquire operation coordination` → `spawn child with explicit argv/env` → `child confirms opened DB identity via private IPC` → `HTTP readiness with exact instance nonce/version` → `commit active service state` → `open browser`。一律不得在 preflight 之前呼叫可能建立或 migration 的 `WorkIntelligenceStore`。`[R]` 現行 `startApi()` 在 `listen()` 前建構 store，因此須提供桌面專用 bootstrap／entry point，或安全注入已驗證的 DB 設定；原 CLI 維持既有行為。

- 控制 IPC 限父子已驗證通道，不以 HTTP health 作為授權。child readiness 至少回報 `runId`、port、version、schemaVersion、DB 身分與 build hash；parent 比對後才宣布 ready。`runId` 不可在一般 health endpoint 洩漏。[D]
- Electron Main 的操作對象必須是**自己啟動且仍能證明身分的子程序**。PID 可能重用，跨 OS 需檢查 handle、建立時間與 process tree。不呼叫非受控系統程序的通用 kill API。[D][T]
- **停止順序**：不受理新的管理變更 → 停背景排程 → 排空或取消長工作（依定義的 deadline）→ 關閉 SSE 與 HTTP → worker drain → 關閉 SQLite → child 已退出且 port 釋放。正常退出不進崩潰重啟；逾時由 App 顯示「正在等待 X」，不假裝已成功。[R][D]
- 環境變數採**明確 allowlist**（尤其 `WORK_INTELLIGENCE_DB`、PORT、BACKUP_DIR）。開發者 shell 的 Node 選項、不可信 PATH 與 Electron flags 不經處理，不得傳給正式後端。使用 `spawn(...,{shell:false})` 與 argv array 避免 shell injection。[D]

**1.6.44 實作**：HTTP 就緒不以 runId 或 nonce 回傳。父程序送出一次性 challenge（`x-work-intelligence-challenge`）；`/api/health` 只在請求帶有效 challenge 時，回傳以 runId 為 key 的 HMAC-SHA256 證明（`x-work-intelligence-proof`）。runId 只經私有 IPC 的 `start` 訊息送給子程序（`packages/shared/src/instance-proof.ts`、`apps/server/src/server.ts`）。停止順序為 IPC `shutdown`、POSIX 的 `SIGTERM`、`kill`（Windows 直接 `TerminateProcess`）、等待 exit 事件，再輪詢 port 釋放（`packages/desktop-core/src/backend/backend-supervisor.ts`）；子程序收到 `shutdown` 後依序停止背景工作、關閉 SSE、排空 HTTP、關閉 SQLite（`apps/server/src/shutdown.ts`）。本段只記錄子程序層級的實作；本節所列的完整停止順序未逐項以測試對應。環境變數 allowlist 不含 DB 路徑、port 與備份目錄，它們經 IPC `start` 傳遞（`packages/desktop-core/src/backend/child-environment.ts`）。

### 5.2 管理控制威脅模型（P0）

| 攻擊者或故障來源 | 能做的事 | 必備控制 | 還要測什麼 |
|---|---|---|---|
| 惡意網站、CSRF、DNS rebinding | 透過 loopback API 向本機 App 發送請求 | **精確 Host（含 port）**、同源 Origin、nonce 會話、CSRF、嚴格 content type；**授權與 Origin 必須同時成立** | 假 Host、無 Origin、跨 port、重播與過期 |
| 同機未受信任本機程序 | 可自行送 HTTP，不受瀏覽器 CORS 限制 | 桌面管理 API 使用不可猜測的會話授權與 OS 層私有 IPC；一般 API 是否另加 auth 屬相容性決策 | curl／CLI 偽造 headers、非 App PID 操作 |
| 同機其他 OS 使用者 | 可能連到 `127.0.0.1` 上的 server（loopback 不是 per-user 權限邊界） | 管理 API 以會話與 IPC 保護；資料 API 跨使用者威脅 V1 以發行聲明排除（ADR-33） | 不同 OS 帳號連線的管理 API 試驗 |
| 瀏覽器擴充、XSS、被替換的 Web 資源 | 讀取網頁狀態、濫用管理 UI | 高風險操作以原生視窗確認；嚴格 CSP、受控前端資產、限時最小權限 token | XSS、fragment／history／extension 可見性 |
| 外部設定、磁碟連結、更新源 | 將操作指向任意檔案或執行檔 | 路徑 allowlist、realpath／檔案身分重驗、簽章與完整性、設定所有權檢查 | symlink swap、硬連結、zip slip、路徑穿越 |
| 偽造或錯誤更新 | 偽造 manifest 或下載到錯誤架構的程式 | 已信任 metadata 驗證與 code signing；工具版本綁定 | manifest 替換、release tag 變更、key rotation |

**Host 比對（1.6.41 已實作，commit dadaae4）。** 現況 `[R]`：`isAllowedHost()` 以 `new URL('http://'+host).hostname` 比對 hostname，**不比對 port**。1.6.41（T4）的目標規則為：允許的 host = **loopback 名稱 × 實際 listen port**，加上**每個 allowed origin 的精確 host:port**。例如開發環境的 Vite `5966` proxy 會轉送 `Host: localhost:5966`，這是 allowed origin 之一。實際規則以 `isAllowedHost()` 為準（測試：`tests/server/host-port.test.ts`）。

**管理授權設計（ADR-11、ADR-12）。** 正常開啟由 App 產生短效、一次性的授權碼，經 URL fragment 在同源頁面交換為限時的桌面會話，隨即以 `history.replaceState` 清除 fragment。交換與管理操作需驗證精確的 loopback Host:port、含 port 的 Origin、JSON、當次實例與防 CSRF 憑證。每次切換 port 或實例都重建授權，憑證不跨 port 共用，且不得出現在 URL query、日誌或持久化瀏覽器儲存中。授權碼只是候選方案，仍可能經瀏覽器歷史、擴充或畫面分享暴露，**不能作為高風險操作的唯一防護**。授權碼 TTL 短、一次性、綁定 `runId + origin + exact port`；管理授權只存記憶體。書籤與手輸網址只能讀一般 Dashboard，進入管理時引導從 tray 開啟。

Web 只能送固定動作與經 schema 驗證的值。特權資料夾選擇、敏感設定預覽、恢復登入服務、刪除或還原 DB、變更路徑、安裝更新與 Agent 配置，仍須回到 App 受控的本機修復或確認視窗。禁止任意 `exec`、任意 URL、任意檔案位置與攜帶秘密的自動導覽。[D][T]

**Electron 修復視窗（ADR-13）。** 只載入 App 隨附資源與固定 scheme；`nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`；最小 preload API；逐項驗證 IPC sender；拒絕未知 navigation、webview 與 `window.open`；default-deny permissions；採 CSP。Electron 官方把 `shell.openExternal` 的任意 URL 與未校驗 IPC 視為風險，不得把 Web 帶入的字串直接交給 `shell.openExternal`。[U] 現有 HTTP 防護參考：[server.ts `[R]`](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/apps/server/src/server.ts) · [Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security)

**資料 API 的相容性決策。** 目前普通 Dashboard／API 的 loopback 存取契約與 MCP stdio 不同。桌面管理授權獨立新增，不應悄悄令既有 CLI、checkout 與第三方腳本的 API 失效。跨 OS 使用者可存取資料 API 的風險不在 V1 處理，於發行說明明確界定（ADR-33）。[D]

### 5.3 設定與操作日誌的耐久性

- 版本化設定 `configVersion`、明確已提交的 active／desired 設定、操作日誌與最後可用 runtime，都放在目前 OS 使用者可寫、其他帳號不可寫的固定根目錄。安裝 binary 不混放資料。[D]
- 寫入流程：同目錄暫存 → 完整內容與 schema 驗證 → flush／fsync（視平台支援）→ 原子 replace 或 rename → 必要時 fsync 父目錄。若磁碟或虛擬化 FS 無法保證原子替換，建立可驗證的復原副本，**不能無保護地就地覆寫唯一配置**。[D][T]
- 讀取失敗不能當成「全新安裝」而覆寫原狀：保存原檔，載入最後有效副本或進修復。只有確定 `ENOENT` 且沒有既有來源時，才按新使用者處理。[D]
- 可借鑑 Actual Budget 的 `global-store.json` 暫存檔與復原副本邏輯，但不照抄其所有 fallback：對會決定 DB 或管理權的設定，無法保證安全寫入時應**中止提交**。[U][D]

---

## 6. 重新啟動、換 port 與服務故障

1. 「重新啟動」沿用目前設定。「套用並重新啟動」先驗證十進位整數 1–65535、作業系統權限、瀏覽器限制與 loopback 綁定。舊值相同則結束。新 port 占用時留在原頁；預檢通過仍以實際 bind 結果為準。
2. 舊頁先顯示操作進度，並提供原／新網址與 tray 備援。停止接新工作，結束 SSE，排空 HTTP，等待 worker 與 SQLite 關閉。進行中的匯入、還原、備份或 migration 須完成或安全延後。桌面程序獨立等待釋放；逾時顯示「正在等什麼」，可重新檢查。
3. 新服務通過 IPC 身分、DB 與 HTTP 驗證後，才提交新 port。相同 port 的頁面自動重連；換 port 時由 App 開啟新網址。保留可安全還原的頁面路徑；有未儲存的編輯時先提示儲存。跨 port 的瀏覽器儲存屬於不同 origin，語言與佈景等偏好從已知偏好還原（§6.2）。
4. 新服務未就緒則以最後成功設定復原。原 port 也被占用時，tray 的「修復連線」可選別的 port、重試或看日誌。啟動期間崩潰採有上限的退避重試，例如兩分鐘內三次後轉為待處理；權限、格式、schema 等確定錯誤直接進修復。睡眠喚醒時重查現況。正常結束不觸發自動重啟。

### 6.1 操作佇列、取消與回復（ADR-21）

所有會影響管理權的動作（接管、換 DB、換 port、套用 Agent、重啟、還原、更新安裝）由單一全域 `OperationCoordinator` 協調。提交時產生具來源、參數摘要、預期狀態、階段與完成結果的 `operationId`。**重送同 ID 只回傳同一操作**；不同 ID 的互斥變更回 `BUSY` 並附目前操作。讀取診斷可在安全處並行。[D]

- **可取消**：尚未切換 owner、尚未進入 schema migration、尚未交給 installer 之前，通常可取消並清除 staging。
- **不可立即取消**：正在執行不可中斷的 SQLite 寫入或安裝器交接時，UI 顯示「已進入不可中斷階段」，待其安全收尾。不得把取消等同 `kill -9`。
- **瀏覽器中斷**：HTTP 回應只證明已受理，實際操作由 Electron Main 持續維護；頁面重新整理後以 ID 查詢，不依賴原 HTTP request 存活。
- **失敗復原**：確認當前 DB／schema／OS 服務／runtime 狀態與上次持久化階段一致後，才重試或回復；無法確認時進修復模式。

### 6.2 換 port 的額外限制

1. 監聽只允許 loopback。`1–65535` 是數學合法值，不代表目前使用者能 bind，也不代表所有瀏覽器都允許導航。低埠與瀏覽器保留埠依實際平台測試。[T]
2. port 空閒預檢只是提示，**實際 bind 才是準據**。任何 port 失敗都不得先建立另一份空 DB（見 §5.1）。`[R][D]`
3. `127.0.0.1:3210` 改為新 port 後，`localStorage` 與 cookie 的 origin 已改。跨 port 偏好只搬運白名單的非秘密值；不移轉管理會話或 DB 路徑 token。[D]
4. 舊 App 書籤或 Agent 舊 dashboard script 可能仍指向 3210。固定 launcher 的 `dashboard` 命令應詢問管理者目前的 port，不要因舊 script 的 health 檢查而重啟 checkout server。[R][D]

---

## 7. GitHub 更新、資料保護與復原

**發行提案。** 使用 electron-builder 打包與 electron-updater，延用產品根目錄版本與同一個 release commit。Windows 11 x64 產生目前使用者安裝的簽章 NSIS；macOS 產生簽署與公證的 App、DMG 與更新 ZIP。各架構的安裝包、更新描述、校驗值與該工具版本所需的附檔必須互相匹配。固定官方 GitHub 倉庫、穩定通道與可信發布者或簽章公鑰；驗證更新清單簽章、檔案雜湊與平台支援的發行者驗證。客戶端不用 GitHub token。[現行發行程序 `[R]`](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/docs/release.md) · [更新套件與平台格式](https://www.electron.build/docs/features/auto-update/) · [更新清單簽章](https://www.electron.build/docs/features/signed-update-manifests/)

| 階段 | 成功條件 | 中斷或失敗的處理 |
|---|---|---|
| 查詢與下載 | 顯示目前版、目標版、大小、版本說明與下載進度。背景檢查有間隔，手動可立即查。 | 離線、代理、限流或 GitHub 暫停不影響本機服務。顯示上次檢查時間與稍後重試。下載可取消；毀損快取可重抓。 |
| 驗證與安裝前檢查 | 目標 OS／架構正確，簽章與雜湊通過。確認空間、安裝位置可寫、資料位置、待完成工作、可驗證的升級前備份，以及可用的復原安裝包。 | 驗證失敗保留舊版與原服務。安裝位置唯讀，或 macOS 仍從 DMG 執行時，說明移到可更新位置的步驟（DT-29）。備份失敗顯示可重試的具體原因。 |
| 切換版本 | 保存目標、上次成功版本與前景／背景狀態；排空服務。schema 會變更時，確認舊 MCP、CLI 等寫入端已退出，遷移期間排除重新開啟。 | 無法約束外部寫入端時暫緩安裝，說明需關閉哪類連線。下載完成不等於已安裝；使用者延後時，一般退出不得意外安裝（DT-30）。 |
| 新版驗證 | 比對桌面、實際 API、Web 資源與 schema，核對 DB 身分、備份 worker 與管理入口。依先前狀態返回 Dashboard 或靜默回到 tray。 | 下次開啟從持久化階段判定結果。新版開不起來時，經獨立的安裝包或修復入口重裝同版或較新修正版，保留設定與資料（DT-31）。 |
| 復原與停止派送 | 維護者可撤下問題更新，發行更高版本修正。更新簽章金鑰或發行者變更時，須先驗證從已安裝舊版的過渡路徑。 | 只在原 schema 相容時回退程式。若已 migration，優先修復程式；需還原 DB 時，先停止所有存取、保留當前 DB 快照、列出備份時間與此後可能失去的工作，再由使用者選擇。禁止自動覆蓋工作記錄（ADR-22）。 |

### 7.1 發行工具版本：v26 與 v27 的差異不能混淆（DT-28）

截至審查日，electron-builder 官網 **v27 `Security & Hardening` 文件明示 v27 仍屬 next**，有別於穩定版 v26。v27 文件描述的 Ed25519 signed `latest*.yml`、信任公鑰與額外 updater 強化，**若實作鎖在 v26，不可宣稱單靠 `sha512` 即能保護 manifest 本身，也不可假定具有 v27 專屬 API**。[U]

**規則**：A 階段先鎖定精確的 `electron`、`electron-builder`、`electron-updater` 版本，對照實際程式庫與產物證明：

- 若使用已實測的 v27 能力：簽名私鑰放 CI secret，App 內嵌信任公鑰；測試篡改、漏簽、錯 key、key rotation，以及 metadata 與安裝資產的一致性。不採 `updateManifest:false` 逃避要求。[U][T]
- 若正式環境仍用 v26：須提出並實測**等價的 metadata 來源驗證方案**；否則改為「手動前往官方 Releases 下載經平台驗證的安裝包」，**不要把不可靠的 auto-update 當作 V1 已完成**。[D]
- 更新來源固定官方倉庫與 release asset，禁止使用者輸入鏡像 URL 交給特權安裝器。release tag、版本與平台檔案之間的映射須以可重現的發行流程驗證。[D]
- electron-updater 文件亦說明 Windows「退出時安裝」可能與 OS session 結束競爭（ADR-24）。須實測 `autoInstallEvent` 可用性與 `manual`、`onNextLaunch` 等策略；若無法證明沒有意外退出安裝，採**使用者明確按下安裝並先排空後端**的方式，且須備有外部可啟動的修復安裝包。[U][T]

### 7.2 更新與 schema 的三階段成功定義（DT-31）

更新畫面不得只有一個「成功」布林值：

| 部分 | 完成條件 | 失敗後策略 |
|---|---|---|
| `desktopInstalled` | 安裝器已切換到新 App，簽章與版本確認 | 機器上的修復安裝包或官方下載 |
| `backendReady` | 指定的 runtime／web／API／worker／管理 IPC 驗證通過 | 留在 tray 修復，不偷用其他 checkout 代替 |
| `dataCompatible` | 選定 DB／schema 正確，必要的 migration 前備份驗證通過，Agent 寫入端依契約轉移 | 阻止舊程式讀寫不相容的 DB；優先以修正版前進修復 |

任何會改變 schema 的更新前，須通知使用者關閉仍持續讀寫的 Agent 或 CLI。**「有舊 MCP 程序尚在」不能只靠 `sqlite_busy` 推定**：長連線可能閒置後才寫入。須有 per-operation schema／capability 檢查、世代屏障或可驗證的更新窗口（§7.3）。

### 7.3 DB schema 相容政策（P0）

**R4 修正（R3 的 R03 描述需更正）**：

- `[R]` `packages/storage/src/store.ts` 的 `withCompatibleSchema(schemaVersion, operation)` 在 `runImmediateSqlTransaction` 內比對 `SELECT MAX(version) FROM schema_migrations` 與 MCP 啟動時的 schema 版本。不符時回傳 `MCP_RESTART_REQUIRED`。`apps/mcp/src/server.ts` 在寫入工具路徑呼叫此方法。因此，**MCP 寫入端已有每次寫入的閘門**，R3 的「長連線 MCP 在 migration 後寫入」在 MCP 寫入路徑上已被阻斷（程式碼閱讀結論 `[R]`；尚待 §10.4 的程序組合實驗證明 `[T]`）。
- **剩餘缺口**：(1) `apps/server` HTTP API 寫入端；(2) 長駐 CLI 寫入端；(3) 長任務提交前的檢查；(4) 未知外部 client（不能假設有權強制中斷）。
- **1.6.41 T2（已實作，commit 3ff1e45）**：在寫入交易（`Store` 的 `runImmediateTransaction`，含 HTTP API）的 `BEGIN IMMEDIATE` 之後經 `SchemaWriteGate` 檢查，不相容時錯誤碼 `server_restart_required`（HTTP 503）。檢查以 `data_version` 與 `schema_version` 組成的快取戳記判斷，只有戳記變動才重查 `schema_migrations`，避免每個請求都重查（現有 `data-revision-cache.ts` 已採此模式 `[R]`）。測試：`tests/storage/schema-write-gate.test.ts`、`tests/server/schema-gate.test.ts`。

| 相容等級 | 新桌面與現役舊客戶端 | 規則 |
|---|---|---|
| `READ_WRITE_COMPATIBLE` | 已驗證可共用契約 | 才允許並行寫入 |
| `READ_ONLY_COMPATIBLE` | 舊客戶端可讀但不應寫 | 舊寫入端進唯讀或拒寫提示（需程式支援） |
| `RECONNECT_REQUIRED` | 契約工具、schema 或 launcher 需要重新載入 | 停止新動作，並顯示在原 Agent 重新連線 |
| `INCOMPATIBLE` | 不可安全共存 | 延後升級或進維護模式，並排除舊端 |
| `UNKNOWN` | 無法證明 | 預設視為不允許破壞性 migration |

每次寫入與長任務提交前，都應重新評估必要的 schema／capability／epoch。客戶端若無法識別屏障，遷移流程須確保它不能在遷移後再次寫入。單一 lockfile 只能做協調，不等同強制隔離任意不受控程序。[D]

### 7.3.1 SQLite 安全版本（P0，R33）

**外部已確認的版本風險**：SQLite 官方於 2026-03 公告 WAL-reset 資料損毀問題。3.51.2 及更早的相關版本，可能在極少數 WAL 多連線寫入或 checkpoint 競態下損毀；官方指出 3.51.3 起已修復，並有 3.50.7、3.44.6 的回補版。此為外部版本風險，不是已證實 WorkLog.Ai 現有資料庫發生損毀。[U]

**R4 量測（開發機，非發行產物）`[T]`**：本機 Node v22.23.4 的 `node:sqlite` 回報 `sqlite_version()` = **3.53.4**，高於 3.51.3 的修補點。此結果：

- 只代表該開發機的 Node 二進位，**不能代表發行安裝包內的 bundled Node**；發行準據是 release 產物本身。
- 不能由 `engines`（`>=22.16.0 <23 || >=24.0.0` `[R]`）或 Node 主版號推定修補狀態。
- 3.50.7、3.44.6 等回補版只對其所屬分支有意義，若 bundled 值落在這些分支，需供應鏈回補證據。

**規則（ADR-19）**：

- 打包規格除 Node.js 主版號與 FTS5 外，必須記錄 bundled Node 的實際 `SELECT sqlite_version()`，並以修補狀態判定；落在疑似受影響區間且無回補證據者，不得做公眾發行的多寫入端桌面 runtime。[D][T]
- **1.6.41 T3（已實作，commit 4420951）**：`doctor` 與系統狀態回應（`routes/system.ts`）報告 `sqlite_version()` 與 WAL-reset 修補狀態，受影響時 `walResetFixed` 為 false；`scripts/check-sqlite-version.mjs` 於 CI（`ci.yml`）與 release（`release.yml`）執行，受影響版本以非零結束；standalone smoke 亦檢查 bundled Node 的 SQLite 版本。（`doctor.ts` 已有 `probeSqlite()` `[R]`。）
- 若更換為另一份可攜 Node，仍須測試既有 `node:sqlite`、FTS5、worker 與 schema 相容。[D][T]
- 跨 runtime 混用（Agent plugin 可能仍指向其他 Node）須列入診斷：桌面 App 的修補不代表未受控的外部 Node 已更新。不可為少見競態而強制殺掉任意外部 Agent；可以限制 schema 變更、顯示相容性風險，並要求選定受管理的入口。[D]
- 採用安全版本後仍需做 WAL 並發壓力與 `integrity_check`、可還原樣本測試（DT-07）；壓力測試**不能**單獨取代官方修補版本的證據。[D]

官方來源：[SQLite WAL-reset bug 與修補條件](https://www.sqlite.org/wal.html#the_wal_reset_bug)、[SQLite 3.51.3 release](https://sqlite.org/releaselog/3_51_3.html)。

### 7.4 備份的真實保護範圍（DT-05）

`[R]` `writeSnapshot()` 以 `VACUUM INTO` 取得一致快照，並在私有 staging 驗證後才對外發布，這優於直接複製 WAL 模式下的主 `.sqlite` 檔。[U] SQLite 官方亦建議以 Online Backup API 或 `VACUUM INTO` 作為 live DB 的快照。

新增保護：

- migration 或 restore 須檢查目標 DB、可用空間、備份目錄，以及**可實際讀回的快照**。以合成資料至少驗證 `PRAGMA integrity_check` 與代表性 Session／專案 ID；重大還原演練另驗 `foreign_key_check`。[D][T]
- 備份後進行破壞性 migration，須保留操作前快照、schema 版本與使用者選擇。不得把保留三份自動備份視為跨磁碟事故或勒索軟體的恢復策略；可提醒使用者另存備份，不預設上傳。[D]
- DB 位於外接磁碟、雲端同步目錄或不支援 WAL 的 FS 時，顯示限制並避免自動接管；避免資料庫與備份都放在同一易遺失的磁碟而不提示。[U][D]
- `restore` 必須先讓相容性可疑的 API／MCP 退出或可靠阻擋；不能以備份 copy 直接覆蓋正在使用且附 `-wal`／`-shm` 的活躍 SQLite。[U][D]
- 對非可逆的 schema 變更，不以「程式降版」當作資料回復。若使用者選擇還原備份，先保存當前 DB 快照，揭露備份時點之後可能流失的 Session，再執行。[D]

---

## 8. 日常設定、診斷與解除安裝

- **同一處找得到。** Web「系統狀態」分成服務、資料與備份、Agent 連線、版本更新，可從 tray 直達。基本畫面先顯示運作結果，需要處理才顯示下一個動作，進階區才列路徑與細節。支援既有繁中與英文、鍵盤操作、深淺色；狀態以文字說明。背景登入遇錯時，提供單次系統通知或 tray 提示，避免反覆開視窗。
- **資料來源遺失。** 已知 DB 消失、外接碟卸載、路徑移動或權限改變時，保留原設定並提供重新定位。重新定位先唯讀預覽，核對資料與各 Agent 路徑後才套用。設定檔毀損時保留原檔，從最後有效設定或使用者確認的路徑復原。
- **本機診斷。** 顯示最近一次操作、失敗階段、時間、版本、服務歸屬與可用動作。例如「3210 已被其他程序使用，原設定已保留」。日誌輪替；匯出診斷前預覽並遮蔽授權碼、個資路徑、工作內容與其他工具設定。無預設遙測或自動上傳。
- **解除連接與移除。** 設定中心先列出 App 管理的登入項、Agent／skill／hook、穩定啟動器與外部整合。依安裝清單與目前指紋選擇性移除，保留使用者修改與其他來源項目。一般移除保留 DB、備份與設定，並顯示實際位置。已接管的使用者可在 schema 相容且預覽原登入狀態後交回舊服務。
- **平台差異**：Windows 解除安裝器整合可用的清理流程。macOS 拖進垃圾桶可能略過清理，提供「移除桌面整合」入口、手動復原說明，以及重裝後清理（DT-34）。重新安裝必須能找回原資料；留存的 hook 即使找不到 App 也應放行。

### 8.1 錯誤分類、隱私與支援界線（ADR-29）

診斷應區分 `DB_MISSING`、`DB_OFFLINE`、`DB_PERMISSION`、`SCHEMA_TOO_NEW`、`SCHEMA_MIGRATION_BLOCKED`、`PORT_OCCUPIED_BY_OTHER`、`SERVICE_OWNER_UNKNOWN`、`RUNTIME_MISSING`、`HOOK_UNTRUSTED`、`UPDATE_UNVERIFIED`、`REPAIR_REQUIRED`。每個錯誤連到**唯一可執行的下一步**。錯誤日誌不得原樣傾印整份 Agent config、MCP 工具輸入輸出、Session 工作內容、home 路徑、完整環境、API 授權碼或 webhook／token。[D]

診斷封包須經 dry-run 檢查、個資路徑遮蔽與秘密掃描；只有使用者主動匯出才寫檔，**不得預設向 GitHub Issue 或遠端 API 上傳**。解除安裝不得擅自卸除外部 plugin 或 MCPB。[D]

### 8.2 退出 App、休眠與排程的可預期行為

- 關閉瀏覽器、退出 App 的語意見 §1.1（ADR-26）。
- 睡眠或休眠：醒來後檢查舊子程序、port、外接 DB 來源與登入項狀態，不盲目重啟；必要時進 `NEEDS_REPAIR`。[D]
- 系統登出或強制關機：不得期待無限時間的 drain；資料庫有自己的 transaction 保護。下次啟動依持久化操作日誌與實際狀態恢復，並驗證未完成的快照。[D][T]

---

## 9. 首發平台需求：Windows 11 x64 與 macOS 同批發行

**R4 決策（ADR-02、ADR-03）**：Windows 11 x64 與 macOS 為**同一批**首發平台，同批發行、同批驗收。Linux 不在 V1；Windows ARM 排除為推論（待確認）。

### 9.0 首發矩陣

| 平台 | 架構 | V1 狀態 |
|---|---|---|
| Windows 11 x64 | x64 | **首發**，與 macOS 同批；需通過 §9.1 全部 gate |
| macOS | Apple Silicon | **首發候選（待確認）**，與 Windows 同批；需通過 §9.2 全部 gate |
| macOS | Intel | 首發候選（待確認；R3 列為候選）。A 階段決定能否同批驗收；若不能，依 ADR-02 變更程序排除並更新發行聲明 |
| Windows 11 | ARM | V1 不做，於發行聲明排除（推論，待確認；R3 §9 另行驗證項目） |
| Linux（Ubuntu GNOME 等 AppImage、系統匣、登入項） | x64 | V1 不做，於發行聲明排除。CLI、standalone、plugin 不受影響 |

**聯合發行門檻（待使用者確認）**：任一首發平台的 gate 未過，整個版本不公開；不允許單平台先發（ADR-03）。Release 先暫存全部首發平台的產物，確定完整且可驗證後才一次公開（DT-33）。此規則加大排程風險，須於里程碑中留出 Windows 實機驗收時間。

### 9.1 Windows 11 x64 需求

- **安裝**：NSIS 目前使用者安裝，產物須簽章。解除安裝只移除 App 擁有的項目，DB 與備份保留（DT-34，R27）。
- **Windows 檔案鎖**：runtime、DB、設定檔可能被防毒軟體或程序占用。runtime 版本化、延後 GC、manifest 原子切換；更新不因鎖而失敗（DT-24，R08）。
- **服務與子程序**：登入背景與服務以 `schtasks` 管理（DT-13）。停止時須證明並終止 runner 的子孫程序，並確認 port 釋放；此為 Windows 必測案例（R05）。
- **登入背景**：無視窗；錯誤以單次系統通知或 tray 提示呈現，不反覆彈窗（R18、R24）。
- **資料夾選擇（1.6.41 T1，已實作，commit 1257d3a；實機待實機驗收；DT-26）**：
  - 現況 `[R]`：`apps/server/src/folder-picker.ts` 以 `powershell.exe -NoProfile -STA` 執行 `System.Windows.Forms.FolderBrowserDialog`。
  - 目標：以 `IFileOpenDialog` 取代。PowerShell `-STA` 搭配 `Add-Type` 的 C# COM interop；選項為 `FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST`；DPI aware；以 TopMost 視窗為 owner。
  - 使用者取消（HRESULT `0x800704C7`）→ exit code `2`。
  - COM 不可用時 fallback 到 `FolderBrowserDialog`（啟用 `EnableVisualStyles`）。
  - 輸出為 UTF-8。
  - **需 Windows 11 實機驗收**，對應 `docs/release-checklist.md` 的「原生資料夾選擇視窗」條目 `[R]`；CI 無法取代。
- **實機驗收**：Windows 11 依 `docs/release-checklist.md` 的 Windows 條目執行，包含備份還原、Codex hook、登入自動啟動服務與 bootstrap。`[R]`

### 9.2 macOS 需求

- **簽署與公證**：App、DMG 與更新 ZIP 均須簽署與公證。Apple Silicon 與 Intel 的架構範圍待確認，見 §9.0。
- **從 DMG 執行**：無法安裝更新。啟動時檢測 App 位置，導引使用者移到 Applications（R26、DT-29）。
- **Quarantine**：以 quarantine 屬性的安裝包做測試（§3.3 驗收）。
- **服務**：LaunchAgent 的辨識與接管（DT-12），依 §4.2 的證據層級判斷歸屬。
- **資料夾選擇**：維持 `osascript` `choose folder` `[R]`，納入 DT-26 的驗收範圍。
- **選單列**：無法控制圖示單擊行為時，選單第一項固定為「開啟 Dashboard」（§1）。
- **拖入垃圾桶**：可能略過清理，提供「移除桌面整合」入口（DT-34）。

### 9.3 V1 不做（發行聲明排除）

- Linux 桌面：AppImage、系統匣、登入項、桌面圖示。既有 `folder-picker.ts` 的 zenity／kdialog 分支維持現況，不納入桌面 V1 驗收 `[R]`。
- Windows ARM（推論，待確認）。
- 資料 API（非管理 API）的跨 OS 使用者隔離（ADR-33）。
- 多資料庫切換、遠端管理、內嵌 Dashboard 視窗。

### 9.4 開發階段與出入口

| 階段 | 產物 | 必通過的 gate |
|---|---|---|
| 0. 契約與測試基座 | ServiceOwner、DB compatibility、runtime manifest、OperationCoordinator、合成資料與假 home／Agent | 狀態機、恢復與不變條件的單元測試全綠 |
| 1. Runtime spike | App／Node／worker／Web／MCP／hook 封裝，無 Node 離線測試 | Windows 與 macOS 實測 SQLite／FTS5、MCP stdio、hook、大小與閒置資源；選出封裝方式 |
| 2. 安全最小桌面 | Electron main、單例、tray、唯讀 preflight、API child、repair window | 不開錯 DB、不雙開、不依賴 browser 才能修復 |
| 3. Agent 整合 | 非互動 plan／apply／compensate、固定 launcher、來源辨識 | host 真正 handshake、hook fail-open、更新後 runtime 不失效 |
| 4. 接管與改設定 | OS service adapter（含 schtasks）、管理者轉移、換 port、設定日誌 | 手動或外部服務不被 kill；每個中斷階段都可恢復 |
| 5. 自動更新與 schema | 固定發布鏈、簽章驗證、DB migration／restore 屏障 | 簽署的 N→N+1、篡改拒絕、斷電復原演練 |
| 6. 同批發行 | Windows 11 x64 與 macOS 的簽章安裝包實測 | 兩平台同批產物完成 §9.5 全部 gate，否則整版不發 |

不得用 mock 服務管理器或 fake Agent 的成功取代最後的 OS／host 實測。CI 用 fake home 的測試是必要條件，**不是**充分條件。

**階段 1 狀態（1.6.43）**：spike 的 CI 可驗證部分已完成，並選定 B（ADR-04）。三平台的量測已由 CI 取得（run 43864453651）；實機驗收尚未進行，**階段 1 的 gate 尚未通過**。Linux 不在 V1 首發範圍，其數字只作方向參考。spike 未量測 `utilityProcess`，R31 要求的比較因此未完整。

**階段 2 狀態（1.6.44）**：CI 可驗證部分已實作（DT-11、DT-15、DT-16、DT-35）：Electron 殼、後端子程序生命週期與修復視窗。三平台的 desktop-smoke 結果待 PR 的 workflow 取得；實機驗收（Windows 11 與 macOS）未做。**階段 2 的 gate 尚未通過。**

### 9.5 發行阻斷的可觀察證據（Gate）

每項測試保存：OS build、CPU 架構、App／Node／Electron／updater 版本、安裝包 SHA-256、DB 身分與 schema、operation ID、舊與新服務狀態、測試輸入、實際輸出、日誌遮蔽結果、復測連結。[D]

- `G-DB-01`：多來源 DB、相同路徑不同檔案、symlink swap、外接裝置卸載，都不會默默產生新 DB。唯讀預覽不因 `-wal`／`-shm` sidecar 造成未預期的資料破壞。
- `G-DB-02`：舊 API 或 stdio MCP 閒置中進行 schema 升級，必須被阻擋或可靠拒寫；中斷後可識別最後的 DB 版本。
- `G-DB-03`：已提交的 Session 留在 WAL；磁碟滿、唯讀、備份途中斷電時，備份驗證與 restore 不丟已提交資料，且不覆蓋唯一可恢復的庫。並驗證 bundled Node 的 SQLite 版本與 WAL-reset 修補證據，搭配多程序 WAL 寫入與 checkpoint 壓力測試。
- `G-SVC-01`：舊 OS 登入服務與桌面同時存在；不 kill 未授權程序，管理權只能有一位有效 owner，失敗可回 external 或 repair。
- `G-SVC-02`：多次點 App、兩個瀏覽器分頁同時重啟、重送 operation ID、服務 crash 或睡醒後，沒有第二個 listener 或孤兒 process。
- `G-MCP-01`：無 Node、App 已退出、App 升級中、Windows runtime 檔案被鎖，bundled SQLite 版本經驗證，已連結的 Agent 仍能正確 `initialize`、`tools/list`；更新契約時明確要求重連。
- `G-SEC-01`：惡意 Origin／Host、本機 curl 假冒 headers、跨 port session、重播或過期 token、XSS、URL injection、任意設定路徑，未授權的高權限操作都無副作用。
- `G-UPD-01`：同一簽名管道的 N→N+1 真實安裝；manifest 篡改、錯 key、錯架構、版本回退皆拒絕；失敗可透過 App 以外的修復路徑救回。
- `G-UX-01`：安裝 → 選 project → 連 Agent → 真實記錄；鍵盤操作、繁中與英文、深淺色、無 tray 場景仍能完成或修復。

**以上是門檻規格，不是目前已通過的測試結果。**

### 9.6 第一版驗收案例

以暫存 home、假 Agent 根目錄與合成 DB 執行自動化。真人驗收使用測試帳號、實際安裝檔與真實 OS 服務管理器，記錄版本、架構、案例、預期與實際值、失敗日誌與復測結果。下表為待執行案例。

| 測試群組 | 至少必測的情境 | 通過條件 |
|---|---|---|
| 安裝與引導 | 乾淨機、離線、非管理員、中文與空格路徑、無 Agent、跳過設定、中途取消、重開與重裝（Windows 與 macOS） | 可完成首次開頁；可略過或續做；全程不要求 pnpm。沒有產生未授權的整合或追蹤記錄。 |
| 既有使用者 | checkout／standalone／plugin link、自訂 DB 與備份、兩個 checkout、外接碟、舊服務執行／停止／停用、手動 start | 前後比較同一 DB、既有專案 ID、Session 數與備份清單。登入後恰一個管理者。失敗可回舊服務，或進明確的相容性復原。 |
| Agent | 各宿主首次連接、plugin 與手動並存、自訂 roots、停用或未信任 hook、宿主未安裝、設定衝突、部分寫入失敗 | 一個 Agent 只有預期註冊，原設定保留；可修復或撤銷。App 關閉、換 port、更新後，從真實 Agent 做 stdio 握手，在合成追蹤專案完成讀寫並於 Dashboard 核對。 |
| 背景與控制 | 快速連點、多分頁同時操作、關頁、手動退出、登入、睡眠喚醒、OS 結束、主或子程序崩潰、無預設瀏覽器 | 無重複 listener、無失控重啟或孤兒程序。手動開啟與登入各有正確的開頁行為，修復入口可用。 |
| Port 與重啟 | 假冒 health、其他帳號或軟體占 port、預檢後被搶占、原 port 也被占用、SSE、長時間備份、操作途中關頁或斷電 | 原操作只執行一次。可回到有效 port 或由 tray 修復，不殺外部程序，不遺失已提交寫入。 |
| Web 管理安全 | 惡意 Origin／Host、跨 port 憑證重用、過期授權、重播、跨站表單、手輸網址、任意檔案與更新 URL 注入 | 未授權操作無副作用；管理憑證不進日誌；既有非桌面 API 行為有回歸測試。 |
| 資料與復原 | DB 不可寫或遺失、磁碟滿、WAL 有已提交寫入、新舊 schema、備份鎖定、Agent 持續寫入、設定檔毀損 | 不誤開空庫，備份失敗不遷移；可從診斷找到原檔與復原步驟。用還原樣本核對內容與完整性。 |
| GitHub 更新 | 無新版、忽略預發版、離線或限流、下載中斷、錯架構、錯誤簽章、安裝無權限、更新中強制退出、N→N+1 | 下載可重試；不接受錯版或偽造檔。成功以執行版本為準。失敗仍可用舊服務或修復安裝包，資料可驗證。 |
| 解除安裝與可用性 | 整合後移除、使用者已手改 hook、重裝、舊服務交回、鍵盤與螢幕閱讀器、兩種語系與佈景 | 可辨識每項設定是否保留或移除，重裝可讀回原資料。主要流程僅用鍵盤可完成，錯誤有可選的動作。 |

**公開發行門檻。** 維持現有 repo 的品質、E2E 與 release 檢查，另驗證本次要上傳的桌面安裝包與更新 metadata。任一首發平台發生資料遺失、錯庫、未授權改設定、無法由正式安裝包升級、背景重複啟動，或服務掛掉後無修復入口，即停止整版發行。[專案發行驗收清單 `[R]`](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/docs/release-checklist.md)

---

## 10. 跨程式契約：工程規格草案

### 10.1 `DesktopSettingsV1`（不與舊 Agent 設定混用）

以下為**語意草案**，JSON 僅示意欄位，不是已實作的檔案格式：

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

- `desired` 可能尚未生效，絕不可顯示為「目前使用中」；`active` 是完成 IPC、API、schema 驗證後才提交的結果。
- `installId` 不能當作授權密鑰；存放路徑與其 ACL 是另一層安全問題。
- `databaseIdentity` 已於 1.6.42 定案為正規化路徑、檔案 ID 與唯讀血統指紋的組合，見 [ADR-36](desktop-v1-adr.md)。嵌入 UUID 延後：預覽舊庫時絕不寫入，只能在日後經授權的 migration 中補上。`[T]`
- `runtimeVersion` 不能只用行銷版本字串，應綁定 build hash、runtime binary／Node 能力與 package manifest。
- 設定格式升級須支援讀舊版本並 fail-closed；設定壞掉時優先修復，不得開空庫。

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

- manifest 與 binary 位於使用者可控的目錄，但須檢查檔案所有權與 ACL，尤其不能被其他 OS 使用者更改。路徑與 hash 範例不是建議的固定字串。[D]
- launcher 讀取 manifest 後須驗證檔案、schema 與所需的 action，並採 `exec`／`spawn` argv 模式，禁止 shell 解譯；秘密不放入 CLI argv 或記錄。[D]
- 更新時先安裝新 runtime 並驗證完整性，再原子切換 manifest。舊 runtime 的清理由「無現役連線且可安全刪除」共同決定，不能僅以 PID 不存在作準（PID 可能重用）。[D]
- 外部 plugin／MCPB 的 launcher 不一定由本 App 管理，絕不強制替換。舊 plugin 仍可維持原 checkout 行為；desktop setup 必須顯示其不同的 DB 或 runtime 來源。[D]
- **1.6.43 實作的 v1 欄位**（以程式為準；上方 JSON 為早期草案）：`manifestVersion: 1`、`runtimeId`、`runtimeKind`（`node` 或 `electron-run-as-node`）、`executable`（相對路徑）、`actions`（每個動作的入口檔 `entry`，只允許 `mcp`、`serve`、`codex-finalize-reminder`、`claude-finalize-reminder`）、`files`（`{path, size, sha256}`，列出 runtime 目錄內每一個檔案，manifest 與快取檔除外）、`symlinks`（`{path, target}`，目標必須留在 runtime 內）。v1 不含 `activeRuntimeId`（由 `current` 指標取代），也不含 DB 路徑或身分欄位；草案的 `allowedActions` 改名為 `actions`。[T]

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

此例的 schema／version 值**僅示意欄位形狀，不宣稱目前正式 schema 值**。protocol version 不合時進 `NEEDS_REPAIR`；不得退回無身分證明的 HTTP health。只有 parent 在本次啟動中建立的受控 IPC handle，才可提交管理權。HTTP `/api/health` 是就緒的輔助判斷，不是身分授權。

**1.6.44 實作**：`ready` 的欄位為 `protocolVersion`、`type`、`runId`、`port`、`appVersion`、`schemaVersion`、`databaseIdentity`（物件：`realPath`、`fileId`、`lineageId`）、`execPath`、`pid`；沒有 `buildHash`，`databaseIdentity` 是可讀的結構而非不透明字串。協議版本不符時回報 `REPAIR_REQUIRED`，不退回 HTTP health。schema 定義於 `packages/schema/src/desktop-child-protocol.ts`（`DESKTOP_CHILD_PROTOCOL_VERSION` 為 1）。

### 10.4 DB 協調實驗與相容性矩陣

**實驗（實作前必做）**：在兩個 Node 程序同時連到 WAL SQLite 的情況下，讓舊 MCP 長連線保持閒置；另一個程序複製快照並執行 schema migration；然後觸發舊 MCP 的工具寫入。記錄 schema version、回應、SQLite 例外與是否誤寫，證明實際的攔截位置。R4 新增測試組合：

1. 舊版 MCP 寫入路徑（`withCompatibleSchema`）：確認拒寫並回 `MCP_RESTART_REQUIRED`。
2. HTTP API 寫入端：T2 已實作（commit 3ff1e45）；1.6.42 的程序組合實驗（DT-04，commit 5bdd530）已確認舊程序寫入回 `server_restart_required`（HTTP 503）且無誤寫 `[T]`。
3. 長駐 CLI 寫入端與長任務提交：同上。
4. 組合：新／舊 CLI、standalone、Codex plugin、Claude Code plugin、MCPB、未經 launcher 的手動 stdio 設定，各跑一次。

候選方案（尚未定案）：

1. 所有受支援的 MCP、HTTP、CLI 寫入 API 在每次交易邊界讀取 schema epoch／capability；不符即拒絕（對新版受控客戶端可靠）。
2. schema-breaking migration 要求**已知**連線完成並退出，並以桌面維護態阻擋從固定 launcher 新開舊 MCP；對未知外部 client，不能假設有權強制中斷。
3. 若無法安全排除外部寫入端，將更新分成「安裝 App」與「稍後升級資料庫」，暫時維持原相容 backend 或修復模式；絕不可自行硬升 DB。

**方案 1 與 2 並非萬靈丹；須以實際程序組合證明可靠性。**

#### DT-04 實驗結果（1.6.42）

實驗位於 `tests/server/old-writer-barrier.test.ts`（輔助程式為 `tests/helpers/old-writer-barrier*.ts`）。LATEST 為 33，合成的 migration 為 34，`PRAGMA schema_version` 由 266 增為 268。以下為開發機上的結果（`[T]`）：

| 情境 | 結果 | 對應組合 |
|---|---|---|
| 舊 MCP stdio 寫入 | `MCP_RESTART_REQUIRED` | 1 |
| 舊 HTTP API 寫入 | 503 `server_restart_required`；GET 仍為 200 | 2 |
| 長駐 Store 程序（CLI、長任務提交）於提交時 | `DATABASE_SCHEMA_CHANGED` | 3 |
| 長任務持有寫入鎖時的 migration | migration 取得 `SQLITE_BUSY`；任務提交合法；之後 migration 成功 | 3 |
| migration 之後才啟動的舊程序（Store、CLI 備份、MCP） | `DATABASE_SCHEMA_VERSION_TOO_NEW` | 4（部分：舊 CLI 與 MCP） |
| 被拒絕的寫入 | 0 個資料列 | — |
| 各情境的 `integrity_check` | 皆為 ok | — |
| migration 前以 `VACUUM INTO` 建立的快照 | 可讀、integrity ok、可由應用程式開啟 | — |

**結論：**

- **方案 1 為主要屏障**：已確認 MCP、HTTP API 與長駐 Store 寫入端，都會在交易邊界拒絕寫入或回報 schema 變更。
- **方案 2 仍需實作**：須阻止舊 launcher 啟動舊 MCP。未知的外部 client 不能假設可被強制中斷。
- **方案 3 保留為備援**：無法安全排除外部寫入端時，更新分為「安裝 App」與「稍後升級資料庫」，絕不自行硬升 DB。
- **前置檢查**：repo checkout 的 MCP 另有較早的 build identity 檢查，會先回 `MCP_RESTART_REQUIRED`，因此 MCP 的結果包含此前置檢查。
- **未驗證**：組合 4 的其餘部分（Codex plugin、Claude Code plugin、MCPB、未經 launcher 的手動 stdio 設定）與 Windows 檔案鎖、WAL 行為，待實機驗收。本實驗不證明外部 client 的行為。

---

## 11. 風險清冊（摘要）

完整的 R01–R34 風險表、Gate、工程票與 V1 排除理由，見 [風險・Gate・工程票對應](desktop-v1-risk-gate-ticket-matrix.md)。

`P0`：可能遺失或誤操作資料、未授權的權限提升、無法修復的更新或接管失敗；公開發行前必須驗證。`P1`：嚴重的功能可靠性、可用性或相容性問題；支持的平台必須解決。`P2`：改善體驗與維運，可排入後續版本。這是設計風險優先序，**不是已偵測到的 bug 計數**。

R01–R14 與 R33 如設計契約未通過，**不得宣稱 V1 可公開自動更新或接管舊資料**。R15–R30、R34 對宣告支援的平台須有通過案例，或明確關閉相關功能並於發行聲明中說明。

---

## 12. 借鑑 GitHub 開源實作：有證據的採用與不採用

- **Actual Budget**（[Electron entry](https://github.com/actualbudget/actual/blob/master/packages/desktop-electron/index.ts)、[security](https://github.com/actualbudget/actual/blob/master/packages/desktop-electron/security.ts)、[navigation E2E](https://github.com/actualbudget/actual/blob/master/packages/desktop-electron/e2e/navigation-security.test.ts)、[startup-errors E2E](https://github.com/actualbudget/actual/blob/master/packages/desktop-electron/e2e/startup-errors.test.ts)）`[U]`：`global-store.json` 的暫存檔替換與 `.bak` 復原、`utilityProcess.fork()` 啟動 loopback 子服務、導航與 permission 限制、資料目錄不可用時的修復 UI 與 E2E。**適用**：設定持久化、子程序就緒、修復畫面、導航安全與真實壞檔案系統的 E2E。**不照抄**：其同步後端可由 Electron 管理，但本專案的 stdio MCP 必須在 Electron 退出後仍能由 Agent 啟動，因此需要標準 Node 加固定 launcher；另對決定 DB 路徑與 owner 的關鍵設定，落盤失敗時偏向中止而非就地覆寫。`[D]`
- **Rancher Desktop**（[tray.ts](https://github.com/rancher-sandbox/rancher-desktop/blob/main/pkg/rancher-desktop/main/tray.ts)）`[U]`：獨立 Tray 類別反映後端與網路狀態，選單中有明確可用與禁用的項目。**適用**：tray 反映 `STARTING／MANAGED／EXTERNAL／NEEDS_REPAIR` 等真實狀態。**不照抄**：其為 VM／container 背景服務，與 SQLite／MCP 的所有權不同，**不能拿其 backend kill 或服務策略作為 SQLite 接管證據**。`[D]`
- **electron-builder**（[signed manifests](https://github.com/electron-userland/electron-builder/blob/master/website/docs/features/signed-update-manifests.md)、[auto-update](https://www.electron.build/docs/features/auto-update/)、[Security & Hardening](https://www.electron.build/docs/features/security/)）`[U]`：v27 的 Ed25519 metadata 簽章、公鑰嵌入與 key rotation；session-end 時 on-quit 安裝中斷的風險。**版本陷阱**：Security & Hardening 明示 v27 為 next，不可把 v27 特性寫成 v26 已有（§7.1）。**適用**：CI 產生完整簽章 release、正式安裝包內公鑰、故意破壞 manifest 的測試、公鑰輪替測試。`[D]`
- **Electron 官方**：[`app.requestSingleInstanceLock()`](https://www.electronjs.org/docs/latest/api/app) 與 `second-instance` 只能防止同一 App 多開，**不是**偵測所有外部 API 或 checkout 程序的機制；[`utilityProcess`](https://www.electronjs.org/docs/latest/api/utility-process) 可作為受管理子程序的候選，但不滿足「GUI 關閉後 Agent stdio 能自行啟動」；[Security Checklist](https://www.electronjs.org/docs/latest/tutorial/security) 要求 context isolation、sandbox、Navigation／IPC sender 驗證與外部 URL 限制。`[U][D]`
- **SQLite 官方**：[Online Backup API](https://sqlite.org/backup.html) 與 `VACUUM INTO` 可作一致快照；[WAL](https://www.sqlite.org/wal.html) 說明本機共享記憶體與網路 FS 的限制；[`PRAGMA integrity_check`](https://www.sqlite.org/pragma.html) 不能取代 `foreign_key_check`；[URI immutable 注意事項](https://www.sqlite.org/uri.html)。**適用**：重用現有 `backup.ts`，並補上「備份之後真的能還原」與「migration／restore 不直接覆寫活躍 DB」的實機驗證。`[U][R][D]`

**借鑑原則**：只擷取小而清楚的機制，保留各專案的 license 聲明。若真正複製開源程式碼，須再確認對應檔案的 license、相依套件與再散布義務。本稿只研究模式，未引入外部程式碼。

---

## 13. 工程拆票與依賴關係

工程票（DT-01 至 DT-37）、與 R3 §13 Epic 的對應、相依關係與完成證據，見 [風險・Gate・工程票對應](desktop-v1-risk-gate-ticket-matrix.md) 的「工程票索引」。

**CI 分層**：純邏輯 unit → 包裝後的 runtime smoke → fake home／Agent integration → Electron Playwright E2E → 實際 OS service 與 host 測試 → 正式簽署的 N→N+1 release install／repair 測試。任何會佔用使用者真實 `$HOME`、真實 Codex／Claude 根目錄或預設 3210 的自動化測試，都必須改為隔離環境，不得觸碰使用者的實際工作庫（DT-36）。

---

## 14. 待決策問題、非目標與封版檢核

### 14.1 進入首輪 coding 前的決策狀態

| 問題 | 狀態／建議 | 驗證方式 | Owner |
|---|---|---|---|
| 首發平台？ | **已決定**：Windows 11 x64 與 macOS 同批（ADR-02）。Linux 排除；Windows ARM 排除待確認 | 兩平台同批的完整安裝、更新、修復紀錄 | 產品＋發行 |
| Node runtime 如何帶進 App？ | 優先標準 Node 加 versioned resources，不仰賴 Electron GUI（ADR-04，待原型） | Node／FTS5／worker／MCP／大小／Windows 檔案鎖基準 | Runtime |
| DB 身分定義與變更屏障？ | 正規化路徑＋OS 檔案身分＋DB 自身 identity；以 §10.4 實驗驗證舊 MCP 與 HTTP／CLI 寫入端 | 長連線 schema 變更、restore race | Storage／MCP |
| 管理授權如何與普通 API 隔離？ | 限時會話、Host:port 精確比對、原生高風險確認（ADR-11、ADR-12） | curl 假 headers、Web XSS、跨使用者 | Security／Web |
| 自動更新是否於 V1 宣告？ | 若 metadata 可信驗證未成，改為手動下載官方安裝包（ADR-25） | 鎖工具版本與篡改測試 | Release |
| 外部管理模式是否只提供連結？ | 是；不控制無法證明身分的服務（ADR-09） | 接管混合安裝與多 checkout | Desktop |
| SQLite 修補的發行證據？ | 開發機 3.53.4 已量測（§7.3.1）；bundled 值待 release 產物確認 | 1.6.41 T3 CI 檢查；release 產物列印 | Runtime／Release |

### 14.2 非目標

多資料庫同時切換或合併、遠端 API 管理、雲端同步、重新設計報表或搜尋、Agent 自主安裝或修改其他專案的 hooks、強制替換 plugin 或 MCPB、全面管理其他 OS 使用者的服務、內嵌完整 Dashboard、服務常駐的外部 daemon 架構。**Linux 與 Windows ARM 亦不在 V1。** 若新增任一項，須另經設計審查與資料安全評估。

### 14.3 封版檢核

- [ ] 鎖定 repo commit、Electron／Node／electron-builder／electron-updater 版本與其 license。
- [ ] 七條 invariants 有自動測試映射。
- [ ] DB 來源、身分、TOCTOU 與多來源衝突矩陣通過（G-DB-01）。
- [ ] 舊 MCP、HTTP API 與長駐 CLI 寫入端於 schema migration／restore 期間的寫入已實測阻斷（G-DB-02；含 1.6.41 T2）。
- [ ] 無 Node、GUI 退出、Agent／MCP／hook 啟動與 Windows runtime 檔案鎖測試通過（G-MCP-01）。
- [ ] OS service ownership、切換、失敗回復、正常退出不重啟測試通過（G-SVC-01、G-SVC-02）。
- [ ] 本機控制 API 威脅模型（含非瀏覽器本機程序）測試通過，含 Host:port 精確比對（G-SEC-01；含 1.6.41 T4）。
- [ ] 修復視窗不依賴 Web／API 存活；無系統匣或選單列圖示時仍可進入（G-UX-01）。
- [ ] 備份可驗證且可還原；schema 升級與失敗回復不覆蓋唯一副本（G-DB-03）。
- [ ] 發行 metadata 與安裝包具對應工具版本的實際可信驗證機制（G-UPD-01）。
- [ ] 同批 Windows 11 x64 與 macOS 的正式簽章安裝包完成 N→N+1 與解除安裝演練，並輸出 `sqlite_version()` 修補證據（G-UPD-01、G-DB-03；含 1.6.41 T3）。
- [ ] Windows 11 實機完成資料夾選擇（IFileOpenDialog，1.6.41 T1）、NSIS、schtasks 與檔案鎖驗收，並記錄於 `docs/release-checklist.md`。
- [ ] CLI、standalone、plugin 不安裝桌面 App 也能依既有方式使用。
- [ ] 發行來源、更新 key rotation、發行失敗停止派送與修復安裝包程序就緒。

---

## 附錄：審查的程式碼與外部文件索引

### Repo 基準

- R4 基準：[WorkLog.Ai `d464ea5`](https://github.com/Ponpon55837/WorkLog.Ai/commit/d464ea5)（main，Merge PR #361，1.6.40）。R3 基準為 `7723b72`，R4 已改用 `d464ea5` 並核對以下路徑皆存在。
- 資料庫啟動：[apps/server/src/start-api.ts](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/apps/server/src/start-api.ts)（建構 store 在 listen 之前）。
- DB 位置：[packages/shared/src/database-location.ts](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/packages/shared/src/database-location.ts)。
- DB 預覽：[apps/server/src/database-inspection.ts](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/apps/server/src/database-inspection.ts)（readOnly metadata）；[doctor.ts](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/apps/server/src/doctor.ts)（`probeSqlite`）。
- 初始化與 migration：[database-initialization.ts](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/packages/storage/src/database-initialization.ts)；[schema-migrations.ts](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/packages/storage/src/schema-migrations.ts)。
- MCP 寫入閘：[packages/storage/src/store.ts](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/packages/storage/src/store.ts)（`withCompatibleSchema`）；[apps/mcp/src/server.ts](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/apps/mcp/src/server.ts)；快取鍵 [data-revision-cache.ts](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/packages/storage/src/data-revision-cache.ts)。
- 備份：[packages/storage/src/backup.ts](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/packages/storage/src/backup.ts)（`VACUUM INTO` 與 staging）。
- Agent plan／apply：[apps/server/src/agent-setup.ts](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/apps/server/src/agent-setup.ts)。
- 資料夾選擇：[apps/server/src/folder-picker.ts](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/apps/server/src/folder-picker.ts)。
- Dashboard 啟動：[scripts/dashboard.mjs](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/scripts/dashboard.mjs)。
- API 安全（Host、Origin）：[apps/server/src/server.ts](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/apps/server/src/server.ts)；子程序關閉：[shutdown.ts](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/apps/server/src/shutdown.ts)。
- 平台登入：[apps/server/src/user-service.ts](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/apps/server/src/user-service.ts)；[docs/service.md](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/docs/service.md)。
- standalone、Agent、plugin、發行：[standalone.md](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/docs/standalone.md)、[agent-setup.md](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/docs/agent-setup.md)、[plugins.md](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/docs/plugins.md)、[release.md](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/docs/release.md)、[release-checklist.md](https://github.com/Ponpon55837/WorkLog.Ai/blob/d464ea5/docs/release-checklist.md)。

### 外部參考（版本與行號可能變動，採用前應鎖 commit）

- Actual Budget：[Electron entry](https://github.com/actualbudget/actual/blob/master/packages/desktop-electron/index.ts)、[security](https://github.com/actualbudget/actual/blob/master/packages/desktop-electron/security.ts)、[navigation-security E2E](https://github.com/actualbudget/actual/blob/master/packages/desktop-electron/e2e/navigation-security.test.ts)、[startup-errors E2E](https://github.com/actualbudget/actual/blob/master/packages/desktop-electron/e2e/startup-errors.test.ts)。
- Rancher Desktop：[Tray](https://github.com/rancher-sandbox/rancher-desktop/blob/main/pkg/rancher-desktop/main/tray.ts)。
- electron-builder：[signed manifest](https://www.electron.build/docs/features/signed-update-manifests/)、[v27 migration](https://www.electron.build/docs/migration/v27-build-changes/)、[auto-update](https://www.electron.build/docs/features/auto-update/)、[Security & Hardening](https://www.electron.build/docs/features/security/)。
- Electron：[app single instance](https://www.electronjs.org/docs/latest/api/app)、[utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)、[security](https://www.electronjs.org/docs/latest/tutorial/security)。
- SQLite：[backup](https://sqlite.org/backup.html)、[WAL（含 WAL-reset 修補）](https://www.sqlite.org/wal.html)、[SQLite 3.51.3 修補紀錄](https://sqlite.org/releaselog/3_51_3.html)、[URI immutable](https://www.sqlite.org/uri.html)、[PRAGMA](https://www.sqlite.org/pragma.html)。

**審查結論**：可保留現有桌面版的產品方向。在分工實作前，需先完成 DB 身分與 schema 相容契約、受控服務身分、Agent 獨立 runtime、管理 API 授權、可信更新管道五大 P0 契約。首發範圍為 Windows 11 x64 與 macOS 同批發行。外部開源案例只支持具體模式，不能代替本專案在各首發平台的完整系統驗證。

---

**文件控制說明：** R4 由 R3（`7723b72` 基準）修訂而來，基準更新為 `d464ea5`（1.6.40），目標為 1.6.41。主要變更包括：首發平台改為 Windows 11 x64 與 macOS 同批發行；更正 R03 的 MCP 寫入閘描述；補入 SQLite 版本量測與 1.6.41 T3 檢查；Host:port 比對（1.6.41 T4）與 Windows 資料夾選擇（1.6.41 T1）；風險表與工程票移至風險矩陣；重複段落已合併。本文修訂本身不含程式變更（1.6.41 T1–T4 的程式變更見各節 commit），亦不代表自動更新、平台支援或安全測試已通過。完整修訂紀錄見 [README](README.md)。
