# WorkLog.Ai 待處理事項清單（給 Codex 執行）

- 日期：2026-09-21
- 來源：彙整自 [2026-09-21-code-review.md](./2026-09-21-code-review.md)（原始複檢）與 [2026-09-21-followup-review.md](./2026-09-21-followup-review.md)（Codex 修正後追蹤複檢）
- 範圍：只列「未修正」「部分修正」與「新發現」的項目，已確認修正完成的項目不再重複列出
- 使用方式：依「建議執行順序」章節逐項處理，每項都附檔案路徑、行號、現況與具體修法。修正後跑 `pnpm test`、`pnpm typecheck`、`pnpm build`；涉及 API 或前端行為變動的項目另外跑 `pnpm test:e2e`。

## 待處理事項總覽

| # | 項目 | 類別 | 狀態 | 優先度 |
|---|---|---|---|---|
| A | `projectRoot` 欄位誤塞 `projectId` 值 | 正確性（新發現） | 未修正 | 高（修法簡單，應優先處理） |
| B | `safeProjectPath` 同步 I/O 阻塞事件迴圈 | 效能/可用性 | 部分修正 | 高 |
| C | `getGraph` 查詢重複掃描、逐專案 N+1 | 效能 | 部分修正 | 中高 |
| D | 缺 ESLint/Prettier | 工具鏈 | 未修正 | 中高（建議在大型重構前先做） |
| E | 缺測試覆蓋率工具 | 工具鏈 | 未修正 | 中 |
| F | `store.ts` 拆分成多個 repository/module | 架構 | 未修正 | 中高（工作量大） |
| G | 「查 project → policyGate.check → skipped」樣板重複（29 處） | 架構 | 未修正 | 中 |
| H | `SkippedResult` 欄位命名不一致（`projectRoot`/`projectId`） | 一致性 | 未修正 | 中（與 A、G 一併處理） |
| I | `App.vue` 拆分成 views/components | 前端架構 | 未修正 | 中高（工作量大） |
| J | 前端無集中 API client / `useApiRequest` composable | 前端架構 | 未修正 | 中高 |
| K | 剪貼簿複製邏輯重複兩份 | 前端 | 未修正 | 低（小工作量，可隨手做） |
| L | Sessions/Knowledge「All」選項無虛擬化 | 前端效能 | 未修正 | 低中 |
| M | `handoff-importer.ts` 無 ReDoS 防護 | 安全性 | 未修正 | 低 |
| N | `handoff-importer.ts` 缺單元測試 | 測試 | 部分修正 | 低中 |
| O | `commitRequired` 殭屍欄位 | 清理 | 未修正 | 低 |
| P | `packages/core/src/modules.ts` 死代碼 | 清理 | 未修正 | 低 |
| Q | 逾時回收函式無交易包裹 | 正確性（觀察） | 未修正 | 低（自我修復性質，非急迫） |

---

## 高優先

### A. `projectRoot` 欄位誤塞 `projectId` 值（新發現，API 語意錯誤）

- **檔案**：`packages/storage/src/store.ts:1542`（`createMetadataBackfillRequest`）、`store.ts:1671`（`listMetadataBackfillRequests`）
- **問題**：呼叫端傳入的是 `projectId`（UUID），但 skipped 回應把它塞進名為 `projectRoot` 的欄位：
  ```ts
  if (input.projectId) {
    project = this.getProjectById(input.projectId);
    if (!project) {
      return {
        outcome: "skipped",
        projectRoot: input.projectId,   // 應該是路徑，卻塞了 UUID
        projectStatus: "unregistered",
        reason: "Project is not registered."
      };
    }
  ```
  任何依賴 `projectRoot` 欄位做路徑顯示、比對或重試邏輯的呼叫端，會把 UUID 誤當成檔案路徑處理。
- **修法**：短期直接改成回傳正確對應的欄位（例如改用已存在的 `SkippedReportResult`／或新增支援 `projectId` 的 skipped 變體，欄位命名為 `projectId` 而非 `projectRoot`）。中期與項目 H 一併處理。

### B. `safeProjectPath` 同步 I/O 阻塞事件迴圈

