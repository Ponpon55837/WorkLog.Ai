# Work Intelligence 桌面版 V1 設計文件索引（R4）

**狀態：工程實作前設計基線（未通過實機驗收）。** 修訂日期：2026-11-16。

| 項目 | 內容 |
|---|---|
| 文件版本 | R4 |
| 基準 commit | `d464ea5`（main，Merge PR #361，release 1.6.40） |
| 目標修補版 | 1.6.41（T1–T4）、1.6.42（DT-01/02/04/09/10/20/36）、1.6.43（DT-23、DT-25，階段 1）、1.6.44（DT-11、DT-15、DT-16、DT-35，階段 2）、1.6.45（DT-23 的 ACL、DT-24 部分、DT-28 決策、DT-33、DT-34，階段 5 的打包部分）、1.6.47（DT-21、DT-22、DT-27、launcher 接線，階段 3）、1.6.49（DT-01 精靈、App 內 Agent 設定、舊服務偵測，階段 4）；設计基準仍為 `d464ea5` |
| 前一版 | R3（來源提交 `e46060e`，審查基準 `7723b72`） |
| 首發平台 | Windows 11 x64 與 macOS 同批發行；Linux 不在 V1。Windows ARM 排除為推論（待確認）；macOS 架構範圍（Apple Silicon、Intel）待確認；1.6.45 的打包以 arm64 與 x64 分開產出（不做 universal），待產品確認 |

---

## R4 是什麼

R4 是 Work Intelligence 桌面版 V1 的設計基線，在 R3 的基礎上：

1. 更新基準至 `d464ea5`（1.6.40），目標 1.6.41，並重新核對關鍵程式碼。
2. 更正 R3 對 MCP schema 閘的描述：MCP 寫入路徑已有閘門，缺口在 HTTP API 與長駐 CLI 寫入端。
3. 首發平台改為 **Windows 11 x64 與 macOS 同批發行**（產品決策），Windows 相關需求（檔案鎖、schtasks、NSIS、`IFileOpenDialog`）進入首發範圍。
4. 補入 SQLite 版本的量測與 CI 檢查，以及 Host:port 比對的規則。
5. 把 R3 的風險表、工程拆票與決策拆到獨立文件，並讓 34 項風險都有對應的工程票或排除理由。

**R4 不是**功能完成的證明。所有門檻都是待驗證的要求；實作、CI、實機與安全測試的結果不由本文件推論。

---

## 檔案

| 檔案 | 用途 | 主要讀者 |
|---|---|---|
| [desktop-v1-design-r4.md](desktop-v1-design-r4.md) | **R4 主文件**：執行摘要、使用者體驗、安裝與設定、服務交接、架構、更新與資料保護、平台需求、契約草案、開源借鑑、封版檢核。由 R3 改名（`git mv`）並修訂而來。 | 產品、實作、安全、發行 |
| [desktop-v1-adr.md](desktop-v1-adr.md) | **決策紀錄**（ADR-01 至 ADR-39）：每筆含脈絡、決策、後果與狀態。涵蓋 R3 所有決策並更新 R4 的變更。 | 架構、審查 |
| [desktop-v1-component-contracts.md](desktop-v1-component-contracts.md) | **元件契約**（C-01 至 C-22、C-T）：每個元件的責任、輸入輸出、不變條件與平台特定要求。 | 實作、測試 |
| [desktop-v1-risk-gate-ticket-matrix.md](desktop-v1-risk-gate-ticket-matrix.md) | **風險・Gate・工程票對應**：R01–R34 全表、Gate 反向索引、工程票索引（DT-01 至 DT-37）、1.6.41 任務對應、V1 不做清單。 | 排程、追蹤、發行 |
| 本檔（README.md） | 索引、證據標籤、修訂紀錄、去重紀錄。 | 所有人 |

**閱讀順序**：摘要（R4 主文件的執行摘要）→ 風險矩陣 → 決策紀錄 → 元件契約。

---

## 證據標籤

R3 的標籤在 R4 中保留，意義不變：

| 標籤 | 意義 | 使用方式 |
|---|---|---|
| `[R]` | 已從目前 repo 確認 | 附上程式碼或文件路徑，R4 以 `d464ea5` 核對 |
| `[U]` | 外部官方文件或 GitHub 原始碼可直接支持 | 附連結 |
| `[D]` | 本規劃提出的設計決策 | 須經審查，可被取代 |
| `[T]` | 須以原型、CI 或實機確認的假設 | 驗證前不得當作事實 |

R4 的補充用法：

- `[T]` 也用於**僅在開發機量測、尚未進入發行產物**的數值（例如本機 Node 22.23.4 → SQLite 3.53.4，見 R4 §7.3.1）。
- **「1.6.41 已實作（commit …）」**：標示 1.6.41 任務（T1–T4）已提交到分支的內容，並附 commit 與實際結果。實機驗收仍為「待實機驗收」，本文件不宣稱實機已通過。

---

## 1.6.41 任務與本文件的關係

| 任務 | 內容 | 本文件位置 |
|---|---|---|
| T1 | Windows 資料夾選擇改為 `IFileOpenDialog`。**1.6.41 已實作（commit 1257d3a）**；實機待實機驗收 | R4 §9.1；C-17；ADR-31；DT-26 |
| T2 | 寫入交易的 schema 閘（含 HTTP API），錯誤碼 `server_restart_required`（HTTP 503）。**1.6.41 已實作（commit 3ff1e45）** | R4 §7.3；C-07；ADR-18；DT-03 |
| T3 | `sqlite_version()` 報告與 release 檢查。**1.6.41 已實作（commit 4420951）** | R4 §7.3.1；C-21；ADR-19；DT-06 |
| T4 | 管理 API 的 Host 比對含 port。**1.6.41 已實作（commit dadaae4）** | R4 §5.2；C-10；ADR-11；DT-17 |

---

## 1.6.42 任務（階段 0：契約與測試基座）與本文件的關係

本版實作階段 0 的 CI 可驗證部分，程式位於 `packages/desktop-core` 與相關測試。以下各項的實機驗收仍為**待實機驗收**，本文件不宣稱實機已通過。

| 任務 | 內容 | 狀態 | 本文件位置 | 證據路徑 |
|---|---|---|---|---|
| DT-01 | DB 來源解析（唯讀候選、狀態分類、依檔案身分分組、衝突策略）；DB 身分策略定案 | 1.6.42 已實作（CI 可驗證部分）；實機待實機驗收 | §3.1；C-05；ADR-06、ADR-36 | `packages/desktop-core/src/db-source/`；`packages/shared/src/file-identity.ts`；`tests/desktop-core/db-source.test.ts`、`tests/desktop-core/identity-compare.test.ts`、`tests/shared/file-identity.test.ts` |
| DT-02 | 唯讀 preflight 與提交前重驗（含 sidecar 副作用測試） | 1.6.42 已實作（CI 可驗證部分）；實機待實機驗收 | §3.1.1；C-06；ADR-07、ADR-08 | `apps/server/src/database-preflight.ts`、`apps/server/src/start-api.ts`；`tests/server/database-preflight.test.ts`、`tests/server/start-api-injected.test.ts` |
| DT-04 | 舊寫入端與長任務屏障的程序組合實驗（方案 1、2、3） | 1.6.42 已實作（CI 可驗證部分）；實機待實機驗收 | §10.4；ADR-17 | `tests/server/old-writer-barrier.test.ts`；`tests/helpers/old-writer-barrier*.ts` |
| DT-09 | ServiceOwner 狀態機與 operation journal | 1.6.42 已實作（CI 可驗證部分）；實機待實機驗收 | §4.1；C-04；ADR-22 | `packages/desktop-core/src/operations/`；`tests/desktop-core/operations-state.test.ts`、`tests/desktop-core/operations-journal.test.ts`、`tests/desktop-core/operations-recovery.test.ts` |
| DT-10 | `OperationCoordinator`（單一鎖、operationId、BUSY、重送） | 1.6.42 已實作（CI 可驗證部分）；實機待實機驗收 | §6.1；C-04；ADR-21 | `packages/desktop-core/src/operations/coordinator.ts`；`tests/desktop-core/operations-coordinator.test.ts` |
| DT-20 | 設定檔原子寫入與 fail-closed 讀取 | 1.6.42 已實作（CI 可驗證部分）；實機待實機驗收 | §5.3；C-03；ADR-20 | `packages/desktop-core/src/settings/`；`tests/desktop-core/settings.test.ts` |
| DT-36 | 測試隔離：`tests/helpers/isolated-environment.ts` 作為所有 Vitest 設定的 setupFiles，不觸碰真實家目錄與 3210 | 1.6.42 已實作（CI 可驗證部分）；實機待實機驗收（Windows 11、macOS 實機環境清單尚未完成） | R4 §13；C-T | `tests/helpers/isolated-environment.ts`；`tests/shared/test-isolation.test.ts`；`vitest.config.ts` |
| 效能（1.6.41 遺留項，非 DT 票） | 備份與匯出 worker 使用精簡入口，首次匯出中位數 188.5 ms 降為 64–80 ms（15 次）；匯出輸出位元組不變 | 1.6.42 已實作（CI 可驗證部分）；數字為單機量測，`test:performance` 3 次通過，門檻未調整 | 無（不屬於桌面設計文件） | `packages/storage/src/backup-export.ts`；`packages/storage/package.json`（`./backup-export` 匯出）；`packages/storage/bench/worker-cold-start.bench.mjs`；`packages/core/src/project-data-columns.ts`（匯出欄位單一來源）、`tests/core/project-data-columns.test.ts` |

