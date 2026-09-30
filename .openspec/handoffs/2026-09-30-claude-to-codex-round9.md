# Handoff：2026-09-30 Claude Code → Codex（第九輪：記錄不中斷、未結項可信）

第八輪完成後實際使用了兩天，出現兩個直接影響日常使用的問題：

1. **每合併一個 PR，所有 Agent 就停止記錄**：只要重新建置，執行中的 MCP 全部回報 `restartRequired: true`，Agent 依規則停止呼叫 MCP。第八輪的 #167、#168、#176、#177、#178 因此沒有任何工作記錄。
2. **未結項只增不減，已經不可信**：全部專案共有 249 筆「未處理」、0 筆「已完成」、9 筆「不再需要」。抽查最舊的項目，多半是第五輪 F3–F6 早已完成的工作。Agent 從未透過 finalize 的 `resolvedOutstandingItemIds` 結案；Web 只能逐筆處理，每頁最多 5 筆。

本輪目標是讓記錄在開發過程中不中斷，並讓未結項清單反映實際狀態。這是長任務，請依階段順序進行，每一項開獨立 PR。完成後使用者會再請 Claude 複檢。

> **不在本輪範圍**：`v1.0.0` tag／Release 與 `docs/release-checklist.md` 的實機驗收仍由使用者執行。本輪不改版本號，也不代打 tag。

## 開始前必讀

- skill：後端讀 `worklog-backend`；前端讀 `worklog-ui`＋`worklog-web-code-style`；程式碼順序讀 `worklog-code-layout`；Agent 使用方式讀 `work-intelligence`。
- `pnpm test:response-size`、`pnpm test:retrieval-quality`、`pnpm test:performance`：本輪會改 MCP 回應、finalize 與新的讀取路徑，都要通過並視需要新增案例。
- `tests/storage/project-data-coverage.test.ts`：新資料表或欄位都要照 `worklog-backend` §4 處理（匯出／匯入、永久刪除、搜尋索引）。

## 第八輪複檢結果（Claude，2026-09-30）

- PR #160–#178 的四項 CI、merge SHA、migration 22 雜湊與 Session 對照已核對，詳見[第八輪複檢交接](2026-09-30-codex-round8-review.md)。
- Claude 後續修正：#179（單列精簡頁首；System Status 不再每次請求重算兩次建置雜湊，約 16 ms → 3 ms）、#181（總覽清單撐滿到視窗底部）。
- 複檢時看到、本輪要處理的：
  - 上面兩個問題。
  - MCP lease 目錄（`<tmpdir>/work-intelligence/mcp-runtime/<scope>/`）目前有 286 個檔案，實際只有 3 個 MCP 程序。過期 lease 讀取時會依 TTL 忽略，但從來不刪。

## 階段 A：開發過程中也能持續記錄（最優先）

### A1. 區分「必須重新連線」與「有新版可用」

**現況**：`packages/shared/src/mcp-runtime.ts` 的 `getMcpRestartStatus()` 只比較整個 runtime dist 的 `buildId`。任何一行實作改動都會讓所有執行中的 MCP 變成 `restartRequired: true`；Agent 依 skill 與工具說明停止呼叫 MCP，當次工作就沒有記錄。

1. 建置時除了 dist 雜湊，再嵌入**相容性識別**，至少包含：
   - 資料庫 schema 版本（`LATEST_SCHEMA_VERSION`）；
   - Agent 可見的契約：`tools/list` 內容，以及每個 operation 的 input schema 與 contract resource。
2. 比對規則：
   - 相容性識別不同（schema 版本或契約變了）：維持 `restartRequired: true`，Agent 停止並請使用者重新連線。
   - 只有實作改變：`restartRequired: false`，另回傳 `updateAvailable: true` 與一行提示，**讀寫都照常進行**。
   - 無法判斷時維持保守行為（視為需要重新連線）。
3. 舊版 MCP 開著、新 migration 已套用時，舊程序寫入必須被擋下，不可寫出舊格式資料。請寫出這個情境的測試。
4. 更新工具說明、server instructions、`work-intelligence` skill：只有 `restartRequired` 才停止；`updateAvailable` 在收尾時提醒使用者一次即可。
5. Web「系統狀態」的「MCP 連線」卡分開顯示「需要重新連線」與「有新版可用」的程序數。
6. 維持 #179 的效能：System Status 請求不可重新對整個 dist 計算雜湊。

### A2. 清理過期的 MCP lease

1. MCP 註冊時與 System Status 讀取時，刪除心跳超過 TTL 一段時間（在 PR 說明門檻）的 lease 與遺留的 `.tmp` 檔。
2. 每次清理的檔案數要有上限，不可阻塞 MCP 啟動或 System Status 回應；刪除失敗時靜默略過。
3. 只能刪該 scope 目錄內、符合 lease 檔名格式的檔案。
4. 測試全部在暫存目錄進行，不碰真正的 `tmpdir()`。

### A3. 補存第八輪缺漏的工作記錄

#167、#168、#176、#177、#178，以及第八輪最後的收尾工作沒有 Session。

1. 只有 Codex 自己的對話紀錄能提供實際的開始／完成時間與內容時才補存；時間取自對話紀錄，不可用 PR 時間推估。
2. 找不到對話紀錄的，在複檢交接中標示「資料不足」，不要補。
3. 補存的 Session 要帶 PR 編號、分支與 commit，才能跟既有記錄對應。

## 階段 B：未結項反映實際狀態

### B1. Web 批次處理

