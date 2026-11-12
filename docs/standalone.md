# 獨立套件（不需要 checkout）

獨立套件把 API server、Web 介面、MCP server 與命令列打包成一個資料夾（或 tarball），只需要 Node.js，不需要 git、pnpm 或 build。官方管道是 GitHub Release 附件 `work-intelligence-<版本>.tgz`（發行流程會先對要上傳的那個 tarball 跑 smoke test）；目前不發佈到 npm，套件的 `package.json` 是 `private`。

目前的套件提供 `start`、`mcp`、`track`、`check`、`db` 與 `--version`。Agent 註冊（`setup-agents`）與登入自動啟動服務（`service`）尚未提供，仍請用 checkout 的 `pnpm setup:agents`、`pnpm service:install`，或自行把 `node <套件>/libexec/apps/mcp/dist/index.js` 註冊到 Agent（見 [agent-setup.md](agent-setup.md)）。

## 產生套件

```bash
pnpm build               # 需要 apps/web/dist
pnpm build:standalone    # 輸出到 dist/standalone/（已在 .gitignore）
```

輸出兩樣東西，路徑印在最後：

- `dist/standalone/work-intelligence-<版本>/`：套件資料夾
- `dist/standalone/work-intelligence-<版本>.tgz`：同一個資料夾的 tarball（頂層資料夾名稱相同，`tar -xzf` 與 `npm i <tgz>` 都能用；內容與日期固定，同樣輸入得到同樣的位元組）

版面：

```text
work-intelligence-<版本>/
  bin/work-intelligence.mjs        指令入口，只檢查 Node.js 版本後交給打包的 CLI
  libexec/apps/server/dist/        standalone-cli.js、backup-worker.js
  libexec/apps/mcp/dist/           index.js 與兩個 finalize reminder hook
  libexec/{.agents,docs}/…         MCP 的 skill（核心與流程指南）與寫作指南資源
  libexec/package.json             打包程式讀取版本的位置
  web/                             apps/web/dist 的複本
  package.json                     private、bin、engines.node（與根目錄相同）
```

所有相依套件都是純 JavaScript，已打包進 `libexec/`，資料夾內沒有 `node_modules`，也沒有原生模組。`backup-worker.js` 必須與 `standalone-cli.js` 在同一個資料夾，API 的備份與匯出由它在 worker thread 執行。

## 下載與驗證

從 [GitHub Releases](https://github.com/Ponpon55837/WorkLog.Ai/releases) 下載 `work-intelligence-<版本>.tgz` 與同一個 Release 的 `SHA256SUMS.txt`，放在同一個資料夾後核對：

```bash
sha256sum -c --ignore-missing SHA256SUMS.txt        # Linux
shasum -a 256 -c --ignore-missing SHA256SUMS.txt    # macOS
```

Windows PowerShell 用 `(Get-FileHash work-intelligence-<版本>.tgz -Algorithm SHA256).Hash` 算出雜湊，與 `SHA256SUMS.txt` 中同名那一行比對（大小寫不同沒關係）。不相符就不要使用，重新下載。

解壓到固定位置（不要放在 Downloads 或暫存資料夾，之後 Agent 與服務會以絕對路徑指向它）。在 Windows 上請用 `./` 相對路徑或 `file:` URL 指定 tarball，不要把 `C:\…\x.tgz` 直接交給 npx，npm 會靜默失敗。

## 使用

```bash
tar -xzf work-intelligence-<版本>.tgz
node work-intelligence-<版本>/bin/work-intelligence.mjs --help
```

把 `bin/` 加入 `PATH`，或用 `npm i -g ./work-intelligence-<版本>.tgz` 安裝後，直接輸入 `work-intelligence`：

| 指令 | 用途 |
|---|---|
| `work-intelligence start` | 啟動 Web 介面與 API，預設 `http://127.0.0.1:3210`；`WORK_INTELLIGENCE_PORT` 可改 port |
| `work-intelligence mcp` | 以 stdio 啟動 MCP server，給 Agent 連線 |
| `work-intelligence track <資料夾> [--name <名稱>] [--yes]` | 預覽後把專案加入並設為記錄中；相對路徑以輸入指令時的目錄為準 |
| `work-intelligence check` | 唯讀診斷 |
| `work-intelligence db <子指令>` | 備份、匯出、匯入、還原與維護，對應 checkout 的 `pnpm db:*`；`work-intelligence db` 列出全部 |
| `work-intelligence --version`、`--help` | 版本與說明 |

在 Windows 上，`start` 與 `mcp` 都在同一個行程內執行，沒有額外的子行程，所以結束行程不會留下孫行程。

## 資料位置

- 資料庫預設在 `~/.work-intelligence/data/work-intelligence.sqlite`，備份在旁邊的 `backups/`。`WORK_INTELLIGENCE_CONFIG_DIR` 改變目錄。
- `WORK_INTELLIGENCE_DB` 指定資料庫檔；相對路徑以 `~/.work-intelligence`（或 `WORK_INTELLIGENCE_CONFIG_DIR`）為基準，不是安裝位置，也不是目前目錄。
- 若設定了 `WORK_INTELLIGENCE_HOME` 或執行過 `pnpm plugin:link`，且沒有設定 `WORK_INTELLIGENCE_DB`，會沿用該 checkout 的 `data/`，與 plugin 共用同一個資料庫。
- 內附的 Web 介面從套件的 `web/` 提供；`WORK_INTELLIGENCE_WEB_DIST` 可改成別的資料夾。

從 checkout 搬到獨立套件的流程見 [experiments/standalone-distribution-spike-2026-10-15.md](experiments/standalone-distribution-spike-2026-10-15.md) 第 7 節：最簡單的是把 `WORK_INTELLIGENCE_DB` 指到舊的資料庫檔。

## `check` 在套件裡檢查什麼

不檢查 pnpm 版本、dist 新舊、repo 根目錄的 SQLite 檔，也不查詢系統的服務管理器。改為檢查：

- 套件檔案：`bin/`、`web/index.html` 與 `libexec/` 內的 bundle 和 Agent 資源是否齊全；缺少時列出檔名並建議重新下載。
- 套件版本：執行中的程式、套件 `package.json` 與 `libexec/package.json` 是否同一個版本。
- 另外照常檢查 Node.js、資料庫、API 與 Agent 設定。建議文字都使用 `work-intelligence …`。

## 測試

`pnpm test:standalone`（需要先 `pnpm build`）在暫存目錄建置、解開 tarball，再以假的 HOME、`WORK_INTELLIGENCE_CONFIG_DIR` 與隨機空閒 port 執行：`--version`、`start`（`/api/health`、`/`、Web 的 JS、經 worker thread 的備份、SIGTERM 後釋放 port）、`track`、`db backups`、`check` 與 MCP stdio 的 `initialize`、`tools/list` 與專案狀態。它不會碰 `data/`、`~/.work-intelligence`、`~/.claude`、登入服務，也不使用預設的 3210。單元測試在 `tests/server/standalone-*.test.ts`、`tests/server/web-directory.test.ts`、`tests/shared/command-name.test.ts`。

## 尚未提供

- `setup-agents`、`service`（登入自動啟動）。
- MCP 的「請重新連線」偵測：套件整包替換，不做 checkout 的 build 監看，所以不需要建置雜湊的替換。
- 上傳 Release 附件、SHA-256 與發行說明。
