# Work Intelligence 桌面版 V1：跨版本獨立審查（v1.6.47 至 v1.6.55）

- **審查範圍**：git tag `v1.6.46..v1.6.55`（14 個 commit，507 個檔案）。審查對象為 `v1.6.55`（`fb1a6107`，等於審查當時的 `main`）。
- **審查日期**：2026-11-18。
- **性質**：只讀審查。本 PR 只新增這份文件，沒有修改產品程式碼、測試、CI 或版本號。
- **判斷依據**：程式碼、測試、CI 設定與文件。release note 與設計文件的說法只當作「宣稱」，逐項對照程式碼。

## 0. 結論

1. **沒有發現會直接毀損資料庫的缺陷。** 設定只在驗證成功後一次原子寫入，這個設計擋住了大部分中斷情境。
2. **高嚴重度 2 項、中 18 項、低 29 項。** 兩項高嚴重度問題是：
   - **H-01**：operation journal 的當機復原（`recover()`）只有測試在呼叫，主程序沒有接線。DT-09、ADR-21、ADR-22、C-04 的「中斷後依真實狀態重建」在產品中不存在。
   - **H-02**：App 內沒有「從備份還原」的功能，但錯誤提示要使用者「從備份還原」。唯一的還原入口是命令列，違反「桌面 App 不得要求指令」。
3. **所有實機驗收都還沒做。** 9 個 Gate（R4 §9.5）沒有任何一個有實機證據，§14.3 封版檢核 14 項全部未勾。CI 通過不等於 Gate 通過（R4 §9.4 自己的規定）。
4. **設計文件沒有跟上程式碼。** R4、契約與矩陣的標頭與狀態段仍停在 1.6.40 至 1.6.47，且與 ADR-38、ADR-40 矛盾。兩份 README 完全沒有提到桌面 App。詳見 §5。
5. **1.6.55 的「單一分頁視窗」沒有內嵌 Dashboard。** 分頁是原修復視窗內的頁籤；Dashboard 仍由 `shell.openExternal` 在系統瀏覽器開啟（`apps/desktop/src/main/dashboard.ts:41-52`）。因此 ADR-01 與「內嵌 Dashboard 視窗非 V1」仍然成立。

### 0.1 查證方式與限制

- 五個方向平行閱讀：安全性、操作協調、runtime 與 CI、Agent 整合與 server/storage、文件一致性。高嚴重度與下表標「已複核」的項目，我另外開檔逐行確認過。
- 標「未複核」的項目來自平行閱讀的回報，我沒有逐行重開檔案；行號可能有幾行誤差。
- 沒有跑完整測試套件，也沒有在 Windows 或 macOS 實機上執行任何東西。診斷遮罩有用打包後的 `buildDiagnostics` 實跑；ACL 讀取次數有用臨時測試在 Linux 上以 win32 policy 實跑。
- **tag `v1.6.51` 不存在。** 1.6.51 併入 v1.6.52 發布，文件說法一致（`docs/releases/1.6.52.md:5`、`CHANGELOG.md:97`、`docs/status.md:68`）。
- 另一個 session 正在 `fix/main-ci-flakes` 修 flaky 測試（old-writer-barrier、agent-setup timeouts、agent-observation、createBackup p90 gate）。本報告不重複這些項目。
- 還沒讀的部分：`packages/desktop-core/src/db-source/{decide,resolve,grouping,identity-compare}.ts`（1.6.50 同資料庫接管的判定）、`shell/{repair-state,setup-state,last-backup}.ts`、`settings/{read,schema}.ts`。release note 1.6.48、1.6.50、1.6.52、1.6.53、1.6.54 只做了識別字與檔案層級的抽查，沒有逐句核對。所有 CI run 編號、通過項數與效能數字都沒有驗證。

---

## 1. 狀態對照表

**狀態用語**：

- **已完成（CI）**：程式碼與自動測試都在，但實機驗收未做。
- **部分完成**：只做了一部分，缺口寫在說明欄。
- **未做**：程式碼中找不到。
- **已取消**：有 ADR 明確決定不做。

「實機」欄為「需要」表示必須在 Windows 11 或 macOS 實機上驗收才算完成。

### 1.1 七條不變條件（R4 §0.2）

| # | 不變條件 | 狀態 | 證據與缺口 | 實機 |
|---|---|---|---|---|
| 1 | 資料不因安裝而改變 | 已完成（CI） | `apps/server/src/database-preflight.ts`；`apps/desktop/src/main/first-run.ts`（設定只在 start 成功後 commit；`first-run.spec.ts:367`） | 需要 |
| 2 | 不假冒管理權 | 部分完成 | 單例鎖與 runId IPC 都在。缺口：Windows 舊服務偵測逾時時 fail-open（M-03） | 需要 |
| 3 | Agent 不依賴桌面 GUI 存活 | 部分完成 | `launcher.spec.ts:138` 驗證 App 結束後 MCP 仍可 initialize；GC 有 lease。缺口：M-07、M-08、M-09 | 需要 |
| 4 | 無法確認相容就停止危險變更 | 部分完成 | schema 閘與還原前驗證都在。缺口：H-01（中斷後不讀 journal） | 需要 |
| 5 | 外部設定尊重所有權 | 部分完成 | `packages/agent-setup` 的指紋重驗與補償都在。缺口：M-11、M-12、M-17 | 需要 |
| 6 | 管理權限須明確授權 | 已完成（CI），做法已改 | 沒有實作會話與 CSRF；改為 Web 只能請 App 開啟分頁，由 App 內確認（`apps/server/src/routes/desktop.ts:13,32`）。文件未更新（§5 D-12） | 需要 |
| 7 | 發行聲明只涵蓋通過的安裝包 | 未達成 | 9 個版本已公開發行安裝檔，但沒有任何實機驗收紀錄 | 需要 |

§14.3 要求「七條 invariants 有自動測試映射」，repo 中沒有這份映射。

### 1.2 九個 Gate（R4 §9.5）

沒有任何 Gate 有實機證據。下表只說明 CI 能涵蓋到哪裡。

| Gate | CI 涵蓋 | 主要缺口 |
|---|---|---|
| G-DB-01 | 大部分（`tests/desktop-core/db-source.test.ts`、`tests/server/database-preflight.test.ts`） | Windows 檔案 ID、外接裝置卸載未實測 |
| G-DB-02 | 大部分（`tests/server/schema-gate.test.ts`、`old-writer-barrier.test.ts`） | 組合 4（真實 plugin、MCPB）未做；H-01 |
| G-DB-03 | 大部分（`tests/storage/restore-verify.test.ts`、`tests/stress/sqlite-wal-stress.test.ts`） | 磁碟滿、斷電未實測；M-14；H-02 |
| G-SVC-01 | 部分 | 真實 `schtasks`、`launchctl` 只用 fake 測；M-03 |
| G-SVC-02 | 部分 | 睡眠喚醒未測；M-02、M-04、M-05 |
| G-MCP-01 | 部分 | 跨版本 runtime 升級沒有 packaged E2E；M-07、M-08、M-13 |
| G-SEC-01 | 大部分 | Electron 層沒有整合測試（T-01）；跨 OS 使用者測試未做 |
| G-UPD-01 | **不適用** | 自動更新已取消（ADR-25、ADR-38、ADR-40）。Gate 定義未改寫 |
| G-UX-01 | 部分 | 真實 Agent 寫入一筆記錄的全流程、螢幕閱讀器、125% 與 150% DPI 未做 |

### 1.3 開發階段（R4 §9.4）

| 階段 | 狀態 | 說明 |
|---|---|---|
| 0 契約與測試基座 | 已完成（CI） | R4 沒有這個階段的狀態段 |
| 1 Runtime spike | 已完成（CI）；gate 未過 | 文件自述「實機驗收未做」 |
| 2 安全最小桌面 | 已完成（CI）；gate 未過 | 同上 |
| 3 Agent 整合 | 已完成（CI）；gate 未過 | 真實 host handshake 未做 |
| 4 接管與改設定 | 部分完成 | 1.6.49 至 1.6.51 實作。「每個中斷階段都可恢復」未達成（H-01）。R4 沒有狀態段 |
| 5 自動更新與 schema | 部分完成 | 打包、schema 屏障與還原驗證已做；自動更新已取消 |
| 6 同批發行 | 未做 | 沒有實機驗收 |

### 1.4 工程票 DT-01 至 DT-37