1. 未結項清單可以多選、選取本頁全部，並批次標記「已完成」或「不再需要」。
2. 篩選條件增加來源 Session 的完成日期範圍，方便一次處理某一輪的舊項目。
3. REST 新增批次更新端點：單次上限（例如 100 筆）、同一個 transaction、每筆都寫入既有的 `outstanding_item_events` 稽核紀錄；上限以外或有無效 id 時整批拒絕並回傳原因。
4. 批次操作後可以一次復原為「未處理」。
5. 手機寬度可用；照 `worklog-ui` 的清單與按鈕規範。

### B2. 收尾時讓 Agent 真的結案

**現況**：`work_get_context` 只列最新的 5 筆未結項，和本次工作未必相關；Agent 收尾時也沒有任何提示去檢查未結項。

1. finalize 前可取得與本次工作相關的未結項：依 `paths`、關鍵字與來源 Session 相關度排序，而非只看新舊。放進既有的讀取 operation 或 context 的 task 模式，不要新增重複的工具。
2. finalize 新增 `supersededOutstandingItemIds`：本次的 nextSteps 取代了舊項目時，把舊項目標為「不再需要」並在稽核紀錄寫明被哪一筆 Session 取代。
3. finalize 回應中列出「本次沒有處理、但與本次工作相關」的未結項，附一行提示。
4. skill 與工具說明寫清楚：只有確認完成的才放進 `resolvedOutstandingItemIds`；不確定就不要動。
5. 回應大小要通過 `test:response-size`；finalize 新增的查詢要有效能門檻。

### B3. Agent 協助整理既有的未結項

既有的 249 筆不能靠使用者逐筆判斷，也不能讓 Agent 直接結案。流程比照 metadata backfill：

1. 使用者在 Web 對某個專案發起「整理未結項」請求。
2. Agent 取得整理用的 context：未處理項目，加上同專案之後的 Session 摘要、outcomes 與 PR。回應要有預算與分頁。
3. Agent 對每一筆提出建議：「已完成」或「不再需要」，附上作為證據的 Session id 與一句理由；證據不足的**不提建議**。
4. 建議只寫入待審清單，不改變未結項狀態。使用者在 Web 逐筆或批次接受、拒絕。
5. 接受時寫入稽核紀錄，註明來自哪一次整理建議與證據 Session。
6. 新資料表照 `worklog-backend` §4 處理，並通過 `project-data-coverage`。
7. 在 PR 中附上以合成資料量測的建議準確度；使用者的實際資料只由使用者自己在 Web 審核。

## 階段 C：文件

### C1. 文件與狀態頁

1. README、`docs/mcp-tools.md`、`docs/agent-setup.md`、`docs/troubleshooting.md`、`docs/user-guide.md` 依本輪實際行為更新；尤其是「什麼時候需要重新連線」。
2. `docs/status.md` 新增第九輪段落，第八輪移到歷史區；E3 實機驗收與 tag 仍列為使用者待辦。
3. CHANGELOG 寫在 Unreleased，不改版本號。

## 工作規則（重申）

- 繁體中文。
- 開工前讀對應的 skill（見「開始前必讀」）。
- 每完成一段就 finalize，每一筆都填 `startedAt`：取自對話紀錄，不要估計。
- 每項開獨立 PR。**最新 commit 的四項 CI（Quality ubuntu／windows／macos 與 E2E）都是 success 才合併**。不要用 `gh pr merge --auto`：E2E 不是必要檢查，`--auto` 會在它跑完前就合併。合併用 merge commit，並刪除分支。
- 健康檢查逐步確認：build、test、typecheck、coverage、performance、retrieval-quality、response-size、E2E。
- 效能：先量測再優化。新的讀取路徑都要有基準情境與上限。
- 不修改使用者的實際資料庫、Agent 設定或全域 hook；測試不碰真正的 HOME 與 `tmpdir()`。
- MCP 不新增刪除資料或變更檔案路徑的能力。未結項的狀態改變一律留下稽核紀錄。
- 使用 pnpm，不使用 npm／npx。
- `docs/agent-memory-improvement-plan.md` 是使用者的未追蹤檔案，不可加入提交。
- 每個階段都檢查 README 與 docs。
- PR 說明寫清楚設計取捨、沒做的部分與驗證方式。
- 結束時比照第八輪，寫一份複檢交接文件，包含：
  - PR、head／merge SHA、CI run、工作記錄 ID 對照；
  - A1 在「只有實作改變」與「schema／契約改變」兩種建置下的實測結果；
  - A2 清理前後的 lease 檔案數；
  - B3 以合成資料量測的建議準確度。

## 下次複檢 Claude 會特別看

- A1：只改實作的 rebuild 後，執行中的 MCP 仍能 finalize；改 schema 或契約後會要求重新連線；舊程序在新 migration 後寫不進資料；System Status 分開顯示兩種數量，且請求時間沒有退步。
- A2：lease 目錄只剩存活中的程序；清理有上限、只刪符合格式的檔案；測試沒有碰到真正的 `tmpdir()`。
- A3：補存的記錄都有對話紀錄作為依據；沒有依據的標為資料不足。
- B1：批次上限、單一 transaction、每筆都有稽核紀錄；可以復原。
- B2：收尾時看得到相關的未結項；`supersededOutstandingItemIds` 有稽核；不確定的項目沒有被結案。
- B3：Agent 的建議不會直接改變狀態；沒有證據的項目不提建議；新資料表通過 `project-data-coverage`。
- 文件與實際行為一致。
