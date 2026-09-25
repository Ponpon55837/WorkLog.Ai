# Handoff：2026-09-25 Claude Code → Codex（第四輪：從 MVP 到 1.0）

使用者的目標：**讓 WorkLog.Ai 從 MVP 變成正式可用的完整專案**。這一輪是長任務，請依下方階段順序進行，每一項開獨立 PR。完成後使用者會再請 Claude 複檢。

> **使用者決定（2026-09-25）**：授權採 **MIT**，`LICENSE` 已由 Claude 加上。**開機自動啟動、發行（tag／release／發行 workflow）與實機驗證，都等所有功能完成後再處理**，這一輪不要做。下方相關項目已標示「暫緩」。

## 第三輪複檢結果

- **流程**：#59～#66 的 CI 都對應最新 commit 且三項全綠；9 筆工作記錄的改動檔案數與 PR 一致。main 上完整健康檢查（build、test、typecheck、coverage、E2E）通過。
- **做得好**：
  - 匯入規劃全部改成 Map／Set 查找。Claude 實測 5,000 筆 Session 加 5 萬筆事件約 3.4 秒，與 Codex 回報的 2.5 秒同一個量級。
  - 匯入錯誤依 `code` 分類，其他例外一律回固定的 500，不外洩內部訊息。
  - 預覽顯示路徑與對應狀態，強制轉型已移除。
  - 自動備份改用本機時區判斷日期；SSE 有連線上限；共用交易 helper。
  - migration 10（確認空的 changed files）已在使用者實際資料庫套用，完整性與外鍵檢查都正常。
- **流程上的小偏差**（請在這一輪改正）：
  - #63～#66 用 squash 合併，repo 慣例是 merge commit（第一輪交接的規則）。
  - 9 筆記錄仍然都沒有 `startedAt`；第三輪第 6 項請你在知道對話開始時間時填上。
  - 匯入效能測試只把時間印出來，沒有設上限，效能退化時不會失敗。

## 1.0 的完成定義

以下都成立時，才算可以發行 1.0：

1. 一般使用者不需要開發模式：一個指令就能以正式模式啟動，Web 與 API 走同一個 port。（開機自動啟動暫緩，功能完成後再做。）
2. 升級安全：新版本第一次開啟資料庫前會自動備份；資料庫比程式新時，會清楚拒絕並說明怎麼處理。
3. 有版本資訊：semver、CHANGELOG；`/api/health` 與 UI 顯示版本。（tag、release 與發行 workflow 暫緩。）
4. 使用者可以自己排除問題：有 `pnpm doctor` 診斷指令、疑難排解文件，API 離線時 UI 有明確提示。
5. 品質有保障：CI 涵蓋 macOS（使用者的主要平台）；E2E 至少再加一種瀏覽器；有效能與檢索品質的回歸門檻。
6. 資料有完整的生命週期：可以永久刪除一個專案及其所有資料（有確認與事前備份）。
7. 文件完整：使用手冊、升級指南、疑難排解、CONTRIBUTING、SECURITY。

## 階段 A：正式執行模式（最優先）

**A1. API server 提供 build 好的 Web**

- `pnpm build` 後，`pnpm start` 用單一 process 同時提供 API 與 `apps/web/dist`：靜態檔、SPA 路由 fallback 到 `index.html`、有 hash 的 assets 用長快取、`index.html` 不快取。
- 同源以後，Web 不需要 CORS；請確認 Host／Origin 檢查在同源下仍然正確（同源請求可能帶 `Origin`，也可能不帶）。
- 正式模式的安全標頭：`Content-Security-Policy`（只允許 self，確認 Vue build 不需要 `unsafe-eval`）、`X-Content-Type-Options`、`Referrer-Policy`、`X-Frame-Options: DENY` 或 `frame-ancestors 'none'`。
- 靜態檔要擋 path traversal（`..`、編碼過的路徑、symlink），並附測試。
- `pnpm dev` 維持現狀，給開發用。README 的快速開始改成正式模式優先。
- E2E 請改跑正式模式，或至少新增一組跑正式模式的 E2E。

