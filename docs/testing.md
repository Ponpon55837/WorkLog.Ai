# 測試與驗證

各層測試指令、覆蓋率門檻與 E2E 範圍。

> 回到 [README](../README.zh-TW.md)（[English](../README.md)）

## 測試檔案位置

所有單元、整合與端對端測試集中放在根目錄 `tests/`，依工作區套件分資料夾；`apps/` 與 `packages/` 只放產品程式碼、建置與測試設定，不在 `src/` 旁混放測試檔。`tests/e2e/` 專放瀏覽器端對端測試。

```powershell
pnpm test         # ESLint、全專案格式檢查，以及 core、政策、shared、schema、storage、server、MCP、Web 測試
pnpm format       # 格式化全專案（文件與 Agent 技能除外）
pnpm test:coverage # core、政策、shared、schema、storage、server、MCP、Web 覆蓋率與最低門檻
pnpm test:performance # 合成資料的匯入與關鍵讀取路徑效能門檻（需先 build）
pnpm run verify:backup-worker-build # 檢查 production build 的 worker entry（CI 三平台皆執行）
pnpm test:retrieval-quality # 只執行合成資料的 work_recall 檢索品質評估
pnpm eval:recall <題目.json> # 在指定資料庫唯讀評估 recall/context
pnpm run test:recall-eval:example # 以暫存合成資料庫跑 CLI 範例與排名 smoke gate
pnpm bench:recall-scale [規模] # 在逐級增加的合成干擾資料中量測 recall/context 排序（需先 build，只在本機手動執行）
pnpm typecheck    # 套件、Vue 樣板、單元測試與 E2E 設定型別
pnpm build        # 工作區套件、server／MCP 與 Vite 正式版
pnpm test:e2e     # 使用隔離資料庫的 Playwright 瀏覽器回歸測試
```

`pnpm db:redact` 的 dry-run 與 `--apply` 測試只使用暫存目錄內的合成 SQLite 資料庫；不會讀寫使用者的實際資料庫。測試中的憑證字串由執行期片段組合，不在原始碼保存完整假 token。

## 介面契約與錯誤路徑

- **文件與實作一致**：`tests/mcp/docs-parity.test.ts` 確認每個已註冊的 MCP operation 都在 `docs/mcp-tools.md` 出現，文件也沒有提到不存在的 operation 或 dispatcher；`tests/server/rest-docs-parity.test.ts` 對 `docs/rest-api.md` 與 REST 路由表做同樣檢查（路徑參數名稱與查詢字串不影響比對）。新增或移除工具與路由時，兩邊要一起更新。
- **REST 嚴格輸入**：`tests/server/rest-strict-input.test.ts` 對每個寫入路由送出帶未知欄位的 body，要求 400 並點名該欄位；沒有 body 的路由必須列在測試內並寫明原因。另檢查所有路由都經 `parseRequestInput` 驗證，不直接呼叫 `safeParse`。
- **資料庫無法寫入**：`tests/storage/sqlite-errors.test.ts` 以建構的錯誤涵蓋 busy、唯讀與磁碟已滿的分類（磁碟已滿無法在測試中可攜地重現）；唯讀情境在 storage、server 與 MCP 測試中以 `PRAGMA query_only` 或唯讀連線重現，不依賴 chmod（root 與 Windows 的行為不同）。
- **破壞性與維護操作的錯誤路徑**：`tests/storage/project-deletion.test.ts` 涵蓋找不到專案、名稱不符、備份目錄不可用、寫入鎖被占用與唯讀資料庫，每種都確認專案與 Session 仍在；`tests/storage/database-maintenance.test.ts` 涵蓋缺少資料庫、非 SQLite 檔案、外來資料庫、完整性檢查失敗（以 `writable_schema` 讓索引指向錯誤頁面，各平台一致）、備份失敗與 schema 過新，並確認檔案未被修改；`tests/storage/handoff-importer.test.ts` 涵蓋排除不讀取、`maxFiles` 上限、超出專案根目錄的路徑與符號連結。
- **鎖定下開啟**：`tests/storage/database-initialization.test.ts` 與 `tests/mcp/server.test.ts` 以第二條連線明確持有、再釋放寫入鎖，確認目前 schema 的資料庫在鎖定時仍可讀取、待 migration 時回傳 `DATABASE_BUSY` 且不寫出備份，釋放後下一次呼叫即恢復；`tests/mcp/store-access.test.ts` 以手動時鐘確認重試次數有上限，不依賴實際時間。

## 介面語言與主題

- **訊息目錄**：`tests/web/i18n/catalog.test.ts` 確認 `zh-TW.json` 與 `en-US.json` 的 key 與 `{placeholder}` 完全一致、沒有空字串、沒有已不再使用的 key，且 `apps/web/src` 裡沒有寫死的中文字串（只允許 `資料不足` 這類資料標記）。不存在的 key 由型別檢查擋下（`t()` 只接受 `MessageKey`）。同一檔案也測試插值、單複數與常數標籤表隨語系切換。
- **測試也不寫死介面文字**：單元測試以 `t("key", 參數)` 取得預期文字；E2E 以 `tests/e2e/helpers/i18n.ts` 的 `tt()`、`ttPattern()`、`textIn()` 從同一份 JSON 取字。`tests/web/i18n/e2e-copy.test.ts` 會在 spec 把中文直接傳給 locator 或文字斷言時失敗（伺服器與 fixture 寫入的資料除外）。
- **偏好設定**：`tests/web/stores/preferences-store.test.ts` 涵蓋主題（含跟隨系統）、語言的保存與還原，以及無法使用 localStorage 時的退回行為。
- **E2E 預設**：Playwright 以 `locale: "zh-TW"`、`colorScheme: "dark"` 執行，所以既有測試維持以繁體中文文案與深色主題斷言。淺色主題由「light theme @accessibility」axe 測試覆蓋；「switches the interface language and theme」測試從頁首切換英文與主題並確認重新整理後保留；另有英文版在 640／390px 的水平溢位檢查，因為英文文案較長。

## CI

`.github/workflows/ci.yml` 在每個 PR 與 `main` push 執行：

- **Quality**（`ubuntu-latest`、`windows-latest`、`macos-latest`）：`pnpm install --frozen-lockfile` → `pnpm build`（workspace 套件透過 `dist/` 互相引用，要先 build）→ `pnpm run verify:backup-worker-build`（用 production build 和合成資料啟動 worker）→ 測試 → `pnpm typecheck`。`pnpm test:coverage` 與 `pnpm test` 執行相同的測試檔，所以每個 OS 只跑一次：Ubuntu 執行 `pnpm lint`、`pnpm format:check` 與 `pnpm test:coverage`（含覆蓋率門檻），Windows 與 macOS 執行 `pnpm test`（含 ESLint 與全 repo Prettier check）。維護者主要使用 macOS；Windows 與 Linux 守住不同的路徑處理（大小寫、分隔符號、8.3 短檔名）與 shell 行為。
- **生產依賴安全稽核**：Ubuntu Quality job 執行 `pnpm audit --prod --audit-level high`；生產依賴出現 high 或 critical 級別漏洞時，檢查會失敗。
- **效能門檻**：在 Ubuntu Quality job 的測試與覆蓋率成功後，執行 `pnpm test:performance`；某個案例第一次量測超過門檻時，會只針對該案例再量一次，第二次仍超標才判定失敗；門檻不變，結果表以 `remeasured` 與 `firstPassP90Ms` 標示。效能基準只跑一次，避免在 OS matrix 重複佔用 CI 時間。5,000 Sessions 匯入 50,000 events 的 20 秒上限則在 `pnpm test` 中跨平台執行。最近一次本機量測中，5,000 Sessions／1,000 個合成未結項的清單 p90 為 2.09 ms（上限 250 ms）；100 筆 Session digest 的 pending-items 批次查詢 p90 為 4.61 ms（上限 100 ms，先前量測為 8.11 ms）。
- **Recall evaluator 效能門檻**：同一個 `pnpm test:performance` 另以 5,000 筆合成 Sessions、MCP in-memory transport 與真實 snapshot 流程量測 recall/context evaluator，15 次執行的 p90 上限為 1,000 ms。此數字涵蓋唯讀來源備份、scratch store 啟動、必要的 scratch 索引同步與兩個 MCP 呼叫；不使用使用者資料庫。最近一次本機量測 p90 為 259.19 ms（median 250.06 ms、max 263.91 ms），整體讀取效能 gate 23/23 通過。
- **Knowledge 信任狀態批次查詢**：`recall (20 Knowledge hits with staleness)` 以 20 筆帶 `appliesTo` 的過時 Knowledge 作為 recall 命中，p90 上限 250 ms。recall 與 `work_get_context` 會替每筆 Knowledge 命中標示過時與確認／推翻次數，這些資訊必須一次批次讀取；逐筆讀取時，每筆都要重新掃描之後的 Session。本機 Windows 量測（5,000 Sessions）：改為批次前 p90 1,414 ms（median 1,217 ms），改為批次後 p90 113 ms（median 88 ms）。
- **Session 條件式重讀**：`getSessionDetailForAgent (full + revision, 200 nodes)` 量測完整讀取並計算內容 revision，`getSessionDetailForAgent (unchanged knownRevision, 200 nodes)` 量測帶回相同 revision 時只回傳識別資料的路徑，p90 上限各 250 ms。精準讀取也由完整詳情計算 revision；本機 5,000 Sessions 單次量測，三個 `getSessionProjection` 案例 median 由 0.75–1.36 ms 變為 3.19–3.84 ms，完整讀取＋revision 3.2 ms、unchanged 3.54 ms（量測時機器負載高，僅供參考）。
- **Recall evaluator CI smoke**：Quality 的 Ubuntu、Windows、macOS 三個 matrix 都執行 `pnpm run test:recall-eval:example`，在暫存目錄建立合成 SQLite，結構化代入臨時 project root 與本次 seed 的 Session／Knowledge ids，再直接用目前 Node 執行 evaluator，避免 shell 路徑與 `pnpm` shim 差異。recall 與 context 正例必須都達 hit@1、hit@5、MRR = 1；負例預期為 `confidence: "none"`，任何不符都以非零結束。CI 明確傳入暫存 `--db`，不讀取 `data/`。
- **檢索品質門檻**：`pnpm test` 在三個 OS 都包含虛構合成資料的 storage 評估；Ubuntu 另以 `pnpm test:retrieval-quality` 明確顯示 hit@5／MRR 門檻結果。
- **MCP 回應大小門檻**：`pnpm test` 在三個 OS 都執行合成資料的回應大小測試；Ubuntu 另以 `pnpm test:response-size` 顯示各工具序列化字元數並檢查上限。
- **E2E**（`ubuntu-latest`，與 Quality 同時開始）：每個瀏覽器一個 job，只安裝該瀏覽器，以 `E2E_PROJECTS=<瀏覽器>` 執行 `pnpm test:e2e`；必要檢查 `E2E (Chromium + Firefox + WebKit)` 會等三個瀏覽器 job 全部通過。本機不設 `E2E_PROJECTS` 時依序跑三個瀏覽器。Chromium 執行完整回歸，Firefox 執行 `@cross-browser` 與 `@accessibility` 流程，WebKit 執行 `@cross-browser` 核心流程。Chromium 與 Firefox 會在六個主要頁面、系統狀態與備份管理頁執行 axe，深色與淺色主題各跑一次，critical／serious impact 的違規（包含色彩對比）會使測試失敗；第一次使用清單另在無專案狀態執行 axe，並在 1440／960／375px 檢查水平溢位。備份刪除確認也有鍵盤操作 E2E。三個瀏覽器分開執行，使用各自的暫存 SQLite 與隔離的 Agent home/config 路徑；失敗時以 `playwright-results-<瀏覽器>` 上傳 `test-results/` 供除錯。測試伺服器載入正式建置的 Web 與 API，並共用一個 port；登入服務與 Agent 診斷使用注入的虛構狀態，不查詢主機設定或排程器。正式啟動程序不由此 E2E 涵蓋。CI 上的 WebKit 是 Ubuntu Playwright 執行環境，不等於 macOS Safari 實機驗證。

