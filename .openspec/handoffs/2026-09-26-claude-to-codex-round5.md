# Handoff：2026-09-26 Claude Code → Codex（第五輪：把 1.0 補完整）

使用者的目標不變：**讓 WorkLog.Ai 成為正式可用的完整專案**。第四輪把 1.0 的骨架做齊了；這一輪補上「日常用得安心」還缺的部分：備份管理、系統狀態、穩健性、工程整理與品質門檻。這是長任務，請依階段順序進行，每一項開獨立 PR。完成後使用者會再請 Claude 複檢。

> **使用者決定（維持不變）**：授權為 MIT。**開機自動啟動、發行（tag／release／發行 workflow）、版本號升到 1.0.0，以及實機驗證**，都等所有功能完成後再處理，這一輪不要做。

## 第四輪複檢結果

**流程**：#69～#85 都用 merge commit 合併，最新 head 的 CI 全部成功。16 筆工作記錄的改動檔案數與各 PR 一致。Claude 在 main 重新跑完整健康檢查，全部通過：

- build、test、typecheck、coverage。
- 效能門檻、檢索品質門檻。
- E2E：Chromium 32 項通過、1 項略過；Firefox 2 項通過。

**做得好**：

- 靜態檔防護完整：逐段檢查、`realpath` 確認沒有離開根目錄，也擋掉控制字元與反斜線。串流途中出錯時直接中斷連線，不會重寫標頭。
- 同源判斷先經過 Host 白名單，DNS rebinding 與其他本機 port 的頁面都會被擋下。
- migration 流程：先檢查 schema 版本，再做備份（失敗就停止），然後在單一交易內套用。錯誤都有分類，也不外洩內部訊息。
- 永久刪除：交易內重新確認專案名稱，涵蓋跨專案關聯與搜尋索引，稽核紀錄不含內容。
- `db:maintain` 用獨占鎖偵測使用中的資料庫。Claude 另外實測：閒置的 WAL 連線也會讓獨占鎖失敗，所以偵測是有效的。
- doctor 動態載入 `node:sqlite`，Node 太舊時仍能先顯示診斷。

**Claude 已修正（PR「Round 4 review fixes」）**：

1. MCP 建立 store 時沒有傳入備份設定，會忽略 `WORK_INTELLIGENCE_BACKUP_DIR`／`KEEP`；升級後若由 MCP 先開資料庫，migration 前備份會寫到不同的位置。
   - 修正：新增 `backupOptionsFromEnvironment()`，API、CLI、MCP 共用。
   - 相對路徑改以資料庫所在資料夾為基準（原本以 cwd 為基準，而 MCP 的 cwd 是 `apps/mcp`）；doctor 使用相同規則。
2. Web client 只要收到 status ≥ 500 就判定 API 離線。API 自己回的 JSON 5xx（例如刪除前備份失敗的 503）會讓畫面誤顯示「無法連線」。
   - 修正：只有網路錯誤，或不是 JSON 的 5xx（例如開發模式的 proxy）才算離線。
3. doctor 只比對 hook 的 `command` 字串，看不懂 Claude Code 的 exec 形式（`command: node`，腳本放在 `args`），因此對使用者實際的設定誤報警告。
   - 修正：`args` 也列入比對，並補上測試。
4. port 被占用時，`pnpm start` 丟出 Node 的 stack trace；而且在失敗前已經開過資料庫、跑過備份檢查。
   - 修正：改成中文說明並以 exit 1 結束；每日備份排程改到確定開始監聽後才啟動。
5. 文件：
   - CHANGELOG 補上 #74 之後的內容。
   - README 全面更新。
   - agent-setup 加上 macOS／Linux 的 MCP 註冊指令。
   - troubleshooting 加上 `db:maintain` 與 port 被占用的說明。
   - 修正 testing.md 裡互相矛盾的主要平台描述（維護者主要使用 macOS）。
   - 使用手冊說明：刪除專案後，資料仍存在於之前的備份中。

