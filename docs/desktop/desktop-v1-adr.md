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
- **1.6.45 的打包**：Windows 11 x64 與 macOS 的安裝包都由 `desktop-package` 產出；macOS 以 arm64 與 x64 分開建置（不做 universal），x64 在 macos-15-intel 建置。架構分開的建議待產品確認（見 §9.0、§14.1）。
- **關聯**：§9；DT-26、DT-34、DT-13、DT-24、DT-36。

### ADR-03 聯合發行門檻：任一首發平台未過即整版不發

- **狀態**：已採用；聯合發行門檻待使用者確認
- **脈絡**：兩平台同批發行，若允許單平台先發，會造成使用者得到不一致的版本，也使更新 metadata 缺附件。
- **決策**：Release 先暫存全部首發平台的產物（ad-hoc 簽章或未簽章，見 ADR-38），完整且驗證通過才一次公開。任一平台的 gate 未過，整版不公開。
- **後果**：更新時程由較慢的平台決定。需在里程碑中預留 Windows 實機時間。
- **1.6.45 的實作**：`desktop-package`（windows-x64、macos-arm64、macos-x64）與 `release.yml` 已接線，發行 job 必須等它成功，安裝包才會加入 `SHA256SUMS.txt` 與 GitHub Release。三平台實際執行的結果於發行前確認。
- **關聯**：§9.0、§9.5；DT-33。

### ADR-04 Runtime：隨包標準 Node，供後端、MCP、hook 共用

- **狀態**：已採用（階段 1 spike，1.6.43）
- **脈絡**：Agent 的 stdio MCP 與 hook 由宿主啟動，App 關閉後仍須運作；系統 Node 與 PATH 不可假設存在；Electron 的 Node 不能被外部宿主當作標準 node 直接使用。spike 比較兩個候選：**A** Electron 內建 Node（`ELECTRON_RUN_AS_NODE=1`，並設 `ELECTRON_NO_ASAR=1`）與 **B** 隨包官方 Node.js（Node 24，本次量測為 24.22.3，內建 SQLite 3.54.1，含 FTS5）。`utilityProcess` 未在本次 spike 中量測（見後果）。
- **決策**：選 **B**。安裝包攜帶官方 Node 可執行檔與後端、MCP、hook、worker、Web 資源，放在實際可執行的路徑（`extraResources`）。
- **理由**：
  - A 需要 Electron 的 `RunAsNode` fuse 保持開啟，而 Electron 安全指引建議停用 [U]。A 也讓任何程序都能把已簽章的 App 當成通用 Node 使用；在 macOS 上，權限（TCC）可能由宿主程序繼承 [T]。
  - A 需要 `ELECTRON_NO_ASAR=1`，因為 Electron 讀取 asar 內檔案的方式與一般檔案不同（見 commit 7c75778）。
  - Electron runtime 較大：目錄為 Node 的 2.1–3.7 倍，壓縮後為 3.0–4.3 倍（Windows 163.5 比 37.9 MB，macOS 125.8 比 42.4 MB）；閒置 RSS 在 Windows 與 macOS 相近，Linux 高約 27–36 MB。
  - B 的官方 Node 在 macOS 有 Developer ID 簽章，發行附 SHASUMS256，launcher 可據以核對。
  - 冷啟動兩者都在 0.9 秒內完成首次啟動，快慢依平台與 run 而異（見量測後的說明），不影響選擇。
- **量測**（CI，1.6.43）：

| 平台與 runtime | runtime 目錄 | tar.gz | 完整／快取驗證 | 伺服器啟動（首次／中位數／直接） | MCP 啟動（首次／中位數／直接） | 閒置 RSS（伺服器／MCP） | 檢查 |
|---|---|---|---|---|---|---|---|
| Windows x64，Node.js 24.22.3 | 102.5 MB（117 檔） | 37.9 MB | 174 ms／10 ms | 586／400／354 ms | 537／282／242 ms | 93.3／79.4 MB | 45/45 |
| Windows x64，Electron 45.3.3 | 382.8 MB（188 檔） | 163.5 MB | 290 ms／6 ms | 542／257／225 ms | 530／155／141 ms | 94.3／72.4 MB | 45/45 |
| macOS arm64，Node.js 24.22.3 | 131.1 MB（117 檔） | 42.4 MB | 194 ms／9 ms | 863／436／403 ms | 656／303／265 ms | 124.3／111.1 MB | 45/45 |
| macOS arm64，Electron 45.3.3 | 278.3 MB（375 檔） | 125.8 MB | 404 ms／43 ms | 769／397／280 ms | 689／274／236 ms | 123.5／113.1 MB | 45/45 |
| Linux x64，Node.js 24.22.3 | 135.4 MB（117 檔） | 47.7 MB | 156 ms／5 ms | 412／219／220 ms | 372／200／183 ms | 127.2／110.9 MB | 46/46 |
| Linux x64，Electron 45.3.3 | 295.3 MB（187 檔） | 127.5 MB | 299 ms／7 ms | 575／218／217 ms | 547／198／182 ms | 154.1／147.4 MB | 46/46 |

  - 欄位定義：伺服器啟動為從啟動到 `/api/health` 的時間（首次、快取後中位數），「直接」為不經 launcher 直接執行官方執行檔；MCP 欄位為到 `initialize` 完成的時間。
  - 全部數字來自同一次 CI：run 43864453651（d250c93），三平台 × 兩種 runtime 的 6 個 job 全數通過（Linux 多一項「serve 程序是隨包執行檔」檢查，故為 46 項）。tar.gz 為 runtime 目錄依 manifest 順序寫成 tar、以 Node 內建 zlib gzip level 6 壓縮的位元組數（`scripts/desktop-runtime-spike/compressed-size.mjs`），不呼叫系統 `tar`：Windows bsdtar 以 ANSI code page 讀參數，含中文的暫存路徑在 run 43859516900 無法開檔；同一 Linux runtime 用此法得 47.7 MB，系統 `tar -czf` 為 46.6 MB，多約 2%。
  - 冷啟動：各為單次 CI 量測，雜訊大（同平台不同 run 可差 100 ms 以上）。這一輪 Electron 的中位數在 Windows 明顯較快（伺服器 257 比 400 ms，MCP 155 比 282 ms），macOS 略快，Linux 相同；Windows 上官方 Node 直接啟動就較慢（354 比 225 ms），差距不在 launcher。冷啟動不是選 B 的理由，也不是否決 B 的理由：兩者都在 0.9 秒內完成首次啟動。
  - Bundle 7.1 MB，Web 1.2 MB，launcher 20.9 KB。Linux 不在 V1 首發範圍，數字只作方向參考。
