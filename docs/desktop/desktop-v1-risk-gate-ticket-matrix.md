# Work Intelligence 桌面版 V1：風險・Gate・工程票對應表（R4）

**基準：** `d464ea5`（1.6.40）；目標 1.6.41。**修訂日期：** 2026-11-16。

本表對應 R3 的 R01–R34（P0 15、P1 17、P2 2）。每項風險必須對應到一張工程票，或明確標示「V1 不做／以發行聲明排除」並附理由。Gate 定義見 [R4 §9.5](desktop-v1-design-r4.md#95-發行阻斷的可觀察證據gate)。

**表內註記**：

- **1.6.41 已實作**：表示該票的一部分已由 1.6.41 的 T1–T4 實作並提交到分支（commit 見 §4）；實機驗收仍為待實機驗收。
- **Linux 或 Windows ARM 部分**：V1 不做，於發行聲明排除（見 §5）。

---

## 1. 風險完整表（R01–R34）

| ID | 級別 | 風險（摘要） | Gate | 工程票 | 處理方式（預防、偵測、復原）與 V1 排除 |
|---|---|---|---|---|---|
| R01 | P0 | 多 DB 或舊 config 衝突，預設連到空庫 | G-DB-01 | DT-01 | 唯讀候選來源、身份重驗、使用者手動選擇；禁止錯誤 fallback 建空庫 |
| R02 | P0 | server `listen` 前已觸發 DB migration | G-DB-01、G-SVC-01 | DT-02 | 在建構 `WorkIntelligenceStore` 之前做完全唯讀 preflight |
| R03 | P0 | 已開啟的舊 MCP 在 schema 升級後寫入 | G-DB-02 | DT-03、DT-04 | MCP 寫入閘已存在 `[R]`（`withCompatibleSchema`）；寫入交易閘（含 HTTP API）由 1.6.41 T2 補上（已實作，commit 3ff1e45）；長任務提交與程序組合實驗由 DT-04 完成 |
| R04 | P0 | 手動複製或錯誤備份漏掉 WAL 中已提交資料 | G-DB-03 | DT-05 | 重用 `VACUUM INTO` 與 staging；快照必須可讀回並通過 `integrity_check` |
| R05 | P0 | 接管時殺掉另一個 checkout 或使用者服務 | G-SVC-01 | DT-12、DT-13 | 服務身分、runner、port、DB 多證據；陌生程序不 kill；Windows 驗證 schtasks 子孫程序 |
| R06 | P0 | 接管時已 migration，卻自動恢復舊服務 | G-SVC-01、G-DB-02 | DT-09、DT-12、DT-32 | phase journal；migration 開始後禁止自動重啟舊服務 |
| R07 | P0 | 無系統 Node 的環境中 Agent MCP 失效 | G-MCP-01 | DT-23、DT-25 | 隨包標準 Node＋固定 launcher；App 退出後仍可獨立運作。**1.6.43 證據**：`scripts/desktop-runtime-spike/smoke.mjs` 在無 `node` 的 PATH、離線、只啟動固定 shim 的環境中，於 serve 停止後 MCP 仍完成 `initialize` 與 `tools/list`，hook 動作通過（Windows 與 macOS 45/45、Linux 46/46，run 43864453651）；見 §4c。**1.6.47 已實作（CI 可驗證部分）**：plugin `launch.mjs`、MCPB 與獨立版優先使用固定 shim，App 以 `desktop-integration.json` 記錄 launcher 路徑；hook 經 shim 靜默、25 秒上限、一律 exit 0。Agent 的 host handshake 與 Windows、macOS 實機待實機驗收；plugin manifest 仍以 `node launch.mjs` 啟動。 |
| R08 | P0 | 更新刪除使用中的 runtime（Windows 檔案鎖） | G-MCP-01 | DT-24 | 版本化 runtime、延後 GC（需無現役連線）、manifest 原子切換 **1.6.45 狀態**：背景清理只保留目前與前一版，尚未證明「無現役連線」，風險只部分緩解（見 DT-24）。 |
| R09 | P0 | 本機網站偽造管理 API 請求 | G-SEC-01 | DT-17 | 精確 Host:port、Origin、短期會話、CSRF、原生高風險確認；**1.6.41 T4 已實作（commit dadaae4）** |
| R10 | P0 | 同機程序偽造 Origin 或 Host 使用管理 API | G-SEC-01 | DT-17 | 不只依賴 CORS 或 Origin；能力憑證與私有 IPC（§5.2 威脅模型） |
| R11 | P0 | 更新 manifest 被替換，只有 hash 卻無來源可信性 | G-UPD-01 | DT-28 | 鎖定工具版本；metadata 簽章驗證；無法證明時禁用自動更新 **1.6.45 狀態**：選擇 electron-builder 26（v26）且本版不做自動更新（ADR-25），因此不信任 metadata 的自動更新路徑未被啟用；v26 的 metadata 簽章驗證未實作，DT-28 的篡改測試不適用。 |
| R12 | P0 | DB restore 覆寫活躍 DB 或遺失新 Session | G-DB-03 | DT-05 | 先停寫入端；保存當前快照；明示資料損失窗口 |
| R13 | P0 | 被竄改的 runtime、launcher 或設定路徑 | G-MCP-01、G-SEC-01 | DT-23 | 只信任已驗證的 manifest；ACL；checksum；絕對路徑。**1.6.43 證據**：smoke 的竄改情境（改一個位元組、manifest 損壞、多放檔案、遺失 `current`、不允許的動作）皆被拒並回對應錯誤碼，修復後可再執行；Windows ACL 已於 1.6.45 實作（僅 fixture 驗證，真實 Windows 行為待 CI 或實機，不算通過；見 DT-23） |
| R14 | P0 | 更新成功但新後端無法啟動，修復入口也壞 | G-UPD-01 | DT-16、DT-31 | App 獨立的修復安裝包；tray 與修復視窗；三階段分段提交 |
| R15 | P1 | Agent plugin 與手動註冊並存，造成重複的 tools 與 hooks | G-MCP-01 | DT-21 | 分來源偵測；plan 預覽；按所有權修復。**1.6.47 已實作（CI 可驗證部分）**：`packages/agent-setup` 的來源偵測（desktop-managed、manual、plugin、mcpb、unknown）與重複註冊標示；plan 拒絕再加入第二個註冊。實機待實機驗收（Claude Desktop 的 MCPB 偵測依檔案配置推測）。 |
| R16 | P1 | 使用者在 plan 之後改了 Agent 設定 | G-MCP-01 | DT-21 | apply 前逐項指紋重驗；不覆蓋外部異動。**1.6.47 已實作（CI 可驗證部分）**：apply 前、寫入前後與 rename 前逐項重驗，發現外部異動即停止；測試見 `tests/agent-setup/toctou.test.ts`。實機待實機驗收。 |
| R17 | P1 | 多檔案的 Agent 設定只套用了一部分 | G-MCP-01 | DT-21 | 操作日誌、補償回復、每項驗證；必要時人工衝突修復。**1.6.47 已實作（CI 可驗證部分）**：持久化操作日誌先於第一次寫入；補償只回復本次寫入且內容仍相同的項目，由新到舊；遇外部異動標記 `needs-manual-repair`。測試見 `tests/agent-setup/transaction.test.ts`。實機待實機驗收。 |
| R18 | P1 | Linux 無系統匣；Windows 登入任務無視窗 | G-UX-01 | DT-15、DT-16 | Windows 與 macOS：修復視窗與明確的 UX；**Linux 部分：V1 不做，於發行聲明排除（§5）** |
| R19 | P1 | port 競態與 health 誤辨身分 | G-SVC-02 | DT-10、DT-11、DT-27 | IPC runId＋DB 身分＋HTTP readiness 多層驗證；operationId 去重；Agent 開頁交給 App |
| R20 | P1 | 切換 port 後 browser 偏好或管理 token 遺失 | G-SEC-01 | DT-14 | 白名單搬運非秘密偏好；重新授權；不跨 origin 復用 |
| R21 | P1 | 作業系統結束階段的自動安裝被中斷 | G-UPD-01 | DT-30 | 使用者明確安裝、先排空後端；外部修復包；Windows 與 macOS 分別實測；**Linux 部分：V1 不做（§5）** |
| R22 | P1 | SQLite 放在 SMB、NFS 或同步資料夾 | G-DB-03 | DT-08 | 偵測疑似不支援環境；禁止自動 upgrade 與 restore；顯示理由 |
| R23 | P1 | 資料來源路徑被 symlink 替換（TOCTOU） | G-DB-01 | DT-01、DT-02 | 預覽與提交前重驗 realpath 與 OS 檔案身分 |
| R24 | P1 | App 停止後 MCP 仍寫入，使用者誤以為每日備份仍在運作 | G-UX-01 | DT-15、DT-35 | 退出提示與最後成功備份時間；登入項為使用者選擇 |
| R25 | P1 | Browser 或 local API 不隔離其他 OS 帳號 | G-SEC-01 | DT-18 | **管理 API：** DT-18 跨使用者測試。**資料 API：V1 不做，於發行聲明排除（ADR-33）** |
| R26 | P1 | macOS App 從 DMG 執行，無法安裝更新 | G-UPD-01 | DT-29 | 啟動時檢測 App 位置，導引移到 Applications |
| R27 | P1 | Windows NSIS 解除安裝器清掉未受管理的資料 | G-UX-01 | DT-34 | 只移除 App 擁有項；DB 與備份保留 **1.6.45 證據**：NSIS 解除安裝只移除程式檔，設定、DB 與備份保留（`deleteAppDataOnUninstall` 為 false）；Windows 打包煙霧測試的靜默解除安裝斷言資料保留（Linux 不執行此項）。實機待驗收。 |
| R28 | P1 | 陳舊的 Agent skill 或 MCP schema 被顯示為已就緒 | G-MCP-01 | DT-22 | 實際 host handshake；版本契約；需重新連線的狀態。**1.6.47 已實作（CI 可驗證部分）**：MCP stdio 握手探測、契約指紋比對（指紋不同顯示需要重新連線）、host 首次 `initialize` 的觀察紀錄（`agent-observations.json`，fail-open）；只有指紋相同的觀察才顯示已觀察到連線。實機 handshake（Claude Code、Codex、Claude Desktop）待實機驗收。 |
| R29 | P1 | 設定檔半寫入或無法解析時被當作全新安裝 | G-DB-01 | DT-20 | 原子替換、recovery copy、修復模式；不開空庫 |
| R30 | P1 | 關機、睡眠或斷電使 operation phase 與實際狀態不符 | G-SVC-02、G-UPD-01 | DT-09、DT-31 | 恢復時重讀 OS、DB 與 manifest 並重建狀態；不只依賴 journal |
| R31 | P2 | 安裝包肥大、冷啟慢、閒置記憶體高 | G-UX-01 | DT-25 | A 階段比較標準 Node 與 `utilityProcess`；記錄基準數字。**1.6.43 數字**：標準 Node 與 Electron RUN_AS_NODE 的量測見 ADR-04（Linux 與 macOS） 三平台；spike 未量測 `utilityProcess` **1.6.45 數字（本機 Linux）**：解開後 405.8 → 395.9 MiB；`app.asar` 3.3 → 0.66 MB；隨包 runtime 135.5 MB（Node 122 MB）；打包 11.8–15.2 s；首次啟動含 runtime 安裝 1028 ms、熱啟動 563 ms；閒置記憶體（打包後的 App，PSS）352 → 292 MiB，RSS 合計 662 → 538 MiB（3 次中位數）。Windows 與 macOS 的數字待 CI；記憶體門檻為 Linux PSS 360 MiB、後端 128 MiB，Windows 與 macOS 暫定 1024 MiB 與 192 MiB。 |
| R32 | P2 | 完整診斷匯出洩漏個資路徑或秘密 | G-SEC-01 | DT-19 | 匯出前預覽、掃描、遮蔽；只手動匯出，不自動上傳 |
| R33 | P0 | bundled Node 的 SQLite 未含 2026 WAL-reset 修補，可能損毀 | G-DB-03、G-MCP-01 | DT-06、DT-07 | release 產物列印 `sqlite_version()` 並保存修補證據（**1.6.41 T3 已實作（commit 4420951）**）；多程序 WAL 壓力與 restore 測試 |
| R34 | P1 | 唯讀 DB 預覽在 WAL 中建立 `-shm`、`-wal`，或誤用 `immutable=1` | G-DB-01 | DT-02 | 檔案系統副作用測試；不刪 sidecar；活躍 DB 不使用 immutable |

**級別統計**：P0 = R01–R14、R33（15 項）；P1 = R15–R30、R34（17 項）；P2 = R31、R32（2 項）。與 R3 相同。

---

## 2. Gate → 工程票（反向索引）

| Gate | 涵蓋風險 | 工程票 |
|---|---|---|
| G-DB-01 | R01、R02、R23、R29、R34 | DT-01、DT-02、DT-20 |
| G-DB-02 | R03、R06 | DT-03、DT-04、DT-32 |
| G-DB-03 | R04、R12、R22、R33 | DT-05、DT-06、DT-07、DT-08 |
| G-SVC-01 | R02、R05、R06 | DT-02、DT-09、DT-12、DT-13 |
| G-SVC-02 | R19、R30 | DT-09、DT-10、DT-11、DT-31 |
| G-MCP-01 | R07、R08、R13、R15、R16、R17、R28、R33 | DT-21、DT-22、DT-23、DT-24、DT-25 |
| G-SEC-01 | R09、R10、R13、R20、R25、R32 | DT-14、DT-17、DT-18、DT-19 |
| G-UPD-01 | R11、R14、R21、R26、R30 | DT-16、DT-28、DT-29、DT-30、DT-31、DT-33、DT-37 |
| G-UX-01 | R18、R24、R27、R31 | DT-15、DT-16、DT-25、DT-34、DT-35、DT-36 |

---

## 3. 工程票索引（DT-01 至 DT-37）

「R3 Epic」欄對應 R3 §13 的 E0-01 至 E5-02；無對應者標示 R4 新增。「平台」欄：W = Windows 11 x64，M = macOS。

| 票號 | 內容 | R3 Epic | 相依 | 完成證據（摘要） | 平台 | 對應風險 |
|---|---|---|---|---|---|---|
| DT-01 | DB 來源解析器與身分（唯讀候選、衝突策略） | E0-01 | — | 合成的舊 checkout、standalone、plugin 流程；多來源衝突測試。**1.6.42 已實作**：`packages/desktop-core/src/db-source/`、`packages/shared/src/file-identity.ts`；`tests/desktop-core/db-source.test.ts`、`tests/desktop-core/identity-compare.test.ts`、`tests/shared/file-identity.test.ts`；身分策略見 ADR-36；Windows 檔案 ID 待實機驗收 | W、M | R01、R23 |
| DT-02 | 唯讀 preflight 與提交前重驗（含 sidecar 副作用測試） | E0-01、E2-02 | DT-01 | 不開錯庫；sidecar 監測；TOCTOU 測試。**1.6.42 已實作**：`apps/server/src/database-preflight.ts`、`apps/server/src/start-api.ts`；`tests/server/database-preflight.test.ts`、`tests/server/start-api-injected.test.ts`；sidecar 本機觀察見 ADR-07（Windows 待實機驗收） | W、M | R02、R23、R34 |
| DT-03 | HTTP API 與 CLI 寫入端 schema 閘（`server_restart_required`，HTTP 503；快取戳記 `data_version` 與 `schema_version`） | E0-02 | — | 舊程序寫入被拒；快取不每請求重查 | W、M | R03 |
| DT-04 | 舊 MCP 與長任務屏障實驗；確定方案 1、2、3 | E0-02、E4-02 | DT-03 | §10.4 的四組程序組合實驗結果。**1.6.42 已實作**：`tests/server/old-writer-barrier.test.ts`（+ `tests/helpers/old-writer-barrier*.ts`）；組合 1 至 3 的結果見 §10.4；組合 4（Codex plugin、Claude Code plugin、MCPB、手動 stdio）與 Windows 檔案鎖／WAL 待實機驗收 | W、M | R03 |
| DT-05 | 備份快照驗證與 restore 守門（可讀回、保存當前快照） | E4-02 | DT-03 | 還原樣本通過 `integrity_check`；活躍 DB 不被覆寫 | W、M | R04、R12 |
| DT-06 | SQLite 版本檢查（`doctor`、`pnpm check`、`/api/health` 警告；release 列印）**1.6.41 T3** | E1-01 | — | CI 檢查通過；release 產物輸出 bundled `sqlite_version()` | W、M | R33 |
| DT-07 | 多程序 WAL 寫入與 checkpoint 壓力、`integrity_check` 測試套件 | E5-01 | DT-05 | 壓力測試輸出與還原比對；不取代 DT-06 的修補證據 | W、M | R33 |
| DT-08 | 檔案系統風險政策（SMB、NFS、同步資料夾、外接碟） | E0-01 | DT-01 | 偵測與禁止自動接管的測試；顯示理由。**1.6.51 已實作**：啟動與選擇資料庫時分類 none、網路、可移除、雲端同步、硬連結與 unknown；網路磁碟拒絕作為 App 資料庫（`DB_STORAGE_NETWORK`）；可移除、雲端同步與硬連結只能勾選同意後選擇且不做 schema 更新；「複製到本機磁碟並改用」以 `VACUUM INTO` 與 `quick_check` 完成，原檔不變；`apps/desktop/src/main/storage-risk.ts`；`packages/desktop-core/src/db-source/storage-policy.ts`；`tests/desktop-core/storage-risk.test.ts`；真實磁碟與雲端根目錄判定待實機驗收；已知未偵測 macOS 的 iCloud「桌面與文件」 | W、M | R22 |
| DT-09 | ServiceOwner 狀態機與 operation journal（R4 §4.1） | E0-03 | DT-01 | 狀態轉移測試；中斷後依 OS／DB 重建。**1.6.42 已實作**：`packages/desktop-core/src/operations/`（狀態表、journal、recovery）；`tests/desktop-core/operations-state.test.ts`、`tests/desktop-core/operations-journal.test.ts`、`tests/desktop-core/operations-recovery.test.ts` | W、M | R06、R30 |
| DT-10 | `OperationCoordinator`（單一鎖、operationId、BUSY、重送） | E0-03 | DT-09 | 重送回傳同一結果；併發操作回 BUSY。**1.6.42 已實作**：`packages/desktop-core/src/operations/coordinator.ts`；`tests/desktop-core/operations-coordinator.test.ts`；跨程序鎖屬 DT-15 | W、M | R19 |
| DT-11 | 子程序 lifecycle（argv、env allowlist、runId IPC、drain） | E2-02 | DT-09、DT-02 | 不開錯 DB；不雙啟；關閉可驗證。**1.6.44 已實作**：`packages/desktop-core/src/backend/`；`apps/server/src/desktop-child.ts`；`packages/shared/src/instance-proof.ts`；`tests/desktop-core/backend-supervisor.test.ts`、`backend-environment.test.ts`、`backend-managed-service.test.ts`；`tests/server/desktop-child.test.ts`、`desktop-child-process.test.ts`；實機待實機驗收 | W、M | R19 |
| DT-12 | 服務擁有權證據與陌生程序保護（macOS LaunchAgent） | E4-01 | DT-09 | 不殺未授權程序；歸屬證據層級測試 | M | R05、R06 |
| DT-13 | Windows schtasks adapter 與 runner 子孫程序驗證 | E4-01 | DT-12 | 停止排程後 port 釋放；子孫程序已終止。**1.6.50 已實作（停用舊的登入服務）**：只結束命令列含該 checkout runner 的 `node.exe` 程序樹，依父程序編號等待每個子孫程序結束與 port 釋放後才刪除排程；`packages/desktop-core/src/legacy-service/disable.ts`；`tests/desktop-core/legacy-service-disable.test.ts`；真實 Windows 程序樹待實機驗收 | W | R05 |
| DT-14 | 連接埠變更與跨 port 偏好白名單 | E2-02 | DT-11 | 換 port 後管理授權重建；偏好正確搬運。**1.6.51 已實作**：只在 App 內變更（修復視窗「連接埠」與工作列「變更連接埠…」）；Web 只請 App 開啟該區段；白名單偏好與路由以一次性 fragment 還原；占用與 `PORT_NOT_PERMITTED` 在停止服務前拒絕；通過 IPC 與 HTTP 證明驗證後才原子寫入設定，失敗回舊 port；`apps/desktop/src/main/change-port.ts`；`packages/desktop-core/src/shell/port-policy.ts`；`tests/desktop-core/change-port-controller.test.ts`；`apps/desktop/tests/desktop-smoke/change-port.spec.ts`；真實 bind 與 Dashboard 新位址待實機驗收 | W、M | R20 |
| DT-15 | 單例、tray／選單列、登入項、靜默背景（無重複彈窗） | E2-01 | DT-10、DT-25 | 重複點擊只開一個實例；背景啟動不跳錯誤窗。**1.6.44 已實作**：`apps/desktop/src/main/index.ts`、`second-instance.ts`、`tray.ts`、`settings.ts`；`packages/desktop-core/src/shell/launch-mode.ts`、`login-item.ts`、`tray-menu.ts`；`tests/desktop-core/shell-basics.test.ts`；`apps/desktop/tests/desktop-smoke/desktop.spec.ts`；實機待實機驗收 | W、M | R18、R24 |
| DT-16 | 修復視窗（隔離、sandbox、不依賴 Web 或 API） | E2-01 | DT-15 | 無 tray 或服務壞掉時仍可修復。**1.6.44 已實作**：`apps/desktop/src/main/repair-window.ts`、`security.ts`、`ipc.ts`；`apps/desktop/src/preload/repair.ts`；`apps/desktop/src/renderer/repair/`；`packages/desktop-core/src/shell/navigation-policy.ts`、`repair-ipc.ts`；`tests/desktop-core/shell-policy.test.ts`；`apps/desktop/tests/desktop-smoke/desktop.spec.ts`；實機待實機驗收 | W、M | R14、R18 |
| DT-17 | 管理 API 授權：精確 Host:port（**1.6.41 T4 已實作**）、Origin、CSRF、會話、原生確認 | E2-03 | DT-15 | 假 Host、假 Origin、跨 port、重播、過期的測試皆拒絕 | W、M | R09、R10 |
| DT-18 | 管理 API 跨使用者與 XSS 回歸測試；資料 API 的發行聲明 | E2-03 | DT-17 | 不同 OS 帳號連線測試；發行說明已列出排除項 | W、M | R25（管理 API 部分） |
| DT-19 | 診斷匯出遮蔽與秘密掃描 | E5-02 | DT-11 | 匯出內容無授權碼與個資路徑；不自動上傳。**1.6.44 註記**：本版的診斷匯出已遮蔽 home、使用者名稱、DB／備份路徑、runId 與秘密樣式（`packages/desktop-core/src/shell/diagnostics.ts`；`tests/desktop-core/shell-policy.test.ts`）；完整版（dry-run 預覽、秘密掃描報告）仍屬 DT-19 | W、M | R32 |
| DT-20 | 設定檔原子寫入與 fail-closed 讀取 | E0-02 | — | 半寫入與毀損情境不開空庫；recovery copy 可用。**1.6.42 已實作**：`packages/desktop-core/src/settings/`；`tests/desktop-core/settings.test.ts` | W、M | R29 |
| DT-21 | Agent plan／apply／verify／compensate 共用 API（擷取自 `agent-setup.ts`） | E3-01 | DT-23 | 指紋重驗；補償只回復 App 擁有項；CLI 行為不變。**1.6.47 已實作（CI 可驗證部分）**：`packages/agent-setup/`；`apps/server/src/agent-setup.ts`（薄 CLI）；`tests/agent-setup/*.test.ts`、`tests/server/agent-setup-golden.test.ts`（CLI 輸出與檔案位元組不變）；App 設定中心尚未呼叫；實機待實機驗收。 | W、M | R15、R16、R17 |
| DT-22 | Agent 狀態分級與 host handshake | E3-01 | DT-21 | 檔案已寫入不顯示「已連接」；握手測試通過。**1.6.47 已實作（CI 可驗證部分）**：`packages/desktop-core/src/agents/`；`packages/shared/src/mcp-contract-fingerprint.ts`；`apps/mcp/src/agent-observation.ts`；`tests/desktop-core/agents-handshake.test.ts`、`agents-status.test.ts`；真實 host 握手待實機驗收。 | W、M | R28 |
| DT-23 | 固定 launcher 與版本化 runtime manifest | E1-02 | DT-25 | App 退出後 MCP 仍可 `initialize`；manifest 篡改被拒。**1.6.43 已實作（CI 可驗證部分）**：`packages/desktop-core/src/runtime/*.ts`；`tests/desktop-core/runtime-install.test.ts`、`runtime-launcher.test.ts`、`runtime-manifest.test.ts`、`runtime-verify.test.ts`；煙霧測試覆蓋竄改拒絕；**1.6.45**：Windows ACL 已實作（`packages/desktop-core/src/runtime/windows-acl.ts`；`tests/desktop-core/runtime-windows-acl.test.ts`，僅 fixture 驗證）；runtime GC 只部分實作（DT-24）；**1.6.47 已實作 launcher 接線（CI 可驗證部分）**：plugin `launch.mjs`、MCPB 與獨立版優先使用固定 shim；`desktop-integration.json` 紀錄（`packages/desktop-core/src/integration/`；`tests/desktop-core/integration-record.test.ts`）；`setup:agents` launcher 目標；plugin manifest 仍以 `node launch.mjs` 啟動；實機待實機驗收 | W、M | R07、R13 |
| DT-24 | runtime 延後 GC 與 Windows 檔案鎖 | E1-02 | DT-23 | 檔案鎖下更新不失敗；無現役連線才刪除 | W | R08 **1.6.45 部分實作**：`packages/desktop-core/src/runtime/runtime-gc.ts`，背景清理保留目前與前一版；無現役連線的證明未做，DT-24 未完成。 |
| DT-25 | 無 Node 封裝 spike、大小與冷啟動基準、FTS5 與 worker 驗證 | E1-01 | — | 無 Node 離線開頁、寫 DB、搜尋、備份、stdio 握手；基準數字紀錄。**1.6.43 已實作（CI 可驗證部分）**：`scripts/desktop-runtime-spike/`（build、smoke、harness、report）、`.github/workflows/desktop-runtime-spike.yml`；三平台數字與檢查見 ADR-04；階段 1 gate 未通過（實機驗收未做） | W、M | R07、R31 |
| DT-26 | Windows 資料夾選擇：`IFileOpenDialog`（**1.6.41 T1 已實作，commit 1257d3a**；實機待實機驗收） | R4 新增 | — | Windows 11 實機通過 `docs/release-checklist.md` 的條目；取消 exit 2；fallback 可用 | W（M 驗證 `osascript`） | — |
| DT-27 | Dashboard bridge：Agent 開頁交給 App，不自啟 checkout server | E3-02 | DT-11、DT-21 | 換 port 與 App 離線後從 Agent 開頁，不產生第二個 server。**1.6.47 已實作（CI 可驗證部分）**：`scripts/dashboard.mjs`、`plugins/work-intelligence/scripts/desktop-integration.mjs`、`apps/desktop/src/main/second-instance.ts`；`apps/desktop/tests/desktop-smoke/dashboard-handoff.spec.ts`；換 port 與 App 離線的實機情境待實機驗收。 | W、M | R19（次要） |
| DT-28 | 更新來源鎖版本與 metadata 驗證（v26 或 v27 決策） | E5-01 | DT-37 | 篡改、漏簽、錯 key、key rotation 測試；無法證明時改手動下載 | W、M | R11 **1.6.45 決策**：選 v26，本版不做自動更新（`publish` 為 null）；改為手動下載經平台驗證的安裝包（ADR-25）。篡改、漏簽、錯 key 測試不適用於本版，待日後決定是否導入。 |
| DT-29 | macOS 安裝位置檢測與 DMG 導引 | E5-01 | DT-28 | 從 DMG 啟動時顯示導引；移到 Applications 後可更新 | M | R26 |
| DT-30 | 更新安裝時機：使用者明確安裝、先排空，不在退出時靜默安裝 | E5-01 | DT-28 | `autoInstallEvent` 行為實測；退出時無意外安裝 | W、M | R21 |
| DT-31 | 三階段更新成功模型與獨立修復安裝包 | E5-02 | DT-30、DT-32 | 三段結果各自可見；新版開不起來時修復安裝包可用 | W、M | R14、R30 |
| DT-32 | migration 前備份與 N→N+1 樣本升級測試（含中斷與還原） | E4-02 | DT-04、DT-05 | 舊版建立的樣本升級、中斷、還原皆通過 | W、M | R06 |
| DT-33 | 同批產物暫存與聯合發行閘（ADR-03） | E5-01 | DT-28、DT-31 | 兩平台產物齊備且驗證後才一次公開；任一平台失敗即整版不發 | W、M | — **1.6.45 已接線**：`.github/workflows/desktop-package.yml` 於 `release.yml` 中被呼叫，發行 job 需等待其成功；三平台實跑結果待確認。 |
| DT-34 | NSIS 解除安裝只移除 App 擁有項；macOS 桌面整合移除入口 | E5-02 | DT-15、DT-24 | 解除安裝後 DB 與備份保留；使用者修改項目保留 | W、M | R27 **1.6.45 已實作（NSIS 部分）**：`apps/desktop/electron-builder.config.mjs` 的 NSIS 設定與 `--quit` 退出；保留設定、DB 與備份；Windows 打包煙霧測試斷言資料保留（Linux 不執行此項）。實機待驗收；macOS 移除入口未做。 |
| DT-35 | 退出語意 UI 與最後成功備份時間顯示 | E2-01 | DT-15、DT-11 | 退出後介面明示「不會每日備份」；時間正確。**1.6.44 已實作**：`apps/desktop/src/main/quit.ts`；`packages/desktop-core/src/shell/quit-flow.ts`、`quit-notice.ts`、`last-backup.ts`、`i18n.ts`；`tests/desktop-core/shell-basics.test.ts`、`shell-flows.test.ts`、`shell-policy.test.ts`；`apps/desktop/tests/desktop-smoke/desktop.spec.ts`；實機待實機驗收 | W、M | R24 |
| DT-36 | CI 隔離（fake home、假 Agent、不觸碰真實 `$HOME` 與 3210）與 Windows 11、macOS 實機環境 | E0-03、CI | — | CI 不讀寫真實使用者資料；實機環境清單就緒。**1.6.42 已實作**：`tests/helpers/isolated-environment.ts`、`tests/shared/test-isolation.test.ts`、`vitest.config.ts`；Windows 11 與 macOS 實機環境清單尚未完成，仍待實機驗收 | W、M | — |
| DT-37 | 首發平台的發行身分與簽章（Windows 簽章、macOS 公證） | R4 新增 | — | 簽章身分與憑證就緒；產物可驗證 | W、M | — |

---

## 4. 1.6.41 任務（T1–T4）對應

以下為 1.6.41 中已提交到分支的實作。實機驗收仍為**待實機驗收**，本文不宣稱實機已通過。

| 1.6.41 任務 | 內容 | 對應票 | 對應風險 | R4 中的位置 | 狀態（commit） |
|---|---|---|---|---|---|
| T1 | Windows 資料夾選擇改為 `IFileOpenDialog`（PowerShell `-STA`、C# COM interop、取消 exit 2、WinForms fallback） | DT-26 | —（Windows 實機驗收必要） | R4 §9.1；C-17；ADR-31 | 已實作（1257d3a）；Windows 11 實機待實機驗收 |
| T2 | 寫入交易的 schema 閘（經 `Store`，含 HTTP API）；錯誤碼 `server_restart_required`（HTTP 503）；`data_version` 與 `schema_version` 快取戳記 | DT-03 | R03 | R4 §7.3；C-07；ADR-18 | 已實作（3ff1e45）；多程序組合實驗待 DT-04 |
| T3 | `sqlite_version()` 報告（doctor、系統狀態）與 WAL-reset 修補判定；CI、release、standalone smoke 檢查 | DT-06 | R33 | R4 §7.3.1；C-21；ADR-19 | 已實作（4420951）；發行產物的實際版本待取得 |
| T4 | 管理 API 的 Host 比對含 port：loopback 名稱 × 實際 listen port，加上 allowed origin 的精確 host:port | DT-17（測試於 DT-18） | R09、R10 | R4 §5.2；C-10；ADR-11 | 已實作（dadaae4） |

**差異註記**：T1–T4 的完成狀態以上列 commit 為準。若後續 PR 改變 `server_restart_required` 名稱、快取策略或 Host 規則，R4 §5.2、§7.3、§7.3.1、§9.1，ADR-11、ADR-18、ADR-19、ADR-31，C-07、C-10、C-17、C-21 須同步更新。

## 4b. 1.6.42（階段 0）對應

階段 0 的 CI 可驗證部分於 1.6.42 實作。下列 commit 為已提交的主要變更與審查後的修正。所有實機驗收仍為**待實機驗收**。

| 項目 | 內容 | 對應票 | 對應風險 | R4 中的位置 | 狀態（commit） |
|---|---|---|---|---|---|
| A | DB 來源解析與身分比對（唯讀候選、依檔案身分分組、血統衝突） | DT-01 | R01、R23 | §3.1；C-05；ADR-06、ADR-36 | 1.6.42 已實作（7b6b8f0；身分比對 `identity-compare.ts` 與 resolve 調整 e4a04a3）；實機待實機驗收 |
| B | 唯讀 preflight、提交前重驗與已驗證的 `startApi` 入口 | DT-02 | R02、R23、R34 | §3.1.1、§5.1；C-06；ADR-07、ADR-08 | 1.6.42 已實作（93a8f24；提交前重驗與不建庫開啟 6869348）；實機待實機驗收 |
| C | 舊寫入端程序組合實驗（組合 1 至 3） | DT-04 | R03 | §10.4；ADR-17 | 1.6.42 已實作（5bdd530）；組合 4 與 Windows 實機待實機驗收 |
| D | ServiceOwner 狀態機與 operation journal | DT-09 | R06、R30 | §4.1；C-04；ADR-21、ADR-22 | 1.6.42 已實作（54f9d3d）；實機待實機驗收 |
| E | `OperationCoordinator`（單一鎖、operationId、BUSY、重送） | DT-10 | R19 | §6.1；C-04；ADR-21 | 1.6.42 已實作（54f9d3d）；實機待實機驗收 |
| F | 設定檔原子寫入與 fail-closed 讀取 | DT-20 | R29 | §5.3；C-03；ADR-20 | 1.6.42 已實作（7b6b8f0）；實機待實機驗收 |
| G | 測試隔離（所有 Vitest 設定載入 `isolated-environment.ts`） | DT-36 | —（CI 基座） | R4 §13；C-T | 1.6.42 已實作（309e936）；實機環境清單待實機驗收 |
| H | 備份與匯出 worker 精簡入口（1.6.41 遺留的效能項） | 非 DT 票 | —（非桌面風險項） | 不屬於本設計文件 | 1.6.42 已實作（9bdec30）；數字為單機量測 |

**差異註記**：ADR-36 的 DB 身分策略與 §3.1 步驟 3、§10.1 的 `databaseIdentity` 已改為引用 ADR-36；§10.4 新增 DT-04 的實驗結果。

## 4c. 1.6.43（階段 1）對應

階段 1 的 CI 可驗證部分於 1.6.43 實作。Windows 的量測與所有實機驗收仍為**待實機驗收**。

| 階段 1 項目 | 工程票 | 風險 | 文件位置 | 狀態 |
|---|---|---|---|---|
| A | 無 Node 封裝 spike：建置、離線煙霧測試，以及大小、冷啟動與閒置記憶體量測（官方 Node.js 與 Electron RUN_AS_NODE） | DT-25 | R07、R31；§9.4；ADR-04 | 1.6.43 已實作（d879dc4）；三平台量測完成（run 43864453651） |
| B | 固定 launcher、manifest v1、shim、`current` 指標與 `runtimes/<id>/` 安裝、launch 一致性檢查 | DT-23 | R07、R13；§3.3、§10.2；ADR-15 | 1.6.43 已實作（e571b31；修正 7c75778、6419aaf；精簡 shim 與 launch 一致性檢查 1b09081）；Windows ACL 為 `not-implemented`；實機待實機驗收 |
| C | CI workflow（Windows、macOS、Ubuntu × Node、Electron） | DT-25 | R07、R31 | 1.6.43 已實作（d879dc4；觸發條件為 pull request 與手動觸發；分支 push 觸發於 e987168 加入，1b09081 移除） |
| D | runtime 延後 GC（DT-24）、Windows ACL、Agent 與 plugin 接線 | DT-24、DT-23 後續 | R08、R13、R07；§9.4 階段 3 | 1.6.47 已實作（CI 可驗證部分）；實機待實機驗收（Agent 與 plugin 接線）。runtime GC 仍為部分實作（DT-24，見 1.6.45） |

**1.6.43 的非 CI 項目**：Windows 11 與 macOS 實機煙霧測試、Windows ACL 檢查、NTFS 變更時間對 stat 快取的影響、Windows `.cmd` 的 `%*`／`!` 行為，以及所有實機驗收。

## 4d. 1.6.45（階段 5 打包部分）對應

階段 5 的打包部分於 1.6.45 實作。R4 §9.4 表中階段 5 的「自動更新與 schema」未做；Windows 與 macOS 的實機驗收仍為**待實機驗收**。

| 階段 5 項目 | 工程票 | 風險 | 文件位置 | 狀態 |
|---|---|---|---|---|
| 打包：electron-builder 26.18.1、NSIS（Windows 11 x64）、DMG 與 ZIP（macOS arm64、x64 分開） | DT-34、DT-33 | R27、R31 | §9.1、§9.2；ADR-02、ADR-30 | 1.6.45 已實作（Linux `dir` 本機驗證）；Windows 與 macOS 實跑待確認 |
| 隨包 runtime（Node 24.22.3）與首次啟動安裝到 launcher root | DT-23 | R07、R13 | §3.3；ADR-04、ADR-15 | 1.6.45 已實作；實機待驗收 |
| Windows ACL 檢查 | DT-23 | R13 | §3.3；ADR-15 | 1.6.45 已實作（fixture）；真實行為待驗收 |
| runtime 背景清理 | DT-24 | R08 | ADR-16 | 部分實作（保留目前與前一版） |
| 更新來源 metadata 驗證與自動更新 | DT-28、DT-30 | R11、R21 | §7.1；ADR-24、ADR-25 | 未做（v26，手動下載） |
| 發行聯合閘（`desktop-package` 與 `release.yml`） | DT-33 | — | ADR-03；§9.5 | 1.6.45 已接線；三平台實跑待確認 |
| 打包後的黑箱煙霧測試與生產建置的後門檢查 | DT-34、DT-36 | R13、R27 | apps/desktop/tests/packaged-smoke | 1.6.45 已實作；Linux 15 項通過 ×2 |

**1.6.45 的非 CI 項目**：Windows 11 與 macOS 的安裝、解除安裝與資料保留、Gatekeeper 與 SmartScreen 提示、Windows ACL 的真實行為、打包與啟動效能的 Windows 與 macOS 數字，以及 Developer ID 簽章與公證（未做；macOS 只有 ad-hoc 簽章）。

## 5. V1 不做／以發行聲明排除

以下項目已標示為 V1 不做。發行說明與使用者介面須清楚說明，不得暗示已支援。

| 項目 | 涉及風險 | 排除理由 | 發行說明的要求 |
|---|---|---|---|
| Linux 桌面（AppImage、系統匣、登入項、桌面圖示） | R18、R21（Linux 部分） | 產品決定 Linux 分開、後續發行（ADR-02）；Linux 的 tray 與 session 行為需獨立驗收 | 不列為支援平台；CLI、standalone、plugin 照常使用 |
| Windows ARM（推論，待確認） | 無獨立風險；屬平台範圍 | 首發只列 Windows 11 x64（ADR-02）；ARM 的安裝與執行需另驗證 | 不列為支援架構 |
| 資料 API（非管理 API）的跨 OS 使用者隔離 | R25（資料 API 部分） | 既有 CLI、checkout、第三方腳本依賴目前的資料 API 契約；加認證會破壞相容性（ADR-33） | 說明 loopback 不是 per-user 權限邊界；多使用者機器的風險須由使用者評估 |
| macOS Intel（候選，待確認；若 A 階段無法同批驗收） | 無獨立風險；屬平台範圍 | 依 ADR-02 的變更程序排除，而非在發行後單獨補上 | 若排除，明確列出支援的架構 |
| 自動更新、Developer ID 簽章與公證（1.6.45 不做；macOS 只有 ad-hoc 簽章） | R11、R14、R21、R26（部分）；DT-28、DT-37 | electron-builder 26 不驗證 v27 的簽名 manifest（ADR-25）；Developer ID 與公證身分未就緒（DT-37） | 不宣稱自動更新；Windows 顯示 SmartScreen 警告，macOS 顯示 Gatekeeper 警告；請核對 `SHA256SUMS.txt` 並從官方 Releases 下載 |
| 多資料庫切換、遠端管理、內嵌 Dashboard 視窗 | 無獨立風險；屬範圍 | 非 V1 目標（R4 §14.2） | 不宣稱支援 |

---

## 6. 使用說明

- 新增或調整工程票時，須同步更新 §1（風險表）、§2（Gate 索引）與 §3（票索引），並檢查每項風險仍至少有一張票或一項排除理由。
- 風險表中的 Gate 名稱與 [R4 §9.5](desktop-v1-design-r4.md#95-發行阻斷的可觀察證據gate) 一致；新增 Gate 時兩處一併修改。
- 本表不代表任何票已完成；完成狀態以各票的完成證據（§3）與 CI、實機紀錄為準。