`.github/workflows/release.yml`（推送 `v*` tag 時執行）使用相同結構：Quality 矩陣與三個瀏覽器的 E2E job 同時開始，每個 OS 的測試只跑一次，`Publish GitHub Release` 需等全部成功；發行 workflow 的 E2E 失敗時改以 `release-playwright-results-<瀏覽器>` 上傳 `test-results/`。

Coverage 使用模組局部門檻；各套件分開量測，因此沒有設定跨套件合併總門檻。core、project-policy、shared 於 2026-09-26 的 macOS 基線分別為 100%／100%／100%／100%、99.27%／98.55%／100%／99.26%、95.45%／81.25%／100%／95.45%（statements／branches／functions／lines）；project-policy 的 Windows branches 為 92.75%，因平台路徑分隔符走不同條件。

A1 新增合成 runtime 的 `getMcpRuntimeStatus (cached identity)` p90 ≤ 50 ms，以及 `MCP guarded finalize (schema check)` p90 ≤ 250 ms。前者複製建置檔到測試目錄再量測暖快取狀態讀取，後者在同一 write transaction 核對 schema 後 finalize；不使用實際資料庫或 Agent 設定。

`tests/mcp/server.test.ts` 的報告回歸透過真實 MCP in-memory transport 與 dispatcher 儲存、冪等重送及重試報告，確認內層服務共用 schema 保護交易。另在隔離 SQLite 注入 INSERT 失敗，驗證先前目前版本與未完成請求均保留，移除失敗條件後可重新提交；不使用使用者報告。

Windows CI 的 coverage 曾讓 recall evaluator 誤判案例與未結項 supersession 稽核案例各耗時約 6 秒，超過 Vitest 預設 5 秒。這兩個包含檔案 SQLite 建置／快照或多次寫入的整合案例各使用 15 秒 timeout；保留所有斷言、其他測試的預設時間與獨立效能門檻。

Server 測試同樣會開啟真實 SQLite 檔案、建立備份並執行 CLI；Windows CI 上新建檔案可能短暫被鎖住，SQLite 會等到 5 秒的 busy_timeout，剛好碰到 Vitest 預設的 5 秒上限（2026-10-07 曾在刪除專案備份、CLI 列出備份等不同案例輪流逾時）。因此 server 的一般與 coverage 設定都比照 storage 使用 20 秒 `testTimeout`，斷言不變。

A2 另以 286 個合成過期 lease／tmp（每次計時前重建，建置資料不計時）量測狀態讀取及 MCP 註冊清理，兩者 p90 上限各為 100 ms。測試涵蓋 TTL＋60 秒邊界、每次 64 次刪除嘗試上限、重複讀取收斂、刪除失敗、非 UUID 檔案、符號連結及 scope 隔離；runtime 單元測試 mock `tmpdir()`，其餘本機驗證使用隔離 HOME／TMPDIR。

### Schema 33 升級與舊匯出檔匯入

- `tests/storage/schema-33-upgrade.test.ts` 以 store API 寫入代表性資料（Session、changed files、決策、evidence、連結、Knowledge、知識頁與版本、各狀態候選、未結項、報告請求），倒回 schema 31 後重新開啟：只建立一份 `pre-migration-v32` 備份、每張資料表（含搜尋索引）在舊欄位上的列數與內容雜湊不變、FTS 有結果、第二次開啟不再遷移也不再備份；備份失敗時不遷移，資料庫維持 schema 31。`tests/storage/schema-migrations.test.ts` 檢查 32 → 33 的 DDL、可為空欄位與兩個索引被查詢計畫採用。
- `tests/storage/project-data-import-floor.test.ts` 把 schema 倒回匯入下限（31），確認每個之後新增的匯出欄位都有匯入預設值、舊匯出缺少的資料表可視為空，且每個 project-data 欄位都在可攜式格式中；`tests/fixtures/project-data-export-schema-31.json` 與 `-32.json` 是 v1.6.8 與 v1.6.21 build 以自己的 store API 匯出的合成資料，兩種策略下預覽與匯入都 0 衝突、各表筆數相同、再次匯入全部略過。

### Schema 31 revision 通知量測（2026-11-03，Windows）

依 backend skill 第 5 節，以獨立 Node 行程、同一份 5,000 Sessions 合成基準資料的全新 SQLite 副本，比較基準與 revision-trigger 分支；順序輪替三輪，每個 `read-paths.bench.mjs` 行程對 finalize 案例跑 15 次並取 p90，再取三個行程 p90 的中位數：

| `finalizeSession (related pending reminder)` | 三個行程 p90 | 中位數 |
| --- | --- | ---: |
| 基準 `c041388` | 122.48、78.55、87.27 ms | 87.27 ms |
| schema 31 分支 | 89.99、30.83、166.94 ms | 89.99 ms |

中位數差為 +2.72 ms（+3.1%）；兩者低於既有 250 ms p90 上限。大量匯入則以同一個合成 fixture（5,000 Sessions、50,000 events）比較 revision triggers 關閉與開啟；每輪是獨立測試行程與新資料庫，輪替順序五輪。trigger 關閉／開啟時間依序為：3,135.5／1,826.0 ms、4,358.1／8,982.1 ms、4,631.8／5,084.0 ms、5,375.4／5,026.1 ms、4,344.5／4,649.2 ms。配對增量中位數為 +304.7 ms；各組中位數為 4,344.5／5,026.1 ms，差 +681.6 ms（+15.7%）。每次都通過既有 20 秒斷言，門檻未調整。

這是單機診斷量測，兩組耗時分布重疊，須把增量視為粗略估計。機器為 Windows 11 build 26200、Node 24.16.0、Intel Core 5 120U、12 邏輯核心、31.6 GiB RAM；量測前可用 RAM 約 7.9 GiB。CPU 計數器在此執行環境不可讀，程序快照只顯示目前 shell、conhost 與 Idle，無法完整判定背景負載。完整 PR gates 仍以原有門檻執行。

## 檢索品質評估

先執行 `pnpm build`，再用 `pnpm eval:recall <題目.json> [--db <資料庫.sqlite>] [--out <結果.json>]`。此 script 固定傳入 `--experimental-sqlite`：Node.js 22.5–22.12 需要此旗標，22.13 以上可接受這個冗餘旗標。未指定 `--db` 時使用 `WORK_INTELLIGENCE_DB`，否則使用 repo 的 `data/work-intelligence.sqlite`。題庫支援 JSON 陣列或 `{ "version": 1, "questions": [...] }`；最多 200 題、輸入檔最多 1 MB。每題必填 `mode`（`recall`／`context`）、`query` 和一項預期：`expectedIds`（最多 20 個 Session／Knowledge id）或 `expectedNoHit: true`。可選 `id`、`projectRoot`、最多 20 個 `paths`、`expectedConfidence`（`none`／`low`／`high`）；只有 recall 可用 `from`／`to`，兩端皆為有效的 `YYYY-MM-DD`，且日期端點包含在範圍內。Recall 固定取 MCP 回傳前 30 名；正例 hit@1／hit@5／MRR 的分母只算已評估的正例，負例另計，MRR 定義為 MRR@30。`expectedConfidence` 未指定時，報告會留空符合狀態，不從預期 id 推定 confidence。

Context 每題呼叫 `work_get_context` 的實際 MCP handler；排名只看 `relevant.sessions` 與 `relevant.knowledge`，各自依型別從 1 排到最多 5，不使用 recent 區段。Context 的 hit@1／hit@5 與 MRR 使用命中預期 id 的最佳型別內排名。Recall 對 Session 與 Knowledge 使用 MCP `work_recall` 的合併排序。若 scoped project 回傳 `skipped`（例如專案未追蹤），問題狀態會標為 `skipped`、不加入 no-hit 分母，並使整份評估失敗。

每題和整份報告的 `passed`（因此 CLI exit 0）表示：每個正例至少一個預期 id 出現在 MCP 回傳名單、明確指定的 `expectedConfidence` 符合、沒有 skipped，且預期 no-hit 沒有 `high` 信心。它不代表 hit@1／hit@5／MRR 達到品質門檻；CI 範例另要求兩個正例都排名第 1 並達 hit@1、hit@5、MRR = 1。

每題記錄 MCP text payload 的 JavaScript `.length` 與 `Client.callTool()` 耗時、MCP 回傳 hit 數；confidence 比對只在題目明確填入 `expectedConfidence` 時執行。`expectedNoHit` 以 MCP confidence 作為通過判準：`high` 會使該題及整份報告失敗並列於 `expectedNoHitWithHighConfidence`；`low` 即使有弱候選仍通過，但每題 `unexpectedHits`、`returnedHitCount` 與頂層 `expectedNoHitWithHits` 會顯示候選數量。`--out` 只在使用者明確指定時寫報告，省略則把 JSON 報告寫到終端；為避免意外覆寫，既有目標一律拒絕，請另選新檔名。也拒絕輸出到題目檔、SQLite 主檔、其 `-wal`、`-shm` 或 `-journal` sidecar，並以 exclusive-create 再防一次路徑競態。

唯讀保證來自 `DatabaseSync(source, { readOnly: true })`（評估器要求 Node.js 22.5+）：先透過 `node:sqlite backup()` 對來源做一致快照，再由正式 `WorkIntelligenceStore` 和 linked in-memory MCP Client/Server 在 OS 暫存副本執行相同 recall/context 路徑。Node 22.5–22.15 沒有 backup API 時，使用唯讀 source 的 `VACUUM INTO` 寫入同一暫存副本；此 fallback 也有強制路徑測試。由此產生的 `search_dirty` 同步只寫 scratch copy，確保尚未同步的來源索引不會漏掉新記錄。SQLite 為讀取 WAL 資料可能使用或建立來源旁的 `-wal`／`-shm` sidecars；這是 SQLite 正常唯讀 WAL 行為，評估器不會刪除它們。測試會逐位元組比對來源主檔和既有 WAL，並確認 records、search chunks/paths/FTS 與 dirty rows 不變、scratch 清理完成。

合成題目模板在 [`tests/fixtures/recall-eval-example.json`](../tests/fixtures/recall-eval-example.json)；`scripts/run-recall-eval-example.mjs` 在 OS 暫存位置建立資料庫並代入本次 seed ids，故範例不含固定的隨機 UUID，也不會碰使用者的 DB。CI 也嘗試把 `--out` 指向 SQLite 主檔與各 sidecar，確認命令失敗且檔案位元組不變。MCP evaluator 的 source/WAL 保持不變與 scratch dirty-index 命中由 `tests/mcp/recall-evaluation.test.ts` 驗證。

