# Handoff：2026-09-24 Claude Code → Codex

交接今天（2026-09-24）Claude Code 在 WorkLog.Ai 做完的工作，以及還沒完成、請 Codex 接手的項目。完成後使用者會再請 Claude 複檢，所以**每個項目請開獨立的 PR**，PR 說明寫清楚做了什麼、怎麼驗證、有哪些沒驗證。

## 目前狀態

- `main` 最新是 #33（報告的跨期工作），CI 全綠後已合併。
- 今天合併的 PR：#21～#33。內容整理在 `docs/status.md` 的「最近完成」，Work Intelligence 每一段都有 Session 記錄（`work_recall` 可以查）。
  - #21 報告 AI 整理的範圍隔離（全專案檢視不再混入單一專案的整理）
  - #22／#23 報告總覽依區間顯示不同內容（日：Session 清單；週：每日；月：每週；季：每月；年：每季；專案占比）與對齊修正
  - #24 報告整理、Knowledge 候選、metadata 回補在 Agent 完成後自動更新頁面（`useActiveRequestWatch`）
  - #25 每日自動備份、「資料備份」分頁、`pnpm db:backup`／`db:export`／`db:restore`（換電腦還原、`--remap-root`）
  - #26 加入專案時用作業系統原生視窗選資料夾（`POST /api/system/pick-folder`）
  - #27 Claude Code Stop hook：改了檔案卻沒保存時提醒一次（`apps/mcp/dist/finalize-reminder.js`）
  - #28 圖譜分頁時跨頁的 Session 關聯；#29 同一毫秒的修改紀錄改以 rowid 排序（修 CI 偶發失敗）
  - #30 E2E：Knowledge 候選、Knowledge 可信度、回補自動更新
  - #31 Session／Knowledge 列表搜尋改多關鍵字（AND、片語、`json_each` 只比對內容）
  - #32 自訂期間報告（`from`／`to`，最長 366 天，`period: "custom"`）
  - #33 報告的 `spanning`：更早開始／之後完成／事後修改的 Session

## 工作規則（請照做）

- 與使用者一律用**繁體中文**。
- 改 `apps/web` 前先讀 `.agents/skills/worklog-ui/SKILL.md` 與 `.agents/skills/worklog-web-code-style/SKILL.md`（tokens、元件目錄、命名、import 順序、`ui/` 元件優先、Box 並排時要把 `.ui-box + .ui-box` 的 margin 歸零）。
- 工作記錄依 `.agents/skills/work-intelligence/SKILL.md`：**每完成一段就 finalize 一次**；`startedAt` 只填確定的時間（例如該段開始的訊息時間），不確定就省略，不要估。
- 流程：開分支 → 實作 → 健康檢查 → 自己 review（正確性、資安、資料保護）→ 開 PR → **確認 CI 結論是 success、且對應的是 PR 最新的 commit** → 合併（merge commit、刪分支）→ finalize。
  - 不要把 `gh pr merge` 串在等待 CI 的指令後面；今天曾因此把紅燈的 #28 合併進 main。
- 健康檢查要逐步確認每一步成功，不要用 grep 過濾輸出而漏看失敗：
  - `pnpm build`
  - `pnpm test`（含 eslint 與 prettier，格式錯誤會在這裡失敗）
  - `pnpm typecheck`
  - `pnpm test:coverage`
  - `pnpm test:e2e`；5967／3211 被占用時用 `WORK_INTELLIGENCE_E2E_WEB_PORT=5987 WORK_INTELLIGENCE_E2E_API_PORT=3231 pnpm exec playwright test`（要先 `pnpm build`）
- E2E 是依序執行、共用同一份資料，新增的 Session 會排到列表第一筆，所以新測試請加在檔案後段，避免影響「打開第一筆 Session」的舊測試。
- 模擬 Agent 寫入（沒有 REST 的 MCP 寫入）的 E2E 用 `withAgentStore`，會打開 `WORK_INTELLIGENCE_E2E_DB` 指向的暫存資料庫。
- 使用者實際的資料在 `data/work-intelligence.sqlite`，**不要直接修改**；要驗證寫入流程時先用 `sqlite3 -readonly data/work-intelligence.sqlite ".backup <scratch 路徑>"` 複製一份。
- 資安慣例：
  - API 只接受 loopback，並檢查 Host 白名單與 Origin；POST 一律要求 JSON body，擋掉跨站表單。
  - 回應不回傳資料庫或備份的檔案系統路徑。
  - 執行外部指令用 `execFile` 加固定參數，不經過 shell，也不帶入請求內容。
  - 建立檔案時權限從一開始就設好（例如 umask 077、0600）。

## 請接手的待辦

