# WorkLog.Ai 複檢報告（給 Codex 執行）

- 日期：2026-09-21
- 審查者：Claude（獨立複檢，先前已由 Codex 做過一次健康檢查與資安檢查）
- 範圍：`apps/server`、`apps/mcp`、`apps/web`、`packages/*`、build/tooling 設定
- 方法：三條並行審查（後端與 MCP 安全性／共用套件與資料層／前端 Vue 應用），逐檔完整閱讀後彙整
- 使用方式：以下每個項目都是可獨立執行的修正任務，包含檔案路徑、行號、問題、風險與具體修法，可依「優先順序」章節逐項派給 Codex 處理。修正後請重新跑 `pnpm test`、`pnpm typecheck`、`pnpm build`，涉及 API 行為變動的項目另外跑 `pnpm test:e2e`。

## 總體結論

安全基礎紮實：SQL 全面參數化、路徑存取一致透過 `ProjectPolicyGate`/`safeProjectPath` 做 default-deny、MCP 與 REST 共用同一套 policy 邏輯、前端未使用 `v-html`／未發現 XSS、敏感資訊未外洩。**沒有發現 Critical 等級漏洞**。

主要風險集中在三個面向：

1. **正確性／併發**：多行程（REST + MCP 同時跑）下的 idempotency 機制在 race condition 下會直接丟未捕捉例外，而非回傳文件宣稱的 `duplicate: true`；部分 schema migration 與多語句寫入缺乏交易保護。
2. **架構／可維護性**：後端 `store.ts`（4658 行）與前端 `App.vue`（3192 行）都是承擔過多職責的巨型檔案，長期會拖慢所有後續修改與測試。
3. **強化型防護**：TOCTOU、Content-Type 檢查、同步 I/O 阻塞事件迴圈、逾時回收機制不對稱等，均屬於「把既有防線再收緊」等級，非緊急漏洞。

---

## 優先順序總覽

| # | 項目 | 類別 | 嚴重度 |
|---|---|---|---|
| 1 | 跨行程 idempotency race + 未捕捉 UNIQUE 例外 | 正確性/併發 | High |
| 2 | `finalizeSession` 查重與交易分離 | 正確性/併發 | High |
| 3 | Schema migration 缺交易保護 | 正確性/資料安全 | High |
| 4 | `App.vue` 為單一 3192 行巨型元件 | 架構 | High |
| 5 | 前端無集中 API client | 架構 | High |
| 6 | 前端 API 請求無 AbortController，有 race condition | 正確性 | High |
| 7 | Metadata backfill 無逾時回收機制 | 正確性 | Medium |
| 8 | `updateSessionMetadata`/`updateSessionVerification` 缺交易 | 正確性 | Medium |
| 9 | `safeProjectPath` 同步 I/O 在大陣列輸入下阻塞事件迴圈 | 效能/可用性 | Medium |
| 10 | symlink 邊界檢查 TOCTOU 窗口 | 安全性 | Medium |
| 11 | `readJsonBody` 未檢查 Content-Type | 安全性 | Medium |
| 12 | `store.ts` 4658 行 God Class | 架構 | Medium |
| 13 | `getGraph` 逐專案重複查詢，O(N) 往返 | 效能 | Medium |
| 14 | Graph／大型列表無虛擬化 | 效能 | Medium |
| 15 | 樣板程式碼重複：policy check、skipped 回應 | 架構 | Medium |
| 16 | Skipped 結果欄位命名不一致（projectRoot/projectId） | 一致性 | Medium |
| 17 | 陣列上限夠但無整體 payload 大小上限（MCP 側尤其） | 安全性/DoS | Medium |
| 18 | 缺 ESLint/Prettier、缺測試覆蓋率工具 | 工具鏈 | Medium |
| 19 | `commitRequired` 殭屍欄位 | 清理 | Low |
| 20 | `packages/core/src/modules.ts` 未被使用的死代碼 | 清理 | Low |
| 21 | 其餘 Low 項目（health check 假狀態、`*` origin 靜默過濾、ReDoS 面、剪貼簿重複程式碼等） | 各類 | Low |

