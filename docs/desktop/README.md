# Work Intelligence 桌面版 V1 設計文件索引（R4）

**狀態：工程實作前設計基線（未通過實機驗收）。** 修訂日期：2026-11-16。

| 項目 | 內容 |
|---|---|
| 文件版本 | R4 |
| 基準 commit | `d464ea5`（main，Merge PR #361，release 1.6.40） |
| 目標修補版 | 1.6.41（T1–T4）、1.6.42（DT-01/02/04/09/10/20/36）、1.6.43（DT-23、DT-25，階段 1）；設計基準仍為 `d464ea5` |
| 前一版 | R3（來源提交 `e46060e`，審查基準 `7723b72`） |
| 首發平台 | Windows 11 x64 與 macOS 同批發行；Linux 不在 V1。Windows ARM 排除為推論（待確認）；macOS 架構範圍（Apple Silicon、Intel）待確認 |

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
| [desktop-v1-adr.md](desktop-v1-adr.md) | **決策紀錄**（ADR-01 至 ADR-36）：每筆含脈絡、決策、後果與狀態。涵蓋 R3 所有決策並更新 R4 的變更。 | 架構、審查 |
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
| DT-25 | 無 Node 封裝 spike：官方 Node.js 與 Electron（`ELECTRON_RUN_AS_NODE`）的建置，離線煙霧測試（serve、DB 寫入、FTS5、備份、MCP stdio、hook、竄改拒絕），以及大小、冷啟動與閒置記憶體量測 | 1.6.43 已實作（CI 可驗證部分）；Linux 與 macOS 量測完成（CI run 43856418517、43857858519）；Windows 量測待 PR CI；階段 1 gate 未通過 | §9.4；§3.3；ADR-04 | `scripts/desktop-runtime-spike/*.mjs`；`.github/workflows/desktop-runtime-spike.yml`；量測 JSON 由 CI 上傳為 `runtime-spike-*` artifact |
| DT-23 | 固定 launcher 與版本化 runtime manifest（v1）：`bin/` 下的 shim、`current` 指標、`runtimes/<id>/`、全檔案 SHA-256 核對、symlink 與權限檢查、錯誤碼 | 1.6.43 已實作（CI 可驗證部分）；Windows ACL 為 `not-implemented`；Agent 設定尚未指向 launcher；實機待實機驗收 | §3.3；§10.2；ADR-15 | `packages/desktop-core/src/runtime/*.ts`；`tests/desktop-core/runtime-install.test.ts`、`runtime-launcher.test.ts`、`runtime-manifest.test.ts`、`runtime-verify.test.ts` |

選定的 runtime 為隨包官方 Node.js（ADR-04），理由與量測數字見該 ADR。

**本版的非 CI 項目**：Windows 量測與煙霧測試、Windows ACL 檢查、Windows 的 `.cmd` 與 `%*`／`!` 行為、NTFS 變更時間與 stat 快取的強度、DT-24 runtime 清理（未實作）、plugin／standalone／MCPB 接線（未做），以及官方 Node.js 發行簽章（GPG）的驗證。

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
