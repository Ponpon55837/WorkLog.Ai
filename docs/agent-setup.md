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

### 保存提醒（選用）

工作記錄要靠 Agent 記得保存。Claude Code 與 Codex 都能加 Stop hook：在「記錄中」的專案裡，Agent 上次保存之後又改了檔案、這一輪結束卻還沒保存時，提醒它一次；同一段未保存工作只提醒一次。Agent 若判斷工作還沒完成，直接結束即可。

#### Claude Code

先執行 `pnpm build`，再把下面的設定加到 `~/.claude/settings.json`（路徑換成你的 repo 位置）：

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/WorkLog.Ai/apps/mcp/dist/finalize-reminder.js",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

- 只讀取 transcript 與專案清單（SQLite 唯讀開啟），不寫入資料庫；資料庫位置同樣可用 `WORK_INTELLIGENCE_DB` 指定。
- 「改了檔案」以 Edit／Write／MultiEdit／NotebookEdit 判斷；只用 Bash 改檔不會觸發。
- 讀不到資料或判斷失敗時一律放行，不會擋住 Agent。

#### Codex

本 repo 已附上專案層級的 `.codex/hooks.json` 與 `apps/mcp/src/codex-finalize-reminder.ts`。它在 Codex 使用 `apply_patch` 改檔後標記未保存工作；成功呼叫 `work_finalize_session` 會清除標記；Stop 時若仍有未保存的改動，就提醒一次。只用 Bash 改檔不會觸發。

先執行 `pnpm --filter @work-intelligence/mcp build`，讓 hook script 出現在 `apps/mcp/dist/`。重新載入專案後，在 Codex 輸入 `/hooks`，檢查並信任 Work Intelligence 保存提醒 hook；Codex 會先略過尚未信任的專案 hook。

- 只讀取專案清單（SQLite 唯讀開啟），不寫入資料庫；資料庫位置可用 `WORK_INTELLIGENCE_DB` 指定。
- hook marker 僅存放在目前使用者的暫存目錄，以權限 `0700` 建立資料夾、`0600` 建立標記檔；不儲存 Session 內容。
- 只要讀不到資料或判斷失敗，就放行 Codex。
- Windows 上 Codex 預設會透過 `cmd.exe /C` 執行 hook；`commandWindows` 因此明確啟動 `powershell.exe`，並用 `-EncodedCommand` 傳入指令，避免把 POSIX 的 `$(...)` 寫法交給 `cmd.exe`。PowerShell 會從 hook 的工作目錄執行 `git rev-parse --show-toplevel`，再組出 hook 腳本路徑，所以可從 repo 子目錄啟動，也可處理含空白的路徑。
- Windows CI 會從 `apps/mcp` 子目錄以 `cmd.exe /d /s /c` 執行 `.codex/hooks.json` 中的原始 `commandWindows`，並把格式錯誤的輸入傳給 hook，確認指令可啟動且會放行。實際 Windows Codex 安裝仍可在信任 hook 後用 `/hooks` 確認載入；官方說明見 [Codex hooks](https://developers.openai.com/docs/hooks) 與 [Codex command runner](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/engine/command_runner.rs)。

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
3. 在 Codex 或 Claude Code 中確認連線與記錄狀態。
4. Agent 完成既有 planning → execution → verification → closing 後，請它保存這次工作。

平常只需要用自然語言；工具名稱、JSON 與呼叫順序由 Agent 依 [`work-intelligence` skill](../.agents/skills/work-intelligence/SKILL.md) 處理。可以用以下提示測試：

```text
這個專案有在 Work Intelligence 記錄嗎？順便看一下最近做了什麼。
```

Agent 會先查詢記錄狀態（`work_get_project_status`），再取回 context（`work_get_context`）。完成工作時：

```text
完成了，請把這次工作記錄到 Work Intelligence。
```

Claude Code 也可以直接使用 MCP prompts：`/mcp__work-intelligence__finalize-work`（保存這次工作）與 `/mcp__work-intelligence__synthesize-report`（整理報告，可帶 `period`）。

連線正確時，`/mcp` 會列出 31 個工具與 2 個 prompts；查詢類工具帶有 `readOnlyHint`，可以在用戶端的權限設定中放行。完整清單見 [mcp-tools.md](mcp-tools.md)。

如果專案還是 `unregistered`、`paused` 或 `ignored`，Agent 會在記錄狀態查詢時就停下來，MCP 也會回傳 `outcome: "skipped"`，不會讀取或保存 handoff、Git、source 資料；這是 default-deny 的預期行為。Agent 無法替你切換成「記錄中」，這一步只能在 Web UI 完成。