---

## 一、正確性／併發（High）

### 1. 跨行程 idempotency race：撞到 UNIQUE 約束會丟未捕捉例外，而非回傳 `duplicate: true`

- **檔案**：`packages/storage/src/store.ts`
  - `recordKnowledge`（約 3632-3714 行）：3652-3659 行 `SELECT` 查重，3681-3704 行 `INSERT`，兩步之間沒有交易。
  - `createMetadataBackfillRequest`（1514-1639 行）、`createReportSynthesisRequest`（2489-2581 行）：相同的 check-then-act 模式。
  - `finalizeSession`（4300-4440 行）：4311 行 `getSessionByIdempotencyKey` 查重在 4353-4425 行的 `BEGIN/COMMIT` 交易**之外**。
- **問題**：`apps/server`（HTTP）與 `apps/mcp`（stdio）是兩個各自持有獨立 `WorkIntelligenceStore`／`DatabaseSync` 連線、但共用同一個 sqlite 檔案的行程（見 `apps/mcp/src/index.ts:38-40`）。若使用者同時經網頁與 Agent 對同一個 `idempotencyKey` 發請求，兩邊的 SELECT 都可能看到「尚未存在」而各自嘗試 `INSERT`，其中一個會撞上 `sessions.idempotency_key`／`knowledge(project_id, idempotency_key)`／`report_synthesis_requests.idempotency_key`／`metadata_backfill_requests.idempotency_key` 的 UNIQUE 約束擲出 `SQLITE_CONSTRAINT` 例外。呼叫端沒有捕捉，最終在 `apps/server/src/server.ts:610-618` 變成 500 錯誤，MCP 端則直接讓工具呼叫失敗——與系統反覆宣稱「idempotencyKey 保證重試安全」矛盾（該保證只在單行程序列呼叫下成立）。
- **修法**：
  1. 把「查重 + 寫入」包進單一 `BEGIN IMMEDIATE ... COMMIT` 交易。
  2. 在 `INSERT` 失敗分支捕捉 `SqliteError`（判斷 `error.code === 'SQLITE_CONSTRAINT_UNIQUE'` 或訊息內容），重新查一次既有列後回傳 `duplicate: true`。
  3. 抽出共用 helper（例如 `insertOrGetByIdempotencyKey`）供 `recordKnowledge`、`createMetadataBackfillRequest`、`createReportSynthesisRequest`、`finalizeSession` 共用，避免各處各寫一份、行為不一致。

### 2. `finalizeSession` 查重與寫入交易分離（同上第 1 項延伸，獨立條列因影響面最大）

- **檔案**：`packages/storage/src/store.ts:4300-4440`
- **修法**：與第 1 項相同做法，優先處理，因為 `work_finalize_session` 是整個系統最核心、被 README 反覆強調「重試安全」的入口。

### 3. Schema migration 缺交易保護，中斷會導致資料庫損毀狀態

- **檔案**：`packages/storage/src/store.ts:1322-1379`
- **問題**：`ensureSchemaMigrations` 用 `PRAGMA table_info` 檢查欄位存在與否，不存在才 `ALTER TABLE ADD COLUMN`（1325-1345 行，這部分對單語句 ADD COLUMN 是安全的）。但 1350-1378 行針對 `metadata_backfill_requests` 加入 `'cancelled'` 狀態值時，用 `RENAME TO ... CREATE TABLE ... INSERT ... DROP TABLE` 重建整張表，**沒有包在 `BEGIN/COMMIT` 交易內**。若進程在 `RENAME` 之後、`CREATE TABLE` 之前中斷（斷電、被強制終止），資料庫會卡在「表被改名為 `_legacy`、新表尚未建立」的損毀狀態，且無交易可回滾。
- **修法**：
  1. 導入 `PRAGMA user_version` 做版本控制，把每個 migration 寫成 `{version, up: (db) => void}` 陣列，啟動時依序套用未套用版本，每個步驟各自包在自己的交易中。
  2. 對重建表這類高風險操作，至少包 `BEGIN/COMMIT`；且保留 `_legacy` 表到下次啟動確認新表正常後才清除，不要立刻 `DROP`。

