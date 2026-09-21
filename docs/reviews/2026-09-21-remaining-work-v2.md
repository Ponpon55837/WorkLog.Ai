# WorkLog.Ai 待處理事項清單 v2（給 Codex 繼續執行）

- 日期：2026-09-21
- 來源：彙整自
  - [2026-09-21-code-review.md](./2026-09-21-code-review.md)（原始複檢）
  - [2026-09-21-followup-review.md](./2026-09-21-followup-review.md)（第一次追蹤複檢）
  - [2026-09-21-remaining-work.md](./2026-09-21-remaining-work.md)（v1 待辦清單）
  - [2026-09-21-codex-execution.md](./2026-09-21-codex-execution.md)（Codex 第一批執行文件，處理了 v1 的 A/B/C/D）
  - [2026-09-21-codex-execution-review.md](./2026-09-21-codex-execution-review.md)（針對第一批的複檢結果）
- 狀態：v1 的 **A、B、C、D 四項已確認修正完成**（詳見 codex-execution-review.md），本文件只列出**新發現的小缺口**與 **v1 尚未處理的 E-Q 項目**（不再重複列出已完成項目）。
- 使用方式：依「建議執行順序」逐項處理，每項附檔案路徑、行號、現況與具體修法。修正後跑 `pnpm test`、`pnpm typecheck`、`pnpm build`；涉及 API 或前端行為變動的項目另外跑 `pnpm test:e2e`。
- **流程建議（請一併處理）**：目前 repo 只有一個近乎空白的 `Initial commit`，所有原始碼都是未提交狀態，導致每次複檢都無法用 `git diff` 比對修改前後，只能靠完整重讀程式碼替代，效率較低也容易遺漏細節。**請在處理完本文件的修正後建立一個 commit**，之後每批修正前後都各建一個 commit，方便後續複檢直接看 diff。

## 待處理事項總覽

| # | 項目 | 類別 | 狀態 | 優先度 |
|---|---|---|---|---|
| A1 | `changedFilesProvenance`/`changedFileChanges` 200 筆上限缺邊界測試 | 測試（新發現） | 已修正 | 已完成 |
| B | `safeProjectPath`／`ProjectPathResolver` 仍有同步 I/O 阻塞事件迴圈的風險 | 效能/可用性 | 部分修正 | 高 |
| D | 缺 ESLint/Prettier | 工具鏈 | 未修正 | 高（建議在大型重構前先做） |
| E | 缺測試覆蓋率工具 | 工具鏈 | 未修正 | 中 |
| F | `store.ts` 拆分成多個 repository/module | 架構 | 未修正 | 中高（工作量大） |
| G | 「查 project → policyGate.check → skipped」樣板重複（約 30 處） | 架構 | 未修正 | 中 |
| H | `SkippedResult` 欄位命名不一致（`projectRoot`/`projectId`） | 一致性 | 未修正 | 中（與 G 一併處理） |
| I | `App.vue` 拆分成 views/components | 前端架構 | 未修正 | 中高（工作量大） |
| J | 前端無集中 API client / `useApiRequest` composable | 前端架構 | 未修正 | 中高 |
| K | 剪貼簿複製邏輯重複兩份 | 前端 | 未修正 | 低（小工作量，可隨手做） |
| L | Sessions/Knowledge/Report evidence「All」選項無虛擬化 | 前端效能 | 未修正 | 低中 |
| M | `handoff-importer.ts` 無 ReDoS 防護 | 安全性 | 未修正 | 低 |
| N | `handoff-importer.ts` 缺單元測試 | 測試 | 部分修正 | 低中 |
| O | `commitRequired` 殭屍欄位 | 清理 | 未修正 | 低 |
| P | `packages/core/src/modules.ts` 死代碼 | 清理 | 未修正 | 低 |
| Q | 逾時回收函式無交易包裹 | 正確性（觀察） | 未修正 | 低（自我修復性質，非急迫） |

---

## 高優先

### A1.（已修正）`changedFilesProvenance`/`changedFileChanges` 200 筆上限邊界測試

