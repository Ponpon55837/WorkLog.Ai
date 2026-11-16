# Work Intelligence 桌面版 V1：決策紀錄（ADR，R4）

**基準：** `d464ea5`（1.6.40）；目標 1.6.41。**修訂日期：** 2026-11-16。本檔記錄 R3 中所有決策，並更新 R4 的變更。每筆 ADR 包含脈絡、決策、後果與狀態。本檔依主題分組，編號不依出現順序排列。

**狀態定義**：

- **已採用**：已有明確決定，且可進入實作。
- **暫定採用**：方向已定，待原型或實測證明。
- **待驗證**：實作前須以實驗或實機確認。
- **已取代**：由後續 ADR 取代，保留原文供追溯。

證據標籤與 README 相同：`[R]` repo 已確認、`[U]` 外部官方文件、`[D]` 設計決策、`[T]` 待驗證假設。

---

## 架構與平台

### ADR-01 桌面框架：Electron 主程序，Dashboard 仍用外部瀏覽器

- **狀態**：暫定採用
- **脈絡**：需要安裝、登入項、系統匣、修復視窗與更新；但既有 Vue Dashboard 已可在瀏覽器使用，不應重寫。
- **決策**：Electron Main 管理系統、服務、tray、登入項、子程序與 updater。Dashboard 維持在外部瀏覽器開啟。修復視窗為 Electron 內附資源。
- **後果**：需維護 Electron 版本與安全設定（ADR-13）。原型可反證此框架。
- **關聯**：§0.3、§5；DT-15、DT-16。

### ADR-02 首發平台：Windows 11 x64 與 macOS 同批發行（取代 R3 的「先 macOS 再 Windows」）

- **狀態**：已採用（產品決策，2026-11-16）；**取代** R3 §0.3、§14.1 的「先 macOS 再 Windows」建議
- **脈絡**：R3 原建議先 macOS，視簽章與驗收能力再開放 Windows，Linux 分開。產品決定 Windows 11 x64 與 macOS 同等重要並同批發行。
- **決策**：首發為 Windows 11 x64 與 macOS（Apple Silicon 與 Intel 皆列為候選，待確認；Intel 的 A 階段決定見 §9.0）。Linux（AppImage、系統匣、登入項）不在 V1，於發行聲明排除；Windows ARM 排除為推論，待確認。CLI、standalone、plugin 不受影響。
- **後果**：Windows 專屬項目（NSIS、schtasks、檔案鎖、IFileOpenDialog）進入首發範圍，排程風險上升。Windows 實機驗收成為發行前提。
- **關聯**：§9；DT-26、DT-34、DT-13、DT-24、DT-36。

### ADR-03 聯合發行門檻：任一首發平台未過即整版不發

- **狀態**：已採用；聯合發行門檻待使用者確認
- **脈絡**：兩平台同批發行，若允許單平台先發，會造成使用者得到不一致的版本，也使更新 metadata 缺附件。
- **決策**：Release 先暫存全部首發平台的簽章產物，完整且驗證通過才一次公開。任一平台的 gate 未過，整版不公開。
- **後果**：更新時程由較慢的平台決定。需在里程碑中預留 Windows 實機時間。
- **關聯**：§9.0、§9.5；DT-33。

### ADR-04 Runtime：隨包標準 Node，供後端、MCP、hook 共用

- **狀態**：暫定採用（待原型）
- **脈絡**：Agent 的 stdio MCP 與 hook 由宿主啟動，App 關閉後仍須運作；系統 Node 與 PATH 不可假設存在；Electron 的 Node 不能被外部宿主當作標準 node 直接使用。
- **決策**：安裝包攜帶標準 Node 可執行檔與後端、MCP、hook、worker、Web 資源，放在實際可執行的路徑（例如 `extraResources`）。原型須比較其與 `utilityProcess` 的大小、冷啟動、FTS5、worker 相容性。
- **後果**：安裝包變大（R31）。需測 bundled Node 的 SQLite 版本（ADR-19）。
- **關聯**：§3.3、§5；DT-25、DT-23。

### ADR-05 DB 沿用 SQLite 與 `VACUUM INTO`，不替換儲存引擎

- **狀態**：已採用
- **脈絡**：既有 `backup.ts` 已用 `VACUUM INTO` 與私有 staging 取得一致快照 `[R]`；不應為桌面版新增第二個儲存引擎。
- **決策**：沿用 SQLite。升級與還原時重用既有備份機制，補上可讀回驗證與 restore 守門（ADR-22）。
- **後果**：相容契約與維護窗口是新增的工作量（ADR-17）。
- **關聯**：§7.4；DT-05。

