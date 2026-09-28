# Handoff：2026-09-28 Claude Code → Codex（第八輪：收尾——可用、好用、能幫到其他專案，並發行 1.0.0）

這是這幾天工作的收尾輪。目標是讓 Work Intelligence：

1. **在任何專案都能直接用**：其他專案的 Agent 也知道怎麼用，不需要讀本 repo。
2. **用起來省 token、找得到答案**：工具清單變小，自然語句找得到答案，使用者能在自己的資料上量測品質。
3. **對日常工作有實際幫助**：多天工作的未結項不會遺失，第一次使用的人知道下一步。
4. **可以發行**：開機自動啟動、發行 workflow、版本 1.0.0。

這是長任務，請依階段順序進行，每一項開獨立 PR。完成後使用者會再請 Claude 複檢。

> **使用者決定（2026-09-28 更新）**：授權為 MIT。開機自動啟動、發行 workflow 與版本 1.0.0 **排進本輪最後階段（E）**。需要實體環境的驗證（Windows、macOS Safari、原生資料夾選擇視窗、私有評估題）寫成使用者照著做的驗收清單，Agent 不代做。

## 開始前必讀

- skill：後端讀 `worklog-backend`；前端讀 `worklog-ui`＋`worklog-web-code-style`；程式碼順序讀 `worklog-code-layout`；Agent 使用方式讀 `work-intelligence`。
- `pnpm test:response-size`、`pnpm test:retrieval-quality`、`pnpm test:performance`：本輪會改工具說明、檢索與新的讀取路徑，都要通過並視需要新增案例。
- `tests/storage/project-data-coverage.test.ts`：新資料表或欄位都要照 `worklog-backend` §4 處理。

## 第七輪複檢結果（Claude）

**流程**：PR #147–#156 的 head、merge SHA、CI run（四項皆 success）與 9 筆工作記錄都與複檢交接一致，Session 的檔案數也和 PR 相符。

**做得好**：

- A1 的回應大小門檻在 CI 執行，前後數字可重現。
- B1 對真正不存在的詞回傳 0 筆與 `none`：recall／search、指定或不指定專案都正確。
- D1 的跨專案隔離有回歸測試。
- D2 沒有放寬 CSP，E2E 會檢查 console。

**Claude 已修正（PR #157、#158）**，都是用實際資料的唯讀備份重跑使用測試時發現的：

1. **context 的省略清單吃掉預算**：`omitted` 佔 3,978／11,902 字元，還逐筆列出已在其他區出現的 id，相關 Session 被擠到只剩 1 筆。
   - 修正：重複只計數；預算省略每區最多列 5 個 id；有旗標的項目完整保留；先縮短摘要，最後才丟相關項目。
   - 結果：同一個 task 的 context 從 11,902 降到 9,932 字元，相關內容從 3,587 增加到 7,790 字元。
2. **所有 MCP 結果改為緊湊 JSON**：context 上限改以緊湊 JSON 計算，有焦點 10,000、無焦點 16,000。
3. **虛構查詢拿到 `high`**：實測的「星際量子記憶加速器」其實寫在第七輪交接文件（raw handoff）中。改為只命中 raw 時是 `low`，`high` 需要結構化欄位或路徑命中。
4. **知識頁 context 過大**：實測約 60,900／58,300 字元。
   - 修正：分成 `full`（空白頁或要求更新）與 `review`（只給涵蓋範圍後的新 Session 與變動的引用來源）兩種模式，預算 24,000。
   - 結果：實際資料降到 24,411／22,154 字元。
5. **C2 第 3 點沒有實作**：「更新知識頁那筆工作本身不要讓頁面變成有新資料」原本只能靠 Agent 事後手動回報。finalize 新增 `maintainedKnowledgePages`。
6. `docs/testing.md` 的最終數字沒有更新；`docs/agent-setup.md` 的工具數仍寫 31 個。

**複檢時看到、本輪要處理的**：

- **工具清單本身很大**：44 個工具的說明與 schema 約 68,000 字元，每個 Agent 對話都要載入，比任何一次查詢結果都大（見 A2）。
- **其他專案的 Agent 看不到 `work-intelligence` skill**：它只在本 repo 的 `.agents/skills/`，別的專案只拿得到約 2,500 字元的 server instructions（見 A1）。
- **自然語句的用詞對不上**：「新增 REST endpoint 的慣例」找不到拆分路由的 PR #141，因為記錄寫的是「路由」（見 B1）。
- **實測延遲不一致**：使用者端測到每次約 1.5 秒，在 MCP 內量到的是 6–80 ms。兩次使用測試都可能打到還沒重新啟動的舊 MCP 程序（B1 已有、B2 還沒生效）。使用者無從判斷 MCP 是不是最新版本（見 A3）。