| 票 | 內容 | 狀態 | 證據或缺口 | 實機 |
|---|---|---|---|---|
| DT-01 | DB 來源解析與身分 | 已完成（CI） | `packages/desktop-core/src/db-source/`；首次設定頁在 1.6.49（`apps/desktop/src/main/first-run.ts`） | 需要（Windows 檔案 ID） |
| DT-02 | 唯讀 preflight | 已完成（CI） | `apps/server/src/database-preflight.ts`；`tests/server/database-preflight.test.ts` | 需要（Windows sidecar） |
| DT-03 | 寫入端 schema 閘 | 已完成（CI） | `tests/server/schema-gate.test.ts`、`tests/storage/schema-gate-surface.test.ts`。矩陣該列沒有狀態註記 | 需要 |
| DT-04 | 舊寫入端屏障實驗 | 部分完成 | 組合 1 至 3 已做；組合 4 未做 | 需要 |
| DT-05 | 備份驗證與 restore 守門 | 部分完成 | `tests/storage/restore-verify.test.ts`。缺口：M-14（最後的 rename 沒有重試）；App 內沒有還原（H-02）。矩陣該列沒有狀態註記 | 需要 |
| DT-06 | SQLite 版本檢查 | 已完成（CI） | `apps/server/src/sqlite-runtime.ts`；`apps/desktop/tests/packaged-smoke/runtime-sqlite.spec.ts:75` | 不需要 |
| DT-07 | 多程序 WAL 壓力 | 已完成（CI） | `tests/stress/sqlite-wal-stress.test.ts`，三個 OS 都跑 | 建議 |
| DT-08 | 檔案系統風險政策 | 部分完成 | `packages/desktop-core/src/db-source/storage-risk.ts`；`storage-risk.spec.ts`。缺口：Windows USB 外接硬碟判為本機、iCloud「桌面與文件」不偵測（L-11）；M-04 | 需要 |
| DT-09 | ServiceOwner 狀態機與 journal | **部分完成，文件標為已實作** | 狀態表與 journal 寫入都在。`recover()` 沒有接線（H-01） | 需要 |
| DT-10 | OperationCoordinator | 已完成（CI） | `packages/desktop-core/src/operations/coordinator.ts`。缺口：部分 handler 繞過（M-04、L-07） | 不需要 |
| DT-11 | 子程序 lifecycle | 部分完成 | `packages/desktop-core/src/backend/`。缺口：Windows 不清孫行程（M-02） | 需要 |
| DT-12 | 服務擁有權證據（macOS LaunchAgent） | 部分完成 | 偵測與停用在 `packages/desktop-core/src/legacy-service/`。矩陣該列沒有狀態註記；真實 `launchctl` 只用 fake 測 | 需要 |
| DT-13 | Windows schtasks adapter | 已完成（CI） | `legacy-service/disable.ts`；`tests/desktop-core/legacy-service-disable.test.ts`（fake） | 需要 |
| DT-14 | 連接埠變更 | 已完成（CI） | `apps/desktop/src/main/change-port.ts`；`change-port.spec.ts`。文件仍寫工作列「變更連接埠…」，1.6.55 已移除（M-16） | 需要 |
| DT-15 | 單例、tray、登入項 | 已完成（CI） | `apps/desktop/src/main/{second-instance,tray}.ts`。1.6.55 縮短工作列選單，矩陣沒有註記 | 需要 |
| DT-16 | 修復視窗 | 已完成（CI） | `apps/desktop/src/main/{repair-window,security,ipc}.ts`。1.6.55 改為六個分頁，矩陣與 C-11 沒有註記 | 需要 |
| DT-17 | 管理 API 授權 | 部分完成，做法已改 | 只有 Host:port 與 Origin 檢查（`apps/server/src/http.ts:60,70`；`tests/server/host-port.test.ts`）。會話與 CSRF 在 `apps/server/src` 中找不到 | 需要 |
| DT-18 | 跨使用者與 XSS 回歸 | 未做 | 找不到跨 OS 帳號的測試 | 需要 |
| DT-19 | 診斷匯出 | 已完成（CI） | `packages/desktop-core/src/shell/diagnostics*.ts`。缺口：L-01、L-02 | 需要 |
| DT-20 | 設定檔原子寫入 | 已完成（CI） | `packages/desktop-core/src/settings/`、`internal/atomic-file.ts` | 不需要 |
| DT-21 | Agent 共用 API | 已完成（CI） | `packages/agent-setup/`；App 自 1.6.49 起呼叫（`apps/desktop/src/main/agents.ts:18`）。矩陣仍寫「App 設定中心尚未呼叫」。缺口：M-11、M-12、M-17 | 需要 |
| DT-22 | Agent 狀態與 handshake | 已完成（CI） | `packages/desktop-core/src/agents/handshake.ts` | 需要（真實 host） |
| DT-23 | 固定 launcher 與 manifest | 已完成（CI） | `packages/desktop-core/src/runtime/`。缺口：M-08、M-09、M-10 | 需要（Windows ACL） |
| DT-24 | runtime 延後 GC | 已完成（CI） | `runtime/{lease,runtime-gc}.ts`；`runtime-gc-live.test.ts:151` 在 Windows 實跑。GC 的核心保證查證成立（§2.5） | 需要（檔案鎖） |
| DT-25 | 無 Node 封裝 spike | 已完成（CI） | `scripts/desktop-runtime-spike/`。不是殘留：`build.mjs` 與 `download.mjs` 是正式建置路徑（L-19） | 需要 |
| DT-26 | Windows `IFileOpenDialog` | 已完成（CI） | `apps/server/src/folder-picker.ts`；`tests/server/folder-picker.test.ts` | 需要 |
| DT-27 | Dashboard bridge | 已完成（CI） | `apps/desktop/src/main/second-instance.ts`；`dashboard-handoff.spec.ts`（整檔在 Windows 跳過） | 需要 |
| DT-28 | 更新 metadata 驗證 | 已取消 | `apps/desktop/electron-builder.config.mjs:102`（`publish: null`）；ADR-25、ADR-40 | 不適用 |
| DT-29 | macOS 安裝位置檢測 | **未做，文件沒有寫未做** | 程式碼中找不到 `ApplicationsFolder` 或 translocation 的處理。App 內不安裝更新後，這張票的理由已不成立；建議在矩陣標為已取消 | 不適用 |
| DT-30 | 更新安裝時機 | 已取消 | 沒有 `electron-updater` | 不適用 |
| DT-31 | 三階段更新與修復安裝包 | 已取消（更新部分） | 修復入口由 App 視窗的「狀態」分頁提供 | 需要（修復入口） |
| DT-32 | migration 前備份與樣本升級 | 已完成（CI） | `tests/storage/{upgrade-samples,migration-interruption}.test.ts`；`migration-interruption.spec.ts`（只殺後端子行程，不殺主行程） | 需要 |
| DT-33 | 聯合發行閘 | 已完成（CI） | `.github/workflows/release.yml:384-390`。矩陣仍寫「實跑待確認」，實際已在 9 個版本跑過 | 不需要 |
| DT-34 | 解除安裝與移除入口 | 部分完成 | NSIS 已做。macOS「移除桌面整合」入口未做，Agent 設定也沒有 App 內的移除（M-11） | 需要 |
| DT-35 | 退出語意 UI | 已完成（CI） | `apps/desktop/src/main/quit.ts` | 需要 |
| DT-36 | CI 隔離與實機環境清單 | 部分完成 | 隔離已做。實機環境清單與驗收清單不存在；本報告 §4 提供一份 | 需要 |
| DT-37 | 簽章與公證 | 已取消 | ADR-38。矩陣該列沒有狀態，§5 仍寫「未就緒」 | 不適用 |

**沒有票號的已發行功能**：1.6.48 串流匯入、1.6.50 同資料庫接管、1.6.53 手動更新檢查（只掛 ADR-40）、1.6.55 單一視窗與分頁。

### 1.5 ADR-01 至 ADR-40

只列出程式碼與文件宣稱不一致的 ADR。其餘 ADR 的程式碼與宣稱相符，或屬於無法由程式碼驗證的產品決策。

| ADR | 文件宣稱 | 程式碼實況 |
|---|---|---|
| ADR-02 | macOS Intel「待確認」 | 已定案：`desktop-package.yml:81-83` 固定建置 windows-x64、macos-arm64、macos-x64 |
| ADR-03 | 「待使用者確認」 | `release.yml:386-390` 已強制，缺任一安裝檔即失敗 |
| ADR-11 | 已採用（Host:port、Origin、會話、CSRF） | 只有 Host:port 與 Origin；會話與 CSRF 未實作 |
| ADR-12 | 高風險操作由原生視窗確認 | 已做，且更嚴格：Web 完全不能送出管理動作 |
| ADR-21 | 1.6.42 已實作 | 寫入與 BUSY 已做；idempotent replay 與復原沒有接線（H-01） |
| ADR-22 | 已採用 | 後端子行程中斷的情境有測試；主行程當機後不讀 `migrationStarted`（H-01）。實際風險有限，因為 App 從不自動啟動舊服務 |
| ADR-23、ADR-24 | 已採用 | 已被 ADR-25、ADR-40 取代，沒有對應程式碼 |
| ADR-30 | macOS 入口未實作 | 屬實（DT-34） |
| ADR-38 | 「主要取得方式是本機打包」 | 9 個 Release 都附安裝檔，App 內更新檢查直接給安裝檔連結（`packages/desktop-core/src/update-check/urls.ts:16-24`） |

### 1.6 元件契約 C-01 至 C-22、C-T

| 契約 | 狀態 | 說明 |
|---|---|---|
| C-01 DesktopMain | 文件過時 | 仍寫「使用 electron-updater」「須簽署並公證」 |
| C-02 TrayController | 文件錯誤 | 「『開啟 Dashboard』永遠是第一項」不成立：`tray-menu.ts:58-62` 會在前面排狀態行與「完成首次設定…」 |
| C-04 OperationCoordinator 與 Journal | **與程式碼不符** | H-01 |
| C-11 RepairWindow | 文件過時 | 仍只描述修復視窗；實際為六個分頁 |
| C-13 AgentStatusModel | 文件與程式碼不符 | 文件的 `effectiveDb`、`launcherKind`、`manifestOwner`、`lastVerifiedAt`、`verificationLevel` 在程式碼中都找不到；實際欄位是 `state`、`levels`、`nextStep`（`packages/desktop-core/src/agents/status.ts:76-79`） |
| C-15 BackupAndRestoreService | 部分 | 還原只有 CLI（H-02） |
| C-16 UpdateService | 文件過時 | 實際只有手動檢查 |
| C-19 UninstallAndIntegrationCleanup | 部分 | macOS 入口與 Agent 移除未做 |
| 其餘 | 與程式碼相符 | C-03、C-05 至 C-10、C-12、C-14、C-17、C-18、C-20 至 C-22、C-T |

---

## 2. 問題清單

