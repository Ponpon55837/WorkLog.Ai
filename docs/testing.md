# 測試與驗證

各層測試指令、覆蓋率門檻與 E2E 範圍。

> 回到 [README](../README.md)

## 測試檔案位置

所有單元、整合與端對端測試集中放在根目錄 `tests/`，依工作區套件分資料夾；`apps/` 與 `packages/` 只放產品程式碼、建置與測試設定，不在 `src/` 旁混放測試檔。`tests/e2e/` 專放瀏覽器端對端測試。

```powershell
pnpm test         # ESLint、全專案格式檢查，以及 core、政策、schema、storage、server、MCP、Web 測試
pnpm format       # 格式化全專案（文件與 Agent 技能除外）
pnpm test:coverage # schema、storage、server、MCP、Web 覆蓋率與最低門檻
pnpm test:performance # 合成資料的匯入與關鍵讀取路徑效能門檻（需先 build）
pnpm test:retrieval-quality # 只執行合成資料的 work_recall 檢索品質評估
pnpm typecheck    # 套件、Vue 樣板、單元測試與 E2E 設定型別
pnpm build        # 工作區套件、server／MCP 與 Vite 正式版
pnpm test:e2e     # 使用隔離資料庫的 Playwright 瀏覽器回歸測試
```

## CI

`.github/workflows/ci.yml` 在每個 PR 與 `main` push 執行：

- **Quality**（`ubuntu-latest`、`windows-latest`、`macos-latest`）：`pnpm install --frozen-lockfile` → `pnpm build`（workspace 套件透過 `dist/` 互相引用，要先 build）→ `pnpm test`（含 ESLint 與全 repo Prettier check）→ `pnpm typecheck` → `pnpm test:coverage`。維護者主要使用 macOS；Windows 與 Linux 守住不同的路徑處理（大小寫、分隔符號、8.3 短檔名）與 shell 行為。
- **效能門檻**：在 Ubuntu Quality job 的測試與覆蓋率成功後，執行 `pnpm test:performance`；效能基準只跑一次，避免在 OS matrix 重複佔用 CI 時間。5,000 Sessions 匯入 50,000 events 的 20 秒上限則在 `pnpm test` 中跨平台執行。
- **檢索品質門檻**：`pnpm test` 在三個 OS 都包含虛構合成資料的 storage 評估；Ubuntu 另以 `pnpm test:retrieval-quality` 明確顯示 hit@5／MRR 門檻結果。
- **E2E**（`ubuntu-latest`，Quality 通過後）：安裝 Playwright Chromium 與 Firefox 後執行 `pnpm test:e2e`；Chromium 執行完整回歸，Firefox 執行帶有 `@cross-browser` 標記的正式模式啟動/API 同源與主要頁面路由流程。Chromium 會在六個主要頁面執行 axe，critical／serious impact 的違規會使測試失敗。兩個瀏覽器分開執行，使用各自的暫存 SQLite；失敗時上傳 `test-results/` 供除錯。測試以 `pnpm start` 在正式模式啟動 Web 與 API，並共用一個 port。

Coverage 門檻維持下方的模組局部門檻；尚未量測其他 workspace 的基線，所以沒有設定全域門檻。

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
| 週報 | 750 ms |
| 年報 | 1,500 ms |
| Agent context | 2,500 ms |
| recall 搜尋 | 10,000 ms |

效能基準使用合成 SQLite，寫在系統暫存目錄；不讀寫 `data/` 下的使用中資料庫。若要列出所有讀取路徑的 median、p90 與 max（不套用失敗門檻），可執行：

```powershell
$env:WI_BENCH_CACHE = "$env:TEMP\wi-bench"; pnpm exec node packages/storage/bench/read-paths.bench.mjs 5000
```

設定 `WI_BENCH_CACHE` 會保留合成資料庫供修改前後比較；不設定時資料庫會在執行後移除。

## 檢索品質回歸門檻

