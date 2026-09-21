# Codex 第一批修正（A-D）複檢報告

- 日期：2026-09-21
- 對應 Codex 執行文件：[2026-09-21-codex-execution.md](./2026-09-21-codex-execution.md)
- 對應待辦清單：[2026-09-21-remaining-work.md](./2026-09-21-remaining-work.md)（本次處理 A、B、C、D 四項）
- 複檢方式：repo 目前只有一個近乎空白的 `Initial commit`（僅 `.gitattributes`），所有原始碼皆為未提交檔案，**無法用 `git diff` 比對修改前後**。本次改採「完整讀取程式碼＋獨立重跑驗證指令」的方式核對，而非逐行 diff。

## 結論：A-D 四項全部確認無誤，僅 1 個低嚴重度測試覆蓋缺口

Codex 這批修正的實作品質高，程式碼邏輯自洽、測試斷言到位，且我獨立重跑 `pnpm test`、`pnpm typecheck` 均與其執行文件宣稱的結果一致（`pnpm build`、`pnpm test:e2e`、`pnpm audit` 因涉及較長建置時間未逐一重跑，但程式碼層級核對未發現與其宣稱矛盾之處）。

---

## 逐項核對結果

### 1. `ProjectIdSkippedResult` 只套用在 projectId-scoped API，未破壞 root-scoped `SkippedResult` — 【確認無誤】

- `packages/core/src/index.ts:804-809` 新增 `ProjectIdSkippedResult { outcome: "skipped"; projectId; projectStatus; reason }`，原本的 `SkippedResult`（`projectRoot`）、`KnowledgeSkippedResult`、`GraphSkippedResult`、`SkippedContextResult`、`SkippedReportResult` 均維持不變。
- `packages/storage/src/store.ts` 的 `createMetadataBackfillRequest`（1544 起）、`listMetadataBackfillRequests`（1674 起）、`cancelMetadataBackfillRequest`（1732 起）、`getMetadataBackfillContext`（1802 起）在 `projectId` 分支下都正確回傳 `ProjectIdSkippedResult`（以 `satisfies` 明確約束型別）。
- `previewMetadataBackfill` 等 root-scoped 路徑仍回傳原本的 `SkippedResult`（`projectRoot`），未被誤改。
- 測試 `store.test.ts:902-947` 明確驗證 unregistered/paused 情境下四個方法都回傳 `projectId` 而非 `projectRoot`，測試通過。

### 2. unknown/paused/ignored project 在讀取 Session/source 前都先做 policy gate — 【確認無誤】

- 四個方法的 policy gate 檢查順序都正確：先確認 project 存在與狀態，gate 失敗立即回傳 skip，不會繼續往下讀取 Session 內容或 source/handoff/Git。
- `cancelMetadataBackfillRequest`、`getMetadataBackfillContext` 會先讀出「請求記錄本身」（含 `project_id`）才能做 gate 判斷，這是必要的架構限制（沒有 `project_id` 無法決定要 gate 哪個 project），並非讀取 Session 詳情，屬合理設計。
- paused/ignored/unregistered 三種狀態均由 `ProjectPolicyGate.check`（`packages/project-policy/src/index.ts:22-51`）統一攔截並 fail closed。

### 3. `ProjectPathResolver` 邊界情境（Windows 路徑、symlink、deleted path、不存在的 root）— 【確認無誤】

逐項核對 `packages/project-policy/src/index.ts:54-133`：

