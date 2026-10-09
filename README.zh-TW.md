# Work Intelligence

**1.4.0** 新增工作記錄「進行中」驗證狀態與原生架構卡片閱讀器。既有 Mermaid 依保存格式顯示；資料庫 schema 維持 27。更新並建置後，重啟執行中的服務及重新連線 Agent MCP，才能載入新版與契約。

[English](README.md) | **繁體中文**

**本機優先的開發工作記憶。** Codex、Claude 等 Agent 完成一段工作後，會把「做了什麼、改了哪些檔案、怎麼驗證」寫進你電腦上的一個 SQLite 檔案。你可以在 Web UI 回顧工作歷程，產生日、週、月、季、年或自訂期間的報告；之後 Agent 開工前或遇到錯誤時，也能從這裡找回過去的工作與 Knowledge。

- 🔒 **預設不記錄**：只有你明確設為「記錄中」的專案才會被讀取與保存，其他專案一律略過。
- 🏠 **資料只在本機**：API 只接受 `127.0.0.1` 的連線，不會把資料送到遠端，也不會在你的專案 repo 裡寫入設定檔。
- ✅ **未結項可核對**：Agent 收尾前取得與任務及檔案相關的項目，確認完成才結案；本次新項目取代舊工作時保留 Session 稽核，證據不足就維持未處理。Web 也支援每批最多 100 項的批次處理與復原；可發起整理請求，核對 Agent 附證據的建議後才接受。
- 🧾 **可追溯**：每筆摘要與報告結論都能回到來源 Session、檔案與證據。changed files 不等於 Git commit，也不會替 Agent 猜測驗證結果；修正與作廢都會留下紀錄。
- 💾 **帶得走、刪得掉**：每日自動備份、整份 SQLite 快照、單一或全部專案的 JSON 匯出與合併匯入，也可以永久刪除單一專案的資料並查看不含內容的刪除紀錄。
- 🩺 **能自己排除問題**：`pnpm run doctor` 唯讀檢查整個環境；API 斷線時畫面上方會顯示提示，恢復後自動重新載入。

---

## 目錄