- **後果**：
  - 安裝包增加約 38–48 MB（壓縮後）的獨立 Node.js，與 Electron App 分開下載（R31）。
  - B 的 SQLite 版本以 release 產物的 `sqlite_version()` 判定（ADR-19）；本次 spike 的 SQLite 3.54.1 來自量測，發行判定仍以 release 產物為準。
  - `utilityProcess` 未量測，R31 要求的 A 階段比較因此未完整；若要改用 `utilityProcess`，需另行量測。
  - spike 預設鎖定 Node.js v24.22.3（`--node-version 24` 才取最新 24 LTS）；發行前仍須驗證發行簽章（目前 SHASUMS256 與封存檔來自同一來源，尚未實作簽章驗證）。
- **1.6.44 的實作**：殼（`apps/desktop`）鎖定 Electron 45.3.2（`apps/desktop/package.json`）；主程序負責 UI、tray、修復視窗與子程序的協調。後端子程序由 launcher 的 `serve` action 啟動，可執行檔與執行方式由 manifest 的 `runtimeKind` 決定；只有 `electron-run-as-node` 會設定 `ELECTRON_RUN_AS_NODE`（`packages/desktop-core/src/runtime/launch-plan.ts`）。依本 ADR，App 啟動後端時要求 `runtimeKind` 為 `node`，其他類型回報 `RUNTIME_KIND_NOT_ALLOWED`（`planLaunch` 的 `requiredRuntimeKind`，`packages/desktop-core/src/backend/node-dependencies.ts`）；煙霧測試組出的是 `node` 類型（`apps/desktop/scripts/run-smoke.mjs`）。spike 量測的是 Electron 45.3.3；它在 2026-11-16 才發布，殼改鎖定已發布數日的 45.3.2。`pnpm-workspace.yaml` 的 `allowBuilds: electron: false` 使 `pnpm install` 不下載 Electron 二進位；只有 `pnpm test:desktop-smoke` 與 desktop-smoke CI 透過 `apps/desktop/scripts/ensure-electron.mjs` 下載。
- **1.6.45 的實作**：發行包把官方 Node.js 24.22.3 與後端放在 `extraResources` 的 `runtime-bundle/`（asar 之外）；manifest 的 SHA-256 內嵌於主程式包。首次啟動時 App 將 runtime 安裝到 launcher root（Windows 為 `%LOCALAPPDATA%\WorkIntelligence\runtime`，macOS 為 `~/Library/Application Support/WorkIntelligence/runtime`，指定 `--user-data-dir` 時為 `<userData>/runtime`）；流程為 staging、退避重試更名、完整雜湊、指紋快取、原子切換 `current`；同版本走不做雜湊的快速路徑。
- **關聯**：§3.3、§5、§9.4、§10.2；DT-25、DT-23；R07、R31、R33。

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
- **1.6.44 狀態**：候選預覽由 `preview` 子程序執行，只送 `preflight`、不送 `start`，因此不 listen，也不開啟可寫連線（`packages/desktop-core/src/backend/backend-supervisor.ts`）；sidecar 的實際行為待實機驗收。
- **1.6.51 狀態**：DB 位置的風險分類（網路、可移除、雲端同步、硬連結、unknown）已實作，啟動與選擇資料庫時執行；網路磁碟拒絕作為 App 資料庫，其他風險位置不一鍵沿用、不更新 schema，必須勾選同意。「複製到本機磁碟並改用」以 `VACUUM INTO` 與 `quick_check` 產生複本，原檔不變。真實磁碟與雲端根目錄的判定待實機驗收（`apps/desktop/src/main/storage-risk.ts`、`local-copy.ts`）。
- **脈絡**：SQLite WAL 唯讀開庫仍可能使用或建立 `-wal`／`-shm`；`immutable=1` 會跳過變更偵測 `[U]`。
- **決策**：唯讀意圖是不修改業務資料；未經同意不得刪除或搬動 sidecar。活躍 DB 禁用 `immutable=1`。網路 FS、同步資料夾、外接碟列為風險來源，禁止自動接管與遷移。
- **後果**：需以檔案系統監測測試實際副作用（G-DB-01）。
- **關聯**：§3.1.1；DT-02、DT-08；R22、R34。
- **1.6.42 觀察（本機 Node 22.23.4／SQLite 3.53.4，`[T]`，非發行產物）**：以唯讀方式開啟已正常關閉的 WAL 資料庫，會在同一資料夾建立 `-wal` 與 `-shm`，關閉後仍保留；主檔的 SHA-256、mtime 與業務資料列皆不變。另一個寫入端持續寫入且 WAL 非空時，preflight 不改變 `-wal`／`-shm`，並讀得到只存在於 WAL 中的資料列。因此「唯讀不等於 0 寫入」已確認；預覽不刪除任何 sidecar。Windows 行為待實機驗證。

### ADR-36 DB 身分策略：檔案身分＋唯讀血統指紋，嵌入 UUID 延後

- **狀態**：已採用（1.6.42）
- **脈絡**：DB 來源選擇（ADR-06）與提交前重驗（R23）需要判定兩個路徑是否指向同一個資料庫，以及兩個檔案是否為同一份資料的副本。純路徑字串會被 symlink、大小寫與 Windows 8.3 短名影響；專案數與 schema 版本不能作為身分。預覽舊庫時寫入 UUID 會違反唯讀原則（§10.1）。
- **決策**：`DatabaseIdentity` 由三部分組成：
  - `realPath`：`fs.realpathSync.native` 的結果；win32 比較時不分大小寫。
  - `fileId`：`fs.statSync(..., { bigint: true })` 的 `dev`／`ino`，以十進位字串保存。Windows 上由 libuv 對應到 volume serial 與 64-bit file index；`ino` 為 0 時（部分網路或 FUSE 掛載）為 `null`。
  - `lineageId`：`schema_migrations` 中最小版本那一列 `version|name|applied_at` 的 SHA-256。唯讀取得；該列於建立資料庫時寫入、之後不改寫，因此備份副本會得到相同的值。它代表「血統」而非「檔案」。
  - 規則：相同 `fileId` 即為同一個實體資料庫（去重）；不同 `fileId` 而相同 `lineageId` 為副本，判定為 conflict，由使用者選擇；不同 `lineageId` 為獨立資料庫。
  - 比對：預期 `lineageId` 為 `null`、實際非 `null` 時，只在 `fileId` 相同時允許（首次 migration 建立 `schema_migrations` 的情況）。
  - 提交前重驗（`revalidateBeforeCommit`）：兩邊 `fileId` 皆已知時必須相同，否則為 `file-replaced`；否則正規化路徑必須相同，否則為 `path-replaced`；血統不符為 `lineage-changed`。
  - 預覽舊庫絕不寫入。嵌入 UUID 只能在日後經授權的 migration 中補上。
