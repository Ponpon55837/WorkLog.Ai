# Work Intelligence 桌面版 V1：元件契約（R4）

**基準：** `d464ea5`（1.6.40）；目標 1.6.41。**修訂日期：** 2026-11-16。

**性質說明**：本檔是**設計契約草案**。介面以語意簽章表示，不是已實作的 API。每個元件列出責任、輸入與輸出、不變條件、平台特定要求，以及對應的工程票（DT-xx，見[風險矩陣](desktop-v1-risk-gate-ticket-matrix.md)）與 ADR（見[決策紀錄](desktop-v1-adr.md)）。平台以 **W** = Windows 11 x64、**M** = macOS 表示；Linux 不在 V1。

**與既有程式的邊界**：`packages/storage`、`apps/server`、`apps/mcp` 不得依賴 Electron。桌面元件位於獨立界線（建議 `apps/desktop`），共享部分以純 TypeScript 模組表達（ADR-08 與 R4 §2.1）。

---

## 桌面主程序與 UI

### C-01 DesktopMain（Electron 主程序）

- **責任**：每位使用者的單一執行鎖；生命週期；協調其他元件；操作進度；登入項；updater。
- **輸入**：使用者啟動、再次啟動（`second-instance`）、登入項觸發、作業系統的 quit／shutdown、子程序事件、更新事件。
- **輸出**：開啟瀏覽器的 URL（只限已提交的 active 狀態）；修復視窗；狀態給 tray 與 Web。
- **不變條件**：
  - 單例鎖只防止本 App 多開；不用來判斷外部 API 或 checkout 程序。`[U]`
  - 只對自己啟動且能證明身分的子程序發出控制命令（DT-11）。
  - 結束前依 §5.1 的停止順序執行，不假裝已成功。
- **平台**：W 的登入項以目前使用者為範圍；M 的 App 必須已簽署，並位於可更新的位置（DT-29）。
- **對應**：DT-15、DT-16、DT-35；ADR-01、ADR-26；R18、R24。
- **1.6.44 實作**：單例鎖在 `whenReady` 之前取得，第二次啟動立即結束（`apps/desktop/src/main/index.ts`、`second-instance.ts`）。登入項預設關閉，開啟需 consent（`packages/desktop-core/src/shell/login-item.ts`、`apps/desktop/src/main/settings.ts`）。結束經 `QuitFlow`：確認、停止受管服務；若有進行中的操作，取消並有界等待，逾時直接停止子程序；最後檢查 exit 與 port 釋放。未證明停止時記錄並提示，不宣稱成功（`packages/desktop-core/src/shell/quit-flow.ts`、`apps/desktop/src/main/quit.ts`）。更新（updater）與簽章尚未實作。

### C-02 TrayController（系統匣／選單列）

- **責任**：顯示真實背景狀態，提供開啟 Dashboard、服務狀態、修復、結束等操作。
- **輸入**：C-01 的狀態（`STARTING`、`MANAGED`、`EXTERNAL`、`NEEDS_REPAIR` 等）、各操作的可用性。
- **輸出**：使用者的選單動作（轉交 C-01）。
- **不變條件**：
  - 無法控制圖示單擊行為時，選單第一項固定為「開啟 Dashboard」。
  - 不可用或禁用的項目需明確標示，不可點擊後才報錯。
  - 結束 App 的文字必須說明「退出後不會每日備份」（ADR-26）。
- **平台**：W 位於通知區（可能被隱藏於溢出區）；M 位於選單列（可能被系統隱藏）。兩者都需要「無圖示」備援（C-11）。
- **對應**：DT-15、DT-35；R18、R24。
- **1.6.44 實作**：選單由 `buildTrayMenu` 產生（`packages/desktop-core/src/shell/tray-menu.ts`）。「開啟 Dashboard」永遠是第一項，只在受管服務執行中可用，否則標籤說明原因。「退出」的標籤含「退出後不會每日備份」（`packages/desktop-core/src/shell/i18n.ts`）。原生 tray 與選單列由 `apps/desktop/src/main/tray.ts` 呈現；位置與可見性待實機驗收。

### C-22 Web 系統狀態與管理介面（既有 Vue，新增控制）