**本版的非 CI 項目**：DT-04 的程序組合 4（Codex plugin、Claude Code plugin、MCPB、手動 stdio 設定）、Windows 檔案 ID 與 sidecar 行為，以及 DT-36 的實機環境清單，皆待實機驗收。

---

## 1.6.43 任務（階段 1：runtime spike）與本文件的關係

本版實作階段 1 的 CI 可驗證部分。Windows 的量測與所有實機驗收仍為**待實機驗收**，本文件不宣稱實機已通過。

| 任務 | 內容 | 狀態 | 本文件位置 | 證據路徑 |
|---|---|---|---|---|
| DT-25 | 無 Node 封裝 spike：官方 Node.js 與 Electron（`ELECTRON_RUN_AS_NODE`）的建置，離線煙霧測試（serve、DB 寫入、FTS5、備份、MCP stdio、hook、竄改拒絕），以及大小、冷啟動與閒置記憶體量測 | 1.6.43 已實作（CI 可驗證部分）；三平台量測完成（CI run 43864453651，6 個 job 全過）；階段 1 gate 未通過 | §9.4；§3.3；ADR-04 | `scripts/desktop-runtime-spike/*.mjs`；`.github/workflows/desktop-runtime-spike.yml`；量測 JSON 由 CI 上傳為 `runtime-spike-*` artifact |
| DT-23 | 固定 launcher 與版本化 runtime manifest（v1）：`bin/` 下的 shim、`current` 指標、`runtimes/<id>/`、全檔案 SHA-256 核對、symlink 與權限檢查、錯誤碼 | 1.6.43 已實作（CI 可驗證部分）；Windows ACL 為 `not-implemented`；Agent 設定尚未指向 launcher；實機待實機驗收 | §3.3；§10.2；ADR-15 | `packages/desktop-core/src/runtime/*.ts`；`tests/desktop-core/runtime-install.test.ts`、`runtime-launcher.test.ts`、`runtime-manifest.test.ts`、`runtime-verify.test.ts` |

選定的 runtime 為隨包官方 Node.js（ADR-04），理由與量測數字見該 ADR。

**本版的非 CI 項目**：Windows 11 與 macOS 實機煙霧測試、Windows ACL 檢查、Windows 的 `.cmd` 與 `%*`／`!` 行為、NTFS 變更時間與 stat 快取的強度、DT-24 runtime 清理（未實作）、plugin／standalone／MCPB 接線（未做），以及官方 Node.js 發行簽章（GPG）的驗證。

---

## 1.6.44 任務（階段 2：安全最小桌面）與本文件的關係