**流程上的小偏差**：D4（`a75a9081`）與 D5（`cab18aad`）兩筆工作記錄沒有 `startedAt`，其餘 14 筆都有。這一輪請每一筆都填。

## 階段 A：資料生命週期補完（最優先）

**A1. 備份管理**

目前使用者看得到備份清單，但無法清理。第四輪的刪除功能也造成一個缺口：專案刪除後，資料還留在先前的備份裡，使用者只能自己去檔案總管刪除。

- 在「專案 → 資料備份」列出所有備份：種類（自動、手動、migration 前、刪除前、維護前）、時間、大小，以及總大小。
- 可以刪除單一備份。確認對話框要顯示檔名與種類；刪除最後一份可用備份時要額外警告。
- REST：`DELETE /api/backups/:fileName`，要求 JSON body（沿用既有的 CSRF 防護慣例）。
  - 檔名必須嚴格符合備份命名規則，只能刪除備份目錄內、屬於目前資料庫的檔案。
  - 要擋 `..`、絕對路徑、編碼過的路徑與 symlink，並附測試。
- CLI：`pnpm db:backups`（列出）與 `pnpm db:backups --delete <檔名>`（互動確認）。
- MCP **不提供**刪除備份的能力。
- 永久刪除專案成功後的結果畫面，要提醒「先前的備份仍包含此專案」，並連到備份管理。

**A2. 刪除紀錄可見**

- 專案頁顯示已刪除專案的稽核紀錄：時間、專案 id、各類刪除筆數，不含任何內容。
- 提供唯讀的 REST endpoint。MCP 不需要。

## 階段 B：系統狀態頁

讓使用者不開終端機也能確認系統是否健康。

- Web UI 新增「系統狀態」（放在「專案」底下，或側欄底部版本資訊的連結）。顯示：
  - 程式版本、schema 版本。
  - 資料庫位置、大小。
  - 最近一次自動備份、備份數量與總大小。
  - 最近一次 `db:maintain` 的結果（成功／失敗代碼）。
  - 目前 SSE 連線數。
- 唯讀 REST：`GET /api/system/status`。
  - **不要**讀取使用者 home 目錄下的 Agent 設定檔；MCP／hook 的檢查留給 `pnpm run doctor`。頁面上說明可以執行 doctor 取得完整診斷。
  - 不要在這個 endpoint 執行耗時的 `integrity_check`；最多做 `quick_check`，或只顯示最近一次維護的結果。
- 和 doctor 重複的判斷邏輯請抽成共用模組，不要複製貼上。doctor 仍然不能靜態匯入 `node:sqlite`。

## 階段 C：穩健性

**C1. 資料庫忙碌時的錯誤分類**

- `db:maintain` 或 `db:restore` 執行期間，API 與 MCP 可能遇到 `SQLITE_BUSY`／`database is locked`。
- 請分類這類錯誤：REST 回 503 並附固定訊息「資料庫暫時忙碌，請稍後再試」；MCP 回可理解的錯誤，不外洩 SQLite 訊息。
- Web 不應把這種情況顯示成「API 離線」（參考 Claude 對 `isGatewayFailure` 的修正）。
- 附測試：用另一個連線持有寫入鎖來模擬。

**C2. 優雅關閉**

- 確認 `SIGINT`／`SIGTERM` 時：
  - SSE 連線會被關閉。
  - 進行中的寫入交易會完成或回滾，不會留下半套資料。
  - 資料庫正常關閉，WAL 會 checkpoint。
- 用測試或腳本驗證，把結果寫進 PR 說明。

**C3. MCP 啟動失敗的訊息**

- MCP 由 Agent 啟動，stderr 通常看不到。請確認資料庫過新、備份失敗等啟動錯誤，Agent 端能看到清楚的原因。
- 例如：仍然完成 MCP 握手，但每個工具都回傳同一個分類過的錯誤；或者文件說明 Agent 端去哪裡看 log。
- 請先查 MCP SDK 的行為再決定做法，並在 PR 說明取捨。

