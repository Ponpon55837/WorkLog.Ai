# 專案現況與未結項

本頁先列目前仍開放或暫緩的工作；已完成階段移到下方歷史段落。實作細節與逐項複檢結果另見 PR、CHANGELOG 與交接文件。

> 回到 [README](../README.md)

- 最後更新：2026-09-30

## 第九輪目前開放

依[第九輪交接文件](../.openspec/handoffs/2026-09-30-claude-to-codex-round9.md)的順序進行，每項開獨立 PR。

| 階段 | 狀態 | 項目 |
| --- | --- | --- |
| A1 | 待開始 | 區分「必須重新連線」（schema 或 Agent 契約改變）與「有新版可用」（只改實作），後者不中斷記錄 |
| A2 | 待開始 | 清理過期的 MCP lease 檔 |
| A3 | 待開始 | 依對話紀錄補存第八輪缺漏的工作記錄；沒有依據的標為資料不足 |
| B1 | 待開始 | Web 未結項批次處理、日期篩選與復原 |
| B2 | 待開始 | 收尾時列出相關未結項，finalize 可標記被取代的項目 |
| B3 | 待開始 | Agent 對既有未結項提出附證據的整理建議，由使用者在 Web 審核 |
| C1 | 待開始 | 文件與狀態頁 |

## 第八輪目前開放

依[第八輪交接文件](../.openspec/handoffs/2026-09-28-claude-to-codex-round8.md)的順序進行；E1、E2、E3 保持最後。需要實體環境的項目列為使用者驗收，不由自動化測試代替。

| 階段 | 狀態 | 項目 |
| --- | --- | --- |
| D2 | 已完成 | README 新手入門、文件行為盤點與狀態頁歷史整理（PR #173） |
| E1 | 已完成 | 使用者層級登入自動啟動：macOS LaunchAgent、Windows 登入工作排程、Linux `systemd --user`（PR #174，merge `d6e768c`） |
| E2 | 已完成 | Tag 觸發的發行 workflow、版本 `1.0.0`、發行步驟與升級說明（PR #175，merge `6a01a9b`）；是否打 tag 由使用者決定 |
| E3 | 待使用者實機驗收 | 驗收程序已列於[發行實機驗收清單](release-checklist.md)；原生資料夾選擇、Windows 備份／hook／服務、macOS Safari、私有檢索題及另一個真實專案流程尚未驗證 |

## 其他暫緩工作

| 項目 | 狀態 | 再次評估條件 |
| --- | --- | --- |
| TypeSafe Adapter（Insight Provider Phase 2） | 等待外部契約 | 產品方定稿 SDK 或 HTTP endpoint、credential／egress 規則、request／response／error schema，以及 timeout／retry／circuit-breaker 契約前不新增依賴或網路呼叫 |
| Async path resolver | 刻意延後 | 只有在提高 metadata 上限、加入批次 ingest，或實測到 server／UI 阻塞時才重新量測並評估 |
| Graph 總數計算 | 觀察中 | 目前 5,000 筆合成資料約 53 ms；出現可重現的效能問題時再評估 |

## 第八輪已完成

| 階段 | 狀態 |
| --- | --- |
| A1 Agent 設定與 onboarding | PR #160 已合併 |
| A2 MCP tools/list 瘦身與 operation contract resources | PR #161、#162 已合併 |
| A3 MCP runtime 過期偵測 | PR #163 已合併 |
| A4 第一次使用引導與 Agent 連線狀態 | PR #164 已合併 |
| B1 固定中英軟體詞彙檢索 | PR #165 已合併 |
| B2 私有資料的唯讀 recall/context evaluator | PR #166 已合併 |
| C1 未結項追蹤 | PR #170 已合併；已作廢 Session 不可更新 workSummary，context／digest 僅顯示 pending 項目，MCP 清單以完整序列化 JSON 限制 30,000 字元 |
| C2 知識頁維護提示 | PR #171 已合併；來源需核對或累積 3 筆新 Session 時提示 Agent 評估 |
| D1 安全、相依性與 setup 等效判斷 | PR #172 已合併（merge `7422beb`）；最新 head 四項 CI 全綠 |
| D2 文件總整理 | PR #173 已合併（merge `f13123f`）；README 與文件已依第八輪實際狀態更新 |

第八輪的後續修正也已合併：PR #167–#169。PR #172 包含 #169 複檢留下的 MCP／hook 有效命令判斷修正。

## 過往輪次（已完成）

## 第七輪複檢（Claude，2026-09-28）

PR #147–#156 的 head、merge SHA、CI run（四項皆 success）與 Work Intelligence Session 對照都與複檢交接一致。以實際資料的唯讀備份重跑使用測試後，修正下列問題：

- `work_get_context` 的省略清單佔掉約三分之一預算（實際資料 3,978／11,902 字元），還逐筆列出已在其他區出現的 id，使相關 Session 被預算擠掉。改為只計數重複、每區最多列 5 個預算省略 id；關鍵旗標仍完整保留，並改為先縮短摘要再丟相關項目。
- 所有 MCP 工具結果改為緊湊 JSON；context 上限改以緊湊 JSON 計算（有焦點 10,000、無焦點 16,000）。
- 查詢詞只出現在 raw handoff（例如交接文件引用了測試用的虛構詞）時，`confidence` 由 `high` 改為 `low`。實測中的「星際量子記憶加速器」確實出現在第七輪交接文件中，並非 B1 失效。
- `docs/testing.md` 的回應大小改為一張「第七輪開始前／目前／上限」對照表。
- 知識頁 context 每次都給最近 60 筆 Session（實際資料約 6 萬字元）。改為兩種模式：空白頁或要求更新時整頁改寫；已寫過的頁面只給涵蓋範圍後的新 Session 與有變動的引用來源，預算 24,000 字。實際資料的兩頁降到 24,411／22,154 字元。
- C2「更新知識頁那筆工作本身不要讓頁面變成有新資料」原本沒有實作，只能靠 Agent 事後手動回報已檢查。finalize 新增 `maintainedKnowledgePages`：這筆 Session 是頁面涵蓋範圍後的第一筆時，自動視為已檢查；前面還有其他未檢查的 Session 時不移動，避免蓋掉它們。

