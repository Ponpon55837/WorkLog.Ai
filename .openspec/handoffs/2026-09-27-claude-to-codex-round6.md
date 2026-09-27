# Handoff：2026-09-27 Claude Code → Codex（第六輪：可信度、洞察與好用度）

第五輪把架構與品質門檻補齊了。第六輪的重點是三件事：

1. **讓使用者信得過資料**：自動遮蔽敏感資料，並分辨 Agent 自己做的決定。
2. **讓記錄變成洞察**：常駐知識頁、熱點、證據強度、時間軸。
3. **修掉使用者實際回報的不便**：換電腦匯入時要手打路徑。

這是長任務，請依階段順序進行，每一項開獨立 PR。完成後使用者會再請 Claude 複檢。

> **使用者決定（維持不變）**：授權為 MIT。開機自動啟動、發行（tag／release／發行 workflow）、版本號升到 1.0.0，以及實機驗證，都等所有功能完成後再處理，這一輪不要做。
>
> 下方多項功能參考了外部專案的做法（graphify、Whiteboard、Hindsight），**但不整合那些專案**：不加它們的依賴，也不匯入它們的資料。

## 開始前必讀

- **新 skill `worklog-backend`**（`.agents/skills/worklog-backend/SKILL.md`）：storage／server／MCP 的慣例與效能規則。本輪大多是後端工作，每一項開工前都要讀。
- **`worklog-web-code-style` 已更新**：query key 必須包含查詢讀取的所有參數；元件直接使用 store；過渡轉接層已刪除。
- **`tests/storage/project-data-coverage.test.ts`**：新增的資料表或欄位，只要沒有納入可攜式匯出（或沒有列為非專案資料並寫明理由），這個測試就會失敗。本輪新增的每一張表都會碰到它，請照 `worklog-backend` §4 的清單處理：匯出、匯入、永久刪除、搜尋索引。

## 第五輪複檢結果

**流程**：#87～#121 共 35 個 PR 都是 merge commit，最新 head 的 4 項 CI 全部成功。33 筆工作記錄中，31 筆的檔案數與 PR 一致；#96 與 #97 共用同一筆記錄，交接文件已標示。**這次每一筆都有 `startedAt`，做得好。**

**做得好**：

- 刪除備份的防護完整：檔名白名單、拒絕分隔符號與 symlink、`realpath` 確認仍在備份目錄內。
- 錯誤代碼、忙碌錯誤分類、優雅關閉都有測試。
- Pinia＋Pinia Colada 遷移後，E2E 仍然全綠；mutation 都宣告了失效範圍。
- `store.ts` 從 3,025 行降到 1,361 行。

**Claude 已修正（PR #122）**：

1. **搜尋很慢**：`work_search`（工作歷程搜尋）在 5,000 筆 Session 時，p50 約 2 秒。
   - 原因：全文搜尋 JOIN `search_chunks` 時，因為有 `doc_type IN (…)` 可以走索引，SQLite 選了 `search_chunks` 當外層迴圈，再對每一筆 chunk 重跑一次全文搜尋。
   - 修正：改用 `CROSS JOIN` 固定讓 FTS 當外層，p50 降到 13 ms（約 150 倍），資料列與分數完全相同。
2. **列出 Knowledge 很慢**：20 筆 Knowledge 的過時判斷約 790 ms。
   - 原因：每一筆各自查詢 Session，每個檔案重新正規化、每次都重新編譯 glob。
   - 修正：改成每個專案查一次、路徑正規化一次、glob 編譯後快取，再用二分搜尋找每筆的起點，降到約 50 ms。
3. **報告趨勢分桶**原本是 O(天數 × Session)，改為用 Map 一次分組。
4. **效能門檻**：搜尋上限從 10,000 ms 收緊到 500 ms，並新增 Knowledge 過時判斷的情境。
5. **資料遺失**：可攜式匯出漏了 `sessions.changed_files_confirmed`，匯入到另一台電腦後，「已確認沒有改動檔案」的標記會消失。現在會匯出這個欄位，舊的匯出檔仍可匯入（預設 0）。這是新的覆蓋測試抓到的。
6. **附加任務 F3 的收尾**：刪除仍留著的過渡轉接層（`useProjects`、`useDashboard`、`useSessionDetail`）與已無人使用的 `useSessions`、`runKeyed`。