- **後果**：DB 身分不依賴可變的路徑或專案數，副本與獨立庫可以區分。代價是依賴檔案系統提供穩定的 `ino`；`fileId` 為 `null` 時只能靠正規化路徑與血統判斷，C-05 的規則仍要求無法證實時不建議沿用。Windows 上的檔案 ID 行為尚未於實機驗證（`[T]`）。
- **關聯**：ADR-06、§3.1、§10.1；DT-01、DT-02。

### ADR-08 啟動順序：preflight 先於任何可能 migration 的 store

- **狀態**：已採用
- **1.6.44 狀態**：子程序依序執行 `hello`、唯讀 preflight、`start`、`ready` 與 HTTP 證明。preflight 在 spawn 之後、`start` 之前完成，與本 ADR 的字面順序不同；但「`start` 才會開啟可能 migration 的 store」這一不變條件成立（`packages/desktop-core/src/backend/backend-supervisor.ts`、`apps/server/src/desktop-child.ts`）。桌面入口為 `start --desktop-ipc`。
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
- **DT-04 實驗結論（1.6.42）**：方案 1 已確認為 MCP、HTTP API 與長駐 Store 寫入端的主要屏障。舊 MCP stdio 寫入回 `MCP_RESTART_REQUIRED`；HTTP 寫入回 503 `server_restart_required`（GET 仍為 200）；長駐 Store 在提交時回 `DATABASE_SCHEMA_CHANGED`；migration 之後才啟動的舊程序回 `DATABASE_SCHEMA_VERSION_TOO_NEW`。被拒絕的寫入沒有留下資料列，所有情境的 `integrity_check` 都回 ok。長任務持有寫入鎖時，migration 取得 `SQLITE_BUSY`，任務提交仍合法，之後 migration 成功。方案 2 仍須實作（阻止舊 launcher 啟動舊 MCP），且無法約束未知的外部 client；方案 3 保留為備援。repo checkout 的 MCP 另有較早的 build identity 檢查，會先回 `MCP_RESTART_REQUIRED`。Codex plugin、Claude Code plugin、MCPB、手動 stdio 與 Windows 檔案鎖／WAL 仍待實機驗收。證據：`tests/server/old-writer-barrier.test.ts`。

### ADR-18 寫入端 schema 閘：MCP 已存在，HTTP 與 CLI 由 1.6.41 補上（更正 R3 的 R03）

- **狀態**：已採用（程式碼閱讀結論）；寫入交易閘 **1.6.41 已實作**（commit 3ff1e45），程序組合實驗（DT-04）**1.6.42 已完成** CI 可驗證部分（commit 5bdd530，見 ADR-17）；plugin、MCPB 等組合待實機驗收
- **脈絡**：R3 把 MCP 寫入路徑描述為尚未有 schema 閘。查證後 `packages/storage/src/store.ts` 的 `withCompatibleSchema()` 已在寫入交易內比對 schema 版本，並由 `apps/mcp/src/server.ts` 的寫入路徑呼叫，不符回 `MCP_RESTART_REQUIRED` `[R]`。`apps/server` 的 HTTP 寫入端與長駐 CLI 沒有等價閘。
- **決策**：MCP 維持現有閘。1.6.41 在寫入交易（`Store`，含 HTTP API）加入等價閘，錯誤碼 `server_restart_required`（HTTP 503），檢查以 `data_version` 與 `schema_version` 組成的快取戳記判斷（`data-revision-cache.ts` 已有此模式 `[R]`）。長任務提交前也要檢查。
- **後果**：R03 的缺口縮小為 HTTP、CLI、長任務與未知外部 client。仍須以程序組合實驗證明（§10.4）。
- **關聯**：§7.3；DT-03、DT-04；R03。

### ADR-19 SQLite 版本以實際 `sqlite_version()` 判定，不以 Node 版本推定

- **狀態**：已採用（判定規則）；1.6.41 T3 **已實作**（commit 4420951）
- **1.6.52 狀態**：打包的 runtime 現在斷言 `sqlite_version()`（含修補與 FTS5），並把 Node 與 SQLite 版本及修補狀態記錄於打包結果；打包 smoke 另以內建 runtime 執行 6 秒的 DT-07 壓力測試。壓力測試（`pnpm test:sqlite-stress`）不取代打包版的修補證據。Windows x64、macOS x64、macOS arm64 的打包 runtime 皆為 Node 24.22.3、SQLite 3.54.1（含修補）；6 秒壓力測試全部通過，每個 OS 的總時間 14.0／16.7／11.9 秒（PR #374 CI）。
- **脈絡**：`engines` 為 `>=22.16.0 <23 || >=24.0.0` `[R]`，無法保證含 WAL-reset 修補 `[U]`。開發機 Node 22.23.4 回報 SQLite 3.53.4 `[T]`，但那是開發機的值，不是發行產物。
- **決策**：打包規格記錄 bundled Node 的 `sqlite_version()`。`doctor`、`pnpm check`、`/api/health` 報告版本並於低於修補版時警告；standalone smoke 與 release workflow 列印並檢查。落在疑似受影響區間且無回補證據者，不得公開發行多寫入端的桌面 runtime。
- **後果**：release 流程需多一道檢查。開發機的量測不能作為發行證據。
- **關聯**：§7.3.1；DT-06、DT-07；R33。

### ADR-20 設定檔：原子寫入、fail-closed 讀取、不以讀失敗當作新安裝

- **狀態**：已採用；1.6.42 已實作契約與測試（packages/desktop-core）
- **脈絡**：設定半寫入或解析失敗若被當作全新安裝，可能覆寫原設定並開空庫（R29）。
- **決策**：暫存檔 → 驗證 → fsync（視平台）→ 原子 replace；無法保證原子替換時建立可驗證的復原副本，不就地覆寫唯一設定。只有確定 `ENOENT` 且無其他來源時才視為新使用者。設定格式升級須支援讀舊版本並 fail-closed。
- **後果**：多一份副本的維護成本；換得可復原性。
- **關聯**：§5.3；DT-20；R29。

### ADR-21 操作日誌、單一 OperationCoordinator 與 idempotent replay

- **狀態**：已採用；1.6.42 已實作契約與測試（packages/desktop-core）；1.6.56 將復原接到主程序啟動流程（H-01）
- **脈絡**：接管、換 port、換 DB、套用 Agent、更新等操作可能重送、中斷或併發（R19、R30）。
- **決策**：所有影響管理權的操作經單一 `OperationCoordinator`。每個操作有 `operationId` 與持久化的階段。重送同 ID 回傳同一結果；不同 ID 的互斥操作回 `BUSY`。中斷後依真實 OS 服務、DB 與 manifest 重建狀態，不只依賴 journal 文字。主程序啟動時，於讀取設定之後、首次設定與後端啟動之前執行復原。復原依真實狀態（設定檔、DB 身分與 schema、子程序、舊服務偵測）關閉中斷的操作，不採信 journal 的階段文字。
- **後果**：journal 為空時，啟動只多一次讀取。損毀的 journal 改名隔離後從空白重來（M-06）。需實作對應的測試替身（DT-09、DT-10）。
- **關聯**：§4.1、§6.1；R30；G-SVC-02。