## 第七輪：Agent 脈絡的用量與準確度（已完成）

原始交接文件：[`.openspec/handoffs/2026-09-28-claude-to-codex-round7.md`](../.openspec/handoffs/2026-09-28-claude-to-codex-round7.md)；複檢交接文件：[`.openspec/handoffs/2026-09-28-codex-round7-review.md`](../.openspec/handoffs/2026-09-28-codex-round7-review.md)。依據是使用者請 Codex 以實際資料做的兩次使用測試。A1–D2 各階段均各自開 PR，四項 CI 成功後以 merge commit 合併；詳見複檢交接文件的 SHA／CI／工作記錄對照表。

| 階段 | 項目 |
| --- | --- |
| A. 回應用量 | A1 合成資料基線與暫行 CI 上限（PR #147）；A2 `work_get_context` 跨區去重、整份預算、任務優先（PR #148）；A3 `work_recall`／`work_search` 精簡結果（PR #149） |
| B. 檢索準確度 | B1 查不到時回傳 `confidence: "none"`（PR #150）；B2 重複的規劃片段只算一次、已完成的工作優先（PR #151） |
| C. 知識頁更新判斷 | C1 已引用來源被更正、作廢或還原時標示需要核對（PR #152）；C2 新 Session 只提示「有新資料」，可回報已檢查（PR #153） |
| D. 其他 | D1 跨專案情境的測試（PR #154）；D2 Mermaid 在嚴格 CSP 下不再產生 console 警告（PR #155） |

### D1 跨專案檢索隔離

- PR #154 加入 storage regression test，使用兩個 tracked 專案與一個先寫入 Session、再暫停的專案；確認 scoped `work_get_context`／`work_recall` 只回傳指定專案、unscoped 結果標示專案名稱與 id，paused 專案內容完全不出現在回應。

### D2 Mermaid 嚴格 CSP console 警告

- 根因是 Mermaid 11 的 `render()` 將動態 `<style>` 插入 SVG；主頁的 `style-src-elem 'self'` 拒絕 inline style，雖然之後已抽出 CSS，瀏覽器仍會記錄 CSP 錯誤。
- 每次繪圖使用獨立且連接至文件的暫存 render surface，在 Mermaid 將 `<style>` 插入 SVG 前收集 CSS 並略過該節點；樣式仍由圖表 Shadow DOM 的 Constructable Stylesheet 套用。主頁 CSP 不變。
- Mermaid E2E 保留 `style-src-elem 'self'` 檢查，並斷言整個繪圖、原始碼 fallback 與作廢流程沒有 CSP console 錯誤。

- PR #155 已合併；A1 基準與本輪最終回應大小、每階段 PR／SHA／CI／Work Intelligence Session 對照及複檢重點見第七輪複檢交接文件。

## 第六輪：可信度、洞察與好用度（已完成）

交接文件：[`.openspec/handoffs/2026-09-27-claude-to-codex-round6.md`](../.openspec/handoffs/2026-09-27-claude-to-codex-round6.md)。全部項目已合併：A1–B1、E1、C1 由 Codex 完成；C2–C4、D1–D5、E2、E3 由 Claude 接手完成（PR #133–#142），每項各自一個 PR，CI 全綠後以 merge commit 合併。開機自動啟動、發行、版本升到 1.0.0 與實機驗證仍維持暫緩。

| 階段 | 項目 |
| --- | --- |
| A. 使用者回報 | A1 換電腦匯入時不再要求輸入路徑（預覽顯示原始路徑、逐一選擇新位置、專案「重新指定位置」）；A2 保存提醒 hook 只計算專案內的改動 |
| B. 敏感資料 | B1 保存前自動遮蔽密鑰，並提供 `pnpm db:redact` 處理既有資料 |
| E1. 先行整理 | query key 包含所有參數，移除手動 refetch 與過渡橋接 |
| C. 可信度與知識 | C1 決策來源與待確認的自主決策；C2 常駐知識頁；C3 知識的證據強度；C4 依時間範圍檢索 |
| D. 洞察與圖像 | D1 熱點檔案；D2 圖譜邊的來源標示與路徑說明；D3 時間軸；D4 從記錄跳到程式碼；D5 Agent 附上的 Mermaid 圖表 |
| E. 工程整理 | E2 拆分 `server.ts` 路由；E3 清掉剩下的模組層級狀態 |

### A1 完成（PR #124）

- 可攜式匯入預覽提供來源路徑與資料夾狀態，Web／互動 CLI 可逐一指定新位置或略過；專案頁可重新指定遺失的位置。
- 重新指定位置會要求 tracked 範圍確認、拒絕專案根目錄重疊，並以交易更新專案路徑與 raw snapshot 路徑前綴；migration 13 的稽核資料不保存路徑。
- PR #124 以 merge commit 合併；head `ba5a24a7dfe2596730c8cd175a64475e5ee88d9b`、merge `987ea9e28ab6671862d9de9f58a880c4ba8e9bc5`，CI run #263 全綠。

### C2 常駐知識頁