每項列出：位置、失敗情境、建議修正。「複核」欄為「是」表示我另外開檔確認過。

### 2.1 高嚴重度

#### H-01 當機復原沒有接到產品（已複核）

- **位置**：`packages/desktop-core/src/operations/recovery.ts:196`（`recover`）、`operation-journal.ts:60`（`findInProgress`）、`:127`（`applyRecovery`）。`apps/desktop/src/main/` 中沒有任何呼叫；`journalFile` 只在 `index.ts:164` 用來建立 coordinator。
- **失敗情境**：主行程在 migration、換連接埠、換資料庫或停用舊服務途中當機或被強制結束。下次啟動時 App 不讀 journal：
  - `in-progress` 的記錄永遠不會關閉，`prune()` 也永遠保留它們。
  - `migrationStarted` 旗標沒有人讀，ADR-22 的保護只在後端子行程中斷時有效。
  - `OPERATION_KINDS` 中的 `apply-agent`、`restore`、`update-install` 從未被建立；`advance()` 沒有產品呼叫者。
- **實際影響**：資料損毀的風險低，因為設定是驗證成功後才一次寫入，而且 App 從不自動啟動舊服務。問題在於文件把 P0 風險 R06 與 R30 的緩解措施標為「已實作」，產品中卻沒有；使用者在中斷後也得不到任何提示。
- **建議**：二選一。
  1. 在 `index.ts` 讀設定之後、首次設定之前呼叫 `findInProgress()` 與 `recover()`，並加一個「殺主行程後重啟」的 smoke。
  2. 刪除未使用的模組，把 DT-09、ADR-21、ADR-22、C-04 改寫為「以原子設定寫入取代 journal 復原」。

#### H-02 App 內沒有還原，卻要使用者「從備份還原」（已複核）

- **位置**：`packages/desktop-core/src/shell/i18n.ts:233`（`DB_MISSING` 的提示）、`:239`；`restoreDatabase` 唯一的產品呼叫點是 `apps/server/src/cli.ts:597`。
- **失敗情境**：使用者的資料庫檔案遺失或檢查失敗。App 顯示「請選擇資料庫，或從備份還原」，但六個分頁裡沒有還原按鈕。使用者只能開終端機執行 `pnpm db:restore`；只安裝桌面 App 的使用者沒有 pnpm，等於無路可走。
- **建議**：在「資料」分頁加還原流程，沿用 `restoreDatabase` 的驗證，經 OperationCoordinator 執行，並先停後端。在做好之前，把提示改成「開啟備份資料夾」這個 App 內做得到的動作。

### 2.2 中嚴重度：操作協調

| ID | 位置 | 失敗情境 | 建議 | 複核 |
|---|---|---|---|---|
| M-01 | `apps/desktop/src/main/local-copy.ts`（回滾在 :173-181） | 「複製到本機磁碟並改用」期間後端不停、也不查進行中的操作。來源是使用中的資料庫時，快照之後到舊後端停止之間的寫入（包含進行中的匯入）不會進副本，而且沒有提示 | 來源等於使用中的資料庫時，先查 activity 並先停後端再複製 | 否 |
| M-02 | `apps/desktop/src/main/ipc.ts:164-195`；`backend-supervisor.ts:845`；`backend/types.ts:77` 對 `apps/server/src/shutdown.ts:8` | 只有換連接埠會查進行中的匯入，換資料庫與退出都不查。supervisor 的 `gracefulMs` 與 server 的連線寬限都是 10 秒（已複核），有進行中請求時必然升級為強制終止。Windows 的強制終止不處理孫行程，匯入的子行程會成為孤兒，繼續寫已被切走的資料庫 | 三條路徑共用換連接埠的 `busyReason()`；`gracefulMs` 改為大於 server 的寬限；Windows 用 Job Object 或 `taskkill /T` | 部分 |
| M-03 | `packages/desktop-core/src/legacy-service/detect.ts:202-208`、`:264-276` | Windows 上沒有定義檔時，偵測完全依賴 PowerShell 查詢。查詢逾時（上限 2 秒）或失敗時 `taskXml` 為空，回傳 `kind: "none"`。只登錄了排程工作的舊服務偵測不到，App 與舊服務同時開同一個資料庫。macOS 沒有這個路徑 | 逾時時回傳「無法判定」而不是「沒有」；同一次執行內快取結果 | 是 |
| M-04 | `apps/desktop/src/main/index.ts:507-534` | `settleStorageRisk` 直接呼叫 `supervisor.stop()`（:521），不經 coordinator。換連接埠或複製進行中，後端可能被它停掉。後端重啟中時（:511）直接 return，網路磁碟的判定不會套用到之後起來的後端 | 改走 coordinator；重啟中時延後重試 | 是 |
| M-05 | `packages/desktop-core/src/shell/backend-recovery.ts:88-98` | 後端意外結束時剛好有別的操作在跑，自動重試遇到 BUSY 只寫 log，不重排也不顯示視窗。視窗關著的使用者不會知道服務已停 | BUSY 時延後重排，或顯示視窗 | 否 |
| M-06 | `packages/desktop-core/src/operations/journal-store.ts:47-60` | `operations-journal.json` 損毀時 `load()` 拋出例外，之後每次啟動後端都失敗。App 內沒有重置的動作，使用者只能自己刪檔 | 讀取失敗時把壞檔改名隔離，從空 journal 重來並記 log | 部分 |

### 2.3 中嚴重度：跨版本互動

| ID | 涉及版本 | 位置 | 失敗情境 | 建議 | 複核 |
|---|---|---|---|---|---|
| M-07 | 1.6.49 × 1.6.51 | `packages/desktop-core/src/runtime/launcher-main.ts:108-122` | launcher 只在行程啟動時讀一次 App 的資料庫路徑。使用者之後在 App 換資料庫或複製到本機，已開著的 Agent（MCP 行程）仍寫舊檔，沒有偵測也沒有提示 | MCP 寫入前重讀指標，不一致就拒寫；或在切換成功後明示「請重新開啟 Agent」 | 否 |
| M-08 | 1.6.45 × 1.6.54 | `packages/desktop-core/src/runtime/bundled-install.ts:201-210`、`:410` | Windows 上重裝同一個 runtime id（檔案損壞，或同版號不同 build）要先改名整個目錄。Agent 正從該目錄執行時改名失敗，約 4.5 秒後回 `RUNTIME_INSTALL_FAILED`，提示是「重新安裝」，沒有說要先關閉 Agent | 專屬錯誤碼與文案；runtime id 納入內容雜湊 | 否 |
| M-09 | 1.6.47 × 1.6.54 | `runtime/install.ts:187-188`；`verify.ts:171-189`；`windows-acl.ts:296-301` | ACL 戳記在改寫 `current` 之前取得，所以每次安裝後第一次啟動都會再開一次 PowerShell；GC 動到 `runtimes/` 後也會再讀一次。這次讀取可能落在 Agent 的 hook 上，最壞等待 160 秒。1.6.47 的 ACL 預熱只涵蓋安裝那一次，效能門檻也只量那一次 | 寫完 `current` 後再取戳記；hook 用短逾時後放行 | 否 |
| M-16 | 1.6.49、1.6.51 × 1.6.55 | `packages/desktop-core/src/shell/i18n.ts:165`、`:253`；`setup-i18n.ts:191` | 1.6.55 把工作列選單縮為六項，但三段文案仍指向已不存在的入口：「從工具列選單開啟『修復…』」「工具列選單的『變更連接埠…』」「在『設定 Agent…』連接」。使用者在工作列找不到這些項目。`port-i18n.ts:40` 的 `trayChangePort` 與 `setup-i18n.ts:256` 的 `trayAgentSetup` 也成了死字串 | 改為「狀態」「設定」「Agent」分頁；刪除死字串 | 是 |
| M-18 | 1.6.46 → 1.6.48 | `packages/storage/src/project-data-import-stream.ts:121-123` | 1.6.48 改為把原始位元組直接送到 server。開頭有 UTF-8 BOM 的匯入檔會被判為 `invalid_json`；1.6.46 的 Web 用 `file.text()`，會自動去掉 BOM。這是讀碼推論，沒有實跑 | 開頭略過 `EF BB BF`，並補測試 | 否 |

**查過且沒有問題的跨版本互動**：

- **換連接埠對 Agent 設定**：Agent 設定、hook、launcher 與 integration record 都不含連接埠（MCP 走 stdio shim），換連接埠不影響。
- **換連接埠對待處理的匯入**：1.6.54 已處理。閒置的預覽不擋，進行中的匯入會擋。只剩確認框沒有預先說明預覽會被捨棄（L-06）。
- **runtime GC 對更新**：見 §2.5。
- **IPC allowlist**：`REPAIR_CHANNELS` 的 31 個 invoke channel 與 `ipc.ts` 的 31 個 handler 一一對應，1.6.47 之後新增的 channel 都在內，沒有 allowlist 以外的註冊。
- **診斷遮罩對新分頁**：診斷文件是 allowlist 結構，Agent 設定路徑、舊服務路徑、複製來源、更新網址與 operation journal 都沒有欄位可以進入。

### 2.4 中嚴重度：Agent 整合、資料與發行