### 實驗紀律

檢索與知識類實驗遵守以下規則，避免數字看起來好看卻不可靠：

- 不同目標分開量測（例如找回舊工作、避免誤報、相關提示），不以單一 Hit@5 代表全部。
- 題目使用問題發生當時的歷史快照，不得洩漏之後才出現的知識。
- 門檻與 Go/No-Go 條件在實驗前寫下，實驗後不得調整。
- 私有資料只在本機唯讀副本上執行；repo 只保留合成資料與彙總數字。

## Agent MCP 回應大小

`pnpm test:response-size` 以虛構合成資料透過 in-memory MCP transport 呼叫工具，計算 Agent 實際收到的文字長度（JavaScript 字元數，不是 UTF-8 位元組或 token）。所有工具的文字結果都是緊湊 JSON。資料包含 20 筆 Session、10 筆共用同一段舊規劃的 handoff、完成工作的決策與陷阱、4 筆 Knowledge、3 頁 Knowledge page，以及 9 筆未結項；資料庫只在記憶體中建立，不讀取 `data/` 或使用者資料。一般未結項頁面為 2,183 字元；另透過合法的舊格式匯入資料建立超過 4,000 字元的全文，確認 storage 與匯出／匯入保留全文，而 MCP 單筆最多回傳 4,000 字元並以 `textTruncated: true` 標示截短。另一個邊界案例以合法的 4,000 字元項目文字作為輸入，同時把合成專案名稱與 Session title 設成含引號、反斜線及換行的超長已存 metadata；測試量完整序列化後的 MCP JSON，確認未結項頁面不超過 30,000 UTF-16 code units，且縮短欄位均帶對應的 `Truncated` 標記。最近一次本機測試中，這個最長頁面為 22,270 UTF-16 code units；MCP 專用 `pageSize` 預設及上限為 5、傳入 6 會被拒絕。REST 仍使用共用的 100 筆上限並保留完整文字。

MCP 清單 regression test（`tests/mcp/tools-list-budget.test.ts`）以 MCP SDK 的 `Client` 和 linked in-memory transport 連接真實 server，對 `JSON.stringify(await client.listTools()).length` 直接量測完整序列化 tools/list 結果。這是 JavaScript UTF-16 code units（`.length`），不是只量 descriptions，也不是 UTF-8 bytes 或 token。A1 merge 的 44-tool 基線為 **81,487 code units**；把所有 description 設為空仍有 **46,474 code units**，所以必須縮減重複 schema/tool metadata。A2 的四 dispatcher 結果為 **3,769 code units**（比 A1 減少 95.4%），低於 **30,000 code units** 上限；A2 當時涵蓋 44 個 operation，第八輪 C1 新增唯讀未結項列表後為 45 個；第九輪 B3 新增整理請求／context／提交三項後為 48 個。測試逐一透過 `Client.callTool()` 路由所有 operation，確認操作索引 resource（上限 6,000 code units）列出每個 operation 與 dispatcher，且每個 `tool-contracts/{operation}` resource（單一上限 12,000）提供完整 schema、behavior、runtime validation 規則及 annotations，涵蓋錯誤回應與各安全分類；另測試任何層級的未知參數鍵都會被拒絕而非靜默丟棄。測試只使用 `:memory:` storage，不讀取使用者資料庫或任意本機路徑。

| MCP 工具與情境 | 第七輪開始前（字元） | 目前（字元） | CI 上限（字元） |
| --- | ---: | ---: | ---: |
| `work_get_context`，無 task | 16,175 | 15,833 | 16,000 |
| `work_get_context`，有 task | 26,247 | 9,038 | 10,000 |
| `work_recall`，預設 8 筆 | 6,807 | 3,799 | 7,000 |
| `work_recall`，5 筆 | 4,741 | 2,532 | 3,500 |
| `work_search`，預設 20 筆 | 15,896 | 7,128 | 8,000 |

- 第七輪開始前的數字是縮排 JSON；目前欄位取自第九輪 B3 最終合成回應大小測試，保留未結項脈絡；差距同時來自內容調整與移除縮排。待審整理請求另有獨立的 context 預算情境。
- context 的上限以緊湊 JSON 計算；省略清單只計數已在其他區出現的項目，預算省略每區最多列 5 個 id，所以省略資訊不會擠掉相關內容。
- 來源核對壓力情境（20 個已引用 Session 全部更正）另有測試：無 task 15,555、有 task 9,590 字元，同樣守住上限並保留核對旗標。
- 檢索品質門檻獨立執行，避免靠移除正確結果縮小回應。

## MCP runtime 更新偵測

`tests/shared/mcp-runtime.test.ts` 與 `tests/mcp/server.test.ts` 以暫存 runtime installation 模擬 MCP dist、workspace dependency dist 在連線啟動後更新，並檢查 incomplete build、缺少 dist、多個 heartbeat、過期／損毀 lease、正常退出只清自己的 lease，以及 build finalizer 注入 fingerprint 後再讀取 identity 一致。`tests/server/doctor.test.ts` 與 `tests/server/server.test.ts` 以暫存 repository、HOME、Codex／Claude config roots 和 lease 驗證 Doctor/API 共用唯讀 Agent 診斷；涵蓋 registered／missing／unknown、skill hash drift、malformed JSON、malformed Codex TOML（MCP 表內外與 EOF comment）及不可讀 hook 設定，並比對設定檔檢查前後位元組相同。兩者的「無法確認 lease 目錄」案例把 registry 目錄換成同名空檔案、結束時還原，不依賴權限位元，所以 Windows 與以 root 執行的環境也會跑到。`tests/server/user-service.test.ts` 只在 OS 暫存目錄比對 macOS、Windows、Linux 服務設定內容，使用假服務管理器確認先預覽再確認、取消時沒有寫入、移除時保留資料與未支援平台不執行服務命令；CI 不安裝或操作實際服務。E2E 以隔離 Agent home 驗證系統狀態頁（含服務狀態）、重新整理、首次使用四步與零 API 寫入。這些測試不讀寫實際資料庫或 Agent 設定。

`tests/server/plugin.test.ts` 檢查 Claude Code／Codex plugin：manifest 版本等於根目錄 `package.json`、兩個 Agent 都經 `scripts/launch.mjs` 啟動 MCP、plugin 內的 skill 與 `.agents/skills/work-intelligence/SKILL.md` 相同、兩個 marketplace 都列出它；再以暫存 HOME 與假 repository 驗證啟動器依 `WORK_INTELLIGENCE_HOME`、所在 repository、`plugin-link.json` 尋找 checkout、原樣轉送 stdin／stdout／exit code、找不到或未 build 時 MCP 失敗而 Stop hook 靜默放行，以及 `pnpm plugin:link` 與 Doctor 對已啟用 plugin、重複註冊的判斷。`tests/server/plugin-bundle.test.ts` 執行 `pnpm build:plugin`，確認 plugin、zip 與 `.mcpb` 內容，並在暫存 HOME、沒有 checkout 的情況下透過啟動器與內附 MCP server 握手、讀取 skill resource，檢查資料庫落在 `~/.work-intelligence/data` 或連結的 checkout；`tests/mcp/database-location.test.ts` 確認 repo build 的資料庫路徑不受 plugin 連結影響。`pnpm test:standalone`（`scripts/smoke-standalone.mjs`，需先 `pnpm build`）在暫存目錄建置獨立套件、解開 tarball，以假的 HOME 與空閒 port 跑 `start`／`track`／`db backups`／`check`／MCP stdio，細節見 [standalone.md](standalone.md)。`tests/server/dashboard.test.ts` 以暫存 port 驗證 `pnpm dashboard`：server 已在執行時只印出網址、未執行時在背景啟動並等待 `/api/health`、port 被其他程式占用或未 build 時說明原因，以及 plugin launcher 的 `dashboard` 指令會略過 Codex 未 build 的 marketplace clone。

Root `pnpm build` 在任何 runtime dist 清理前建立排他的進行標記，完成所有 workspace builds 與 MCP entry fingerprint 注入後才移除；直接 runtime package build 使用相同標記。失敗時標記保留，狀態以 unknown 呈現。

## 效能回歸門檻

```powershell
pnpm build
pnpm test:performance
```

Storage 的匯入效能測試以虛構資料組成 5,000 個 Session 與 50,000 筆 events，要求只計時的匯入階段在 20 秒內完成；資料建置時間不計入門檻。讀取基準則在暫存目錄建立 2 個 tracked 專案與 5,000 個 Session，預熱後各執行 15 次，以 p90 和下列寬鬆上限判定，避免單一排程尖峰造成失敗：