- 每個 tracked 專案有「架構與慣例」「進行中的工作與未結項」「常見陷阱」三個預設知識頁，也可建立自訂問題的頁面；Agent 以四個 MCP 工具讀取、更新或標記已檢查，每段必須引用來源 Session 或寫「資料不足」。檢查游標只保存同專案 Session id，隨頁面匯出／匯入；來源 Session 刪除時清空游標，因此不進全文搜尋索引。
- 新 Session 先標示為「有新資料」；Agent 評估後可記錄已檢查游標，只有答案改變時才新增頁面版本。Web 知識頁分頁提供狀態篩選；已引用來源改變仍獨立標示「需要核對」。
- 知識頁與版本納入匯出／匯入、專案刪除與 `pnpm db:redact`；補上 C1 漏列的 `session_decisions` 遮蔽欄位，並以覆蓋測試防止之後漏列。

### C3 知識證據強度

- 新表 `knowledge_feedback` 保存每次 Session 確認、Session 推翻與手動確認；升級時只從 audit 回填能確定的紀錄（使用中的資料庫：81 筆 audit 中 4 筆符合，3 筆 Session 確認、1 筆手動確認，0 筆推翻）。
- Knowledge 列表顯示確認／推翻次數，變更紀錄面板列出來源 Session；證據一次分組查詢算出。
- 檢索排序納入證據強度，新增合成案例；檢索品質門檻維持通過。

### C4 依時間範圍檢索

- `work_recall`、`work_search` 與 `GET /api/search` 新增 `from`／`to`（server 時區日曆日期），在 SQL 層依 `doc_date` 篩選；工具說明提示 Agent 把「上週」「六月」換算成日期。
- 新增合成檢索案例與「依月份範圍檢索」效能門檻（p90 約 15 ms，上限 500 ms）。

### D1 熱點檔案

- `getHotspots` 以 SQL 彙總 search path 索引（排除作廢與改動超過 20 檔的 Session），一次查詢取前 N 名與各自最近 5 筆 Session；可依目錄彙總、依專案與期間篩選，並還原原始大小寫顯示。
- `GET /api/insights/hotspots`；工作圖譜新增「熱點」分頁（文字標示與圖例，不只靠顏色）；報告風險加入本期熱點；`work_get_context` 帶 paths 時提示近 30 天常被修改的檔案。
- 效能：5,000 筆 Session 全期間前 20 名 p90 約 74 ms、依目錄單月約 23 ms（門檻各 500 ms）。

### D2 圖譜邊來源與路徑

- `GraphEdge` 加上 `provenance`（recorded／derived）與 `reason`；推導的 `co_changed` 邊以雜湊表一次計數檔案配對（預設至少 3 筆 Session），預設隱藏，UI 以虛線與圖例區分。
- `GET /api/graph/path` 與唯讀 MCP `work_get_graph_path`：500 節點內 BFS 最短路徑，同長度時優先具體關係，逐段說明；節點面板可選另一節點並高亮路徑。
- 選擇新增唯讀工具而非擴充 `work_get_graph`，避免把一次性的小查詢混進可分頁的大量輸出。

### D3 時間軸

- `getTimeline`：期間內重疊的 Session、Knowledge 事件（一次 UNION 查詢取得建立、確認、推翻、取代）與 Session 關聯；單次最多 2,000 筆 Session。
- 工作圖譜新增「時間軸」分頁：泳道內以區間分割（最小堆積）把重疊的 Session 排到最少列，水平捲動時以二分搜尋只畫可見範圍；可縮放、選期間，點選開啟 Session 面板。
- 同樣內容的清單檢視（依日期分組的表格），手機寬度自動切換；納入 axe 檢查。
- 效能：5,000 筆 Session 單月 p90 約 6 ms、一整年約 18 ms。

### D4 從記錄跳到程式碼

- 專案新增 `repositoryUrl`（migration 18，只接受不含帳號或 token 的 https 網址，納入匯出；匯入時不安全的值會被清除）；Session 有 commit 時連到儲存庫的 commit 頁面。
- 系統狀態頁「個人偏好」可選 VS Code／Cursor／不使用，存在瀏覽器本機；changed files 旁的「在編輯器開啟」只為記錄中的專案產生，路徑正規化且不能跳出專案根目錄（拒絕 `..` 與其他根目錄的絕對路徑）。
- 所有外部連結使用 `rel="noopener noreferrer"`，並有單元測試與 E2E。

### D5 Agent 附上的 Mermaid 圖表

- 新表 `session_diagrams`（migration 19）與 MCP `work_attach_diagram`（`ADDITIVE_IDEMPOTENT`）；finalize 可帶最多 5 張；標題與原始碼經過遮蔽；可作廢與還原、不能刪除；納入匯出、匯入、專案刪除與 `db:redact`。
- 主頁 CSP 不放寬：`srcdoc` iframe 會繼承主頁 CSP，所以改為在 Shadow DOM 顯示 SVG、樣式以 Constructable Stylesheet（CSSOM，不受 `style-src` 限制）套用；Mermaid 以 `securityLevel: "strict"` 延遲載入。
- 打包：主程式 chunk 不含 Mermaid；Mermaid 與各圖表類型是獨立的延遲 chunk（dist 由約 0.8 MB 增至約 4.2 MB，只有開啟含圖表的 Session 時才下載需要的部分）。

### E2 拆分 server 路由

- `server.ts` 從約 1,650 行降到約 270 行，只留下 Host／Origin 檢查、CORS、SSE、路由分派與錯誤處理；70 條路由分成 7 個路由檔（皆在 300 行內），`http.ts` 放共用的 body 解析與回應工具。
- 路由比對：字面路徑以雜湊表 O(1) 查找，含參數的路徑依方法與段數分組；建表時拒絕重複路由。
- 行為不變：既有 server 測試原樣通過；新增路由表測試，確認每條路由的方法與路徑都有註冊且沒有重複。

