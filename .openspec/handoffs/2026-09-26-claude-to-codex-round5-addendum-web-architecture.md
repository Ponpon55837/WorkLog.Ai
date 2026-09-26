# 附加任務：2026-09-26 Claude Code → Codex（第五輪附加：Web 架構與資料流）

這份文件是第五輪的**附加任務**，不取代 `.openspec/handoffs/2026-09-26-claude-to-codex-round5.md`。第五輪原本的階段 A～E 照常進行；本文件的階段 F 請排在**階段 D（工程整理）之後、階段 E（品質門檻）之前**，因為 E 的新頁面與 axe 檢查會用到重構後的結構。

使用者的問題：「Web 沒有使用狀態管理器，是不是應該用 Pinia 讓資料流動更順暢？」以及「有沒有其他可以優化的架構問題？」。以下是 Claude 以 `origin/main`（`4f823e8`）為準的分析結果與要做的事。

## 現況分析

### 1. 其實已經有全域狀態，只是手寫的

`apps/web/src/composables/` 裡的領域 composable 都在**模組頂層**宣告 `ref`，等於自己實作的全域 store。例如：

| composable                  | 頂層狀態數 | 行數 |
| --------------------------- | ---------: | ---: |
| `useReports.ts`             |         29 |  495 |
| `useGraph.ts`               |         20 |  458 |
| `useKnowledge.ts`           |         19 |  306 |
| `useSessions.ts`            |         13 |   99 |
| `useProjects.ts`            |         10 |  169 |
| `useProjectDataTransfer.ts` |         10 |  193 |

這是 `worklog-web-code-style` skill §4 明文規定的做法（「Domain state is a module-level singleton」）。問題不是「沒有 store」，而是這種寫法缺少：

- **測試隔離**：模組層級的狀態在測試之間共用，無法每個測試重新建立，所以資料層幾乎沒有單元測試（見第 5 點）。
- **Devtools**：無法檢查狀態或追蹤變化來源。
- **重設**：沒有 `$reset`。表單與對話框的草稿（例如 `useProjects` 的 `projectName`、`projectRoot`）放在全域，離開頁面後仍然殘留。
- **明確的邊界**：store 之間的相依關係是隱性的模組互相匯入。

### 2. 資料流真正的痛點：伺服器資料的失效與重新載入

- **全域重載**：SSE 收到資料變動，或按下重新整理時，`useAppRefresh` 會把 `refreshTick` 加一，**每個已掛載的畫面都重新載入自己的全部資料**；`App.vue` 也會同時重載 dashboard、projects 與 health。同一份資料（例如 projects）在 `App.vue` 和 `ProjectsView` 會各打一次，其中一次被 `runKeyed` 中止。
- **失效靠手動、散落各處**：每個寫入動作都要自己記得刷新哪些清單。例如：
  - `useHandoffImport` 匯入後手動呼叫 `loadDashboard()`、`loadProjects()`、`useSessions().loadSessions()`。
  - `useRecordVoid` 作廢後手動呼叫 `useProjects().loadDashboard()`。
  - `useProjects.addProject()` 手動呼叫 `loadProjects()` 與 `loadDashboard()`。
  - 漏掉任何一處，畫面就會顯示舊資料。
- **沒有快取與去重**：切換頁面時一律重新請求；同一份資料的請求無法共用。

**只把 ref 搬進 Pinia 解決不了這個問題**，還需要一層伺服器資料的快取與失效機制。

### 3. 違反 skill 規則的地方

- skill 規定「會呼叫 API 的程式只能放在 composable，不能放在 component」，但：
  - `App.vue:44` 直接呼叫 `useApi().client.getHealth()`。
  - `CommandPalette.vue:94-103` 直接呼叫 `client.listSessions()` 等 API。

### 4. 錯誤訊息用英文字串當 key

- `useProjects.ts` 的 `projectDeletionMessages` 用 API 回傳的**英文錯誤訊息**當 key，對應成中文。只要伺服器改了文案，對應就會失效，使用者只會看到通用訊息。
- 根本原因：`server.ts` 的 `sendError()` 只回 `{ error: message, details }`，沒有機器可讀的錯誤代碼。第三輪已在 server 內部改用 `code`（`ProjectDataTransferError`、`ProjectDeletionError` 等），但沒有傳給前端。

### 5. Web 覆蓋率只量了 3 個檔案

- `apps/web/vitest.coverage.config.ts` 的 `include` 只有 `utils/report.ts`、`utils/format.ts`、`composables/useActiveRequestWatch.ts`。
- 28 個 composable、約 3,800 行的資料層都不在統計範圍內。`tests/web/` 只有 4 個測試檔。
- 所以「Web 有覆蓋率門檻」目前只對極小範圍成立；資料層主要靠 E2E 保護。