---

## 二、前端架構（High）

### 4. 整個 Dashboard 是單一 3,192 行的 `App.vue`

- **檔案**：`apps/web/src/App.vue`（全檔，`<script setup>` 約 1-1938 行、`<template>` 約 1939-3192 行）
- **問題**：Dashboard、Projects、Reports、Knowledge、Graph、Worklog 六個視圖，以及 Session Detail、Knowledge Editor、Knowledge History、Graph Node、Handoff Import 五個 modal，全部寫在同一個 SFC。模板部分幾乎沒有換行（例如 3073-3086 行整段 Session Detail 寫在單行）。沒有 `components/`、`views/`、`composables/`、`router/` 目錄，沒有 Vue Router、Pinia。
- **影響**：任何小改動都要在 3000+ 行檔案定位；多人/多次修改幾乎必然在同一檔案衝突；IDE 型別推導與熱更新變慢；Codex 逐項修正時，改 A 視圖誤動到 B 視圖的風險大增。
- **修法**：
  1. 導入 Vue Router（或至少用動態元件）取代目前用 `activeView` ref 手動切換 6 個 `v-else` 區塊（2811 行附近的鏈式 `v-if/v-else`）。
  2. 依視圖拆成 `views/DashboardView.vue`、`ReportsView.vue`、`KnowledgeView.vue`、`GraphView.vue`、`WorklogView.vue`、`ProjectsView.vue`。
  3. 5 個 modal（`selectedDetail` 2945 行、`knowledgeEditor` 2993 行、`knowledgeHistoryItem` 3057 行、`selectedGraphNode` 3094 行、`handoffImportPreview` 3136 行）各自抽成獨立元件，並抽出共用 `BaseModal.vue`（統一 `role="dialog"`、`aria-modal`、`@keydown.esc`、`@click.self`，目前在 5 處重複）。
  4. 各視圖資料流改用 composable 封裝（見第 5 項）。

### 5. 前端沒有集中的 API client，每個 view 各自組裝 URL 與參數

- **檔案**：`apps/web/src/App.vue:332-345`（`request<T>`）以及 20+ 個 `loadXxx` 函式（`loadKnowledge` 364-406、`loadGraph` 422-449、`loadSessions` 462-495、`loadReportSynthesis` 520-563、`loadReportSessions` 698-729、`loadReportEvidence` 744-788、`loadReport` 790-830 等）
- **問題**：唯一集中的部分是 `request<T>()`（fetch 包裝）。每個 `loadXxx` 都手刻 `URLSearchParams`、各自處理 `outcome === "xxx"` 的 discriminated union、各自維護 loading/error ref，路徑字串靠手動拼接（例如 1420 行、1165 行），無編譯期檢查。
- **修法**：抽出 `apps/web/src/api/client.ts`，把每個資源端點包成型別化函式（如 `fetchKnowledge(params): Promise<KnowledgeSearchResult>`），並抽出共用 composable `useApiRequest()` 統一處理 `loading`/`error`/`data` 三態，把現行 15-20 行的樣板降到 3-5 行。

### 6. `request()` 無 AbortController，快速操作會有 stale-response race condition

- **檔案**：`apps/web/src/App.vue:332-345`（`request<T>`），呼叫點含 `changeView`（1043-1060）、`loadKnowledge`、`loadSessions`、`loadGraph`、各分頁切換函式（`changeKnowledgePage` 408-414、`changeSessionPage` 506-512、`changeReportEvidencePage` 832-838）
- **問題**：`request<T>()` 純 `fetch()` 包裝，無取消機制。使用者快速切頁/切篩選/切視圖時，舊回應可能晚於新請求到達，導致畫面顯示與目前選擇不符的資料，且無任何提示。
- **修法**：在共用 `request()`／`useApiRequest` 中加入 `AbortController`，同一資源的新請求發出前先 `abort()` 上一個未完成請求，`catch` 中忽略 `AbortError`；或用遞增請求 token 比對，回應寫回前檢查 token 是否仍是最新。