## 階段 A：讓其他專案的 Agent 真的會用（最優先）

### A1. 把 Agent 使用說明隨 MCP 一起交付

**現況**：

- `work-intelligence` skill 只在本 repo。
- `docs/agent-setup.md` 要使用者手動執行 `codex mcp add`、`claude mcp add` 並手動設定 hook。
- 其他專案的 AGENTS.md／CLAUDE.md 沒有任何提示。

**要做的**：

1. **MCP 本身提供使用說明**：用 MCP prompt 或 resource 提供 skill 的完整內容，讓任何用戶端都能在需要時讀取。server instructions 保持精簡，並指向它。
2. **一個設定命令**：`pnpm setup:agents`，互動式執行。
   - 預設只顯示「會做什麼」：MCP 註冊、user 層級的 skill 複本、保存提醒 hook。確認後才寫入。
   - 寫入前先備份被修改的設定檔。可以重複執行（idempotent），也要提供 `--uninstall`。
   - Codex 與 Claude Code 的 user 層級 skill 位置、設定檔格式，請以官方文件為準，**不要猜**。某個用戶端沒有 user 層級 skill 時，就只註冊 MCP，並說明原因。
   - skill 複本帶版本標記。`pnpm run doctor` 要能指出複本過期或缺少。
3. **給其他專案的片段**：提供一段可以貼進其他專案 AGENTS.md／CLAUDE.md 的說明，內容是開工時呼叫 `work_get_context`、完成時保存工作記錄。放在 `docs/agent-setup.md`；`setup:agents` 最後也要印出來。
4. **測試**：用暫存的 HOME 目錄驗證安裝、重跑、解除安裝與備份。**不得碰使用者真正的設定。**

### A2. 工具清單瘦身

**現況**：44 個工具的說明＋schema 約 68,000 字元。最大的幾個：

| 工具                               | 說明＋schema（字元） |
| ---------------------------------- | -------------------: |
| `work_finalize_session`            |         3,919＋5,609 |
| `work_save_report_summary`         |         2,114＋2,679 |
| `work_update_session_work_summary` |         2,396＋2,340 |
| `work_recall`                      |           2,186＋665 |

**要做的**：

1. 在 `tests/mcp/` 加一個門檻，量測 `tools/list` 的總字元數。目標 **30,000 以內**；基線與結果寫進 `docs/testing.md`。
2. 說明只寫「什麼時候用、不會做什麼、重要限制」。長的格式規範（contract）改成需要時才讀：沿用 A1 的 prompt／resource，或放在寫入工具失敗時的錯誤回應中。**不能讓 Agent 在第一次寫入前就缺少必要規則**，請在 PR 說明取捨。
3. 可以合併很少用、而且流程固定的工具，例如 metadata backfill 的 6 個、報告整理的 6 個工具。合併時：
   - 不能失去任何能力；
   - 唯讀與寫入要分開，才能保留 `readOnlyHint`；
   - 工具說明、skill、`docs/mcp-tools.md`、E2E 與既有測試都要同步。
4. 檢索品質與回應大小門檻都要維持通過。

### A3. 偵測過期的 MCP 程序

1. MCP 啟動時記下自己的建置識別（版本加上建置時間或 dist 雜湊）。
2. 磁碟上的建置比執行中的新時，`work_get_project_status` 與 `work_get_context` 回傳明確提示：`server.restartRequired: true` 與一句「請重新連線 MCP」。
3. `pnpm run doctor` 與 Web「系統狀態」也顯示同一件事。
4. 測試：模擬 dist 在啟動後更新。

### A4. 第一次使用的引導（Web）

1. 總覽頁在「沒有記錄中專案」或「還沒有任何 Session」時，顯示步驟清單：
   - 加入專案 → 設為記錄中 → 連接 Agent → 第一筆工作記錄。
   - 每一步都顯示是否完成，未完成的附上下一步連結或命令（例如 `pnpm setup:agents`）。
2. 「系統狀態」新增 Agent 連線區塊，唯讀顯示：
   - MCP 是否已註冊（Codex／Claude Code）；
   - skill 複本是否最新；
   - hook 是否安裝；
   - MCP 是否需要重新連線（A3）。
3. 沿用 doctor 的檢查邏輯，只讀、不修改任何設定。
4. 照 `worklog-ui` 的元件與狀態顏色，補 E2E 與 axe。

## 階段 B：找得到答案

### B1. 自然語句與中英混用

1. 加入一份**固定的軟體用語對照表**（中英、同義詞），例如：
   - endpoint／API／路由／route；
   - 慣例／convention；
   - 效能／performance；
   - 測試／test；
   - 設定／config；
   - 遷移／migration。
