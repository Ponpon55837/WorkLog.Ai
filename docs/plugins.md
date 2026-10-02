# Claude Code 與 Codex plugin

以 plugin 安裝 Work Intelligence 的 MCP server、agent skill 與保存提醒，不必手動編輯 Agent 設定檔。

> 回到 [README](../README.zh-TW.md)（[English](../README.md)）｜手動註冊與 `pnpm setup:agents` 見 [註冊到 Codex 與 Claude](agent-setup.md)

## 它是什麼、不是什麼

`plugins/work-intelligence/` 是一個同時給 Claude Code 與 Codex 用的本機 plugin。它**不內含** Work Intelligence 本身，只帶一支啟動器 `scripts/launch.mjs`：啟動器找到你本機的 WorkLog.Ai checkout，執行和 `pnpm setup:agents` 註冊的同一支 `apps/mcp/dist/index.js`。因此：

- **資料庫位置不變**：預設仍是 repo 的 `data/work-intelligence.sqlite`；Agent 環境有設 `WORK_INTELLIGENCE_DB` 時照樣使用它。plugin 不會建立第二個資料庫。
- **原本的用法不受影響**：Web UI、REST API、CLI、`pnpm setup:agents`、手動 `claude mcp add`／`codex mcp add` 都照舊。plugin 不寫入、不移除任何既有設定。
- **更新方式不變**：在 repo 執行 `git pull`、`pnpm install`、`pnpm build`；plugin 直接使用新的 build，重新連線提示也和原本一樣。

| 內容 | Claude Code | Codex |
|---|---|---|
| MCP server `work-intelligence` | ✓ | ✓ |
| `work-intelligence` skill（與 `.agents/skills/work-intelligence/SKILL.md` 相同） | ✓ | ✓ |
| 保存提醒 Stop hook | ✓ | ✗（Codex 的 hook 仍依 [保存提醒](agent-setup.md#保存提醒選用) 設定） |

## 共用準備

```bash
cd /path/to/WorkLog.Ai
pnpm install
pnpm build
pnpm plugin:link
```

`pnpm plugin:link` 把這個 checkout 的路徑寫進 `~/.work-intelligence/plugin-link.json`（可用 `WORK_INTELLIGENCE_CONFIG_DIR` 改目錄），只寫這一個檔。Agent 把 plugin 複製到自己的快取後，啟動器靠它找回 repo。`pnpm plugin:link --remove` 會刪除它。

啟動器依序尋找 repo：環境變數 `WORK_INTELLIGENCE_HOME` → plugin 本身所在的 repo（從本 repo 的 marketplace 原地載入時）→ `plugin-link.json`。找不到或還沒 build 時，MCP 會在 stderr 說明原因並結束；保存提醒 hook 則靜默放行，不會擋住 Agent。

## Claude Code

```bash
claude plugin marketplace add /path/to/WorkLog.Ai
claude plugin install work-intelligence@worklog-ai
```

也可以在 Claude Code 內輸入 `/plugin marketplace add /path/to/WorkLog.Ai`，再從 `/plugin` 安裝。repo 根目錄的 `.claude-plugin/marketplace.json` 列出這個 plugin。從本機目錄加入的 marketplace 會原地載入 plugin，所以 Claude Code 不一定需要 `plugin-link.json`，但先執行 `pnpm plugin:link` 也無妨。

plugin 的 MCP server 由 Claude Code 以 plugin 名稱區分，工具與 prompt 會出現在 plugin 底下；skill 會以 `work-intelligence:work-intelligence` 出現。

## Codex

在本 repo 開啟 Codex 時，它會讀到 `.agents/plugins/marketplace.json`，可以從 `/plugins` 安裝 `work-intelligence`。要在其他專案也使用，請把它加為個人 marketplace（例如 `codex plugin marketplace add /path/to/WorkLog.Ai`，或在 `~/.agents/plugins/marketplace.json` 加入指向 `plugins/work-intelligence` 的項目）。Codex 會把 plugin 複製到自己的快取，所以**必須**先執行 `pnpm plugin:link`，或在 Codex 環境設定 `WORK_INTELLIGENCE_HOME`。

Codex 的 MCP 設定在 `plugins/work-intelligence/codex.mcp.json`，以 plugin 根目錄為工作目錄執行 `node ./scripts/launch.mjs mcp`。

## 不要同時用兩種接法

plugin 與 `pnpm setup:agents`（或手動 `mcp add`）二選一即可；兩者並存時 Agent 會看到兩份相同的工具、skill 與提醒（提醒本身每段工作只會出現一次）。`pnpm doctor` 偵測到 Claude Code 已啟用 plugin、全域設定又註冊了 `work-intelligence` MCP 或 Stop hook 時會提出警告；只啟用 plugin 時，它不再要求手動註冊 Claude MCP、skill 與 hook。

從手動註冊改用 plugin：先 `pnpm setup:agents --uninstall`（預覽後確認；它也會移除 Codex 的手動設定），再安裝 plugin。改回手動：在 Agent 中停用或移除 plugin，再執行 `pnpm setup:agents`。

## 版本與檢查

`plugin.json` 的版本與根目錄 `package.json` 相同，發版時一起更新；`tests/server/plugin.test.ts` 會檢查版本、兩個 Agent 的 MCP 設定、skill 與 `.agents/skills/work-intelligence/SKILL.md` 一致，以及啟動器的尋找、轉送與失敗行為。修改 canonical skill 後請同步複製到 `plugins/work-intelligence/skills/work-intelligence/SKILL.md`。`claude plugin validate plugins/work-intelligence` 與 `claude plugin validate .` 可檢查 Claude Code 的 manifest 與 marketplace。

Claude Desktop（`.mcpb`）與 ChatGPT／claude.ai 網頁版需要另外的封裝或遠端 HTTPS MCP，目前不在這個 plugin 的範圍。