| ID | 位置 | 失敗情境 | 建議 | 複核 |
|---|---|---|---|---|
| M-11 | `apps/desktop/src/main/agents.ts:242`；`packages/agent-setup/src/plan.ts:448` | App 只建立 `"install"` 計畫。`uninstallPlan` 只有 CLI 會用。使用者想解除 Agent 整合只能下指令 | 「Agent」分頁加「移除 Agent 設定」，走同一套預覽與交易 | 是 |
| M-12 | `packages/agent-setup/src/apply.ts:232-238` | 「復原上次變更」要求整個檔案的雜湊等於套用後的值。`~/.claude.json` 只要被 Agent 自己改寫過，復原就停在「需要手動修復」。加上 M-11，使用者沒有可用的移除路徑。Agent 改寫該檔的頻率沒有驗證 | 雜湊不符時退回條目層級的移除（`removeJsonSpec`、`findOwnedHook` 已存在） | 是 |
| M-13 | `packages/agent-setup/src/commands.ts:10-13`、`:160-166` | Windows 的 hook 字串是 `"C:\…\work-intelligence-launcher.cmd" <action>`。cmd 與 Git Bash 可以解析；PowerShell 需要 `& "…"`，否則是語法錯誤。測試只有字串比對，沒有交給真實 shell 執行。MCP 自我測試用 App 自己的 `cmd.exe /d /s /c` 包裝，不能證明 Agent 能直接啟動 `.cmd` | Windows CI 加測試，把字串分別交給 cmd、bash、PowerShell 執行 | 否 |
| M-14 | `packages/storage/src/backup.ts:660-664` | 還原的最後一步先刪正式資料庫的 `-wal` 與 `-shm`，再 `renameSync`，沒有重試。Windows 上檔案被防毒或索引器鎖住時直接拋出例外。「使用中」的檢查在更早的 :580，檢查之後才開庫寫入的行程，其 WAL 會被刪掉。這段不在本次範圍的 diff 內；1.6.52 只加了驗證 | rename 加重試；rename 成功後再清 WAL；交換前重做獨占檢查 | 是 |
| M-15 | `packages/desktop-core/src/shell/setup-i18n.ts:216`、`:243-248`；`i18n.ts:204`、`:231`；`legacy-service/remove-command.ts:17-19` | 舊服務無法由 App 停用時，App 顯示「在終端機執行這個指令移除它」並提供「複製指令」。違反「桌面 App 不得要求指令」。`i18n.ts:204` 與 `:231` 對同一件事給了兩個不同的指令（`pnpm service:uninstall` 與 `pnpm bootstrap`） | 無法辨識的服務改為「開啟系統的登入項目設定」這類 App 內可完成的引導；統一文案 | 是 |
| M-17 | `apps/desktop/src/main/agents.ts:105-124` | 計畫永遠同時涵蓋 Codex 與 Claude Code，不偵測是否安裝。只用 Claude Code 的人也會被建立 `~/.codex/*`。任一個 Agent 有衝突就整批拒絕 | 讓使用者按 Agent 選擇；衝突只擋該 Agent | 否 |
| M-10 | `scripts/desktop-runtime-spike/download.mjs:6-8`、`:106` | 內建的 Node 只對同一來源的 `SHASUMS256.txt` 驗證。檔頭註解自己寫「release 必須驗簽章或在 repo 釘 hash」，兩者都沒做。安裝檔本身沒有簽章，所以這是唯一的供應鏈檢查 | 在 repo 釘 Node 各平台的 SHA-256 | 否 |

### 2.5 Windows 與 macOS 的差異

| 項目 | Windows | macOS | 評估 |
|---|---|---|---|
| 舊服務偵測 | 每次啟動都跑 PowerShell（上限 2 秒）；逾時時 fail-open | 沒有定義檔就直接回「沒有」，不跑指令 | M-03 |
| 系統工具路徑 | System32 絕對路徑 | `launchctl` 以裸名經 PATH 解析 | L-04 |
| 強制終止後端 | `TerminateProcess`，不處理孫行程 | 訊號，子行程在 parent disconnect 時自行結束 | M-02 |
| runtime 目錄保護 | 讀 12 個物件的 ACL，拒絕任何非信任 SID 的寫入權；檔案假設繼承 | 逐檔檢查 owner 與 world-writable，不查 group 可寫 | L-17。兩邊都只檢查、不修正 |
| 應用程式選單 | 沒有（`app-menu.ts:25` 回傳 null） | 保留 App、編輯、視窗 | 符合設計；macOS 的編輯快捷鍵有測試 |
| 外接硬碟判定 | USB 硬碟的 DriveType 是 Fixed，判為本機 | `Internal=false` 判為可移除 | L-11 |
| 雲端同步資料夾 | OneDrive 只看環境變數；Google Drive 虛擬磁碟不偵測 | iCloud「桌面與文件」不偵測 | L-11 |
| hook 命令 | `.cmd` shim；PowerShell 下的行為沒有測試 | 單引號加 `'\''` | M-13 |
| 解除安裝 | NSIS 保留資料，有 smoke 斷言 | 拖到垃圾桶，沒有清理入口 | DT-34 |
| 只在單一平台跑的 smoke | `desktop.spec.ts:442` | `shell-window.spec.ts:352`；`dashboard-handoff.spec.ts:38` 整檔在 Windows 跳過 | T-05 |

**runtime GC 對更新的查證結果（沒有問題）**：

- GC 不會刪除 `current`、前一版或 launcher 解析到的 runtime：開始時讀一次 `current`，改名前再讀一次，讀不到就不動（`runtime-gc.ts:262-269`、`:291`）。
- 刪除只發生在已改名為 `.quarantine-*` 的目錄。Windows 上檔案被鎖時整個延後，不會留下半刪的 runtime 被當成可用。
- lease 不看 PID，只看 mtime 加靜默期，沒有 PID 重用的問題。
- 1.6.53 以前的 launcher 不寫 lease，只受 7 天規則保護。

### 2.6 安全性

**沒有發現高或中嚴重度的安全問題。** 查證結果：

| 項目 | 結果 | 證據 |
|---|---|---|
| CSP | 以回應標頭套在每個 `wi-repair:` 回應；`default-src 'none'; script-src 'self'; connect-src 'none'` | `apps/desktop/src/main/security.ts:36-45`；`packages/desktop-core/src/shell/navigation-policy.ts:26-27` |
| IPC 傳送者檢查 | 31 個 handler 都先過 `isTrusted`：必須是該視窗的主 frame，網址是 App 自己的資產 | `apps/desktop/src/main/ipc.ts:87-94` |
| 導航與開新視窗 | `will-navigate`、`will-redirect`、`will-attach-webview` 全擋；`setWindowOpenHandler` 全拒；權限請求全拒 | `security.ts:13-18`、`:33-35` |
| webPreferences | `contextIsolation`、`sandbox` 開；`nodeIntegration`、`webviewTag` 關；打包版關 DevTools | `repair-window.ts:85-93`；`index.ts:197` |
| 除錯參數 | 打包版拒絕 `--remote-debugging-port`、`--inspect` 等 | `index.ts:673-677` |
| Fuses | `runAsNode` 關、`onlyLoadAppFromAsar` 開、asar 完整性驗證開等 7 項；打包後從成品讀回逐項比對，不符即失敗。#386 升級只改了 import 寫法 | `apps/desktop/scripts/app-fuses.mjs:6-14`；`package.mjs:356-369` |
| 後端啟動方式 | 用 runtime 內的官方 Node，不用 `ELECTRON_RUN_AS_NODE`，與 `runAsNode` fuse 不衝突 | `backend/node-dependencies.ts:43` |
| 更新檢查 | 網址寫死；不帶憑證、不接受重新導向、10 秒逾時、1 MiB 上限；連結由 tag 自行組出再驗證；不下載、不執行 | `update-check/constants.ts`、`check.ts:127-152` |
| 指令注入 | 全部用 argv，不經 shell；PowerShell 腳本是常數，路徑經環境變數或 stdin 傳入 | `windows-acl.ts:697-715` |
| 測試後門 | 都在 `__WI_TEST_BUILD__ && !isPackaged` 之後；打包時掃描禁用字串 | `config.ts:102-198`；`scripts/check-production-bundle.mjs` |
| CI | action 都釘 SHA；沒有 `pull_request_target`；沒有被關掉的 gate | `.github/workflows/` |

### 2.7 低嚴重度

