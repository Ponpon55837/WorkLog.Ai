# WorkLog.Ai 複檢報告 II（Codex 修正後追蹤）

- 日期：2026-09-21
- 對應原始報告：[docs/reviews/2026-09-21-code-review.md](./2026-09-21-code-review.md)
- 審查方式：git 目前無可用 commit 歷史比對 diff（整個 repo 為 untracked），改採直接讀取現行程式碼，逐項核對原報告 24 個項目的修正狀態，並檢查是否有新引入的問題。
- 使用方式：交給 Codex 繼續處理「未修正／部分修正」項目，以及優先修掉本次新發現的問題。

## 總體結論

Codex 這次的修正**優先且紮實地處理了「正確性／併發」類的 High/Medium 項目**（idempotency 交易化、schema migration 交易保護、metadata backfill 逾時回收、symlink TOCTOU、Content-Type 檢查、MCP payload 上限），做法比原報告建議的更講究（例如用 `BEGIN IMMEDIATE` + `busy_timeout` 從根本避免 race，而非「查重後 catch UNIQUE」）。

但「架構／可維護性」（`store.ts` 拆分、`App.vue` 拆分、樣板去重）與「工具鏈」（ESLint、覆蓋率）**幾乎完全沒有處理**，`store.ts` 反而從 4658 行長到 4728 行，`App.vue` 從 3192 行長到 3330 行——問題沒有惡化但也沒有收斂，技術債持續累積。

另外發現 **1 個新的中等風險問題**：`createMetadataBackfillRequest`/`listMetadataBackfillRequests` 回傳的 `skipped` 結果把 `projectId` 的值塞進名為 `projectRoot` 的欄位，屬於 API contract 語意錯誤（見下方「新發現問題」）。

---

## 一、已修正（做得紮實，可視為結案）

| # | 項目 | 修正方式 |
|---|---|---|
| 1 | `recordKnowledge`/`createMetadataBackfillRequest`/`createReportSynthesisRequest` 跨行程 race | 改用 `runImmediateTransaction`（`BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`，`store.ts:1385-1399`）+ `PRAGMA busy_timeout=5000`，第二個行程的交易會排隊等鎖，查重時必定看到已存在的列，回傳 `duplicate:true`，而非撞 UNIQUE 例外 |
| 2 | `finalizeSession` 查重與寫入交易分離 | 同上，查重 SELECT 與 INSERT 已包進同一個 `runImmediateTransaction`（`store.ts:4409-4430`） |
| 3 | Schema migration 缺交易保護 | `ensureSchemaMigrations` 整段（含高風險的表重建）已包進 `runImmediateTransaction`（`store.ts:1325-1382`），中斷會 ROLLBACK 不會卡在半損毀狀態 |
| 7 | Metadata backfill 無逾時回收 | 新增 `METADATA_BACKFILL_PROCESSING_TIMEOUT_MS`（`store.ts:134`）與 `recoverStaleMetadataBackfillRequests()`（`store.ts:2516-2550`），對稱於既有的 report synthesis 版本 |
| 8 | `updateSessionMetadata`/`updateSessionVerification` 缺交易 | 兩者的多語句寫入已包進 `runImmediateTransaction`（`store.ts:3450-3459`、`3509-3531`），與 `updateSessionSummary`/`finalizeSession` 寫法一致 |
| 10 | symlink TOCTOU | 新增 `packages/storage/src/path-safety.ts` 的 `safeExistingProjectPath()`，回傳 `realpathSync` 解析後的實際路徑而非 lexical candidate；所有實際 `readFileSync` 呼叫點（`readProjectSource`、`captureHandoff`、Git HEAD/ref 讀取、handoff-importer 的候選掃描）都已改用此 helper |
| 11 | `readJsonBody` 未檢查 Content-Type | `apps/server/src/server.ts:71-75` 已加檢查，非 `application/json` 回 415 |
| 12 | MCP 側無 payload 大小上限 | 新增 `apps/mcp/src/input.ts` 的 `parseMcpInput()`，估算 JSON 序列化位元組數，與 HTTP 側一致的 1.5MB 上限（`MAX_INPUT_PAYLOAD_BYTES`），已確認全部 25 處 MCP 工具呼叫都改用此函式 |
| 13a | `/api/health` 假狀態 | 改為實際呼叫 `store.listProjects()` 做輕量查詢，失敗回 503（`server.ts:129-142`） |
| 13b | `ALLOWED_ORIGINS=*` 靜默過濾 | 偵測到 `*` 時 `console.error` 明確警告（`server.ts:49-51`） |
| 13c | `readProjectSource` 無大小上限 | 已補 `.slice(0, 200_000)`（`store.ts:4594`），惟該方法仍是未被路由呼叫的死代碼 |