- **責任**：在 Web 顯示服務、資料與備份、Agent 連線、版本更新四類狀態；只有桌面管理的實例顯示控制項。
- **輸入**：後端的 `/api/...` 狀態；管理授權會話（C-10）。
- **輸出**：固定動作（重新啟動、切換 port 等）的請求；所有高風險操作都改為 C-10 + 原生確認（C-01）。
- **不變條件**：
  - 不顯示 `desired` 設定為「目前使用中」（§10.1）。
  - 管理授權只存記憶體；不寫入 `localStorage`、URL query 或日誌。
  - 換 port 時保留可安全還原的路徑；有未儲存的編輯則先提示。
  - 不因 port 變更而傳遞 DB 路徑 token（R20）。
- **對應**：DT-14、DT-17；R09、R20。

- **1.6.51 實作**：Web 狀態頁只顯示目前位址與「在桌面 App 變更連接埠」按鈕（`apps/web/src/views/SystemStatusView.vue`、`apps/web/src/stores/system-status.ts`）。按鈕經 `POST /api/desktop/open-port-settings` 只請 App 開啟連接埠區段，並交出白名單偏好與目前路由；Web 不接收、不保存 App 的 session 或 token。新位址的頁面由 `apps/web/src/utils/port-handoff.ts` 讀取一次性 fragment，寫入白名單偏好後立即移除 fragment，並回到原路由（若存在）或 Dashboard 首頁。系統狀態頁以警告顯示資料庫位置風險（`desktop.storageRisk`）；unknown 只顯示為提示。

### C-11 RepairWindow（內建修復視窗）

- **責任**：Web 與 API 不可用時仍可完成修復、查看診斷、重試或切換模式。
- **輸入**：C-01 提供的狀態、操作紀錄、診斷摘要。
- **輸出**：修復動作（轉交 C-01，經 C-10 之外的原生確認）。
- **不變條件**：
  - 只載入 App 內附資源與固定 scheme；`nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`；最小 preload API；逐項驗證 IPC sender（ADR-13）。
  - 拒絕未知 navigation、webview 與 `window.open`；default-deny permissions；採 CSP。
  - 不依賴 Web 或 API 存活。
- **平台**：W 與 M 都需測試無 tray 與無預設瀏覽器的情境（DT-16）。
- **對應**：DT-16；R14、R18。
- **1.6.44 實作**：修復視窗為 `BrowserWindow`，`sandbox` 與 `contextIsolation` 為真，`nodeIntegration` 與 `webviewTag` 為假（`apps/desktop/src/main/repair-window.ts`）。`security.ts` 拒絕導覽、重新導向、`window.open` 與 webview，權限請求一律拒絕。修復頁只經 `wi-repair://` 的固定表提供，回應附 CSP（`packages/desktop-core/src/shell/navigation-policy.ts`）。IPC 每個通道先驗 sender（只接受修復視窗的主框架），再以 zod 驗輸入（`apps/desktop/src/main/ipc.ts`）。修復動作（重試、選擇資料庫（須先預覽）、開啟資料夾、匯出診斷）經 IPC 轉交。修復頁不經 Web 或 API 載入。無 tray 與無預設瀏覽器的情境待實機驗收。

---

## 資料與 DB

### C-03 DesktopSettingsStore

- **責任**：保存 `DesktopSettingsV1`（`desired`、`active`、`lastKnownGood`），以及操作日誌的位置與版本。
- **輸入**：使用者設定、C-04 的階段提交、C-16 的更新結果。
- **輸出**：目前生效的設定（只讀）、待套用值。
- **不變條件**（ADR-20）：
  - 暫存檔 → 驗證 → fsync（視平台）→ 原子 replace；無法保證時建立可驗證副本，不就地覆寫唯一設定。
  - 讀取失敗不當作全新安裝；只有確定 `ENOENT` 且沒有其他來源才視為新使用者。
  - 設定升級支援讀舊版本並 fail-closed。
  - `installId` 不是授權密鑰。