---

## 三、正確性（Medium）

### 7. Metadata backfill request 沒有逾時自動恢復機制，Report synthesis request 有

- **檔案**：`packages/storage/src/store.ts`
  - Report synthesis：`REPORT_SYNTHESIS_PROCESSING_TIMEOUT_MS`（132 行）+ `recoverStaleReportSynthesisRequests()`（2460-2487 行），在多個方法前呼叫。
  - Metadata backfill（1514-1926 行）：`getMetadataBackfillContext`（1767-1836 行）會把 `pending` 轉 `processing`，但**沒有任何逾時判定**，Agent 中途崩潰會讓請求永久卡在 `processing`，需人工手動取消。
- **修法**：比照 report synthesis 模式，為 `metadata_backfill_requests` 加上 `PROCESSING_TIMEOUT_MS` 與 `recoverStaleMetadataBackfillRequests()`，在對應 public 方法前呼叫。

### 8. `updateSessionMetadata` / `updateSessionVerification` 多語句寫入缺交易

- **檔案**：`packages/storage/src/store.ts`
  - `updateSessionVerification`（3364-3397 行）：3383-3389 行與 3390 行兩條 `UPDATE` 無交易包裹。
  - `updateSessionMetadata`（3399-3466 行）：3439-3458 行與 3459 行同樣無交易。
- **對照**：`updateSessionSummary`（3468-3583 行）與 `finalizeSession`（4300-4440 行）都正確用 `BEGIN/COMMIT` 包住多語句寫入，這兩個方法明顯遺漏。
- **修法**：比照 `updateSessionSummary` 寫法補上 `BEGIN/COMMIT/ROLLBACK`，避免進程中斷造成 `sessions` 與 `projects.updated_at` 不一致。

---

## 四、安全性強化（Medium/Low）

### 9. `safeProjectPath` 同步阻塞 I/O，大陣列輸入下會卡住事件迴圈

- **檔案**：`packages/project-policy/src/index.ts:54-93`（`safeProjectPath`），呼叫端 `packages/storage/src/store.ts` 的 `normalizeChangedFilePath`（527-543）、`normalizeChangedFileChanges`（545-573）、`normalizeChangedFiles`（600-656）、`mergeChangedFiles`（658-724）
- **問題**：`safeProjectPath` 用 `existsSync` 迴圈往上層爬 + `realpathSync`，全同步阻塞。`changedFiles`／`changedFileChanges`／`changedFilesProvenance` 各自上限 500 筆（`packages/schema/src/index.ts:86, 212`），單次 `updateSessionMetadata` 可能疊加上千次同步 fs 呼叫。`apps/server` 是 Node 內建單執行緒 `http` server，這會完全阻塞事件迴圈，卡住其他並發連線（含其他 Agent 的 MCP 請求）。
- **修法**：
  1. 短期：收緊 `changedFiles`／`changedFileChanges`／`changedFilesProvenance` 上限（例如 500 → 100）。
  2. 中期：批次處理路徑正規化（先快取一次 `realpathSync(projectRoot)`，只在必要時做存在性檢查），或把大量檔案系統操作丟到 `worker_threads`/分批 `setImmediate` 讓出事件迴圈。

### 10. symlink 邊界檢查存在 TOCTOU 窗口