### 6. 檔案過大

| 檔案                                 | 行數 |
| ------------------------------------ | ---: |
| `views/ReportsView.vue`              |  811 |
| `api/client.ts`                      |  667 |
| `components/domain/SessionPanel.vue` |  650 |
| `composables/useReports.ts`          |  495 |
| `composables/useGraph.ts`            |  458 |

## 決定

**採用 Pinia（setup store）＋ Pinia Colada。**

- Pinia 是 Vue 官方的狀態管理。現有的「模組層級單例」可以幾乎一對一改寫成 setup store（`defineStore("projects", () => { … })`），風險低。版本：`pinia` 4.0.3（peer `vue ^3.5.11`，專案目前是 `^3.5.13`）。
- Pinia Colada 是 Pinia 團隊的資料載入層（`@pinia/colada` 1.4.6，已是穩定版），提供：
  - query key 快取、同一個 key 的請求去重、stale time。
  - `AbortSignal` 支援，可以取代 `runKeyed`。
  - mutation 完成後依 key 失效（`invalidateQueries`），取代散落各處的手動刷新。
  - 只重新載入目前有畫面在使用的 query。
- 考慮過的替代方案：
  - `@tanstack/vue-query`（5.103.3）：功能相當成熟，但它的快取與 Pinia 是兩套狀態系統，會讓 client 狀態和伺服器狀態分處兩地。
  - 自己寫一層快取：依賴最少，但要自己維護去重、失效、abort 與測試，成本不划算。

採用前請先確認：`pnpm audit --prod` 沒有 high／critical 問題；打包大小的增加記錄在 PR 說明；授權相容（兩者都是 MIT）。**若評估後發現 Pinia Colada 有阻礙採用的問題**（例如與 Vue 版本或 SSE 失效模式不相容），請改用 TanStack Query，並在 PR 說明原因；不要自己寫快取層。

## 階段 F：Web 架構與資料流

每一項開獨立 PR；F2、F3 可以依領域拆成多個 PR。**每個 PR 都不能改變使用者看到的行為**，E2E 必須維持全綠。

**F1. 引入 Pinia 與 Pinia Colada，更新規範，並做一個樣板領域**

- 安裝 `pinia` 與 `@pinia/colada`，在 `main.ts` 註冊。
- 更新 `.agents/skills/worklog-web-code-style/SKILL.md` §4（以及目錄結構那一節）：
  - 領域狀態改為 `apps/web/src/stores/` 下的 Pinia setup store，一個領域一個 store。
  - 伺服器資料用 Pinia Colada 的 query；寫入用 mutation，並宣告要失效的 key。
  - query key 集中定義在一個檔案（例如 `stores/query-keys.ts`），不要在各處手寫字串。
  - 表單、對話框草稿這類 UI 狀態放在 component 內，或提供 `$reset`；不要放在全域。
  - 保留「會呼叫 API 的程式只能放在 store／composable」的規則。
  - 同步更新 `worklog-ui` skill 中提到 composable 狀態的部分（如果有）。
- 先遷移 **projects** 領域作為樣板：`useProjects` → `stores/projects.ts`，dashboard、projects 清單改用 query，新增／更新狀態／刪除改用 mutation 並宣告失效。
- 保留 `useProjects()` 作為過渡用的轉接（回傳 store 的內容），讓其他地方可以分批遷移；F3 完成後移除。

**F2. 以失效取代全域重載**

- SSE 的 `changed` 事件改成「讓目前有畫面在使用的 query 失效並重新載入」，不再讓每個畫面重載全部資料。SSE 事件維持**不帶資料**（隱私設計不變）。
- 分頁回到前景時的補抓、API 恢復連線後的重新載入，也改成讓使用中的 query 失效。
- 移除 `refreshTick`／`requestAppRefresh`／`useViewLoader` 的全域重載；標頭的「重新整理」按鈕改成讓所有使用中的 query 失效。
- 保留 `useActiveRequestWatch` 在請求處理中時的輪詢行為（可以改用 query 的 `refetchInterval` 或等效機制），並確認分頁在背景時會暫停。
- 驗證：
  - 同一頁面上，同一份資料在一次重新整理中只發出一個請求（可以在 E2E 用 `page.on("request")` 計數）。
  - Agent 寫入後，目前畫面在合理時間內更新；其他頁面切換過去時會拿到新資料。

**F3. 逐一遷移其他領域**