- **平台**：W 的目錄為目前使用者可寫；M 為 `~/Library` 下的使用者目錄（ACL 與權限由平台決定）。
- **對應**：DT-20；R29。
- **1.6.42 實作**：`packages/desktop-core/src/settings/`（`atomic-write.ts`、`read.ts`、`schema.ts`）；暫存檔（同目錄、`wx`、0o600）→ fsync → 重讀驗證 → recovery copy → rename → 目錄 fsync（win32 或不支援的檔案系統跳過並回報）。讀取時只有 primary 與 recovery 皆為 `ENOENT` 且無其他來源才視為新安裝；primary 損毀時改用 recovery copy 並標示；未來版本或權限不足則為 needs-repair，絕不使用 recovery。讀取從不寫入，並拒絕覆寫較新版本的設定。

### C-05 DbSourceResolver（DB 來源解析與身分）

- **責任**：收集候選來源、辨識有效性、判定唯一性，產生可由使用者選擇的結果。全程唯讀。
- **輸入**：已提交設定、使用者選擇、OS 舊服務定義、plugin link、Agent MCP 設定、standalone 與 checkout 預設。
- **輸出**：`SourceCandidate[]`，每筆含來源類型、原字串、解析基準、展開後絕對路徑、受管理狀態、有效性狀態（`missing`、`offline`、`denied`、`unreadable`、`unsupported-schema`、`ok`、`conflict`），以及 DB 身分（策略待定）。
- **不變條件**：
  - 不寫入任何檔案；唯讀取得的 schema 與專案數只作預覽。
  - 不以路徑字串或專案數判定唯一性；比較正規化路徑與 OS 檔案身分（ADR-06）。
  - 無法證實時不建議「沿用」，也不 fallback 建空庫。
  - 網路 FS、同步資料夾、外接碟列為風險來源；V1 不自動接管（ADR-07）。
- **平台**：W 比較檔案識別與 UNC 路徑；M 處理 `~/Library` 與外接碟；兩者都需驗證 symlink 與 hard link（DT-08）。
- **對應**：DT-01、DT-08；R01、R22、R23。
- **1.6.42 實作**：`packages/desktop-core/src/db-source/`（`collect.ts`、`decide.ts`、`grouping.ts`、`identity-compare.ts`、`resolve.ts`）與 `packages/shared/src/file-identity.ts`；唯讀收集七類候選（desktop-committed、explicit-selection、legacy-service、plugin-link、agent-mcp、standalone-default、checkout-default），狀態互不混淆；以 fileId（無法取得時以 realPath）分組，並標示血統衝突；選擇依優先序，高優先來源不可用時阻擋而非往下遞補；新建只在使用者明確同意且無其他來源時提供。身分規則見 ADR-36。

- **1.6.51 實作**：`DbSourceResolver` 之後的 DB 位置判定（DT-08）分為 none、網路、可移除、雲端同步、硬連結與 unknown，於啟動與選擇資料庫時執行，判定有時限（Windows DriveInfo 3 秒；macOS mount 與 diskutil 2 秒；Linux `/proc/mounts`）；系統磁碟且不在雲端根目錄者不啟動子程序；失敗與逾時為 unknown，不快取（`packages/desktop-core/src/db-source/storage-policy.ts`、`storage-risk-node.ts`、`storage-risk-override.ts`；`apps/desktop/src/main/storage-risk.ts`）。網路磁碟不能作為 App 資料庫；可移除、雲端同步與硬連結只能勾選同意後選擇，且不做 schema 更新；unknown 只阻擋一鍵選擇。「複製到本機磁碟並改用」由 `copy-to-local.ts` 與 `apps/server/src/database-copy.ts` 完成（`VACUUM INTO` 經唯讀預覽子程序，再 `PRAGMA quick_check`，檔名不覆寫），之後以日誌化切換改用複本，原檔不變。

### C-06 DbPreflight（唯讀 preflight）

- **責任**：在任何可能 migration 的 store 建構之前，對選定 DB 做唯讀檢查與提交前重驗。
- **輸入**：C-05 選定的候選、目標 port、目前服務所有權。
- **輸出**：`PreflightResult`（schema 版本、相容等級、sidecar 狀態、可用空間、備份目錄可寫性）。
- **不變條件**：
  - 使用唯讀連線；不刪除或搬動 `-wal`／`-shm`；對活躍 DB 不使用 `immutable=1`（ADR-07）。
  - 慢速 `integrity_check` 不阻擋一般初次啟動（R4 §2.1）。
  - 提交前重驗 realpath 與檔案身分；若在預覽後被替換，中止並回到選擇（TOCTOU）。
  - preflight 失敗不得建立空 DB（ADR-08）。