**A2. 開機自動啟動：暫緩**（使用者決定等功能都完成後再處理，這一輪不要做）。

**A3. API 離線時 UI 有明確提示**

- 現在 API 斷線時，每個頁面各自顯示錯誤。請加一個全域的連線狀態（SSE 斷線或請求失敗時顯示「無法連線到 Work Intelligence API」的 banner），恢復後自動重新載入。
- 請參考 #56 的 `ApiClient.request()` 錯誤訊息。

## 階段 B：升級安全與版本

**B1. migration 前自動備份**

- 開啟資料庫時，如果有待套用的 migration，先做一份帶版本標記的備份（例如 `pre-migration-v10-...`），並依既有保留規則管理，再套用 migration。記憶體資料庫與全新資料庫可以略過。
- 資料庫 schema 版本比程式支援的新時，API、MCP、CLI 都要清楚拒絕，說明「請更新 Work Intelligence」，不要崩潰或部分運作。
- 附測試：舊版本 fixture 升級時會先產生備份；新版本資料庫會被拒絕。

**B2. 版本與發行**

- 決定一個版本號來源（例如根目錄 `package.json`），讓 `/api/health`、MCP server 版本、Web UI（例如側欄底部）都顯示同一個版本與 schema 版本。
- 新增 `CHANGELOG.md`（Keep a Changelog 格式）。依 `docs/status.md` 與 git 歷史，把目前已完成的功能整理成 `1.0.0` 之前的內容（可以先放在 `Unreleased`）。
- 發行相關（`docs/release.md`、發行 workflow、tag、release）：**暫緩**，功能完成後再做。
- LICENSE 已決定為 MIT，Claude 已加入 `LICENSE` 並在各 `package.json` 標示 `"license": "MIT"`；你不需要再處理。

## 階段 C：診斷與文件

**C1. `pnpm doctor`**

- 檢查並用繁體中文列出結果與修正建議：
  - Node 版本（需要 `node:sqlite`）與 pnpm。
  - 是否已 build、dist 是否完整。
  - 資料庫位置、大小、`integrity_check`、schema 版本、最近一次自動備份時間。
  - API port 是否被占用、`/api/health` 是否可以連線。
  - Codex／Claude 是否已註冊 `work-intelligence` MCP：只讀取設定，不修改。
  - hook 檔是否存在。
- 預設只讀；輸出不含資料內容。

**C2. 文件**

- `docs/user-guide.md`：安裝、正式模式、第一次使用、日常流程、報告、Knowledge、備份與匯入、換電腦、升級。
- `docs/troubleshooting.md`：
  - API 無法連線或 port 被占用。
  - MCP 沒有載入新工具（需要重新連線）。
  - hook 沒有觸發。
  - 還原時資料庫仍被開著。
  - 匯入衝突。
  - 在開發模式看到 `Unexpected end of JSON input`（#56 已修，但可說明原因）。
- `CONTRIBUTING.md`：開發流程、skill、健康檢查、PR 與 merge commit 規則、工作記錄規則。
- `SECURITY.md`：威脅模型（只接受本機連線、預設不記錄、不回傳路徑）與回報方式。
- 更新 `docs/architecture.md`、`docs/status.md`，讓它們和 1.0 的狀態一致。

## 階段 D：品質門檻

**D1. CI 加上 macOS**：Quality matrix 加入 `macos-latest`。若有平台差異造成的失敗，請修正程式，不要略過測試。

**D2. 第二種瀏覽器**：E2E 加上 Firefox 或 WebKit（至少跑核心流程），必要時可以分成不同的 job。

**D3. 效能回歸門檻**