- **檔案**：`packages/schema/src/index.test.ts:18-82`
- **現況**：`finalizeSessionInputSchema` 與 `updateSessionMetadataInputSchema` 的 `changedFiles`、`changedFilesProvenance`、`changedFileChanges` 三個陣列都限制為 `.max(200)`，且四組 provenance／lifecycle change 的 201 筆拒絕測試已補上。
- **驗證**：`packages/schema/src/index.test.ts` 現在覆蓋 finalize 與 metadata update 的兩種陣列邊界，應列為已完成，不再是後續待辦。

### B. `safeProjectPath`／`ProjectPathResolver` 仍有同步 I/O 阻塞事件迴圈的風險

- **檔案**：`packages/project-policy/src/index.ts:54-133`
- **現況**：Codex 已加入 `ProjectPathResolver` 做「同一次操作內快取 `realpathSync(projectRoot)`」的優化，並新增 safe path／safe existing path 的候選結果快取。這降低了同一批次重複路徑的同步 I/O，但 `resolveCandidate` 對新的候選路徑仍會做 `existsSync` 向上遞迴尋找存在的父目錄 + `realpathSync`，本質仍是同步阻塞 I/O。
- **影響**：`changedFiles`/`changedFileChanges`/`changedFilesProvenance` 上限已從 500 降到 200（見上方 A1），單次請求的阻塞次數已降低，但單一大量檔案的請求仍可能觸發到 200 次同步系統呼叫，`apps/server` 是單執行緒 `http` server，仍會阻塞事件迴圈。
- **修法**：
  1. 先用實際 payload 與 benchmark 量測 200 筆上限下的延遲，再決定是否收緊上限；目前不直接改變既有 API 上限。
  2. 中期若確認同步 I/O 是瓶頸，再另開 async storage contract／worker 工作，因為目前 `WorkIntelligenceStore`、REST 與 MCP handler 都是同步 facade，不能只局部替換成 `Promise.all`。

### D. 缺 ESLint / Prettier

- **檔案**：monorepo 根目錄與各 package 下均無 `.eslintrc*`、`eslint.config.*`、`.prettierrc*`；根目錄 `package.json` 無 `lint` script
- **問題**：`tsconfig.base.json` 雖有 `strict: true`，但沒有 lint 規則，無法自動抓未使用的 import/變數、no-floating-promises 等潛在 bug 來源，程式碼風格也不一致。
- **修法**：加入 `@typescript-eslint` + `eslint-plugin-import` 基本設定，`package.json` 加 `lint` script 並串進 `pnpm test`/CI。**建議在 F、G、I、J 等大型重構之前先做好**，作為重構期間的安全網。

---

## 中高優先

### F. `store.ts` 拆分成多個 repository/module

- **檔案**：`packages/storage/src/store.ts`（全檔，上次複檢時為 4728 行）
- **問題**：`WorkIntelligenceStore` 單一 class 同時負責 schema/migration、Project CRUD、Session finalize/metadata/summary、Knowledge CRUD、Report 建置/synthesis 狀態機、Metadata backfill 狀態機、Handoff import、Graph 建置、Evidence attach。
- **修法**：拆成多個 repository（`SessionRepository`、`KnowledgeRepository`、`ReportBuilder` + `ReportSynthesisRequestRepository`、`MetadataBackfillRepository`、`HandoffImportService`、`GraphBuilder`、`SchemaMigrator`），`WorkIntelligenceStore` 保留為 facade 委派給各模組，對外 API 不變。**建議先完成 D（lint）再動手，降低拆分風險**。

### I. `App.vue` 拆分成 views/components

- **檔案**：`apps/web/src/App.vue`（全檔，上次複檢時為 3330 行）
- **問題**：Dashboard、Projects、Reports、Knowledge、Graph、Worklog 六個視圖與 5 個 modal（Session Detail、Knowledge Editor、Knowledge History、Graph Node、Handoff Import）全部寫在同一個 SFC，且用 `v-if="activeView === 'dashboard'" / v-else-if ...` 鏈式切換視圖，沒有 Vue Router。
- **修法**：
  1. 導入 Vue Router 取代鏈式 `v-if/v-else`。
  2. 依視圖拆成 `views/DashboardView.vue`、`ReportsView.vue`、`KnowledgeView.vue`、`GraphView.vue`、`WorklogView.vue`、`ProjectsView.vue`。
  3. 5 個 modal 各自抽成獨立元件，抽出共用 `BaseModal.vue`。
  4. **拆分時務必把現有的 AbortController 機制（`beginRequest`/`isCurrentRequest`/`finishRequest`/`isAbortError`）與 `request<T>()` 一起搬進 `useApiRequest` composable**（呼應項目 J），這組機制目前運作良好，不要在拆分過程中遺漏或破壞。