- **平台**：W 的檔案鎖與 sidecar 行為需以實機測試；M 的 quarantine 不影響唯讀檢查，但要測試安裝後首次開啟。
- **對應**：DT-02；R02、R23、R34。
- **1.6.42 實作**：`apps/server/src/database-preflight.ts`（`preflightDatabase`、`revalidateBeforeCommit`）與 `apps/server/src/start-api.ts` 的 `startApi({ database })` 已驗證入口；以 `node:sqlite` 唯讀開啟（不使用 `immutable=1`），回報身分、血統、schema 相容性（empty、current、older-needs-migration、newer-unsupported）與 sidecar 前後狀態；提交前重驗路徑、檔案與血統；已驗證入口拒絕建立不存在的資料庫，CLI 行為不變。

### C-07 DbCompatibilityGate（寫入端 schema 閘）

- **責任**：在每個寫入端（MCP、HTTP API、長駐 CLI、長任務提交）檢查目前 schema 是否仍與程序啟動時一致；不一致時拒寫。
- **輸入**：程序啟動時記錄的 schema 版本或 epoch；每次寫入前讀取的 `schema_migrations` 最大版本或 `PRAGMA schema_version`。
- **輸出**：通過則放行寫入；不通過則回錯誤（MCP 為 `MCP_RESTART_REQUIRED`；寫入交易（含 HTTP API）在 1.6.41 T2 後為 `server_restart_required`，HTTP 503）。
- **不變條件**：
  - MCP 寫入路徑已有此閘（`store.withCompatibleSchema()`，於寫入交易內比對）`[R]`。
  - HTTP 與 CLI 的閘以 `PRAGMA schema_version` 快取，避免每個請求重查（1.6.41 T2，已實作，commit 3ff1e45）。
  - 無法證明相容時，遷移流程必須確保該寫入端不能在遷移後再寫入（R4 §7.3）。
  - 單一 lockfile 只做協調，不是強制隔離。
- **平台**：W 的 Agent 與 CLI 行為要實機測試；M 同。
- **對應**：DT-03、DT-04；R03。

### C-15 BackupAndRestoreService

- **責任**：升級前與手動備份、備份驗證（可讀回）、restore 守門。重用既有 `backup.ts`（`VACUUM INTO`、私有 staging、no-clobber 發布）。
- **輸入**：DB 路徑、備份目錄、保留設定、目標 schema。
- **輸出**：快照路徑與驗證結果（`integrity_check`、代表性 Session／專案 ID，重大演練另跑 `foreign_key_check`）。
- **不變條件**：
  - 不以 copy 覆寫正在使用的活躍 SQLite；restore 前所有寫入端必須退出或被可靠阻擋（ADR-22）。
  - restore 前保存當前快照並揭露可能流失的資料。
  - 不把三份自動備份視為跨磁碟事故的恢復策略；只提醒使用者另存，不預設上傳。
  - 備份失敗時不進行 migration。
- **平台**：W 的備份目錄與空間檢查需實機測試；M 同。
- **對應**：DT-05、DT-07；R04、R12、R33。
- **1.6.52 實作**：restore 在取代現行資料庫之前，先把備份遷移到暫存副本，並對副本執行 `quick_check` 與 `foreign_key_check`；兩者都通過才改名（rename）取代現行資料庫。驗證失敗回傳 `RESTORE_VERIFY_FAILED`，現行資料庫不變，暫存副本移除（`packages/storage/src/backup.ts`）。以真實程序強制結束還原途中的程序時，現行資料庫不變；還原後保留一份安全快照（`tests/storage/migration-interruption.test.ts`）。DT-07 的壓力測試（`pnpm test:sqlite-stress`）另外驗證已還原快照的指紋與來源相同。桌面 App 目前沒有還原流程，只有 CLI `pnpm db:restore` 適用。

### C-21 SqliteRuntimeCheck