### E3 清除模組層級狀態

- `useKnowledge`、`useKnowledgeCandidates`、`useRecordVoid`、`useSessionEditor`、`useSessionLinks`、`useConfirm`、`useToast` 的模組層級狀態移進 7 個附 `$reset` 的 Pinia store；composable 對外介面不變。
- 移除 `useApiRequest` 未使用的 `beginRequest`／`isCurrentRequest`／`finishRequest`。原本 `abortAll` 只中止由 `beginRequest` 註冊的控制器，正式程式碼從未註冊，因此改為以 Pinia Colada `cancelQueries()` 真正取消進行中的查詢；測試輔助同步調整。
- 保留的例外（寫在 worklog-code-layout skill）：無反應性的 `useApi` 單例、`useRouteQuery` 的批次緩衝，以及由 fetch callback 更新的連線狀態 `useApiConnection`。

### 額外調整：報告主要完成事項增加至 10 筆

- 報告頁與 Agent 報告摘要脈絡都保留最新 10 筆主要完成事項，期間工作總數仍按完整資料計算。

### 第六輪後的調整

- Agent 在工作改到跨模組流程、資料路徑、狀態機、架構或多步驟流程時，會自己附上 Mermaid 圖（最多兩張），小修正、樣式、設定與只改測試的工作不附（PR #143）。
- Web 動效：共用 easing／duration token、換頁淡入、分頁指示線滑動、對話框與選單彈出、Toast 滑入、按鈕按壓回饋；系統要求減少動態時全部關閉。待確認決策列表修正跑版（PR #144）。
- 時間軸依縮放切換細節層級：拉遠時每個專案每天一根長條（依驗證結果分色、各泳道同一比例），點一下放大到那天並置中於當天的 Session；Session 在每條泳道都能排進 10 列以內時才畫個別長條，這個門檻以二分搜尋在幾個縮放層級中找出。縮放改為連續倍率（放大、縮小、顯示整個期間），座標軸依縮放顯示月、週一、日或小時刻度。

## 第五輪結案（2026-09-27）

- Codex 完成階段 A～E 與附加的 Web 架構階段 F（#87～#121）：備份管理、刪除稽核、系統狀態頁、`SQLITE_BUSY` 分類與優雅關閉、storage service 拆分、Pinia＋Pinia Colada、API 錯誤代碼、WebKit 核心流程、生產依賴稽核、Firefox axe 與鍵盤操作 E2E。
- Claude 複檢（PR #122）：
  - 工作歷程搜尋在 5,000 筆 Session 時約 2 秒，原因是全文搜尋的 join 順序；修正後約 13 ms。
  - 列出 Knowledge 的過時判斷約 790 ms，改為批次計算後約 50 ms。
  - 可攜式匯出漏了 `sessions.changed_files_confirmed`，已修正；舊的匯出檔仍可匯入。
  - 新增資料表與欄位的匯出覆蓋測試、收緊效能門檻、移除過渡轉接層。
- 新增 `worklog-backend` skill，並更新 `worklog-web-code-style` 與 `worklog-ui` skill。

第六輪結案時，依使用者決定暫緩開機自動啟動、發行 workflow／tag／release、升到 1.0.0 與實機平台驗證；第八輪已將這些工作重新排到最後的 E1–E3 階段。

### 歷史計畫：Agent 檢索品質（已完成）

目標：讓 Agent 透過 MCP 查工作記錄與 Knowledge 時「找得到、放得進 context、敢用」，工作記錄才會成為可靠的幫手。以下是 2026-09-24 在本機以真實 DB 快照做的評估；評估只讀快照副本、沒有修改資料。為保護使用者資料，這裡只記錄彙總數字與機制層面的發現，不收錄任何查詢內容、Session／Knowledge 內容、id 或專案檔名；評估題與腳本只留在本機，不進 repo。

### 評估發現

1. **搜尋幾乎找不到資料**：`work_search` 把整個查詢字串當成一個 `LIKE '%…%'`，Agent 慣用的多關鍵字查詢一律 0 筆；`work_search_knowledge` 同樣如此。36 題評估題中，現行搜尋 hit@5 只有 14%，31 題回傳 0 筆；唯一有命中的檔名題型，是剛好比對到 Knowledge 的 `references` 欄位。
2. **約 69% 的 Session 內容搜不到**：歷史 handoff 匯入的 Session，title 只有 slug，summary 與 events 是固定句，真正內容在 raw snapshot（平均約 4.2 萬字、最大約 20 萬字），完全不在搜尋範圍。重要的事故與決策因此無法被找回。
3. **回傳過大，入口工具本身超出 Agent 上限**：`work_get_context` 單一專案回傳約 107 KB，被用戶端改寫到暫存檔；其中 `recentSessions` 約 49 KB（`changedFilesProvenance`、`changedFileChanges`、`changedFiles` 合計約 27 KB），`metadataFollowUps` 約 17 KB 是回補用資料、與開工無關。`work_search` 單一關鍵字只命中 1 筆也可能回傳 67 KB，因為回傳完整 Session 物件（該筆有近 200 個 changedFiles）。
4. **context 與任務無關**：`recentDecisions` 取最近 8 個 `note`／`closing` 事件，實際內容多是 commit、工作區狀態這類流程記錄，不是技術決策；真正的決策在 `workSummary.decisions`（只有約 10% 的 Session 有填），context 沒有回傳。`recentKnowledge` 只依更新時間取 12 筆，與要做的工作無關。也沒有「我要改這個檔案，過去有什麼記錄」的查法。
5. **Knowledge 量少、路徑格式不一**：active Knowledge 只有個位數。`references` 混用「專案名／相對路徑」、「相對路徑」與絕對路徑三種格式，也夾雜 commit SHA，要先正規化才能做路徑比對。
6. **changedFiles 異常會汙染路徑檢索**：changed files 異常多的 Session 在檔名查詢中經常擠進前 3 名。
7. **Skill 沒有「何時該查」的規則**：只要求在使用者問到過去工作時才查，Agent 不會在開工前或遇到錯誤時主動查。