### 1. changedFiles 品質（status.md「changedFiles 品質」）

- 問題：有的 Session 把開工前就存在的未提交改動也算成自己改的檔案（例如「唯讀盤點」記到 41 個檔案），在檔名檢索中被擠到前面。目前只在排序時對超過 20 個檔案的 Session 降權。
- 建議做法（二選一或都做，先寫設計放進 PR 說明）：
  - finalize 時可選擇回報開工前的基準（例如 `baselineChangedFiles`，或 `changedFilesProvenance` 加上 `pre-existing` 標記），儲存時把基準以外的才算本次改動。
  - UI 在 Session 詳情標出「改動檔案數異常」（例如遠多於同專案的中位數），並可在編輯對話框更正 changed files。目前 changed files 是唯讀，要開放的話請先確認 `worklog-ui` skill 的唯讀規則並同步更新。
- 驗收：storage 測試、MCP contract 說明、E2E（若有 UI）。

### 2. 工程整理（status.md「工程整理」）

- 拆 `packages/storage/src/store.ts`（目前約 5,300 行）：report（含 spanning、自訂期間）、synthesis、metadata backfill、context／recall、backup 已獨立在 `backup.ts`，可參考 `knowledge-candidates.ts` 的拆法。**只搬移、不改行為**，每次拆一塊、各自一個 PR，靠既有的 storage 測試（目前 90 項以上）保護。
- Web 單元測試：`apps/web` 目前沒有。建議加 vitest，先測純函式：
  - `utils/report.ts`：`buildReportBuckets` 的各種 mode、跨年標籤、自訂期間的分組
  - `utils/format.ts`：`formatBytes`、`formatDuration`
  - `useActiveRequestWatch`：用假時間與假的 visibility
- coverage 門檻：server／mcp／web 目前沒有，比照 `packages/storage/vitest.coverage.config.ts`，門檻設在目前實測值附近，不要一次設太高。

### 3. 即時更新新的 Session（今天做了第 1 種，這是第 2 種）

- 目前只有「進行中的 Agent 請求」會自動檢查；Agent 新存的 Session，要手動重新整理才會出現在工作歷程與總覽。
- 建議做法：API server 定時（例如每 2 秒）讀 SQLite 的 `PRAGMA data_version`（別的連線寫入時會改變），有變化就透過 SSE（例如 `GET /api/events`）推送 `changed`；Web 收到後重新載入目前頁面（沿用 `useAppRefresh`），並處理斷線重連、分頁在背景時暫停。
- 注意：SSE 端點一樣要經過 Host／Origin 檢查；推送內容不要帶資料，只送「有變化」的訊號。
- 驗收：server 測試（另一個連線寫入後會收到事件）、E2E（用 REST 新增 Session 後，列表不用重新整理就出現）。

### 4. 其他今天留下的缺口

- Knowledge 候選的「修改後接受」與「拒絕」沒有 E2E。
- 自訂期間的 AI 整理不支援：`report_synthesis_requests` 與 `report_summaries` 的 `period` 有 CHECK 限制。要支援就得寫 migration 重建這兩張表（加上 `custom`，並處理 `range_from`／`range_to` 的唯一性），請先評估風險，在 PR 說明寫清楚遷移步驟與回復方式。
- 報告的 Session 查詢上限是 200 筆（`listSessions` 的 limit），很長的自訂期間或年報可能被截斷，目前沒有標示。建議在報告回傳截斷旗標並在 UI 顯示。

## 需要使用者自己處理或決定（不要自動做）

- 保存提醒 hook 已依使用者要求加到使用者的 `~/.claude/settings.json`（Stop hook，與既有的桌面寵物 hook 並存）；它執行的是 `apps/mcp/dist/finalize-reminder.js`，改到這個檔案後要重新 `pnpm build` 才會生效。Codex 沒有對應的 hook。
- 選擇資料夾的原生視窗：自動測試不會開真視窗。macOS 需要使用者實際試一次；Windows、Linux 沒有實機驗證過。
- 備份與還原只有 Windows CI 測試，沒有在 Windows 實機手動試過。
- `docs/status.md` 第一階段剩下的「以真實 DB 重跑 36 題人工評估」：評估題與腳本只在使用者本機，不進 repo，需要使用者提供位置。

## 複檢時請 Claude 特別看

- 每個 PR 的 CI 是否對應最新的 commit、是否全綠。
- store.ts 拆分是否只搬移不改行為（diff 應該幾乎都是移動）。
- 新端點的 Host／Origin／JSON body 檢查，以及回應裡有沒有路徑或敏感資料。
- `worklog-ui` 規範：tokens、`ui/` 元件、12px 以上字級、375px 沒有水平捲動。