`tests/storage/retrieval-quality.test.ts` 以 20 題虛構查詢和暫存目錄的合成專案資料，透過 `WorkIntelligenceStore.recall` 評估 `work_recall` 使用的排序路徑。評估包含 K（gotcha／pattern）、S（Session 主題）、R（答案只在 raw handoff）、N（自然語句）與 P（路徑查詢）五類，各 4 題；題目涵蓋中文雙字詞、原始交接文件與絕對／相對／Windows 形式路徑。每題都放入合成近似干擾紀錄，以檢查正確答案排名。

目前合成基線為整體 hit@5 1.00、MRR 0.90。門檻設定為整體 hit@5 ≥ 0.95、MRR ≥ 0.90；每一類 hit@5 ≥ 0.75，K／S／N／P 的 MRR ≥ 0.70，R 類 MRR ≥ 0.50。R 類答案只在 raw handoff，並刻意搭配共享部分查詢詞的標題干擾項；目前四題都排第 2，反映 raw 欄位較低的權重，因此以 0.50 作為該類不退化的基線。hit@5 表示正確 Session／Knowledge 是否進入前 5 筆，MRR 以正確項目的排名倒數取平均；沒有命中時計 0。測試不開啟 `data/work-intelligence.sqlite`，不使用私有的 36 題評估資料，也不將真實工作記錄寫入 repository。

```powershell
pnpm test:retrieval-quality
```

一般 `pnpm test` 已包含此評估；Ubuntu CI 另有獨立步驟，方便直接看到檢索指標回歸。

`pnpm test:coverage` 使用 V8：schema 的 statements／branches／functions／lines 門檻為 90%（新增 schema，包括 MCP 專用的 input schema，都要補測試才會過），storage handoff parser 的門檻為 85%／70%／90%／85%；coverage 輸出只寫入被 `.gitignore` 排除的 `coverage/` 目錄。

`pnpm test:e2e` 會先建置 production packages，再以獨立的暫存 SQLite、單一 port `5967` 啟動正式模式測試服務，不會讀寫目前使用中的 `data/work-intelligence.sqlite` 或 `5966` 開發畫面。若 port 已被占用，可改用其他 port：

```powershell
$env:WORK_INTELLIGENCE_E2E_WEB_PORT = "5987"; pnpm exec playwright test
```

E2E 涵蓋：Knowledge 候選（網頁建立請求、以 storage 套件模擬 Agent 回寫後頁面自動出現並接受）、Knowledge 可信度（改到 appliesTo 檔案後標示可能過時、確認仍有效後清除）、metadata 回補請求在 Agent 回寫後自動更新、專案頁「資料備份」立即備份、永久刪除專案前輸入完整名稱確認並顯示備份檔名（workspace sentinel 檔案保留）、AI 報告整理卡（來源 Session、歷史版本、重新整理、Agent 存入結果後頁面自動更新並提示）、報告總覽依區間切換內容、工作歷程／知識的每頁筆數與 virtual list、Graph 篩選、節點搜尋（`?q=`、Enter 選取第一筆、無結果狀態）與節點面板、390px 寬度的 Session 面板、640／390px 各頁無水平捲動、六個主要頁面的 axe 掃描（critical／serious impact 必須為零）、直接路由與 `/worklog` 轉址、`?session=` 深連結、側邊面板拖曳調整寬度並記住、切換為記錄中前的同意對話框、Ctrl／⌘ K 指令面板、Session 面板「編輯 Session」（改主摘要、一段 workSummary 與 verification，未改的段落保留，verification 留下修改紀錄）、Session 作廢／「只看已作廢」篩選／還原。報告日期以測試機器的系統時區計算，與 server 一致。

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
- tracked-only context/search 行為
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
- MCP server 以 in-memory transport 端對端測試：工具清單、annotations、instructions 長度、contract 只掛在寫入工具、prompts、`work_get_project_status`、`work_list_sessions`／`work_get_session` 與 paused 專案 skip、Agent 建立報告／metadata 請求並出現在 context 的 `pendingRequests`

模擬 Agent 的 E2E 會直接開啟 server 使用的暫存 SQLite（`WORK_INTELLIGENCE_E2E_DB`，由 `playwright.config.ts` 設定並傳給 worker），因為候選回寫只有 MCP 工具、沒有 REST。這些測試需要先 `pnpm build`（`pnpm test:e2e` 會自動執行）。