| ID | 位置 | 問題 | 建議 |
|---|---|---|---|
| L-01 | `shell/diagnostics-redact.ts:76,89`；`diagnostics-scan.ts:31` | POSIX 路徑遮罩只認固定的根目錄。實測 `/etc/…`、`/usr/local/…`、`/data/…` 原樣輸出，第二道掃描也沒抓到。目前只有在資料庫路徑字串與設定不同時才可能發生 | 任何兩段以上的絕對路徑都遮；把 realpath 與 log 目錄加進已知路徑 |
| L-02 | `diagnostics-redact.ts:88` | Windows 的 `\\?\C:\Users\…` 路徑已遮，但殘留 `\\?\` 前綴。沒有洩漏 | 起始樣式納入 `\\?\` 與 `\\.\` |
| L-03 | `apps/desktop/src/main/log.ts:55-64` | `desktop-main.log` 用預設權限建立；其他檔案都是 0600。log 內有資料庫路徑 | 目錄 0700、檔案 0600 |
| L-04 | `legacy-service/disable.ts:141-177`；`detect.ts:173,184` | macOS 的 `launchctl` 以裸名經 PATH 解析，與 Windows 的做法不一致 | 改用 `/bin/launchctl` |
| L-05 | `electron-builder.config.mjs:132-133`；`release.yml:416-442` | 安裝檔未簽章，Release 只附 `SHA256SUMS.txt`。屬 ADR-38 的已知取捨 | 加 `actions/attest-build-provenance` |
| L-06 | `apps/desktop/src/main/change-port.ts:119` | 已知有待處理的匯入預覽，卻沒有傳給確認框。預覽被捨棄是事後才告知 | 確認框加一句 |
| L-07 | `apps/desktop/src/main/ipc.ts:303-311`、`:337-355`、`:370` | 首次設定、Agent、舊服務預覽的 handler 不經共用的 `state.busy`。Agent 套用可以和換連接埠並行 | 統一走 `exclusive` |
| L-08 | `apps/desktop/src/renderer/repair/actions.ts:37-42` | 任何 BUSY 都顯示「正在重新啟動服務」，把「另一個動作進行中」說錯 | 像 `port-view.ts:42-45` 一樣區分原因 |
| L-09 | `backend/backend-supervisor.ts:826` | 後端就緒後沒有週期性健康檢查。卡住但還活著的後端偵測不到 | 加低頻探測 |
| L-10 | `apps/desktop/src/main/local-copy.ts:157` | 後端啟動成功到寫入設定之間當機，副本成為孤兒。不傷資料 | 隨 H-01 一併處理 |
| L-11 | `db-source/storage-risk-node.ts:279`、`:344-346` | Windows USB 硬碟判為本機；iCloud「桌面與文件」與 Google Drive 虛擬磁碟不偵測 | Windows 加查 BusType；文件列出已知缺口 |
| L-12 | `apps/desktop/src/main/runtime-provision.ts:94-102` | 更新後 7 天內，GC 每小時空跑一次並寫一行 log | 「剛退役」這個原因不重試 |
| L-13 | `runtime/runtime-gc.ts:178-183`、`:430-433` | `gc-state.json` 寫入失敗時沿用舊的保留名單，真正的前一版可能在 7 天後被收掉 | 記憶體內保留本次指名的保留名單 |
| L-14 | `runtime/lease.ts:122-133` | lease 被清掉後只重建一次。行程兩度停頓超過 4 分鐘就永久沒有 lease | 允許重複重建 |
| L-15 | `runtime/bundled-install.ts:252-262`、`:302` | 複製的檔案沒有 fsync 就 commit。斷電後內容壞但大小相同的檔案理論上可能被 stat 快取放行 | commit 前 fsync |
| L-16 | `runtime/verify.ts:303-305`；`scan.ts:85-87` | runtime 目錄多出任何檔案（例如 Finder 的 `.DS_Store`）就拒絕啟動，MCP 以 78 結束 | 忽略已知的系統雜檔 |
| L-17 | `runtime/permissions.ts:28-36` | POSIX 不查 group 可寫 | 加查，或在文件載明差異 |
| L-18 | `.github/workflows/desktop-smoke.yml`；`desktop-package.yml:8-25` | `desktop-smoke` 只在 PR 且路徑符合時跑，不在發行閘內。`plugins/**` 不在路徑清單，但 `launcher.spec.ts:30` 用到 plugin 的 `launch.mjs` | 補路徑；發行前要求 desktop-smoke 成功 |
| L-19 | `.github/workflows/desktop-runtime-spike.yml:34` | matrix 的 `electron` 那一半（3 個 job）測的是 App 拒收的 runtime 種類 | 移除那一半；workflow 改名去掉「spike」 |
| L-20 | `apps/desktop/src/main/agents.ts:279` | 套用結果是「需要手動修復」時，畫面顯示「已寫入的部分已還原」，與事實不符 | 改用 `agentsManualRepair` 並帶路徑 |
| L-21 | `packages/agent-setup/src/files.ts:143` | `renameSync` 沒有 Windows 的 EPERM、EBUSY 重試。回滾安全，但使用者看到失敗 | 短暫重試 3 至 5 次 |
| L-22 | `packages/agent-setup/src/json-config.ts:129-138` | Tab 縮排的 JSON 被改成空白縮排，差異預覽變成整個檔案 | 保留原縮排字元與結尾換行 |
| L-23 | `apps/server/src/routes/system.ts:59-70` | 匯出先把整份寫到磁碟才比 256 MiB。大資料庫會白寫數 GB 再回 413 | 寫入時計數，超限即中止 |
| L-24 | `packages/storage/src/backup.ts:540-553` | 還原驗證只做 `quick_check` 與 `foreign_key_check` | 還原是離線操作，可改用 `integrity_check` |
| L-25 | `apps/server/src/transfer-workspace.ts:21,67` | 殘留的暫存目錄只在啟動時清，而且要滿 1 小時。App 可能常駐數週 | 加定時清理 |
| L-26 | `apps/server/src/backup-worker-client.ts:325-339` | 單一操作沒有逾時。子行程卡住時請求永遠不釋放 | 加 watchdog |
| L-27 | `apps/desktop/src/renderer/repair/theme.ts` | App 視窗只跟隨系統主題，Web 版 Dashboard 可手動選。兩者可能一深一淺 | 記錄為已知差異，或共用偏好 |
| L-28 | 多處（見下） | 死碼 | 刪除 |
| L-29 | 遠端分支 `tmp/perf-baseline-phases` | 只有 1 個未合併的 commit（`9b3a2b0f`），在 `performance.spec.ts` 加 11 行計時輸出 | 確認不需要後刪除分支 |

**L-28 的死碼明細**：

- `packages/desktop-core/src/operations/`：`recover`、`findInProgress`、`applyRecovery`、`advance`，以及從未建立的 operation kind（屬 H-01）。
- `packages/desktop-core/src/shell/navigation-policy.ts:89-91`：`isAllowedNavigation` 沒有產品呼叫者；註解說「可導航到 Dashboard」，與實際全擋的行為不符。
- `packages/desktop-core/src/shell/repair-ipc.ts:328-338`：`isRepairActionId` 只有測試在用。
- `packages/desktop-core/src/runtime/`：`reuseAclStamp`、`onlyLeftovers`、`fullVerification`、`buildRuntimeManifest`、`launcherCommandPath` 只有測試在用。
- `port-i18n.ts:40` 的 `trayChangePort`、`setup-i18n.ts:256` 的 `trayAgentSetup`：1.6.55 後沒有對應的工作列項目。
- `apps/desktop/src/main/legacy-disable.ts:268` 的 `syntheticLegacyDisable` 留在產品 bundle，但只有測試建置可達。

**臨時程式碼**：`main` 在 `v1.6.46..v1.6.55` 內沒有 TEMPORARY commit；審查範圍內的程式碼沒有 `TODO`、`FIXME`、`HACK`、`XXX`。檔名與識別字仍叫 `repair-window`、`REPAIR_CHANNELS`、`workIntelligenceRepair`，實際已是整個 App 視窗，命名過時但無害。

### 2.8 效能

- **沒有發現被調鬆的門檻。** 1.6.54 的「Windows SQLite timing」是純測試儀器（`WI_SQLITE_TIMING`），沒有改門檻，也沒有修正產品行為；它量到的 `BEGIN IMMEDIATE` 最長等待 5.5 秒仍未處理。
- **1.6.55 的 renderer 變大**：gzip 合計 28,859 增為 34,758 位元組（增加 20.4%）。
- **1.6.55 的視窗開啟時間在三份文件中不一致**，無法判斷哪一組正確（§5 D-04）。
- **每次啟動後端的固定成本**：journal 整檔重寫加 fsync 多次；runtime GC 掃描一次；Windows 多一次 PowerShell（M-03）；安裝後第一次啟動多一次 ACL 讀取（M-09）。
- **4 秒輪詢**：`agents.snapshot()` 每次同步讀多個 Agent 設定檔。量小，但一直在跑。
- 效能測試（`test:performance`）、覆蓋率與 Web E2E 只在 Linux CI 跑。

### 2.9 測試缺口

| ID | 缺口 |
|---|---|
| T-01 | Electron 層沒有整合測試驗證：非受信傳送者呼叫 IPC 被拒、`will-navigate` 被擋、實際回應帶 CSP 標頭。目前只有純函式測試（`tests/desktop-core/shell-policy.test.ts`） |
| T-02 | 沒有測試逐一比對 `REPAIR_CHANNELS` 與已註冊的 handler |
| T-03 | 打包版 smoke 只驗 `--remote-debugging-port` 被拒；沒有驗 `--inspect`、`ELECTRON_RUN_AS_NODE=1`、`NODE_OPTIONS` 無效，也沒有驗竄改 `app.asar` 後拒絕啟動 |
| T-04 | 主行程當機後帶著進行中的 journal 重啟，沒有任何 smoke（H-01）。journal 損毀、複製期間有寫入、換資料庫或退出時有進行中的匯入、自動重試遇 BUSY，都沒有測試 |
| T-05 | 單一平台：`dashboard-handoff.spec.ts:38` 整檔在 Windows 跳過；`transaction.test.ts:256` 的 symlink 測試在 Windows 跳過；`runtime-update-session.test.ts:63` 整組在 Windows 跳過 |
| T-06 | 沒有跨版本 runtime 升級的打包版 E2E：`lifecycle.spec.ts:97` 用同一個安裝檔覆蓋，只會走「已是目前版本」 |
| T-07 | 舊服務的 smoke 用合成檔；真實的 `schtasks` 與 `launchctl` 只用 fake 測 |
| T-08 | hook 字串沒有交給真實 shell 執行（M-13）；BOM 匯入檔（M-18）；接近 256 MiB 的實際匯入；Windows 上 rename 被鎖（M-14、L-21） |
| T-09 | `agents.spec.ts` 只涵蓋順利路徑，沒有「套用後檔案被外部改寫再復原」（M-12） |
| T-10 | 診斷測試沒有涵蓋 L-01、L-02 的路徑形式 |
| T-11 | Windows 超過 260 字元的長路徑；macOS quarantine 屬性；系統睡眠跨越 GC 靜默等待 |

---

## 3. 建議的處理順序

1. **H-02 與 M-15、M-11**：三項都是「App 要求使用者下指令」，直接違反產品要求。建議在實機驗收前處理，否則驗收清單 §4 的 A-7、E-4 與 H-3 會不通過。
2. **H-01**：先決定要接線還是刪除，再改文件。
3. **M-16**：改文案即可，成本最低，而且實機驗收時一定會被看到。
4. **M-02、M-03、M-04**：Windows 上的協調缺口，建議在 Windows 實機驗收前修掉。
5. **文件**（§5）：可以獨立於程式碼修改進行。

---

## 4. 實機驗收清單

**適用版本**：v1.6.55 的安裝檔。**全部步驟只用滑鼠與鍵盤操作畫面，不需要輸入任何指令。** 如果某一步只能靠指令完成，該步即為不通過。

**通用規則**：

- 每一步記錄：作業系統版本、CPU 架構、安裝檔的 SHA-256、實際結果、截圖。
- 只使用合成資料與測試帳號，不使用真實的工作記錄。
- 畫面文字以繁體中文介面為準。系統語言不是中文時 App 顯示英文。
- 標「前置」的項目由準備測試機的人事先完成，不屬於驗收步驟。
- 標「已知問題」的步驟預期不通過，對應 §2 的編號；請照實記錄。

### A. 安裝與首次啟動

| # | 步驟 | 預期結果 | Windows 11 | macOS |
|---|---|---|---|---|
| A-1 | 從 GitHub Releases 頁面下載安裝檔 | Windows：`…win-x64-setup.exe`。macOS：依晶片選 `…mac-arm64.dmg` 或 `…mac-x64.dmg` | ☐ | ☐ |
| A-2 | 執行安裝檔 | Windows：出現 SmartScreen 警告，按「其他資訊」再按「仍要執行」後安裝完成，不要求系統管理員權限。macOS：把 App 拖到「應用程式」；第一次開啟時在「系統設定 → 隱私權與安全性」按「強制打開」 | ☐ | ☐ |
| A-3 | 在沒有安裝 Node.js 的電腦上開啟 App | App 正常開啟，不提示安裝任何東西 | ☐ | ☐ |
| A-4 | 觀察第一個畫面 | 出現一個視窗，最前面是「首次設定」分頁，畫面上有「使用預設設定開始」 | ☐ | ☐ |
| A-5 | 按「使用預設設定開始」 | 服務啟動；瀏覽器自動開啟 Dashboard；「首次設定」分頁消失；「狀態」分頁出現一張標題為「開始使用 Work Intelligence」的卡片 | ☐ | ☐ |
| A-6 | 關閉 App 再開啟 | 不再出現「首次設定」分頁，也不再出現 A-5 的卡片 | ☐ | ☐ |
| A-7 | 使用者名稱含中文或空白的帳號重做 A-2 至 A-5 | 結果相同 | ☐ | ☐ |
| A-8 | 中斷網路後重做 A-3 至 A-5 | 結果相同（App 不需要網路） | ☐ | ☐ |

### B. 視窗、分頁與外觀（1.6.55）

| # | 步驟 | 預期結果 | Windows 11 | macOS |
|---|---|---|---|---|
| B-1 | 觀察分頁列 | 依序為「狀態」「Agent」「設定」「資料」「診斷」 | ☐ | ☐ |
| B-2 | 用滑鼠點每個分頁 | 內容切換，不開新視窗 | ☐ | ☐ |
| B-3 | 用 Tab 鍵移到分頁列，按左右方向鍵、Home、End | 焦點在分頁之間移動，有清楚可見的焦點框 | ☐ | ☐ |
| B-4 | 觀察視窗上方 | Windows：沒有選單列；按 Alt 也不出現。macOS：選單列只有 App 名稱、「編輯」「視窗」 | ☐ | ☐ |
| B-5 | 按 F12、Ctrl+Shift+I（macOS：Cmd+Option+I）、Ctrl+R（macOS：Cmd+R）、F5 | 沒有任何反應：不開開發者工具，畫面不重新載入 | ☐ | ☐ |
| B-6 | 在任何文字欄位試剪下、複製、貼上、全選、復原 | 都正常運作 | ☐ | ☐ |
| B-7 | macOS：按 Cmd+W | 視窗關閉，App 仍在選單列執行 | 不適用 | ☐ |
| B-8 | 視窗開著時，把系統外觀從淺色切到深色再切回 | 視窗立刻跟著切換，不需要重開 | ☐ | ☐ |
| B-9 | 把視窗縮到最小 | 最小約 720×560；內容沒有被切掉，沒有水平捲軸 | ☐ | ☐ |
| B-10 | 把顯示比例設為 125% 與 150% 後重開 App | 文字與按鈕沒有重疊或被切掉 | ☐ | ☐（Retina 與外接螢幕各一次） |
| B-11 | 關閉視窗後，從工作列圖示選「開啟 Work Intelligence…」 | 開啟同一個視窗；連按多次也只有一個視窗 | ☐ | ☐ |
| B-12 | App 執行中，再點一次桌面或開始功能表的 App 圖示 | 既有視窗被帶到前面，沒有第二個 App | ☐ | ☐ |

### C. 工作列圖示與退出

| # | 步驟 | 預期結果 | Windows 11 | macOS |
|---|---|---|---|---|
| C-1 | 在通知區（macOS：選單列）找到 App 圖示並開啟選單 | 項目為：「開啟 Dashboard」「開啟 Work Intelligence…」「檢查更新…」、分隔線、「退出（退出後不會每日備份）」 | ☐ | ☐ |
| C-2 | 選「開啟 Dashboard」 | 預設瀏覽器開啟 Dashboard | ☐ | ☐ |
| C-3 | 選「退出（退出後不會每日備份）」 | 出現確認對話框，顯示「退出後不會每日備份」與最後成功備份的時間 | ☐ | ☐ |
| C-4 | 按「取消」 | App 繼續執行 | ☐ | ☐ |
| C-5 | 再選一次並按「退出」 | App 結束；工作列圖示消失；在瀏覽器重新整理 Dashboard，頁面無法連線 | ☐ | ☐ |
| C-6 | 開啟工作管理員（macOS：活動監視器），搜尋「Work Intelligence」與「node」 | 沒有殘留的 App 行程 | ☐ | ☐ |
| C-7 | 登出再登入作業系統 | 依登入項設定：App 在背景啟動，不跳出視窗，也不跳錯誤對話框 | ☐ | ☐ |

### D. 連接 Agent

**前置**：測試機已安裝 Claude Code 或 Codex。

| # | 步驟 | 預期結果 | Windows 11 | macOS |
|---|---|---|---|---|
| D-1 | 開「Agent」分頁 | 列出各 Agent 的狀態。尚未設定時不顯示「已連接」 | ☐ | ☐ |
| D-2 | 按預覽變更的按鈕 | 顯示每個將被修改的檔案與差異。此時還沒有寫入任何檔案 | ☐ | ☐ |
| D-3 | 按「套用變更」 | 顯示成功，並提示重新開啟 Agent | ☐ | ☐ |
| D-4 | 按測試連線的按鈕 | 顯示連線測試通過 | ☐ | ☐ |
| D-5 | 重新開啟 Agent，請它記錄一筆合成的工作項目 | 在 Dashboard 看得到這筆記錄 | ☐ | ☐ |
| D-6 | 退出 App（C-5），再請 Agent 記錄一筆 | Agent 仍然成功；重新開啟 App 後在 Dashboard 看得到 | ☐ | ☐ |
| D-7 | Windows：分別在 PowerShell 與命令提示字元環境下的 Agent 觸發一次 hook（以 Agent 的正常操作觸發） | hook 不報錯。**已知風險：M-13** | ☐ | 不適用 |
| D-8 | 按「復原上次變更」 | 顯示「已復原上次的變更。」；Agent 分頁回到未設定的狀態 | ☐ | ☐ |
| D-9 | 重做 D-2、D-3，使用 Agent 幾分鐘後再按「復原上次變更」 | 應該可以復原。**已知問題：M-12**，可能顯示需要手動修復 | ☐ | ☐ |
| D-10 | 在 App 內尋找「移除 Agent 設定」之類的入口 | **已知問題：M-11**，目前沒有 | ☐ | ☐ |
| D-11 | 只安裝 Claude Code、沒有安裝 Codex 的電腦上做 D-2 | 預覽不應包含 Codex 的檔案。**已知問題：M-17** | ☐ | ☐ |

### E. 舊的登入服務

**前置**：測試機有一份 checkout，並已安裝舊的登入服務、使用與 App 相同的資料庫。

| # | 步驟 | 預期結果 | Windows 11 | macOS |
|---|---|---|---|---|
| E-1 | 舊服務執行中，開啟 App | 「狀態」分頁顯示「舊的登入服務也在使用這份資料庫」；App 沒有啟動自己的後端 | ☐ | ☐ |
| E-2 | 按「停用舊的登入服務…」 | 先顯示將被處理的項目，再出現系統確認對話框 | ☐ | ☐ |
| E-3 | 確認 | 顯示已停用；之後提供「立即啟動」 | ☐ | ☐ |
| E-4 | 閱讀 E-1 與 E-3 畫面上的所有文字 | 不應要求在終端機執行指令。**已知問題：M-15** | ☐ | ☐ |
| E-5 | 開啟工作管理員（macOS：活動監視器） | 舊服務的 node 行程已全部結束 | ☐ | ☐ |
| E-6 | Windows：開啟「工作排程器」；macOS：開啟「系統設定 → 一般 → 登入項目」 | 舊服務的項目已不在 | ☐ | ☐ |
| E-7 | 登出再登入 | 只有 App 的服務在執行 | ☐ | ☐ |
| E-8 | 重新安裝舊服務後，在 E-1 的畫面改按「仍要啟動」 | 出現第二次確認；確認後 App 的後端啟動 | ☐ | ☐ |

### F. 變更連接埠

| # | 步驟 | 預期結果 | Windows 11 | macOS |
|---|---|---|---|---|
| F-1 | 開「設定」分頁的連接埠區塊，輸入另一個可用的連接埠並確認 | 出現確認對話框；確認後服務在新連接埠啟動；瀏覽器開啟新位址的 Dashboard | ☐ | ☐ |
| F-2 | 在新位址的 Dashboard 檢查語言、主題等偏好 | 與變更前相同 | ☐ | ☐ |
| F-3 | 在瀏覽器開啟舊位址 | 無法連線 | ☐ | ☐ |
| F-4 | 請 Agent 再記錄一筆 | 成功（Agent 不受連接埠影響） | ☐ | ☐ |
| F-5 | 輸入一個已被其他程式占用的連接埠 | 被拒絕，服務沒有中斷，舊位址仍可用 | ☐ | ☐ |
| F-6 | Windows：輸入系統保留範圍內的連接埠 | 顯示「系統不允許使用這個連接埠」 | ☐ | 不適用 |
| F-7 | 閱讀連接埠相關的錯誤提示 | 不應提到工作列的「變更連接埠…」。**已知問題：M-16** | ☐ | ☐ |
| F-8 | 在 Dashboard 上傳一個匯入檔、停在預覽畫面，再回 App 變更連接埠 | 可以變更；之後提示預覽已被捨棄 | ☐ | ☐ |
| F-9 | 在 Dashboard 開始一個大檔案的匯入，匯入進行中回 App 變更連接埠 | 被拒絕，提示有操作進行中 | ☐ | ☐ |

### G. 資料庫位置與風險

| # | 步驟 | 預期結果 | Windows 11 | macOS |
|---|---|---|---|---|
| G-1 | 「資料」分頁按「選擇資料庫…」，選網路磁碟上的資料庫 | 被拒絕，顯示「資料庫放在網路磁碟上」 | ☐（對應磁碟機與 `\\server\share` 各一次） | ☐（SMB 掛載） |
| G-2 | 選 USB 隨身碟上的資料庫 | 要勾選同意才能使用；提供「複製到本機磁碟並改用」 | ☐ | ☐ |
| G-3 | 選 USB 外接硬碟上的資料庫 | 同 G-2。**已知問題：L-11**，Windows 可能判為本機 | ☐ | ☐ |
| G-4 | 選雲端同步資料夾內的資料庫 | 同 G-2 | ☐（OneDrive） | ☐（iCloud Drive；「桌面與文件」同步為已知未偵測） |
| G-5 | 按「複製到本機磁碟並改用」 | 完成後 App 使用副本；原檔沒有變動（比對修改時間與大小） | ☐ | ☐ |
| G-6 | G-5 之後，已開著的 Agent 再記錄一筆 | 應寫入新的副本。**已知問題：M-07**，可能寫入舊檔；重新開啟 Agent 後應正常 | ☐ | ☐ |
| G-7 | 退出 App，用檔案總管（Finder）把資料庫檔案移到別處，再開啟 App | 顯示「找不到資料庫檔案」；沒有建立新的空資料庫 | ☐ | ☐ |
| G-8 | 閱讀 G-7 的提示並嘗試照做 | 「選擇資料庫…」可用。「從備份還原」在 App 內找不到入口。**已知問題：H-02** | ☐ | ☐ |
| G-9 | 用「選擇資料庫…」選回原檔 | 顯示「✓ 已恢復」，Dashboard 自動開啟一次 | ☐ | ☐ |
| G-10 | 按「開啟備份資料夾」 | 檔案總管（Finder）開啟備份資料夾 | ☐ | ☐ |

### H. 匯入與匯出（1.6.48）

| # | 步驟 | 預期結果 | Windows 11 | macOS |
|---|---|---|---|---|
| H-1 | 在 Dashboard 匯出一個合成專案 | 下載一個檔案 | ☐ | ☐ |
| H-2 | 匯入該檔案 | 先顯示預覽，確認後匯入成功 | ☐ | ☐ |
| H-3 | 匯入一個約 200 MiB 的合成檔 | 成功；期間 Dashboard 仍可操作；App 的記憶體用量沒有隨檔案大小明顯增加 | ☐ | ☐ |
| H-4 | 匯入一個超過 256 MiB 的檔案 | 被拒絕，訊息清楚 | ☐ | ☐ |
| H-5 | 用「記事本」把 H-1 的檔案另存為「UTF-8（含 BOM）」再匯入 | 應成功。**已知風險：M-18** | ☐ | 不適用 |

### I. 檢查更新（1.6.53）

| # | 步驟 | 預期結果 | Windows 11 | macOS |
|---|---|---|---|---|
| I-1 | 開啟 App 後靜置 10 分鐘 | App 沒有自行連線檢查更新 | ☐ | ☐ |
| I-2 | 從工作列選「檢查更新…」 | 視窗切到「設定」分頁並開始檢查 | ☐ | ☐ |
| I-3 | 已是最新版時 | 顯示已是最新版本，並有「開啟發行頁面」 | ☐ | ☐ |
| I-4 | 安裝較舊的版本後再檢查 | 顯示新版本的版號、日期與說明；下載按鈕對應本機平台（macOS 依晶片） | ☐ | ☐（arm64 與 x64 各一次） |
| I-5 | 按下載按鈕 | 瀏覽器開啟下載；App 本身不下載、不安裝；旁邊有以 `SHA256SUMS.txt` 驗證的提示 | ☐ | ☐ |
| I-6 | 中斷網路後檢查 | 顯示離線，沒有錯誤對話框 | ☐ | ☐ |
| I-7 | 用新版安裝檔覆蓋安裝 | 資料庫、設定與 Agent 連線都保留；Agent 不需要重新設定 | ☐ | ☐ |
| I-8 | Agent 開著時做 I-7 | 安裝成功；已開著的 Agent 繼續可用 | ☐ | ☐ |

### J. 診斷匯出（1.6.54）

| # | 步驟 | 預期結果 | Windows 11 | macOS |
|---|---|---|---|---|
| J-1 | 「診斷」分頁按「匯出診斷資訊…」 | 先顯示預覽文字與遮蔽摘要；還沒有寫入檔案 | ☐ | ☐ |
| J-2 | 閱讀預覽全文 | 沒有使用者名稱、家目錄路徑、資料庫完整路徑、電子郵件或權杖 | ☐ | ☐ |
| J-3 | 切到別的分頁再切回來 | 預覽還在 | ☐ | ☐ |
| J-4 | 按「儲存檔案…」並選位置 | 存出的檔案內容與預覽完全相同 | ☐ | ☐ |
| J-5 | 資料庫放在 `D:\客戶名稱\…`（macOS：`/Volumes/客戶名稱/…`）時重做 J-1、J-2 | 資料夾名稱已被遮蔽 | ☐ | ☐ |

### K. 解除安裝

| # | 步驟 | 預期結果 | Windows 11 | macOS |
|---|---|---|---|---|
| K-1 | Windows：「設定 → 應用程式」解除安裝。macOS：退出 App 後把它拖到垃圾桶 | App 被移除 | ☐ | ☐ |
| K-2 | 用檔案總管（Finder）檢查資料庫與備份資料夾 | 都還在 | ☐ | ☐ |
| K-3 | 開啟 Agent | Agent 的設定仍指向已移除的 App。**已知問題：M-11、DT-34**，沒有 App 內的清理入口 | ☐ | ☐ |
| K-4 | 重新安裝並開啟 | 讀回原來的資料庫，專案數與之前相同 | ☐ | ☐ |

---

## 5. 需要修正的文件

「未驗證」表示我沒有對照 CI 紀錄確認哪一邊正確。

### 5.1 README.md 與 README.zh-TW.md

| ID | 位置 | 問題 | 建議 |
|---|---|---|---|
| D-01 | 兩檔全文 | 完全沒有提到桌面 App。專案結構（:357-371）漏列 `apps/desktop`、`packages/desktop-core`、`packages/agent-setup`、`packages/ui-tokens`；文件索引（:419-441）沒有 `docs/desktop/` | 加「桌面 App」一節：支援平台、下載、未簽章的提示 |
| D-02 | 兩檔 :113 | Release 附件只列 plugin zip、mcpb、tgz，並寫「全部需要 Node.js 22.16+」。實際 Release 還有 5 個安裝檔，而且安裝檔自帶 Node | 補列安裝檔，註明不需要系統 Node |

兩語版本的章節結構一致，沒有發現不同步。

### 5.2 docs/status.md

| ID | 位置 | 問題 | 建議 |
|---|---|---|---|
| D-03 | :9、:23 | 「1.6.55（進行中）」。tag `v1.6.55` 已存在且已發布 | 改為已完成 |
| D-04 | :19；`docs/desktop/README.md:247`；對 `docs/releases/1.6.55.md:48-50` | 視窗開啟時間三處不一致。status 與 README：Windows 1543→1715 ms（+11%）、Linux 610→620、macOS 1426→1176。release note：1543→1669（+8%）、610→531、1286→1388。未驗證 | 以最終 CI 取樣統一 |
| D-05 | :44、:72 | 「工作列的『檢查更新…』與修復視窗的『更新』卡片」「工作列的『連接埠』設定」。1.6.55 後工作列只有六項，更新與連接埠在「設定」分頁 | 補 1.6.55 的註記 |
| D-06 | 全檔 | 未結項沒有列出：App 內還原（H-02）、無法辨識的舊服務要下指令（M-15）、Agent 移除（M-11）、DT-18、DT-29、DT-34 的 macOS 部分 | 加入「未結項」 |

### 5.3 docs/releases 與 CHANGELOG.md

| ID | 位置 | 問題 | 建議 |
|---|---|---|---|
| D-07 | `1.6.55.md:10,75`；`CHANGELOG.md:24`；`docs/desktop/README.md:237` | 「`wi-repair://` 連結…聚焦同一個視窗」。`wi-repair` 只是內部頁面的 scheme，沒有註冊為系統協定（找不到 `setAsDefaultProtocolClient`），使用者無法點這種連結 | 改為「工作列項目、啟動旗標與 Web 的開啟請求」 |
| D-08 | `CHANGELOG.md:24`；`docs/desktop/README.md:238` | 工作列項目寫成「完成設定…」。實際是「完成首次設定…」（`setup-i18n.ts:255`） | 改為實際字串 |
| D-09 | `1.6.55.md:14`；`CHANGELOG.md:19`；`status.md:17` | 「設定完成」卡片。實際標題是「開始使用 Work Intelligence」（`status-view.ts:56-67`），程式碼中沒有「設定完成」這個字串 | 改用實際標題 |
| D-10 | `1.6.55.md:17` | 「CSP、IPC allowlist 與 OperationCoordinator 的 BUSY 規則不變」。前兩者屬實。BUSY 規則本身不變，但部分 handler 原本就不經過它（M-04、L-07） | 不需要改 release note；在契約文件列出例外 |
| D-11 | `CHANGELOG.md:124-128` | `[1.6.51]` 段沒有說明這個版本沒有 tag | 段首加一句「未單獨發布，隨 v1.6.52 發行」 |

### 5.4 docs/desktop/desktop-v1-design-r4.md

| ID | 位置 | 問題 | 建議 |
|---|---|---|---|
| D-12 | :296 | 「短效授權碼、限時桌面會話、防 CSRF 憑證」。沒有實作，做法已改為 App 內確認 | 加註實際做法 |
| D-13 | :345、:490、:745 | 「產物須簽章」「App、DMG 與更新 ZIP 均須簽署與公證」「正式簽章安裝包」。與 ADR-38 矛盾 | 加「依 ADR-38 取代」的註記 |
| D-14 | :151、:349 | 「預設在背景低頻檢查版本…可關閉」。與 ADR-40 矛盾：沒有背景檢查，也沒有開關 | 改為只有手動檢查 |
| D-15 | :521-527 | 只有階段 1、2、3、5 的狀態段；沒有階段 0、4、6，全檔沒有提到 1.6.52 至 1.6.55 | 補狀態段 |
| D-16 | :525 | 「App 設定中心尚未接上 Agent API」。1.6.49 已接上 | 更新 |
| D-17 | :443 | 錯誤碼 `HOOK_UNTRUSTED`、`SERVICE_OWNER_UNKNOWN`、`UPDATE_UNVERIFIED` 在程式碼中找不到 | 標為草案，指向 `packages/desktop-core/src/shell/i18n.ts` |
| D-18 | :70、:463-465、:727 | 「macOS 架構範圍待確認」。兩個架構都已固定建置並發行 | 改為已定案 |
| D-19 | :491 | 「啟動時檢測 App 位置，導引移到 Applications」。沒有實作（DT-29） | 標為未做或已取消 |
| D-20 | :322 | 「工作列『變更連接埠…』」。1.6.55 已移除 | 更新 |
| D-21 | :519 | 「主要取得方式為本機打包」。與 :85「一般使用流程無須開終端機」矛盾，也與實際發行方式不符 | 改為以 Release 安裝檔為主 |
| D-22 | :3 | 標頭「基準 1.6.40；目標 1.6.41」 | 改為「設計基準 d464ea5；最後修訂對應 1.6.55」 |
| D-23 | §9.5 | G-UPD-01 仍以自動更新與簽章為條件 | 依 ADR-25、ADR-38、ADR-40 改寫 |

### 5.5 docs/desktop/desktop-v1-adr.md

| ID | 位置 | 問題 | 建議 |
|---|---|---|---|
| D-24 | ADR-11（:226）、ADR-12（:234） | 狀態「已採用」，但會話與 CSRF 沒有實作 | 加註實際做法 |
| D-25 | ADR-21（:176）、ADR-22（:184） | 「1.6.42 已實作」「已採用」。復原沒有接線（H-01） | 依 H-01 的決定更新 |
| D-26 | ADR-23（:375）、ADR-24（:383） | 狀態「已採用」，但已被 ADR-25、ADR-40 取代 | 標為「已被取代」 |
| D-27 | ADR-02（:30）、ADR-03（:41） | 「待確認」「三平台實跑結果待確認」 | 更新 |
| D-28 | ADR-38（:465） | 「主要取得方式是使用者在自己的電腦上以 `pnpm package:desktop` 打包」。要求使用者下指令，且與實際不符 | 改為開發者選項 |
| D-29 | ADR-27（:349）、ADR-40（:423） | 仍提到工作列的「變更連接埠…」與修復視窗的「更新」卡片 | 補 1.6.55 的註記 |
| D-30 | :3 | 標頭同 D-22 | 同 D-22 |

### 5.6 docs/desktop/desktop-v1-component-contracts.md

| ID | 位置 | 問題 | 建議 |
|---|---|---|---|
| D-31 | C-04（:156-168） | 「恢復時依真實 OS 服務、DB 與 manifest 重建狀態」。沒有接線（H-01） | 依 H-01 的決定更新 |
| D-32 | C-01（:22-24）、C-16（:272-287） | 「使用 electron-updater」「須簽署並公證」「更新與簽章尚未實作」 | 改寫為手動更新檢查 |
| D-33 | C-02（:37） | 「『開啟 Dashboard』永遠是第一項」。不成立 | 改為「常態第一項；被保留或待設定時前面有狀態行」 |
| D-34 | C-11（:53-64） | 只描述修復視窗 | 補六個分頁與 `app:get-tab`、`app:remember-tab`、`app:select-tab` |
| D-35 | C-13（:234） | 5 個欄位名稱在程式碼中找不到 | 列出實際欄位 |
| D-36 | C-12、C-20 | 沒有 1.6.47、1.6.49 的實作註記 | 補上 |

### 5.7 docs/desktop/desktop-v1-risk-gate-ticket-matrix.md

| ID | 位置 | 問題 | 建議 |
|---|---|---|---|
| D-37 | :3、:9 | 標頭同 D-22 | 同 D-22 |
| D-38 | DT-03、DT-05、DT-06、DT-12（:81、:83、:84、:90） | 列內沒有狀態註記，但 §4 寫 T2、T3 已實作；還原驗證記在 DT-32；macOS LaunchAgent 的處理只記在 DT-13 | 四列各補狀態與證據 |
| D-39 | DT-09（:87） | 「1.6.42 已實作」。復原沒有接線 | 改為部分完成 |
| D-40 | DT-21（:99） | 「App 設定中心尚未呼叫」 | 更新為 1.6.49 已接上 |
| D-41 | DT-14（:92）、DT-15、DT-16 | 仍寫工作列「變更連接埠…」；沒有 1.6.55 的註記 | 補註記 |
| D-42 | DT-17（:95）、DT-18（:96） | 會話與 CSRF、跨使用者測試沒有狀態 | 標明未做與實際做法 |
| D-43 | DT-29（:107）、DT-30、DT-31、DT-37（:115） | 沒有狀態 | DT-29、DT-30、DT-37 標為已取消並附 ADR；DT-31 標為部分 |
| D-44 | DT-33（:111）、:168、:173 | 「三平台實跑結果待確認」 | 更新 |
| D-45 | §5（:187-188） | 「macOS Intel（候選，待確認）」「Developer ID 與公證身分未就緒」 | 前者改為已發行；後者改為依 ADR-38 不做，並補手動更新檢查 |
| D-46 | §3 | 1.6.48 串流匯入、1.6.50 同資料庫接管、1.6.53 更新檢查、1.6.55 分頁視窗沒有票號 | 補票號或加一節「無票號的已發行功能」 |

### 5.8 docs/desktop/README.md

| ID | 位置 | 問題 | 建議 |
|---|---|---|---|
| D-47 | :3、:9、:19 | 標頭停在 1.6.40；目標修補版只列到 1.6.49；「狀態：工程實作前設計基線」 | 更新 |
| D-48 | :34、:288、:320-326 | 「ADR-01 至 ADR-39」「ADR-01 至 ADR-35」；修訂紀錄停在 1.6.47 | 改為 ADR-40；補修訂紀錄 |
| D-49 | :356-367 | 「bundled Node 的 `sqlite_version()` 尚未取得」「工具版本尚未鎖定」「已暫存，未提交」。都已解決；同檔 :202 已寫 SQLite 3.54.1 | 刪除或標為已解決 |
| D-50 | :117、:131、:169、:204 | 各版的「尚未做」清單沒有標示已被後版完成（DT-19、DT-24） | 加註，或集中成一張現況表 |
| D-51 | :143、:150 | 「App 尚未呼叫 Agent API」 | 更新 |
| D-52 | :190、:214 | 提到工作列的「變更連接埠…」「設定 Agent…」 | 補 1.6.55 的註記 |
| D-53 | :252-265 | 以 `pnpm package:desktop` 為主要取得方式 | 同 D-28 |
| D-54 | 全檔 | 沒有實機驗收清單；1.6.53 至 1.6.55 三節沒有「非 CI 項目」段落 | 引用本報告 §4，或把 §4 移入 |

### 5.9 範圍外但相關

- `docs/user-guide.md:212` 提到已不存在的工作列項目。這是給使用者看的文件，建議一併修正。
- `docs/release-checklist.md` 沒有任何桌面 App 的項目。R4 §9.1 與 §14.3 要求 Windows 11 的實機驗收紀錄寫在這裡。