**第五輪留下、這一輪要處理的**（階段 E）：多個 query 使用固定 key、`server.ts` 路由集中在單一函式、部分 composable 仍有模組層級的表單狀態。

## 階段 A：使用者回報的問題（最優先）

### A1. 換電腦時，不再要求使用者輸入路徑

**使用者回報**：「依專案匯出與匯入」要使用者自己填「舊電腦路徑前綴」和「新電腦路徑前綴」。使用者在一台電腦匯出、丟到雲端、在另一台電腦下載，根本不會記得原本的路徑。

**現況**：

- `BackupSection.vue` 在「預覽匯入」**之前**就要求輸入兩個前綴，而且只能填一組。
- 原始路徑其實就在匯出檔裡（`projects.root_path`）。
- API 的 `remap` 已經支援多組（最多 20 組），所以「一個專案一組」在後端可行。
- 更新專案時**不能改路徑**（`updateProjectInputSchema` 只有 `name`、`status`），所以用 `db:restore` 還原或匯入後才發現路徑不對時，使用者在 UI 上無法補救。

**要做的**：

1. **選擇檔案後立即預覽，不先問路徑。** 預覽的每個專案顯示：
   - 名稱、匯出檔中的原始路徑。
   - 在這台電腦上的狀態：
     - 「找到資料夾」：路徑存在，而且是資料夾。
     - 「已對應既有專案」：依現有的 existing／conflict 判斷。
     - 「這台電腦找不到這個資料夾」。
   - server 只可以用 `stat` 檢查路徑是否存在、是不是資料夾，**不讀取資料夾內容**。文件要說明這一點。
2. **逐一選擇新位置。** 找不到資料夾的專案旁邊有「選擇新位置」按鈕，使用現有的原生資料夾選擇視窗（`POST /api/system/pick-folder`），選好後就為該專案產生一組 `from = 原始路徑`、`to = 選取的資料夾`，並立即重新預覽。
3. **一次套用到其他專案。** 使用者為第一個專案選好新位置後，如果其他找不到的專案在新的上層資料夾下有**同名資料夾**，提示「其他 N 個專案也在這個資料夾下找到，要一起套用嗎？」。確認後才加入 remap，不要自動套用。
4. **可以不指定。** 使用者可以保留原始路徑直接匯入（專案會照現有規則以暫停狀態匯入），之後再用第 5 點修正。
5. **重新指定專案位置（新功能）。** 專案清單中，路徑在這台電腦上不存在的專案標示「找不到資料夾」，並提供「重新指定位置」：
   - 用資料夾選擇視窗選新位置。
   - 同一個交易內更新 `projects.root_path`，並用既有的 `remapPathPrefix` 規則轉換該專案 handoff 的 `source_path`。
   - 新路徑必須通過 `project-policy` 的正規化，而且不能和其他專案的根目錄相同或互相包含。
   - 記錄中（tracked）的專案改路徑，等於擴大 Agent 可讀取的範圍，所以要跳出與「切換為記錄中」相同等級的確認對話框。
   - 留下不含內容的稽核紀錄（時間、專案 id、舊路徑與新路徑的雜湊或是否變更）。
   - REST：`PATCH /api/projects/:id/location`，JSON body 帶新路徑。MCP **不提供**這個能力。
6. **CLI 同步。** `pnpm db:import` 在互動終端中，對找不到的專案逐一詢問新位置（可以直接按 Enter 略過）；`--remap-root` 保留給腳本使用。
7. **移除 UI 上的「舊電腦路徑前綴」「新電腦路徑前綴」兩個欄位。** 進階使用者仍可用 CLI 的 `--remap-root`。

**驗收**：

- E2E：匯入一個原始路徑不存在的檔案 → 預覽顯示原始路徑與「找不到」 → 選擇新位置（E2E 用可注入的假資料夾選擇器）→ 預覽更新 → 匯入後專案路徑正確。
- E2E：專案清單的「重新指定位置」。
- storage／server 測試：路徑重疊被拒絕、handoff 路徑一起轉換、tracked 專案需要確認、稽核紀錄不含內容。
- 更新使用手冊的「換電腦」章節與疑難排解。

