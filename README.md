# Work Intelligence

**本機優先的開發工作記憶。** Codex、Claude 等 Agent 完成一段工作後，會把「做了什麼、改了哪些檔案、怎麼驗證」寫進你電腦上的一個 SQLite 檔案。你可以在 Web UI 回顧工作歷程，產生日、週、月、季、年或自訂期間的報告；之後 Agent 開工前或遇到錯誤時，也能從這裡找回過去的工作與 Knowledge。

- 🔒 **預設不記錄**：只有你明確設為「記錄中」的專案才會被讀取與保存，其他專案一律略過。
- 🏠 **資料只在本機**：API 只接受 `127.0.0.1` 的連線，不會把資料送到遠端，也不會在你的專案 repo 裡寫入設定檔。
- 🧾 **可追溯**：每筆摘要與報告結論都能回到來源 Session、檔案與證據。changed files 不等於 Git commit，也不會替 Agent 猜測驗證結果；修正與作廢都會留下紀錄。
- 💾 **帶得走、刪得掉**：每日自動備份、整份 SQLite 快照、單一或全部專案的 JSON 匯出與合併匯入，也可以永久刪除單一專案的資料。
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

需求：**Node.js 22.5 以上**（建議 24，會用到內建的 `node:sqlite`）與 **pnpm 11**（版本見 `package.json` 的 `packageManager`）。

```bash
pnpm install
pnpm build
pnpm start
```

`pnpm start` 是正式模式：由同一個 process、同一個 port 提供 Web UI 與 REST API。終端機保持執行，按 `Ctrl+C` 停止。

| 項目 | 位置 |
|---|---|
| Web UI | <http://127.0.0.1:3210> |
| REST API | <http://127.0.0.1:3210/api/health>（回傳程式版本與 schema 版本） |
| SQLite | `data/work-intelligence.sqlite`（可用 `WORK_INTELLIGENCE_DB` 指定） |

第一次使用前，建議先執行診斷：

```bash
pnpm run doctor
```

請用 `pnpm run doctor`，不要用 `pnpm doctor`：pnpm 11 把 `doctor` 保留給自己的命令，不會執行 Work Intelligence 的診斷。它會唯讀檢查 Node.js、pnpm、build 檔案、資料庫健康與 schema 版本、最近的備份與維護、API 是否可連線、MCP 是否已註冊，以及全域保存提醒 hook，並用繁體中文列出修正建議。輸出不含任何工作記錄內容。

開啟 Web UI 之後：