### ADR-32 範圍負面清單與非目標

- **狀態**：已採用
- **脈絡**：避免桌面版擴大成遠端管理、同步或重寫。
- **決策**：不替換 SQLite、不重寫 Web／API、不新增 SaaS、不導入遠端管理、不強制統一 plugin、不預設遙測、不要求 checkout／standalone 使用者安裝 Electron。多 DB 切換、遠端管理、內嵌 Dashboard 留待後續。
- **後果**：任何觸及資料模型、MCP tool contract 或 CLI 的變更須獨立評估與回歸。
- **關聯**：§0.4、§14.2。

---

## 資料與 schema

### ADR-06 DB 來源選擇：有優先序的選擇，不是錯誤後的 fallback

- **狀態**：已採用
- **脈絡**：不同 config、plugin、舊服務可能指向不同 DB；找不到就建空庫會造成資料分裂。
- **決策**：選擇優先序為：顯式已提交的桌面選擇 > 使用者當次人工選擇 > 唯一且一致的受支援舊設定 > 新安裝預設。來源不唯一、無法證實、或外接來源遺失時，不自動建新庫；新建只能在使用者明確接受的位置進行。
- **後果**：多來源時需使用者介入；但不會默默丟失資料。
- **關聯**：§3.1；DT-01、DT-02；R01、R23。

### ADR-07 唯讀預覽：不視為 0 寫入；活躍 DB 禁用 `immutable=1`

- **狀態**：已採用（行為待測）
- **脈絡**：SQLite WAL 唯讀開庫仍可能使用或建立 `-wal`／`-shm`；`immutable=1` 會跳過變更偵測 `[U]`。
- **決策**：唯讀意圖是不修改業務資料；未經同意不得刪除或搬動 sidecar。活躍 DB 禁用 `immutable=1`。網路 FS、同步資料夾、外接碟列為風險來源，禁止自動接管與遷移。
- **後果**：需以檔案系統監測測試實際副作用（G-DB-01）。
- **關聯**：§3.1.1；DT-02、DT-08；R22、R34。

### ADR-08 啟動順序：preflight 先於任何可能 migration 的 store

- **狀態**：已採用
- **脈絡**：`start-api.ts` 在 `listen()` 之前建構 `WorkIntelligenceStore`，可能觸發 migration `[R]`。
- **決策**：強制順序為設定驗證 → 唯讀 preflight → 服務所有權與 port → 操作協調 → spawn 子程序 → 私有 IPC 身分確認 → HTTP 就緒 → 提交 active 狀態 → 開瀏覽器。桌面需要專用 bootstrap 入口；原 CLI 行為不變。
- **後果**：`startApi()` 需要小幅重構，並保留 CLI 的既有測試。
- **關聯**：§5.1；DT-02、DT-11；R02。

### ADR-17 DB 相容等級與寫入端屏障

- **狀態**：暫定採用（方案待實測）
- **脈絡**：舊版長連線 MCP、HTTP API、CLI 可能在 migration 後寫入；`sqlite_busy` 無法證明沒有寫入端。
- **決策**：以 `READ_WRITE_COMPATIBLE`、`READ_ONLY_COMPATIBLE`、`RECONNECT_REQUIRED`、`INCOMPATIBLE`、`UNKNOWN` 分級。`UNKNOWN` 預設不允許破壞性 migration。屏障候選方案見 §10.4，最終以程序組合實驗決定。
- **後果**：schema 更新前可能需要要求使用者關閉 Agent 或 CLI。
- **關聯**：§7.3、§10.4；DT-03、DT-04；R03。

### ADR-18 寫入端 schema 閘：MCP 已存在，HTTP 與 CLI 由 1.6.41 補上（更正 R3 的 R03）