### ADR-22 migration 之後不自動重啟舊服務，DB 不自動回退

- **狀態**：已採用
- **1.6.56 狀態**：啟動復原（H-01）依真實狀態判斷是否已 migration（DB 身分與 schema），不讀 journal 的 `migrationStarted`。已 migration 或 DB 身分不確定時，不自動重啟舊服務，改進入修復或還原流程。App 內還原（H-02）見 C-15。
- **1.6.52 狀態**：DT-32 的測試已實作（CI 可驗證部分）：三份真實舊版樣本的升級測試（`tests/storage/upgrade-samples.test.ts`）、以真實程序中斷 migration、備份與還原的測試（`tests/storage/migration-interruption.test.ts`），以及桌面 smoke（`apps/desktop/tests/desktop-smoke/migration-interruption.spec.ts`）驗證 migration 開始後不回到舊服務。還原前驗證遷移後的副本，失敗回傳 `RESTORE_VERIFY_FAILED` 且現行資料庫不變。實機行為待實機驗收。
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
- **1.6.47 的實作**：`packages/desktop-core/src/agents` 的 MCP stdio 握手探測（initialize、notifications/initialized、tools/list，含分頁、逾時與程序樹終止）與 `classifyAgentStatus`，結果分為設定寫入、自我測試、host 觀察（current、stale、none）與信任提醒三層。`apps/mcp` 在程序內第一次收到 host 的 `initialize` 時記錄觀察（`agent-observations.json`，fail-open）；契約指紋相同的觀察才顯示「已觀察到連線」，指紋不同顯示需要重新連線。Host clientInfo：Claude Code 與 Codex 依文件與實驗確認；`claude-ai`（Claude Desktop）未驗證。真實 host 的握手待實機驗收。
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
- **1.6.44 狀態**：已依本 ADR 實作於 `apps/desktop`（視窗設定、最小 preload、IPC sender 與 zod 驗證、導覽與權限拒絕、CSP）；三平台 desktop-smoke CI 已通過（[run 43929965453](https://github.com/Ponpon55837/WorkLog.Ai/actions/runs/43929965453)）；實機待驗收。
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
- **1.6.47 的實作**：`scripts/dashboard.mjs`（`launch.mjs dashboard`）在沒有 server 回應該 port、且紀錄有效時，以 `--open-dashboard` 分離啟動 App 後結束（exit 0），不啟動 checkout server。App 在後端就緒後開啟一次 Dashboard；第二個實例透過單例鎖的附加資料轉交請求；STARTING、QUIESCING、PREPARING 期間的請求延後並合併為一次開啟。換 port 與 App 離線的實機情境待實機驗收。
- **關聯**：§3.2、§6.2；DT-27；R19。

---

## Agent 整合與 runtime

### ADR-14 Agent 寫入：plan／apply／verify／compensate，非 OS 原子交易

- **狀態**：已採用
- **脈絡**：JSON、TOML、skill、hook 與 host CLI 橫跨多檔，無法保證同時成功（R17）。`agent-setup.ts` 已有 plan 與 mutations `[R]`。
- **決策**：共用非互動 API。每次套用前逐項重驗檔案指紋（R16），保存備份與操作日誌，只對仍由 App 擁有且未被外部修改的項目做補償回復。外部異動時停止並要求人工處理。不宣稱能回滾 plugin 或 MCPB 的宿主管理器。桌面不另寫一套 JSON／TOML 改寫器。
- **後果**：部分失敗需要人工修復；但不會覆蓋使用者設定。
- **1.6.47 的實作**：共用 API 位於 `packages/agent-setup`。plan 為每個檔案記錄 sha256；apply 前、寫入前後與 rename 前逐項重驗，外部異動即停止、不覆蓋，標記為 `externally-modified`。持久化操作日誌（fsync 後以 rename 寫入）在第一次寫入前建立；補償只回復本次寫入且內容仍相同的項目，由新到舊；遇到外部異動時標記 `needs-manual-repair`。recovery 在動任何檔案前驗證 journal 路徑；無法讀取的 journal 移到 `.corrupt-<ts>`，不刪除。`setup:agents` 的輸出與檔案位元組不變（golden test）。效能：CLI 完整安裝由 0.65–0.72 ms 增至 9–21 ms（Linux，約 30 次 fsync），選擇耐久性。實機待實機驗收。
- **關聯**：§3.2；DT-21；R15、R16、R17。

### ADR-15 Agent 固定 launcher 與版本化 runtime manifest

- **狀態**：暫定採用（1.6.43 實作 DT-23；1.6.45 加入 Windows ACL 檢查，僅以 fixture 驗證，真實 Windows 行為待 CI 或實機）
- **脈絡**：Agent 直接指向版本目錄會在更新後失效；shell 拼接字串有注入風險（R07、R13）。
- **決策**：Agent 的 `command` 指向使用者層固定 launcher。launcher 讀取原子提交的 manifest，以 argv array 啟動，只允許指定動作（`mcp`、`serve`、`codex-finalize-reminder`、`claude-finalize-reminder`）。檢查 manifest 與 binary 的所有權與權限：POSIX 拒絕 world-writable 與非目前使用者擁有的項目；Windows 的 ACL 於 1.6.45 起檢查（見下方實作狀態）。
- **1.6.43 的實作**：`bin/` 下的 shim 只讀取 `current` 與 `runtime-launch.txt` 後執行 launcher；所有驗證（manifest 嚴格解析、逐檔 SHA-256 與大小、未列出的檔案與 symlink、路徑、動作白名單、錯誤碼）都在共用的 TypeScript 中。manifest 為 v1，列出 runtime 目錄內的每一個檔案，未列出的檔案使 runtime 無效。
- **後果**：多一層 launcher 需要測試；換版透過 manifest 切換。
- **1.6.45 的實作**：Windows ACL 分兩層讀取，第一層為 .NET，失敗才用 `Get-Acl` 加 `whoami /user`；PowerShell 5.1 以絕對路徑與允許清單環境啟動，腳本關閉模組自動載入與進度輸出。第一層以結束碼 3 回報 Constrained Language Mode。逾時第一層 20 秒、第二層 60 秒，逾時重試一次。固定 SID 的 SDDL 別名展開為 SID 後再判斷，相對別名不受信任；擁有者限目前使用者、SYSTEM、Administrators 或 TrustedInstaller。兩層都失敗回報 `RUNTIME_ACL_UNREADABLE`，附各層結束碼、耗時與 stderr。`icacls` 未採用，因為 `icacls /save` 沒有擁有者資訊，而擁有者必須被驗證。真實 Windows 行為待 CI 或實機確認。
- **1.6.47 的實作（launcher 接線）**：打包後的 App 在 runtime 成為 current 後寫入 `desktop-integration.json` v1，內容未變則略過，不含資料庫路徑。plugin `launch.mjs`、MCPB 與獨立版在紀錄有效時優先使用 shim。`setup:agents` 的 launcher 目標：MCP 為 shim 加 `["mcp"]`，hook 為加引號的 shim 加 `claude-finalize-reminder` 或 `codex-finalize-reminder`；shim 路徑須為絕對路徑，檔名為 `work-intelligence-launcher`（Windows 為 `.cmd`），不得含 shell 特殊字元或控制字元。Windows 只接受磁碟機代號路徑（不接受 UNC 與 `\\?\`）。信任規則與威脅模型見 ADR-39。實機待實機驗收。
- **關聯**：§3.3、§10.2；DT-23；R07、R13。

### ADR-16 Runtime 延後清理：無現役連線且可安全刪除才 GC

- **狀態**：已採用（Windows 檔案鎖待實機驗證；DT-24 已實作）
- **脈絡**：Windows 會鎖住執行中的檔案（R08）；PID 可能被重用，不能以 PID 不存在作為可刪除的依據。
- **決策**：runtime 版本化；更新時先安裝新版、驗證完整性、再原子切換 manifest。舊 runtime 的清理需要「無現役連線」與「可安全刪除」兩項條件，失敗則延後重試。
- **1.6.43 的實作**：runtime 的檔案寫入 `runtimes/<id>/` 後不再修改（只有 `.verified.json` 快取例外）；切換只改 `current` 單行指標。清理（GC）尚未實作，舊版目錄會保留。
- **1.6.45 的實作**：背景的 best-effort 清理只保留目前與前一版。尚未證明「無現役連線」（PID 可能被重用，不能以 PID 不存在作為依據），因此 DT-24 只完成一部分；其餘舊版目錄仍會保留。
- **DT-24 的實作（無現役連線的證明）**：
  - launcher 的每個 action（含 hook，不含 `--print-runtime-info`）在驗證 runtime 之前，於 `<launcher root>/leases/<runtimeId>/` 以獨佔方式建立 `<隨機>.lease`（0600，內容只有 `action` 與 `createdAt`），程序結束時移除；`mcp` 與 `serve` 每 60 秒更新 mtime。建立或更新失敗（沙箱、唯讀 HOME）不影響也不拖慢 action：hook 保持靜默，其他 action 每個程序最多一行不含路徑的 stderr（只有錯誤碼）。
  - GC 一律保留 `current` 與前一版（前一版與退役時間記錄在 `leases/gc-state.json`，放在 leases 內使寫入不改變 launcher root 的變更時間，因此不會多花一次 Windows ACL 讀取）。其他 runtime 先記錄「首次被視為退役」的時間，滿 7 天才可能被清理：沒有 lease 的程序（建立 lease 失敗者）必然啟動於其 runtime 被退役兩次之前，7 天的下限把殘餘風險限縮在「在沙箱內跑超過 7 天、且來自兩個版本以前的程序」。
  - 證明：（a）該 runtime 所有 lease 的 mtime 都早於 2 倍心跳，並在 GC 自己的單調時鐘走過 2 倍心跳後仍未更新（不使用 PID）；（b）將目錄改名為 `.quarantine-<id>-<隨機>`，Windows 上被鎖住則延後；（c）改名後重新讀取 lease，若有新出現者就改名回來並延後，否則刪除。不存在的 runtime 的 lease 目錄與檔案另行清除，且不跟隨符號連結。
  - 改名移開的 `.quarantine-<id>-<隨機>` 目錄不再只憑名稱刪除。GC 從名稱取出 runtime id，套用同樣的證明：該 id 不是 `current` 或前一版；`leases/<id>` 沒有新的 lease，且在 2 倍心跳內沒有任何變化；刪除前再讀一次 `current`。若 lease 仍有效而原名稱空著，先把目錄改名回去；前一版與 `current` 的 id 不改名回去（安裝進行中會暫時移開同一個目錄），只保留。不是這個格式的名稱不屬於 GC，原樣保留。這裡不再套用 7 天下限：GC 自己移開的目錄，其 runtime 早已退役滿 7 天；安裝移開的目錄與安裝剛取代的是同一個 id，仍在使用它的程序由該 id 的 lease 涵蓋。
  - 找不到已知的保留清單時（`gc-state.json` 遺失、損壞或無法寫入，且呼叫者沒有指定前一版），本次不記錄任何退役時間，也沒有 runtime 成為可清理對象，因為此時看不出哪一個是前一版。安裝指定前一版，或有一份有效的記錄之後，才開始計算退役。1.6.54 第一次啟動且 runtime id 不變時，就是這種情況。
  - `current` 與前一版的 lease 若已證明失效（超過 2 倍心跳未更新，且在 GC 等待期間仍未更新），GC 會刪除這些 lease 檔；只處理一般的 `*.lease` 檔，用 `lstat` 檢查，不跟隨連結，也從不刪除保留中的 runtime 目錄。
  - `<launcher root>/leases`、`leases/<id>` 必須是真正的目錄（`lstat` 判斷，符號連結與 Windows junction 都不算）。建立 lease 前先檢查：`leases` 不存在時，在已驗證的 root 之下以非遞迴方式建立；不是真正的目錄時略過 lease，action 照常執行，沉默規則不變。GC 的每項 lease 操作也先檢查：`leases` 不是真正的目錄時，不讀、不寫、不清除，所有未保留的 runtime 都以 `live-lease` 延後。
  - 競態：每次改名前再讀一次 `current` 與保留清單，已成為 `current` 或保留者就延後；`refresh` 發現 lease 檔不存在（例如被孤兒清理刪除）時，以獨佔方式重建一次；Windows 與 macOS 比對 runtime id 時不分大小寫。有 quarantine 目錄的 runtime，其 lease 目錄不算孤兒。
  - 延後或失敗時，App 以 10 分鐘、30 分鐘、之後每小時在背景重試；安裝從不刪除也不等待鎖。
- **後果**：磁碟上會暫時保留多個 runtime 版本。
- **關聯**：§3.3、§10.2；DT-24；R08；G-MCP-01。

---

### ADR-39 desktop-integration 紀錄與 Agent launcher 選擇順序（同使用者威脅模型）

- **狀態**：暫定採用（1.6.47 實作，1.6.49 加入資料庫交接；Windows 與 macOS 實機待驗收）
- **脈絡**：Agent 設定指向固定 launcher（ADR-15），但 plugin、MCPB 與獨立版也可能指向 checkout 或內附的 server。App 需要讓這些入口優先使用已安裝的 runtime；Dashboard 交接（ADR-28）也需要知道 App 的位置。這份紀錄不應成為新的權限邊界。
- **決策**：打包後的 App 在 runtime 成為 current 後，寫入 `<config dir>/desktop-integration.json`（v1：version、launcherPath、runtimeRoot、appExecutable、appVersion、writtenAt），內容未變則略過；不含資料庫路徑與使用者資料。讀取端的選擇順序為：明確指定的 `WORK_INTELLIGENCE_HOME` checkout → 桌面 shim → plugin 位置或 link 的 checkout → 內附的 server。紀錄只有在通過以下檢查時才被採用：POSIX 上擁有者必須是目前 uid、不得 world-writable、不得含 symlink；Windows 上只接受磁碟機代號路徑（不接受 UNC 與 `\\?\`）；runtime 必須已就緒（current、runtime-launch.txt、可執行檔、launcher.mjs）才選擇 shim。紀錄無效或 runtime 未就緒時，退回下一個順序，並輸出一行 stderr。
- **1.6.49 的實作（launcher 交給 Agent 的資料庫）**：
  - App 在 launcher root 寫入 `desktop-settings-path`，內容只有 App 設定檔的絕對路徑，內容未變則略過。這是指標，不含資料庫路徑。
  - 沒有設定 `WORK_INTELLIGENCE_DB` 時，launcher 每次執行都讀這個指標與設定檔，把 `desired.databasePath` 交給 MCP 與兩個 hook。明確設定的 `WORK_INTELLIGENCE_DB` 一律優先。
  - 兩個檔案都必須是本人擁有、不可被他人寫入的一般檔案（不得是 symlink），大小有上限。路徑須為絕對路徑：Windows 只接受磁碟機代號路徑。App 設定檔與 launcher 共用同一條規則（`isSupportedDatabasePath`）：首次執行頁與設定 schema 拒絕 UNC（`\\server\share`）與 `\\?\`、`\\.\` 裝置路徑，因為 SQLite 走 SMB 不安全。
  - 明確設定 `WORK_INTELLIGENCE_HOME` 或 `WORK_INTELLIGENCE_CONFIG_DIR` 時，launcher 不交接 App 的資料庫，沿用獨立版規則。
  - 沒有指標或尚未設定（首次執行頁還沒完成）時，沿用獨立版的資料庫規則。
  - 指標已存在但設定無效（擁有者或權限錯誤、symlink、不是 JSON、路徑不支援等）時**不退回**獨立版：MCP 輸出一行 zh-TW stderr 並以 78 結束，不啟動；hook 保持靜默、exit 0，並略過工作，不會寫入另一個資料庫。
  - 測試涵蓋 MCP 與兩個 hook 解析到同一個資料庫，在 App 換資料庫後亦然（`tests/desktop-core/desktop-database.test.ts`）。
  - 每次 hook 的額外成本：Linux 上第一次讀取約 0.3–0.7 ms，中位數 0.44 ms，預算為 5 ms。Windows 與 macOS 的數字由 CI 的同一個測試量測並印出（`[hook cost]`）。
- **威脅模型**：同一使用者的程序本來就能改寫 Agent 設定與 runtime 目錄，因此這些檢查只防止誤指向與意外的權限錯誤，不宣稱防禦同使用者的惡意程式。跨使用者的情境由 OS 權限與 ACL 處理（ADR-15）。
- **後果**：多一層讀取與檢查，需要測試覆蓋（`tests/desktop-core/integration-record.test.ts`）。hook 經 shim 執行時靜默、25 秒後終止，且一律 exit 0，避免 hook 失敗阻擋 Agent。Windows 與 macOS 的實機行為待驗收。
- **關聯**：§3.3、§10.2；DT-23 後續、DT-27；R07、R13；ADR-15、ADR-16、ADR-28。

---

## 設定、退出與port

### ADR-26 退出語意與登入背景啟動預設

- **狀態**：已採用
- **1.6.44 狀態**：退出流程（確認、停止受管服務、有界等待進行中的操作、確認 port 釋放）與退出文字已實作；登入項預設關閉，開啟需 consent；背景啟動以 `--background` 或 macOS `wasOpenedAtLogin` 判定。實機行為待實機驗收。
- **1.6.45 的實作**：第二個實例以 `requestSingleInstanceLock` 的附加資料傳送 `{action:"quit"}`，經嚴格 zod schema 驗證後，執行中的實例做一般的非互動退出（停止後端、確認 port 釋放）。此指令供 NSIS 安裝與解除安裝程式使用，等待最多 40 s，之後以 `taskkill /T /F` 結束目前使用者的程序。
- **脈絡**：使用者關瀏覽器不應停服務；結束 App 後，Agent 自啟的 MCP 仍可用，但 App 的每日備份不會再執行（R24）。
- **決策**：關瀏覽器不停止 API 與每日備份。「結束 App」停止其管理的 API 與排程，等工作收尾後結束。介面明示「退出後不會每日備份」。新安裝的「登入時在背景執行」預設關閉；背景啟動失敗時只顯示單次通知或 tray 提示。
- **後果**：使用者若要退出後仍備份，須開啟登入項或使用其他獨立方式（V1 不隱式新增）。
- **關聯**：§1.1、§8.2；DT-15、DT-35；R18、R24。

### ADR-27 Port 策略：預設 3210，實際 bind 為準，跨 port 只搬白名單偏好

- **狀態**：已採用
- **1.6.51 狀態**：換 port 已實作於 App 內（修復視窗「連接埠」與工作列「變更連接埠…」）。實際 bind 或 IPC 與 HTTP 證明失敗時不寫入設定、回到舊 port；OS 不允許的 port 回報 `PORT_NOT_PERMITTED`，與占用分開。新位址以一次性 fragment 還原白名單偏好，不移轉 session 或 DB 路徑（`apps/desktop/src/main/change-port.ts`）。實機行為待驗收。
- **2026-11-18（1.6.54）**：閒置的匯入預覽（暫存檔，沒有任何操作正在讀取）不再阻擋換 port；匯入、備份、匯出與還原仍阻擋。換 port 成功且確實捨棄預覽時，連接埠區段才顯示提示。暫存檔於 App 重新啟動、Web 離開頁面與 `pagehide` 時移除；沒有人移除的暫存檔 30 分鐘後過期。
- **脈絡**：port 預檢無法代表實際 bind 結果；port 改變後 browser origin 也改變（R20）。
- **決策**：預設 `127.0.0.1:3210`，接管時記住既有 port。僅 loopback。實際 bind 失敗不得先建立空 DB。跨 port 只搬運白名單非秘密偏好，不移轉管理會話或 DB 路徑 token。
- **後果**：換 port 時使用者可能需要重新登入管理授權。
- **關聯**：§6、§6.2；DT-14；R19、R20。

### ADR-29 診斷匯出：手動、遮蔽、不預設上傳

- **狀態**：已採用（DT-19 已實作（CI 可驗證部分）；實機待驗收）
- **脈絡**：診斷可能含 Agent config、路徑、工作內容與授權碼（R32）。
- **決策**：只在使用者主動匯出時寫檔。匯出前 dry-run、遮蔽個資路徑與授權碼、掃描秘密。不預設上傳 GitHub Issue 或遠端 API。無預設遙測。
- **1.6.54 的實作**：
  - 「匯出診斷資訊」先建立預覽（`packages/desktop-core/src/shell/diagnostics*.ts`；`apps/desktop/src/renderer/repair/diagnostics-view.ts`）。預覽包含將寫入的確切文字，以及遮蔽摘要：依類別的數量，與因非 App 日誌而捨去的行數。摘要不顯示被遮蔽的值。
  - 「儲存檔案…」寫入預覽中的同一份文字（POSIX 上為 0600）。預覽 10 分鐘內有效，只能儲存一次，且只能從要求它的視窗儲存；否則 App 顯示新的預覽。
  - 第二道獨立掃描檢查已遮蔽的文字並遮蔽殘留內容；最後的檢查仍找到內容時，匯出被拒絕（`DIAGNOSTICS_SCAN_FAILED`）。
  - 輸出行只保留以 App 日誌前綴（例如 `[shell]`、`[desktop-child]`、`[work-intelligence]`）開頭的行。檔案上限 1 MiB；超過時先捨去最舊的輸出行，再捨去最舊的錯誤，並記錄捨去的數量。
  - 所有遮蔽模式以線性時間執行。舊的遮蔽程式有一個在特定輸入下可能耗時數分鐘的模式，已改寫。
  - 只有手動匯出會寫檔；不上傳，無遙測。Windows 與 macOS 實機待驗收。
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
- **1.6.45 狀態**：本版沒有自動更新（見 ADR-25），因此不存在安裝時機的問題；退出時不安裝、也不會靜默安裝。若日後加入自動更新，本條須重新評估。
- **脈絡**：electron-updater 文件指出 Windows 與 Linux 的退出時安裝可能與 OS session 結束競爭 `[U]`（R21）。
- **決策**：使用者明確按下安裝後，先排空後端再安裝。延後時，一般退出不得安裝。若無法證明沒有意外安裝，採用 manual 或 onNextLaunch 策略，並保留外部可啟動的修復安裝包。
- **後果**：更新需要使用者多一次操作。
- **關聯**：§7.1、§7（切換版本列）；DT-30；R21。

### ADR-25 更新工具版本鎖定；無法證明 metadata 驗證時改為手動下載

- **狀態**：待驗證（版本待鎖）；**1.6.45 採用手動下載路徑**：electron-builder 鎖定 26.18.1（v26 穩定線），不做自動更新，`publish` 為 null，未加入 electron-updater。
- **1.6.53 狀態**：手動下載路徑已確認。App 內的更新檢查只開啟發行頁面與安裝檔下載，不下載、不安裝（ADR-40）。
- **脈絡**：electron-builder v27 的 Security & Hardening 文件明示 v27 為 next `[U]`；v26 只靠 `sha512` 不能保護 manifest 本身（R11）。
- **決策**：A 階段鎖定精確的 electron、electron-builder、electron-updater 版本，並實測 metadata 簽章與篡改拒絕。若使用 v27 的能力，需以實測證明。若 v26 無法提出等價的來源驗證方案，V1 改為手動前往官方 Releases 下載經平台驗證的安裝包，不宣稱自動更新已完成。
- **後果**：V1 可能只有手動更新。
- **關聯**：§7.1；DT-28；R11。

### ADR-30 解除安裝與桌面整合移除只處理 App 擁有的項目

- **狀態**：已採用
- **脈絡**：NSIS 解除安裝器可能清掉未受管理的資料（R27）；macOS 拖入垃圾桶不會執行清理。
- **1.6.45 的實作**：NSIS 解除安裝只移除程式檔，設定、資料庫（`~/.work-intelligence`）與備份保留（`deleteAppDataOnUninstall` 為 false）。electron-builder 的解除安裝程式仍接受明確的 `--delete-app-data`，此參數只移除 userData，不動資料庫。安裝與解除安裝前以 `--quit` 退出執行中的 App。macOS 的移除入口未實作；實機待驗收。
- **決策**：移除只刪除 App 擁有的登入項、Agent 整合、hook 與啟動器（依安裝清單與指紋）。DB、備份與設定保留，並顯示實際位置。提供「移除桌面整合」入口，並在重裝後清理殘留。外部 plugin 與 MCPB 不擅自卸除。
- **後果**：移除流程需要辨識 App 擁有的項目，這依賴安裝清單的正確性。
- **關聯**：§8、§9.1、§9.2；DT-34；R27。

### ADR-31 Windows 資料夾選擇：以 IFileOpenDialog 取代 WinForms

- **狀態**：1.6.41 已實作（T1，commit 1257d3a）；Windows 11 實機驗收待實機驗收
- **脈絡**：現況為 `System.Windows.Forms.FolderBrowserDialog`，透過 `powershell.exe -NoProfile -STA` 執行 `[R]`。
- **決策**：改用 `IFileOpenDialog`（PowerShell `-STA` + `Add-Type` C# COM interop）；選項 `FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST`；DPI aware；TopMost owner。取消（HRESULT `0x800704C7`）→ exit `2`。COM 不可用時 fallback 到 `FolderBrowserDialog`（`EnableVisualStyles`）。輸出 UTF-8。
- **後果**：需要 Windows 11 實機驗收，對應 `docs/release-checklist.md` 的條目；CI 無法取代。
- **關聯**：§9.1；DT-26。

### ADR-40 手動更新檢查

- **狀態**：已採用（使用者決策，1.6.53）
- **脈絡**：ADR-25 的 V1 只能手動下載新版。使用者需要知道有沒有新版，但若 App 自行查詢，會在使用者沒有察覺時連線到外部服務，也會增加背景行為的風險。
- **決策**：
  - 只提供手動的「檢查更新」：修復視窗的「更新」卡片，以及工作列的「檢查更新…」（主程序在這次點擊時直接開始檢查，與按鈕共用同一次請求，再開啟卡片）。啟動、背景與閒置時都不查詢，也不設定計時器；沒有任何旗標等待頁面開啟後才送出請求。
  - **沒有設定開關**。使用者按下「檢查更新」即為同意連線到 GitHub。「預設關閉」的意思是：沒有任何東西會自動執行。
  - 請求只在主程序發出，請求內容只含固定的 API 路徑與標頭，不含版本、作業系統、機器識別碼或權杖，並移除瀏覽器核心自動加上的 `Accept-Language`；使用不帶憑證、不快取、不接受重新導向的記憶體內 session。
  - 下載的對象只能是安裝檔或發行頁面，由使用者的瀏覽器開啟。App 內不下載、不安裝（ADR-25）。
  - 下載網址由 tag 重新組成，只允許本儲存庫 github.com 的發行網址。畫面不顯示來自網路的網址，跨入主程序的只有固定的選項。
- **理由**：
  - 按鈕本身就是使用者明確的動作，不需要額外的設定頁面。
  - 沒有背景行為，離線與隱私的預期最簡單，也最容易測試（啟動與閒置時不得有請求，由 smoke 測試證明）。
  - 不做 App 內安裝，就不需要我們自己的 manifest 簽章（ADR-38）。
- **後果**：
  - 使用者需要主動檢查，App 不會提醒有新版。
  - 查詢受 GitHub 配額限制；配額用盡時顯示可再試的時間，不自動重試。
  - 新版仍需手動安裝，安裝檔未簽署時會出現 Gatekeeper 或 SmartScreen 提示。
  - 若日後加入 App 內下載或安裝，本條須重新評估，並以我們自己的 manifest 簽章驗證（ADR-24、ADR-38）。
- **關聯**：ADR-24、ADR-25、ADR-38；[1.6.53 更新說明](../releases/1.6.53.md)；[使用指南](../user-guide.md)「桌面 App 檢查更新」。

---

## 驗證與決策紀錄

### ADR-35 SQLite 量測與修補證據的使用限制

- **狀態**：已採用（使用限制）
- **脈絡**：本機 Node 22.23.4 的 `sqlite_version()` = 3.53.4 `[T]`；官方指出 WAL-reset 修補自 3.51.3 起 `[U]`。
- **決策**：量測只作為方向性證據，發行判定以 release 產物的 bundled 值為準（ADR-19）。WAL 壓力測試與 integrity 測試不能取代修補證據。
- **後果**：發行前仍需 release 產物的列印與保存。
- **關聯**：§7.3.1；DT-06、DT-07。

### ADR-37 安裝包壓縮：DMG 用 ULFO，NSIS 與 ZIP 用 normal

- **狀態**：已採用（1.6.45）
- **脈絡**：1.6.45 的 CI 對每個平台建置兩種壓縮並記錄大小與時間（MiB／建置秒數）。darwin-arm64：DMG UDZO 151.87／48.3、ULFO 148.93／9.0；ZIP normal 146.51／62.3、maximum 145.89／440.1。darwin-x64：DMG UDZO 159.97／38.8、ULFO 156.88／11.8；ZIP normal 154.63／118.3、maximum 154.00／634.8。win32-x64：NSIS normal 120.63／132.9、maximum 120.63／264.3。
- **決策**：DMG 預設 ULFO（lzfse），比 UDZO 小約 2% 且快 3–5 倍；lzfse 映像需 macOS 10.11 以上，而 Electron 45 本身需 macOS 12，沒有受支援的 Mac 受影響。NSIS 與 ZIP 維持 normal：maximum 大小相同或只小不到 0.5%，建置時間卻是 2–7 倍。預設值在 `apps/desktop/scripts/package-gates.mjs`。
- **後果**：比較功能保留，只在手動執行或呼叫端傳入 `compare-compression` 時建置，pull request 不再執行（原本讓每個 macOS job 多 8–10 分鐘）。Windows 打包時間主要在 NSIS normal 的約 133 秒，目前沒有不增加安裝包大小、且已量測證實的加速方式，因此維持。
- **關聯**：`.github/workflows/desktop-package.yml`；CHANGELOG 1.6.45。

### ADR-38 不使用付費簽章憑證：macOS ad-hoc、Windows 未簽章，以本機打包為主

- **狀態**：已採用（使用者決策，1.6.45）
- **脈絡**：正式簽章需要 Apple Developer ID（年費）與 Windows 程式碼簽章憑證，公證也需要 Developer ID。原本的 §9.4 階段 5、6 以「簽署的 N→N+1」與「簽章安裝包」為 gate，ADR-03 也以簽章產物為暫存條件。
- **決策**：
  - 不購買 Apple Developer ID 與 Windows 程式碼簽章憑證，長期維持 macOS ad-hoc 簽章（`afterPack` hook）、Windows 不簽章，也不做公證。
  - 主要取得方式是使用者在自己的電腦上以 `pnpm package:desktop` 打包（它會先執行 `pnpm build`）（見[桌面設計索引](README.md)「本機打包」）；CI 與 GitHub Release 的產物為輔。
  - 產物的完整性以 `SHA256SUMS.txt` 核對；之後若加入更新檢查，改以我們自己的 manifest 簽章驗證，不依賴平台的程式碼簽章。
- **後果**：
  - 下載的安裝包會出現 macOS Gatekeeper 與 Windows SmartScreen 提示，使用者需自行允許開啟；本機打包的產物通常沒有隔離屬性（macOS `com.apple.quarantine`）或 Mark of the Web，所以多半不會出現這些提示。
  - macOS 無法使用 Squirrel.Mac 自動更新（它要求 Developer ID 簽章），所以更新維持手動下載或本機重新打包（ADR-25）。
  - 打包流程中所有現有的 gate 與測試維持原有嚴格度：fuse 讀回、ad-hoc 簽章驗證（`codesign --verify --deep --strict`）、隨包 Node 簽章、雜湊與大小 gate。只有原本以付費簽章為前提的 gate 依下列方式重新定義。
  - §9.4 的 gate 重新定義：階段 5 的「簽署的 N→N+1」改為「以 SHA256SUMS 與我們自己的 manifest 簽章驗證的 N→N+1」（若之後做更新檢查）；階段 6 的「簽章安裝包」改為「ad-hoc（macOS）／未簽章（Windows）安裝包，並附 SHA256SUMS」。ADR-03 的暫存條件改為同樣的產物。
- **1.6.53 補充**：更新檢查（ADR-40）不在 App 內下載或安裝，因此目前不需要我們自己的 manifest 簽章；使用者以發行頁面上的 `SHA256SUMS.txt` 核對安裝檔。只有日後加入 App 內安裝時，才需要以我們自己的 manifest 簽章驗證。
- **關聯**：ADR-03、ADR-25；§9.4；`apps/desktop/scripts/after-pack.mjs`；`.github/workflows/release.yml`。