### A2. 保存提醒 hook 的誤報

**現況**：

- Claude 版（`apps/mcp/src/finalize-reminder.ts`）只看工具名稱是否在 `EDIT_TOOLS`（Edit／Write／MultiEdit／NotebookEdit），不看改了哪個檔案。改到專案外的檔案（例如 `~/.claude/` 的記憶檔）也會觸發提醒。
- Codex 版（`codex-finalize-reminder.ts`）只要呼叫 `apply_patch` 就標記。

**要做的**：

- Claude：從 transcript 中讀出工具輸入的 `file_path`（NotebookEdit 是 `notebook_path`），只有落在「記錄中」專案根目錄內的檔案才算改動。
- Codex：解析 `apply_patch` 的 patch 標頭（`*** Add File:`、`*** Update File:`、`*** Delete File:`、`*** Move to:`），路徑相對於 hook 的 `cwd`，只有專案內的檔案才標記。
- 讀不到或解析失敗時，沿用現在的放行行為。
- 補測試：改專案內的檔案會提醒、只改專案外的檔案不會提醒、兩者都有時會提醒。

## 階段 B：敏感資料防護

### B1. 保存前自動遮蔽密鑰

**為什麼優先**：Agent 保存的 handoff 原文最長 20 萬字，摘要、事件、Knowledge、報告整理也都是 Agent 寫的，很可能夾帶 token、API key、`.env` 內容或私鑰。這些資料會進入 SQLite、全文搜尋索引、每日備份與匯出檔，之後還會被 `work_recall` 回傳給其他 Agent。

**要做的**：

1. 新模組 `packages/storage/src/secret-redaction.ts`，固定規則、不用 LLM：
   - GitHub token（`ghp_`、`gho_`、`ghu_`、`ghs_`、`ghr_`、`github_pat_`）。
   - OpenAI（`sk-…`）、Anthropic（`sk-ant-…`）、Slack（`xox[abprs]-…`）、Google API key（`AIza…`）。
   - AWS access key（`AKIA`／`ASIA` 開頭）與 `aws_secret_access_key = …`。
   - PEM 私鑰區塊（`-----BEGIN … PRIVATE KEY-----` 到 `END`）。
   - JWT（三段 base64url，以 `eyJ` 開頭）。
   - 連線字串中的密碼（`scheme://user:password@host`，只遮蔽密碼部分）。
   - 常見的 `API_KEY=`、`SECRET=`、`TOKEN=`、`PASSWORD=` 賦值（值至少 8 個字元，大小寫不拘；只遮蔽值）。
   - 遮蔽後的格式：`[REDACTED:github_token]` 這類的類型標籤，**不保留原值的任何片段**。
2. 套用在所有會寫入文字的入口：
   - finalize 的 summary、workSummary、events、handoffContent、evidence summary。
   - 摘要與 workSummary 修正、handoff 匯入、Knowledge 記錄與修改、Knowledge 候選、報告整理結果。
   - 可攜式 JSON 匯入。
3. 回報：
   - finalize 與其他寫入工具的結果加上 `redactions: { total, byKind }`（只有數量，不含內容），MCP 工具的說明文字要提到這件事。
   - Session 記錄遮蔽數量（新欄位，要照 `worklog-backend` §4 納入匯出）。
   - Web 的 Session 面板顯示「已遮蔽 N 處敏感資訊」。
4. **既有資料**：`pnpm db:redact`。
   - 預設 `--dry-run`：只顯示各類型的數量與受影響的 Session 數，不顯示內容。
   - 加上 `--apply` 才會寫入：先建立備份，再在單一交易內改寫，並把受影響的文件標為 `search_dirty`，讓搜尋索引重建。
   - 提醒使用者：舊的備份與匯出檔仍含原文，需要自行刪除（可以連到備份管理）。
   - 和 `db:maintain` 一樣，需要獨佔資料庫。
5. **誤判控制**：
   - 規則要有邊界（例如 GitHub token 的長度與字元集），避免把一般的 hash、UUID、commit SHA 當成密鑰。
   - 測試要包含「不應該被遮蔽」的案例：40 字元的 commit SHA、UUID、檔案路徑、一般英文句子。

**測試注意**：