- **狀態**：已採用（程式碼閱讀結論）；寫入交易閘 **1.6.41 已實作**（commit 3ff1e45），程序組合實驗（DT-04）待完成
- **脈絡**：R3 把 MCP 寫入路徑描述為尚未有 schema 閘。查證後 `packages/storage/src/store.ts` 的 `withCompatibleSchema()` 已在寫入交易內比對 schema 版本，並由 `apps/mcp/src/server.ts` 的寫入路徑呼叫，不符回 `MCP_RESTART_REQUIRED` `[R]`。`apps/server` 的 HTTP 寫入端與長駐 CLI 沒有等價閘。
- **決策**：MCP 維持現有閘。1.6.41 在寫入交易（`Store`，含 HTTP API）加入等價閘，錯誤碼 `server_restart_required`（HTTP 503），檢查以 `data_version` 與 `schema_version` 組成的快取戳記判斷（`data-revision-cache.ts` 已有此模式 `[R]`）。長任務提交前也要檢查。
- **後果**：R03 的缺口縮小為 HTTP、CLI、長任務與未知外部 client。仍須以程序組合實驗證明（§10.4）。
- **關聯**：§7.3；DT-03、DT-04；R03。

### ADR-19 SQLite 版本以實際 `sqlite_version()` 判定，不以 Node 版本推定

- **狀態**：已採用（判定規則）；1.6.41 T3 **已實作**（commit 4420951）
- **脈絡**：`engines` 為 `>=22.16.0 <23 || >=24.0.0` `[R]`，無法保證含 WAL-reset 修補 `[U]`。開發機 Node 22.23.4 回報 SQLite 3.53.4 `[T]`，但那是開發機的值，不是發行產物。
- **決策**：打包規格記錄 bundled Node 的 `sqlite_version()`。`doctor`、`pnpm check`、`/api/health` 報告版本並於低於修補版時警告；standalone smoke 與 release workflow 列印並檢查。落在疑似受影響區間且無回補證據者，不得公開發行多寫入端的桌面 runtime。
- **後果**：release 流程需多一道檢查。開發機的量測不能作為發行證據。
- **關聯**：§7.3.1；DT-06、DT-07；R33。

### ADR-20 設定檔：原子寫入、fail-closed 讀取、不以讀失敗當作新安裝

- **狀態**：已採用
- **脈絡**：設定半寫入或解析失敗若被當作全新安裝，可能覆寫原設定並開空庫（R29）。
- **決策**：暫存檔 → 驗證 → fsync（視平台）→ 原子 replace；無法保證原子替換時建立可驗證的復原副本，不就地覆寫唯一設定。只有確定 `ENOENT` 且無其他來源時才視為新使用者。設定格式升級須支援讀舊版本並 fail-closed。
- **後果**：多一份副本的維護成本；換得可復原性。
- **關聯**：§5.3；DT-20；R29。

### ADR-21 操作日誌、單一 OperationCoordinator 與 idempotent replay

- **狀態**：已採用
- **脈絡**：接管、換 port、換 DB、套用 Agent、更新等操作可能重送、中斷或併發（R19、R30）。
- **決策**：所有影響管理權的操作經單一 `OperationCoordinator`。每個操作有 `operationId` 與持久化的階段。重送同 ID 回傳同一結果；不同 ID 的互斥操作回 `BUSY`。中斷後依真實 OS 服務、DB 與 manifest 重建狀態，不只依賴 journal 文字。
- **後果**：需實作 journal 與對應的測試替身（DT-09、DT-10）。
- **關聯**：§4.1、§6.1；R30；G-SVC-02。

### ADR-22 migration 之後不自動重啟舊服務，DB 不自動回退

- **狀態**：已採用
- **脈絡**：舊程式開新版 DB 會造成寫入不相容；非可逆 schema 變更不能以程式降版來回復資料。
- **決策**：schema 尚未變更且舊版相容時，可恢復外部服務先前狀態。migration 開始或 DB 身分不確定後，禁止自動重啟舊服務，只能進入修復或備份選擇流程。若要還原 DB，先保存當前快照並揭露可能流失的資料，由使用者選擇。
- **後果**：修復流程較複雜，但不會覆蓋工作記錄。
- **關聯**：§4、§7（復原列）、§7.4；DT-05、DT-32；R06、R12。

---

## 服務與管理權

### ADR-09 服務管理權：ServiceOwner 唯一；不 kill 無法證明身分的程序

- **狀態**：已採用
- **脈絡**：另一位使用者或其他 checkout 可能占用同一 port；以 PID、port 或 health 推定歸屬會誤殺程序（R05）。
- **決策**：每位使用者只有一個桌面主程序與一位有效 owner。`DatabaseAccess` 與 `ServiceOwner` 分開：桌面可以管理 API，但不等於 DB 獨占。只操作自己啟動、且能證明身分的子程序。無法證明時維持 `EXTERNAL` 或 `NEEDS_REPAIR`。外部管理服務由原管理者停止。
- **後果**：某些接管情境需使用者手動處理。
- **關聯**：§4、§4.1；DT-12、DT-13；R05、R06。