- **檔案**：`packages/project-policy/src/index.ts:54-93`
- **現況**：仍是 `existsSync` 迴圈往上層爬 + `realpathSync`，全同步阻塞，未批次化、未搬到 worker。`changedFiles`/`changedFileChanges`/`changedFilesProvenance` 上限仍是 500（`packages/schema/src/index.ts:86-88, 212-215`）。
- **影響**：`finalizeSession`/`updateSessionMetadata` 一次仍可能觸發數百次同步系統呼叫，`apps/server` 是單執行緒 `http` server，會完全阻塞事件迴圈，卡住其他並發連線（含其他 Agent 的 MCP 請求）。
- **修法**：
  1. 短期：把 `packages/schema/src/index.ts:86-88, 212-215` 的陣列上限從 500 降到 100-200。
  2. 中期：在 `normalizeChangedFiles`/`mergeChangedFiles`（`packages/storage/src/store.ts:600-724`）呼叫端快取一次 `realpathSync(projectRoot)`，避免每個路徑都重新解析專案根目錄；或把批次路徑檢查搬到 `worker_threads`/分批 `setImmediate` 讓出事件迴圈。

### D. 缺 ESLint / Prettier

- **檔案**：monorepo 根目錄與各 package 下均無 `.eslintrc*`、`eslint.config.*`、`.prettierrc*`；根目錄 `package.json` 無 `lint` script
- **問題**：`tsconfig.base.json` 雖有 `strict: true`，但沒有 lint 規則，無法自動抓未使用的 import/變數、no-floating-promises 等潛在 bug 來源，程式碼風格也不一致。
- **修法**：加入 `@typescript-eslint` + `eslint-plugin-import` 基本設定，`package.json` 加 `lint` script 並串進 `pnpm test`/CI。**建議在 F、G、I、J 等大型重構之前先做好**，作為重構期間的安全網。

---

## 中高優先

### C. `getGraph` 查詢重複掃描、逐專案 N+1

- **檔案**：`packages/storage/src/store.ts:4010-4260`
- **現況**：「算總數」已改成批次查詢（`store.ts:4074-4113`，3 條 `WHERE project_id IN (...)`），但「建圖」迴圈仍在 `for (const project of projects)` 內逐一呼叫 `this.listSessions`（4174 行）與 `this.searchKnowledge`（4221 行），往返次數仍隨專案數線性增加；且「算總數」與「建圖」實質上重複掃描了同一批資料。
- **修法**：把 sessions/knowledge/evidence 改成一次性用 `WHERE project_id IN (...)` 撈全部後在記憶體中依 project 分組，同一份資料同時供「算總數」與「建圖」使用，取代目前兩階段各自查詢的模式。

### F. `store.ts` 拆分成多個 repository/module

- **檔案**：`packages/storage/src/store.ts`（全檔，目前 4728 行，比上次複檢時的 4658 行更長）
- **問題**：`WorkIntelligenceStore` 單一 class 同時負責 schema/migration、Project CRUD、Session finalize/metadata/summary、Knowledge CRUD、Report 建置/synthesis 狀態機、Metadata backfill 狀態機、Handoff import、Graph 建置、Evidence attach，對應測試檔 `store.test.ts` 也高達 1738 行。
- **修法**：拆成多個 repository（`SessionRepository`、`KnowledgeRepository`、`ReportBuilder` + `ReportSynthesisRequestRepository`、`MetadataBackfillRepository`、`HandoffImportService`、`GraphBuilder`、`SchemaMigrator`），`WorkIntelligenceStore` 保留為 facade 委派給各模組，對外 API 不變。**建議先完成 D（lint）再動手，降低拆分風險**。

### I. `App.vue` 拆分成 views/components

- **檔案**：`apps/web/src/App.vue`（全檔，目前 3330 行，比上次複檢時的 3192 行更長）
- **問題**：Dashboard、Projects、Reports、Knowledge、Graph、Worklog 六個視圖與 5 個 modal（Session Detail、Knowledge Editor、Knowledge History、Graph Node、Handoff Import）全部寫在同一個 SFC，且用 `v-if="activeView === 'dashboard'" / v-else-if ...` 鏈式切換視圖（`App.vue:2145, 2224, 2348, 2722, 2800`），沒有 Vue Router。
- **修法**：
  1. 導入 Vue Router 取代鏈式 `v-if/v-else`。
  2. 依視圖拆成 `views/DashboardView.vue`、`ReportsView.vue`、`KnowledgeView.vue`、`GraphView.vue`、`WorklogView.vue`、`ProjectsView.vue`。
  3. 5 個 modal 各自抽成獨立元件，抽出共用 `BaseModal.vue`。
  4. **拆分時務必把現有的 AbortController 機制（`beginRequest`/`isCurrentRequest`/`finishRequest`/`isAbortError`，`App.vue:331-352`）與 `request<T>()` 一起搬進 `useApiRequest` composable**（呼應項目 J），這組機制目前運作良好，不要在拆分過程中遺漏或破壞。