- **檔案**：`packages/project-policy/src/index.ts:71-90`
- **問題**：`safeProjectPath` 在 `realpathSync` 檢查完後，回傳的是**未經 realpath 處理**的 `candidate` 路徑給呼叫端做實際讀檔。檢查與實際讀檔之間的窗口內，若路徑被替換為指向外部的 symlink，可繞過邊界檢查。
- **修法**：回傳 `realpathSync` 解析後的實際路徑而非 lexical `candidate`；或在 `store.ts` 呼叫後、`readFileSync` 前再做一次 `realpathSync` + `isPathWithinProject` 二次確認。

### 11. `readJsonBody` 未檢查 Content-Type

- **檔案**：`apps/server/src/server.ts:65-87`
- **問題**：不論 `Content-Type` 為何，只要 body 能被 `JSON.parse` 就接受，削弱了 CORS「simple request 需走 preflight」這層縱深防禦。
- **修法**：檢查 `request.headers["content-type"]` 是否以 `application/json` 開頭，不符合直接回 415。

### 12. 陣列各自有上限但無整體 payload 大小限制，MCP 側完全無請求大小防護

- **檔案**：`packages/schema/src/index.ts`（`finalizeSessionInputSchema` 77-92 行、`updateSessionMetadataInputSchema` 210-218 行）
- **問題**：`apps/server` 有 1.5MB HTTP body 上限（`server.ts:72`），但 `apps/mcp/src/index.ts` 走 stdio 協定，**沒有等價限制**，只靠 zod 個別欄位上限把關，理論上仍可讓資料塞入數 MB 進 SQLite（TEXT 欄位無長度限制）。
- **修法**：在共用 zod schema 加 `superRefine` 估算序列化後總大小（或加總字串欄位長度），設合理上限（如 2MB），MCP 與 HTTP 兩條路徑一致生效。

### 13. 其他 Low 級強化項目（可批次處理）

- **`apps/server/src/server.ts:118-125`**：`/api/health` 的 `database: "connected"` 是硬編碼常數，非實際檢查結果。修法：跑一次輕量查詢（如 `SELECT 1`）依實際結果回傳。
- **`apps/server/src/server.ts:40-45`**：`WORK_INTELLIGENCE_ALLOWED_ORIGINS=*` 會被靜默過濾成空集合（fail-safe 但不透明）。修法：偵測到 `*` 時 `console.error` 明確警告。
- **`packages/storage/src/store.ts:4508-4525`**：`readProjectSource` 是未被任何路由呼叫的 public 方法，且無檔案大小上限（其他讀檔邏輯都有 `.slice(0, 200_000)`）。修法：若無使用計畫直接移除；若保留則補上大小上限。
- **`packages/storage/src/handoff-importer.ts`**：`findStatusSignals`（77 行起）、`extractChangedFiles`（191 行起）對未受信任 Markdown 內容跑多個正則，存在低機率 ReDoS 面。修法：對正則處理加執行時間/迭代次數軟上限，或跑 `safe-regex` 類工具檢測。
- **`apps/web/src/App.vue:656-671` 與 `1181-1196`**：剪貼簿複製邏輯重複兩次，fallback 用已棄用的 `document.execCommand`。修法：抽成共用 composable `useClipboard()`，評估是否仍需 fallback。

---

## 五、架構／可維護性（Medium）

### 14. `store.ts` 是 4658 行的 God Class

- **檔案**：`packages/storage/src/store.ts`（整檔）
- **問題**：`WorkIntelligenceStore` 一個類別同時負責 schema/migration、Project CRUD、Session finalize/metadata/summary、Knowledge CRUD + audit trail、Report 建置/比較/匯出、Report synthesis 生命週期狀態機、Metadata backfill 生命週期狀態機、Handoff import、Graph 建置、Evidence attach。對應測試檔 `store.test.ts` 也高達 1677 行。
- **修法**：拆成多個 repository（`SessionRepository`、`KnowledgeRepository`、`ReportBuilder` + `ReportSynthesisRequestRepository`、`MetadataBackfillRepository`、`HandoffImportService`、`GraphBuilder`、`SchemaMigrator`），`WorkIntelligenceStore` 保留為 facade 委派給各模組，對外 API 不變。