### ADR-10 服務辨識證據層級

- **狀態**：已採用（各 OS 可靠性待驗證）
- **脈絡**：PID、port、HTTP health、版本號、命令列文字都可能重複或偽造。
- **決策**：弱線索（名稱、PID、port、health、版本、命令列）不足以歸屬。較強線索包括 OS 服務註冊識別、canonical runner、process start-time、可驗證的父子關係、IPC nonce、DB 身分與服務 manifest。
- **後果**：接管流程需收集多項證據；少數情況需人工確認。
- **關聯**：§4.2；DT-12、DT-13。

### ADR-34 Agent 顯示狀態分級：不把「已寫入」顯示為「已連接」

- **狀態**：已採用
- **脈絡**：寫入設定檔不代表宿主已載入 MCP；R28 的風險是陳舊的 skill 或 schema 被顯示為就緒。
- **決策**：狀態分為「已觀察到連線」「已配置、待確認」「需要信任或授權」「外部管理」「設定衝突」「runtime 不相容」。只有 host handshake 或明確檢測才可顯示「已觀察到連線」。
- **後果**：UI 會較保守；需要實機握手測試。
- **關聯**：§3.2.1；DT-22；R28。

---

## 管理 API 與安全

### ADR-11 管理 API 授權：Host:port 精確比對、Origin、會話、CSRF 同時成立

- **狀態**：已採用（判定規則）；Host:port 比對 **1.6.41 已實作**（commit dadaae4）
- **脈絡**：現況 `isAllowedHost()` 只比對 hostname，不比對 port `[R]`；DNS rebinding 與本機其他程序都可能帶假 Host（R09、R10）。
- **決策**：允許的 Host = loopback 名稱 × 實際 listen port，加上每個 allowed origin 的精確 host:port。例如開發環境 Vite 5966 proxy 轉送的 `Host: localhost:5966`。管理 API 另需會話、Origin 與 CSRF。機密不放在 URL query 或日誌。
- **後果**：port 變更時須重建授權；開發代理需明確列在 allowed origin。
- **關聯**：§5.2；DT-17、DT-18；R09、R10；G-SEC-01。

### ADR-12 高風險操作由原生視窗確認；Web 只送固定動作

- **狀態**：已採用
- **脈絡**：瀏覽器擴充、XSS、畫面分享都可能暴露授權碼，授權碼不能作為唯一防護（R09）。
- **決策**：Web 只能送固定動作與經 schema 驗證的值。特權資料夾選擇、設定預覽、恢復登入服務、刪除或還原 DB、變更路徑、安裝更新、寫 Agent 設定，一律回到 App 的本機視窗確認。禁止任意 `exec`、任意 URL 與任意檔案位置。
- **後果**：部分操作需要切換視窗，操作路徑較長。
- **關聯**：§5.2；DT-17。

### ADR-13 修復視窗隔離

- **狀態**：已採用
- **脈絡**：Electron 官方把未受控的 `shell.openExternal` 與未校驗的 IPC 列為風險 `[U]`；修復視窗必須在 Web／API 壞掉時仍可用。
- **決策**：只載入 App 內附資源與固定 scheme；`nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`；最小 preload API；逐項驗證 IPC sender；拒絕未知 navigation、webview 與 `window.open`；default-deny permissions；嚴格 CSP。Web 帶入的字串不交給 `shell.openExternal`。
- **後果**：修復頁功能受限，但安全邊界清楚。
- **關聯**：§5.2；DT-16。

### ADR-33 資料 API 跨 OS 使用者隔離：V1 不做，於發行聲明排除

- **狀態**：已採用（發行聲明排除）
- **脈絡**：loopback 不是 per-user 權限邊界（R25）。既有 CLI、checkout 與第三方腳本依賴目前的資料 API 契約；對其加認證會破壞相容性。
- **決策**：V1 的新增保護只適用於桌面管理 API（ADR-11、ADR-12）。資料 API 的跨使用者隔離列為後續安全議題，並在發行說明中明確界定。
- **後果**：多使用者機器上的資料 API 存在已知限制；須在發行聲明清楚說明。
- **關聯**：§0.4、§5.2、§9.3；DT-18；R25。

### ADR-28 Dashboard bridge：Agent 的開頁要求交給 App，不自啟 checkout server

