# Handoff：2026-09-25 Claude Code → Codex（第二輪）

Claude 已複檢 Codex 第一輪的 PR #35～#46，並合併了 #47（備份清單改為框內捲動）。這一輪請 Codex 接手以下的**長任務**：一個新功能（依專案匯出／匯入），以及複檢發現的改善項目。完成後使用者會再請 Claude 複檢。

使用者特別要求：**程式碼品質很重要，複檢會特別看**。請維持第一輪的水準（純搬移的拆分、窄介面依賴、無 `any`／`eslint-disable`／`@ts-ignore`），並注意下方「品質要求」。

## 第一輪複檢結果（摘要）

- **整體**：12 個 PR 都有對應的工作記錄，CI 對應最新 commit 且全綠。main 上完整健康檢查（build、test、typecheck、coverage、E2E）通過。
- **做得好**：
  - #37／#38／#40／#41 的 store 拆分是純搬移，service 只依賴範圍很小的 `*StoreReader` 介面。
  - #39 的 SSE 走 Host／Origin 檢查、推送不帶資料，也有測試。
  - #44 的 migration 8 在使用者實際資料庫上已套用：完整性與外鍵檢查都正常，索引齊全，既有請求與摘要都保留。
  - #36 的 baseline 取捨在 skill 與 MCP 說明寫得很清楚。
- **需要改善**：見下方「複檢發現的改善項目」。

## 工作規則（沿用第一輪，重點重述）

- 與使用者用**繁體中文**；改 `apps/web` 前先讀 `.agents/skills/worklog-ui` 與 `.agents/skills/worklog-web-code-style`。
  - `worklog-ui` 的捲動規則剛更新：可能變長、沒有分頁的清單，用 `VirtualList` 在 Box 內捲動，不要手刻捲動外框。
- 每完成一段就 finalize；`startedAt` 只填確定的時間，不確定就省略。
- 每個項目開獨立 PR；合併前確認 CI 結論為 success，而且對應 PR 最新的 commit。
- 健康檢查逐步確認：
  - `pnpm build`
  - `pnpm test`
  - `pnpm typecheck`
  - `pnpm test:coverage`
  - `pnpm test:e2e`
- 使用者實際資料在 `data/work-intelligence.sqlite`，**不要直接修改**；需要時先用 `sqlite3 -readonly ... ".backup <路徑>"` 複製一份。
- 資安慣例：
  - API 只接受 loopback，並檢查 Host／Origin；POST 一律要求 JSON body。
  - 回應不回傳檔案系統路徑。
  - 外部指令用 `execFile` 加固定參數。
  - 建立檔案時從一開始就設好權限（0600／0700）。

## 品質要求（這一輪特別注意）

- 新功能的邏輯放在 `packages/storage` 的獨立模組（參考 `backup.ts`、`knowledge-candidates.ts`），不要再把大段邏輯加回 `store.ts`（目前約 3,200 行）；store 只做薄的轉接。
- 每個模組附單元測試；純函式（格式解析、衝突判斷）要有邊界案例測試。
- 對外的輸入（上傳的檔案、REST body）一律用 zod schema 驗證，驗證失敗回 400 並附上可讀的原因，不要讓例外變成 500。
- 不要複製貼上相近的程式碼；需要共用就抽出來，但不要為了抽而抽。
- PR 說明寫清楚設計取捨、沒做的部分、怎麼驗證。

## 任務 1：依專案匯出／匯入（使用者新需求）

使用者希望「資料備份與還原」可以選**單一專案**或**全部專案**來匯出與匯入，比較方便使用。

目前的狀態：

- 「匯出整份資料」是整個 SQLite 快照。
- 還原只能用 CLI 整份取代（`pnpm db:restore`），而且不能有其他程式開著資料庫。

建議設計（可以調整，但請把取捨寫在 PR 說明）：

1. **格式**：新增一種可攜式的匯出檔（例如 `work-intelligence-export`，JSON，帶 `formatVersion` 與 `schemaVersion`），內容是選定專案的完整資料：
   - 專案本身
   - Session（含 workSummary、verification、changed files 與 provenance、事件、Evidence、raw handoff snapshot）
   - Session 修改紀錄與作廢紀錄
   - Session 關聯（兩端都在匯出範圍內的才帶）
   - Knowledge（含修改紀錄）與 Knowledge 候選
   - 該專案範圍的報告整理請求與摘要

   全專案匯出就是「所有專案」的同一種格式。既有的整份 SQLite 快照保留，給換電腦整份還原用。

2. **匯入 = 合併，不是取代**，所以可以在 server 執行中透過 store 在單一交易內完成，不需要停服務：
   - 先有**預覽**：會新增幾個專案、幾筆 Session、Knowledge 等，哪些已存在（相同 id 且內容相同，可以略過，讓匯入可以重複執行），哪些有衝突（相同 id 但內容不同）。預覽不寫入。
   - 專案用 id 或 root path 對應既有專案；新電腦路徑不同時要能改路徑前綴（沿用 `--remap-root` 的規則：整段比對、Windows 不分大小寫、跨平台轉換分隔符號）。
   - 冷門但要處理的衝突：`idempotency_key` 的唯一限制、關聯另一端不存在、Knowledge 的 `supersedes_id` 指向不在範圍內的資料。
   - 匯入的專案預設狀態建議為「暫停」，由使用者在專案頁確認後才改成「記錄中」，避免新電腦一匯入就開始讀取那個路徑。請在 PR 說明寫明你的決定。
   - 匯入後要重建搜尋索引（沿用現有的 dirty trigger 機制即可），並留下可追溯的紀錄（例如一筆匯入 audit）。