- 測試用的假 token **必須在執行期組合**（例如 `"ghp_" + "A".repeat(36)`），不要把完整的 token 字串寫進原始碼，否則會被 GitHub 的 secret scanning 或 push protection 擋下。
- 每一種規則都要有「會遮蔽」與「不會遮蔽」的案例；另外要測：搜尋索引中查不到原值、匯出檔中沒有原值。

**文件**：`SECURITY.md` 新增「敏感資料遮蔽」一節：涵蓋的類型、限制（不保證找出所有密鑰）、既有資料的處理方式、備份仍含原文。

## 階段 E1：先把 query key 參數化（排在 C、D 之前）

第六輪會新增好幾個頁面與 query，應該直接建立在正確的寫法上，所以這一項排在 C、D 之前。

**現況**：`stores/sessions.ts`（`sessions.list`）、`stores/reports.ts`（`report`、`evidence`、`sessions`、`synthesis`）、`stores/knowledge.ts`（`knowledge.list`）等使用固定 key，在 `query` 函式裡讀取篩選條件，再手動呼叫 `refetch(true)`。`reports.ts` 甚至把 `scopeKey` 放進回傳資料裡，來判斷結果是不是舊範圍的。

這樣寫功能是正確的（Pinia Colada 的 `fetch` 會中止舊請求），但：換回先前的篩選條件時要重新請求；換條件的瞬間會短暫顯示上一個條件的資料；程式裡有不必要的手動 refetch 與 `scopeKey` 變通。

**要做的**：

- 移除 `composables/useAppRefresh.ts` 的 `useActiveViewQuery`：它是 F3 之前的過渡橋接，把舊的載入函式包成回傳 `true` 的 query，目前只剩 `KnowledgeView.vue` 使用。改成真正的 Knowledge query。
- 每個 query 的 key 改成函式，包含它讀取的所有參數：`key: () => [...queryKeys.sessions.list, { q, projectId, voided, from, to, page, pageSize }]`。
- 移除對應的手動 `refetch()` 與 `scopeKey` 變通；需要「保留上一頁資料直到新資料到達」的地方用 `placeholderData`。
- mutation 的失效改用前綴（不加 `exact`），讓同一前綴下的所有參數組合都失效。
- 確認 SSE 觸發的 `invalidateActiveQueries()` 只重新載入目前使用中的 query。
- E2E 維持全綠，**不刪改斷言**。若有測試依賴「不會發出請求」的時機，改成等待畫面結果。
- PR 說明列出每個 store 改了哪些 query。

## 階段 C：Agent 的可信度與知識

### C1. 決策來源與待確認的自主決策（參考 Whiteboard 的 Decision log）

**目標**：讓使用者知道 Agent 自己做了哪些決定，並且可以確認或否決。

**現況**：`workSummary.decisions` 是字串陣列，沒有來源。

**設計**：

1. **輸入**：`workSummary.decisions` 的每一項可以是字串（相容舊格式），也可以是 `{ text, origin }`，其中 `origin` 是 `"user_requested"`（使用者要求的）或 `"agent_autonomous"`（Agent 自己決定的）。
   - `workSummary` 在資料庫中仍存成字串陣列，維持相容性。
   - 來源另外存在新表 `session_decisions`：id、session_id、project_id、position、text、origin（`user_requested`／`agent_autonomous`／`unspecified`）、review_status（`pending`／`confirmed`／`rejected`／`promoted`）、reviewed_at、knowledge_id。
   - 只有 `agent_autonomous` 的決策會進入待確認清單。
   - 修改 workSummary 時（`work_update_session_work_summary`），同步更新這張表：文字相同的項目保留原本的審查狀態。
2. **合約**：更新 `workRecordContract` 與 `work-intelligence` skill，說明 Agent **只有在來源明確時**才標示 origin：使用者在對話中明確要求的，才是 `user_requested`；Agent 自行選擇的方案或取捨是 `agent_autonomous`；不確定就用字串（`unspecified`）。
3. **Web**：
   - 工作知識頁（或總覽的待處理事項）新增「待確認的 Agent 決策」，可以確認、否決，或「升級為 Knowledge」（開啟 Knowledge 編輯器並預填內容，來源 Session 自動帶入）。
   - Session 面板的「決策」段落標示每一項的來源。