- **狀態**：已採用
- **脈絡**：既有 plugin 的 dashboard script 會啟動 checkout server；接管後會與桌面服務競爭 port `[R]`。
- **決策**：受支援的 script 與 skill 從使用者層管理設定找到桌面 App 與已生效的 port，把開頁要求交給 App。遷移預覽須指出仍會自行啟動 server 的舊 plugin，並提供更新方式。
- **後果**：舊 plugin 在更新前可能仍重複啟動服務；需在預覽中提示。
- **關聯**：§3.2、§6.2；DT-27；R19。

---

## Agent 整合與 runtime

### ADR-14 Agent 寫入：plan／apply／verify／compensate，非 OS 原子交易

- **狀態**：已採用
- **脈絡**：JSON、TOML、skill、hook 與 host CLI 橫跨多檔，無法保證同時成功（R17）。`agent-setup.ts` 已有 plan 與 mutations `[R]`。
- **決策**：共用非互動 API。每次套用前逐項重驗檔案指紋（R16），保存備份與操作日誌，只對仍由 App 擁有且未被外部修改的項目做補償回復。外部異動時停止並要求人工處理。不宣稱能回滾 plugin 或 MCPB 的宿主管理器。桌面不另寫一套 JSON／TOML 改寫器。
- **後果**：部分失敗需要人工修復；但不會覆蓋使用者設定。
- **關聯**：§3.2；DT-21；R15、R16、R17。

### ADR-15 Agent 固定 launcher 與版本化 runtime manifest

- **狀態**：暫定採用
- **脈絡**：Agent 直接指向版本目錄會在更新後失效；shell 拼接字串有注入風險（R07、R13）。
- **決策**：Agent 的 `command` 指向使用者層固定 launcher。launcher 讀取原子提交的 manifest，以 argv array 啟動，只允許指定動作（`mcp`、`codex-finalize-reminder`、`claude-finalize-reminder`）。檢查 manifest 與 binary 的所有權與 ACL，拒絕 world-writable 目錄。
- **後果**：多一層 launcher 需要測試；換版透過 manifest 切換。
- **關聯**：§3.3、§10.2；DT-23；R07、R13。

### ADR-16 Runtime 延後清理：無現役連線且可安全刪除才 GC

- **狀態**：已採用（Windows 檔案鎖待驗證）
- **脈絡**：Windows 會鎖住執行中的檔案（R08）；PID 可能被重用，不能以 PID 不存在作為可刪除的依據。
- **決策**：runtime 版本化；更新時先安裝新版、驗證完整性、再原子切換 manifest。舊 runtime 的清理需要「無現役連線」與「可安全刪除」兩項條件，失敗則延後重試。
- **後果**：磁碟上會暫時保留多個 runtime 版本。
- **關聯**：§3.3、§10.2；DT-24；R08；G-MCP-01。

---

## 設定、退出與port

### ADR-26 退出語意與登入背景啟動預設

- **狀態**：已採用
- **脈絡**：使用者關瀏覽器不應停服務；結束 App 後，Agent 自啟的 MCP 仍可用，但 App 的每日備份不會再執行（R24）。
- **決策**：關瀏覽器不停止 API 與每日備份。「結束 App」停止其管理的 API 與排程，等工作收尾後結束。介面明示「退出後不會每日備份」。新安裝的「登入時在背景執行」預設關閉；背景啟動失敗時只顯示單次通知或 tray 提示。
- **後果**：使用者若要退出後仍備份，須開啟登入項或使用其他獨立方式（V1 不隱式新增）。
- **關聯**：§1.1、§8.2；DT-15、DT-35；R18、R24。

### ADR-27 Port 策略：預設 3210，實際 bind 為準，跨 port 只搬白名單偏好

- **狀態**：已採用
- **脈絡**：port 預檢無法代表實際 bind 結果；port 改變後 browser origin 也改變（R20）。
- **決策**：預設 `127.0.0.1:3210`，接管時記住既有 port。僅 loopback。實際 bind 失敗不得先建立空 DB。跨 port 只搬運白名單非秘密偏好，不移轉管理會話或 DB 路徑 token。
- **後果**：換 port 時使用者可能需要重新登入管理授權。
- **關聯**：§6、§6.2；DT-14；R19、R20。

### ADR-29 診斷匯出：手動、遮蔽、不預設上傳

- **狀態**：已採用
- **脈絡**：診斷可能含 Agent config、路徑、工作內容與授權碼（R32）。
- **決策**：只在使用者主動匯出時寫檔。匯出前 dry-run、遮蔽個資路徑與授權碼、掃描秘密。不預設上傳 GitHub Issue 或遠端 API。無預設遙測。
- **後果**：支援人員需依賴使用者手動提供診斷。
- **關聯**：§8、§8.1；DT-19；R32。