3. **介面**：
   - REST：匯出 `POST /api/export`（body 帶 `scope: "all" | "project"` 與 `projectId`，或另開端點）。匯入分成 `POST /api/import/preview` 與 `POST /api/import`。上傳需要比 `MAX_INPUT_PAYLOAD_BYTES`（1.5 MB）大的上限：請只為匯入端點提高，並設明確的上限（例如 50 MB），超過回 413。
   - Web「資料備份」分頁：匯出時可選範圍（全部或某個專案）；匯入是選檔 → 顯示預覽（新增／略過／衝突數量與路徑轉換）→ 確認對話框 → 匯入 → 提示結果。
   - CLI：`pnpm db:export --project <名稱或 id>`、`pnpm db:import <檔案> [--remap-root 舊=新] [--dry-run]`。
4. **資安與資料保護**：
   - 匯入檔視為不可信的輸入：全部欄位用 zod 驗證、限制大小與筆數，路徑欄位不可用來讀寫檔案系統。
   - 匯出檔沒有加密，UI 與 CLI 要提醒使用者妥善保管。
   - 不要把匯入內容寫進 log。
5. **驗收**：
   - storage 單元測試：匯出後匯入到空資料庫的往返一致；重複匯入是冪等的；衝突偵測；路徑前綴轉換；超過上限；格式或 schema 版本不相容時拒絕。
   - server 測試：大小上限、JSON 驗證、Origin。
   - E2E：選單一專案匯出、再匯入到測試資料庫並確認預覽與結果。
   - 文件：README「備份與換電腦」、rest-api、status。

## 任務 2：複檢發現的改善項目

1. **Codex hook 沒有測試**：`apps/mcp/src/codex-finalize-reminder.ts` 目前只做過手動試跑。請仿照 `tests/mcp/finalize-reminder.test.ts`，把邏輯改成可以注入依賴、容易測試的形式，並測試：apply_patch 標記、finalize 成功才清除、只提醒一次、非記錄中專案不動作、格式錯誤的輸入放行。
2. **Codex hook 的 Windows 指令**：`.codex/hooks.json` 的 `commandWindows` 使用 `$(git rev-parse --show-toplevel)`，只在 PowerShell 有效、在 cmd 無效，也沒有實機驗證。請確認 Codex 在 Windows 執行 hook 用的是哪種 shell，改成可靠的寫法（例如不依賴 shell 展開），並把驗證方式寫進文件。
3. **備份保留規則**：目前只依份數保留最近 14 份。使用者連續手動備份時，會把較舊的每日自動備份全部擠掉（使用者測試時就發生了）。建議把自動與手動分開保留，或保證每天至少保留一份自動備份，最多 N 天。要有測試。
4. **`work_list_sessions` 回傳太大**：37 筆 Session 就回傳約 17 萬字，Agent 的 context 裝不下（Claude 複檢時實際遇到）。建議預設回傳 digest（和 `work_search`／`work_get_context` 一樣：摘要截斷、不含 changed files 清單），需要完整內容再用 `work_get_session`。這會改變 MCP 回傳，請更新說明與 skill，並確認 Web 使用的 REST `/api/sessions` 不受影響。
5. **build 沒有清空 `dist`**：`tsc` build 不會刪除舊檔。測試搬到 `tests/` 後，本機的 `apps/server/dist` 還留著舊的 `server.test.js` 等檔案。請讓各套件 build 前先清掉 `dist`（跨平台可用的寫法，例如 `node -e` 呼叫 `rmSync`，或 `tsc --build --clean`），並確認 Windows CI 仍然通過。
6. **長清單的 UI 盤點**：依新的捲動規則，檢查其他沒有分頁、可能變長的清單，需要的話改成 Box 內捲動。至少包括：
   - Knowledge 候選清單
   - 報告「工作」分頁的「跨期工作」（三組，每組最多 20 筆）
   - Session 面板裡的長區塊
   - metadata 回補清單

   請附 1440／960／375 寬度的檢查結果。

7. **小型清理（可選）**：
   - `report-synthesis-service`、`metadata-backfill-service` 等各自包了一層 `runImmediateTransaction`，可以共用 `sqlite-transaction.ts`。
   - SSE 端點沒有同時連線數上限，只接受本機連線所以風險低，可以加一個合理的上限。

## 仍需要使用者自己做的事（不要自動做）

- 選擇資料夾的原生視窗：macOS、Windows、Linux 的實機操作。
- 備份與還原在 Windows 實機的手動確認。
- 36 題真實資料庫檢索評估：題目與腳本只在使用者本機。

## 複檢時 Claude 會特別看

- 程式碼品質：模組邊界、store.ts 沒有變胖、重複程式碼、命名、測試的邊界案例。
- 匯入的安全性：不可信輸入的驗證、大小上限、路徑不被拿來存取檔案系統、交易完整性（失敗時整批回復）。
- 匯入不會改到或刪除既有資料（合併語意），重複匯入是冪等的。
- UI 規範（tokens、`ui/` 元件、12px 以上字級、375px 沒有水平捲動）。
- 每個 PR 的 CI 對應最新 commit 且全綠；每段都有工作記錄。