### J. 前端無集中 API client / `useApiRequest` composable

- **檔案**：`apps/web/src/App.vue`（`request<T>()` 現在在 354-367 行），約 97 個頂層函式各自組 `URLSearchParams`、各自宣告 loading/error ref
- **修法**：抽出 `apps/web/src/api/client.ts`，把每個資源端點包成型別化函式；抽出共用 composable `useApiRequest()` 統一處理 `loading`/`error`/`data` 三態與 AbortController 邏輯（見項目 I 的第 4 點），應與 I 一併規劃、一次還清。

---

## 中優先

### G. 「查 project → policyGate.check → skipped」樣板重複

- **檔案**：`packages/storage/src/store.ts` 全檔 **29 處**直接呼叫 `this.policyGate.check(...)`（分布在 1488、1547、1676、1738、1808、1956、2565、2661、2727、2773、2866、2936、3065、3216、3279、3437、3475、3554、3705、3792、3875、3922、3945、4015、4057、4328、4379、4514、4541、4579 行），每處各自手刻 `if (!decision.allowed || !decision.project) { return { outcome: "skipped", ... } }`
- **修法**：抽出私有 helper（如 `requireTrackedProjectByRoot`、`requireTrackedProjectById`），回傳 union 結果供各處 early return，消除重複程式碼，同時降低「某處漏加 policy check」的風險。建議與 F（`store.ts` 拆分）一併規劃，拆分後的各 repository 共用同一組 helper。

### H. `SkippedResult` 欄位命名不一致

- **檔案**：`packages/core/src/index.ts`
  - `SkippedResult`（792-797 行）、`KnowledgeSkippedResult`（226-231 行）、`GraphSkippedResult`（353-358 行）用 `projectRoot: string`
  - `SkippedReportResult`（474-479 行）用 `projectId?: string`
- **問題**：同一種「專案未追蹤」情境，不同 API 回傳不同欄位名稱，已直接導致項目 A 的資料塞錯值問題。
- **修法**：統一成單一 discriminated union（例如 `scope: { type: "root" | "id", value: string }`），逐步收斂所有 skipped 回應型別，並回頭確認項目 A 的兩處呼叫點改用正確型別。

---

## 中低優先

### L. Sessions/Knowledge「All」選項無虛擬化

- **檔案**：`apps/web/src/App.vue:56-62`（`listPageSizeOptions` 含 `{ value: "all", label: "All" }`），`pageSizeToQuery("all")` 回傳 `0`（397-399 行附近）向後端請求不分頁的全量資料
- **現況**：Graph 已有配額截斷機制緩解（`graphVisualQuotas`，`App.vue:1798-1820`），但列表的「All」選項完全沒有處理，`package.json` 未安裝任何虛擬捲動套件。
- **修法**：對「All」選項設硬上限（例如伺服器端限制最多回傳 500 筆），或導入虛擬捲動元件（如 `vue-virtual-scroller`）。

### N. `handoff-importer.ts` 缺單元測試

- **檔案**：`packages/storage/src/handoff-importer.ts`（`classifyHandoff`、`parseVerification`、`extractChangedFiles` 均為模組私有函式）
- **現況**：只有 `store.test.ts:936-992` 透過公開 API `previewHandoffImport` 做整合層級驗證，涵蓋 `blocked`/`pending`/`planning_only`/`excluded_by_user`，但函式本身無單元測試，中英文混合、多層 heading、程式碼區塊內誤判等邊界情境未覆蓋。
- **修法**：export 這三個函式（或建立測試專用 barrel），補上 `handoff-importer.test.ts` 針對邊界情境的測試。