## 階段 D：工程整理

**D1. `store.ts` 瘦身**

- 目前 3,025 行。把剩下的舊欄位相容處理與仍留在其中的業務邏輯拆到各自的 service，讓 `store.ts` 只做轉接，**目標 1,500 行以下**。
- 不改變任何行為與公開 API。每拆一塊就跑完整測試，可以分成多個 PR。
- 拆完後更新 `docs/status.md` 的「工程整理」列。

**D2. 覆蓋率補齊**

- `packages/core`、`packages/project-policy`、`packages/shared` 目前沒有覆蓋率設定。請加上 `test:coverage`、量測基線，並設下門檻。
- 尤其是 `project-policy`：它是 default-deny 的安全閘門，分支覆蓋率應該接近 100%。
- 如果可行，在 `pnpm test:coverage` 加上全域門檻。

## 階段 E：品質門檻

**E1. WebKit 核心流程**：使用者主要用 macOS，請把帶有 `@cross-browser` 標記的核心流程也跑在 WebKit 上。WebKit 在 Ubuntu 的行為和 macOS Safari 有差異時，請在文件註明限制，不要宣稱等同 Safari 實機驗證。

**E2. 依賴套件安全檢查**：CI 加上 `pnpm audit --prod`（high／critical 會失敗）。若有無法立即修正的弱點，要有明確、會到期的例外清單，不要整個關掉。

**E3. 無障礙**：

- axe 也在 Firefox 跑六個主要頁面。
- 新增的「系統狀態」與「備份管理」納入 axe 檢查。
- 加一項純鍵盤操作的 E2E：Tab 走完刪除專案或刪除備份的確認流程。

## 工作規則（重申）

- 繁體中文；改 Web 前先讀 `worklog-ui` 與 `worklog-web-code-style` skill。
- 每完成一段就 finalize，**每一筆都填 `startedAt`**。
- 每項開獨立 PR。CI 對應最新 commit 且全綠才合併；用 merge commit 合併（不要 squash），並刪除分支。
- 健康檢查逐步確認：build、test、typecheck、coverage、效能、檢索品質、E2E。
- 不修改使用者的實際資料庫、Agent 設定或全域 hook；不重新加入 repo 內的 `.codex/hooks.json`。這一輪不做服務安裝、發行 workflow、tag 或 release，也不把版本號升到 1.0.0。
- 新邏輯放在獨立模組，`store.ts` 只做轉接；對外輸入用 zod 驗證；錯誤要分類、不外洩內部訊息；不複製貼上。
- 刪除類操作（備份、專案）只能由使用者在 UI 或 CLI 進行，MCP 不提供。
- PR 說明寫清楚設計取捨、沒做的部分與驗證方式。
- 結束時比照第四輪，寫一份複檢交接文件（PR、head／merge SHA、CI run、工作記錄 ID 對照）。

## 暫緩（功能完成後再做）

- 開機自動啟動（服務安裝）。
- 發行：`docs/release.md`、發行 workflow、tag、release，以及版本號升到 1.0.0。
- 實機驗證：
  - 原生資料夾選擇視窗（macOS、Windows、Linux）。
  - Windows 的備份還原與匯入。
  - Windows Codex 的 hook 載入狀態。
  - 私有的 36 題檢索評估。

## 下次複檢 Claude 會特別看

- 備份刪除：檔名驗證與 path traversal、只能刪除屬於目前資料庫的備份、MCP 沒有刪除能力。
- 系統狀態 endpoint 不讀取 home 設定檔、不執行耗時檢查、不外洩內部訊息；與 doctor 沒有重複的邏輯。
- 忙碌錯誤的分類，以及 Web 不會誤判為離線。
- `store.ts` 拆分後行為不變（測試數量與覆蓋率不下降）。
- 新增的 CI 門檻實際有執行，而且不容易誤判。
- 文件與實際行為一致。