本版實作階段 2 的 CI 可驗證部分。Windows 11 與 macOS 的實機驗收仍為**待實機驗收**；三平台 desktop-smoke 已在 CI 通過（[run 43929965453](https://github.com/Ponpon55837/WorkLog.Ai/actions/runs/43929965453)）。本文件不宣稱實機已通過。

| 任務 | 內容 | 狀態 | 本文件位置 | 證據路徑 |
|---|---|---|---|---|
| DT-11 | 後端子程序 lifecycle：`start --desktop-ipc` 子程序、env allowlist 與固定 PATH、runId 只經私有 IPC、HMAC 實例證明、停止順序（IPC shutdown → POSIX SIGTERM → kill → 確認 port 釋放） | 1.6.44 已實作（CI 可驗證部分）；實機待實機驗收 | §5.1；§10.3；C-08；ADR-08 | `packages/desktop-core/src/backend/*.ts`；`apps/server/src/desktop-child.ts`；`packages/schema/src/desktop-child-protocol.ts`；`packages/shared/src/instance-proof.ts`；`tests/desktop-core/backend-supervisor.test.ts`、`backend-environment.test.ts`、`backend-managed-service.test.ts`；`tests/server/desktop-child.test.ts`、`desktop-child-process.test.ts`；`tests/shared/instance-proof.test.ts` |
| DT-15 | 單例、tray／選單列、登入項（預設關閉、需同意）、`--background` 與 `wasOpenedAtLogin` 的靜默背景啟動 | 1.6.44 已實作（CI 可驗證部分）；實機待實機驗收 | ADR-26；C-01；C-02 | `apps/desktop/src/main/index.ts`、`second-instance.ts`、`tray.ts`、`settings.ts`；`packages/desktop-core/src/shell/launch-mode.ts`、`login-item.ts`、`tray-menu.ts`；`tests/desktop-core/shell-basics.test.ts`；`apps/desktop/tests/desktop-smoke/desktop.spec.ts` |
| DT-16 | 修復視窗：固定 scheme、sandbox、最小 preload、IPC sender 與 zod 驗證、拒絕導覽與權限、CSP | 1.6.44 已實作（CI 可驗證部分）；實機待實機驗收 | ADR-13；C-11 | `apps/desktop/src/main/repair-window.ts`、`security.ts`、`ipc.ts`；`apps/desktop/src/preload/repair.ts`；`apps/desktop/src/renderer/repair/`；`packages/desktop-core/src/shell/navigation-policy.ts`、`repair-ipc.ts`；`tests/desktop-core/shell-policy.test.ts`；`apps/desktop/tests/desktop-smoke/desktop.spec.ts` |
| DT-35 | 退出語意：退出確認與 tray 文字寫明不會每日備份；顯示最後成功備份時間；退出流程 | 1.6.44 已實作（CI 可驗證部分）；實機待實機驗收 | ADR-26；C-02；§8.2 | `apps/desktop/src/main/quit.ts`；`packages/desktop-core/src/shell/quit-flow.ts`、`quit-notice.ts`、`last-backup.ts`；`tests/desktop-core/shell-flows.test.ts`、`shell-basics.test.ts`、`shell-policy.test.ts` |

**本版的非 CI 項目**：Windows 11 與 macOS 的實機煙霧測試（Windows 登入項 `--background`、單例、tray、8.3 短名、`TerminateProcess`；macOS 的 `wasOpenedAtLogin`、`mainAppService`、Dock、選單列、Gatekeeper 與簽章），以及 Windows 與 macOS 的 CI 首次實跑。尚未做：簽章、公證、安裝包、自動更新、DT-01 完整的來源偵測精靈、DT-19 完整診斷、DT-24 runtime 清理，以及 plugin／standalone／MCPB 接線到 launcher。

## 1.6.45 任務（階段 5：打包）與本文件的關係

本版實作階段 5 的打包部分；§9.4 表中階段 5 的「自動更新與 schema」未做。Windows 11 與 macOS 的實機驗收仍為**待實機驗收**；三平台的打包 CI 結果於發行前確認。本文件不宣稱實機或 CI 已通過。

| 任務 | 內容 | 狀態 | 本文件位置 | 證據路徑 |
|---|---|---|---|---|
| DT-23 | Windows ACL 檢查由 `not-implemented` 改為實作：SDDL 分兩層讀取（.NET 優先，失敗才用 `Get-Acl` 加 `whoami /user`），依 SID 判斷擁有者（目前使用者、SYSTEM、Administrators 或 TrustedInstaller）與可寫 ACE，固定 SID 的 SDDL 別名先展開，失敗封閉；第一層以結束碼 3 回報 Constrained Language Mode；逾時第一層 20 秒、第二層 60 秒、逾時重試一次；只在安裝、切換、完整驗證或 root 相關時間戳改變時讀取 | 1.6.45 已實作（fixture 驗證）；真實 Windows 行為待 CI 或實機 | §3.3；ADR-15 | `packages/desktop-core/src/runtime/windows-acl.ts`；`tests/desktop-core/runtime-windows-acl.test.ts` |
| DT-24 | 舊 runtime 背景清理：只保留目前與前一版；尚未證明「無現役連線」 | 1.6.45 部分實作；DT-24 未完成 | ADR-16；§3.3 | `packages/desktop-core/src/runtime/runtime-gc.ts` |
| DT-28 | 更新來源版本鎖定與 metadata 驗證：選擇 v26，不做自動更新，改為手動下載經平台驗證的安裝包 | 決策已記錄（ADR-25）；v26 的 metadata 簽章驗證未實作，因此 DT-28 的篡改測試不適用 | §7.1；ADR-25 | `apps/desktop/package.json`（electron-builder 26.18.1）；`apps/desktop/electron-builder.config.mjs` |
| DT-33 | 同批產物暫存與聯合發行閘：`desktop-package` 三平台成功才允許 release 公開 | 1.6.45 已接線（`release.yml` 呼叫、發行須等待成功）；三平台實跑結果待確認 | ADR-03；§9.4 | `.github/workflows/desktop-package.yml`；`.github/workflows/release.yml` |
| DT-34 | NSIS 解除安裝只移除程式檔，保留設定、資料庫與備份；安裝與解除安裝前以 `--quit` 退出 App | NSIS 設定與文件已實作；實機待驗收；macOS 拖入垃圾桶的清理入口未做 | ADR-30；§8.2；§9.1 | `apps/desktop/electron-builder.config.mjs`；`apps/desktop/build/`；`apps/desktop/tests/packaged-smoke/` |

**本版的非 CI 項目**：Windows 11 的安裝、靜默安裝與 `/D=` 路徑、執行中重裝、靜默解除安裝與資料保留、Defender 更名重試的實際行為；macOS 的 DMG 掛載、`spctl` 結果（只記錄）與 Gatekeeper 提示（ad-hoc 簽章，須於系統設定中強制打開）；Windows ACL 的真實行為；打包與啟動效能在 Windows 與 macOS 的數字（`desktop-perf-<os>` 與 `package-<platform>-<arch>.json` artifact）。尚未做：簽章、公證、自動更新、DT-01 完整的來源偵測精靈、DT-19 完整診斷、DT-24 完整清理、macOS 移除桌面整合入口，以及 plugin／standalone／MCPB 接線到 launcher。

**macOS 簽章與首次啟動**：Electron 翻轉 fuse 後原簽章失效，而 electron-builder 在 GitHub `pull_request` 執行時會略過所有簽章，所以 `electron-builder.config.mjs` 設 `mac.identity: null`，改由 `afterPack` hook（`apps/desktop/scripts/after-pack.mjs`）在 PR 與 release 建置走同一條路徑：先翻轉 fuse，再由 `mac-ad-hoc-sign.mjs` 以 ad-hoc 由內而外簽署整個 .app（`runtime-bundle` 不動，官方 Node 保有自己的簽章）。尚無 Developer ID，不做公證；在 macOS 15 上，帶隔離屬性的 ad-hoc App 須於「系統設定 → 隱私權與安全性」按「強制打開」（Open Anyway）才能首次開啟，右鍵 → 打開已不能繞過 Gatekeeper。`package.mjs` 以 `codesign --verify --deep --strict`（含解壓後的 zip）、內附 Node 的 `codesign --verify --strict` 與 fuse 回讀作為硬性閘；`spctl` 只記錄結果。

**Windows ACL 與打包補充（1.6.45）**：Windows ACL 第二層（`Get-Acl`，供 Constrained Language Mode 使用）以絕對路徑匯入 `Microsoft.PowerShell.Security`，並與 `whoami` 一同執行；兩層腳本都關閉進度輸出與模組自動載入。逾時為第一層 20 秒、第二層 60 秒、`whoami` 15 秒，逾時重試一次；CI 量到第一層約 0.4 秒、第二層一般約 6 秒，逾時待實際數據後收緊。失敗訊息每層一段，含結束碼、訊號或逾時、耗時與去除 CLIXML 的 stderr。Windows CI 另在真實 Constrained Language Mode 下執行 ACL 測試。打包 smoke 除非測的是互動行為，一律以 `--background` 啟動，因為互動啟動會依 ADR-01 以外部瀏覽器開 Dashboard；App 會記錄 `[shell] dashboard opened`。沙盒清理會先等待並結束仍在使用沙盒的程序，刪不掉時列出佔用者；打包記憶體只計 App 自己的程序。`commitCurrent` 可重用同一行程中剛執行之 `installRuntime` 的 ACL 讀取（`reuseAclStamp`，只存在記憶體中，不從 `.verified.json` 讀取）；只有在所有受涵蓋物件的變更時間、inode 與物件集合都相同，且沒有檔案漏掉雜湊快取時才重用，否則重新讀取，佈建日誌以 `acl-reads=N` 顯示次數。打包方面，每次 `build()` 使用新的 electron-builder 設定（electron-builder 會原地正規化 `files`）；`beforeBuild` 回傳 false 以跳過約 7 秒的 node_modules 搜尋，因為暫存的 App 沒有 node_modules。`afterPack` 與 `package.mjs` 會輸出 `[afterPack]` 與 `[package]` 行，記錄 fuses、ad-hoc 簽章的路徑數、codesign、`spctl` 結束碼等。PR 建置時 electron-builder 出現「code signing will be skipped」是預期的，簽章由 `afterPack` 完成。

## 1.6.47 任務（階段 3：Agent 整合）與本文件的關係

本版實作階段 3 的 CI 可驗證部分。Windows 11 與 macOS 的實機驗收仍為**待實機驗收**；CI 結果見 PR [#369](https://github.com/Ponpon55837/WorkLog.Ai/pull/369) 合併前最後一個 head 的 CI：[Desktop package](https://github.com/Ponpon55837/WorkLog.Ai/actions/runs/44038144921)、[Desktop smoke](https://github.com/Ponpon55837/WorkLog.Ai/actions/runs/44038145033)、[Desktop runtime spike](https://github.com/Ponpon55837/WorkLog.Ai/actions/runs/44038144908)、[CI](https://github.com/Ponpon55837/WorkLog.Ai/actions/runs/44038144926)（20 項全部通過；合併後 main 的 [CI](https://github.com/Ponpon55837/WorkLog.Ai/actions/runs/44039318088) 也通過）。階段 3 的 gate（host 真正 handshake、hook fail-open、更新後 runtime 不失效）尚未通過，本文件不宣稱實機或 gate 已通過。

| 任務 | 內容 | 狀態 | 本文件位置 | 證據路徑 |
|---|---|---|---|---|
| DT-21 | Agent plan／apply／verify／compensate 共用 API：每檔指紋、寫入前後重驗、持久化操作日誌與補償、launcher 目標、註冊來源偵測與重複標示 | 1.6.47 已實作（CI 可驗證部分）；App 設定中心尚未呼叫此 API；實機待實機驗收 | §3.2；ADR-14；R15、R16、R17 | `packages/agent-setup/src/`；`apps/server/src/agent-setup.ts`；`tests/agent-setup/*.test.ts`；`tests/server/agent-setup-golden.test.ts`（9abe75a、112f343） |
| DT-22 | Agent 狀態分級與 host handshake：MCP stdio 探測、契約指紋、host 首次 `initialize` 的觀察紀錄（fail-open） | 1.6.47 已實作（CI 可驗證部分）；真實 host（Claude Code、Codex、Claude Desktop）的 handshake 待實機驗收 | §3.2.1；ADR-34；R28 | `packages/desktop-core/src/agents/`；`packages/shared/src/mcp-contract-fingerprint.ts`；`apps/mcp/src/agent-observation.ts`；`tests/desktop-core/agents-handshake.test.ts`、`agents-status.test.ts`；`tests/shared/mcp-contract-fingerprint.test.ts`；`tests/mcp/agent-observation.test.ts`（e9f2ef6） |
| DT-23 後續（launcher 接線） | plugin `launch.mjs`、MCPB、獨立版優先使用固定 shim；`desktop-integration.json` 紀錄；hook 經 shim 靜默、25 秒上限、一律 exit 0；`setup:agents` launcher 目標與 Windows 路徑規則 | 1.6.47 已實作（CI 可驗證部分）；plugin manifest 仍以 `node launch.mjs` 啟動；信任模型見 ADR-39；實機待實機驗收 | §3.3；ADR-15、ADR-39；R07、R13 | `packages/desktop-core/src/integration/`；`apps/desktop/src/main/integration-record.ts`；`plugins/work-intelligence/scripts/launch.mjs`、`desktop-integration.mjs`；`scripts/mcpb-launch.mjs`；`tests/desktop-core/integration-record.test.ts`、`shell-launch-command.test.ts`、`runtime-update-session.test.ts`；`apps/desktop/tests/packaged-smoke/launcher.spec.ts`（496e1e7、d63d680） |
| DT-27 | Dashboard bridge：`launch.mjs dashboard` 轉交 App，不啟動 checkout server；App 首次開啟與第二實例轉交，合併為一次開啟 | 1.6.47 已實作（CI 可驗證部分）；換 port 與 App 離線的實機情境待實機驗收 | §6.2；ADR-28；R19（次要） | `scripts/dashboard.mjs`；`plugins/work-intelligence/scripts/desktop-integration.mjs`；`apps/desktop/src/main/second-instance.ts`；`apps/desktop/tests/desktop-smoke/dashboard-handoff.spec.ts`（496e1e7、d63d680） |
| backlog a：Windows ACL 預熱 | 首次安裝時 tier-1 ACL reader 與 runtime 複製並行；失敗退回一次性 reader；快路徑不預熱 | 1.6.47 已實作（fixture 與 Linux 模型）；真實 Windows 數字待 CI | §3.3；ADR-15 | `apps/desktop/src/main/runtime-provision.ts`；`packages/desktop-core/src/runtime/bundled-install.ts`、`windows-acl.ts`；`tests/desktop-core/runtime-install-prewarm.test.ts`、`runtime-windows-acl-prewarm.test.ts`（c3d512b） |
| backlog b：後端閒置 RSS | 匯出唯讀連線的 SQLite page cache 由 16 MB 改為 1 MB；重度操作後 worker 保留時間由 5 秒改為 1 秒。Linux 3 次中位數：匯出後閒置 122 → 92 MiB（基準 85），匯出／匯入後 3 秒 237–280 → 121–130 MiB；匯入後閒置未改善（約高 30 MiB） | 1.6.47 已實作（Linux 量測）；Windows 與 macOS 待量測 | 無（不屬於桌面設計文件） | `packages/storage/src/backup-export-store.ts`、`database-initialization.ts`；`apps/server/src/backup-worker-client.ts`；`packages/storage/bench/export-import-memory.bench.mjs`；`tests/storage/backup-export-store.test.ts` |

**本版的非 CI 項目**：Windows 11 與 macOS 的實機 host handshake（Claude Code、Codex、Claude Desktop 的 clientInfo 與狀態顯示；`claude-ai` 未驗證）；Claude Desktop MCPB 偵測（依檔案配置推測）；Windows ACL 預熱的真實時間與 PowerShell 5.1 的 stdin 行為；Windows 的 `.cmd` 與 hook 的 `taskkill /T` 程序樹終止；`desktop-integration.json` 與 launcher 接線在真實 Agent 中的行為；Dashboard 在 Windows 與 macOS 的冷熱啟動數字；backlog b 的記憶體數字。尚未做：App 設定中心接上 DT-21 的 API、plugin manifest 改為啟動固定 launcher，以及 DT-24 的「無現役連線」證明。

---

## 修復成功回饋（階段 3 之後的小改）

使用者在修復視窗按「重試啟動」或「選擇資料庫 → 確認」且後端成功執行（owner 為 MANAGED）時：清除過期錯誤、修復視窗顯示「✓ 已恢復」卡片（脫敏的資料庫路徑與專案數；專案數由後端 `ready` 訊息的選填欄位 `projectCount` 帶來，查詢失敗就省略）、送出系統通知「Work Intelligence 已可使用」（fail-open：不支援或失敗就略過），約 1.5 秒後關閉修復視窗並只開啟一次 Dashboard（與待處理的 `--open-dashboard` 去重）。失敗時視窗保持開啟，只顯示目前的錯誤。只有修復視窗的使用者動作會觸發；`--background` 登入啟動、自動重試與一般啟動都不會。判斷邏輯在 `packages/desktop-core/src/shell/repair-success.ts`，測試在 `tests/desktop-core/shell-repair-success.test.ts` 與 `apps/desktop/tests/desktop-smoke/desktop.spec.ts`。macOS ad-hoc 簽署的 App 可能不顯示系統通知，視窗卡片與 Dashboard 才是主要提示。

## 1.6.49 任務（階段 4 第二部分：首次執行與 App 內 Agent 設定）與本文件的關係

本版實作階段 4 第二部分的 CI 可驗證部分。Windows 11 與 macOS 的實機驗收仍為**待實機驗收**。PR #371 的 20 項 CI 檢查全部通過。

| 任務 | 內容 | 狀態 | 本文件位置 | 證據路徑 |
|---|---|---|---|---|
| DT-01（精靈） | 首次執行頁：只在沒有設定檔時顯示；「使用預設設定開始」在第一次繪製就可按；唯讀偵測既有來源並各預覽一次；成功啟動後才寫入設定；預設啟動會建立新的空資料庫，啟動失敗時刪除（ADR-27）；升級安裝不顯示 | 1.6.49 已實作（CI 可驗證部分）；實機待實機驗收 | §3.1；R4 §5 全新安裝流程；ADR-06、ADR-27 | `apps/desktop/src/main/first-run.ts`；`packages/desktop-core/src/shell/setup-state.ts`；`apps/server/src/database-create.ts`；`apps/desktop/tests/desktop-smoke/first-run.spec.ts`；`tests/desktop-core/shell-setup-state.test.ts`、`created-database.test.ts`；`tests/server/database-create.test.ts` |
| DT-21 後續（App 內 Agent 設定） | App 視窗的 Agent 頁、工作列「設定 Agent…」與 `--open-agent-setup`：預覽差異、只套用預覽過的計畫、測試連線、依日誌復原；「改由桌面 App 管理…」接管 checkout 的設定；Web 狀態頁按鈕只請 App 開啟頁面 | 1.6.49 已實作（CI 可驗證部分）；真實 Codex 與 Claude Code 設定待實機驗收 | §3.2；ADR-14、ADR-34 | `apps/desktop/src/main/agents.ts`；`packages/agent-setup/src/adopt.ts`、`diff.ts`；`apps/server/src/routes/desktop.ts`；`apps/desktop/tests/desktop-smoke/agents.spec.ts`；`tests/agent-setup/*.test.ts`；`tests/desktop-core/shell-agent-setup.test.ts` |
| Q1（launcher 交給 Agent 的資料庫） | 沒有 `WORK_INTELLIGENCE_DB` 時，MCP 與 hook 使用 App 設定的資料庫；設定無效時退回獨立版規則；每次 hook 的額外成本中位數 0.44 ms（Linux，預算 5 ms） | 1.6.49 已實作；Windows 與 macOS 數字由 CI 印出 | §3.3；ADR-39 | `packages/desktop-core/src/runtime/desktop-database.ts`；`tests/desktop-core/desktop-database.test.ts` |
| 舊的登入服務 | 唯讀偵測 `pnpm bootstrap` 的服務；首次執行頁、修復視窗與 Web 狀態頁顯示警告與移除指令；同一資料庫須按「仍要啟動」（`LEGACY_SERVICE_ACTIVE`，不自動重試）；連接埠被它占用時直接指出 | 1.6.49 已實作（CI 可驗證部分）；一鍵停用見下方 1.6.50；真實 LaunchAgent 與工作排程器待實機驗收 | §8；R4 §5 升級流程 | `packages/desktop-core/src/legacy-service/`；`apps/desktop/src/main/legacy.ts`；`tests/desktop-core/legacy-service.test.ts`；`apps/desktop/tests/desktop-smoke/first-run.spec.ts` |

**本版的非 CI 項目**：Windows 11 與 macOS 實機上的首次執行頁、Agent 頁的套用、測試連線與復原（真實的 Agent 設定）、舊服務偵測（真實的 LaunchAgent 與工作排程器）。尚未做：DT-19 完整診斷、DT-24 完整清理、簽章與公證、自動更新。

## 1.6.50 任務（階段 4：舊服務停用與 Agent 接管收尾）與本文件的關係

本版實作下列項目的 CI 可驗證部分；Windows 11 與 macOS 的實機驗收仍為**待實機驗收**。CI 結果待 PR 檢查完成後補上。

| 任務 | 內容 | 狀態 | 本文件位置 | 證據路徑 |
|---|---|---|---|---|
| 舊的登入服務：一鍵停用 | 「停用舊的登入服務…」只用於辨識得出的定義：唯讀預覽（指令只在「詳細步驟」）、匯入或備份中的提醒、系統對話框確認（預設「取消」）；動手前重新偵測並比對內容雜湊、checkout 與連接埠；步驟與 `pnpm service:uninstall` 相同，另以 `launchctl print`／`systemctl --user is-enabled` 確認已卸載或停用；先證明停下才移除；操作日誌類型 `legacy-disable`；App 資料庫先做唯讀 `quick_check`，只有檢查本身不通過才記錄 `DB_INTEGRITY_CHECK_FAILED` 並進修復流程，沒能完成時不當成損壞、也不提供「立即啟動」；只在手動開啟、後端未執行時提供「立即啟動」 | 1.6.50 已實作（CI 可驗證部分）；真實 LaunchAgent 與工作排程器待實機驗收 | §8；R4 §5 升級流程；G-SVC-01 | `packages/desktop-core/src/legacy-service/disable.ts`；`apps/desktop/src/main/legacy-disable.ts`；`apps/desktop/src/renderer/repair/legacy-disable-view.ts`；`tests/desktop-core/legacy-service-disable.test.ts`；`tests/desktop-core/legacy-disable-controller.test.ts`；`apps/desktop/tests/desktop-smoke/first-run.spec.ts` |
| DT-13 | Windows：只結束命令列含這個 checkout `scripts\service-runner.mjs` 的 `node.exe` 程序樹（`schtasks /End` 後 `taskkill /T`）；依父程序編號找出子孫程序，只等待不單獨結束；等連接埠釋放與整棵樹結束（有上限）後才 `schtasks /Delete` | 1.6.50 已實作（模擬程序清單的單元測試）；真實 Windows 程序樹待 CI 或實機驗收 | §4；ADR 的服務擁有權；R05 | `packages/desktop-core/src/legacy-service/disable.ts`（`legacyRunnerTrees`、`matchesLegacyRunner`）；`tests/desktop-core/legacy-service-disable.test.ts` |
| 預覽的 `quick_check` | 桌面子程序預檢的選填 `quickCheck: true`：同一個唯讀連線上的 `PRAGMA quick_check`，不通過為 `unreadable`（固定訊息） | 1.6.50 已實作 | §3.1 | `apps/server/src/database-preflight.ts`、`desktop-child.ts`；`packages/schema/src/desktop-child-protocol.ts`；`tests/server/database-preflight.test.ts`、`desktop-child.test.ts` |
| 接管只限同一份資料庫 | 「改由桌面 App 管理」以 Agent 為單位，只接管資料庫與 App 相同（檔案身分比對）的 checkout 項目，同一個 Agent 有任何項目用其他資料庫時整個 Agent 都不接管；其他資料庫不接管也不改寫，卡片提供「改用這份資料庫」，在修復視窗預覽後由使用者確認 | 1.6.50 已實作（CI 可驗證部分） | §3.2；ADR-39 | `packages/agent-setup/src/adopt.ts`；`apps/desktop/src/main/agents.ts`；`tests/agent-setup/adopt.test.ts`；`apps/desktop/tests/desktop-smoke/agents.spec.ts` |

**本版的非 CI 項目**：Windows 11 與 macOS 實機上的停用流程（真實的 LaunchAgent、工作排程器與 runner 程序樹）、停用後的資料庫檢查與「改用這份資料庫」。

## 1.6.51 任務（連接埠變更與檔案系統風險政策）與本文件的關係

本版實作下列項目的 CI 可驗證部分；Windows 11 與 macOS 的實機驗收仍為**待實機驗收**。CI 20/20 通過（PR #373，a4b212c）。

| 任務 | 內容 | 狀態 | 本文件位置 | 證據路徑 |
|---|---|---|---|---|
| DT-14（連接埠變更） | 只在 App 內變更：修復視窗的「連接埠」區段與工作列「變更連接埠…」；Web 只請 App 開啟該區段（白名單偏好與路由在記憶體中一次使用，最久 2 分鐘）；拒絕 1024 以下、瀏覽器限制與被占用的連接埠；`PORT_NOT_PERMITTED` 與 `PORT_OCCUPIED_BY_OTHER` 分開；忙碌時拒絕；先停止、在新 port 啟動、以 IPC 與 HTTP 證明驗證，通過後才原子寫入 `desired.port`、`active` 與 `lastKnownGood`；失敗回舊 port；新位址以一次性 fragment 還原偏好與路由 | 1.6.51 已實作（CI 可驗證部分）；Windows 與 macOS 的實際 bind 與 Dashboard 新位址待實機驗收 | §3.1.1、§6、§6.2；ADR-27；C-22 | `apps/desktop/src/main/change-port.ts`；`apps/desktop/src/renderer/repair/port-view.ts`；`packages/desktop-core/src/shell/port-policy.ts`、`port-handoff-store.ts`、`port-i18n.ts`；`packages/schema/src/port-handoff.ts`；`apps/server/src/routes/desktop.ts`；`apps/web/src/utils/port-handoff.ts`；`tests/desktop-core/port-policy.test.ts`、`change-port-controller.test.ts`；`tests/schema/port-handoff.test.ts`；`tests/web/utils/port-handoff.test.ts`；`apps/desktop/tests/desktop-smoke/change-port.spec.ts` |
| DT-08（檔案系統風險政策） | 啟動與選擇資料庫時分類 none、網路、可移除、雲端同步、硬連結與 unknown（Windows 以 DriveInfo、macOS 以 mount 與 diskutil、Linux 以 `/proc/mounts`；有時限，失敗不快取）；網路磁碟拒絕作為 App 資料庫並進修復（`DB_STORAGE_NETWORK`）；UNC 仍拒絕；可移除、雲端同步與硬連結只能勾選同意後選擇，且不做 schema 更新；unknown 只阻擋一鍵選擇；「複製到本機磁碟並改用」以 `VACUUM INTO`、`quick_check` 與不覆寫的檔名完成，原檔不變 | 1.6.51 已實作（CI 可驗證部分）；真實磁碟與雲端根目錄的判定待實機驗收 | §3.1.1、§5.1；C-05；ADR-07；R22 | `apps/desktop/src/main/storage-risk.ts`、`local-copy.ts`；`packages/desktop-core/src/db-source/storage-policy.ts`、`storage-risk-node.ts`、`storage-risk-override.ts`；`packages/desktop-core/src/shell/copy-to-local.ts`、`storage-risk-view.ts`、`storage-start-policy.ts`；`apps/server/src/database-copy.ts`；`tests/desktop-core/storage-policy.test.ts`、`storage-risk.test.ts`、`copy-to-local.test.ts`；`tests/server/database-copy.test.ts`；`apps/desktop/tests/desktop-smoke/storage-risk.spec.ts` |

**本版的非 CI 項目**：Windows 11 與 macOS 實機上的連接埠變更（真實的服務停止與啟動、`PORT_NOT_PERMITTED`、Dashboard 新位址）、風險判定（DriveInfo、mount、diskutil 的實際結果與雲端根目錄）與「複製到本機磁碟並改用」。已知未偵測：macOS 的 iCloud「桌面與文件」同步；Windows 的 Google Drive 虛擬磁碟為盡力偵測。

## 1.6.52 任務（升級、還原與多程序寫入的驗證）與本文件的關係

本版實作下列項目的 CI 可驗證部分；Windows 11 與 macOS 的實機驗收仍為**待實機驗收**。CI：PR #374 的 23 項必要檢查全部通過（commit 6916e49）。

| 任務 | 內容 | 狀態 | 本文件位置 | 證據路徑 |
|---|---|---|---|---|
| DT-32（migration 前備份與 N→N+1 樣本升級） | 三份真實舊版樣本（v1.6.8 schema 31、v1.6.21 schema 32、1.6.51 schema 33，合成資料，以 `scripts/generate-upgrade-fixtures.mjs` 手動產生、不在 CI 執行）以真實 store 升級：升級前備份與樣本相同、integrity／外鍵／FTS 正常、資料列與舊欄位不變、新欄位為 NULL、搜尋可用、私人文字不出現、第二次開啟不做事；新 migration 必須附上前一版樣本；真實程序在 migration 交易中、備份途中、20 次隨機時間點與還原途中被強制結束，結果永遠是全部舊版或全部新版；還原前驗證遷移後的副本（`quick_check`、`foreign_key_check`），失敗回 `RESTORE_VERIFY_FAILED` 且現行資料庫不變；桌面 smoke：migration 開始後後端被強制結束進入 `NEEDS_REPAIR`，不回到舊服務，下一次修復只升級一次 | 1.6.52 已實作（CI 可驗證部分）；Windows 11 與 macOS 實機待實機驗收 | C-15；ADR-22；R06 | `tests/storage/upgrade-samples.test.ts`；`tests/storage/migration-interruption.test.ts`；`tests/fixtures/upgrade/`；`scripts/generate-upgrade-fixtures.mjs`；`packages/storage/src/backup.ts`；`apps/desktop/tests/desktop-smoke/migration-interruption.spec.ts` |
| DT-07（多程序 WAL 寫入與 checkpoint 壓力） | `pnpm test:sqlite-stress`（不在 `pnpm test` 內）：4 個寫入程序、2 個唯讀程序（其中一個持有長時間讀取交易）、checkpointer 循環 PASSIVE／FULL／RESTART／TRUNCATE、`VACUUM INTO` 快照程序與隨機 SIGKILL，45 秒；絕對檢查 `integrity_check`、`foreign_key_check`、FTS5 完整性、已確認的寫入恰好一次、被中斷的寫入全有或全無、快照為無缺口前綴、還原快照指紋相同；拋出的 `SQLITE_BUSY` 設門檻（寫入程序 ≤ max(5, 寫入數 2%)、讀取／checkpointer／snapshotter 為 0；checkpoint 的 `busy` 旗標只回報），各系統數字與上限記錄在結果檔的 `busyGate`；CI 新增 `SQLite stress (ubuntu-latest／windows-latest／macos-latest)`，必要檢查增為 23 項；「Storage (Node 26)」工作同時執行 `check-sqlite-version`；打包 smoke 斷言內建 Node 的 `sqlite_version()` 與 FTS5，並在內建 runtime 下執行 6 秒壓力測試 | 1.6.52 已實作（CI 可驗證部分）；`SQLITE_BUSY` 門檻已設；Windows x64、macOS x64、macOS arm64 的打包 runtime 皆為 Node 24.22.3、SQLite 3.54.1（含修補）；6 秒壓力測試全部通過，每個 OS 的總時間 14.0／16.7／11.9 秒（PR #374 CI），實機待實機驗收。**不取代 DT-06 的 SQLite 修補證據** | ADR-19；C-21；R33 | `tests/stress/sqlite-wal-stress.test.ts`；`tests/stress/stress-support.ts`；`tests/stress/stress-worker.ts`；`tests/stress/vitest.config.ts`；`scripts/run-sqlite-stress-with-node.mjs`；`scripts/check-sqlite-version.mjs`；`.github/workflows/ci.yml`（`sqlite-stress` 工作）；`.github/workflows/desktop-package.yml` |

**本版的非 CI 項目**：Windows 11 與 macOS 實機上的 migration 中斷行為與桌面 smoke 的對應行為、壓力測試的實際結果與 `SQLITE_BUSY` 計數（`busyGate`）、打包版的 SQLite 版本與數字。尚未做：桌面 App 的還原流程（目前只有 CLI `pnpm db:restore`）。

下一版（1.6.53）為更新檢查：預設關閉，由手動的「檢查更新」按鈕觸發；Windows 與 macOS 都顯示版本與更新說明，並開啟下載頁面，App 內不安裝。

## 1.6.53 任務（手動更新檢查）與本文件的關係

本版實作下列項目；Windows 11 與 macOS 的實機驗收仍為**待實機驗收**。CI：PR #375 的 23 項必要檢查全部通過（commit c8efde0）。

| 任務 | 內容 | 狀態 | 本文件位置 | 證據路徑 |
|---|---|---|---|---|
| 手動更新檢查 | 修復視窗的「更新」卡片與工作列的「檢查更新…」。只在按下按鈕時由主程序請求 GitHub releases API（`per_page=20`），記憶體內 session、不帶憑證、不快取、不接受重新導向；標頭只有 `Accept`、`X-GitHub-Api-Version`、`User-Agent`（移除 `Accept-Language`），不送版本、作業系統、機器識別碼或權杖；10 秒逾時、1 MiB 上限、同時只一次。略過草稿與預發布，tag 須為 `vX.Y.Z`。工作列項目由主程序直接開始檢查。狀態：最新、有新版、離線、查詢次數受限（不自動重試）、安全連線失敗、沒有正式版、錯誤；每個狀態都有「開啟發行頁面」。更新說明純文字、移除控制與雙向字元、上限 20 000 字元。下載按鈕以預設瀏覽器開啟該平台安裝檔，網址由 tag 重建且只允許本儲存庫的發行網址；其他平台只提供發行頁面。App 內不下載、不安裝 | 1.6.53 已實作；單元測試 82 項、桌面 smoke 24 項；Windows 11 與 macOS 實機待實機驗收 | ADR-40（新增）；ADR-25（手動下載路徑）；ADR-38（未簽署與 SHA256SUMS）；[1.6.53 更新說明](../releases/1.6.53.md) | `packages/desktop-core/src/update-check/`；`apps/desktop/src/main/update-check.ts`；`apps/desktop/src/main/update-session.ts`；`apps/desktop/src/renderer/repair/update-view.ts`；`tests/desktop-core/update-check-{logic,request,controller}.test.ts`；`tests/desktop-core/dashboard-link.test.ts`；`apps/desktop/tests/desktop-smoke/update-check.spec.ts` |
| 每日稽核例外監看 | `audit-exceptions-watch`：每天 UTC 03:37 與手動觸發，`contents: read`，無 secret，不是 PR 的必要檢查；執行 `node scripts/check-audit-ignores.mjs --registry`，npm 出現修補版或 advisory 不再回報時失敗並通知維護者 | 1.6.53 已加入 | [相依套件稽核例外](../security/audit-exceptions.md) | `.github/workflows/audit-exceptions-watch.yml`；`scripts/check-audit-ignores.mjs` |

沒有 schema 變更（33），沒有 migration。下一版（1.6.54）為診斷匯出、runtime 延後清理與 Windows SQLite 量測，見下節。

## 1.6.54 任務（診斷匯出、runtime 延後清理與 Windows SQLite 量測）與本文件的關係

本版實作下列項目的 CI 可驗證部分；Windows 11 與 macOS 的實機驗收仍為**待實機驗收**。CI：PR #382 的 23 項必要檢查全部通過（commit c4e67ea）。

| 任務 | 內容 | 狀態 | 本文件位置 | 證據路徑 |
|---|---|---|---|---|
| 診斷匯出預覽與遮蔽（DT-19） | 修復視窗的「匯出診斷資訊」先開啟預覽；「儲存檔案…」寫入預覽中的同一份文字（POSIX 0600）；「取消」與 Esc 關閉；只手動匯出，不上傳，沒有遙測。內容為固定欄位，輸出行只保留 App 日誌前綴的行。遮蔽涵蓋使用者主目錄、UNC、資料庫與備份路徑、電子郵件、交接代碼、URL 秘密與權杖形狀；第二道掃描失敗回 `DIAGNOSTICS_SCAN_FAILED`；1 MiB 上限；預覽 10 分鐘有效、只能儲存一次；所有遮蔽模式以線性時間執行 | 1.6.54 已實作（CI 可驗證部分）；桌面 smoke 檢查儲存的檔案與預覽相同且不含植入標記；實機待實機驗收 | ADR-29；C-18；R32 | `packages/desktop-core/src/shell/diagnostics*.ts`；`apps/desktop/src/renderer/repair/diagnostics-view.ts`；`tests/desktop-core/diagnostics.test.ts`、`diagnostics-preview-store.test.ts`、`diagnostics-linear-time.test.ts`、`shell-policy.test.ts`；`apps/desktop/tests/desktop-smoke/desktop.spec.ts` |
| 舊 runtime 延後清理（DT-24） | 目前與前一版永遠保留；其餘舊版在退役滿 7 天、沒有 lease、且可改名移開時才刪除。launcher 的每個 action 建立與移除 lease（只含 action 與建立時間），MCP 與 serve 每 60 秒更新；兩次心跳未更新的 lease 視為已不存在；改名失敗則 10 分鐘、30 分鐘、之後每小時重試；更新不刪除、不等待鎖 | 1.6.54 已實作（CI 可驗證部分）；Windows 檔案鎖的實機行為待實機驗收；lease 成本 Windows 中位數 0.75 毫秒、macOS 0.43 毫秒 | ADR-16；C-14；R08 | `packages/desktop-core/src/runtime/lease.ts`、`runtime-gc.ts`；`apps/desktop/src/main/runtime-provision.ts`；`tests/desktop-core/runtime-lease.test.ts`、`runtime-gc.test.ts`、`runtime-gc-live.test.ts` |
| Windows SQLite 停滯量測（僅測試） | `WI_SQLITE_TIMING=1` 只在 Windows CI 的單元測試與 SQLite 壓力測試工作中開啟；記錄超過 1 秒的呼叫、`BEGIN IMMEDIATE` 等待直方圖、資料庫開啟時間、每次 `wal_checkpoint` 與超過 10 秒的測試；不記錄繫結值；生產版建置檢查若發現 helper 即失敗；不改變門檻、逾時或斷言 | 1.6.54 已加入（僅測試）；量測結果：停滯發生在 `BEGIN IMMEDIATE` 等待鎖與個別陳述式，不在開啟或 checkpoint；未修正 | — | `tests/helpers/sqlite-timing.ts`；CI artifact `sqlite-timing-windows-latest` 與 `sqlite-stress-windows-latest` |

沒有 schema 變更（33），沒有 migration。

## 本機打包

依 ADR-38，本機打包是主要的取得方式；CI 與 GitHub Release 的產物為輔。打包只能建置執行它的平台與架構（隨包 Node.js 是該平台的官方執行檔），因此 Windows 與 macOS 各自在本機執行。

| 平台 | 指令 | 產物 |
|---|---|---|
| Windows 11 x64 | `pnpm install --frozen-lockfile`，然後 `pnpm package:desktop` | `dist/desktop-package/win32-x64/out/Work-Intelligence-<版本>-win-x64-setup.exe`（NSIS，目前使用者安裝） |
| macOS（arm64 或 x64，依本機） | 同上 | `dist/desktop-package/darwin-<arch>/out/` 下的 `Work-Intelligence-<版本>-mac-<arch>.dmg` 與 `.zip`；`.app` 在同一資料夾的 `mac*/` 下 |

- **一個指令**：`pnpm package:desktop` 會先執行整個 `pnpm build`（失敗即中止，不打包），再打包；建置耗時印成 `[package] build N s`，並寫入結果 JSON 的 `timings.buildSeconds`。已自行建置過時可加 `--skip-build`，CI 的 `desktop-package.yml` 就是如此，因為它另有建置步驟。
- **首次打包會下載**：Electron 與 electron-builder 的檔案，以及官方 Node.js runtime（依 `SHASUMS256.txt` 核對雜湊後才使用，快取在 `dist/desktop-runtime-spike/downloads`）；之後的打包重用快取。
- **只要解開的 App**：`pnpm package:desktop --dir`，停在未封裝成安裝包的 App；同樣會先建置，也可加 `--skip-build`。
- **結果與檢查**：大小、時間與各項 gate 寫入 `apps/desktop/package-results/package-<platform>-<arch>.json`；fuse 讀回、雜湊與（macOS）`codesign --verify --deep --strict` 等檢查與 CI 相同，任一失敗即中止。
- **安全提示**：本機建置的檔案通常沒有 macOS 的隔離屬性（`com.apple.quarantine`）或 Windows 的 Mark of the Web，所以多半不會出現 Gatekeeper 或 SmartScreen 提示；從網路下載的 CI 或 Release 產物則會出現，需要使用者自行允許開啟（macOS ad-hoc 簽章、Windows 未簽章）。

## R3 → R4 修訂紀錄

### 指定修改（使用者需求）

| # | 需求 | R3 位置 | R4 位置 | 變更摘要 |
|---|---|---|---|---|
| 1 | 基準 commit 更新為 `d464ea5`，目標 1.6.41 | R3 §0.1、附錄 | R4 標頭、附錄 | 基準由 `7723b72` 改為 `d464ea5`；repo 連結全部改用 `d464ea5` 並核對存在 |
| 2 | MCP 已有寫入閘；缺口在 HTTP API 與長駐 CLI | R3 R03、§7.2、§7.3 | R4 §7.2、§7.3；ADR-18；C-07；DT-03、DT-04 | 更正 R03 描述；§7.2 的阻斷條件改為「HTTP 與 CLI 缺閘」；T2 已實作（commit 3ff1e45） |
| 3 | `isAllowedHost` 比對 port（T4） | R3 §5.2 | R4 §5.2；C-10；ADR-11；DT-17 | 加入現況（僅比 hostname）與目標規則，標示 1.6.41 已實作（commit dadaae4） |
| 4 | SQLite 量測與 T3 檢查 | R3 §7.3.1、R33 | R4 §7.3.1；ADR-19、ADR-35；C-21；DT-06 | 加入本機量測（3.53.4，`[T]`）與使用限制；T3 已實作（commit 4420951） |
| 5 | Windows 11 x64 與 macOS 同批首發，Linux 分開 | R3 §0.3、§1、§2.1、§7、§8、§9、§11、§14.1 | R4 §0.3、§1、§9、§14.1；ADR-02、ADR-03；DT-26、DT-33、DT-34 | 全文改寫首發範圍；Windows 檔案鎖、schtasks、NSIS 進入首發；Linux 與 Windows ARM 列入排除 |
| 6 | 每項風險都有工程票或排除理由 | R3 §11 | 風險矩陣 §1、§2、§5 | R01–R34 全部對應 DT 票；3 項有部分排除（R18、R21、R25） |
| 7 | 去重並保留證據標籤 | 全文 | 見下方去重紀錄 | 合併重複段落；四種標籤保留原意 |
| 8 | Windows 資料夾選擇（T1） | 無 | R4 §9.1；C-17；ADR-31；DT-26 | 新增 `IFileOpenDialog` 規格（COM interop、旗標、取消碼、fallback、UTF-8）與實機驗收要求 |

### 其他結構性變更

| 變更 | 說明 |
|---|---|
| 風險表移出 | R3 §11 的 34 列表格移至風險矩陣，R4 正文改為摘要與連結。 |
| 工程拆票移出 | R3 §13 的 Epic 表移至風險矩陣 §3，並以 DT 票號與 R3 Epic 編號對照。 |
| 決策拆出 | R3 的決策散落於各節。R4 把決策整理為 ADR-01 至 ADR-35，正文仍保留細節，ADR 為索引。 |
| 元件契約新增 | R4 新增元件契約（C-01 至 C-22），供實作分工。 |
| 首發決策落定 | R3 §14.1 的「是否先 macOS 再 Windows」已由產品決定，記為 ADR-02。 |
| 新增 DT 票 | DT-26（1.6.41 T1）、DT-33（聯合發行閘）、DT-37（發行身分與簽章）為 R4 新增。 |
| 基準連結更新 | repo 連結由 `7723b72` 改為 `d464ea5`；外部連結維持 R3 原樣，採用前仍應鎖定 commit。 |

### 去重紀錄

以下段落經合併或移除。合併後保留的位置列於右欄。

| R3 內容 | 重複之處 | R4 保留位置 |
|---|---|---|
| §1.1 與 §8.2 的退出語意 | 兩處描述同一規則 | R4 §1.1（8.2 只引用） |
| §5 表格的「從瀏覽器發出控制命令」段與 §5.2「會話授權設計」 | 同一套授權碼與 fragment 設計，重複描述 | R4 §5.2（單一段落） |
| §6 第 4 段（現有 server 在 listen 前開 store） | 與 §2.1 及 §5.1 重複 | R4 §5.1（canonical） |
| §6.2 第 2 點（port 預檢只是提示） | 與 §5.1 的 preflight 規則重複 | R4 §6.2 只保留 port 相關的部分，並引用 §5.1 |
| §7 階段表與 §7.2 三階段定義 | 更新成功條件重複 | R4 §7 階段表與 §7.2 的 `desktopInstalled`、`backendReady`、`dataCompatible` |
| §7 末段「在任何 schema 會改變的更新前…」與 §7.2 同段 | 重複 | R4 §7.2 |
| §7 末段「沿用 storage 原有 migration 前備份」與 §7.4 | 重複 | R4 §7.4 |
| §3.1 唯讀段落、§3.1 檔案系統政策、§0.2 invariant 4 | 三處描述唯讀與 WAL sidecar | R4 §3.1.1（sidecar 與 `immutable=1`） |
| §4 第 3 點與 §4.2 的 Windows `conhost` 描述 | 同一觀察 | R4 §4.2 |
| §9 的 A–D 交付摘要表與 §9.1 的階段表 | 兩表描述同一批階段 | R4 §9.4（A→階段 0–1；B→階段 3–4；C→階段 2；D→階段 5–6） |
| §9.2 Gate 定義、§9 第一版驗收案例、§14.3 封版檢核 | Gate 內容重複 | R4 §9.5 為 Gate 定義；§14.3 只列檢核項並引用 Gate 代碼 |
| §11 風險表與 §0.2 invariant | 部分風險描述重疊 | 風險矩陣為唯一風險表；R4 §11 只保留摘要 |
| §3.2 Agent 狀態表與 §3.2 結果分級段 | 狀態描述重疊 | R4 §3.2.1（表格為準，分級段保留為說明） |
| §14.1 問題表與 §0.3 決策表 | 同一批決策 | R4 §0.3 為現況；§14.1 只列驗證方式與 Owner |
| 附錄的 repo 連結與正文連結 | 同一批檔案出現兩次 | 正文保留連結；附錄作索引 |

**去除的非重複內容（Linux 相關）**：R3 中針對 Linux 的桌面描述（系統匣不可用、AppImage、Ubuntu GNOME 驗收、Linux 更新簽章）已移除，並改記為 §5 的 V1 排除項。Linux 的 zenity、kdialog 分支維持程式現況，不納入驗收。

---

## 後續修訂紀錄

- R4 第三次修訂（1.6.42）: 更新階段 0 狀態與 DT-04 實驗結論、DB 身分策略定案。
- R4 第四次修訂（1.6.43）: 階段 1 spike 結果與 ADR-04 決策（隨包官方 Node.js）；DT-23、DT-25 狀態；風險矩陣的證據與 §3.3、§9.4、§10.2 的階段 1 進度與實作 layout。
- R4 第五次修訂（1.6.44）: 階段 2 的實作狀態（DT-11、DT-15、DT-16、DT-35）；風險矩陣的證據與 ADR-04、ADR-07、ADR-08、ADR-13、ADR-26 的狀態；C-01、C-02、C-08、C-11 的實作註記；§5.1、§9.4、§10.3 的階段 2 進度與實作差異。
- 1.6.45（階段 5 的打包部分；未另列修訂序號）: 階段 5 狀態（§7.1 的 DT-28 決定、§9.4、§3.3 的 ACL 與 runtime 清理）；風險矩陣與 ADR-15、ADR-16、ADR-25、ADR-30、ADR-38 的 1.6.45 註記。
- R4 第六次修訂（1.6.47）: 階段 3 的 CI 可驗證部分（DT-21、DT-22、DT-23 後續、DT-27）與 backlog a、b；§3.3、§9.4 的階段 3 進度；風險矩陣的 R07、R15、R16、R17、R28 與 DT 票狀態；ADR-14、ADR-15、ADR-28、ADR-34 的實作註記與新增 ADR-39。

## 驗證紀錄（R4 修訂過程）

以下為 R4 撰寫時的唯讀核對，**未修改任何程式碼、未執行測試**：

- 基準 `d464ea5` 存在；R4 引用的 25 個 repo 路徑在 `d464ea5` 皆存在（`git cat-file -e`）。
- `packages/storage/src/store.ts` 含 `withCompatibleSchema()`，錯誤碼 `MCP_RESTART_REQUIRED`；`apps/mcp/src/server.ts` 在寫入路徑呼叫它。
- `apps/server/src/server.ts` 的 `isAllowedHost()` 只比對 hostname。未找到已建置的 Web 目錄時，預設允許的 origin 為 `http://127.0.0.1:5966`、`http://localhost:5966`（開發模式）。
- `apps/server/src/folder-picker.ts` 在 `d464ea5` 仍為 WinForms `FolderBrowserDialog`，macOS 為 `osascript`，Linux 為 zenity／kdialog。
- `packages/storage/src/data-revision-cache.ts` 以 `pragma_schema_version` 作快取鍵。
- `apps/server/src/doctor.ts` 含 `probeSqlite()`。
- `package.json`：版本 `1.6.40`；`engines` 為 `>=22.16.0 <23 || >=24.0.0`。
- `docs/release-checklist.md` 含 Windows 相關未執行條目（原生資料夾選擇、備份還原、Codex hook、登入自動啟動、bootstrap）。
- 開發機 `node` v22.23.4，`node:sqlite` 回報 `sqlite_version()` = `3.53.4`（僅為本機量測，見 R4 §7.3.1）。

**1.6.41 實作結果的核對（R4 第二次修訂）**：僅以唯讀方式檢查 commit 存在與相關符號的接線（`Store` 寫入交易閘、`isAllowedHost(hostHeader, listenPort)`、`sqlite-runtime.ts`、`folder-picker.ts` 的 `IFileOpenDialog` 與 exit 2、`check-sqlite-version.mjs` 於 ci／release 的呼叫）。**未執行測試、未取得實機結果。**

---

## 待使用者確認事項

以下項目是產品決策或推論，需使用者確認。確認前，文件以標示的狀態描述，不視為定案。

1. **聯合發行門檻（待使用者確認）**：任一首發平台的 gate 未過即整版不發（ADR-03；R4 §9）。R4 保留此規則，待使用者確認是否接受其時程代價。
2. **macOS 架構範圍（待確認）**：Apple Silicon 與 Intel 皆列為首發候選（ADR-02；R4 §9.0）。Intel 能否同批驗收，於 A 階段決定；若不能，依 ADR-02 變更程序排除並更新發行聲明。
3. **Windows ARM 排除（推論，待確認）**：本文依產品決策「Windows 11 x64」排除 Windows ARM，此排除是由範圍推論而來，產品端並未明確寫出（ADR-02；R4 §9）。

## 未確定事項

1. **SQLite 修補的發行證據**：發行產物內 bundled Node 的實際 `sqlite_version()` 尚未取得。本機值不能取代它。
2. **官方 SQLite 說明**：「3.51.3 起修復、3.50.7 與 3.44.6 回補」來自 R3 的引用，R4 未重新抓取原文，採用前應確認。
3. **實機驗收**：Windows 11 與 macOS 實機結果全部為待實機驗收，包括 T1 的現代資料夾選擇視窗（`docs/release-checklist.md`「Windows 11：現代資料夾選擇視窗」）。
4. **`apps/desktop` 界線與各元件的介面**：僅為草案，待原型決定。
5. **電子與更新工具版本**：尚未鎖定；v26 與 v27 的選擇依 ADR-25 決定。
6. **1.6.41 之外的 PR**：本文件未檢查其他分支對上述程式的修改。

---

## 檔名異動

- R3 檔名 `desktop-v1-design-r3.md` 已以 `git mv` 改名為 `desktop-v1-design-r4.md`（已暫存，未提交）。
- repo 內除 git 歷史外，不再有指向舊檔名的連結（修訂後以 `grep` 確認）。
