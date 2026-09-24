# Work Intelligence

**Local-first 的開發工作記憶。** Codex／Claude 等 Agent 完成一次工作後，把「做了什麼、改了哪些檔案、怎麼驗證的」寫進本機的中央 SQLite；你可以在 Web UI 回顧工作歷程、產生日／週／月報，後續 Agent 也能從這裡取回脈絡。

- 🔒 **預設不記錄**：只有你明確切換為「記錄中」的專案會被讀取與保存，其他專案一律安靜略過。
- 🏠 **資料只在本機**：API 只綁 `127.0.0.1`，不會往任何專案 repo 寫設定檔。
- 🧾 **可追溯**：每筆摘要、報告結論都能回到來源 Session、檔案與證據；不把 changed files 當成 Git commit，也不替 Agent 猜測驗證結果。

---

## 目錄

- [快速開始](#快速開始)
- [連接 Codex／Claude](#連接-codexclaude)
- [日常使用](#日常使用)
- [Web UI 導覽](#web-ui-導覽)
- [核心概念](#核心概念)
- [專案結構與開發](#專案結構與開發)
- [文件索引](#文件索引)

## 快速開始

需求：**Node.js 22.5+**（建議 24+，使用內建 `node:sqlite`）與 **pnpm**。

```powershell
pnpm install
pnpm build
pnpm dev
```

| 服務 | 位址 |
|---|---|
| Web UI | <http://127.0.0.1:5966> |
| REST API | <http://127.0.0.1:3210/api/health> |
| SQLite | `data/work-intelligence.sqlite`（可用 `WORK_INTELLIGENCE_DB` 指定） |

第一次開啟 Web UI 後：

1. 左側選單 →「專案」→「加入專案」，填入要記錄的 workspace 路徑。
2. 把狀態切換成「記錄中」（會跳出確認對話框說明允許讀取的範圍）。
3. [連接 Agent](#連接-codexclaude)，之後完成的工作就會出現在「工作歷程」。

## 連接 Codex／Claude

Work Intelligence 的 MCP 是**本機 stdio server**（`5966` 是 Web UI，不是 MCP endpoint）。先執行一次 `pnpm build`，再依你的 Agent 註冊：

```powershell
# Codex CLI
codex mcp add work-intelligence --env "WORK_INTELLIGENCE_DB=C:\path\to\WorkLog.Ai\data\work-intelligence.sqlite" -- pnpm.cmd --dir "C:\path\to\WorkLog.Ai" start:mcp

# Claude Code（user scope，所有 workspace 都可用）
claude mcp add --scope user --transport stdio work-intelligence --env "WORK_INTELLIGENCE_DB=C:\path\to\WorkLog.Ai\data\work-intelligence.sqlite" -- pnpm.cmd --dir "C:\path\to\WorkLog.Ai" start:mcp
```

Claude Code 另外提供兩個 MCP prompts：`/mcp__work-intelligence__finalize-work`、`/mcp__work-intelligence__synthesize-report`。Claude Desktop 設定、驗證方式與常見問題見 **[docs/agent-setup.md](docs/agent-setup.md)**。更新 MCP 後請重新 `pnpm build` 並重新連線 Agent，才會載入新的工具清單。

## 日常使用

你只需要用自然語言跟 Agent 說話；工具名稱、request ID、JSON 都由 Agent 處理（規則寫在 [`.agents/skills/work-intelligence`](.agents/skills/work-intelligence/SKILL.md)）。

| 想做的事 | 在 Agent 對話中說 | 或在 Web UI |
|---|---|---|
| 確認有沒有在記錄 | 「這個專案有在 Work Intelligence 記錄嗎？」 | 專案 |
| 保存這次工作 | 「完成了，請把這次工作記錄到 Work Intelligence。」（非記錄中的專案會直接略過） | — |
| 取回專案脈絡 | 「先看一下 Work Intelligence 裡這個專案最近做了什麼。」 | 工作歷程、工作知識 |
| 整理報告 | 「幫我整理這週的 Work Intelligence 報告。」（沒有請求時 Agent 會自己建立） | 工作報告 →「請 Agent 整理這份報告」 |
| 補齊缺漏的 metadata | 「幫我補齊 Work Intelligence 的 metadata 缺口。」（沒有請求時 Agent 會自己建立） | 專案 → Metadata 回補 →「掃描 metadata 缺口」 |
| 修正已保存的摘要 | 「幫我修正上一筆 Session 的摘要：……」 | Session 面板 →「編輯摘要」 |
| 匯入歷史 handoff | 「幫我預覽這個專案可以匯入的 handoff。」 | 專案 → Handoff 匯入 |

每筆 Session 都包含一句話摘要與固定五段內容：**成果／範圍／決策／驗證／狀態與未結項**。格式與報告粒度見 [Work record and report format v1](docs/work-record-and-report-format.md)。

## Web UI 導覽

GitHub 深色風格的介面，左側選單分三組：

| 頁面 | 用途 |
|---|---|
| **總覽** | 本週 Sessions、驗證分布、待處理事項（等待 Agent 的報告整理或 metadata 回補）、最近工作 |
| **工作歷程** | 搜尋與依專案／日期篩選所有 Session；點任一筆從右側開啟詳情，`J`/`K` 切換上下筆，「編輯摘要」可直接修正主摘要與五段內容 |
| **工作報告** | 日／週／月／季／年報告（依系統時區切日，頁首標示時區）、AI 報告整理（每段附來源 Session）、趨勢、風險、原始紀錄、來源證據；可匯出 Markdown／JSON |
| **工作知識** | Agent 明確提交的決策、模式、注意事項、流程與技能；可編輯、封存與查看變更紀錄 |
| **工作圖譜** | Project、Session、Knowledge、Evidence、檔案之間的關聯圖 |
| **專案** | 專案清單與記錄狀態、Metadata 回補、Handoff 匯入 |

快捷鍵：`Ctrl`/`⌘` + `K` 搜尋或跳頁、`/` 聚焦頁面搜尋、`g` + `d`／`s`／`r`／`k`／`g`／`p` 切換頁面。篩選條件與開啟中的 Session 都會寫進網址，可以直接分享或重新整理。

## 核心概念

**專案記錄狀態（default deny）**

| 狀態 | 意義 |
|---|---|
| 未註冊 `unregistered` | 剛加入的預設值，不讀取、不保存 |
| 記錄中 `tracked` | 你明確授權；Agent 可讀取 handoff／Git／source 並保存工作紀錄 |
| 已暫停 `paused` | 暫停記錄，既有資料保留 |
| 已忽略 `ignored` | 明確排除 |

非「記錄中」的專案，所有 Agent 請求都會回傳 `skipped`，不會讀取任何檔案。

**幾個容易混淆的區分**

- **Finalize ≠ Git commit**：一次工作可以沒有 commit；changed files 只代表檔案曾變動。
- **Verification 四種狀態分開**：通過、失敗、明確未執行（`not_run`）、未回報（歷史資料沒有提供）。
- **報表數字 ≠ AI 摘要**：統計與趨勢由系統 deterministic 計算；AI 整理的每段結論都必須引用來源 Session，資料不足時會直接寫「資料不足」。
- **Knowledge 只收明確提交**：不會從 handoff 或原始碼自動抽取。
- **摘要可修正，其他欄位不改**：主摘要與五段 workSummary 可由 Agent 或 Session 面板就地修正（同一筆 Session、留 audit）；changed files、verification、events、evidence 在 UI 維持唯讀。

更完整的資料契約、一致性保證與設計原則見 [docs/architecture.md](docs/architecture.md)。

## 專案結構與開發

```text
apps/
  web/       Vue 3 + Vite Web UI（GitHub-dark design system）
  server/    REST API + SQLite application host
  mcp/       MCP stdio server
packages/
  core/            domain types 與 extension interfaces
  schema/          Zod 輸入契約
  storage/         SQLite schema 與 work/session service
  project-policy/  default-deny policy gate 與安全路徑
  shared/          共用常數與 helpers
data/              本機 SQLite（不進版控）
```

```powershell
pnpm dev            # API + Web UI（開發模式）
pnpm start:server   # 只啟動 API
pnpm start:mcp      # 只啟動 MCP stdio server
pnpm test           # lint + Prettier check + 各 package 測試
pnpm format         # 用 Prettier 格式化整個 repo
pnpm typecheck      # packages + Vue + e2e 型別
pnpm test:e2e       # Playwright（獨立暫存 SQLite，不影響你的資料）
```

設定：`WORK_INTELLIGENCE_DB` 指定 SQLite 位置；Web UI 若不是從 `127.0.0.1:5966` 連線，請在 `.env` 設定 `WORK_INTELLIGENCE_ALLOWED_ORIGINS`（逗號分隔，不要用 `*`），其中的主機也會加入 API 的 `Host` 白名單。報告與日期篩選依 server 所在的系統時區切日（Node 會遵守 `TZ` 環境變數）。

改 Web UI 前請先看共用 skill：[`worklog-ui`](.agents/skills/worklog-ui/SKILL.md)（設計與資料語意）與 [`worklog-web-code-style`](.agents/skills/worklog-web-code-style/SKILL.md)（程式碼規範）。

## 文件索引

| 文件 | 內容 |
|---|---|
| [docs/agent-setup.md](docs/agent-setup.md) | 註冊到 Codex CLI、Claude Code、Claude Desktop 與第一次使用 |
| [docs/mcp-tools.md](docs/mcp-tools.md) | 每個 MCP tool 的用途、欄位、範例、policy 行為、annotations 與 prompts |
| [docs/rest-api.md](docs/rest-api.md) | REST endpoints、metadata backfill、報告匯出 |
| [docs/work-record-and-report-format.md](docs/work-record-and-report-format.md) | Session 五段格式、報告粒度與回填邊界 |
| [docs/architecture.md](docs/architecture.md) | 資料契約、一致性與輸入邊界、Recording Policy、設計原則 |
| [docs/testing.md](docs/testing.md) | 測試指令、覆蓋率門檻與 E2E 範圍 |
| [docs/ui-redesign-plan.md](docs/ui-redesign-plan.md) | Web UI 改版的決策與實作紀錄 |
| [docs/status.md](docs/status.md) | 專案現況、未結項與最近完成的工作 |