---

## 二、部分修正（需要接續處理）

### 9. `safeProjectPath` 同步 I/O 阻塞事件迴圈 — 實質未解決

- **現況**：`packages/project-policy/src/index.ts:54-93` 邏輯與原本幾乎相同，仍是 `existsSync` 迴圈往上層爬 + `realpathSync`，全同步阻塞；沒有批次快取、沒有搬到 worker/setImmediate。
- **上限也未收緊**：`changedFiles`/`changedFileChanges`/`changedFilesProvenance` 仍各自上限 500（`packages/schema/src/index.ts:86-88, 212-215`）。
- **影響**：`finalizeSession`/`updateSessionMetadata` 一次仍可能觸發數百次同步系統呼叫，單執行緒 `http` server 阻塞事件迴圈的風險原封不動。
- **後續修法**（沿用原報告建議）：
  1. 短期：把上限從 500 降到 100-200。
  2. 中期：在 `normalizeChangedFiles`/`mergeChangedFiles`（`store.ts:600-724`）呼叫端快取一次 `realpathSync(projectRoot)`，避免每個路徑都重新解析專案根目錄；或把批次路徑檢查搬到 `worker_threads`。

### 17. `getGraph` 查詢效率 — 只解決一半

- **已改善**：「算總數」部分已從逐專案 COUNT 改成 3 條 `WHERE project_id IN (...)` 批次查詢（`store.ts:4074-4113`）。
- **仍未解決**：
  - 建圖迴圈仍是 `for (const project of projects)` 內逐一呼叫 `this.listSessions`（`store.ts:4174`）與 `this.searchKnowledge`（`store.ts:4221`），往返次數仍隨專案數線性增加（N+1）。
  - 「算總數」批次查詢與「建圖」迴圈**實質上重複掃描了同一批 session/knowledge 資料**，原報告指出的「同樣資料撈兩遍」本質沒有解決，只是重複的顆粒度變了。
- **後續修法**：把 sessions/knowledge/evidence 改成一次性用 `WHERE project_id IN (...)` 撈全部後在記憶體中依 project 分組，同一份資料同時供「算總數」與「建圖」使用，取代目前兩階段各自查詢的模式。

### 22. `handoff-importer.ts` 單元測試 — 僅有整合測試

- **現況**：`store.test.ts:936-992` 透過公開 API `previewHandoffImport` 對分類邏輯做了整合層級驗證（涵蓋 `blocked`/`pending`/`planning_only`/`excluded_by_user`）。
- **缺口**：`classifyHandoff`/`parseVerification`/`extractChangedFiles` 仍是模組私有函式，沒有針對函式本身的單元測試，原報告要求的「中英文混合、多層 heading、程式碼區塊內誤判」邊界情境仍未覆蓋。
- **後續修法**：export 這三個函式（或建立測試專用的 barrel）補上 `handoff-importer.test.ts`，針對邊界情境寫測試。

### 24. 測試覆蓋率工具與 schema 邊界測試 — schema 測試已補，覆蓋率工具仍缺