### J. 前端無集中 API client / `useApiRequest` composable

- **檔案**：`apps/web/src/App.vue`（`request<T>()`），約 97 個頂層函式各自組 `URLSearchParams`、各自宣告 loading/error ref
- **修法**：抽出 `apps/web/src/api/client.ts`，把每個資源端點包成型別化函式；抽出共用 composable `useApiRequest()` 統一處理 `loading`/`error`/`data` 三態與 AbortController 邏輯（見項目 I 的第 4 點），應與 I 一併規劃、一次還清。

---

## 中優先

### G. 「查 project → policyGate.check → skipped」樣板重複

- **檔案**：`packages/storage/src/store.ts` 全檔目前約 30 處直接呼叫 `this.policyGate.check(...)`，每處各自手刻 `if (!decision.allowed || !decision.project) { return { outcome: "skipped", ... } }`
- **修法**：抽出私有 helper（如 `requireTrackedProjectByRoot`、`requireTrackedProjectById`），回傳 union 結果供各處 early return，消除重複程式碼，同時降低「某處漏加 policy check」的風險。建議與 F（`store.ts` 拆分）一併規劃，拆分後的各 repository 共用同一組 helper。**注意**：Codex 第一批已新增 `ProjectIdSkippedResult` 型別，拆分樣板時請沿用這個已確立的 root/id 雙軌回應模式，不要再引入第三種變體。

### H. `SkippedResult` 欄位命名不一致

- **檔案**：`packages/core/src/index.ts`
- **現況**：Codex 第一批新增了 `ProjectIdSkippedResult`（`projectId`），與既有 `SkippedResult`（`projectRoot`）並存，這是刻意的雙軌設計而非隨機不一致，已在 codex-execution-review.md 中確認正確套用。
- **剩餘問題**：目前仍有 project-root、project-id、session-id 三種不同 scope；這不應被簡化成所有 skipped response 都使用同一個 `projectId` 欄位。`SkippedReportResult.projectId?` 也同時支援 all-project scope，不能只靠名稱判斷為錯誤。
- **修法**：先建立 scope 對照表與 contract tests：root-scoped 使用 `projectRoot`、project-id-scoped 使用 `projectId`、session-scoped 使用 `sessionId`；只有在完成相容性盤點後，才評估加入帶 `scopeType` 的新 envelope，不在 MVP 直接替換既有 response shape。

---

## 中低優先

### L. Sessions/Knowledge/Report evidence「All」選項無虛擬化

- **檔案**：`apps/web/src/App.vue`（`listPageSizeOptions` 含 `{ value: "all", label: "All" }`），`pageSizeToQuery("all")` 回傳 `0` 向後端請求不分頁的全量資料；同一選項也用於 Report 原始 Session 與 Evidence。
- **現況**：Graph 已有配額截斷機制緩解，但列表的「All」選項完全沒有處理，`package.json` 未安裝任何虛擬捲動套件。
- **修法**：第一階段對「All」選項設 server-side hard cap 並回傳可辨識的截斷狀態，再視資料量導入虛擬捲動元件（如 `vue-virtual-scroller`）。

### N. `handoff-importer.ts` 缺單元測試

- **檔案**：`packages/storage/src/handoff-importer.ts`（`classifyHandoff`、`parseVerification`、`extractChangedFiles` 均為模組私有函式）
- **現況**：只有 `store.test.ts` 透過公開 API `previewHandoffImport` 做整合層級驗證，函式本身無單元測試，中英文混合、多層 heading、程式碼區塊內誤判等邊界情境未覆蓋。
- **修法**：優先把 parser 拆成可測試的純函式模組，再由 importer 呼叫；不要只為了測試而擴大 production export surface。補上 `handoff-importer.test.ts`，覆蓋中英文混合、多層 heading、程式碼區塊內誤判與 changed-file path 邊界。