2. 查詢時用對照表擴展查詢詞，擴展詞的權重要低於原詞。命中比例與 `confidence` 只依原詞計算，避免同義詞讓無關結果變成 `high`。
3. 對照表是原始碼中的固定資料：不呼叫外部服務，不用模型推測。
4. 用 `retrieval-quality.test.ts` 的合成案例重現：
   - 「新增 REST endpoint 的慣例」要找到只寫「路由」的記錄（前 3 名）；
   - 「repositoryUrl、commit 與編輯器」這類混合查詢，完成記錄要排在舊規劃片段前面；
   - 既有類別的 hit@5／MRR 不能退步。
5. 效能門檻維持通過。

### B2. 使用者在自己的資料上量測檢索品質

使用者請 Codex 做了兩次人工抽測，結果難以重現。請提供 `pnpm eval:recall <題目.json>`：

1. 題目檔格式：查詢、選用的 `projectRoot`／日期、預期的 Session 或 Knowledge id（可以多個）、是否預期「查不到」。
2. 以唯讀方式開啟資料庫，逐題呼叫與 MCP 相同的 recall／context 路徑。
3. 輸出：
   - hit@1／hit@5／MRR；
   - 每題的排名、`confidence` 是否符合預期；
   - 回應字元數與耗時；
   - 預期「查不到」卻回傳 `high` 的題目另外列出。
4. 結果只輸出到終端機或使用者指定的檔案，**不寫回資料庫、不上傳**。
5. 提供一份合成的範例題目檔，並在 CI 用它跑一次。
6. 這也是使用者執行私有 36 題評估的工具（見 E3 的驗收清單）。

## 階段 C：對日常工作有實際幫助

### C1. 未結項追蹤

多天的工作中，`workSummary.nextSteps` 散在各筆 Session，後續完成了也不會被標記，Agent 開工時看不出哪些還沒做。

1. 每筆 Session 的 nextSteps 都是一個「未結項」，狀態有未處理、已完成、不再需要。
2. **Agent**：
   - finalize 可以回報這次解決了哪些未結項（引用 id）；
   - `work_get_context` 只列出未處理的項目，附來源 Session；
   - 不新增刪除能力，狀態改變要留下稽核紀錄。
3. **Web**：工作歷程或總覽新增未結項清單，可以依專案篩選，也可以手動標記完成或不再需要。
4. 新資料表照 `worklog-backend` §4 處理，並通過 `project-data-coverage` 測試。
5. 新的讀取路徑要有效能門檻。
6. 既有資料升級時，把現有的 nextSteps 回填成「未處理」。**不要推測哪些已完成。**

### C2. 知識頁的維護提示

1. 頁面有「需要核對」，或「有新資料」累積到一定數量（在 PR 中說明門檻的依據）時，finalize 回應附一行提示，列出該檢查的頁面。
2. `work_get_context` 的 `pendingRequests.knowledgePages` 依同一規則排序。
3. 工作知識頁的「知識頁」分頁顯示最後檢查時間。

## 階段 D：工程收尾

### D1. 安全與相依性

1. 執行 `pnpm audit`，處理 high／critical 等級的弱點。無法升級的，在 PR 說明原因。
2. 新增 `SECURITY.md`：回報方式，以及本機優先、loopback-only、預設不讀取的資料邊界。
3. 確認 `LICENSE`（MIT）與 `package.json` 的 `license` 欄位一致。
4. 檢查依賴的授權沒有與 MIT 衝突的。

### D2. 文件總整理

1. README 以「第一次使用者」的角度重寫開頭：這是什麼、能做什麼、5 分鐘上手（`pnpm setup:agents`）。開發者資訊移到後段。
2. `docs/` 裡每份文件都和實際行為一致：
   - 工具數、上限、命令；
   - 已完成的輪次移到 `docs/status.md` 的歷史段落；
   - 只保留仍開放的項目。

## 階段 E：發行 1.0.0（最後階段）

### E1. 開機自動啟動

1. 提供 `pnpm service:install`、`pnpm service:uninstall`、`pnpm service:status`，平台做法如下：

   | 平台    | 做法                   |
   | ------- | ---------------------- |
   | macOS   | 使用者層級 LaunchAgent |
   | Windows | 登入時執行的工作排程   |
   | Linux   | `systemd --user`       |

2. **不需要管理員權限**：只在使用者層級安裝。
3. 安裝前先顯示將寫入的檔案與內容，確認後才寫入。
4. 服務以正式模式（`pnpm start`）啟動，並指定資料庫與備份路徑，以及日誌位置。
5. `pnpm run doctor` 與「系統狀態」顯示服務狀態。
6. 測試只在暫存目錄產生設定檔並比對內容，**CI 不實際安裝服務**。
7. 文件寫清楚每個平台的安裝、移除與排除問題步驟。