### 候選檢索策略實測

評估題共 36 題、5 類：K＝找 gotcha／pattern（7）、S＝Session 主題（10）、R＝答案只在 raw handoff（10）、N＝自然語句提問（4）、P＝以檔名／路徑查（5）。指標為 hit@5（答案出現在前 5 筆）、MRR（正確答案排名倒數平均）、0 筆題數。

| 策略 | K | S | R | N | P | 全部 hit@5／MRR／0 筆 | 前 5 筆回傳大小 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S0 現行（整句 LIKE、依時間排序） | 0% | 0% | 0% | 0% | 100% | 14%／0.14／31 | 最大 67 KB |
| S1 拆字 AND ＋ 擴充欄位 | 71% | 100% | 0% | 0% | 100% | 56%／0.49／16 | 約 1.5 KB |
| S2 拆字 OR ＋ 欄位權重排名 ＋ 中文雙字切詞 | 100% | 100% | 30% | 75% | 100% | 78%／0.73／0 | 約 1.3 KB |
| S3 S2 ＋ raw snapshot 整份索引 | 100% | 100% | 90% | 100% | 100% | 97%／0.89／0 | 約 1.2 KB |
| S4 S3 ＋ 路徑正規化比對 | 100% | 100% | 90% | 100% | 100% | 97%／0.91／0 | 約 1.2 KB |
| **S5 S2 ＋ raw 依標題切段 BM25 ＋ 路徑比對** | 100% | 100% | 100% | 100% | 100% | **100%／0.95／0** | 約 1.3 KB |

擴充欄位＝title、summary、workSummary 五段、changedFiles、branch、events，以及 Knowledge 的 title、body、tags、references。欄位權重：title 3、Knowledge tags 2、summary／workSummary／Knowledge body 1.5、其他 1、raw 0.6（S5 的 raw 段落分數 ×0.5 加權）；分數再乘上「命中關鍵字比例的平方」，偏好命中多數關鍵字的結果。

從實測得到的設計結論：

- **raw snapshot 必須切段索引**：整份索引時，超長文件幾乎包含所有字詞，會把正確答案擠下去。依 `#`～`###` 標題切段（每份平均約 70 段）並以 BM25 做長度正規化後修正，結果也能附上命中的段落標題。
- **FTS5 trigram 不能單獨使用**：trigram 至少要 3 個字元，實測兩字中文詞 trigram 0 筆、LIKE 有結果。兩字中文詞要退回 LIKE 或另做雙字切詞；超過 3 字的中文連續字串切成雙字 token。
- **路徑查詢要先正規化**：去掉專案名前綴與絕對路徑前段後比對尾端，P 類 MRR 由 0.87 提升到 1.00。
- **限制**：評估題是看過資料後撰寫，絕對數字偏樂觀、題數也少；適合比較方案間的相對差異。

### 改善計畫

**第一階段：找得到、放得進 context**（已完成實作，見下方「最近完成」）

repo 內的合成回歸評估涵蓋 K／S／R／N／P 五類，設定整體與分類 hit@5／MRR 下限，並在 Ubuntu CI 單獨執行。私有 36 題評估與真實資料仍留在使用者本機；本 repo 不含其題目、資料或腳本。

**第二階段：可信度與回饋**：已全部完成（Session 作廢、Session 關聯、Knowledge 可信度、Session 開始／更新時間、Knowledge 候選），見下方「最近完成」。

### 第五輪後的交付補記（已完成）

- **報表日期版面與長清單內部捲動**（PR #83，2026-09-26）：切換單日、自訂期間與預設期間時日期控制項維持固定位置；不完整自訂日期補最近 14 天，避免送出缺少起訖日的請求。主要頁面與 Session 詳情、輔助面板／對話框的長清單改在受限區域內捲動；補上 worklog-ui 規範，並以 Chromium／Firefox E2E 覆蓋桌面、平板與手機尺寸。