4. **報告**：週報、月報新增「本期 Agent 自主決策」段落：列出數量與尚待確認的項目，每項連回來源 Session。
5. **MCP**：`work_get_context` 的 `pendingRequests` 附上待確認決策的**數量**（不回傳全文，避免 context 過大）。確認與否決只能在 Web 進行。

**驗收**：storage、server、MCP、E2E 測試；匯出、匯入與刪除涵蓋新表；更新 `docs/work-record-and-report-format.md`。

### C2. 常駐知識頁（參考 Hindsight 的 Mental models）

**目標**：Agent 開工時直接拿到整理好的專案知識，不必每次重新檢索。這也解決先前檢索評估的發現：`work_get_context` 回傳過大、內容與任務無關。

**設計**：

1. **新表 `knowledge_pages`**：id、project_id、slug、title、question、body（Markdown，上限約 8,000 字）、source_session_ids_json、status（`fresh`／`needs_update`）、updated_at、version。另外用 `knowledge_page_versions` 保留歷史版本。
2. **預設頁面**：每個專案可以建立以下三頁，也可以自訂問題：
   - 架構與慣例
   - 進行中的工作與未結項
   - 常見陷阱
3. **更新流程**比照報告整理：
   - `work_request_knowledge_page_update` 建立請求。
   - `work_get_knowledge_page_context` 取得來源 Session（有字數上限，超過時標示「資料不完整」）。
   - `work_save_knowledge_page` 存入結果，每段都必須引用 `sourceSessionIds`，資料不足時寫「資料不足」。
   - 契約文字放在 `contracts.ts`。
4. **過時標示**：頁面最後一次來源之後，同一專案有新的 Session 時，標為 `needs_update`，並在 `work_get_context` 的 `pendingRequests` 列出。
5. **`work_get_context`**：優先回傳該專案的知識頁（每頁有字數上限，總量也有上限），並標示是否需要更新。
6. **Web**：工作知識頁新增「知識頁」分頁，可以查看、請 Agent 更新、查看歷史版本與來源 Session。編輯只能透過 Agent 重新整理，或由使用者在 Web 直接修改（直接修改要留下版本紀錄）。
7. **效能**：`work_get_context` 仍要通過效能門檻；在基準測試加入含知識頁的情境。

### C3. 知識的證據強度（參考 Hindsight 的 Observations）

**現況**：`knowledge` 只記錄最後一次確認（`lastConfirmedAt`）和最新一次推翻（`review`），沒有累計次數；逐次的變化只存在 `knowledge_audit` 中。

**設計**：

- 新表 `knowledge_feedback`：id、knowledge_id、project_id、session_id、kind（`applied`／`contradicted`／`manual_confirm`）、occurred_at。
- `applyKnowledgeFeedback` 與手動確認時寫入。
- migration 從 `knowledge_audit` 回填可以確定的歷史紀錄；無法判斷來源的就不要回填，並在 PR 說明實際回填了多少筆。
- 每筆 Knowledge 顯示「被 N 次 Session 確認、M 次推翻」，並可以展開來源 Session 清單。
- 檢索排序納入證據強度：確認次數多的略微加分，最近被推翻的降分。**必須通過檢索品質門檻**，並新增合成測試案例。
- 計算採批次處理，比照 `withKnowledgeTrustMany`：不可以逐筆查詢。

### C4. 依時間範圍檢索

- `work_recall` 與 `work_search` 新增選填的 `from`、`to`（本機日曆日期，和 `work_list_sessions` 一致）。
- 在 SQL 層依 `doc_date` 篩選（`search_chunks` 已有 `doc_date` 欄位），不要取回全部結果後再過濾。
- 更新工具說明，讓 Agent 在使用者問「上週」「六月」時帶入日期。
- 補合成檢索測試與效能情境。

## 階段 D：洞察與圖像呈現

以下都遵守：計算放在 storage 層、結果固定可重現、不用 LLM；只處理記錄中的專案；每個新的讀取路徑都要有效能情境與上限。

### D1. 熱點檔案與反覆出問題的區域