| 關鍵路徑 | p90 上限 |
| --- | ---: |
| Session 列表（預設第一頁） | 200 ms |
| Dashboard | 250 ms |
| 提醒聚合（八類混合來源，每類最多 200 筆） | 500 ms |
| 週報 | 750 ms |
| 年報 | 1,500 ms |
| 報告 Agent context（年度固定來源請求；第 1 頁含報告區塊，第 2 頁只含該頁 Session 與 evidence；第 2 頁本機 p90 38.9 ms） | 各 1,500 ms |
| Agent context | 500 ms |
| 單一專案 Agent context（含 3 個常駐知識頁摘要） | 500 ms |
| metadata follow-up count（5,000 個 tracked Sessions；計數需與完整預覽總數一致） | 100 ms |
| metadata follow-up count（每次計時前由另一個連線寫入一筆 project data，必須重新掃描） | 100 ms |
| `requestKnowledgeCandidates selection`（5,000 Sessions 的獨立副本，含已確認決策、延續連結、驗證修復與重讀訊號；每次計時前清掉候選請求；為未涵蓋的 Session 計分、選出前 10 筆並寫入請求） | 250 ms |
| `getContext with knowledge backlog (cold token)`（同一份副本；每次計時前由另一個連線寫入一筆 project data 並清掉候選請求，必須重新計分；回應必須帶 `knowledgeBacklog`） | 500 ms |
| `getContext with knowledge backlog (warm token)`（資料未變，只讀資料變更序號，不再計分） | 500 ms |
| 大量變更後第一次讀取（另一份資料庫副本上 5,000 筆 Session 待更新索引，讀取前全部重建） | 1,500 ms |
| 知識頁列表含過時判斷（3 頁 × 一年的 Session） | 250 ms |
| finalize 知識頁維護提示（3 頁 × 5,000 個新 Session） | 250 ms |
| task context 相關未結項（5,000 Sessions／1,000 項，含文字與路徑排名） | 500 ms |
| finalize 相關未結項提示（5,000 Sessions／1,000 項；目標專案 500 項，唯一匹配加 23 個干擾詞） | 操作 p90 250 ms；交易 p90 50 ms |
| 知識頁 review context（涵蓋範圍後的一年 Session，最多 60 筆） | 250 ms |
| 知識頁 not_found 診斷（列出專案 slug、比對 id 與編輯距離） | 50 ms |
| 知識搜尋寬鬆備援（嚴格零命中後的 FTS 排序、`appliesTo` 路徑比對與其他狀態計數） | 250 ms |
| 檔案歷史（3 個路徑、每個 28–125 筆 Session：整段歷史統計、摘要、驗證失敗／未執行提醒與 `appliesTo` Knowledge；本機 p90 2.98 ms） | 50 ms |
| `appliesTo` glob 比對（儲存的大量星號樣式對 3 個 500 字元路徑；不回溯的比對器，本機 p90 0.44 ms） | 20 ms |
| `appliesTo` glob 比對（30 筆 500 個星號的樣式對 20 個 1,000 字元路徑；超過 16 個星號的樣式不模擬即拒絕，未設上限時約 3.5 秒；本機 p90 0.7 ms） | 20 ms |
| `appliesTo` 掃描（16 個星號、字面片段都在路徑中的最貴樣式，跑到比對預算用完；1.6.26 預算改以字元操作計、約 100 ms 目標，本機 p90 69.7 ms） | 250 ms |
| `appliesTo` 掃描（2 個星號夾約 600 字元近似重複的字面片段，2,000 筆 × 30 項 × 20 個 1,000 字元路徑，跑到預算用完；1.6.25 每組只計 1 步、約 50 秒；本機 p90 63.2 ms） | 250 ms |
| `appliesTo` 儲存項目（2 MB 的單一項目不解析即略過（1.6.27 起解析每字元計 4 單位，超過約 2.5 MB 的清單在 SQL 端就不載入，所以改用 2 MB），之後不重複的 1,000 字元項目逐一編譯直到預算用完；1.6.25 編譯 5 MB 項目約 1.7 秒、674 MB；本機 p90 89.9 ms） | 250 ms |
| Knowledge 候選重疊檢查（30 筆候選對同專案 500 筆 Knowledge，每筆既有記錄只斷詞一次；本機 p90 32.9 ms） | 150 ms |
| Session 列表依 commit 前綴（`work_list_sessions` 的 `commitSha`：歧義檢查、計數與一頁；合成 Session 沒有 commit，量的是索引 seek，本機 p90 0.2 ms） | 50 ms |
| 未結項清單（5,000 個 Session 中的 1,000 筆合成項目） | 250 ms |
| 未結項清單（來源 Session 完成日期區間） | 250 ms |
| 工作歷程搜尋（`search`） | 500 ms |
| 依月份範圍的排序檢索（`recall` 帶 `from`／`to`） | 500 ms |
| 同義詞擴展排序檢索（`q=endpoint performance`） | 500 ms |
| 帶 `paths` 的排序檢索（`recall (paths, appliesTo)`：兩個路徑比對 20 筆只靠 `appliesTo` 連到檔案的 Knowledge，含有界的 `appliesTo` 掃描與信任批次查詢） | 250 ms |
| 帶 `task`／`paths` 的 Agent context（`getContext (paths, appliesTo-matched Knowledge)`：同一批 Knowledge 以 `appliesTo` 命中並放進 `relevant.knowledge`） | 500 ms |
| 熱點檔案（全部期間前 20 名；依目錄、單月） | 各 500 ms |
| 圖譜含推導關係、兩節點路徑（500 節點內 BFS） | 各 750 ms |
| 時間軸（單月；一整年，最多 2,000 筆 Session） | 250 ms；750 ms |
| 工作熱度日曆（一整年，每日 Session 計數，本地日於記憶體分桶） | 250 ms |
| Agent 讀取各工具耗時統計（`summarizeAgentReads`，5,000 筆稽核、12 個工具，含失敗與無耗時舊紀錄） | 100 ms |
| Knowledge 列表含過時判斷（20 筆 Knowledge × 一年的 Session） | 500 ms |
| Knowledge 列表搜尋最壞情況（另一份資料庫：200 筆 × 30 項 1,000 字元 `appliesTo`，8 個 200 字元近似詞；每筆成本固定、讀完全部且沒有 `warnings`，與筆數成正比；1.6.26 的 `LIKE` 約 15.7 秒，本機 p90 287 ms） | 1,000 ms |
| finalize `knowledgeToReview` 最壞情況（200 筆候選、5,000 個之後的 Session 各 20 × 100 字元檔案，最舊的一個碰到全部候選；1.6.26 每筆候選各掃一次約 2.9 秒，本機 p90 23 ms） | 250 ms |
| Knowledge 讀取的過時判斷（之後 5,000 個 Session 各 20 × 100 字元檔案；1.6.28 起以每次呼叫建立的不同路徑索引解析，讀完且不標 `stalenessUnchecked`；1.6.26 以 `.all()` 讀 50 × 100 字元約 433 ms、235 MB，本機 p90 188 ms） | 500 ms |
| Knowledge 讀取的過時判斷，1.6.27 審查的不同路徑資料（另一份資料庫：之後 2,000 個 Session 各 50 個不同的約 100 字元路徑，200 筆 Knowledge 各 5 項、其中 2 項為單星號 glob，第一頁 20 筆；1.6.27 逐一比對約 2.9 秒、1.6.14 約 1.0 秒，本機 p90 225 ms） | 1,000 ms |
| Knowledge 讀取的過時判斷遇到 15 星號 glob（同一份資料庫的另一個專案：10 個 Session × 200 個 1,000 字元路徑，20 筆 Knowledge 的 glob 沒有可縮小範圍的路徑段，每個路徑都要模擬；解析上限為 3 億單位時這份資料會全部判斷完，上限較低時則停止並標 `stalenessUnchecked`，案例只限制耗時；停止本身由 `tests/storage/later-change-index.test.ts` 以注入的上限驗證） | 1,000 ms |
| 手動備份（`createBackup`，整個資料庫快照） | 300 ms |
| 整庫匯出（`exportTo`，`VACUUM INTO`） | 300 ms |
| 專案資料匯出（`exportProjectData`，全部專案） | 400 ms |
| 匯入預覽（`previewProjectDataImport`，全部專案） | 1,500 ms |
| 線上匯入（`importProjectData`，全部專案，資料已存在：驗證、計畫、寫入交易與索引同步都在 worker；1.6.29 新增，本機 p90 580–604 ms、事件迴圈阻塞 p90 約 14 ms；1.6.30 起沒有變更的匯入不寫匯入前備份，本機 p90 414 ms、事件迴圈阻塞 p90 約 12 ms） | 1,500 ms |

備份、整庫匯出、專案資料匯出、匯入預覽與線上匯入各跑 5 次。操作總時間單獨量測，不同時送出 health 請求；health p90 另以另一個 client pass 量測，在整個重操作期間每 10 ms 持續呼叫 `/api/health`。API 程序在操作 pass 期間用 `monitorEventLoopDelay`（10 ms resolution）連續量測主執行緒延遲。每個案例 p90 是 5 次中的最大值。原有 300／300／400／1,500 ms 門檻不變，分別同時套用到 health p90 與 HTTP 操作總時間 p90。事件迴圈阻塞另設 100 ms p90 上限：既有 Ubuntu CI 四項 p90 約 11.26、13.30、44.83、13.66 ms，兩倍最高值為 89.66 ms，依既有規則進位到百毫秒為 100 ms。任一門檻超出都會令 gate 失敗。

5.3 的 focused case 可用 `--case=finalize-related-reminder` 單獨執行。Bench 以唯一合成候選項和 23 個不匹配詞確認提醒內容只回傳該候選，並另外量測最外層 `BEGIN IMMEDIATE` 到 `COMMIT` 的 p90。操作總時間維持原有 250 ms 上限；寫入交易另設 50 ms 上限，低於 main 的三次交易 p90（54.67、75.40、126.44 ms），並高於 branch 的三次交易 p90（23.14、31.06、46.88 ms）。交易量只含寫入鎖持有時間，不含 commit 後的提醒查詢。

2026-11-06 在 Windows／Node 24.16.0 使用同一份 5,000 Sessions 合成快取，兩個專案共 1,000 個待辦（目標專案 500 個）；每個獨立 bench 行程跑 15 次，三組都依序 main → branch。每組操作 p90／交易 p90 為：main 89.77／54.67 → branch 83.79／23.14 ms；main 114.06／75.40 → branch 112.98／31.06 ms；main 146.99／126.44 → branch 146.95／46.88 ms。所有操作 p90 都在原有 250 ms 上限內；三組交易 p90 分別降低 57.7%、58.8%、62.9%。最後一組以含 50 ms 交易門檻的 bench 執行，main 如預期因交易 p90 超標失敗，branch 通過。

`operationP90Ms` 從 client 開始送出重工作請求，到完整讀完 API 回應，包含 worker `postMessage`、結構化複製的請求／回應資料、JSON 輸出和傳輸成本。專案匯出在 worker 將 JSON 編碼為 UTF-8 bytes，轉移 ArrayBuffer 回主執行緒，避免 structured-clone 複製大型字串；HTTP body 仍是相同 JSON bytes。匯入預覽會在 API 收到原始 bytes 後把 ArrayBuffer 轉移給 worker，由 worker 解析與驗證大型 JSON，避免主執行緒同步解析。worker 模式另列冷啟動操作時間：每筆請求建立新的 worker client，HTTP 計時包含 worker 啟動，回應後的 worker 關閉不計入；此欄只回報，不設門檻。bench 另以 10 ms 取樣列出各操作的程序 RSS 峰值，並在一次合成自動備份後等待 worker idle close 再列閒置 RSS；穩態 bench 與正式 server 都使用 15 秒 idle timeout。四個重案例不讀共用 store，而是讀種子資料建好、任何案例執行前（WAL checkpoint 後）複製出的同一份資料庫檔：其他案例會寫入共用 store（finalize 案例新增 Session 與每輪的 Knowledge、未結項清理等），1.6.26 以前完整執行到重案例時共用檔已比只跑 `--backup-worker-only` 時大約 5%（26.5 → 27.9 MB），備份與匯出複製的檔案也跟著變大。結果表的 `databaseBytes` 是重案例看到的檔案大小，完整執行與 `--backup-worker-only`（同一份 `WI_BENCH_CACHE`）相同（26,484,736 bytes）。`createBackup` 寫入暫存根目錄下的 `backups/`，`exportTo` 寫入 `export/`，兩者在每次計時前清空（不計入時間）；匯入預覽與線上匯入使用計時前先匯出一次的全部專案資料，所以每筆 Session 都判定為已存在；線上匯入每次只寫入一筆匯入稽核，其餘資料不變；1.6.30 起它沒有任何變更，所以不寫 `pre-import-` 備份（bench 檢查回應 `changed: false` 且沒有 `backupFileName`），所以排在四個重案例之後。1.6.29 只驗證一次匯入檔並把匯出的遮蔽改為先找必要字面再跑規則：本機三次 `pnpm test:performance` 的匯入預覽 p90 由 897 ms 降為 347–402 ms，專案資料匯出由 334 ms 降為 245–300 ms，`exportTo` 程式未變（189–269 ms 之間的差異來自機器負載，三次為 211–247 ms）。其他讀取案例仍共用 store，會看到前面 finalize 案例新增的約 48 個 Session 與 16 筆 Knowledge（約 1%）；年報 ANALYZE、大量變更後第一次讀取、候選重疊與 1.6.27 的儲存文字最壞情況各用自己的資料庫。 這四個重工作案例排在所有其他案例之前執行：它們只讀自己的快照，不影響其他案例；排在最後時，量到的是作業系統還在寫出先前案例產物（待更新文件的副本、最壞情況的資料庫）時的 I/O，Ubuntu CI 曾因此讓 `createBackup` 由 133 ms 升到 193–213 ms、`exportTo` 由 225 ms 升到 262–305 ms，而所有 CPU 型案例不變。

