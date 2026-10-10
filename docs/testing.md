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
pnpm test:retrieval-quality # 只執行合成資料的 work_recall 檢索品質評估
pnpm eval:recall <題目.json> # 在指定資料庫唯讀評估 recall/context
pnpm run test:recall-eval:example # 以暫存合成資料庫跑 CLI 範例與排名 smoke gate
pnpm typecheck    # 套件、Vue 樣板、單元測試與 E2E 設定型別
pnpm build        # 工作區套件、server／MCP 與 Vite 正式版
pnpm test:e2e     # 使用隔離資料庫的 Playwright 瀏覽器回歸測試
```

`pnpm db:redact` 的 dry-run 與 `--apply` 測試只使用暫存目錄內的合成 SQLite 資料庫；不會讀寫使用者的實際資料庫。測試中的憑證字串由執行期片段組合，不在原始碼保存完整假 token。

## 介面語言與主題

- **訊息目錄**：`tests/web/i18n/catalog.test.ts` 確認 `zh-TW.json` 與 `en-US.json` 的 key 與 `{placeholder}` 完全一致、沒有空字串、沒有已不再使用的 key，且 `apps/web/src` 裡沒有寫死的中文字串（只允許 `資料不足` 這類資料標記）。不存在的 key 由型別檢查擋下（`t()` 只接受 `MessageKey`）。同一檔案也測試插值、單複數與常數標籤表隨語系切換。
- **測試也不寫死介面文字**：單元測試以 `t("key", 參數)` 取得預期文字；E2E 以 `tests/e2e/helpers/i18n.ts` 的 `tt()`、`ttPattern()`、`textIn()` 從同一份 JSON 取字。`tests/web/i18n/e2e-copy.test.ts` 會在 spec 把中文直接傳給 locator 或文字斷言時失敗（伺服器與 fixture 寫入的資料除外）。
- **偏好設定**：`tests/web/stores/preferences-store.test.ts` 涵蓋主題（含跟隨系統）、語言的保存與還原，以及無法使用 localStorage 時的退回行為。
- **E2E 預設**：Playwright 以 `locale: "zh-TW"`、`colorScheme: "dark"` 執行，所以既有測試維持以繁體中文文案與深色主題斷言。淺色主題由「light theme @accessibility」axe 測試覆蓋；「switches the interface language and theme」測試從頁首切換英文與主題並確認重新整理後保留；另有英文版在 640／390px 的水平溢位檢查，因為英文文案較長。

## CI

`.github/workflows/ci.yml` 在每個 PR 與 `main` push 執行：

- **Quality**（`ubuntu-latest`、`windows-latest`、`macos-latest`）：`pnpm install --frozen-lockfile` → `pnpm build`（workspace 套件透過 `dist/` 互相引用，要先 build）→ `pnpm test`（含 ESLint 與全 repo Prettier check）→ `pnpm typecheck` → `pnpm test:coverage`。維護者主要使用 macOS；Windows 與 Linux 守住不同的路徑處理（大小寫、分隔符號、8.3 短檔名）與 shell 行為。
- **生產依賴安全稽核**：Ubuntu Quality job 執行 `pnpm audit --prod --audit-level high`；生產依賴出現 high 或 critical 級別漏洞時，檢查會失敗。
- **效能門檻**：在 Ubuntu Quality job 的測試與覆蓋率成功後，執行 `pnpm test:performance`；效能基準只跑一次，避免在 OS matrix 重複佔用 CI 時間。5,000 Sessions 匯入 50,000 events 的 20 秒上限則在 `pnpm test` 中跨平台執行。最近一次本機量測中，5,000 Sessions／1,000 個合成未結項的清單 p90 為 2.09 ms（上限 250 ms）；100 筆 Session digest 的 pending-items 批次查詢 p90 為 4.61 ms（上限 100 ms，先前量測為 8.11 ms）。
- **Recall evaluator 效能門檻**：同一個 `pnpm test:performance` 另以 5,000 筆合成 Sessions、MCP in-memory transport 與真實 snapshot 流程量測 recall/context evaluator，15 次執行的 p90 上限為 1,000 ms。此數字涵蓋唯讀來源備份、scratch store 啟動、必要的 scratch 索引同步與兩個 MCP 呼叫；不使用使用者資料庫。最近一次本機量測 p90 為 259.19 ms（median 250.06 ms、max 263.91 ms），整體讀取效能 gate 23/23 通過。
- **Recall evaluator CI smoke**：Quality 的 Ubuntu、Windows、macOS 三個 matrix 都執行 `pnpm run test:recall-eval:example`，在暫存目錄建立合成 SQLite，結構化代入臨時 project root 與本次 seed 的 Session／Knowledge ids，再直接用目前 Node 執行 evaluator，避免 shell 路徑與 `pnpm` shim 差異。recall 與 context 正例必須都達 hit@1、hit@5、MRR = 1；負例預期為 `confidence: "none"`，任何不符都以非零結束。CI 明確傳入暫存 `--db`，不讀取 `data/`。
- **檢索品質門檻**：`pnpm test` 在三個 OS 都包含虛構合成資料的 storage 評估；Ubuntu 另以 `pnpm test:retrieval-quality` 明確顯示 hit@5／MRR 門檻結果。
- **MCP 回應大小門檻**：`pnpm test` 在三個 OS 都執行合成資料的回應大小測試；Ubuntu 另以 `pnpm test:response-size` 顯示各工具序列化字元數並檢查上限。
- **E2E**（`ubuntu-latest`，Quality 通過後）：安裝 Playwright Chromium、Firefox 與 WebKit 後執行 `pnpm test:e2e`；Chromium 執行完整回歸，Firefox 執行 `@cross-browser` 與 `@accessibility` 流程，WebKit 執行 `@cross-browser` 核心流程。Chromium 與 Firefox 會在六個主要頁面、系統狀態與備份管理頁執行 axe，深色與淺色主題各跑一次，critical／serious impact 的違規（包含色彩對比）會使測試失敗；第一次使用清單另在無專案狀態執行 axe，並在 1440／960／375px 檢查水平溢位。備份刪除確認也有鍵盤操作 E2E。三個瀏覽器分開執行，使用各自的暫存 SQLite 與隔離的 Agent home/config 路徑；失敗時上傳 `test-results/` 供除錯。測試以 `pnpm start` 在正式模式啟動 Web 與 API，並共用一個 port。CI 上的 WebKit 是 Ubuntu Playwright 執行環境，不等於 macOS Safari 實機驗證。

Coverage 使用模組局部門檻；各套件分開量測，因此沒有設定跨套件合併總門檻。core、project-policy、shared 於 2026-09-26 的 macOS 基線分別為 100%／100%／100%／100%、99.27%／98.55%／100%／99.26%、95.45%／81.25%／100%／95.45%（statements／branches／functions／lines）；project-policy 的 Windows branches 為 92.75%，因平台路徑分隔符走不同條件。

A1 新增合成 runtime 的 `getMcpRuntimeStatus (cached identity)` p90 ≤ 50 ms，以及 `MCP guarded finalize (schema check)` p90 ≤ 250 ms。前者複製建置檔到測試目錄再量測暖快取狀態讀取，後者在同一 write transaction 核對 schema 後 finalize；不使用實際資料庫或 Agent 設定。

`tests/mcp/server.test.ts` 的報告回歸透過真實 MCP in-memory transport 與 dispatcher 儲存、冪等重送及重試報告，確認內層服務共用 schema 保護交易。另在隔離 SQLite 注入 INSERT 失敗，驗證先前目前版本與未完成請求均保留，移除失敗條件後可重新提交；不使用使用者報告。

Windows CI 的 coverage 曾讓 recall evaluator 誤判案例與未結項 supersession 稽核案例各耗時約 6 秒，超過 Vitest 預設 5 秒。這兩個包含檔案 SQLite 建置／快照或多次寫入的整合案例各使用 15 秒 timeout；保留所有斷言、其他測試的預設時間與獨立效能門檻。

Server 測試同樣會開啟真實 SQLite 檔案、建立備份並執行 CLI；Windows CI 上新建檔案可能短暫被鎖住，SQLite 會等到 5 秒的 busy_timeout，剛好碰到 Vitest 預設的 5 秒上限（2026-10-07 曾在刪除專案備份、CLI 列出備份等不同案例輪流逾時）。因此 server 的一般與 coverage 設定都比照 storage 使用 20 秒 `testTimeout`，斷言不變。

A2 另以 286 個合成過期 lease／tmp（每次計時前重建，建置資料不計時）量測狀態讀取及 MCP 註冊清理，兩者 p90 上限各為 100 ms。測試涵蓋 TTL＋60 秒邊界、每次 64 次刪除嘗試上限、重複讀取收斂、刪除失敗、非 UUID 檔案、符號連結及 scope 隔離；runtime 單元測試 mock `tmpdir()`，其餘本機驗證使用隔離 HOME／TMPDIR。

## 檢索品質評估

先執行 `pnpm build`，再用 `pnpm eval:recall <題目.json> [--db <資料庫.sqlite>] [--out <結果.json>]`。此 script 固定傳入 `--experimental-sqlite`：Node.js 22.5–22.12 需要此旗標，22.13 以上可接受這個冗餘旗標。未指定 `--db` 時使用 `WORK_INTELLIGENCE_DB`，否則使用 repo 的 `data/work-intelligence.sqlite`。題庫支援 JSON 陣列或 `{ "version": 1, "questions": [...] }`；最多 200 題、輸入檔最多 1 MB。每題必填 `mode`（`recall`／`context`）、`query` 和一項預期：`expectedIds`（最多 20 個 Session／Knowledge id）或 `expectedNoHit: true`。可選 `id`、`projectRoot`、最多 20 個 `paths`、`expectedConfidence`（`none`／`low`／`high`）；只有 recall 可用 `from`／`to`，兩端皆為有效的 `YYYY-MM-DD`，且日期端點包含在範圍內。Recall 固定取 MCP 回傳前 30 名；正例 hit@1／hit@5／MRR 的分母只算已評估的正例，負例另計，MRR 定義為 MRR@30。`expectedConfidence` 未指定時，報告會留空符合狀態，不從預期 id 推定 confidence。

Context 每題呼叫 `work_get_context` 的實際 MCP handler；排名只看 `relevant.sessions` 與 `relevant.knowledge`，各自依型別從 1 排到最多 5，不使用 recent 區段。Context 的 hit@1／hit@5 與 MRR 使用命中預期 id 的最佳型別內排名。Recall 對 Session 與 Knowledge 使用 MCP `work_recall` 的合併排序。若 scoped project 回傳 `skipped`（例如專案未追蹤），問題狀態會標為 `skipped`、不加入 no-hit 分母，並使整份評估失敗。

每題和整份報告的 `passed`（因此 CLI exit 0）表示：每個正例至少一個預期 id 出現在 MCP 回傳名單、明確指定的 `expectedConfidence` 符合、沒有 skipped，且預期 no-hit 沒有 `high` 信心。它不代表 hit@1／hit@5／MRR 達到品質門檻；CI 範例另要求兩個正例都排名第 1 並達 hit@1、hit@5、MRR = 1。

每題記錄 MCP text payload 的 JavaScript `.length` 與 `Client.callTool()` 耗時、MCP 回傳 hit 數；confidence 比對只在題目明確填入 `expectedConfidence` 時執行。`expectedNoHit` 以 MCP confidence 作為通過判準：`high` 會使該題及整份報告失敗並列於 `expectedNoHitWithHighConfidence`；`low` 即使有弱候選仍通過，但每題 `unexpectedHits`、`returnedHitCount` 與頂層 `expectedNoHitWithHits` 會顯示候選數量。`--out` 只在使用者明確指定時寫報告，省略則把 JSON 報告寫到終端；為避免意外覆寫，既有目標一律拒絕，請另選新檔名。也拒絕輸出到題目檔、SQLite 主檔、其 `-wal`、`-shm` 或 `-journal` sidecar，並以 exclusive-create 再防一次路徑競態。

唯讀保證來自 `DatabaseSync(source, { readOnly: true })`（評估器要求 Node.js 22.5+）：先透過 `node:sqlite backup()` 對來源做一致快照，再由正式 `WorkIntelligenceStore` 和 linked in-memory MCP Client/Server 在 OS 暫存副本執行相同 recall/context 路徑。Node 22.5–22.15 沒有 backup API 時，使用唯讀 source 的 `VACUUM INTO` 寫入同一暫存副本；此 fallback 也有強制路徑測試。由此產生的 `search_dirty` 同步只寫 scratch copy，確保尚未同步的來源索引不會漏掉新記錄。SQLite 為讀取 WAL 資料可能使用或建立來源旁的 `-wal`／`-shm` sidecars；這是 SQLite 正常唯讀 WAL 行為，評估器不會刪除它們。測試會逐位元組比對來源主檔和既有 WAL，並確認 records、search chunks/paths/FTS 與 dirty rows 不變、scratch 清理完成。

合成題目模板在 [`tests/fixtures/recall-eval-example.json`](../tests/fixtures/recall-eval-example.json)；`scripts/run-recall-eval-example.mjs` 在 OS 暫存位置建立資料庫並代入本次 seed ids，故範例不含固定的隨機 UUID，也不會碰使用者的 DB。CI 也嘗試把 `--out` 指向 SQLite 主檔與各 sidecar，確認命令失敗且檔案位元組不變。MCP evaluator 的 source/WAL 保持不變與 scratch dirty-index 命中由 `tests/mcp/recall-evaluation.test.ts` 驗證。

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

`tests/shared/mcp-runtime.test.ts` 與 `tests/mcp/server.test.ts` 以暫存 runtime installation 模擬 MCP dist、workspace dependency dist 在連線啟動後更新，並檢查 incomplete build、缺少 dist、多個 heartbeat、過期／損毀 lease、正常退出只清自己的 lease，以及 build finalizer 注入 fingerprint 後再讀取 identity 一致。`tests/server/doctor.test.ts` 與 `tests/server/server.test.ts` 以暫存 repository、HOME、Codex／Claude config roots 和 lease 驗證 Doctor/API 共用唯讀 Agent 診斷；涵蓋 registered／missing／unknown、skill hash drift、malformed JSON、malformed Codex TOML（MCP 表內外與 EOF comment）及不可讀 hook 設定，並比對設定檔檢查前後位元組相同。`tests/server/user-service.test.ts` 只在 OS 暫存目錄比對 macOS、Windows、Linux 服務設定內容，使用假服務管理器確認先預覽再確認、取消時沒有寫入、移除時保留資料與未支援平台不執行服務命令；CI 不安裝或操作實際服務。E2E 以隔離 Agent home 驗證系統狀態頁（含服務狀態）、重新整理、首次使用四步與零 API 寫入。這些測試不讀寫實際資料庫或 Agent 設定。

`tests/server/plugin.test.ts` 檢查 Claude Code／Codex plugin：manifest 版本等於根目錄 `package.json`、兩個 Agent 都經 `scripts/launch.mjs` 啟動 MCP、plugin 內的 skill 與 `.agents/skills/work-intelligence/SKILL.md` 相同、兩個 marketplace 都列出它；再以暫存 HOME 與假 repository 驗證啟動器依 `WORK_INTELLIGENCE_HOME`、所在 repository、`plugin-link.json` 尋找 checkout、原樣轉送 stdin／stdout／exit code、找不到或未 build 時 MCP 失敗而 Stop hook 靜默放行，以及 `pnpm plugin:link` 與 Doctor 對已啟用 plugin、重複註冊的判斷。`tests/server/plugin-bundle.test.ts` 執行 `pnpm build:plugin`，確認 plugin、zip 與 `.mcpb` 內容，並在暫存 HOME、沒有 checkout 的情況下透過啟動器與內附 MCP server 握手、讀取 skill resource，檢查資料庫落在 `~/.work-intelligence/data` 或連結的 checkout；`tests/mcp/database-location.test.ts` 確認 repo build 的資料庫路徑不受 plugin 連結影響。`tests/server/dashboard.test.ts` 以暫存 port 驗證 `pnpm dashboard`：server 已在執行時只印出網址、未執行時在背景啟動並等待 `/api/health`、port 被其他程式占用或未 build 時說明原因，以及 plugin launcher 的 `dashboard` 指令會略過 Codex 未 build 的 marketplace clone。

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
| Dashboard | 1,000 ms |
| 提醒聚合（八類混合來源，每類最多 200 筆） | 500 ms |
| 週報 | 750 ms |
| 年報 | 1,500 ms |
| Agent context | 2,500 ms |
| 單一專案 Agent context（含 3 個常駐知識頁摘要） | 500 ms |
| 知識頁列表含過時判斷（3 頁 × 一年的 Session） | 250 ms |
| finalize 知識頁維護提示（3 頁 × 5,000 個新 Session） | 250 ms |
| task context 相關未結項（5,000 Sessions／1,000 項，含文字與路徑排名） | 500 ms |
| finalize 相關未結項提示（同一合成歷史，排除本次新項目） | 250 ms |
| 知識頁 review context（涵蓋範圍後的一年 Session，最多 60 筆） | 250 ms |
| 未結項清單（5,000 個 Session 中的 1,000 筆合成項目） | 250 ms |
| 未結項清單（來源 Session 完成日期區間） | 250 ms |
| 工作歷程搜尋（`search`） | 500 ms |
| 依月份範圍的排序檢索（`recall` 帶 `from`／`to`） | 500 ms |
| 同義詞擴展排序檢索（`q=endpoint performance`） | 500 ms |
| 熱點檔案（全部期間前 20 名；依目錄、單月） | 各 500 ms |
| 圖譜含推導關係、兩節點路徑（500 節點內 BFS） | 各 750 ms |
| 時間軸（單月；一整年，最多 2,000 筆 Session） | 250 ms；750 ms |
| 工作熱度日曆（一整年，每日 Session 計數，本地日於記憶體分桶） | 250 ms |
| Knowledge 列表含過時判斷（20 筆 Knowledge × 一年的 Session） | 500 ms |

搜尋的上限原本是 10,000 ms。修正全文搜尋的 join 順序後（見 `search-repository.ts` 的 `CROSS JOIN` 註解），中位數從約 2,000 ms 降到約 13 ms，因此收緊到 500 ms，讓同樣數量級的退化會直接失敗。新增讀取路徑時，請在 `read-paths.bench.mjs` 加上對應情境與上限。

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

B2 加入重複規劃片段的反例：八筆合成 Session 共用舊 handoff 片段，分別以「新增 REST endpoint 的慣例」與「FTS 效能問題」查詢時，已完成的路由拆分與 FTS 修正 Session 必須排第一。Raw section 先做 NFKC、空白與大小寫正規化並存 SHA-256；同一專案最早的 Session 保留完整 raw 欄位權重，重複引用只計 10%，結構化 Session 欄位的權重高於 raw handoff。Schema 20 對既有索引加上衍生 `content_hash` 欄位並把舊 Session 標為待重建；`project-data-coverage` 確認此欄位留在可重建搜尋索引，不當作可匯出的專案資料。檢索品質案例另確認正確命中仍保留在結果內。

```powershell
pnpm test:retrieval-quality
```

一般 `pnpm test` 已包含此評估；Ubuntu CI 另有獨立步驟，方便直接看到檢索指標回歸。

`pnpm test:coverage` 使用 V8。core 的四項門檻皆為 100%；project-policy 為 95%／90%／100%／95%，branch 門檻依 Windows 92.75% 基線保留跨平台餘裕；shared 為 90%／80%／100%／90%。schema 的四項門檻為 90%（新增 schema，包括 MCP 專用 input schema，都要補測試才會過）；storage handoff parser 為 85%／70%／90%／85%。Web 覆蓋率納入 `apps/web/src/stores/**`、`api/**`、`utils/**` 與 `useActiveRequestWatch`；總門檻為 80%／65%／82%／85%，API 各檔門檻為 95%／80%／95%／95%，store 各檔為 75%／55%／70%／80%，utils 各檔為 90%／90%／95%／90%（依序為 statements／branches／functions／lines）。各 store 測試在每個案例建立獨立 Pinia／Pinia Colada query cache，並以 stub fetch 隔離 API。server、MCP 維持既有門檻。Coverage 輸出只寫入被 `.gitignore` 排除的 `coverage/` 目錄。

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

## 第九輪 B3 整理建議驗證

新增整理 request list／5-item＋10-Session context／100-proposal page 的 5,000 Session 基準，各 p90 上限 250 ms；最新完整檢查的 15 次取樣分別為 0.47／3.32／3.86 ms。回應大小測試保護 24,000 字元整理 context、固定 item／Session ID 與截短旗標，以及一般 context 的 pending 整理請求。儲存層／MCP／REST 測試確認提案不改狀態、重試、同專案與時間範圍、source/evidence 更新／作廢、整批回滾、policy skip、錯誤遮罩、migration 22→23、轉移／遮蔽及永久刪除。

建議準確度採獨立 Agent 真正閱讀合成 context 與完整來源，沒有以 hardcoded classifier 測自己。20 個預先建立答案的項目中，12 個確認完成／取代、8 個失敗／部分／回退／草稿或缺證據；Agent 未讀答案，核對 8 頁後提交 12 項正確建議，精確率 12/12、確認案例覆蓋 12/12、證據不足保留 8/8。公開 schema 與實際 storage submit 驗證後 pending 仍 20→20，重試未新增提案。小樣本只是這組合成案例，不代表實際資料的整體準確度；詳細資料見 [B3 合成評估](../.openspec/handoffs/2026-10-01-codex-round9-b3-accuracy.md)。

B3 複檢補上活躍 pending／awaiting_review 快照的 Agent finalize 完成／取代與 nextSteps 移除防護，並確認取消後恢復正常收尾、Web 人工更新仍可用。背景刷新遭後續刷新取消時，批次更新／復原與整理審核保留實際寫入結果；同頁未結項與建議刷新保留仍符合條件的勾選，切換範圍仍清空。回歸案例分別以 AbortError 與實際瀏覽器刷新驗證。

整理面板的三個瀏覽器案例涵蓋逐筆與批次接受／拒絕、接受前原狀、來源與證據跳轉、URL 審核狀態與第二頁重載、1440／960／375px 內部滾輪與鍵盤捲動、axe、Esc 與焦點返回，以及過期建議與取消後唯讀／清除選取。兩種清單均驗證同頁刷新保留仍符合條件的勾選；批次復原案例先確認畫面呈現復原後的本頁成員再重新選取。


## Archify 技術探測

歷史版本的 `pnpm test:archify-probe /path/to/archify-checkout` 是選擇性的隔離探測（2026-10-10 隨 Mermaid runtime 移除而刪除命令），需先建置與安裝三個 Playwright 瀏覽器；不使用正式資料庫或全域 skill。固定上游版本、75 組 CSP／主題／語言／規模驗證、原始測量值及邊界見 [Archify 技術驗證](archify-spike.md)。


架構圖格式 v1 測試涵蓋界限、未知版本／欄位、引用與作者路徑順序、MCP dispatcher、migration 26→27 保留排序／作廢、結構化遮蔽、舊匯出相容與新格式 round-trip。既有 SessionDetail 讀取路徑與政策不變。

`getSessionDetail (200 architecture nodes)` 增加 200 節點／199 連線合成快照，p90 門檻 250ms，確認圖表隨完整 Session 讀取；不是瀏覽器繪製或實機觸控量測。


原生架構閱讀器的跨瀏覽器案例涵蓋群組、來源、直接關係、作者路徑、面板收合、縮放／背景拖曳、鍵盤／焦點、重載網址、明暗主題／繁中英文、375／960／1440 視窗與桌面側欄縮窄、axe、CSP、HTML 字串逸出與未知版本來源回退。200 節點案例保存選取至兩個繪製幀的五筆樣本及中位數（寬鬆 2,000ms 回歸門檻），不是輸入延遲／FPS／冷啟動網路或實機 Safari／觸控的驗收；密集及巢狀圖不在本輪量測範圍。

進行中驗證回歸：`tests/storage/verification-progress.test.ts` 檢查同筆狀態稽核、補登區別、205 筆進行中超過來源上限的完整統計與匯出匯入；MCP/schema 與三瀏覽器案例驗證 `not_run → in_progress → passed/failed`、雙語明暗主題、1440／960／375px、axe 與不受信任字串逸出。合成 5,000 筆 read-path benchmark 新增 `getReport (in-progress verification)`，15 次的 p90 上限 750ms。

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