- storage：`getHotspots({ projectId?, from?, to?, limit })`，回傳每個檔案（正規化後的路徑）：
  - 修改過它的 Session 數。
  - 驗證失敗與未執行的比例。
  - 最後修改時間、最近 5 筆 Session。
- 排除已作廢的 Session，也排除被判定為 changed files 異常的 Session（沿用 recall 的降權規則）。
- 可以選擇依目錄彙總。
- REST：`GET /api/insights/hotspots`。
- `work_get_context`：Agent 傳入 `paths` 時，如果某個檔案是熱點，回傳簡短提醒（例如：這個檔案在過去 30 天被 12 筆 Session 修改，其中 3 筆驗證失敗）。
- Web：
  - 報告的「風險」段落加入本期熱點。
  - 工作圖譜頁新增「熱點」檢視：列表，或依目錄結構畫成 treemap，面積代表修改次數、顏色代表失敗比例。顏色要有文字與圖例，不能只靠顏色表達。
- 效能：5,000 筆 Session 的情境要在門檻內，必要時用 SQL 彙總，不要在 JS 逐筆處理。

### D2. 圖譜的邊來源標示與路徑說明（參考 graphify）

- `GraphEdge` 新增 `provenance: "recorded" | "derived"` 與選填的 `reason`。
  - 現有的邊（`contains`、`changed_file`、`has_knowledge`、`has_evidence`、`session_link`）都是 `recorded`。
  - 新的推導邊 `co_changed`：兩個檔案在至少 N 筆 Session 中一起被修改（N 可以調整，預設 3），`reason` 寫出次數。
  - 推導邊預設隱藏，可以在 UI 開啟。
- UI：記錄的邊用實線，推導的邊用虛線，並提供圖例；點選推導邊時顯示推導理由。
- **路徑說明**：
  - `GET /api/graph/path?from=&to=` 在限定的節點數內，用 BFS 找最短路徑，回傳每一段的邊與理由。
  - UI：在節點面板選「找出與…的關聯」，高亮路徑並逐段說明。
  - MCP：`work_get_graph` 新增選填的 `pathFrom`／`pathTo`，或新增唯讀工具，由你評估並在 PR 說明取捨。

### D3. 時間軸

- storage：`getTimeline({ projectId?, from, to })`，回傳：
  - Session 的 `startedAt`～`completedAt`（沒有 `startedAt` 的以完成時間畫成一個點）。
  - Knowledge 的建立、被推翻、被取代時間（從 `knowledge_audit` 與 C3 的回饋表取得）。
  - Session 之間的關聯。
- Web：工作圖譜頁新增「時間軸」模式：
  - 依專案分泳道，Session 畫成長條，關聯畫成弧線，Knowledge 事件畫成標記。
  - 支援縮放時間範圍，大量資料時要虛擬化，只畫可見範圍。
  - 手機寬度改為依日期分組的清單。
  - 點選長條開啟 Session 面板。
- 無障礙：提供同樣資訊的表格或清單檢視，並納入 axe 檢查。

### D4. 從記錄跳到程式碼（參考 Whiteboard）

- 專案新增選填的 `repositoryUrl`（使用者在 UI 輸入，只接受 `https://`，這是新欄位，要納入匯出）。
- Session 的 changed files 旁加上「在編輯器開啟」：
  - 使用者可以在 Web 的設定中選擇編輯器協定（VS Code `vscode://file/…`、Cursor `cursor://file/…`、不使用）。這是個人偏好，存在瀏覽器本機即可。
  - 只為記錄中的專案產生連結；路徑由專案根目錄與相對路徑組合，並經過正規化，不能跳出專案根目錄。
- Session 有 `commitSha` 而且專案有 `repositoryUrl` 時，顯示連到該 commit 的連結。
- 連結一律使用 `rel="noopener noreferrer"`，並附測試。

### D5. Agent 附上的圖表（參考 Whiteboard）

