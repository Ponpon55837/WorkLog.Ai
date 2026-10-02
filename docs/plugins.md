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

plugin 與 `pnpm setup:agents`（或手動 `mcp add`）二選一即可；兩者並存時 Agent 會看到兩份相同的工具、skill 與提醒（提醒本身每段工作只會出現一次）。`pnpm run doctor` 偵測到 Claude Code 已啟用 plugin、全域設定又註冊了 `work-intelligence` MCP 或 Stop hook 時會提出警告；只啟用 plugin 時，它不再要求手動註冊 Claude MCP、skill 與 hook。

從手動註冊改用 plugin：先 `pnpm setup:agents --uninstall`（預覽後確認；它也會移除 Codex 的手動設定），再安裝 plugin。這個指令只移除它自己安裝的項目；依本頁以外的說明手動加入的設定要自己移除：Claude Code 執行 `claude mcp remove work-intelligence --scope user`，並刪除 `~/.claude/settings.json` 中指向 `apps/mcp/dist/finalize-reminder.js` 的 Stop hook；Codex 執行 `codex mcp remove work-intelligence`。移除後執行 `pnpm run doctor` 確認沒有重複。改回手動：在 Agent 中停用或移除 plugin，再執行 `pnpm setup:agents`。

## 信任與權限

- **Claude Code**：plugin 的 Stop hook 隨 plugin 啟用，不必另外授權；可在 `/hooks` 檢視，或在 `/plugin` 停用整個 plugin。第一次呼叫 MCP 工具時，Claude Code 會照一般 MCP 權限規則詢問。
- **Codex**：本 plugin 沒有帶 hook。若依 [保存提醒](agent-setup.md#保存提醒選用) 手動設定 Codex hook，需在 Codex 輸入 `/hooks` 檢視並信任；未信任的 hook 會被略過。

## 安裝與排錯

| 症狀 | 原因與處理 |
|---|---|
| MCP 沒有連上，stderr 出現 `Work Intelligence repository not found` | Agent 把 plugin 複製到快取後找不到 checkout。在 repo 執行 `pnpm plugin:link`，或設定 `WORK_INTELLIGENCE_HOME`；也可以改用 release 附的自帶 server 版本。 |
| `Missing apps/mcp/dist/index.js … run pnpm build` | checkout 還沒 build 或 build 中斷。在 repo 執行 `pnpm install && pnpm build`，再重新連線 MCP。 |
| `node:sqlite` 相關錯誤或 `ERR_UNKNOWN_BUILTIN_MODULE` | Node.js 低於 22.13。升級 Node.js；`node --version` 確認 Agent 使用的是同一個 Node。 |
| 工具或 skill 出現兩份 | plugin 與 `pnpm setup:agents`／手動 `mcp add` 同時啟用。依上方「不要同時用兩種接法」擇一；`pnpm run doctor` 會指出重複。 |
| 資料庫不是預期的那一個 | MCP 啟動時在 stderr 印出 `connected using <路徑>`。依序檢查 `WORK_INTELLIGENCE_DB`、`WORK_INTELLIGENCE_HOME`、`~/.work-intelligence/plugin-link.json`。 |
| 更新 repo 後 Agent 提示需要重新連線 | 與手動註冊相同：`pnpm build` 後重新連線 MCP（Claude Code 可用 `/mcp` 重新連線，或重新開啟工作階段）。 |
| 保存提醒沒有出現 | 提醒只在「追蹤中」的專案、改過檔案且上次保存後才出現，同一段工作只提醒一次；`pnpm run doctor` 會檢查 hook 設定。 |

其餘 MCP、資料庫與 hook 問題見 [疑難排解](troubleshooting.md)。

## 版本與檢查

`plugin.json` 的版本與根目錄 `package.json` 相同，發版時一起更新；`tests/server/plugin.test.ts` 會檢查版本、兩個 Agent 的 MCP 設定、skill 與 `.agents/skills/work-intelligence/SKILL.md` 一致，以及啟動器的尋找、轉送與失敗行為；`tests/server/plugin-bundle.test.ts` 會實際執行 `pnpm build:plugin`，在沒有 checkout 的暫存 HOME 啟動內附 server，確認 MCP 握手、skill resource 與資料庫位置。修改 canonical skill 後請同步複製到 `plugins/work-intelligence/skills/work-intelligence/SKILL.md`。`claude plugin validate plugins/work-intelligence` 與 `claude plugin validate .` 可檢查 Claude Code 的 manifest 與 marketplace。

## 不用 checkout 的版本（release 附件）

`pnpm build:plugin` 在 `dist/plugin/` 產生：

| 檔案 | 用途 |
|---|---|
| `work-intelligence/`、`work-intelligence-plugin-<版本>.zip` | 同一個 plugin，另外帶有以 esbuild 打包的 MCP server（`server/`），不需要 clone 或 build |
| `work-intelligence-<版本>.mcpb` | Claude Desktop 擴充，雙擊安裝 |

發行 tag 時 workflow 會把兩個檔案附到 GitHub Release。repo 內的 `plugins/work-intelligence/` 不含 `server/`，所以從本 repo marketplace 安裝的行為不變。

啟動器仍然先找 checkout（`WORK_INTELLIGENCE_HOME` → 所在 repository → `plugin-link.json`），只有找不到已 build 的 checkout 時才用內附的 server。內附 server 的資料庫：

1. `WORK_INTELLIGENCE_DB`（`.mcpb` 安裝時可填「Database file」）
2. `WORK_INTELLIGENCE_HOME` 或 `pnpm plugin:link` 指向的 checkout 的 `data/work-intelligence.sqlite`：與 Web UI 共用同一個資料庫
3. 都沒有時：`~/.work-intelligence/data/work-intelligence.sqlite`（可用 `WORK_INTELLIGENCE_CONFIG_DIR` 改目錄）

內附 server 隨 plugin 整包更新，不做 checkout 的 build 監看與重新連線提示。它需要 Node.js 22.13 以上（`node:sqlite`）；`.mcpb` 的 manifest 宣告了這個需求，Claude Desktop 內建的 Node.js 不符時會拒絕安裝。Web UI、REST API、備份 CLI 仍需要 checkout。

- Claude Code：`claude --plugin-url <zip 的網址>` 試用一次，或解壓後加入自己的 marketplace。
- Claude Desktop：下載 `.mcpb` 後雙擊，或從「設定 → 擴充功能」安裝。
- 上架 Anthropic 目錄或 OpenAI plugin 目錄時，應提交這個自帶 server 的版本；目錄的審核規則以各平台說明為準。

claude.ai 與 ChatGPT 網頁版只能連遠端 HTTPS MCP，與「資料只留在本機」的設計衝突，目前不提供。