- **報告的跨期工作**：報告新增 `spanning`，列出在期間內完成但更早開始、在期間內開始但之後才完成、更早完成但在期間內修改（比 finalize 晚一分鐘以上）的 Session；統計數字仍只算期間內完成的 Session。報告頁「工作」分頁與 Markdown 匯出都會顯示。
- **自訂期間報告**：報告查詢（REST、MCP `work_get_report`／`work_export_report`、Web）接受 `from`／`to`（最長 366 天），回傳 `period: "custom"`，上一期為緊接在前的同樣天數，超過 92 天趨勢以月份為單位。報告頁新增「自訂」區間與日期範圍選擇，總覽依長度按日／週／月分組；PR #44 也完成自訂期間的 AI 整理與既有摘要資料升級。
- **報告 Session 截斷標示**：報告回傳本期與上一期是否各自超過 200 筆，報告頁與 Markdown 匯出會提示部分統計只依納入的 200 筆計算。
- **列表搜尋改為多關鍵字**：Web 的 Session 列表、Knowledge 搜尋與 `work_search_knowledge` 原本把整句當成一個 LIKE。現在依空白拆詞（雙引號可保留片語），每個詞都要出現在某個欄位；Session 另外比對五段 workSummary 與 changed files（以 `json_each` 只比對內容，不會因欄位名稱如 decisions 命中每一筆）。列表維持時間排序與分頁，排序檢索仍由 Agent 的 `work_recall` 負責（評估的 S1 策略：0 筆題數 31→16）。
- **圖譜跨頁的 Session 關聯**：分頁取回圖譜時，只要關聯的一端在該頁就送出 `session_link`（另一端必須是範圍內的有效 Session），Web 合併各頁後即可畫出兩端落在不同頁的關聯。
- **測試檔集中分類（PR #45）**：單元測試與端對端測試統一放在根目錄 `tests/`，依套件與測試類型分類；不再混放於 `apps/` 或 `packages/` 的程式碼目錄。
- **保存提醒 hook**：Claude Code 使用 `apps/mcp/dist/finalize-reminder.js`；Codex 使用 `apps/mcp/dist/codex-finalize-reminder.js`，兩者仍由使用者全域設定載入，repo 不附專案層級的 `.codex/hooks.json`。Claude 只把 transcript 中落在記錄中專案根目錄內的 Edit／Write／MultiEdit／NotebookEdit 路徑算為改動；Codex 解析 `apply_patch` 的 Add／Update／Delete／Move 標頭，依 hook `cwd` 篩選專案內路徑。讀取或解析失敗時放行；兩者唯讀查專案清單，Codex hook 需在 `/hooks` 檢查並信任，Bash 改檔不會觸發。設定方式見 agent-setup。
- **changedFiles 開工基準排除**：`work_finalize_session` 可傳入工作開始時擷取的 `baselineChangedFiles`，系統會從該 Session 的 changed files、來源與變更事件排除開工前已變更的路徑；從基準路徑改名時只記新路徑為新增檔案。相同基準檔案後續又修改也會保守排除，避免把先前工作錯算成本次成果。
- **Storage 報告讀取服務拆分**：將報告產生、跨期 Session、證據整理與 Markdown／JSON 匯出搬至 `report-service.ts`，期間計算與趨勢函式移至 `report-utils.ts`；`WorkIntelligenceStore` 對外方法維持原樣並轉呼叫新服務，未改變報告行為。
- **加入專案改為選擇資料夾**（使用者提出）：「加入專案」對話框新增「選擇資料夾」，由本機 API server 叫出作業系統的選擇資料夾視窗（macOS `osascript`、Windows PowerShell、Linux `zenity`／`kdialog`），選完自動填入路徑，名稱空白時以資料夾名稱帶入；仍可手動輸入。新增 `POST /api/system/pick-folder`，指令固定、不經過 shell，區分「取消」與「無法開啟」，同時只開一個視窗。
- **資料庫備份與換電腦**（使用者提出）：API server 每個本機日曆日自動備份一次到資料庫旁的 `backups/`（`VACUUM INTO` 一致快照、`quick_check` 驗證、檔案 0600／目錄 0700）；自動與手動備份分開保留，預設各 14 份，手動備份不會擠掉每日自動備份。專案頁可立即備份、列出備份、匯出整份資料。`pnpm db:backup`／`db:export`／`db:restore` 提供 CLI，還原會檢查完整性與 schema 版本、先備份原本的資料、以 `--remap-root` 換掉專案與 handoff 路徑前綴，並以取得獨佔鎖判斷資料庫是否仍被 server 或 Agent 開著。API 只回檔名、不回傳路徑，POST 要求 JSON body。
- **依專案匯出與合併匯入**：Web 與 CLI 支援單一／全部專案的 JSON 可攜式資料包；所有匯入欄位經 schema 驗證並限制檔案大小、筆數與字串長度。匯入先顯示新增、略過、衝突與路徑轉換預覽，再由使用者確認，在單一 SQLite 交易內合併；相同資料可重複匯入，既有資料不覆寫，新專案先暫停，且以計數與檔案摘要寫入匯入稽核。`--remap-root` 使用完整路徑片段比對並支援跨平台分隔符號。
- **Build 清除舊產物**：所有工作區在 build 前用共用 Node.js 腳本清理各自的 `dist`，避免 TypeScript 將搬入 `tests/` 前的舊測試輸出留在建置目錄。以 `pnpm build` 驗證所有八個工作區建置成功，並確認預先放入 `apps/server/dist` 的舊檔已清除。
- **Agent 完成請求後頁面自動更新**（使用者提出）：報告整理、Knowledge 候選、metadata 回補的請求在待處理或處理中時，頁面每 5 秒安靜地重新檢查（不顯示載入動畫，分頁不在前景時暫停、回到前景立即檢查），請求結束就停止；Agent 完成時自動載入結果並提示，失敗時也會提示。切換報告區間或專案時會重設追蹤，不會誤報完成。只改前端，API 不變；E2E 以 API 模擬 Agent 存入整理結果驗證。
- **報告總覽依區間顯示不同內容**：總覽原本五種區間用同一個版型、只有數字不同。現在依區間加上 deterministic 的分組：日報列出當日完成的 Session，週報分成每日、月報分成每週（週一起算、以月界截斷）、季報分成每月、年報分成每季，標出最多的一期與有完成工作的期數；各區間都顯示專案占比。只用既有的報告資料（`sessions`、`trends`、`projects`）在前端計算，API 沒有變動。
- **報告 AI 整理的範圍隔離**：選「所有記錄中專案」時，提煉請求與摘要原本只依區間篩選，同一區間的單一專案 AI 整理會被當成全專案報告顯示，且其待處理請求會擋住建立全專案請求。請求與摘要查詢新增 `scopeType`（REST 同名參數），Web 在未選專案時只取全專案的整理；MCP 行為不變。
- **Knowledge 候選**（Agent 檢索第二階段）：migration 7 新增 `knowledge_candidate_requests`、`knowledge_candidates`。Agent 以 `work_request_knowledge_candidates` → `work_get_knowledge_candidate_context` → `work_submit_knowledge_candidates` 從專案尚未整理過的 Session（含 raw handoff，40,000 字內）提出候選，每筆附來源 Session 與依據；候選只有在工作知識頁由使用者接受（可先修改）後才寫成 Knowledge，MCP 沒有接受工具。`work_get_context` 的 `pendingRequests` 新增 `knowledgeCandidates`；請求超過 30 分鐘未完成會標為可重新處理。Web：工作知識頁新增「Knowledge 候選」區塊（整理候選、接受、修改後接受、拒絕、查看來源 Session）。
- **Session 開始時間與最後更新時間**（使用者提出）：migration 6 為 Session 加上 `started_at`、`updated_at`。finalize 可回報 `startedAt`（沒回報時取早於完成時間的最早 event，都沒有就留空，不推測），`work_update_session_metadata` 可補上已確認的開始時間；摘要、workSummary、verification、metadata、作廢、Evidence、關聯等修改都會更新 `updatedAt`，既有資料以修改紀錄回填。Session 詳情顯示開始時間與耗時、完成時間、最後更新，工作歷程列表在完成後有修改時顯示「更新於」。報告與日期篩選仍以完成時間分組。
- **Knowledge 可信度**（Agent 檢索第二階段）：migration 5 為 Knowledge 加上 `appliesTo`、`lastConfirmedAt`／`lastConfirmedSessionId`、`supersedesId`、`review`。之後有 Session 改到 `appliesTo` 的檔案時，讀取結果帶 `possiblyStale`（規則判斷）；finalize 可回報 `appliedKnowledgeIds`（確認有效）與 `contradictedKnowledgeIds`（標示需要檢視）；記錄新 Knowledge 時可用 `supersedesId` 自動封存被取代的舊 Knowledge。context 與 `work_recall` 帶 `possiblyStale`／`needsReview` 旗標。Web：工作知識頁顯示「可能過時」「需要檢視」與原因、確認有效時間與適用路徑，選單新增「確認仍有效」「查看改動檔案的 Session」，編輯對話框可設定適用路徑。
- **Session 關聯**（Agent 檢索第二階段）：migration 4 新增 `session_links`（`continues`：接續另一筆的工作，`related`：一般關聯；同一對 Session 只有一個關聯）。finalize 可帶 `parentSessionId`／`relatedSessionIds`（無法建立的列在 `linkWarnings`），MCP 新增 `work_link_sessions`，REST 新增 `POST /api/sessions/:id/links`、`DELETE /api/sessions/:id/links/:relatedId`。Session 詳情回傳 `links`，`work_recall` 的 Session hit 附 `related`（不含已作廢），圖譜新增 `session_link` 連線。Web：Session 面板「關聯 Session」區塊可搜尋並建立關聯、點標題跳到另一筆、移除（確認框）。
- **Verification 可在 UI 修正**：Session 面板的「編輯 Session」對話框新增 Verification 狀態（通過／失敗／未執行；未回報只能維持不變）與說明，只在有變更時送出 `PATCH /api/sessions/:id/verification`。migration 3 新增 `session_verification_updates`，Web 修正與 Agent 的 metadata 回填改動 verification 時都會留下前後值與來源，Session 詳情以「Verification 修改紀錄」顯示。
- **Session 作廢與 Evidence 更正**（Agent 檢索第二階段）：migration 2 為 Session 與 Evidence 加上 `voided_at`／`void_reason`，並新增 `void_audit` 作廢紀錄。作廢的 Session 從 Session 列表、Dashboard、報告、圖譜、metadata 缺口、近期決策、context 與檢索排除，詳情仍可開啟並顯示原因與作廢紀錄；標示錯誤的 Evidence 保留在詳情但不進報告與圖譜。MCP 新增 `work_void_session`／`work_void_evidence`，REST 新增 `PATCH /api/sessions/:id/void`、`PATCH /api/evidence/:id/void`，Session 列表可用 `voided` 篩選。Web：Session 面板可作廢（對話框必填原因）與還原（確認框），Evidence 可逐筆標示錯誤／還原，工作歷程新增「作廢」篩選，列表與面板顯示「已作廢」標籤。
- **Agent 檢索第一階段：排序檢索與 `work_recall`**：新增 `schema_migrations` 版本表；migration 1 建立 FTS5 檢索索引，涵蓋 Session 的 title、summary、五段 workSummary、changed files、branch、events 與 raw handoff（依 `#`～`###` 標題切段），以及 Knowledge 的 title、body、tags、references，既有資料在第一次查詢時回填。英文識別字拆成 camelCase／snake_case 各段、中文以雙字切詞；排序為 BM25 × 欄位權重 × 命中關鍵字比例平方 × 時間權重，changed files 超過 20 個的 Session 降權。新增 MCP `work_recall(q, paths, projectRoot, limit)` 回傳 Session＋Knowledge 混合的精簡 hit，有關鍵字沒命中時附 `termHits`；`work_search`（與 REST `/api/search`）改走同一個引擎、只查 Session、上限 20 筆；`work_get_context` 可帶 `task`／`paths`，回傳 `relevant`（相關 Knowledge、相關 Session 的決策、改過同批檔案的 Session 與未結項）。Knowledge `references` 在索引時把 commit SHA、URL 與路徑分開，路徑去掉專案根目錄與專案名前綴後比對。索引由 SQLite trigger 標記變動、查詢前重建，涵蓋 REST、MCP 與 UI 的所有寫入。以 60 筆各含 4.2 萬字 handoff 的合成資料量測：第一次建立索引約 0.74 秒，之後每次查詢約 38 ms，8 筆結果約 4 KB。另修正 storage coverage 設定沒有固定 `TZ=UTC`，在非 UTC 機器上日期邊界測試會失敗的問題。
- **Agent context 與搜尋改為精簡回傳**（Agent 檢索第一階段）：`work_get_context` 的 Session、Knowledge 改回傳 digest（摘要與 Knowledge 本文超過 400 字截斷、不含 changed files 清單與 provenance），Session 附前 3 項未結項；`recentDecisions` 改取 `workSummary.decisions` 並附來源 `sessionId`；`metadataFollowUps` 只回傳筆數，明細改用 `work_preview_metadata_backfill`。`work_search` 的每筆結果也改成同樣的 Session digest。以本機資料量測，單一專案 context 由約 107 KB 降到約 12.6 KB，單一關鍵字搜尋由 67 KB 降到約 0.5 KB。原本給 note／closing 事件用的近期決策 partial index 已不再使用並移除。
- **報告日期改用系統時區**（PR #10）：報告、趨勢與工作歷程日期篩選改依 server 所在系統時區計算，報告回傳 `timezone`，報告頁頁首顯示時區名稱。另外修正搜尋把 `%`、`_` 當萬用字元的問題，API 拒絕非 loopback 的 `Host`（防 DNS rebinding），Prettier 改為檢查全專案。
- **Session 摘要可在 UI 編輯**：Session 面板新增「編輯摘要」，可修改主摘要與五段 workSummary（每行一項）；只送出有變更的欄位，同一筆 Session 就地更新並留下 audit，其他欄位維持唯讀。
- **MCP 補強**（PR #11）：新增 `work_get_project_status`（唯讀記錄狀態）、`work_list_sessions`、`work_get_session`、`work_request_report_synthesis`、`work_request_metadata_backfill`；`work_get_context` 多回傳 `pendingRequests`。所有工具加上 MCP annotations，新增 `finalize-work`／`synthesize-report` prompts。Server instructions 精簡為路由規則（原本會被用戶端截斷），三份 contract 只附在負責寫入的工具上。
- **只顯示 tracked 專案的 Session**：Dashboard 的 Session／事件計數、最近完成的工作與工作歷程列表（`/api/sessions`）都排除已暫停、忽略的專案；資料仍保留在 SQLite，恢復記錄中後會再出現。這也修正了列表會列出、但點進去詳情卻 404 的不一致。
- **圖譜節點面板改為覆蓋**：面板覆蓋在圖譜右側，不再把圖譜往左推，欄寬維持不變；畫布右側多出可捲動空間，選取的節點會自動捲到面板左側。
- **資料盤點**：2 個 tracked 專案（DevTools、Assistant）共 62 筆 Session 全部有五段 workSummary。修正 5 筆重複或放錯區段的內容，只重新安排既有句子，沒有加入新內容。報告摘要目前有 3 份現行版本，全部是 `report-synthesis-v3`，每個區塊都有可對應的 `sourceSessionIds`。
- **CI**：Quality（Linux + Windows：build、test、typecheck、coverage）與 E2E（Linux Chromium），每個 PR 與 `main` push 都會執行，目前全綠。第一次執行失敗的兩個原因已修正（PR #4）：workspace 套件透過 `dist/` 互相引用，所以要先 build 再測試；Windows runner 預設 `autocrlf=true` 會讓 Prettier 看到 CRLF，現在以 `.gitattributes` 的 `eol=lf` 統一換行。使用的 Actions 已升到 Node 24 版本（`checkout` v7、`setup-node` v7、`pnpm/action-setup` v6、`upload-artifact` v7），不再出現 Node 20 過時警告。
- **工作圖譜改版**（PR #6）：分層排版讓知識、證據、檔案排在所屬 Session 旁邊，連線改為曲線；選取節點時淡化無關節點並自動捲到該節點；新增節點搜尋（`?q=`，Enter 選取第一筆）；欄寬隨容器調整；檔案節點改顯示檔名與目錄，Session 副標題改用 verification 中文標籤。
- **右側面板加大且可調整寬度**（PR #6）：Session 760、Knowledge 變更紀錄 640、圖譜節點 460px；拖曳左緣或用方向鍵調整，寬度依面板各自記住。
- **Storage 讀取效能**：新增 `completed_at` 全域索引與近期決策 partial index；日期條件改為可使用索引的寫法；報告與提煉的 IN 列表查詢固定 join 順序；metadata 預覽先在 SQL 預篩。以 5,000 筆合成資料量測（`packages/storage/bench/read-paths.bench.mjs`，見 [testing.md](testing.md)）：

  | 讀取路徑 | 修改前 | 修改後 |
  | --- | ---: | ---: |
  | Session 列表 | 9.6 ms | 0.6 ms |
  | Dashboard | 7.4 ms | 0.1 ms |
  | 週報 | 20.1 ms | 3.9 ms |
  | 年報 | 30.4 ms | 16.7 ms |
  | Agent context | 84.1 ms | 29.8 ms |
  | metadata 預覽 | 58.0 ms | 17.6 ms |

### 更早已完成的工程基礎

UI 改版 P0–P4（六頁、共用 UI、App.vue 拆解、a11y、Ctrl／⌘ K）；集中 API client 與 AbortController；`store.ts` 拆出 repository；ESLint／Prettier；coverage 門檻（schema、storage handoff parser）；Graph server-side cursor 與 viewport culling；列表 virtual list；Provider + No-op；跨行程 idempotency 與 migration 交易保護；Content-Type 與 payload 上限；symlink real-path 二次檢查；`commit_required` 移除；handoff parser 單元測試與輸出邊界。