1. 左側選單 →「專案」→「加入專案」，按「選擇資料夾」挑選要記錄的專案資料夾，也可以直接輸入路徑。
2. 把狀態切換成「記錄中」。確認對話框會說明允許讀取的範圍。
3. [連接 Agent](#連接-codexclaude)。之後完成的工作就會出現在「工作歷程」。

側欄底部會顯示目前的程式版本與 schema 版本。

## 連接 Codex／Claude

Work Intelligence 的 MCP 是**本機 stdio server**，由 Agent 自己啟動，不使用 Web 的 HTTP port。先執行一次 `pnpm build`，再依你的 Agent 註冊。請用絕對路徑，讓 API、MCP 與 CLI 使用同一個資料庫。

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

Claude Code 另外提供兩個 MCP prompts：`/mcp__work-intelligence__finalize-work` 與 `/mcp__work-intelligence__synthesize-report`。Claude Desktop 的設定、驗證方式與常見問題見 **[docs/agent-setup.md](docs/agent-setup.md)**。更新 Work Intelligence 後，請重新 `pnpm build`，並重新啟動或重新連線 Agent，它才會載入新的工具清單。

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
| 取回專案脈絡 | 「先看一下 Work Intelligence 裡這個專案最近做了什麼。」 | 工作歷程、工作知識 |
| 查過去的工作或錯誤 | 「之前有處理過報告時區的問題嗎？」或直接貼上錯誤訊息（Agent 用 `work_recall` 排序檢索 Session、raw handoff 與 Knowledge） | 工作歷程搜尋（多個關鍵字時每個都要命中） |
| 整理報告 | 「幫我整理這週的 Work Intelligence 報告。」（沒有請求時 Agent 會自己建立；自訂期間也可以） | 工作報告 →「請 Agent 整理這份報告」，Agent 完成後頁面會自動更新 |
| 整理 Knowledge 候選 | 「幫我整理 Work Intelligence 的 Knowledge 候選。」 | 工作知識 →「整理候選」，接受（可先修改）或拒絕後才會成為 Knowledge |
| 補齊缺漏的 metadata | 「幫我補齊 Work Intelligence 的 metadata 缺口。」（沒有請求時 Agent 會自己建立） | 專案 → Metadata 回補 →「掃描 metadata 缺口」 |
| 修正已保存的摘要 | 「幫我修正上一筆 Session 的摘要：……」 | Session 面板 →「編輯 Session」 |
| 連結相關的工作 | 「這次是接續昨天那筆規劃的實作。」 | Session 面板 →「關聯 Session」 |
| 撤掉記錯的 Session | 「上一筆記到錯的專案，請作廢。」（可還原） | Session 面板 →「作廢」 |
| 匯入歷史 handoff | 「幫我預覽這個專案可以匯入的 handoff。」 | 專案 → Handoff 匯入 |

每筆 Session 都有一句話摘要，以及固定的五段內容：**成果／範圍／決策／驗證／狀態與未結項**。格式與報告粒度見 [Work record and report format v1](docs/work-record-and-report-format.md)。

更完整的操作說明見 **[使用手冊](docs/user-guide.md)**。

## Web UI 導覽

GitHub 深色風格的介面，左側選單分三組。長清單都在各自的框內捲動，不會把整頁撐長。

| 頁面 | 用途 |
|---|---|
| **總覽** | 本週 Sessions、驗證分布、待處理事項（等待 Agent 的報告整理或 metadata 回補）、最近工作 |
| **工作歷程** | 多關鍵字搜尋，並依專案、日期篩選所有 Session。點任一筆會從右側開啟詳情（開始時間、耗時、最後更新），`J`/`K` 切換上下筆。「編輯 Session」可修正主摘要、五段內容與 verification（會留下修改紀錄），也可以建立 Session 關聯、作廢或還原，並逐筆標示錯誤的 Evidence。Agent 新存的 Session 會自動出現 |
| **工作報告** | 日、週、月、季、年與自訂期間（最長 366 天）的報告，依系統時區切日，頁首會標示時區。總覽依期間分組（當日 Session、每日／每週／每月／每季分布、專案占比）；另有 AI 報告整理（每段附來源 Session）、趨勢、風險、跨期工作（更早開始、之後完成、事後修改）、原始紀錄與來源證據，資料超過上限時會提醒。可匯出 Markdown／JSON |
| **工作知識** | Agent 明確提交的決策、模式、注意事項、流程與技能，以及待審核的 Knowledge 候選。相關檔案被改動時標示「可能過時」，被 Session 推翻時標示「需要檢視」；可以「確認仍有效」、編輯、封存與查看變更紀錄 |
| **工作圖譜** | Project、Session、Knowledge、Evidence、檔案與 Session 關聯的關係圖 |
| **專案** | 專案清單與記錄狀態（加入時可用系統視窗選資料夾）、永久刪除專案、Metadata 回補、Handoff 匯入、資料備份（備份、匯出、匯入） |

快捷鍵：`Ctrl`/`⌘` + `K` 搜尋或跳頁，`/` 聚焦頁面搜尋，`g` + `d`／`s`／`r`／`k`／`g`／`p` 切換頁面。篩選條件與開啟中的 Session 都會寫進網址，可以直接分享或重新整理。

API 無法連線時，頁面上方會顯示「無法連線到 Work Intelligence API」，連線恢復後會自動重新載入目前的資料。

## 備份、換電腦與刪除

所有記錄都在一個 SQLite 檔案裡。

- **自動備份**：API server 每個本機日曆日自動備份一次，存到資料庫旁的 `backups/`。自動備份與手動備份分開保留，預設各保留最近 14 份，手動備份不會擠掉每日自動備份。備份檔只有目前的使用者可以讀寫。
- **手動備份**：Web UI 的「專案 → 資料備份 → 立即備份」，或執行 `pnpm db:backup`。
- **管理備份**：「專案 → 資料備份」會列出備份種類、時間、大小與總大小；刪除前會顯示檔名與種類並要求確認，刪除唯一一份列出的備份時會額外警告。CLI 可用 `pnpm db:backups` 列出，或在互動終端執行 `pnpm db:backups --delete <檔名>` 確認刪除。刪除專案後，刪除前備份與其他舊備份仍可能包含該專案資料，可從資料備份頁管理。
- **依專案攜帶資料**：在「專案 → 資料備份」可以匯出全部專案或單一專案的 JSON。CLI 用 `pnpm db:export --all` 或 `pnpm db:export --project <專案名稱或 id>`，加上 `--out <檔案.json>` 可以指定輸出位置。JSON 沒有加密，請妥善保管。
- **合併匯入**：
  - 在同一個分頁選擇 JSON 檔，先看新增、略過、衝突與路徑轉換的預覽，再確認匯入。
  - CLI：`pnpm db:import <檔案.json> --dry-run` 只預覽；在互動終端執行 `pnpm db:import <檔案.json> --remap-root <舊路徑>=<新路徑>`，輸入 `yes` 後才寫入。
  - 可以重複執行，不會覆寫既有資料；新匯入的專案會先暫停。
  - 匯入透過正在運作的 API／SQLite 合併，不必先停服務。
- **路徑轉換**：`--remap-root` 可以重複使用，以完整的路徑片段比對。Windows 路徑不分大小寫，並依新路徑轉換分隔符號。它只調整匯入資料裡的專案根路徑與 handoff 來源路徑，不會用匯入的路徑讀寫檔案。
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
- **Verification 有四種狀態**：通過、失敗、明確未執行（`not_run`）、未回報（歷史資料沒有提供）。
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

威脅模型與漏洞回報方式見 [SECURITY.md](SECURITY.md)。

## 專案結構與開發

```text
apps/
  web/       Vue 3 + Vite Web UI（GitHub-dark design system）
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
pnpm start:server             # 只啟動 API
pnpm start:mcp                # 只啟動 MCP stdio server
pnpm run doctor               # 唯讀診斷
pnpm db:backup                # 立即備份（db:export、db:import、db:restore 見上方）
pnpm db:backups               # 列出備份；加 --delete <檔名> 可互動確認刪除
pnpm db:maintain              # 離線維護（需先停止 server 與 MCP）
pnpm test                     # ESLint、Prettier 檢查，以及各 package 與 Web 單元測試
pnpm test:coverage            # 覆蓋率（schema、storage、server、mcp、web 各有門檻）
pnpm test:performance         # 合成資料的讀取路徑效能門檻（需先 build）
pnpm test:retrieval-quality   # 合成資料的 work_recall 檢索品質門檻（hit@5、MRR）
pnpm typecheck                # packages、Vue 與 E2E 型別
pnpm test:e2e                 # build 後以正式模式跑 Playwright（Chromium 全套、Firefox 核心流程），使用獨立的暫存 SQLite
pnpm format                   # 用 Prettier 格式化整個 repo
```

CI 在 Ubuntu、Windows、macOS 跑 build、test、typecheck 與 coverage；Ubuntu 另外跑效能與檢索品質門檻，以及 Chromium／Firefox E2E（Chromium 含六個主要頁面的 axe 無障礙檢查）。細節見 [docs/testing.md](docs/testing.md)。

其他設定：

- `WORK_INTELLIGENCE_DB`：SQLite 位置。
- `WORK_INTELLIGENCE_PORT`：正式模式的 port，預設 `3210`。
- `WORK_INTELLIGENCE_ALLOWED_ORIGINS`：正式模式同源，不需要額外設定。開發模式或自訂來源使用非預設的 Web origin 時，在 `.env` 設定這個變數（逗號分隔，不能用 `*`），其中的主機也會加入 API 的 `Host` 白名單。
- 報告與日期篩選依 server 所在的系統時區切日（Node 會遵守 `TZ` 環境變數）。

改 Web UI 前請先看共用 skill：[`worklog-ui`](.agents/skills/worklog-ui/SKILL.md)（設計與資料語意）與 [`worklog-web-code-style`](.agents/skills/worklog-web-code-style/SKILL.md)（程式碼規範）。開發流程、健康檢查與 PR 規則見 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 文件索引

| 文件 | 內容 |
|---|---|
| [docs/user-guide.md](docs/user-guide.md) | 安裝、正式模式、日常使用、報告、Knowledge、備份、刪除、換電腦與升級 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | API 連線、port、MCP、全域 hook、還原、匯入與維護的常見問題 |
| [docs/agent-setup.md](docs/agent-setup.md) | 註冊到 Codex CLI、Claude Code、Claude Desktop，以及全域保存提醒 hook |
| [docs/mcp-tools.md](docs/mcp-tools.md) | 每個 MCP tool 的用途、欄位、範例、policy 行為、annotations 與 prompts |
| [docs/rest-api.md](docs/rest-api.md) | REST endpoints、metadata backfill、報告匯出、備份、專案資料匯出／匯入、刪除與即時更新串流 |
| [docs/work-record-and-report-format.md](docs/work-record-and-report-format.md) | Session 五段格式、報告粒度與回填邊界 |
| [docs/architecture.md](docs/architecture.md) | 資料契約、一致性與輸入邊界、Recording Policy、設計原則 |
| [docs/testing.md](docs/testing.md) | 測試指令、覆蓋率、效能、檢索品質與無障礙門檻，以及 E2E 範圍 |
| [docs/status.md](docs/status.md) | 專案現況、未結項與暫緩項目 |
| [docs/ui-redesign-plan.md](docs/ui-redesign-plan.md) | Web UI 改版的決策與實作紀錄 |
| [CHANGELOG.md](CHANGELOG.md) | 版本變更紀錄 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 開發流程、健康檢查、PR 與工作記錄規則 |
| [SECURITY.md](SECURITY.md) | 威脅模型、本機安全邊界與私密漏洞回報方式 |

## 授權

[MIT](LICENSE)