---

## 更新與發行

### ADR-23 更新的三階段成功定義

- **狀態**：已採用
- **脈絡**：只用一個「成功」布林值會把安裝、後端與資料相容混為一談（R14）。
- **決策**：分為 `desktopInstalled`、`backendReady`、`dataCompatible` 三段，各有完成條件與失敗策略。UI 分別呈現。
- **後果**：UI 與測試需覆蓋三段各自的失敗。
- **關聯**：§7.2；DT-31；R14、R30。

### ADR-24 更新安裝時機：使用者明確安裝、先排空；不在 quit 時靜默安裝

- **狀態**：已採用（實作策略待 `autoInstallEvent` 實測）
- **脈絡**：electron-updater 文件指出 Windows 與 Linux 的退出時安裝可能與 OS session 結束競爭 `[U]`（R21）。
- **決策**：使用者明確按下安裝後，先排空後端再安裝。延後時，一般退出不得安裝。若無法證明沒有意外安裝，採用 manual 或 onNextLaunch 策略，並保留外部可啟動的修復安裝包。
- **後果**：更新需要使用者多一次操作。
- **關聯**：§7.1、§7（切換版本列）；DT-30；R21。

### ADR-25 更新工具版本鎖定；無法證明 metadata 驗證時改為手動下載

- **狀態**：待驗證（版本待鎖）
- **脈絡**：electron-builder v27 的 Security & Hardening 文件明示 v27 為 next `[U]`；v26 只靠 `sha512` 不能保護 manifest 本身（R11）。
- **決策**：A 階段鎖定精確的 electron、electron-builder、electron-updater 版本，並實測 metadata 簽章與篡改拒絕。若使用 v27 的能力，需以實測證明。若 v26 無法提出等價的來源驗證方案，V1 改為手動前往官方 Releases 下載經平台驗證的安裝包，不宣稱自動更新已完成。
- **後果**：V1 可能只有手動更新。
- **關聯**：§7.1；DT-28；R11。

### ADR-30 解除安裝與桌面整合移除只處理 App 擁有的項目

- **狀態**：已採用
- **脈絡**：NSIS 解除安裝器可能清掉未受管理的資料（R27）；macOS 拖入垃圾桶不會執行清理。
- **決策**：移除只刪除 App 擁有的登入項、Agent 整合、hook 與啟動器（依安裝清單與指紋）。DB、備份與設定保留，並顯示實際位置。提供「移除桌面整合」入口，並在重裝後清理殘留。外部 plugin 與 MCPB 不擅自卸除。
- **後果**：移除流程需要辨識 App 擁有的項目，這依賴安裝清單的正確性。
- **關聯**：§8、§9.1、§9.2；DT-34；R27。

### ADR-31 Windows 資料夾選擇：以 IFileOpenDialog 取代 WinForms

- **狀態**：1.6.41 已實作（T1，commit 1257d3a）；Windows 11 實機驗收待實機驗收
- **脈絡**：現況為 `System.Windows.Forms.FolderBrowserDialog`，透過 `powershell.exe -NoProfile -STA` 執行 `[R]`。
- **決策**：改用 `IFileOpenDialog`（PowerShell `-STA` + `Add-Type` C# COM interop）；選項 `FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST`；DPI aware；TopMost owner。取消（HRESULT `0x800704C7`）→ exit `2`。COM 不可用時 fallback 到 `FolderBrowserDialog`（`EnableVisualStyles`）。輸出 UTF-8。
- **後果**：需要 Windows 11 實機驗收，對應 `docs/release-checklist.md` 的條目；CI 無法取代。
- **關聯**：§9.1；DT-26。

---

## 驗證與決策紀錄

### ADR-35 SQLite 量測與修補證據的使用限制

- **狀態**：已採用（使用限制）
- **脈絡**：本機 Node 22.23.4 的 `sqlite_version()` = 3.53.4 `[T]`；官方指出 WAL-reset 修補自 3.51.3 起 `[U]`。
- **決策**：量測只作為方向性證據，發行判定以 release 產物的 bundled 值為準（ADR-19）。WAL 壓力測試與 integrity 測試不能取代修補證據。
- **後果**：發行前仍需 release 產物的列印與保存。
- **關聯**：§7.3.1；DT-06、DT-07。
