# Handoff：2026-09-25 Claude Code → Codex（第三輪）

Claude 已複檢第二輪 PR #49～#55 的程式碼與工作記錄。PR、CI 與記錄都一致；程式碼沒有需要撤回的問題，但有幾個**品質與穩健性**的改善要請 Codex 處理。完成後使用者會再請 Claude 複檢。

Claude 自己已修正一項：**F12 的 `Unexpected end of JSON input`**（PR #56）。原因已重現：開發時 API 由 `tsx watch` 重啟，那幾秒內 Vite proxy 回傳內容為空的 500，`ApiClient.request()` 直接 `response.json()` 就丟出解析錯誤。現在會先讀文字、有內容才解析，並顯示原本設計的「API 可能未啟動」訊息，另有 4 項單元測試。

## 第二輪複檢結果

- **流程**：#49～#55 的 head／merge SHA、CI（三項全綠且對應最新 commit）、`changedFiles` 數量都和 GitHub 與 git 一致。抽查記錄中的說法（dist 已清、MCP 清單為 digest、自動備份獨立命名、Windows 指令改 EncodedCommand）都屬實。
- **做得好**：
  - 匯入先做完整計畫再寫入：衝突會連帶傳到依賴它的資料；supersedes 的循環有處理；寫入在 IMMEDIATE 交易內完成並留下 audit；新匯入的專案預設暫停。
  - schema 驗證嚴格：每列必須剛好是支援的欄位，列舉、必填、數字欄位都有檢查，也有大小與筆數上限。
  - `VirtualList` 改成泛型，拿掉了原本唯一被允許的 `any`，並加上鍵盤捲動。
  - 清除 `dist` 的腳本有防呆，不會在 repo 根目錄執行。

## 請處理的項目（依優先順序，每項獨立 PR）

### 1. 匯入的效能：避免 O(n²) 並卡住 server

`packages/storage/src/project-data-transfer.ts` 有兩處線性掃描：

- `isAvailable()` 每次呼叫都用 `planned[table].some(...)` 掃描。
- `makePlan()` 的 `plannedUnique` 用 `rows[table].find(...)`。

大量「全部專案」匯入時（例如 5,000 筆 Session、5 萬筆事件）會有上億次比較。這段是同步執行，而且握著 IMMEDIATE 寫入鎖，整個 API server（含 SSE）都會卡住。

請改用 Map／Set（例如每個 table 維護「衝突 id」集合，以及「唯一鍵 → 列」的 Map）。另外加一個合成資料的量測或測試（例如 5,000 筆 Session 在合理時間內完成），把數字寫進 PR 說明。

### 2. 匯入端點的錯誤處理

`apps/server/src/server.ts`：

- `/api/import`、`/api/import/preview` 的 catch 會把**任何**例外都回 400，並把 `error.message` 原樣回給前端。SQLite 的內部錯誤（例如 `UNIQUE constraint failed: sessions.idempotency_key`）會把資料表與欄位名稱暴露出去，也把伺服器端的錯誤錯歸成使用者的錯。這違反既有的「500 不外洩內部訊息」慣例。
- 匯出用 `error.message === "找不到要匯出的專案。"` 判斷 404；只要改文案就會壞。

請在 storage 定義明確的錯誤型別或 outcome（例如 `ProjectDataTransferError`，帶 `code`：`invalid_bundle`、`unsupported_schema`、`project_not_found`…）。server 依 `code` 對應 400／404，其餘一律回 500，並使用固定、不含內部細節的訊息。請補 server 測試：模擬 storage 丟出一般錯誤時，回應為 500，且內容不含原始訊息。

### 3. 匯入預覽要顯示專案路徑

預覽的 `selectedProjects` 只有 id 與名稱。匯入的 `root_path` 來自不可信的檔案，專案一旦被改成「記錄中」，Agent 就會讀取那個路徑。

請在預覽回傳並在 UI 顯示每個專案套用路徑轉換後的 `root_path`，以及它會對應到既有專案、新增，還是衝突。也請移除 `parsed.data as ProjectDataImportInput` 這類強制轉型，讓 schema 推導出的型別與 core 型別由編譯器檢查一致（例如用 `satisfies`，或以 schema 為型別來源）。

### 4. E2E 在本機的偶發失敗（疑似與即時更新有關）

Claude 在本機跑了 4 次 E2E，失敗 2 次，失敗的是不同測試：

- 「rejects an Agent-proposed Knowledge candidate」：等待「Agent 已送出…Knowledge 候選」提示時逾時。
- 「keeps Worklog and Knowledge page-size controls at the intended default」：`expectBoundedVirtualList` 的位置檢查拿到 -52。

CI 目前都通過。推測原因：#39 的 SSE 在測試用 REST 寫入時推送「有變化」，頁面在量測或斷言中途重新載入。請確認原因並讓測試穩定，例如：

- 等待重新載入完成後再斷言；
- 對短暫出現的 toast 用更可靠的等待方式；
- 或在 E2E 提供關閉 SSE 的設定，另寫專門的即時更新測試。

請連跑至少 5 次，全部通過再附上結果。

### 5. 自動備份「今天」的判斷改用 server 的時區

`isBackupDue()` 用 UTC 日期判斷今天是否已經自動備份過。app 其他地方（報告、日期篩選）都用 server 所在的時區；以台北為例，等於每天早上 8 點才換日。請改用 `@work-intelligence/shared` 的本地日曆日期，並補測試。

### 6. 文件與記錄的小修正

- `.agents/skills/worklog-web-code-style/SKILL.md` 還寫著「No `any` except the documented `VirtualList` slot」，#54 已經拿掉那個 `any`，請更新。
- 工作記錄：
  - `verification.summary` 與 workSummary 裡的測試數量，口徑要一致或寫清楚（例如 #51、#52 寫「Server 11 項」和「Server 17 項」，一個只算 `server.test.ts`，一個算全部 server 測試）。
  - `git.branch`／`commitSha` 請記錄 finalize 當下實際所在的分支與 commit。
  - 知道對話開始時間時，請填 `startedAt`。

### 7. 仍可選做（上一輪標為可選、尚未實作）

- 共用 `runImmediateTransaction`：各 service 各自包了一層。
- SSE 同時連線數上限。

## 工作規則與品質要求

沿用 `.openspec/handoffs/2026-09-25-claude-to-codex.md` 的「工作規則」與「品質要求」：

- 繁體中文。
- 改 Web 前先讀 skill。
- 每完成一段就 finalize。
- 每項開獨立 PR；CI 對應最新 commit 且全綠才合併。
- 健康檢查逐步確認。
- 不修改使用者的實際資料庫。
- 新邏輯放在獨立模組、store 只做轉接；對外輸入用 zod 驗證；不複製貼上；PR 說明寫清楚取捨、沒做的部分與驗證方式。

## 仍需要使用者自己做的事

1. 原生資料夾選擇視窗：macOS、Windows、Linux 的實機操作。
2. Windows 實機上的備份與還原（含依專案匯出／匯入）。
3. 36 題真實資料庫檢索評估（題目與腳本只在使用者本機）。
4. Windows 實際 Codex 安裝中的 hook 載入狀態。

## 下次複檢 Claude 會特別看

- 匯入效能的量測數字，以及大量匯入時 server 是否仍能回應。
- 錯誤回應不再外洩內部訊息，型別不再靠強制轉型。
- E2E 在本機連跑的穩定性。
- 程式碼品質：模組邊界、重複程式碼、測試的邊界案例；`store.ts` 沒有變胖。