- [快速開始](#快速開始)
- [連接 Codex／Claude](#連接-codexclaude)
- [日常使用](#日常使用)
- [Web UI 導覽](#web-ui-導覽)
- [備份、換電腦與刪除](#備份換電腦與刪除)
- [升級與維護](#升級與維護)
- [核心概念](#核心概念)
- [安全與隱私](#安全與隱私)
- [專案結構與開發](#專案結構與開發)
- [文件索引](#文件索引)
- [授權](#授權)

## 快速開始

需求：**Node.js 22.5 以上**（建議 24，會用到內建的 `node:sqlite`）與 **pnpm 11.16 以上**（見 `package.json` 的 `engines.pnpm`）。以下是約五分鐘的設定流程；第一次下載依賴可能需要較久。

```bash
cd /path/to/WorkLog.Ai
pnpm install
pnpm build
pnpm setup:agents
```

`pnpm setup:agents` 會先列出預計安裝的 MCP、user-level skills 與保存提醒 hook。預覽預設不會寫入；確認內容後，在互動提示輸入 `yes`，installer 會先備份再套用。若不想變更全域 Agent 設定，輸入其他內容或離開即可。完整範圍、備份方式與解除安裝步驟見[Agent 設定指南](docs/agent-setup.md)。

接著啟動本機 Dashboard 與 REST API：

```bash
pnpm start
```

終端機保持執行，按 `Ctrl+C` 停止。正式模式由同一個 process、同一個 port 提供 Web UI 與 REST API。

如果希望在登入電腦後自動啟動，可先執行 `pnpm build`，再執行 `pnpm service:install`。安裝前會列出即將寫入的服務檔案與完整內容；確認後才會設定目前使用者的服務，無須管理員權限。`pnpm service:status` 查看狀態，`pnpm service:uninstall` 停止並移除服務設定，保留資料庫、備份與日誌。各平台位置與排除問題方式見[登入自動啟動](docs/service.md)。

| 項目 | 位置 |
|---|---|
| Web UI | <http://127.0.0.1:3210> |
| REST API | <http://127.0.0.1:3210/api/health>（回傳程式版本與 schema 版本） |
| SQLite | `data/work-intelligence.sqlite`（可用 `WORK_INTELLIGENCE_DB` 指定） |

第一次使用前，建議先執行診斷：

```bash
pnpm run doctor
```

請用 `pnpm run doctor`，不要用 `pnpm doctor`：pnpm 11 把 `doctor` 保留給自己的命令，不會執行 Work Intelligence 的診斷。它會唯讀檢查 Node.js、pnpm、build 檔案、資料庫健康與 schema 版本、最近的備份與維護、API 是否可連線、MCP 註冊、skill 複本與全域保存提醒 hook，並用繁體中文列出修正建議。輸出不含任何工作記錄內容。

在 Codex 或 Claude Code 中重新連線 Work Intelligence MCP；Codex 使用保存提醒 hook 時，請在 `/hooks` 檢查並信任它。接著在 Dashboard：

1. 開啟「專案」→「加入專案」，選擇要記錄的專案資料夾。
2. 將專案狀態切換成「記錄中」，並確認允許讀取的範圍。
3. 在 Agent 對話中確認連線，之後照常工作；完成時請 Agent 保存這次工作。

如果還沒有記錄中專案或尚無 Session，總覽會顯示「加入專案 → 設為記錄中 → 連接 Agent → 第一筆工作記錄」四步清單，並連到相關頁面或提供安裝命令。

側欄底部會顯示目前的程式版本與 schema 版本。

## 連接 Codex／Claude

Work Intelligence 的 MCP 是**本機 stdio server**，由 Agent 自己啟動，不使用 Web 的 HTTP port。先執行一次 `pnpm build`，再依你的 Agent 註冊。請用絕對路徑，讓 API、MCP 與 CLI 使用同一個資料庫。

### 以 plugin 安裝（Claude Code／Codex）

這是連接 Agent 最簡單的方式。Claude Code 與 Codex 都從這個 repo 的 marketplace 安裝 Work Intelligence；plugin 執行的是你本機的 checkout，所以先 build 一次並連結：

```bash
git clone https://github.com/Ponpon55837/WorkLog.Ai && cd WorkLog.Ai
pnpm install && pnpm build && pnpm plugin:link
```

**Claude Code**

```bash
claude plugin marketplace add Ponpon55837/WorkLog.Ai
claude plugin install work-intelligence@worklog-ai
```

重新開啟 Claude Code，`/mcp` 會顯示 `work-intelligence` 已連線。保存提醒不需要其他設定。

**Codex**

```bash
codex plugin marketplace add Ponpon55837/WorkLog.Ai
```

在 Codex 開啟 `/plugins` 安裝 `work-intelligence`，再開啟 `/hooks`，檢視這個 plugin 的 hooks 並選擇**信任（Trust）**；未信任的 hook 會被略過，MCP 與 skill 不受影響。重新開啟 Codex，`/mcp` 會顯示 `work-intelligence` 已連線。

| plugin 提供 | Claude Code | Codex |
|---|---|---|
| MCP server `work-intelligence`（回想、脈絡、保存、報告） | ✓ | ✓ |
| Skill `work-intelligence`（何時、如何使用工具） | ✓ | ✓ |
| Skill `dashboard`（開啟 Web UI） | ✓ `/work-intelligence:dashboard` | ✓ 直接請 Agent 開啟 |
| 保存提醒 hooks | ✓ | ✓（在 `/hooks` **信任**後） |

**開啟 Dashboard**：請 Agent「打開 Work Intelligence dashboard」（Claude Code 也可輸入 `/work-intelligence:dashboard`），或在 checkout 執行 `pnpm dashboard`。server 沒在執行時會在背景啟動，並開啟 <http://127.0.0.1:3210>。想要每次登入都自動啟動，執行一次 `pnpm service:install`。

**更新**：在 checkout 執行 `git pull && pnpm install && pnpm build`，再執行 `claude plugin update work-intelligence@worklog-ai`；Codex 執行 `codex plugin marketplace remove worklog-ai` 後重新加入。Agent 提示重新連線時照做即可。

**之前手動註冊過？** plugin 與下方的手動註冊擇一即可，兩者並存時 Agent 會看到兩份相同的工具與提醒。移除手動註冊：`claude mcp remove work-intelligence --scope user`／`codex mcp remove work-intelligence`，並刪除 Claude `settings.json` 與 Codex `hooks.json` 裡 Work Intelligence 的 hook；`pnpm run doctor` 會指出重複的項目。

**沒有 checkout？** 每個 [GitHub Release](https://github.com/Ponpon55837/WorkLog.Ai/releases) 都附上 `work-intelligence-plugin-<版本>.zip`（內含 MCP server 的 plugin）與 `work-intelligence-<版本>.mcpb`（Claude Desktop 擴充）。需要 Node.js 22.13 以上，資料存在 `~/.work-intelligence/data`，但不含 Web UI。

遇到問題先執行 `pnpm run doctor`，再看 [plugin 指南](docs/plugins.md) 的排錯表。

### 手動註冊

想讓 Work Intelligence MCP 與 user-level skill 一次完成設定，可執行 `pnpm setup:agents` 預覽安裝計畫；預設不會寫入。操作方式、備份與解除安裝見 [Agent 設定指南](docs/agent-setup.md)。MCP 也會用標準 `resources/list`／`resources/read` 提供完整 skill 與記錄格式，任何支援 MCP resources 的 client 都能讀取：`work-intelligence://agent/work-intelligence/SKILL.md`、`work-intelligence://agent/work-record-and-report-format.md`。

macOS／Linux：

```bash
# Codex CLI
codex mcp add work-intelligence --env "WORK_INTELLIGENCE_DB=/path/to/WorkLog.Ai/data/work-intelligence.sqlite" -- pnpm --dir "/path/to/WorkLog.Ai" start:mcp

# Claude Code（user scope，所有 workspace 都能用）
claude mcp add --scope user --transport stdio work-intelligence --env "WORK_INTELLIGENCE_DB=/path/to/WorkLog.Ai/data/work-intelligence.sqlite" -- pnpm --dir "/path/to/WorkLog.Ai" start:mcp
```

Windows（PowerShell）：

```powershell
codex mcp add work-intelligence --env "WORK_INTELLIGENCE_DB=C:\path\to\WorkLog.Ai\data\work-intelligence.sqlite" -- pnpm.cmd --dir "C:\path\to\WorkLog.Ai" start:mcp

claude mcp add --scope user --transport stdio work-intelligence --env "WORK_INTELLIGENCE_DB=C:\path\to\WorkLog.Ai\data\work-intelligence.sqlite" -- pnpm.cmd --dir "C:\path\to\WorkLog.Ai" start:mcp
```

過期 MCP lease 與遺留暫存檔會在 MCP 註冊及系統狀態讀取時分批清理，預設門檻為 90 秒、每次最多 64 次刪除嘗試；詳見[疑難排解](docs/troubleshooting.md)。

Claude Code 另外提供兩個 MCP prompts：`/mcp__work-intelligence__finalize-work` 與 `/mcp__work-intelligence__synthesize-report`。Claude Desktop 的設定、驗證方式與常見問題見 **[docs/agent-setup.md](docs/agent-setup.md)**。更新 Work Intelligence 後，請重新 `pnpm build`。只有 schema／Agent 契約改變或無法確認相容性時才必須重新連線；僅實作更新會顯示「有新版可用」，原連線仍可照常讀寫，收尾再提醒重連。

第九輪的未結項整理新增 schema 與 Agent 契約。更新主安裝前先保存工作記錄，再依[升級說明](docs/user-guide.md#更新-work-intelligence)重新建置、重啟服務並重新連線 Agent；之後可在 Web 發起整理，由 Agent 提交建議，再由使用者接受或拒絕。

### 保存提醒 hook（選用）

想讓 Agent 忘記保存時被提醒一次，可以加上保存提醒 hook。hook 和 MCP 一樣裝在**全域**，任何專案都能用；它只在「記錄中」的專案作用，其他專案一律放行，判斷失敗時也會放行。

| Agent | 全域設定檔 | 事件 | 腳本 |
|---|---|---|---|
| Claude Code | `~/.claude/settings.json` | `Stop` | `apps/mcp/dist/finalize-reminder.js` |
| Codex | `~/.codex/hooks.json` | `PostToolUse`（`apply_patch`、`work_finalize_session`）＋`Stop` | `apps/mcp/dist/codex-finalize-reminder.js` |

- 設定時請使用 repo 的絕對路徑，並先執行 `pnpm build`。
- Codex 需要在 `/hooks` 中檢查並信任這個 hook。
- repo 不附專案層級的 `.codex/hooks.json`。
- 設定是否正確，可以用 `pnpm run doctor` 檢查。

完整設定範例見 [保存提醒 hook](docs/agent-setup.md#保存提醒選用)。

## 日常使用

你只需要用自然語言跟 Agent 說話，工具名稱、request ID、JSON 都由 Agent 處理（規則寫在 [`.agents/skills/work-intelligence`](.agents/skills/work-intelligence/SKILL.md)）。

| 想做的事 | 在 Agent 對話中說 | 或在 Web UI |
|---|---|---|
| 確認有沒有在記錄 | 「這個專案有在 Work Intelligence 記錄嗎？」 | 專案 |
| 保存這次工作 | 「完成了，請把這次工作記錄到 Work Intelligence。」（非記錄中的專案會直接略過） | — |
| 整理既有未結項 | 「請整理這個專案的未結項。」 | 工作歷程 → 未結項：選擇專案並建立整理請求，查看來源、理由與證據後逐筆或批次接受／拒絕 |
| 接續前次未結項 | 「這次處理了哪些先前列出的未結項？」 | 工作歷程 →「未結項」可依專案與狀態篩選，標記完成、不再需要或重新開啟 |
| 取回專案脈絡 | 「先看一下 Work Intelligence 裡這個專案最近做了什麼。」 | 工作歷程、工作知識 |
| 查過去的工作或錯誤 | 「之前有處理過報告時區的問題嗎？」或直接貼上錯誤訊息（Agent 用 `work_recall` 排序檢索 Session、raw handoff 與 Knowledge；結構化工作欄位優先，重複的舊 handoff 計分會降低，固定軟體詞表可跨中英文找低信心線索。`work_search` 回傳帶 confidence 的精簡 Session 命中；`none` 代表沒有可引用依據，完整記錄可再讀取） | 工作歷程搜尋（多個關鍵字時每個都要命中） |
| 整理報告 | 「幫我整理這週的 Work Intelligence 報告。」（沒有請求時 Agent 會自己建立；自訂期間也可以） | 工作報告 →「請 Agent 整理這份報告」，Agent 完成後頁面會自動更新 |
| 整理 Knowledge 候選 | 「幫我整理 Work Intelligence 的 Knowledge 候選。」 | 工作知識 →「整理候選」，接受（可先修改）或拒絕後才會成為 Knowledge |
| 更新常駐知識頁 | 「幫我更新這個專案的知識頁。」 | 工作知識 →「知識頁」：架構與慣例、進行中的工作與未結項、常見陷阱，每段附來源 Session；來源需核對或新資料累積 3 筆時，Agent 會收到維護提示；頁面顯示最後檢查到的時間，可手動編輯與查看版本 |
| 補齊缺漏的 metadata | 「幫我補齊 Work Intelligence 的 metadata 缺口。」（沒有請求時 Agent 會自己建立） | 專案 → Metadata 回補 →「掃描 metadata 缺口」 |
| 修正已保存的摘要 | 「幫我修正上一筆 Session 的摘要：……」 | Session 面板 →「編輯 Session」 |
| 連結相關的工作 | 「這次是接續昨天那筆規劃的實作。」 | Session 面板 →「關聯 Session」 |
| 撤掉記錯的 Session | 「上一筆記到錯的專案，請作廢。」（可還原） | Session 面板 →「作廢」 |
| 匯入歷史 handoff | 「幫我預覽這個專案可以匯入的 handoff。」 | 專案 → Handoff 匯入 |

每筆 Session 都有一句話摘要，以及固定的五段內容：**成果／範圍／決策／驗證／狀態與未結項**。每個未結項都有穩定識別碼並連回來源 Session；既有資料升級時一律先標為未處理，不會推測它是否已完成。Agent 可在保存後續工作時回報已解決的項目，工作歷程的「未結項」分頁也能手動標記完成、不再需要或重新開啟。格式與報告粒度見 [Work record and report format v1](docs/work-record-and-report-format.md)。 補存歷史工作前先查既有 Session，實際起訖只使用對話或 hook 證據；資料不足時保留缺口，避免以 PR 合併時間推估。

### 量測自己的檢索品質

可以用私有題目重跑 recall 與 context，確認預期的 Session／Knowledge 是否出現在前段：

```bash
pnpm eval:recall ./recall-questions.json --db ./data/work-intelligence.sqlite --out ./recall-report.json
```

先執行 `pnpm build`（此 CLI 需 Node.js 22.5+，與 repo 其餘部分相同）。每題指定 `mode: "recall"` 或 `"context"`、`query`、預期 id（可多筆）或 `expectedNoHit: true`；可選專案路徑與 recall 的起訖日期。報告列出各模式 hit@1、hit@5、MRR、每題排名、confidence、MCP 回應字元數與呼叫耗時。資料庫以 SQLite 唯讀連線建立 OS 暫存快照，檢索與索引同步只作用在快照；結果只到終端機或 `--out` 指定的新檔案，不會上傳，也不會覆寫任何已存在檔案。範例格式見 [`tests/fixtures/recall-eval-example.json`](tests/fixtures/recall-eval-example.json)，完整限制與指標定義見 [測試與驗證](docs/testing.md#檢索品質評估)。

更完整的操作說明見 **[使用手冊](docs/user-guide.md)**。

## Web UI 導覽

GitHub（Primer）風格的介面，有深色與淺色兩種主題，介面語言可選繁體中文或 English。左側選單分三組。長清單都在各自的框內捲動，不會把整頁撐長。

- **主題**：頁首的太陽／月亮按鈕切換淺色與深色；「系統狀態 → 個人偏好」可改回「跟隨系統」，隨作業系統的淺色／深色設定自動切換。第一次開啟時就跟隨系統。
- **語言**：頁首的語言選單切換繁體中文與 English。第一次開啟時依瀏覽器語言決定（中文瀏覽器用繁體中文，其他用 English）。只翻譯介面文字；Session、報告與 Agent 寫入的內容維持原本記錄的語言。
- 主題與語言都只存在這個瀏覽器，不會送到本機 API。
- 淺色主題使用柔和的灰色底而非純白，降低刺眼感。
- 載入資料時，頁面會顯示「正在載入…」與佔位列；數量在確定前不會顯示。

| 頁面 | 用途 |
|---|---|
| **總覽** | 本週 Sessions、驗證分布、依專案與類型聚合既有提醒（Knowledge／知識頁核對、自主決策、未結項整理審閱、未結項與 metadata 缺口入口、報告與補填請求），附有界分頁及部分／失敗來源提示、最近工作，以及「工作熱度」日曆（過去 53 週每天一格，依完成的 Session 數量深淺；點某一天開啟當日報告）；尚未有記錄中專案或 Session 時顯示第一次使用四步清單 |
| **工作歷程** | 多關鍵字搜尋，並依專案、日期篩選所有 Session。另有「未結項」分頁，可依專案、狀態與來源 Session 完成日期分頁查看，選取本頁項目批次標記完成／不再需要（最多 100 項），並一次復原為待處理或逐筆重新開啟；每項都連回來源 Session。點任一 Session 會從右側開啟詳情（開始時間、耗時、最後更新），`J`/`K` 切換上下筆。面板會顯示寫入這筆 Session 的 Agent 用戶端（有回報時也顯示模型），列表可依 Agent 篩選；「複製為 Markdown」可把 Session 貼到 PR 說明、站會訊息或交接；「Agent 讀取」列出 Agent 何時取得過這筆 Session。「編輯 Session」可修正主摘要、五段內容與 verification（會留下修改紀錄），也可以建立 Session 關聯、作廢或還原，並逐筆標示錯誤的 Evidence。Agent 新存的 Session 會自動出現 |
| **工作報告** | 日、週、月、季、年與自訂期間（最長 366 天）的報告，依系統時區切日，頁首會標示時區。總覽依期間分組（當日 Session、每日／每週／每月／每季分布、專案占比）；另有 AI 報告整理（每段附來源 Session）、趨勢、風險、跨期工作（更早開始、之後完成、事後修改）、原始紀錄與來源證據，資料超過上限時會提醒。可匯出 Markdown／JSON |
| **工作知識** | 分成四個分頁，分頁上顯示各自的數量：**Knowledge**（Agent 明確提交的決策、模式、注意事項、流程與技能；相關檔案被改動時標示「可能過時」，被 Session 推翻時標示「需要檢視」；顯示被幾次 Session 確認、幾次推翻，點開可看到是哪些 Session；可以「確認仍有效」、編輯、封存與查看變更紀錄）、**知識頁**（Agent 依已記錄 Session 撰寫的常駐頁面，每段附來源 Session；新 Session 先標示「有新資料」，累積 3 筆後或來源需要核對時，context 與 finalize 會提示 Agent 檢查；答案不變時可標記已檢查，頁面顯示最後檢查至哪個時間點；只有答案需要改變時才重寫；可要求 Agent 更新、手動編輯、查看版本，並與前一版比較差異）、**候選**（Agent 提出、等你接受或拒絕的 Knowledge）、**待確認決策**（Agent 自主做的決策，可確認、否決或升級為 Knowledge） |
| **工作圖譜** | 分成三個分頁：**時間軸**（依專案分泳道；拉遠時每天一根依驗證結果分色的長條，點一下放大到那天，拉近後 Session 畫成長條或點、關聯畫成弧線；Knowledge 的建立／確認／推翻／取代畫成標記；可縮放、顯示整個期間與選擇期間，點選開啟 Session；也能切換成依日期分組的清單，手機寬度自動使用清單）、**關係圖**（Project、Session、Knowledge、Evidence、檔案與 Session 關聯；實線是記錄的關係，可開啟以虛線顯示的「一起修改」推導關係；在節點面板可選另一個節點，逐段說明兩者如何關聯）、**熱點**（被最多 Session 修改的檔案或目錄，附驗證失敗與未執行的比例、最近 5 筆 Session；可依專案、期間篩選）。工作報告的「風險」也會列出本期被 2 筆以上 Session 修改的檔案 |
| **專案** | 專案清單與記錄狀態（加入時可用系統視窗選資料夾；可設定 https 儲存庫網址，Session 的 commit 會連到該儲存庫）、永久刪除專案、Metadata 回補、Handoff 匯入、資料備份（備份、匯出、匯入） |
| **Session 圖表** | Agent 在工作改到跨模組流程、資料流、狀態機或架構時，會主動為 Session 附上一到兩張 Mermaid 圖表（`work_attach_diagram` 或 finalize 的 `diagrams`；單檔修正、樣式、設定與純測試不附），在 Session 面板延遲載入並渲染；無法解析時顯示原始碼。圖表可作廢、不能刪除，也會隨專案匯出與匯入 |
| **系統狀態** | 程式與 schema 版本、資料庫位置與大小、最近的自動備份、備份數量與總大小、最近一次資料庫維護的結果、登入自動啟動服務，以及 Codex／Claude Code MCP 註冊、skill 複本與全域 hook 的唯讀狀態；不會修改服務或 Agent 設定。「Agent 讀取紀錄」列出最近的 MCP 讀取（時間、Agent 與工具、專案，以及回傳的 Session id），可依專案與 Agent 篩選。「個人偏好」可選擇外觀主題、介面語言，以及用 VS Code 或 Cursor 開啟 Session 的 changed files（都只存在這個瀏覽器）。完整環境診斷請用 `pnpm run doctor` |

Session 詳情提供最多五筆同專案共同檔案的相關工作提示，排除既有關聯，搜尋截短時明示；開啟提示不會建立關聯。

快捷鍵：`Ctrl`/`⌘` + `K` 搜尋、跳頁，或切換主題與介面語言，`/` 聚焦頁面搜尋，`g` + `d`／`s`／`r`／`k`／`g`／`p` 切換頁面。篩選條件與開啟中的 Session 都會寫進網址，可以直接分享或重新整理。

API 無法連線時，頁面上方會顯示「無法連線到 Work Intelligence API」，連線恢復後會自動重新載入目前的資料。

## 備份、換電腦與刪除

所有記錄都在一個 SQLite 檔案裡。

- **自動備份**：API server 每個本機日曆日自動備份一次，存到資料庫旁的 `backups/`。自動備份與手動備份分開保留，預設各保留最近 14 份，手動備份不會擠掉每日自動備份。備份檔只有目前的使用者可以讀寫。
- **手動備份**：Web UI 的「專案 → 資料備份 → 立即備份」，或執行 `pnpm db:backup`。
- **管理備份**：「專案 → 資料備份」會列出備份種類、時間、大小與總大小；刪除前會顯示檔名與種類並要求確認，刪除唯一一份列出的備份時會額外警告。CLI 可用 `pnpm db:backups` 列出，或在互動終端執行 `pnpm db:backups --delete <檔名>` 確認刪除。刪除專案後，刪除前備份與其他舊備份仍可能包含該專案資料，可從資料備份頁管理。
- **依專案攜帶資料**：在「專案 → 資料備份」可以匯出全部專案或單一專案的 JSON。CLI 用 `pnpm db:export --all` 或 `pnpm db:export --project <專案名稱或 id>`，加上 `--out <檔案.json>` 可以指定輸出位置。JSON 沒有加密，請妥善保管。
- **合併匯入**：
  - 在同一個分頁選擇 JSON 檔，預覽會顯示來源路徑與此電腦的資料夾狀態；找不到的專案可逐一選擇資料夾，或略過並以暫停狀態匯入。系統只檢查所選路徑是否為資料夾，不會讀取資料夾內容。
  - 若多個匯出路徑的父資料夾下有同名資料夾，UI 會列出候選路徑並要求你逐一確認後才採用。
  - CLI：`pnpm db:import <檔案.json> --dry-run` 只預覽；互動匯入時會為找不到的資料夾逐一詢問新位置，直接按 Enter 可略過。也可使用 `--remap-root <舊路徑>=<新路徑>`，最後輸入 `yes` 才寫入。
  - 可以重複執行，不會覆寫既有資料；新匯入的專案會先暫停。
  - 匯入透過正在運作的 API／SQLite 合併，不必先停服務。
- **路徑轉換**：`--remap-root` 可以重複使用，以完整的路徑片段比對。Windows 路徑不分大小寫，並依新路徑轉換分隔符號。它只調整匯入資料裡的專案根路徑與 handoff 來源路徑，不會用匯入的路徑讀寫檔案。
- **專案重新指定位置**：專案頁會以資料夾狀態提示找不到或無法確認的路徑；「重新指定位置」只選擇並驗證新資料夾，接著更新專案根路徑與該專案原始快照的路徑前綴。若專案正在記錄，操作前會要求確認 Agent 可讀寫的新範圍。稽核只保存時間、專案 id 與是否更新路徑，不保存路徑；MCP 沒有改路徑或刪除能力。
- **換電腦**：
  1. 在舊電腦按「匯出整份資料」（或執行 `pnpm db:export <檔案>`），得到一個 `.sqlite` 檔。檔案包含全部工作記錄且沒有加密，請用可信任的方式帶到新電腦。
  2. 在新電腦執行 `pnpm build`，停止 API server，並關閉會啟動 MCP 的 Agent 對話。
  3. 執行還原：

     ```bash
     pnpm db:restore <匯出的檔案> --remap-root <舊電腦的專案上層路徑>=<新電腦的路徑>
     ```

  專案在新電腦的位置相同時，不用加 `--remap-root`；也可以加多組。還原前會檢查檔案完整性與版本、自動備份新電腦上原本的資料；資料庫仍被其他程式開著時會停止。用備份還原也是同一個指令。

- **永久刪除專案**：在「專案 → 專案清單」按專案旁的垃圾桶，閱讀刪除範圍後輸入完整的專案名稱才能確認。
  - 會先建立並驗證一份完整備份，備份失敗就不刪除。
  - 在單一交易內刪除該專案的 Session、事件、handoff、Evidence、Knowledge、候選、報告整理、修改紀錄、搜尋索引，以及其他專案指向它的關聯。
  - 只留下一筆不含內容的刪除紀錄（時間、專案 id、各類筆數）。
  - 「專案 → 刪除紀錄」可查看每筆刪除的時間、專案 id 與各類筆數，不含專案名稱、路徑或已刪除內容。
  - 專案資料夾本身不會被動到。MCP 沒有刪除工具，只有你能在 UI 或 REST API 刪除。
  - **刪除後，資料仍存在於刪除前的各種備份與匯出檔中**，直到它們被輪替掉或你自行刪除。細節見[使用手冊](docs/user-guide.md#永久刪除專案資料)。

備份相關的環境變數：

| 環境變數 | 用途 |
|---|---|
| `WORK_INTELLIGENCE_BACKUP_DIR` | 備份目錄，預設是資料庫旁的 `backups/`。相對路徑以資料庫所在資料夾為基準，API、MCP、CLI 與 doctor 都會指向同一個位置 |
| `WORK_INTELLIGENCE_BACKUP_KEEP` | 手動備份保留份數，預設 14；自動備份另外保留 14 份 |
| `WORK_INTELLIGENCE_BACKUP=off` | 關閉每日自動備份 |

## 升級與維護

**升級**：更新程式碼後執行 `pnpm install`、`pnpm build`，再重新啟動 `pnpm start` 與 Agent 對話。

- 新版本需要升級資料庫時，第一次開啟前會自動建立一份 migration 前備份（`pre-migration-v<版本>-…`），再在單一交易內套用 migration；備份失敗時不會升級。
- 如果資料庫的 schema 比目前的程式新（例如在另一台電腦用過新版本），API、MCP 與 CLI 都會拒絕開啟，並提示你先更新 Work Intelligence，不會崩潰或只做一部分。
- 詳細步驟見[使用手冊](docs/user-guide.md#更新-work-intelligence)，版本變更見 [CHANGELOG](CHANGELOG.md)。

**資料庫維護**：

```bash
pnpm db:maintain
```

它會先建立維護前備份，再執行 `integrity_check`、`VACUUM`、`ANALYZE` 與搜尋索引重建，結果會記錄下來供 `pnpm run doctor` 顯示。它需要獨占資料庫，所以執行前請先停止 `pnpm start`，並關閉會啟動 MCP 的 Agent 對話；資料庫仍被開著時，它會停止並提示你。

遇到問題時，先執行 `pnpm run doctor`，再看 **[疑難排解](docs/troubleshooting.md)**。

## 核心概念

**專案記錄狀態（default deny）**

| 狀態 | 意義 |
|---|---|
| 未註冊 `unregistered` | 剛加入時的預設值，不讀取、不保存 |
| 記錄中 `tracked` | 你明確授權；Agent 可以讀取 handoff／Git／source 並保存工作紀錄 |
| 已暫停 `paused` | 暫停記錄，既有資料保留 |
| 已忽略 `ignored` | 明確排除 |

不是「記錄中」的專案，所有 Agent 請求都會回傳 `skipped`，也不會讀取任何檔案。Agent 不能替你把專案切換成「記錄中」。

**幾個容易混淆的區分**

- **Finalize ≠ Git commit**：一次工作可以沒有 commit；changed files 只代表檔案曾經變動。
- **Verification 分開呈現五種狀態**：通過、失敗、進行中（`in_progress`）、明確未執行（`not_run`）、未回報（歷史資料沒有提供）。驗證已開始但結果尚未確定時，可在「編輯 Session」選擇「進行中」；確認結果後原地改為通過或失敗。開始工作不等於通過，報表與可攜式匯出會保留這項區別；記錄定稿與驗證狀態各自獨立。
- **報表數字 ≠ AI 摘要**：統計與趨勢由系統固定規則計算；AI 整理的每段結論都必須引用來源 Session，資料不足時會直接寫「資料不足」。
- **Knowledge 只收明確提交的內容**：不會從 handoff 或原始碼自動抽取。候選由 Agent 提出，由你接受後才成為 Knowledge。
- **修正留痕跡，不重寫歷史**：主摘要、五段 workSummary 與 verification 可以由 Agent 或 Session 面板就地修正（同一筆 Session，留下修改紀錄）。記錯的 Session 與錯誤的 Evidence 用作廢處理（需要填原因，可以還原）。changed files、events 與 Evidence 內容維持唯讀。
- **開工前的改動不算這次的成果**：Agent 可以在開工時記下已存在的改動（`baselineChangedFiles`），finalize 時會從 changed files 排除。
- **Knowledge 會提醒自己過時**：`appliesTo` 列出的檔案之後被改動時，會標示「可能過時」。
- **作廢 ≠ 刪除**：作廢可以還原；永久刪除只針對整個專案，而且需要你親自確認。

更完整的資料契約、一致性保證與設計原則見 [docs/architecture.md](docs/architecture.md)。

## 安全與隱私

- API 只監聽 `127.0.0.1`，並檢查 `Host` 與 `Origin`。正式模式下 Web 與 API 同源，另外加上 Content-Security-Policy、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff` 與 `Referrer-Policy: no-referrer`。
- 靜態檔案會阻擋 `..`、編碼過的路徑與指向外部的 symlink。
- 錯誤回應只包含固定的訊息，不會外洩 SQLite 或檔案系統的內部細節。
- 備份與匯出檔沒有加密，請用可信任的方式保存與傳輸。
- 使用 MCP 時，Agent host 可能依其設定把工具結果送到遠端模型，這部分由 Agent host 的政策決定。
- 成功的 MCP 讀取會在本機留下稽核紀錄，只存 id 與數量（不存查詢或內容），保留 30 天或最新 5,000 筆，刪除專案時一併移除。

威脅模型與漏洞回報方式見 [SECURITY.md](SECURITY.md)。

## 專案結構與開發

```text
apps/
  web/       Vue 3 + Vite Web UI（GitHub/Primer design system，深色／淺色主題，繁體中文／English 介面，文字放在各語系的 JSON 目錄）；Pinia store 管理狀態，Pinia Colada 管理 API 資料的快取與失效
  server/    REST API、正式模式靜態檔、CLI（db:*）與 doctor
  mcp/       MCP stdio server 與保存提醒 hook
packages/
  core/            domain types 與 extension interfaces
  schema/          Zod 輸入契約
  storage/         SQLite schema、migration，以及報告、synthesis、backfill、recall、備份、資料轉移、刪除與維護等 service
  project-policy/  default-deny policy gate 與安全路徑
  shared/          共用常數、版本與 helpers
tests/             各 package 的單元／整合測試與 Playwright E2E（依 package 分資料夾）
scripts/           正式模式啟動與 build 前清除 dist 等腳本
data/              本機 SQLite 與 backups/（不進版控）
```

```bash
pnpm dev                      # 開發模式：Web UI 5966（Vite）＋ API 3210
pnpm start                    # 正式模式：Web 與 API 同一個 port（需先 build）
pnpm dashboard                # 必要時啟動正式模式 server，並開啟 Web UI
pnpm plugin:link              # 讓 Claude Code／Codex plugin 找到這個 checkout
pnpm build:plugin             # 在 dist/plugin/ 產生自帶 MCP 的 plugin zip 與 Claude Desktop .mcpb
pnpm start:server             # 只啟動 API
pnpm start:mcp                # 只啟動 MCP stdio server
pnpm run doctor               # 唯讀診斷
pnpm db:backup                # 立即備份（db:export、db:import、db:restore 見上方）
pnpm db:backups               # 列出備份；加 --delete <檔名> 可互動確認刪除
pnpm db:maintain              # 離線維護（需先停止 server 與 MCP）
pnpm test                     # ESLint、程式碼擺放順序、Prettier 檢查，以及各 package 與 Web 單元測試
pnpm test:coverage            # 覆蓋率（schema、storage、server、mcp、web 各有門檻）
pnpm test:performance         # 合成資料的讀取路徑效能門檻（需先 build）
pnpm test:retrieval-quality   # 合成資料的 work_recall 檢索品質門檻（hit@5、MRR）
pnpm eval:recall <題目.json>  # 在本機唯讀評估 recall/context（可加 --db 與 --out）
pnpm test:response-size       # 合成 MCP 輸出大小基線與 CI 上限
pnpm typecheck                # packages、Vue 與 E2E 型別
pnpm test:e2e                 # build 後以正式模式跑 Playwright（Chromium 全套、Firefox／WebKit 核心流程），使用獨立的暫存 SQLite
pnpm format                   # 用 Prettier 格式化整個 repo
```

CI 在 Ubuntu、Windows、macOS 跑 build、test、typecheck 與 coverage；Ubuntu 另外跑生產依賴安全稽核（high／critical 即失敗）、效能、檢索品質與 MCP 回應大小門檻，以及 Chromium／Firefox／WebKit E2E（Chromium 與 Firefox 掃描六個主要頁面、系統狀態、備份管理與第一次使用清單的 axe 無障礙檢查）。Ubuntu WebKit 不代表 macOS Safari 實機驗證。細節見 [docs/testing.md](docs/testing.md)。

其他設定：

- `WORK_INTELLIGENCE_DB`：SQLite 位置。
- `WORK_INTELLIGENCE_PORT`：正式模式的 port，預設 `3210`。
- `WORK_INTELLIGENCE_ALLOWED_ORIGINS`：正式模式同源，不需要額外設定。開發模式或自訂來源使用非預設的 Web origin 時，在 `.env` 設定這個變數（逗號分隔，不能用 `*`），其中的主機也會加入 API 的 `Host` 白名單。
- 報告與日期篩選依 server 所在的系統時區切日（Node 會遵守 `TZ` 環境變數）。

開工前請先讀對應的共用 skill（Codex 與 Claude 共用，放在 `.agents/skills/`）：

| 範圍 | skill |
|---|---|
| Web UI 的設計與資料語意 | [`worklog-ui`](.agents/skills/worklog-ui/SKILL.md) |
| Web 程式碼規範（Vue、TypeScript、Pinia store、query key） | [`worklog-web-code-style`](.agents/skills/worklog-web-code-style/SKILL.md) |
| storage、server、MCP（migration、錯誤代碼、效能規則、新資料表的匯出與刪除） | [`worklog-backend`](.agents/skills/worklog-backend/SKILL.md) |
| 所有檔案的程式碼擺放順序（先宣告後使用、生命週期位置等，`pnpm lint` 會檢查） | [`worklog-code-layout`](.agents/skills/worklog-code-layout/SKILL.md) |
| Agent 如何使用 Work Intelligence 的 MCP 工具 | [`work-intelligence`](.agents/skills/work-intelligence/SKILL.md) |

開發流程、健康檢查與 PR 規則見 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 文件索引

| 文件 | 內容 |
|---|---|
| [docs/user-guide.md](docs/user-guide.md) | 安裝、正式模式、日常使用、報告、Knowledge、備份、刪除、換電腦與升級 |
| [docs/release.md](docs/release.md) | SemVer、發行前檢查、tag-only GitHub Release 與跨版本升級 |
| [docs/release-checklist.md](docs/release-checklist.md) | 各平台實機驗收步驟與使用者結果欄位；未執行的項目保持待驗收 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | API 連線、port、MCP、全域 hook、還原、匯入與維護的常見問題 |
| [docs/service.md](docs/service.md) | macOS、Windows 與 Linux 的使用者層級登入自動啟動、移除與疑難排解 |
| [docs/agent-setup.md](docs/agent-setup.md) | 註冊到 Codex CLI、Claude Code、Claude Desktop，以及全域保存提醒 hook |
| [docs/plugins.md](docs/plugins.md) | Claude Code／Codex plugin：安裝、`pnpm plugin:link` 與從手動註冊切換 |
| [docs/mcp-tools.md](docs/mcp-tools.md) | 每個 MCP tool 的用途、欄位、範例、policy 行為、annotations 與 prompts |
| [docs/rest-api.md](docs/rest-api.md) | REST endpoints、metadata backfill、報告匯出、備份、專案資料匯出／匯入、刪除與即時更新串流 |
| [docs/work-record-and-report-format.md](docs/work-record-and-report-format.md) | Session 五段格式、報告粒度與回填邊界 |
| [docs/architecture.md](docs/architecture.md) | 資料契約、一致性與輸入邊界、Recording Policy、設計原則 |
| [docs/testing.md](docs/testing.md) | 測試指令、覆蓋率、效能、檢索品質與無障礙門檻，以及 E2E 範圍 |
| [docs/status.md](docs/status.md) | 專案現況、未結項與暫緩項目 |
| [docs/ui-redesign-plan.md](docs/ui-redesign-plan.md) | Web UI 改版的決策與實作紀錄 |
| [docs/five-feature-integration-research.md](docs/five-feature-integration-research.md) | 五項功能整合先行研究：UIUX、演算法、安全與分階段驗收；尚未實作 |
| [CHANGELOG.md](CHANGELOG.md) | 版本變更紀錄 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 開發流程、健康檢查、PR 與工作記錄規則 |
| [SECURITY.md](SECURITY.md) | 威脅模型、本機安全邊界與私密漏洞回報方式 |

## 授權

[MIT](LICENSE)