經驗證的快照先寫進同一目錄內的私有 staging directory，quick check 成功後優先以 `linkSync` 原子建立正式目標。若 hard link 失敗且錯誤不是 `EEXIST`，程式以 `openSync(target, "wx")` 專有地建立目的檔佔位，再將 staging 檔 `renameSync` 到目的路徑；佔位會阻止另一個遵循相同 no-clobber 流程的程序發布同名檔。若佔位建立遇到 `EEXIST`，保留既有目標；若 rename 失敗，刪除本次佔位並回報原始 rename 錯誤。備份、匯出或 migration 前備份完成後，目標目錄只留下正式輸出，沒有 `.wi-publish-*` 鎖檔或 staging 目錄。

修改前後比對使用獨立行程、相同 5,000 Sessions 快取資料庫，各跑 3 輪並交錯 control／worker 順序，最後取每輪 p90 的中位數。只量這四項可執行：

```powershell
node packages/storage/bench/read-paths.bench.mjs 5000 --check --backup-worker-only --backup-worker-mode=sync
node packages/storage/bench/read-paths.bench.mjs 5000 --check --backup-worker-only --backup-worker-mode=worker
```

使用基準 checkout 的建置產物時，將 `WI_BACKUP_BENCH_BUILD_ROOT` 指向該獨立 checkout；`WI_BENCH_CACHE`、`WORK_INTELLIGENCE_DB`、`TEMP` 與 `HOME` 應全部指向暫存位置。沒有 `--backup-worker-only` 時，`pnpm test:performance` 仍會執行完整讀取路徑套件。

搜尋的上限原本是 10,000 ms。修正全文搜尋的 join 順序後（見 `search-repository.ts` 的 `CROSS JOIN` 註解），中位數從約 2,000 ms 降到約 13 ms，因此收緊到 500 ms，讓同樣數量級的退化會直接失敗。新增讀取路徑時，請在 `read-paths.bench.mjs` 加上對應情境與上限。

`getGraph (default 180 nodes)` 量測預設 Graph（最多 180 個節點）：只讀取必要欄位並只解碼可顯示的 Session 候選範圍，總數由 SQL 聚合；bench 在計時前驗證結果被截斷在 180 個節點。上限 250 ms 為寬鬆 CI 門檻。可用 `--case=<完整案例名稱>` 只跑該案例，例如 `node packages/storage/bench/read-paths.bench.mjs 5000 --check --case="getGraph (default 180 nodes)"`。`tests/storage/graph-candidates.test.ts` 以固定預期檔 `tests/storage/fixtures/graph-candidates.golden.json`（由舊的全量載入實作產生）比對節點、邊、總數、截斷旗標與排序，涵蓋 limit／maxNodes／maxEdges、單一專案、cursor 逐頁、作廢 Session、暫停專案、壞掉的舊 changed-files JSON 與 Session 連結。

`getReport year (after ANALYZE)` 以 `VACUUM INTO` 複製 bench 資料庫、在副本執行 `ANALYZE`（等同 `db:maintain`）後量年報，並要求輸出與未 ANALYZE 的年報完全相同；p90 上限沿用年報的 1,500 ms。這個門檻很寬、只擋數量級退化，精確防線是 `tests/storage/report-decision-plan.test.ts`：ANALYZE 後以 `EXPLAIN QUERY PLAN` 斷言決策總數與待處理決策兩條查詢仍以 `session_decisions` 為外層（不是 `sessions` 的 `completed_at` 範圍掃描）。`tests/storage/attention.test.ts` 的 fingerprint 案例涵蓋 outstanding 與 Knowledge page 來源的新增、更新、刪除、作廢，以及無變動時 `sourceRevision` 不變。

`summarizeAgentReads (5,000 rows)` 在 bench 資料庫寫入一個完整保留窗（5,000 筆合成 Agent 讀取稽核，12 個工具、3 個 Agent，每 50 筆一筆 `database_busy`、每 20 筆一筆沒有耗時），以一次 SELECT 讀出 tool／耗時／錯誤代碼，在記憶體依工具分組並各排序一次求 nearest-rank p50／p95。計時前檢查 12 個工具都有 p95。2026-11-07 macOS 本機量測 p90 13.99 ms（median 12.7 ms），上限 100 ms 只擋數量級退化。

`finalizeSession (changed files, Knowledge review)` 量測真實大小的收尾寫入：20 個變更路徑與待辦來源 Session 及 Knowledge `appliesTo` 重疊，相關未結項的路徑評分與 `knowledgeToReview` 掃描都實際執行；種子的模組 Knowledge 早已可能過時（提早結束），每次計時前另記錄一筆從未被改過、建立時間早於所有 Session 的 Knowledge，讓檢查走完所有後續 Session；計時前後檢查結果含相關未結項，且 `knowledgeToReview` 只列這筆。操作 p90 上限 250 ms、寫入交易 p90 上限 50 ms（與 `finalizeSession (related pending reminder)` 相同，兩者都量交易時間）。相關未結項改為一次讀出 pending 候選、在 JavaScript 評分；`tests/storage/outstanding-item-relevance.test.ts` 是改寫前以原 SQL 評分固定下來的特性測試，涵蓋同分依完成時間／Session id／位置排序、大小寫與反斜線、改名、目錄前綴與後綴、段落邊界及只折疊 ASCII 的大小寫規則。

`metadata follow-up count` 獨立量測 `work_get_context` 使用的 SQL 聚合，不建立完整預覽 DTO；bench 在計時前用 JavaScript 預覽 totals 驗證 SQL 結果完全相同。5,000 筆完整預覽的既有本機 p90 約 58 ms，因此 count-only 路徑設 100 ms 上限；完整明細預覽仍保留原本路徑與回傳內容。

`metadata follow-up count` 的結果依資料庫識別、`data_revision` 與 `schema_version` 快取在每個連線上，所以原本的案例現在量的是重複讀取；`metadata follow-up count（after a write）` 在每次計時前由第二個連線更新一筆專案資料，量的是快取失效後的完整掃描，上限沿用 100 ms。`first read after 5,000 dirty documents` 在 VACUUM INTO 的獨立副本上每次計時前把 5,000 筆 Session 標成待更新，再量第一次 `search`（含整批重建索引），並在計時內確認 `search_dirty` 已清空；放在副本上是為了不讓反覆重建 FTS 影響之後的備份與匯出案例。本機 5,000 Sessions、三輪交錯的中位數：重建由 839 ms 降到 572 ms（20,000 Sessions 時 935 → 602 ms），上限 1,500 ms 只擋數量級退化；Dashboard 與 Agent context 的上限依修改後本機 p90（約 5.4 ms、26 ms）收緊為 250 ms 與 500 ms。`tests/storage/read-path-equivalence.test.ts` 以修改前的實作作為 oracle，比對 recall／寬鬆 Knowledge 搜尋／focused context 的排序輸出、逐筆與整批重建索引後的 chunks、rowid、paths 與 FTS 分數、文字查詢 Session 列表（含超出最後一頁與 `pageSize: 0`），以及改用 `CROSS JOIN` 的列表、Dashboard 事件數與熱點期間查詢；`tests/storage/data-revision-cache.test.ts` 用第二個 store 與原始連線模擬另一個程序，涵蓋跨連線寫入、專案範圍與 policy、交易中與 rollback 後同一個 revision 數字、DDL 與資料庫識別變更。

第九輪 B1 在相同 5,000 Sessions／1,000 合成未結項中新增來源完成日期的月份篩選，p90 為 1.62 ms（上限 250 ms）；既有未結項列表 p90 為 7.89 ms。28 組讀取門檻全部通過。批次測試涵蓋 100／101 項、重複／無效 ID、作廢來源、停用專案、狀態衝突、無變更不追加稽核與稽核失敗整批回滾；瀏覽器測試涵蓋跨頁復原、日期 URL／reload，以及 1440／960／375px 的區塊內捲動。

效能基準使用合成 SQLite，寫在系統暫存目錄；不讀寫 `data/` 下的使用中資料庫。若要列出所有讀取路徑的 median、p90 與 max（不套用失敗門檻），可執行：

```powershell
$env:WI_BENCH_CACHE = "$env:TEMP\wi-bench"; pnpm exec node packages/storage/bench/read-paths.bench.mjs 5000
```

設定 `WI_BENCH_CACHE` 會保留合成資料庫供修改前後比較；不設定時資料庫會在執行後移除。

## 檢索品質回歸門檻

`tests/storage/retrieval-quality.test.ts` 以 20 題虛構查詢和暫存目錄的合成專案資料，透過 `WorkIntelligenceStore.recall` 評估 `work_recall` 使用的排序路徑。評估包含 K（gotcha／pattern）、S（Session 主題）、R（答案只在 raw handoff）、N（自然語句）與 P（路徑查詢）五類，各 4 題；題目涵蓋中文雙字詞、原始交接文件與絕對／相對／Windows 形式路徑。每題都放入合成近似干擾紀錄，以檢查正確答案排名。額外的 B1 合成案例獨立驗證固定詞彙擴展與完成紀錄對舊規劃片段的排序，不計入這 20 題分類指標。

另有一個證據強度案例：三筆內容相同的 Knowledge 中，被 Session 確認兩次的排第一，被推翻的排在未回饋的之後。目前合成基線為整體 hit@5 1.00、MRR 0.90。門檻設定為整體 hit@5 ≥ 0.95、MRR ≥ 0.90；每一類 hit@5 ≥ 0.75，K／S／N／P 的 MRR ≥ 0.70，R 類 MRR ≥ 0.50。R 類答案只在 raw handoff，並刻意搭配共享部分查詢詞的標題干擾項；目前四題都排第 2，反映 raw 欄位較低的權重，因此以 0.50 作為該類不退化的基線。hit@5 表示正確 Session／Knowledge 是否進入前 5 筆，MRR 以正確項目的排名倒數取平均；沒有命中時計 0。測試不開啟 `data/work-intelligence.sqlite`，不使用私有的 36 題評估資料，也不將真實工作記錄寫入 repository。

B1 的固定軟體用語表只存在原始碼，不呼叫外部服務，也不由模型推測，包含 endpoint／API／路由／route、慣例／convention、效能／performance、測試／test、設定／config、遷移／migration。原詞照原權重計分；同義擴展另行計分，權重為 0.2，原詞已有分數時，擴展對單筆結果的加分最多為原詞文字分數的 25%；只有同義詞命中時，只取最強的單一 chunk 或 raw 片段，不累加多個片段。只靠同義詞找到的結果可作為 `low` 信心的線索；`termHits`、原詞命中比例與 `high` 判斷仍只看使用者原詞，因此同義詞不能把結果推成 `high`。合成案例確認「新增 REST endpoint 的慣例」能在前三名找到只寫「路由」的紀錄，同義詞命中不會改變原詞信心度與 `termHits`，而多個 alias-bearing chunks 不會累加放大 synonym-only 分數。另以「repositoryUrl、commit 與編輯器」查詢確認已完成紀錄排在重複舊規劃片段之前。