- 依序遷移：sessions、session detail／editor／links、record void、knowledge、knowledge candidates、reports（含 synthesis）、metadata backfill、handoff import、backups、project data transfer、graph、dashboard。
- 每個 mutation 都要明確宣告它會讓哪些 query 失效，取代原本散落的手動 `load*()` 呼叫。
- 把 `App.vue` 的 health 請求與 `CommandPalette.vue` 的搜尋請求移進 store／query。
- 保留網址參數同步（`useRouteQuery`）的行為；網址仍是篩選條件的唯一來源，store 只從網址讀取，不要形成兩份各自維護的狀態。
- 全部完成後刪除 `composables/` 裡已經沒有使用的領域 composable 與過渡轉接；`useApi`／`runKeyed` 若已不再需要也一併移除。與 UI 行為相關的 composable（`useHotkeys`、`useFocusTrap`、`usePopover`、`useRouteQuery`、`useToast`、`useConfirm` 等）保留。

**F4. API 錯誤代碼**

- `sendError()` 回應加上機器可讀的 `code`（例如 `{ error, code, details }`），沿用 server 內部既有的錯誤分類（`PROJECT_NAME_MISMATCH`、`PROJECT_BACKUP_FAILED`、`invalid_bundle`、`backup_unavailable`…）。沒有特定分類的錯誤給通用代碼（例如 `invalid_input`、`not_found`、`internal_error`）。
- `docs/rest-api.md` 列出所有錯誤代碼。這是**只增不減**的相容變更，`error` 欄位保留。
- `ApiClient` 丟出的錯誤帶上 `code` 與 HTTP status（例如 `ApiError` 類別）。
- 前端改成依 `code` 對應中文訊息，移除 `projectDeletionMessages` 這類以英文訊息當 key 的對應；全面搜尋是否還有其他地方比對錯誤字串。
- 第五輪 C1 的 `SQLITE_BUSY` 分類請使用同一套代碼（例如 `database_busy`）。

**F5. 拆分過大的檔案**

- `ReportsView.vue`（811 行）與 `SessionPanel.vue`（650 行）拆成有明確職責的子元件，目標每個 SFC 400 行以下。
- `api/client.ts`（667 行）依領域拆成多個模組（例如 `api/projects.ts`、`api/sessions.ts`），共用的請求與錯誤處理留在一個核心模組。
- `useReports`／`useGraph` 在 F3 遷移時一併拆分，不要把 495 行原封不動搬進一個 store。

**F6. Web 單元測試與覆蓋率**

- 覆蓋率的 `include` 擴大到 `apps/web/src/stores/**`、`apps/web/src/api/**`、`apps/web/src/utils/**`，以及保留的 composable。
- 每個 store 都要有單元測試：每個測試建立新的 Pinia（`setActivePinia(createPinia())`），用假的 API client 或 `fetch` stub 驗證：
  - query 的載入、錯誤與取消。
  - mutation 成功後讓正確的 query 失效。
  - 錯誤代碼對應到正確的中文訊息。
- 依實際量測結果設定門檻，建議 stores 與 api 的分支覆蓋率至少 80%。
- 更新 `docs/testing.md`，寫清楚 Web 覆蓋率涵蓋的範圍。

## 完成後請更新

- `docs/architecture.md`：新增 Web 資料流一節（store、query key、失效規則、SSE 如何觸發失效）。
- `docs/status.md`：「工程整理」列補上 Web 架構的結果。
- `CHANGELOG.md`：`Changed` 記錄資料層改為 Pinia＋Pinia Colada、錯誤代碼；`Added` 記錄 `code` 欄位。
- README 的「專案結構與開發」補上 `stores/`。

## 規則（沿用第五輪）

- 繁體中文；改 Web 前先讀 `worklog-ui` 與 `worklog-web-code-style` skill（F1 會更新後者，後續 PR 以更新後的版本為準）。
- 每完成一段就 finalize，每一筆都要填 `startedAt`。
- 每項開獨立 PR；CI 對應最新 commit 且全綠才合併；用 merge commit 合併並刪除分支。
- 健康檢查逐步確認：build、test、typecheck、coverage、效能、檢索品質、E2E。
- 不修改使用者的實際資料庫、Agent 設定或全域 hook；暫緩項目（開機自動啟動、發行、版本升到 1.0.0、實機驗證）維持不做。
- 在最後的複檢交接文件中，把階段 F 的 PR 一併列入對照表。

## 下次複檢 Claude 會特別看

- 使用者看到的行為沒有改變：E2E 全綠，沒有為了配合重構而刪改斷言。
- 一次資料變動或重新整理不會造成重複請求；寫入後相關畫面都會更新，沒有漏掉的失效。
- query key 集中管理，沒有散落的字串；mutation 都宣告了失效範圍。
- 錯誤一律依 `code` 處理，沒有比對英文訊息；新增的 `code` 不外洩內部細節。
- store 的單元測試確實隔離，覆蓋率範圍與門檻和文件描述一致。
- 新增依賴通過 `pnpm audit --prod`，PR 說明記錄了打包大小的變化。
