# Codex 第二批小幅修正（A1、B）複檢報告

- 日期：2026-09-21
- 對應 Codex 執行文件：[2026-09-21-codex-correction-execution.md](./2026-09-21-codex-correction-execution.md)
- 對應待辦清單：[2026-09-21-remaining-work-v2.md](./2026-09-21-remaining-work-v2.md)（本次處理 A1、B 兩項，並同步更新文件本身）
- 複檢方式：repo 仍無可用 commit 歷史，採「完整讀取程式碼＋獨立重跑驗證指令」方式核對。

## 結論：A1、B 兩項全部確認無誤，僅 1 個低嚴重度細節可留待未來處理

我獨立重跑 `pnpm test`、`pnpm typecheck`，結果與 Codex 聲稱一致（`pnpm build`、`pnpm test:e2e` 本輪未重複驗證，上一批已驗證過建置鏈正常，本批修改範圍小，風險低）。

---

## 逐項核對結果

### 1. 四組 schema 邊界測試確實驗證 provenance/lifecycle changes — 【確認無誤】

- `packages/schema/src/index.test.ts:36-84` 確實新增 4 組測試：finalize-provenance（36-46）、finalize-lifecycle（48-58）、metadata-provenance（60-71）、metadata-lifecycle（73-84）。
- 每組測試都正確地只把目標陣列（`changedFilesProvenance`/`changedFileChanges`）撐到 201 筆，`changedFiles` 本身維持空陣列，不會誤觸到別的欄位上限，確實是獨立驗證。
- 對照 `packages/schema/src/index.ts:86-88`（finalize）與 `212-215`（metadata update），兩個陣列皆為 `.max(200).optional()`，與測試期待一致。
- 全檔共 7 組測試，與獨立重跑 `pnpm test` 顯示的 schema 7 tests 相符。

### 2 & 3. `ProjectPathResolver` cache 正確性與作用域 — 【確認無誤，1 個低嚴重度細節】

- `packages/project-policy/src/index.ts:72-77`：`safePathCache`、`safeExistingPathCache` 是 `createProjectPathResolver` 函式內的區域變數（closure），並非 module-level；`store.ts` 的所有呼叫點都是每次操作各自建立新的 resolver，不會跨 project 或跨請求復用，符合「單次 operation scope」的宣稱。
- Cache key 由 `cacheKeyFor` 產生：先 `resolve(projectRoot, path)` 正規化，Windows 上再 `toLowerCase()`。
  - **相對路徑 vs 絕對路徑**：`resolve()` 已正規化成同一個絕對路徑字串，不會產生不同 key 或誤判。
  - **`/` 與 `\` 混用**：`resolve()` 統一成原生分隔符號，同樣不會造成不一致。
  - **Windows 大小寫**（低嚴重度細節）：`cacheKeyFor` 對 key 做了 lowercase，但存入快取的**值**（`candidate`/`safeCandidate`）保留原始大小寫。若先以 `"Src/File.ts"` 呼叫、之後以 `"src/file.ts"` 呼叫，會命中同一個 lowercase key，但拿回的是第一次呼叫時的大小寫字串，而非本次輸入對應的大小寫。
    - **不構成安全邊界誤判**：底層安全判斷（`isPathWithinProject`、`realpathSync`）操作的是實際檔案系統路徑，NTFS 大小寫不敏感時兩個大小寫變體本就指向同一個真實檔案，驗證結論相同。
    - **影響範圍極小**：目前所有呼叫端都不依賴回傳字串的確切大小寫做後續比對，現況不構成功能性 bug。
    - **建議修法（非急迫）**：若要更嚴謹，寫入 cache 時也用正規化的值（都存 lowercase 或都存 realpath 後的大小寫），避免依賴「先到者的大小寫」。可留到下次觸碰這段程式碼時一併處理，不需要為此單獨開一批修正。

### 4. `safeExistingPath` 仍對不存在檔案與 project-root 外 symlink fail closed — 【確認無誤】

- 對「檔案不存在」與「symlink 指向 project root 外」兩種情況，都在 catch 分支或 `isPathWithinProject` 為 false 時把 `undefined` 存入 cache 並回傳，沒有任何「快取成安全」的誤判路徑。
- 檢查實際呼叫鏈（`handoff-importer.ts` 的 `discoverHandoffCandidates`、`path-safety.ts`）：所有使用 `safeExistingPath` 的操作都是唯讀流程，過程中不會建立新檔案，因此執行文件中假設的「檢查後才建立檔案導致 stale cache」情境在目前程式碼路徑中不會發生，與 Codex 自行判斷「理論上不太可能」一致。

### 5. v2 文件更新與現況一致 — 【確認無誤】

- `policyGate.check(...)` 實際 grep 得到 **30 處**（`store.ts` 全部行號已逐一列出核對），與文件「G=30」及執行文件「policy check inventory：目前 30 處」一致。
- `packages/core/src/index.ts` 中 skipped 結果型別確實只有三種 scope：`projectRoot`（`SkippedResult` 等）、`projectId`（`ProjectIdSkippedResult`、`SkippedReportResult` 的 optional 用法涵蓋單一 project 與 all-projects 情境）、`sessionId`（`EvidenceSkippedResult`、`SessionVerificationSkippedResult`）。未發現遺漏的第四種 scope，與 H 項目描述一致。

### 6. 重跑驗證 — 【確認無誤】

- `pnpm test`：project-policy 6、schema 7、storage 25、server 3、MCP 6，共 **47 tests 全數通過**，與 Codex 聲稱一致（本次由我獨立重跑確認，非僅採信文件）。
- `pnpm typecheck`：全部 workspace + `tsconfig.e2e.json` 皆通過。

---

## 總結與建議

Codex 這批修正範圍小（只處理 A1、B 兩項並同步更新 v2 文件），品質延續前兩批的水準：邏輯正確、測試到位、獨立驗證結果一致。唯一發現的細節（cache 大小寫正規化不一致）是低嚴重度、非安全問題，可留到日後有相關改動時一併處理，**不需要為此單獨開一批修正**。

**v2 待辦清單狀態更新**：A1 已完成，B 從「未修正」提升為「部分修正」（已加入快取降低重複開銷，同步 I/O 的本質風險仍在，Codex 也已在文件中明確說明「暫不改 async，需另開完整 contract 與效能基準批次」，這個判斷合理）。其餘 D、E、F、G、H、I、J、K、L、M、N、O、P、Q 仍待處理，可繼續依 [2026-09-21-remaining-work-v2.md](./2026-09-21-remaining-work-v2.md) 的建議執行順序進行。

---

*本文件為 WorkLog.Ai 專案複檢系列文件，針對 Codex 第二批小幅修正（A1、B）做獨立複檢確認。*