- **責任**：報告 bundled Node 的 `sqlite_version()`、FTS5 可用性與修補狀態；供 `doctor`、系統狀態回應、CI（`ci.yml`）、standalone smoke 與 release workflow 使用（1.6.41 T3 已實作，commit 4420951）。
- **輸入**：執行中的 Node 的 `node:sqlite`；發行產物的 Node 二進位（release 時）。
- **輸出**：版本字串、是否低於修補版的 warning、release 中的列印記錄。
- **不變條件**：
  - 判定以 `sqlite_version()` 為準，不以 `engines` 或 Node 主版號推定（ADR-19）。
  - 開發機的量測（Node 22.23.4 → 3.53.4 `[T]`）不能代表發行產物。
- **平台**：W 與 M 各自的 bundled Node 都需檢查。
- **對應**：DT-06、DT-25；R33。

---

## 服務、子程序與管理權

### C-04 OperationCoordinator 與 OperationJournal

- **責任**：協調所有影響管理權的操作（接管、換 DB、換 port、套用 Agent、重啟、還原、更新安裝）；持久化操作紀錄與階段。
- **輸入**：操作請求（`operationId`、來源、參數摘要、預期狀態）。
- **輸出**：操作結果；`BUSY`（附目前操作）；可查詢的狀態。
- **不變條件**（ADR-21）：
  - 單一全域鎖；同 ID 的重送回傳同一結果（idempotent）。
  - 持久化 `phase`、`previousOwner`、`selectedDb`、`oldServiceDefinition`、`oldEnabledState`、`oldRunningState`、`lastKnownGood`、`migrationStarted`、`recoveryPolicy`（不保存密鑰）。
  - 恢復時依真實 OS 服務、DB 與 manifest 重建狀態，不只依賴 journal 文字。
  - 「不可立即取消」階段（SQLite 寫入、installer 交接）須明確顯示，不得以 kill 取代。
- **平台**：W 與 M 的操作紀錄都放在使用者可寫的固定目錄。
- **對應**：DT-09、DT-10；R19、R30。
- **1.6.42 實作**：`packages/desktop-core/src/operations/`（`service-owner-state.ts`、`operation-journal.ts`、`journal-store.ts`、`coordinator.ts`、`recovery.ts`）；ServiceOwner 的狀態轉移表以資料表示；檔案式原子 journal，重送冪等；`recover()` 依注入的 OS／DB 探測結果重建狀態，而非依 journal 文字；migration 有證據後禁止還原舊服務，並進入 NEEDS_REPAIR。單一行程內的全域鎖：同 ID 回傳同一結果，不同 ID 回 BUSY；跨程序鎖屬 DT-15。取消在副作用發生後延後到恢復處理。

### C-08 BackendChild（後端子程序）

- **責任**：啟動後端、建立私有 IPC、等待 readiness、收尾與 drain。
- **輸入**：已驗證的設定（DB 絕對路徑、port、備份目錄）、`runId`。
- **輸出**：`ready` 訊息（見 R4 §10.3）；收尾完成的回報。
- **不變條件**：
  - 以 `spawn(..., {shell:false})` 與 argv array 啟動。
  - 環境變數採明確 allowlist（尤其 `WORK_INTELLIGENCE_DB`、`PORT`、`BACKUP_DIR`）；開發者 shell 的 Node 選項、不可信 PATH 與 Electron flags 不傳遞。
  - 只有 parent 在本次啟動中建立的 IPC handle 才可提交管理權（§10.3）。
  - 父程序失聯時子程序自行收尾。
- **平台**：W 的子孫程序需確認 port 釋放（DT-13）；M 同樣要檢查 process tree。
- **對應**：DT-11；R19。
- **1.6.44 實作**：`BackendSupervisor` 只操作自己 spawn 的 `ChildProcess`，並以 `shell: false` 與 argv 啟動（`packages/desktop-core/src/backend/backend-supervisor.ts`）。環境變數 allowlist 只含 OS 變數（POSIX：`HOME`、`TMPDIR`、`LANG`、`TZ`、`LC_*`；Windows：`SystemRoot`、`TEMP`、`USERPROFILE` 等）、固定 PATH，以及 `WORK_INTELLIGENCE_*` 桌面值；`NODE_OPTIONS` 與使用者的 PATH 不傳（`packages/desktop-core/src/backend/child-environment.ts`）。DB 路徑、port 與備份目錄**不經 env**，而是經私有 IPC 的 `start` 訊息傳遞；runId 也只經 IPC。父程序失聯時子程序自行收尾（`apps/server/src/desktop-child.ts`）。