### 15. 樣板程式碼大量重複：「查 project → policyGate.check → 組 skipped 回應」

- **檔案**：`packages/storage/src/store.ts` 全檔 30+ 處（例如 1461-1476、1514-1535、1641-1661、1698-1722、1767-1791、2098-2127、2489-2511、2583-2604、2646-2670、2691-2716、2784-2809、2854-2879、3140-3159、3198-3222、3364-3379、3399-3414、3468-3490、3632-3641、3716-3725、3800-3809、3935-3993、4239-4261、4300-4309、4442-4452）
- **修法**：抽出私有 helper（如 `requireTrackedProjectByRoot`、`requireTrackedProjectById`），回傳 union 結果供各處 early return，消除數百行重複程式碼，同時降低「某處漏加 policy check」的風險。

### 16. Skipped 結果欄位命名不一致（`projectRoot` vs `projectId`）

- **檔案**：`packages/core/src/index.ts`（`SkippedResult` 792-797 行用 `projectRoot`；`SkippedReportResult` 474-479 行用 `projectId`）
- **問題**：同一種「專案未追蹤」情境，不同 API 回傳不同欄位名稱，前端/Agent 需同時判斷兩種欄位。
- **修法**：統一成單一 discriminated union（例如 `scope: { type: "root" | "id", value }`），逐步收斂成一種 shape。

### 17. `getGraph` 逐專案重複查詢，往返次數隨專案數線性增加

- **檔案**：`packages/storage/src/store.ts:3935-4237`
- **問題**：對每個 tracked project 各自呼叫 `listSessions`、`searchKnowledge`（內部至少 2 次 SQL）、evidence 查詢；函式開頭又用三條獨立 COUNT 查詢先算總數（4000-4038 行），等於同樣資料撈兩遍。
- **修法**：合併「算總數」與「建圖」為一次查詢的兩種用途；多專案情境改用 `WHERE project_id IN (...)` 一次撈取後在記憶體中分組，取代逐專案迴圈查詢。

### 18. Graph／大型列表無虛擬化

- **檔案**：`apps/web/src/App.vue:1679-1734`（`graphVisual` computed）、2737-2765（`v-for` 渲染節點/邊）；`listPageSizeOptions`（56-63 行）含「All」選項，`pageSizeToQuery`（355-357 行）轉成不分頁請求
- **問題**：Graph 支援載入到 500 節點/1000 邊，全量 SVG 渲染無虛擬化；Sessions/Knowledge 等清單選「All」時整批渲染無虛擬捲動，資料量成長會卡頓。
- **修法**：Graph 長期可考慮改用 canvas-based 圖形庫；列表可對「All」設硬上限或導入虛擬捲動元件（如 `vue-virtual-scroller`）。

### 19. `apps/server/src/server.ts` 為 500+ 行的 if 鏈式路由

- **檔案**：`apps/server/src/server.ts:100-609`
- **問題**：30+ 條路由全用 `if (method && pathname)` 逐一比對，容易在新增路由時漏加 CORS/驗證邏輯。
- **修法**：抽成路由表（`Array<{method, pattern, handler}>`）或引入輕量路由函式。

---

## 六、清理項目（Low）

### 20. `commitRequired` 是永遠為 `false` 的殭屍欄位

- **檔案**：`packages/core/src/index.ts:77`（型別寫死 `false`）、`packages/storage/src/store.ts:751`（`toSession()` 永遠回傳 `false`）、`packages/storage/src/store.ts:339`（DB schema `CHECK (commit_required = 0)`）
- **修法**：確認前端無依賴後，整組移除（型別欄位、DB 欄位待下次 migration 版本化清理、`toSession` 對應程式碼）。

### 21. `packages/core/src/modules.ts` 是未被使用的死代碼