- 新表 `session_diagrams`：id、session_id、project_id、title、kind（先只支援 `mermaid`）、source（上限 20,000 字）、created_at、voided_at。
- 新 MCP 工具 `work_attach_diagram`（`ADDITIVE_IDEMPOTENT`，帶 `idempotencyKey`）；finalize 也可以選擇性附上。內容要經過 B1 的遮蔽。
- Web：在 Session 面板渲染。
  - **不能放寬主頁的 CSP**。先確認 Mermaid 在目前 CSP 下能否運作（它可能會插入 `<style>`，而目前的 CSP 是 `style-src-elem 'self'`）。
  - 如果不能，改在 `sandbox` iframe 中以 `srcdoc` 渲染，iframe 內另設嚴格的 CSP，並用 `securityLevel: "strict"`。
  - Mermaid 只在需要時才延遲載入，並在 PR 說明打包大小的變化。
  - 渲染失敗時顯示原始碼。
- 圖表可以作廢（比照 Evidence），不能刪除。
- 匯出、匯入與專案刪除都要涵蓋新表（守門測試會檢查）。

## 階段 E：工程整理（接在 D 之後）

### E2. 拆分 `server.ts` 的路由

- 目前約 1,400 行，59 條路由集中在同一個函式的 if 串中。
- 改成路由表：`apps/server/src/routes/<domain>.ts` 各自匯出 `{ method, pattern, handler }`；`server.ts` 只保留共用流程：Host／Origin 檢查、CORS、body 解析、錯誤處理、靜態檔。
- 行為完全不變：現有 server 測試與 E2E 必須原樣通過；新增一個測試，確保每條路由的方法與路徑都有註冊，而且沒有重複。
- 目標：`server.ts` 400 行以下，每個路由檔 300 行以下。

### E3. 清掉剩下的模組層級狀態

- `composables/useKnowledge.ts` 等仍在模組頂層放表單與對話框狀態（例如 `knowledgeEditor`、`knowledgeEditorForm`）。依 skill 移到擁有互動的元件，或移進 store 並提供 `$reset`。
- `useApiRequest` 的 `beginRequest`／`isCurrentRequest`／`finishRequest` 在正式程式碼中已無人使用（只剩測試）；確認後移除，連同測試輔助一起調整。

## 工作規則（重申）

- 繁體中文。
- 開工前讀對應的 skill：後端讀 `worklog-backend`；前端讀 `worklog-ui`＋`worklog-web-code-style`；Agent 工具的使用方式讀 `work-intelligence`。
- 每完成一段就 finalize，每一筆都填 `startedAt`。
- 每項開獨立 PR。CI 對應最新 commit 且全綠才合併；用 merge commit 合併並刪除分支。
- 健康檢查逐步確認：build、test、typecheck、coverage、效能、檢索品質、E2E。
- 效能：先量測再優化；新的讀取路徑都要有基準情境與上限。
- 新資料表或欄位：照 `worklog-backend` §4 納入匯出、匯入、刪除與搜尋索引。
- 不修改使用者的實際資料庫、Agent 設定或全域 hook；暫緩項目維持不做。
- MCP 不提供任何刪除或改路徑的能力。
- 使用 pnpm，不使用 npm／npx。
- PR 說明寫清楚設計取捨、沒做的部分與驗證方式。
- 結束時比照第五輪，寫一份複檢交接文件（PR、head／merge SHA、CI run、工作記錄 ID 對照）。

## 暫緩（功能完成後再做）

- 開機自動啟動（服務安裝）。
- 發行：`docs/release.md`、發行 workflow、tag、release，以及版本號升到 1.0.0。
- 實機驗證：原生資料夾選擇視窗（macOS、Windows、Linux）、Windows 的備份還原與匯入、Windows Codex 的 hook 載入、macOS Safari 實機、私有的 36 題檢索評估。

## 下次複檢 Claude 會特別看

- A1：使用者完全不需要輸入路徑就能完成換電腦匯入；重新指定位置有路徑安全檢查、tracked 專案需要確認、handoff 路徑一起轉換。
- B1：所有寫入入口都經過遮蔽；搜尋索引與匯出中找不到原值；沒有把 commit SHA、UUID 誤判為密鑰；原始碼裡沒有完整的假 token。
- 新資料表都通過 `project-data-coverage` 測試，而且刪除專案時會清乾淨。
- E1：query key 包含所有參數，沒有殘留的手動 refetch 與 `scopeKey` 變通。
- 新的讀取路徑都有效能門檻；檢索排序的改動通過檢索品質門檻。
- Mermaid 沒有放寬主頁的 CSP。
- 文件與實際行為一致。