### C-09 ServiceOwnerAdapter（OS 服務 adapter）

- **責任**：辨識、預覽、接管、停止與回復既有服務（登入項、排程、LaunchAgent、Windows schtasks）。
- **輸入**：服務定義、runner 路徑、port、DB 身分、OS 註冊資訊。
- **輸出**：歸屬判定（見 R4 §4.2 證據層級）、接管預覽、可還原的服務定義。
- **不變條件**（ADR-09、ADR-10）：
  - 只停止已驗明的程序樹；不 kill 無法辨識的程序。
  - 弱線索（名稱、PID、port、health、版本、命令列）不足以歸屬。
  - 失敗時先停桌面子程序；若 DB 相容，恢復舊註冊與原執行狀態；若 migration 已開始，禁止自動重啟舊服務（ADR-22）。
- **平台**：
  - **W**：以 `schtasks` 管理登入背景與服務。停止排程後，必須證明並終止 runner 與 `conhost` 子孫程序，並確認 port 釋放（DT-13，R05）。
  - **M**：以 LaunchAgent 管理（DT-12）；服務辨識需要 `launchctl` 的註冊資訊，並檢查 plist 的所有權。
- **對應**：DT-12、DT-13；R05、R06。

### C-10 ManagementAuthGate（管理 API 授權）

- **責任**：對桌面管理 API 的每個請求，驗證 Host、Origin、會話與 CSRF。
- **輸入**：HTTP 請求（`Host`、`Origin`、`Content-Type`、會話憑證、CSRF 憑證）。
- **輸出**：放行或拒絕（`421`、`403` 等）。
- **不變條件**（ADR-11、ADR-12）：
  - **Host 比對（1.6.41 T4，已實作，commit dadaae4）**：允許的 Host = loopback 名稱 × 實際 listen port，加上每個 allowed origin 的精確 host:port。現況 `[R]` 僅比對 hostname。
  - Host 與 Origin 同時成立才放行管理操作。
  - 授權碼 TTL 短、一次性，綁定 `runId + origin + exact port`；透過 URL fragment 交換為限時會話後立即 `history.replaceState` 清除。
  - 管理授權只存記憶體；不進入 URL query、日誌或持久化瀏覽器儲存。
  - 高風險操作（恢復登入服務、刪除或還原 DB、變更路徑、安裝更新、寫 Agent 設定）必須經 C-11 或 C-01 的原生確認。
- **平台**：W 與 M 的 loopback 名稱都為 `127.0.0.1`、`localhost`、`[::1]`；測試 DNS rebinding 與 IPv6。
- **對應**：DT-17、DT-18；R09、R10、R25。

---

## Agent 與 runtime

### C-12 AgentIntegrationService

- **責任**：Agent 設定的非互動 plan、apply、verify、compensate；擷取自既有 `agent-setup.ts` 的 `AgentSetupPlan` 與 `mutations`（R4 §2.1）。
- **輸入**：Agent 來源（Codex、Claude Code、Claude Desktop、手動、plugin、MCPB），選定的 DB，選定的變更集。
- **輸出**：plan（新增、沿用、更新、略過、衝突，附路徑、範圍、原因），操作日誌，驗證結果。
- **不變條件**（ADR-14）：
  - apply 前逐項重驗檔案指紋；外部異動則停止並要求人工處理（R16）。
  - 只補償仍由 App 擁有且未被外部修改的項目。
  - 不宣稱能回滾第三方 plugin 或 MCPB 的宿主管理器。
  - 保留其他工具與其他專案的設定；不得自行改寫 JSON／TOML 之外的字串。
  - CLI 行為不變。
- **平台**：W 的 Codex 與 Claude 設定路徑（`CODEX_HOME`、`CLAUDE_CONFIG_DIR`）需實機驗證；M 同。
- **對應**：DT-21；R15、R16、R17。