原詞命中仍依文件頻率估算 IDF；命中覆蓋低於 10% 且沒有路徑或同義詞候選時回傳空 hits 與 `none`，只有弱部分命中或同義詞線索時回傳 `low`，至少一筆以原詞在結構化欄位達 50% 覆蓋或命中路徑時回傳 `high`。B1 前後的定向測試直接鎖定既有分類指標：K hit@5／MRR=1.00／1.00、S=1.00／1.00、R=1.00／0.50、N=1.00／1.00、P=1.00／1.00。本次 `pnpm test:retrieval-quality` 24/24 通過，五類指標與基線一致；重新建置 storage 套件後，5,000 筆 Session 的 performance gate 含同義詞擴展 recall，19/19 通過。本次實測 p90：`search` 11.62 ms、月份範圍 recall 13.85 ms、同義詞擴展 recall 1.42 ms；三者上限皆為 500 ms。精確查詢的排序仍受上述 hit@5／MRR 門檻保護，`work_get_context`、`work_recall` 與 `work_search` 都檢查無命中訊號。

1.6.30 起，回傳的 hits 中 Knowledge 會排在自己來源 Session 的正上方（只調整順序，不改分數與回傳的記錄）；`pnpm test:retrieval-quality` 25/25 通過，五類指標在這條規則前後完全相同（K／S／R／N／P 同上）。`tests/storage/search-repository.test.ts` 以合成資料檢查這條規則：分數不變、同一 Session 的多筆 Knowledge 各自就位、limit 外的 Knowledge 不會被帶進來，以及不跨專案。

B2 加入重複規劃片段的反例：八筆合成 Session 共用舊 handoff 片段，分別以「新增 REST endpoint 的慣例」與「FTS 效能問題」查詢時，已完成的路由拆分與 FTS 修正 Session 必須排第一。Raw section 先做 NFKC、空白與大小寫正規化並存 SHA-256；同一專案最早的 Session 保留完整 raw 欄位權重，重複引用只計 10%，結構化 Session 欄位的權重高於 raw handoff。Schema 20 對既有索引加上衍生 `content_hash` 欄位並把舊 Session 標為待重建；`project-data-coverage` 確認此欄位留在可重建搜尋索引，不當作可匯出的專案資料。檢索品質案例另確認正確命中仍保留在結果內。

```powershell
pnpm test:retrieval-quality
```

一般 `pnpm test` 已包含此評估；Ubuntu CI 另有獨立步驟，方便直接看到檢索指標回歸。

`pnpm test:coverage` 使用 V8。core 的四項門檻皆為 100%；project-policy 為 95%／90%／100%／95%，branch 門檻依 Windows 92.75% 基線保留跨平台餘裕；shared 為 90%／80%／100%／90%。schema 的四項門檻為 90%（新增 schema，包括 MCP 專用 input schema，都要補測試才會過）；storage 以 `packages/storage/src/**/*.ts` 量測，對 27 個高風險檔案各設門檻（維持 handoff parser 85%／70%／90%／85% 不降）：政策與隱私邊界（`policy-helper`、`secret-redaction`、`diagram-source-redaction`、`path-safety`、`project-path-remap`、`agent-read-audit-service`）、報告與 Agent 投影（`report-synthesis-service`、`report-agent-view`、`report-service`、`report-builder`）、attention／related-work／未結項（`attention-service`、`related-work-service`、`outstanding-item-service`、`outstanding-cleanup-service`）、知識與檢索（`knowledge-page-service`、`knowledge-candidates`、`knowledge-service`、`context-recall-service`、`search-repository`）、資料搬移與刪除（`project-data-transfer`、`project-deletion-service`、`session-deletion-service`、`session-record-service`、`sqlite-transaction`、`sqlite-errors`、`schema-migrations`、`backup`）。各檔門檻為實測值往下取整再減約 2 個百分點，branches 多留 3–5 點（實測於 2026-11-07 macOS，CI 在 Ubuntu 執行，差異由緩衝吸收；若 Linux 實測更低，以 Linux 為準調整）。其餘檔案（`store.ts` facade、僅 CLI 使用的 `database-maintenance`、舊版 `handoff-importer` 等）共用 80%／65%／90%／80% 的底線。`policy-helper` 與 `report-agent-view` 原本只由 server／MCP 測試間接覆蓋，現在有 storage 自己的單元測試。Web 覆蓋率納入 `apps/web/src/stores/**`、`api/**`、`utils/**` 與 `useActiveRequestWatch`；總門檻為 80%／65%／82%／85%，API 各檔門檻為 95%／80%／95%／95%，store 各檔為 75%／55%／70%／80%，utils 各檔為 90%／90%／95%／90%（依序為 statements／branches／functions／lines）。各 store 測試在每個案例建立獨立 Pinia／Pinia Colada query cache，並以 stub fetch 隔離 API。server、MCP 維持既有門檻。Coverage 輸出只寫入被 `.gitignore` 排除的 `coverage/` 目錄。

`pnpm test:e2e` 會先建置 production packages，再以獨立的暫存 SQLite、單一 port `5967` 啟動正式模式測試服務，不會讀寫目前使用中的 `data/work-intelligence.sqlite` 或 `5966` 開發畫面。若 port 已被占用，可改用其他 port：

```powershell
$env:WORK_INTELLIGENCE_E2E_WEB_PORT = "5987"; pnpm exec playwright test
```

C1 的 E2E 另確認工作歷程中的未結項可依專案與狀態篩選、開啟來源 Session、標記完成／不再需要／重新開啟，並覆蓋載入、空清單與錯誤狀態。

E2E 涵蓋：Knowledge 候選（網頁建立請求、以 storage 套件模擬 Agent 回寫後頁面自動出現並接受）、Knowledge 可信度（改到 appliesTo 檔案後標示可能過時、確認仍有效後清除）、metadata 回補請求在 Agent 回寫後自動更新、專案頁「資料備份」立即備份、永久刪除專案前輸入完整名稱確認並顯示備份檔名（workspace sentinel 檔案保留）及刪除後在專案頁檢視不含內容的 audit、AI 報告整理卡（來源 Session、歷史版本、重新整理、Agent 存入結果後頁面自動更新並提示）、報告總覽依區間切換內容、工作歷程與工作報告「原始記錄」列表在桌機／平板／手機撐滿可用高度、保留可見分頁並維持內部捲動、工作歷程／知識的每頁筆數與 virtual list、Graph 篩選、節點搜尋（`?q=`、Enter 選取第一筆、無結果狀態）與節點面板、390px 寬度的 Session 面板、640／390px 各頁無水平捲動、六個主要頁面的 axe 掃描（critical／serious impact 必須為零）、直接路由與 `/worklog` 轉址、`?session=` 深連結、側邊面板拖曳調整寬度並記住、切換為記錄中前的同意對話框、Ctrl／⌘ K 指令面板、Session 面板「編輯 Session」（改主摘要、一段 workSummary 與 verification，未改的段落保留，verification 留下修改紀錄）、Session 作廢／「只看已作廢」篩選／還原。報告日期以測試機器的系統時區計算，與 server 一致。

設定 `UI_SCREENSHOTS=<label>` 會額外把六頁 × 1440／960／375 的截圖寫到 `docs/ui-baseline/<label>/`（已被 `.gitignore` 排除），方便改版前後比對。

資料庫維護測試只使用暫存 SQLite 與虛構 Session：確認搜尋索引可完整重建、維護前會建立並驗證快照、另一連線持有寫入鎖時會拒絕操作，以及 doctor 讀取維護結果時不會改變資料庫檔案雜湊。

Unit／integration 測試涵蓋：

- unknown/unregistered、paused、ignored 不會建立 session
- tracked 才能讀 handoff snapshot 與 Git metadata
- raw handoff、events、changed files、verification 會保存；缺少結構化欄位時會要求 Agent follow-up
- 同一 `idempotencyKey` finalize 不重複寫入
- 兩個 SQLite store connection 同時使用相同 finalize key 仍只保存一筆 Session
- metadata backfill processing timeout recovery、Session metadata／verification transaction 與 MCP payload boundary
- schema 的 changed-files／metadata backfill 陣列上限
- 專案永久刪除的精確名稱確認、in-memory 備份拒絕、備份快照、跨專案 Session 關聯與共享請求清理、搜尋索引清理及不含內容的 audit row
- REST 不接受非 JSON Content-Type，malformed JSON 會回傳安全的 4xx 錯誤
- Agent setup／doctor（`agent-setup.test.ts`、`doctor.test.ts`）只使用暫存 home、Codex／Claude config roots 與測試 repo；涵蓋預覽不寫入、精確備份、重複安裝、skill hash drift、Codex canonical／legacy path、v1 ownership migration、自訂 root 的解除安裝、missing dist、衝突拒寫、失敗 rollback、保留後加設定，以及含 Unicode、空白、引號與反斜線的路徑。
- project-scoped `work_get_context`／`work_recall` 只回傳指定 tracked 專案；未指定範圍時，以 project name／id 標示跨專案結果，paused 專案完全排除（`cross-project-context.test.ts`）
- tracked-only day/week/month/quarter/year 完整報告、上一期比較、趨勢、風險與 source evidence provenance
- changed-file lifecycle history 的新增／修改／刪除／重新命名、路徑正規化、merge dedupe 與 metadata follow-up
- Markdown／JSON 報告匯出與 paused/unregistered project skip
- metadata backfill preview、明確批次更新、duplicate sessionId protection 與 policy skip
- tracked session evidence 的保存、去重、Session Detail／報告呈現與 policy skip
- explicit Knowledge 的 Session provenance、idempotent record、搜尋、context／Session Detail／UI 呈現與 policy skip
- Knowledge update、封存／恢復、預設 active 搜尋與 policy skip
- Knowledge audit history 的 immutable before／after snapshots、changed fields、REST／MCP／UI 與 policy skip
- metadata backfill 的明確 replace／merge 模式、多 stage 路徑 union、provenance dedupe 與 legacy provenance 保留
- tracked-only deterministic graph 的節點／邊、Knowledge／Evidence／changed-file 關聯與 project policy skip
- Graph UI 的 scope filter、節點類型切換、畫面預覽量、資料載入上限、節點／關係統計、可讀預覽與 Session／Knowledge source navigation
- Agent report synthesis request 的建立、bounded context、sourceSessionIds 驗證、摘要回寫、重試 idempotency 與歷史版本保留
- Agent report synthesis request 的逾時回收、舊 Agent 寫入隔離、失敗請求 retry 與 UI 恢復流程
- Reports 的 Evidence 類型／關鍵字篩選只更新證據區塊，不重新渲染整份報告；原始工作紀錄與來源證據提供 10／20／50／100／All 的局部分頁控制
- project root 之外的 source path 會被拒絕
- 日期邊界依系統時區：storage 測試固定以 `TZ=UTC` 執行（`packages/storage/vitest.config.ts`），另有 `Asia/Taipei` 案例驗證篩選、日報與週趨勢的分桶
- Session 列表把 `%`、`_` 當字面字元（Knowledge 搜尋共用同一個跳脫函式）
- 檢索（`search-repository.test.ts`，全部使用虛構合成資料）：多關鍵字、兩字與較長中文詞、自然語句、raw handoff 切段與段落標題、路徑正規化與 changed files 異常降權、Knowledge references 的 commit SHA 分離、編輯／封存／專案狀態變更後索引同步、`termHits`、既有資料庫的索引回填，以及 context 的 `task`／`paths`
- REST 拒絕非 loopback 的 `Host`（421）與不在白名單的 `Origin`（403）
- MCP server 以 in-memory transport 端對端測試：工具清單、annotations、instructions 長度、contract 只掛在寫入工具、prompts、`work_get_project_status`、`work_list_sessions`／`work_get_session`、分頁讀取未結項及 paused 專案 skip、Agent 建立報告／metadata 請求並出現在 context 的 `pendingRequests`