- **Windows 路徑**：`isPathWithinProject` 用 `node:path` 的 `relative`/`sep`，並額外檢查 `..\`、`../`、`:\`（防止磁碟機代號跳脫），跨平台一致。
- **root 本身是 symlink**：一次性快取 `realRoot = realpathSync(projectRoot)`，後續一律用 `realRoot` 比對，root 是否為 symlink 不影響正確性。
- **project 內子路徑指向外部的 symlink**：`resolveCandidate` 沿路徑向上找「目前存在的最近路徑」做 `realpathSync` 並檢查邊界，一旦透過 symlink 指到 root 外即 fail closed。
- **已刪除/尚未建立的檔案**：`resolveCandidate` 允許回傳 lexical candidate（供 metadata 使用），但 `safeExistingPath` 對同一路徑做 `realpathSync` 時因檔案不存在而 fail closed，符合「metadata 可保留、真正讀檔 fail closed」的設計。
- **root 本身不存在**：`safeExistingPath` 直接回傳 `undefined`。
- `handoff-importer.ts` 的 `discoverHandoffCandidates` 在函式開頭建立**一個** resolver 供整個遞迴掃描重用，`realRoot` 只計算一次，符合「operation-scoped resolver」的宣稱；`entry.isSymbolicLink()` 的目錄/檔案項目也額外直接略過。

### 4 & 5. `getGraph` 批次讀取改動 — 【確認無誤】

- 確認函式體（`store.ts:4024-4337`）內**沒有**任何 project loop 內的 `listSessions`/`searchKnowledge` 呼叫，也沒有逐專案的 evidence SQL。
- Sessions、Knowledge、Evidence 均改為一次性批次查詢，再於記憶體中用 `Map` 依 `projectId`/`session_id` 分組，供 totals 計算與 render 共用。
- `totalNodes`/`totalEdges`/`totalNodesByKind` 用批次查到的完整資料集計算，不受 render 階段配額影響，維持原始語意；排序、`sourceSessionIds`、`truncation` 邏輯均未改變。
- 仍完全不讀取 project source/handoff/Git，維持 read-only graph 設計。
- 測試 `store.test.ts:1407-1467` 涵蓋五種節點/四種邊、非 tracked project 排除、totals 精確比對、`maxNodes`/`maxEdges` 截斷情境，全數通過。

### 7. 是否有超出 A-D 範圍的意外變更 — 【確認無誤，1 個低嚴重度測試覆蓋缺口】

- `commitRequired` 殭屍欄位、`packages/core/src/modules.ts` 死代碼均維持原樣未被誤動，符合「刻意未擴大範圍」的聲明。
- README 與 MCP tool description 已同步 200 筆上限與 `projectId` skip 契約說明，文件/schema/實作三者一致。
- 獨立重跑 `pnpm test`（43 tests 全過）、`pnpm typecheck`（全 workspace 通過），與 Codex 執行文件第 3 節聲稱結果相符。

**發現的低嚴重度問題**：

- **檔案**：`packages/schema/src/index.ts:86-88`（`finalizeSessionInputSchema`）、`212-215`（`updateSessionMetadataInputSchema`）
- **現況**：`changedFiles`、`changedFilesProvenance`、`changedFileChanges` 三個陣列確實都同步改成 `.max(200)`，修正是完整的（優於原待辦事項描述的擔憂）。
- **缺口**：`packages/schema/src/index.test.ts:18-45` 只針對 `changedFiles` 補了「201 筆應被拒絕」的邊界測試，**沒有**針對 `changedFilesProvenance`、`changedFileChanges` 超過 200 筆補測試。
- **影響**：程式碼正確、測試覆蓋不完整。若未來有人不小心把後兩個陣列的 `.max(200)` 誤改或誤刪，現有測試不會抓到。
- **建議修法**：比照現有兩個測試案例，各補一筆「201 個 provenance / changes 項目應被拒絕」的斷言，成本很低，可隨手處理。

---

## 建議

1. **補上述測試覆蓋缺口**（低優先，成本低，可與下一批一起處理）。
2. **建議 Codex 在下一批動手前先建立一個基準 commit**：目前 repo 只有一個近乎空白的 `Initial commit`，導致每次複檢都無法用 `git diff` 比對，只能靠完整重讀程式碼取代，效率較低也容易遺漏細節。若能在每批修正前後各建一個 commit，後續複檢可以直接看 diff，準確度與效率都會提升。
3. 待處理清單（[2026-09-21-remaining-work.md](./2026-09-21-remaining-work.md)）中的 E-Q 項目仍待後續批次處理，可依原文件的優先順序繼續執行。

---

*本文件為 WorkLog.Ai 專案複檢系列的第三份文件，針對 Codex 依 [remaining-work.md](./2026-09-21-remaining-work.md) 執行的第一批修正（A-D）做獨立複檢確認。*