### C-13 AgentStatusModel

- **責任**：保存並計算每個 Agent 的顯示狀態與驗證等級（R4 §3.2.1）。
- **輸入**：C-12 的寫入結果、host handshake 結果、hook 信任狀態、runtime 版本契約。
- **輸出**：`AgentStatus`（`source`、`effectiveDb`、`launcherKind`、`manifestOwner`、`lastVerifiedAt`、`verificationLevel`、顯示狀態）。
- **不變條件**（ADR-34）：
  - 只有 host handshake 或明確檢測才可顯示「已觀察到連線」。
  - 寫入檔案而未驗證載入時顯示「已配置、待確認」。
  - 更新 MCP 契約後，顯示「需重新連線」而非直接判定已同步（R28）。
- **對應**：DT-22；R28。

### C-14 LauncherAndRuntimeStore（launcher、runtime manifest、GC）

- **責任**：固定 launcher、版本化 runtime 目錄、manifest 的原子切換、延後 GC。
- **輸入**：manifest（R4 §10.2）、安裝的 runtime 版本、現役連線資訊。
- **輸出**：launcher 執行結果（只允許固定 action）；GC 的刪除或延後結果。
- **不變條件**（ADR-15、ADR-16）：
  - launcher 以 argv array 啟動，禁止 shell 解譯；只允許 `mcp`、`codex-finalize-reminder`、`claude-finalize-reminder` 等固定動作。
  - 讀取 manifest 後驗證檔案 checksum、schema 與允許的 action。
  - 拒絕所有權不可信或 world-writable 的目錄。
  - GC 條件：無現役連線且可安全刪除；不以 PID 不存在作為依據。
  - hook 找不到 runtime 時放行，並提供後續診斷。
- **平台**：
  - **W**：檔案鎖可能阻止刪除；GC 延後重試，更新不因鎖而失敗（DT-24，R08）。
  - **M**：從 DMG 執行時不可更新；quarantine 屬性需測試（DT-29）。
- **對應**：DT-23、DT-24；R07、R08、R13。

### C-20 DashboardBridge

- **責任**：讓 Agent 的開頁要求由 App 處理，使用已生效的 port，不自行啟動 checkout server。
- **輸入**：Agent script 或 skill 的開頁請求；使用者層管理設定（已生效的 port）。
- **輸出**：開啟 App 或瀏覽器的請求；無法連到 App 時的診斷。
- **不變條件**（ADR-28）：
  - 不因舊 script 的 health 檢查而重啟 checkout server（R4 §6.2）。
  - 遷移預覽需標示仍自行啟動 server 的舊 plugin。
- **對應**：DT-27；R19。

---

## 更新、安裝與移除

### C-16 UpdateService（updater、metadata 驗證、三階段）

- **責任**：查詢版本、下載、驗證 metadata 與安裝包、安裝前檢查、安裝、新版驗證、回報三階段結果（R4 §7.2）。
- **輸入**：固定官方 GitHub Releases 來源、目前版本、使用者的安裝決定。
- **輸出**：`desktopInstalled`、`backendReady`、`dataCompatible` 三個獨立結果。
- **不變條件**（ADR-23、ADR-24、ADR-25）：
  - 來源固定；不接受使用者輸入的鏡像 URL。客戶端不使用 GitHub token。
  - metadata 簽章與檔案 hash 驗證失敗時，保留舊版與原服務。
  - 只有使用者明確安裝時才安裝；退出時不靜默安裝；安裝前先排空後端。
  - 無法證明 metadata 驗證時，改為手動下載（V1）。
  - 下載完成不等於已安裝。
  - 只回退程式；若 DB 已 migration，不自動回退 DB（ADR-22）。
- **平台**：
  - **W**：NSIS 目前使用者安裝，產物須簽章；`autoInstallEvent` 與退出競爭需實測（DT-30）。
  - **M**：DMG 位置檢測與導引（DT-29）；App 須簽署並公證。
- **對應**：DT-28、DT-29、DT-30、DT-31、DT-33、DT-37；R11、R14、R21、R26、R30。

### C-17 FolderPicker（資料夾選擇器）