### E2. 發行 workflow 與 1.0.0

1. 新增 `docs/release.md`：版本規則、發行前檢查（健康檢查全部通過、CHANGELOG、升級說明）、如何打 tag。
2. GitHub Actions 發行 workflow，在推送 `v*` tag 時執行：
   - 跑完整檢查；
   - 以 CHANGELOG 對應段落建立 GitHub Release；
   - 附上原始碼封存檔。
   - workflow 只能由 tag 觸發，不能在一般 PR 上發行。
3. 版本號升到 `1.0.0`：
   - `package.json`、`/api/health`、MCP metadata 與 Web 側欄同步；
   - CHANGELOG 的 Unreleased 整理成 `[1.0.0]`；
   - 附上從任何舊版本升級的步驟（migration 會自動備份）。
4. **不要自己推 tag 或建立 Release**：準備好 PR，合併後由使用者決定何時打 tag。在最終交接中寫出要執行的命令。

### E3. 使用者實機驗收清單

新增 `docs/release-checklist.md`，列出 Agent 無法代做、需要使用者本人操作的驗收。每一項都要寫出步驟與預期結果：

- 原生資料夾選擇視窗：macOS、Windows、Linux。
- Windows：備份還原與匯入、Codex hook 載入、`pnpm service:install`。
- macOS Safari：主要頁面、圖表與時間軸。
- 私有 36 題檢索評估：用 B2 的 `pnpm eval:recall`，記錄 hit@5／MRR 與「查不到卻 high」的題數。
- 在另一個真實專案中，用 `pnpm setup:agents` 設定後，從開工到保存完整跑一次，確認沒有讀取本 repo 也能正確使用。

## 工作規則（重申）

- 繁體中文。
- 開工前讀對應的 skill（見「開始前必讀」）。
- 每完成一段就 finalize，每一筆都填 `startedAt`：取自對話紀錄，不要估計。
- 維護知識頁的工作，finalize 時帶 `maintainedKnowledgePages`。
- 每項開獨立 PR。**最新 commit 的四項 CI（Quality ubuntu／windows／macos 與 E2E）都是 success 才合併**。不要用 `gh pr merge --auto`：E2E 不是必要檢查，`--auto` 會在它跑完前就合併。合併用 merge commit，並刪除分支。
- 健康檢查逐步確認：build、test、typecheck、coverage、performance、retrieval-quality、response-size、E2E。
- 效能：先量測再優化。新的讀取路徑都要有基準情境與上限；工具清單與回應大小也要有上限。
- 不修改使用者的實際資料庫、Agent 設定或全域 hook。`setup:agents` 與 `service:install` 只在測試的暫存目錄中執行；真正的安裝由使用者自己執行。
- MCP 不新增刪除資料或變更檔案路徑的能力。
- 使用 pnpm，不使用 npm／npx。
- 每個階段都檢查 README 與 docs。
- PR 說明寫清楚設計取捨、沒做的部分與驗證方式。
- 結束時比照第七輪，寫一份複檢交接文件，包含：
  - PR、head／merge SHA、CI run、工作記錄 ID 對照；
  - A2 工具清單大小、B1 檢索品質的前後比較；
  - E2 要執行的 tag 命令。

## 下次複檢 Claude 會特別看

- A1：在沒有本 repo 的另一個專案中，Agent 能讀到使用說明；`setup:agents` 預設只顯示不寫入、寫入前備份、可以解除安裝；測試沒有碰到真正的 HOME。
- A2：`tools/list` 的大小有 CI 門檻且在 30,000 字元以內；合併工具沒有失去能力；寫入規則在第一次寫入前就拿得到。
- A3：dist 更新後，執行中的 MCP 會提示重新連線。
- B1：「endpoint／路由」的案例找得到；同義詞沒有讓無關結果變成 `high`；既有檢索品質沒有退步。
- B2：`eval:recall` 以唯讀方式開啟資料庫，結果不寫回。
- C1：舊資料的 nextSteps 回填為未處理，沒有推測完成；新資料表通過 `project-data-coverage`；狀態改變有稽核。
- E1：安裝前會顯示內容、不需要管理員權限、可以移除；CI 沒有真的安裝服務。
- E2：發行 workflow 只由 tag 觸發；版本 1.0.0 在所有顯示處一致；沒有自行推 tag。
- 文件與實際行為一致；README 開頭能讓第一次使用的人在 5 分鐘內上手。