模擬 Agent 的 E2E 會直接開啟 server 使用的暫存 SQLite（`WORK_INTELLIGENCE_E2E_DB`，由 `playwright.config.ts` 設定並傳給 worker），因為候選回寫只有 MCP 工具、沒有 REST。這些測試需要先 `pnpm build`（`pnpm test:e2e` 會自動執行）。

第九輪 B2 先以同一合成資料量測，完整 recall 加上相關未結項的 finalize 提示 p90 為 175.48 ms，原知識頁提示由 B1 的 12.92 ms 增至 139.06 ms。CPU profile 與 SQL plan 顯示完整文字檢索和重複 correlated scans 的成本；改成在收尾以 pending 項目、來源標題／摘要及路徑直接排名，並材料化查詢條件與每筆分數後，相關提示降為 22.59 ms、原提示 18.58 ms；task context 為 155.86 ms，30 組門檻全通過。關鍵字使用既有中英 tokenizer，單次最多 24 個不同詞，路徑最多 20 個；來源摘要評分讀前 2,000 字，task context 額外使用既有前 20 筆 Session 檢索順序，較新的無關項目不會遮掉直接文字／路徑命中的舊項目。所有值均來自隔離合成資料。後續完整檢查的 task context／finalize 相關提示 p90 分別為 128.53／22.73 ms。相關未結項的 SQL 比對涵蓋一般英文大小寫與中文詞；SQLite 內建 lower 不提供完整 Unicode case folding，全形 Latin 或非 ASCII 大寫文字可能漏掉直接命中，排名只作核對指引。

## 資料規模下的排序量測

`pnpm bench:recall-scale [規模] [--json <新檔案>]`（先 `pnpm build`）在 OS 暫存資料夾建立合成資料庫，量測 roadmap Phase 0 第 3 步：正確答案放進大量相似資料後是否還排得到前面。規模是以逗號分隔、遞增的 Session 數，預設 `1000,5000,10000`；同一個資料庫逐級長大，每一級保留前一級的資料。排名與信心由 `pnpm eval:recall` 同一個評估器計算，所以數字可以和私有真實資料基線比較。只寫合成資料，結束時刪除暫存資料夾；`--json` 拒絕覆寫既有檔案。

題目有 12 個正例（K Knowledge、S 結構化 Session、R 答案只在 raw handoff、N 自然語句問句、P 路徑，中英文都有）、2 個未結項題（O，看 `work_get_context` 的 `relevant.outstandingItems`）和 4 個無答案題（X，每個查詢詞都出現在干擾資料中，但沒有一筆回答它）。目標日期最舊，干擾資料較新，因此新舊加權不利於目標。

干擾資料用固定亂數種子產生，每筆都模仿一個目標，但在所有欄位都固定拿掉該目標的一個內容詞，所以沒有一筆真的能回答那題；另外只加入一個來自其他目標的詞，避免拼出第二個答案。每 10 筆有 1 筆是困難近似項，標題含有其餘全部內容詞。資料裡有未結項（約 30% 的 Session）、raw handoff（約 20%）、Evidence（約 20%）和 Knowledge（每 10 筆 Session 約 1 筆，困難近似項會帶一筆同樣用詞的 Gotcha）。Knowledge 的建立與更新時間會改到和 Session 相同的時間軸，否則每筆 Knowledge 都會拿到完整的新近加分。

輸出每一級的 recall／context hit@1、hit@5、MRR、各類別排名與信心分布、無答案題中 `high` 的題目、未結項排名，以及目標沒有排第一時搶到第一名的紀錄（合成標題與命中欄位），方便分辨是候選召回還是排序問題。延遲每題只量一次，而且包含快照與 MCP 往返，同一規模在不同次執行間可以差一倍，只能看趨勢；效能門檻仍以 `pnpm test:performance` 為準。寫入時間會隨資料量增加，在本機 Windows 上 10,000 筆約需 15 分鐘，所以這項量測不放進 CI。

## 第九輪 B3 整理建議驗證

新增整理 request list／5-item＋10-Session context／100-proposal page 的 5,000 Session 基準，各 p90 上限 250 ms；最新完整檢查的 15 次取樣分別為 0.47／3.32／3.86 ms。回應大小測試保護 24,000 字元整理 context、固定 item／Session ID 與截短旗標，以及一般 context 的 pending 整理請求。儲存層／MCP／REST 測試確認提案不改狀態、重試、同專案與時間範圍、source/evidence 更新／作廢、整批回滾、policy skip、錯誤遮罩、migration 22→23、轉移／遮蔽及永久刪除。

建議準確度採獨立 Agent 真正閱讀合成 context 與完整來源，沒有以 hardcoded classifier 測自己。20 個預先建立答案的項目中，12 個確認完成／取代、8 個失敗／部分／回退／草稿或缺證據；Agent 未讀答案，核對 8 頁後提交 12 項正確建議，精確率 12/12、確認案例覆蓋 12/12、證據不足保留 8/8。公開 schema 與實際 storage submit 驗證後 pending 仍 20→20，重試未新增提案。小樣本只是這組合成案例，不代表實際資料的整體準確度；詳細資料見 [B3 合成評估](experiments/outstanding-cleanup-accuracy-2026-10-01.md)。

B3 複檢補上活躍 pending／awaiting_review 快照的 Agent finalize 完成／取代與 nextSteps 移除防護，並確認取消後恢復正常收尾、Web 人工更新仍可用。背景刷新遭後續刷新取消時，批次更新／復原與整理審核保留實際寫入結果；同頁未結項與建議刷新保留仍符合條件的勾選，切換範圍仍清空。回歸案例分別以 AbortError 與實際瀏覽器刷新驗證。

整理面板的三個瀏覽器案例涵蓋逐筆與批次接受／拒絕、接受前原狀、來源與證據跳轉、URL 審核狀態與第二頁重載、1440／960／375px 內部滾輪與鍵盤捲動、axe、Esc 與焦點返回，以及過期建議與取消後唯讀／清除選取。兩種清單均驗證同頁刷新保留仍符合條件的勾選；批次復原案例先確認畫面呈現復原後的本頁成員再重新選取。


## 實驗資料

`docs/experiments/` 保存仍被決策引用的合成實測。腳本只用合成資料或其副本，不接觸正式資料庫；數字是當次機器的樣本，不是產品 SLO。

| 檔案 | 用途 |
| --- | --- |
| `attention-query-probe.mjs`／`.results.json` | 提醒聚合的 SQL 計畫與 CPU profile |
| `related-query-probe.mjs`／`.results.json` | 相關工作索引在 5k／50k Sessions 的首次同步與暖讀取 |
| `related-work-candidates.mjs`／`-2026-10-09.json` | 相關工作候選與全掃描 oracle 的比對 |
| `session-read-projection-2026-10-10.json` | MCP Session 精準讀取的任務成本、p90 與 peak RSS |
| `agent-data-source-audit-2026-09-30.md` | 第八輪工作記錄的來源與時間核對 |
| `outstanding-cleanup-accuracy-2026-10-01.md` | 未結項清理建議的合成準確度評估 |
| `standalone-distribution-spike-2026-10-15.md`／`.mjs` | 不需要 checkout 的發行方式研究與原型 |
| `knowledge-reuse-attribution.mjs` | Knowledge 重用歸因重播（唯讀），說明見下方 Knowledge reuse attribution |

### Knowledge reuse attribution

`docs/experiments/knowledge-reuse-attribution.mjs` is a read-only replay that asks why a Knowledge item that could have been reused in a Session was or was not reported as applied. Run `pnpm build` first, then:

```
node docs/experiments/knowledge-reuse-attribution.mjs --db <database path> [--limit 500] [--json <new file>]
node docs/experiments/knowledge-reuse-attribution.mjs --self-check
```