- **檔案**：`packages/core/src/modules.ts`（全檔 43 行）
- **問題**：全 repo 搜尋 `ExtensionModules|ReportModule|EvidenceModule|KnowledgeModule|GraphModule` 只在此檔案定義，無任何實作或 import。`WorkIntelligenceStore` 完全繞過這組介面，直接把功能寫成自己的 public method。
- **修法**：若無「core 定義介面、storage 實作」的計畫，直接刪除 `modules.ts` 及 `packages/core/src/index.ts:1158` 的 re-export；若有計畫，讓 `WorkIntelligenceStore implements ReportModule, EvidenceModule, ...`。

### 22. `handoff-importer.ts` 分類規則無單元測試覆蓋

- **檔案**：`packages/storage/src/handoff-importer.ts:97-120`（`classifyHandoff`）、138-152（`parseVerification`）、191-227（`extractChangedFiles`）
- **問題**：用大量中英文關鍵字正則判斷 handoff 狀態，本質脆弱（措辭變化易誤判），且找不到對應的 `handoff-importer.test.ts`。
- **修法**：補上獨立單元測試，覆蓋中英文混合、多層 heading、程式碼區塊內誤判等邊界情況。

---

## 七、工具鏈（Medium）

### 23. 完全沒有 ESLint / Prettier

- **檔案**：monorepo 根目錄與各 package 下均無 `.eslintrc*`、`eslint.config.*`、`.prettierrc*`
- **現況**：`tsconfig.base.json` 有開 `strict: true`、`noUncheckedIndexedAccess: true`（良好），但無 lint 意味著沒有工具檢查未使用的 import/變數、no-floating-promises 等潛在 bug 來源，程式碼風格也不一致（例如 `store.ts` 1106-1242 行 `reportExportMarkdown` 用 `+` 字串拼接，與其他檔案的樣板字串風格不一致）。
- **修法**：加入 `@typescript-eslint` + `eslint-plugin-import` 基本設定，`package.json` 加 `lint` script 並串進 `pnpm test`/CI。

### 24. 沒有測試覆蓋率工具，`packages/schema`/`core`/`shared` 無任何測試

- **檔案**：`package.json`（根目錄）、各 package 下無 `vitest.config.ts`
- **問題**：`test` script 只是 `vitest run src`，無 `--coverage`。`packages/schema` 承擔所有輸入邊界驗證（DoS 第一道防線），卻完全沒有測試驗證 `max(500)`、`max(1_000)` 等邊界值實際生效。
- **修法**：為 `packages/schema` 補上邊界值測試（超過上限應被拒絕）；加入 `@vitest/coverage-v8` 並在 CI 設最低覆蓋率門檻，優先覆蓋 `storage` 與 `schema`。

---

## 建議執行順序（給 Codex）

1. **第 1、2、3 項**（idempotency race + migration 交易）— 正確性缺陷，直接關係到系統核心承諾是否成立，優先處理。
2. **第 7、8 項**（metadata backfill 逾時回收、缺交易的多語句寫入）— 收斂正確性風險。
3. **第 9、10、11、12 項**（safeProjectPath 阻塞、TOCTOU、Content-Type、payload 上限）— 安全性強化，風險與工作量都不高，適合一次性處理。
4. **第 23、24 項**（lint、測試覆蓋率工具鏈）— 儘早建立，讓後續重構有安全網。
5. **第 4、5、6 項**（前端拆分 `App.vue`、API client、AbortController）— 工作量較大但是所有後續前端修正的前提工程。
6. **第 14、15、16、17、19 項**（後端 `store.ts` 拆分、樣板去重、命名一致化、Graph 查詢優化、路由表化）— 中長期重構。
7. **第 13、18、22 項**（其餘 Low 強化與測試補齊）。
8. **第 20、21 項**（死代碼清理）— 可隨手處理，風險最低。

---

*本文件由 Claude 針對 WorkLog.Ai 專案於 2026-09-21 進行的獨立複檢彙整而成，涵蓋後端/MCP 安全性、共用套件與資料層、前端三個角度的完整程式碼審查。*
