# 註冊到 Codex 與 Claude

把 Work Intelligence MCP stdio server 註冊到 Codex CLI、Claude Code 與 Claude Desktop，並完成第一次使用。

> 回到 [README](../README.md)

這個 MCP 是本機 stdio server。`http://127.0.0.1:5966` 是 Dashboard，不是 MCP endpoint；Codex 與 Claude 會各自啟動 `pnpm.cmd`，並共用同一個中央 SQLite。

## 共用準備

在註冊 MCP 前，先安裝依賴並建立 MCP 的 production build：

以下範例的 `C:\path\to\WorkLog.Ai` 請替換成實際專案目錄。

```powershell
cd C:\path\to\WorkLog.Ai
pnpm install
pnpm build
```

建議所有 client 都明確指定同一個 database path：

```text
C:\path\to\WorkLog.Ai\data\work-intelligence.sqlite
```

## Codex CLI

使用 `codex mcp add` 註冊本機 stdio server：

```powershell
codex mcp add work-intelligence --env "WORK_INTELLIGENCE_DB=C:\path\to\WorkLog.Ai\data\work-intelligence.sqlite" -- pnpm.cmd --dir "C:\path\to\WorkLog.Ai" start:mcp
```

確認設定：

```powershell
codex mcp list
codex mcp get work-intelligence
```

如果已經存在同名設定，可以先移除再重新加入：

```powershell
codex mcp remove work-intelligence
```

## Claude Code

使用 `user` scope，讓 Claude Code 在不同 workspace 都能使用這個工具：

```powershell
claude mcp add --scope user --transport stdio work-intelligence --env "WORK_INTELLIGENCE_DB=C:\path\to\WorkLog.Ai\data\work-intelligence.sqlite" -- pnpm.cmd --dir "C:\path\to\WorkLog.Ai" start:mcp
```

確認設定與連線狀態：

```powershell
claude mcp list
claude mcp get work-intelligence
```

進入 Claude Code 後，也可以輸入 `/mcp` 查看 server 和 tools。若同名設定已存在：

```powershell
claude mcp remove work-intelligence
```

Claude Code 的 `--` 後方是實際啟動 MCP server 的 command；`--scope user` 會將設定套用到使用者層級。詳見 [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp)。

MCP server 的工具清單會在 Codex／Claude host 建立連線時載入。更新 Work Intelligence 的 MCP contract（例如新增 `work_update_session_work_summary`）後，請先重新執行 `pnpm build`，再重新啟動或重新連線目前的 Codex／Claude 對話；若工具清單仍是舊的，請移除並重新加入 `work-intelligence` MCP 設定。只要 host 尚未重新載入，舊對話即使連到同一個 SQLite，也不會看到新工具。

## Claude Desktop

如果使用的是 Claude Desktop GUI，將以下內容合併到 Windows 設定檔：

```text
%APPDATA%\Claude\claude_desktop_config.json
```

```json
{
  "mcpServers": {
    "work-intelligence": {
      "command": "pnpm.cmd",
      "args": ["--dir", "C:\\path\\to\\WorkLog.Ai", "start:mcp"],
      "env": {
        "WORK_INTELLIGENCE_DB": "C:\\path\\to\\WorkLog.Ai\\data\\work-intelligence.sqlite"
      }
    }
  }
}
```

如果檔案原本已有其他 `mcpServers`，只加入 `work-intelligence`，不要整份覆蓋。儲存後重新啟動 Claude Desktop，再從聊天框的 `+` → `Connectors` 確認 tools。Claude Desktop 的 local MCP 與 Claude.ai/Cowork 的 remote connector 是不同機制；目前這個 MVP 適用於 Claude Desktop 與 Claude Code，不能直接從 Claude.ai 使用本機 stdio server。詳見 [Claude Desktop local MCP guide](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop) 與 [Claude custom connector notes](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)。

## 第一次使用

先啟動 Dashboard 與 REST API：

```powershell
cd C:\path\to\WorkLog.Ai
pnpm dev
```

開啟 <http://127.0.0.1:5966>，進入左側選單的「專案」：

1. 按「加入專案」填入要記錄的 workspace。
2. 將該專案狀態切換成「記錄中」，並在確認對話框中同意。
3. 在 Codex 或 Claude Code 中測試 `work_get_context`。
4. Agent 完成既有 planning → execution → verification → closing 後，呼叫 `work_finalize_session`。

可以用以下提示測試：

```text
請使用 work_get_context，projectRoot 為
C:\path\to\WorkLog.Ai
```

完成工作時：

```text
完成這次工作後，請呼叫 work_finalize_session。
projectRoot 為 C:\path\to\WorkLog.Ai，
請提供唯一的 idempotencyKey、title、summary、workSummary（成果／範圍／決策／驗證／狀態與未結項五個陣列）、changedFiles 與 verification。
```

如果專案還是 `unregistered`、`paused` 或 `ignored`，MCP 會回傳 `outcome: "skipped"`，不會讀取或保存 handoff、Git、source 資料；這是 default-deny 的預期行為。