- Opportunity: a (Session, Knowledge) pair in the same tracked project where the Session is not voided, the Knowledge was created before the Session started, was active then (an unexplained archived row is counted as `excluded_not_active`), its appliesTo covers a changed file by the product's `appliesToStrength` rule, and the Session is not the Knowledge's own source. Reported means a `knowledge_feedback` row of kind `applied`; `contradicted` is counted separately.
- Replay: per Session (once, cached) `getContext` runs with `{task}`, `{paths}` and `{task, paths}` (task = Session title, paths = first 20 changed files). Each pair is `full`, `pointer_only` (id only inside `omitted`) or `absent`. For pairs absent from the combined variant, `recall` (limit 30) gives the cause: `budget_trimmed`, `ranked_behind` or `no_match` (`applies_to_only` when no changed file is among the Knowledge references), plus counts for default `recall` and `getFileHistory` presence. Every class is cross-tabbed by reported, unreported and contradicted.
- Safety: the database is opened read-only and copied with `VACUUM INTO` to a temp folder; the store runs on the copy only and the folder is removed afterwards. The output is aggregate numbers only (no ids, titles, paths or project names); `--json` writes the same object to a new file and refuses to overwrite. `--limit` takes a deterministic every-k-th sample of the opportunities.
- Diagnostics (aggregate counts only, each verified with the product's exported matching functions, first match wins): **A** splits `no_match/applies_to_only` into `beyond_replayed_paths` (no matched file within the 20 replayed paths), `applies_to_budget_or_scan` (the Knowledge is outside the newest 2,000 active rows with appliesTo of its project, or recall carries the appliesTo-truncated warning), `product_matcher_mismatch` (the script's matcher matches a replayed path but `appliesToEntries` + `appliesToStrength` on the normalized queried paths do not), `reserve_crowded` (present in a Knowledge-only recall at limit 30, absent from the mixed one) and `unknown`. **B** profiles `pointer_only` by omitted section, reason (budget or duplicate), possiblyStale and whether it ranked in the recall@20 Knowledge top 5. **C** buckets replayed Sessions by opportunity Knowledge count (1, 2-3, 4-5, 6-10, >10) with full / pointer_only / absent totals. **D** splits absent Knowledge missing from `getFileHistory` of its first three matched files into `outside_scan_set`, `scan_truncated`, `matcher_mismatch`, `crowding_limit5` and `unknown`, with independent tallies of whether a single-file call (up to 10 matched files) finds it and of glob versus plain appliesTo. A shape table of the raw replayed changed-file paths (absolute, backslash, project-name prefix, changed by normalization and so on) shows what the product's path normalization has to absorb. `maybe hidden by moreIds` counts absent pairs whose Knowledge sections kept more omitted ids than the pointer lists (it can overlap any cause).
- `--self-check` (and no `--db`) builds a fictional database through the real store API and asserts the expected counts through the same `--db` path. It also constructs a Knowledge whose only matching file is the 21st changed file, an archived rule outside the scanned set and seven Knowledge on one file (file-history limit of five), and asserts the diagnostic counters above. It constructs full (reported, unreported, contradicted), `pointer_only`, `budget_trimmed`, `ranked_behind`, both `no_match` kinds and the not-an-opportunity cases (Knowledge newer than the Session, archived before the Session, the Knowledge's own source Session).
- Known biases: the replay reads the current database, so Sessions and Knowledge created after the original Session compete in the ranking and recency differs; the Session itself is indexed (supplements sourced from its own applied Knowledge are discarded and counted as `selfSupplementLeak`). Context and recall match `paths` against Knowledge appliesTo (the replay passes the first 20 raw changed files), so appliesTo-only Knowledge beyond those paths or outside the scanned set reaches an Agent only through `getFileHistory().knowledge`, the relaxed Knowledge search or `recentKnowledge`.

## 五項整合 A1 提醒聚合

`tests/storage/attention.test.ts` 使用隔離合成 SQLite 驗證混合來源、原狀態不變、全域請求來源再閘門、paused／unknown／void 排除、最新請求優先、220 個決策與 200 列窗口分開、未知可信度範圍及來源失敗不洩漏正文。REST 測試涵蓋成功、400 參數上限／未知欄位、policy skip、Origin 與固定 500 遮蔽。前端 store 驗證完整 query keys、全域快取共用、報告 server date 及獨立錯誤。

`tests/e2e/attention.spec.ts` 在兩語系、明暗主題及 1440／960／375px 檢查框內鍵盤捲動、URL／reload、axe、無水平溢出，同名 Knowledge 的精確來源歷史與 Esc，以及部分／失敗來源不呈現健康空清單。這些案例標記 cross-browser，三個 Playwright 引擎都執行；不等於 macOS Safari 實機驗收。正式數量及 p90 測量結果待本階段完成後記錄。

## 五項整合 B1 相關工作提示

`tests/storage/related-work.test.ts` 覆蓋同專案／已有雙向關聯、重複與正規化檔名、作廢／停用、未確認／超檔案上限、排序 top-5、dirty 重建、熱門 posting 截短與 FK 永久刪除；派生索引不出現在匯出 bundle。REST 驗證 scope、Origin、嚴格 query 與未知錯誤遮蔽。Web store 驗證晚回應不顯示上筆 Session，錯誤保留重試。E2E 包含 12 種語言／主題／視窗組合、axe、鍵盤切換與不溢出，以及錯誤／部分空結果。

38 項 5,000 Sessions read-path 基準通過；相關工作 p90 2.57ms，gate 250ms。另有 [5k/50k 首次同步、暖讀取、CPU 與 SQL 探測](experiments/related-query-probe.results.json)，明示 50k 初次同步 1.21 秒與 partial，僅使用合成資料庫副本，不接觸正式資料。


## 報告段落呈現回歸

`report-presentation` 的 core／schema／storage／server／store／E2E 測試涵蓋群組呈現與引用保留、版本 CAS／冪等、來源失效拒讀寫、遮蔽及匯入／刪除生命週期。瀏覽器驗證使用純合成資料，涵蓋 375／960／1440px、繁中／英文、明暗主題，包含隱藏／恢復、改稿、axe、頁面溢出與 409 保留草稿及明確比較。此處描述驗證範圍；本機與 CI 結果另記於整合研究文件。

首頁洞察回歸使用超過 200 筆的完整 totals、空前期、同筆數專案及五種 verification 狀態驗證推導；UI 涵蓋雙語、明暗、1440／960／375px、axe、範圍／專案 URL 及載入／錯誤／空結果。沒有新增 API 或 SQL read path。


報告複製測試涵蓋來源拒讀、修訂 409、strict query、SQLite snapshot rollback、投影與引用一致、HTML／Markdown 逸出及基本報告安全輸出。新增 `exportReportPresentation (snapshot and Markdown)` 合成 read benchmark（p90 ≤ 250 ms）。瀏覽器測試在 12 組語言／主題／尺寸中模擬剪貼簿成功與拒絕、檢查預覽／複製一致、手動選取與下載、axe 對話框及來源失效。剪貼簿 stub 不代表 OS 剪貼簿或實機 Safari 已驗證。

### 提醒顯示偏好 A2

儲存層回歸覆蓋隱藏／restore、七天稍後期限與到期、來源同計數／同最新時間替換、source/preference CAS、停用／跨專案／全域來源、可攜式 roundtrip 與舊備份、來源及專案永久刪除、29→30 migration 與 tuple 唯一索引。REST 覆蓋 strict schema、origin、404／409、遮罩內部錯誤與 policy skip。瀏覽器涵蓋雙語／明暗／1440、960、375px 的隱藏、reload、restore、snooze、URL、總數不結案、axe 與 409；Playwright WebKit 不代表實機 Safari。5,000 Session 新增 suppressed preferences 的 p90 上限 500ms，偏好為已檢查來源的批次 lookup。

報告複製收尾同時補上完整匯入只使用指定 fixture 專案、移除 route 前等待已送出請求、來源批次 undo 後重新載入已恢復清單，以及知識頁成功寫入不受背景刷新 AbortError 影響的回歸。完整 E2E 保留三瀏覽器與所有案例；本機以單一 worker 排除跨測試背景寫入競態。

報表複製預覽的三瀏覽器回歸會在「已複製」主按鈕上明確停留滑鼠再跑 axe，涵蓋深色／淺色與繁中／英文，防止標籤寬度改變讓低對比 hover 狀態偶然避開檢查。深色沿用既有合格背景 token，hover 以邊框呈現。

總覽工作熱度版面驗證包含兩語系／明暗／1440、960、375px：熱度完整寬度、位於 KPI／洞察／提醒之前且首屏可見，日期入口導向報告、axe 與實際 scroller 水平邊界。

## 時間軸自動符合區間（2026-10-10）

`tests/e2e/timeline-fit.spec.ts` 的 36 項三瀏覽器案例覆蓋繁中／英文、明暗與 1440／960／375px：首次掛載、手機清單轉桌面、全年期間、resize、手動縮放保留、清單切回圖表、期間切換及 reload。斷言實際 scrollWidth／clientWidth，不先點顯示整個期間按鈕，並執行 axe。

Agent 決策回歸以模擬 SSE 取代背景刷新驗證 Knowledge 建立與來源提升仍回傳成功，並核對兩個寫入只執行一次。

工作熱度的 dashboard-layout E2E 同時核對 53 週 grid 初開／resize 的容器滿寬、無橫向溢位、正方形日期格、最末週可見及鍵盤日期移動，涵蓋雙語／明暗／三尺寸／三瀏覽器。

- Session「可能相關」：`related-work.spec.ts` 在中英文、明暗主題與 1440／960／375px 下檢查說明、日期、標題及長路徑距外框至少 12px，並保留五筆來源、鍵盤跳轉與無障礙檢查。

- 整理未結項：保留本專案已載入資料時，延遲背景清單刷新不會停用建立請求；第一次載入及跨專案資料未知時仍禁止建立，單元與三瀏覽器延遲回應案例檢查此區別。

### 原生圖表與歷史 Mermaid 保留

Schema／REST／MCP／storage 驗證新增圖表必須明確指定 architecture v1；缺少 kind 或版本、Mermaid 寫入與未知版本拒絕，finalize 失敗不留下部分 Session。歷史匯入走獨立 portable schema，保留 source、kind、id、版本、作廢狀態；round-trip、遮蔽、永久刪除與 schema 升級覆蓋維持。跨瀏覽器 E2E 驗證原生 200 節點、歷史來源不執行 HTML、複製成功／失敗、下載原始內容、URL 重載、焦點、雙語主題與 axe。本次實機 Safari／觸控依使用者指示免驗；三瀏覽器自動化結果與實機結果分開記載。

## Session 精準讀取驗證

`session-agent-read.test.ts` 與 MCP dispatcher 測試核對完整模式相容、固定欄位／依賴、歷史缺漏、作廢／拒絕決策／更正驗證、UTF-16 snapshot 長度、實際讀取稽核，以及 WAL 並行寫入下的一致讀取快照。未選資料族群的 SQL 必須為零；無任意欄名或 post-trim full detail。

5,000-Session 效能 gate 加入 completion、handoff 與指定 native source 三例，各 p90 ≤250 ms（寬鬆 CI 門檻）。`node apps/mcp/bench/session-projection.bench.mjs [--projected]` 使用純合成小型／大量附件資料，計入 initialize instructions、tools/list、操作索引、完整 skill、初次操作契約、輸入、所有補查、JSON 文字、SDK envelope、SQL prepare、延遲與獨立程序 peak RSS。handoff 另讀 changed files／Evidence，不能隱藏補查成本。每組工作流先暖機 3 次，再量 15 次；JSON-RPC frames 是 in-memory 訊息的序列化 bytes，並非實體網路流量。`WI_PROJECTION_SOURCE_ROOT` 可指向已建置舊版；`WI_PROJECTION_OUTPUT` 保存 JSON。

可選固定參考 tokenizer：在開發環境安裝 `tiktoken==0.12.0`，設定 `WI_PROJECTION_TOKENIZER_PYTHON`，使用 `scripts/measure-reference-tokens.py` 的 `o200k_base`。這不增加執行期依賴；參考 token／SDK envelope 不是 Codex 實際模型注入量或計費 token。原始快照 metadata 的 UTF-16 長度透過 SQLite scalar function 計算，保持 emoji 語意；讀取指定 raw metadata 時仍必須掃描來源文字，未選 raw 時則完全不查詢它。

MCP 精準讀取前後成本：三組獨立程序的全部任務參考文字 token 中位降幅 30.45%–30.95%，相對 p90、一次補查上限與 peak RSS 110% 門檻均通過。小型 handoff 仍增 4.21%–4.55%，保留完整讀取建議；大型任務下降 60.68%–84.20%。含全部啟動 resource 的原始結果、限制與契約 fingerprint 見 [實驗資料](experiments/session-read-projection-2026-10-10.json)。

架構圖未支援格式的攔截回歸在所有斷言後以 `page.unrouteAll({ behavior: "wait" })` 等待背景 handler，避免 WebKit teardown 先銷毀 `route.fetch()` 回應而誤報 `Response has been disposed`；原 timeout 與 UI／CSP 斷言保留。

`tests/e2e/page-width.spec.ts` 使用側欄實際切換圖譜與其他六個主要頁面，對繁中／英文、明暗及 1920／1440／960／375px 比較內容左右邊界、可用寬度與水平溢位；三瀏覽器各執行16種組合。1920px 舊版可重現切出圖譜後縮窄400px；修正保留響應內距及穩定捲軸預留，不改頁面高度。

架構圖閱讀器在 reload 後的鍵盤 resize 回歸改由 separator locator 發送 Home／ArrowRight，防止面板啟用時的焦點移動讓全域鍵盤輸入落到其他控制項；保留640px響應斷言、22次方向鍵與原timeout。PR #238 CI首輪Chromium此處失敗後完整重跑成功，證據保留，不稱首輪全綠。


## 1.5.1 報告回歸

以隔離 SQLite／MCP client 驗證固定來源不受最新 200 筆窗口影響、全來源快照、來源／證據分頁、作廢／暫停政策與覆蓋分母。回傳大小測試使用長摘要／證據，檢查整體 JSON 字元上限、明確省略與 full 相容性。Web 測試確認延遲／失敗時不呈現空狀態或建立操作，長摘要展開仍保留原文。

coverage 與瀏覽器整合採序列執行，保留既有 axe 與 timeout 門檻；合成測試不能等同實機 Safari、OS Clipboard 或使用者資料庫性能。