- **責任**：提供使用者選擇專案資料夾的原生對話框。
- **現況** `[R]`：`apps/server/src/folder-picker.ts` 在 `d464ea5` 的分支：
  - W：`powershell.exe -NoProfile -STA` 執行 `System.Windows.Forms.FolderBrowserDialog`。
  - M：`osascript -e "choose folder with prompt ..."`。
  - Linux：zenity、kdialog（V1 不在驗收範圍）。
- **目標（1.6.41 T1，已實作，commit 1257d3a；實機待實機驗收）**：
  - W 改為 `IFileOpenDialog`。PowerShell `-STA` 搭配 `Add-Type` 的 C# COM interop。
  - 選項：`FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST`。
  - DPI aware；以 TopMost 視窗為 owner。
  - 使用者取消（HRESULT `0x800704C7`）→ exit code `2`。
  - COM 不可用時 fallback 到 `FolderBrowserDialog`（`EnableVisualStyles`）。
  - 輸出為 UTF-8。
- **不變條件**：
  - 只回傳使用者選擇的絕對路徑；Web 不能指定對話框的初始路徑或任意執行命令（ADR-12）。
  - 取消不是錯誤，但須與真正的失敗（exit 非 0 且非 2）區分。
- **平台**：W 需 Windows 11 實機驗收，對應 `docs/release-checklist.md` 的「原生資料夾選擇視窗」條目 `[R]`；M 驗證 `osascript` 的取消行為。
- **對應**：DT-26；ADR-31。

### C-18 DiagnosticsExporter

- **責任**：匯出診斷封包；只在使用者主動要求時寫檔。
- **輸入**：最近操作、錯誤代碼（R4 §8.1）、版本、服務歸屬、設定的遮蔽規則。
- **輸出**：預覽內容與寫入的檔案（經遮蔽）。
- **不變條件**（ADR-29）：
  - 遮蔽授權碼、個資路徑、工作內容與其他工具設定；掃描秘密。
  - 不預設上傳，不包含整份 Agent config、MCP 工具輸入輸出或完整環境變數。
  - 無預設遙測。
- **對應**：DT-19；R32。

### C-19 UninstallAndIntegrationCleanup

- **責任**：解除安裝與移除桌面整合；只處理 App 擁有的項目（ADR-30）。
- **輸入**：安裝清單、各項目的目前指紋、使用者的選擇。
- **輸出**：每一項的「已移除」「保留」「需人工處理」結果。
- **不變條件**：
  - 不刪除 DB、備份與使用者設定（一般移除時）。
  - 不卸除外部 plugin 或 MCPB。
  - 保留使用者修改過的項目，並說明原因。
  - hook 殘留時，即使找不到 App，也應放行。
- **平台**：
  - **W**：NSIS 解除安裝器整合清理流程；只移除 App 擁有項（DT-34，R27）。
  - **M**：拖入垃圾桶可能略過清理，提供「移除桌面整合」入口與重裝後清理（DT-34）。
- **對應**：DT-34；R27。

---

## 測試基座

### C-T 測試替身與隔離環境（DT-36）

- **責任**：提供 fake home、假 Agent 根目錄、合成 DB、假 OS 服務管理器，讓 CI 不觸碰使用者真實資料。
- **不變條件**：
  - 任何會佔用真實 `$HOME`、真實 Codex／Claude 根目錄或預設 3210 的測試，必須改為隔離環境。
  - mock 服務管理器或 fake Agent 的成功，不能取代 OS 與 host 的實機驗收（R4 §9.4）。
- **平台**：W 與 M 各自的 CI runner 需要對應的隔離設定。
- **對應**：DT-36。
- **1.6.42 實作**：`tests/helpers/isolated-environment.ts`，註冊為所有 Vitest 設定的 `setupFiles`（含根目錄 `vitest.config.ts`）。HOME、USERPROFILE、APPDATA、LOCALAPPDATA、XDG_* 等指向每個測試檔自己的暫存目錄；`WORK_INTELLIGENCE_PORT` 設為哨兵值 65533；監聽或連線 3210 會拋錯；真實家目錄中的敏感路徑先取指紋，測試後若被改動，CI 下即失敗。靜態掃描禁止測試中硬編碼 3210（測試位於 `tests/shared/test-isolation.test.ts`）。