- **已改善**：新增 `packages/schema/src/index.test.ts`（46 行），驗證 `finalizeSessionInputSchema`/`updateSessionMetadataInputSchema` 拒絕超過 500 筆 `changedFiles`、`metadataBackfillApplyInputSchema` 拒絕超過 100 筆更新。
- **仍缺**：全 repo 沒有 `@vitest/coverage-v8` 依賴，`test` script 仍是純 `vitest run src`，無覆蓋率門檻設定。
- **後續修法**：加入 `@vitest/coverage-v8`，在 CI 設定 `storage`/`schema` 的最低覆蓋率門檻。

### 前端：Graph／大型列表虛擬化 — Graph 有緩解，列表未處理

- **Graph 已緩解**：新增配額機制（`graphVisualQuotas`/`graphVisualBaseQuotas`，`App.vue:1798-1820`），依節點種類比例分配可視數量上限並 `.slice(0, quota)` 截斷（1837-1838 行），畫面顯示「顯示 N / 總數 節點」。這是客戶端取樣截斷，非真正的 viewport-based 虛擬捲動，但確實避免了 500 節點/1000 邊全量掛載 DOM 的最壞情況。
- **列表未處理**：Sessions/Knowledge 的「All」選項（`listPageSizeOptions`，`App.vue:56-62`）仍會向後端請求不分頁的全量資料，且 `package.json` 未安裝任何虛擬捲動套件，選「All」時仍整批 `v-for` 渲染。
- **後續修法**：對「All」選項設硬上限，或導入虛擬捲動元件。

---

## 三、未修正

| # | 項目 | 現況 |
|---|---|---|
| 4 | `App.vue` 拆分成 views/components | 完全未拆分，檔案結構仍是 `main.ts`/`style.css`/`App.vue` 三檔，`App.vue` 反而從 3192 行**增加到 3330 行**（新增了項目 6 的 AbortController 機制，但疊加在同一檔案上） |
| 5 | 集中 API client + `useApiRequest` composable | 全 repo 搜尋無任何相關實作，`App.vue` 內仍有約 97 個頂層函式各自處理 loading/error/URL 組裝 |
| 13（剪貼簿部分） | `copyReportSynthesisInstruction`/`copyMetadataBackfillInstruction` 抽共用 composable | 兩份函式邏輯逐字重複（`App.vue:734-749` 與 `1297-1312`），仍各自用已棄用的 `document.execCommand` fallback |
| 13d | `handoff-importer.ts` ReDoS 防護 | 正則與原本一致，未加執行時間/迭代次數軟上限，未引入 `safe-regex` 類工具（緩解因素：輸入仍有 `.slice(0, 200_000)` 上限、多用 lazy quantifier，實務風險偏低） |
| 14 | `store.ts` 拆分成多個 repository/module | 完全未拆分，反而從 4658 行長到 **4728 行**，`WorkIntelligenceStore` 仍是單一 God Class |
| 15 | 「查 project → policyGate.check → 組 skipped 回應」樣板重複 | 仍有 **29 處**直接呼叫 `this.policyGate.check(...)` 各自手刻 skipped 回應，規模與原報告的「30+ 處」相當 |
| 16 | `SkippedResult` 欄位命名不一致（`projectRoot` vs `projectId`） | 未統一：`SkippedResult`/`KnowledgeSkippedResult`/`GraphSkippedResult` 用 `projectRoot`，`SkippedReportResult` 用 `projectId`（且此問題已衍生出下方新發現的資料語意錯誤） |
| 19 | `commitRequired` 殭屍欄位 | 三處（型別定義、`toSession()`、DB schema CHECK 約束）都還在，`finalizeSession` INSERT 仍寫入常數 `0` |
| 20 | `packages/core/src/modules.ts` 死代碼 | 檔案內容不變，全 repo 確認仍無任何實作或 import |
| 23 | ESLint / Prettier | 完全未加入，無 `.eslintrc*`/`eslint.config.*`/`.prettierrc*`，`package.json` 無 `lint` script |

---

## 四、本次新發現的問題

### 【Medium】`projectRoot` 欄位實際被塞入 `projectId` 的值，造成 API contract 語意錯誤