- 匯入效能測試加上寬鬆的上限（例如合成資料 5,000／50,000 筆需在 20 秒內），避免 CI 機器慢造成誤判，但能抓到數量級的退化。
- 把 `packages/storage/bench/read-paths.bench.mjs` 的關鍵路徑（Session 列表、Dashboard、週報、年報、Agent context、recall）整理成有門檻的測試，或在 CI 另外執行並比對上限。

**D4. 檢索品質回歸**

- 使用者的 36 題評估題是私有的。請改用**虛構的合成資料**建立一組可以放進 repo 的評估集（K／S／R／N／P 五類，每類數題，含只存在 raw handoff 的答案、中文雙字詞、路徑查詢），在測試中計算 hit@5 與 MRR，並設下門檻，防止 `work_recall` 的排序退化。
- 不要把使用者的真實資料或題目放進 repo。

**D5. 無障礙檢查**：E2E 加上 axe（例如 `@axe-core/playwright`），檢查六個主要頁面沒有 critical／serious 等級的問題。

## 階段 E：資料生命週期

**E1. 永久刪除專案與資料**

- 目前只能把專案設為暫停或忽略，資料會一直留著。請新增「刪除專案與所有資料」：
  - 刪除前自動備份。
  - 確認對話框要求輸入專案名稱。
  - 在單一交易內刪除專案底下的 Session、事件、Evidence、raw handoff、Knowledge、候選、報告整理、各種修改紀錄、搜尋索引與關聯（包含跨專案關聯中指向它的那一端）。
  - 留下一筆不含內容的刪除紀錄（時間、專案 id、刪除的筆數）。
- REST 用 `DELETE`，並要求 JSON body 帶確認用的專案名稱；MCP **不提供**刪除工具（刪除只能由使用者在 UI 或 CLI 進行）。
- 附 storage、server、E2E 測試。

**E2. 資料庫維護**

- 提供 `pnpm db:maintain`（`integrity_check`、`VACUUM`、`ANALYZE`、重建搜尋索引）。執行前檢查資料庫沒有被其他程式開著，或只做不需要獨佔的部分；結果寫進 doctor。

## 工作規則（重申）

- 繁體中文；改 Web 前讀 `worklog-ui` 與 `worklog-web-code-style` skill。
- 每完成一段就 finalize；**知道對話或這段工作的開始時間時，填 `startedAt`**。
- 每項開獨立 PR；CI 對應最新 commit 且全綠才合併；**用 merge commit 合併**（不要 squash），並刪除分支。
- 健康檢查逐步確認：build、test、typecheck、coverage、E2E。
- 不修改使用者的實際資料庫、不修改使用者的 Agent 設定；這一輪不做服務安裝、發行 workflow、tag 或 release。
- 新邏輯放在獨立模組，`store.ts` 只做轉接；對外輸入用 zod 驗證；錯誤要分類、不外洩內部訊息；不複製貼上。
- PR 說明寫清楚設計取捨、沒做的部分與驗證方式。

## 已由使用者決定

- 授權：MIT（已加入）。
- 開機自動啟動、發行（tag／release）與實機驗證：等所有功能完成後再處理，這一輪不做。實機項目包括：
  - 原生資料夾選擇視窗（macOS、Windows、Linux）。
  - Windows 的備份還原與匯入。
  - Windows Codex 的 hook 載入狀態。
  - 私有的 36 題檢索評估。

## 下次複檢 Claude 會特別看

- 正式模式的安全性：靜態檔 path traversal、CSP 與安全標頭、同源下的 Host／Origin 檢查。
- 升級：migration 前的備份確實產生、新版資料庫被正確拒絕。
- 刪除：單一交易、刪乾淨（含搜尋索引與關聯）、事前備份、MCP 沒有刪除能力。
- CI：macOS 與第二種瀏覽器實際執行並通過；效能與檢索門檻合理、不易誤判。
- 程式碼品質與文件的正確性（文件內容要與實際行為一致）。