---

## 低優先

### E. 缺測試覆蓋率工具

- **檔案**：根目錄 `package.json`（`test` script 仍是純 `vitest run src`，無 `--coverage`）
- **修法**：加入 `@vitest/coverage-v8`，在 CI 設定 `storage`/`schema` 的最低覆蓋率門檻。

### K. 剪貼簿複製邏輯重複兩份

- **檔案**：`App.vue` 的 `copyReportSynthesisInstruction` 與 `copyMetadataBackfillInstruction`
- **問題**：兩份函式邏輯逐字重複，均用已棄用的 `document.execCommand("copy")` 作為 fallback。
- **修法**：抽成共用 composable `useClipboard()`，評估是否仍需 `execCommand` fallback。

### M. `handoff-importer.ts` 無 ReDoS 防護

- **檔案**：`packages/storage/src/handoff-importer.ts`（`findStatusSignals`、`extractChangedFiles`、`parseVerification`）
- **現況**：正則多用 lazy quantifier，輸入已有 `.slice(0, 200_000)` 上限，實務風險偏低，但未加執行時間/迭代次數軟上限。
- **修法**：加執行時間/迭代次數軟上限，或引入 `safe-regex` 類工具做靜態檢測。

### O. `commitRequired` 殭屍欄位

- **檔案**：`packages/core/src/index.ts`（型別寫死 `false`）、`packages/storage/src/store.ts`（`toSession()` 永遠回傳 `false`；DB schema `CHECK (commit_required = 0)`；`finalizeSession` INSERT 仍寫入常數 `0`）
- **修法**：確認前端無依賴後整組移除（型別欄位、DB 欄位待下次 migration 版本化清理、相關程式碼）。

### P. `packages/core/src/modules.ts` 死代碼

- **檔案**：`packages/core/src/modules.ts`（全檔 42 行，定義 `ReportModule`/`EvidenceModule`/`KnowledgeModule`/`GraphModule`/`ExtensionModules`）
- **現況**：全 repo 確認除自身定義外無任何實作或 import。
- **修法**：若無「core 定義介面、storage 實作」計畫，直接刪除此檔與對應 re-export；若有計畫，讓 `WorkIntelligenceStore implements` 這些介面。

### Q. 逾時回收函式無交易包裹（觀察，非急迫）

- **檔案**：`packages/storage/src/store.ts`（`recoverStaleReportSynthesisRequests`、`recoverStaleMetadataBackfillRequests`）
- **現況**：先 `SELECT` 撈出逾時請求，再逐筆 `UPDATE`，中間無交易；每筆 `UPDATE` 都有 `WHERE status='processing'` 防護、是冪等操作，中斷後下次啟動會自我修正。
- **修法**：可視情況一併包進 `runImmediateTransaction`，非急迫。

---

## 建議執行順序

1. **D** — 建立 ESLint/Prettier check-only 安全網，不先做全檔格式化。
2. **B** — 以 benchmark 驗證同步 path I/O；維持目前 API，同批次快取已先完成。
3. **F、G** — `store.ts` 拆分 + policy check 樣板去重（一併規劃，工作量最大）。
4. **H** — 先建立 root/id/session scope contract tests，不直接替換所有 response shape。
5. **I、J** — `App.vue` 拆分 + 集中 API client（一併規劃，記得把現有 AbortController 機制搬進新 composable）。
6. **E、N** — 補齊測試覆蓋率工具與 handoff-importer 單元測試。
7. **K、L、M** — 前端 clipboard／All hard cap 與低風險 parser 防護。
8. **O、P、Q** — 清理項與低風險觀察項，可隨手處理。

**每完成一批（建議以上方分組為單位），請建立一個 git commit**，方便下一輪複檢直接用 `git diff` 比對，取代目前逐次重讀全部程式碼的方式。

---

*本文件彙整自 2026-09-21 系列複檢與 Codex 第一批執行結果，僅列出尚待處理的項目，供 Codex 依序執行。*