---

## 低優先

### E. 缺測試覆蓋率工具

- **檔案**：根目錄 `package.json`（`test` script 仍是純 `vitest run src`，無 `--coverage`）
- **現況**：`packages/schema/src/index.test.ts` 已補上邊界值測試（驗證超過上限應被拒絕），但整體覆蓋率工具仍缺。
- **修法**：加入 `@vitest/coverage-v8`，在 CI 設定 `storage`/`schema` 的最低覆蓋率門檻。

### K. 剪貼簿複製邏輯重複兩份

- **檔案**：`App.vue:734-749`（`copyReportSynthesisInstruction`）與 `App.vue:1297-1312`（`copyMetadataBackfillInstruction`）
- **問題**：兩份函式邏輯逐字重複，均用已棄用的 `document.execCommand("copy")` 作為 fallback。
- **修法**：抽成共用 composable `useClipboard()`，評估是否仍需 `execCommand` fallback。

### M. `handoff-importer.ts` 無 ReDoS 防護

- **檔案**：`packages/storage/src/handoff-importer.ts`（`findStatusSignals` 77-96 行、`extractChangedFiles` 192-228 行、`parseVerification` 139-153 行）
- **現況**：正則多用 lazy quantifier，輸入已有 `.slice(0, 200_000)` 上限，實務風險偏低，但未加執行時間/迭代次數軟上限。
- **修法**：加執行時間/迭代次數軟上限，或引入 `safe-regex` 類工具做靜態檢測。

### O. `commitRequired` 殭屍欄位

- **檔案**：`packages/core/src/index.ts:77`（型別寫死 `false`）、`packages/storage/src/store.ts:753`（`toSession()` 永遠回傳 `false`）、`store.ts:341`（DB schema `CHECK (commit_required = 0)`）、`store.ts:4436-4440`（`finalizeSession` INSERT 仍寫入常數 `0`）
- **修法**：確認前端無依賴後整組移除（型別欄位、DB 欄位待下次 migration 版本化清理、相關程式碼）。

### P. `packages/core/src/modules.ts` 死代碼

- **檔案**：`packages/core/src/modules.ts`（全檔 42 行，定義 `ReportModule`/`EvidenceModule`/`KnowledgeModule`/`GraphModule`/`ExtensionModules`）
- **現況**：全 repo 確認除自身定義外無任何實作或 import。
- **修法**：若無「core 定義介面、storage 實作」計畫，直接刪除此檔與對應 re-export；若有計畫，讓 `WorkIntelligenceStore implements` 這些介面。

### Q. 逾時回收函式無交易包裹（觀察，非急迫）

- **檔案**：`packages/storage/src/store.ts:2487-2514`（`recoverStaleReportSynthesisRequests`）、`store.ts:2516-2550`（`recoverStaleMetadataBackfillRequests`）
- **現況**：先 `SELECT` 撈出逾時請求，再逐筆 `UPDATE`，中間無交易；每筆 `UPDATE` 都有 `WHERE status='processing'` 防護、是冪等操作，中斷後下次啟動會自我修正。
- **修法**：可視情況一併包進 `runImmediateTransaction`，非急迫。

---

## 建議執行順序

1. **A** — 修欄位語意錯誤，風險低、修法簡單，立即處理。
2. **B** — 收緊路徑檢查上限與同步 I/O，涉及可用性風險。
3. **D** — 建立 ESLint/Prettier，作為後續大型重構的安全網。
4. **C** — `getGraph` 查詢去重。
5. **F、G** — `store.ts` 拆分 + policy check 樣板去重（一併規劃，工作量最大）。
6. **H** — 統一 `SkippedResult` 命名，回頭驗證 A 的修正是否已納入正確型別。
7. **I、J** — `App.vue` 拆分 + 集中 API client（一併規劃，記得把現有 AbortController 機制搬進新 composable）。
8. **E、N** — 補齊測試覆蓋率工具與 handoff-importer 單元測試。
9. **K、L、M** — 前端小型修正與 ReDoS 防護。
10. **O、P、Q** — 清理項與低風險觀察項，可隨手處理。

---

*本文件彙整自 2026-09-21 的原始複檢與追蹤複檢，僅列出尚待處理的項目，供 Codex 依序執行。*