- **檔案**：`packages/storage/src/store.ts:1542`（`createMetadataBackfillRequest`）、`store.ts:1671`（`listMetadataBackfillRequests`）
- **問題**：
  ```ts
  if (input.projectId) {
    project = this.getProjectById(input.projectId);
    if (!project) {
      return {
        outcome: "skipped",
        projectRoot: input.projectId,   // 這裡塞的是 projectId（UUID），不是路徑
        projectStatus: "unregistered",
        reason: "Project is not registered."
      };
    }
  ```
  呼叫端傳入的是 `projectId`（UUID），但回應欄位名稱是 `projectRoot`——這不只是命名風格不一致，而是**回傳值內容與欄位語意矛盾**。任何依賴 `projectRoot` 欄位做路徑顯示、比對或重試邏輯的呼叫端（前端或 Agent），都可能把一個 UUID 誤當成檔案路徑處理，產生隱性 bug。
- **根因**：與未修正項目 16（`SkippedResult` 命名不一致）同源——因為型別系統沒有統一的 discriminated union，才會讓開發者在「用 ID 呼叫卻要湊 root 欄位」時隨手塞錯值。
- **建議修法**：優先修正這兩處，短期做法是把這兩處改成回傳正確對應的欄位（例如改用 `SkippedReportResult` 或新增一個支援 `projectId` 的變體），中期則與項目 16 一併處理，統一成 `scope: { type: "root" | "id", value: string }` 的 discriminated union，避免同類錯誤再次發生。

### 【Low，觀察】回收函式本身無交易包裹（自我修復性質，非急迫）

- **檔案**：`store.ts:2487-2514`（`recoverStaleReportSynthesisRequests`）、`store.ts:2516-2550`（`recoverStaleMetadataBackfillRequests`）
- **問題**：先 `SELECT` 撈出逾時請求，再逐筆 `UPDATE`，中間無 `BEGIN/COMMIT`。若進程在迴圈中途中斷，部分請求會被標記失敗、部分仍是 `processing`。
- **影響**：低——每筆 `UPDATE` 都有 `WHERE status='processing'` 防護，是冪等操作，下次啟動會重新掃描並自我修正，不會造成資料損毀。
- **建議**：可視情況一併包進 `runImmediateTransaction`，非急迫。

---

## 五、建議接續執行順序

1. **修正新發現的 `projectRoot`/`projectId` 欄位語意錯誤**（風險低、修法簡單，應立即處理）。
2. **收斂 `safeProjectPath` 阻塞問題**：先降低陣列上限（500→100-200），再考慮批次快取 realpath。
3. **`getGraph` 查詢去重**：合併「算總數」與「建圖」的資料來源，避免重複掃描。
4. **建立工具鏈安全網**：ESLint/Prettier + `@vitest/coverage-v8`，在後續大型重構（`store.ts`/`App.vue` 拆分）前先建好，降低重構風險。
5. **`store.ts` 拆分**與**樣板去重**（項目 14、15）：工作量最大，但是後續一切維護的前提工程，建議在工具鏈就位後進行。
6. **`App.vue` 拆分**（項目 4）與**集中 API client**（項目 5）：目前 AbortController 機制（項目 6，已修正良好）疊加在同一巨型檔案上，建議拆分時把 `beginRequest`/`finishRequest`/`isCurrentRequest` 這組邏輯一併搬進 `useApiRequest` composable，一次還清兩筆技術債。
7. **剪貼簿重複程式碼**（項目 13 剪貼簿部分）：小工作量，可隨手處理。
8. **死代碼清理**（`commitRequired`、`modules.ts`）與 **`handoff-importer` 單元測試補齊**：優先度最低，可排在最後。

---

*本文件由 Claude 於 2026-09-21 針對 Codex 依 [2026-09-21-code-review.md](./2026-09-21-code-review.md) 所做的修正進行獨立追蹤複檢，涵蓋後端/MCP 安全性、共用套件與資料層、前端三個角度。*
