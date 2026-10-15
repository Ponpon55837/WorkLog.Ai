# 研究：不需要 checkout 的發行方式（spike C）

日期：2026-10-15　基準：main 1.5.3（8a3b936）　分支：`spike/standalone-distribution`
原型：[`standalone-distribution-spike.mjs`](./standalone-distribution-spike.mjs)（可重跑，輸出在 gitignore 的 `dist/standalone-spike/`）

這是研究，沒有修改任何產品程式碼。以下「需要的修改」都只是建議。

## 1. 結論與建議

**技術上可行，而且比預期便宜；建議做，但分階段，第一階段只做「GitHub Release 附 tarball」，不要先上 npm。**

- 單一 bundle 沒有任何原生 addon。全部執行期相依都是純 JS（zod、`@modelcontextprotocol/sdk` 及其 ajv、smol-toml、zod-to-json-schema 等），資料庫用的是 Node 內建的 `node:sqlite`。esbuild 完全不需要 `external`，bundle 內只剩 `node:*` 的 import。
- 原型已經端到端跑通：`node bin start`、MCP stdio、`track`、`db backups`、`npm pack` → `npm i --prefix` → 已安裝的 bin、`npx ./tarball`、`npx file:...`，全部成功（第 4 節）。tarball 只有約 1.1 MiB，解開後約 5.1 MiB。
- 不需要使用者有 npm 帳號、不需要 pnpm、不需要 build。真正的成本不在打包，而在**十幾處把 repo 根目錄與 `dist` 路徑寫死的地方**（第 3 節），其中最重的是登入服務（目前靠 `pnpm start`）、`setup:agents` 的註冊路徑、doctor 與 MCP 重啟偵測。
- **npx 不適合當作日常入口**：npx 的快取路徑不穩定，不能註冊給 Agent 或登入服務。穩定入口只有「全域安裝」或「固定解壓位置」，兩者都能提供不隨版本變動的絕對路徑（第 6 節）。因此 npm 管道的實際用法是 `npm i -g work-intelligence`，npx 只適合一次性的 `npx work-intelligence track`／`check`。
- 發佈到 npm 牽涉使用者尚未做的決定（名稱、帳號、2FA、provenance），而且一旦發佈就難以撤回。GitHub Release 管道已經有 `release.yml`，可以重用，風險最低。
- 若不想投入：維持 checkout + `pnpm bootstrap` 完全可行，這份文件的原型與盤點仍可作為日後的起點。

建議順序：PR1（路徑抽象）→ PR2（bin 與打包）→ PR3（MCP/Agent 註冊）→ PR4（登入服務）→ PR5（Release 附件）→ 之後再決定 PR6（npm）。詳見第 8 節。

## 2. 方法與安全邊界

原型只寫入 `dist/standalone-spike/`（gitignore）和一個暫存目錄，暫存目錄同時承載合成資料庫、假的 HOME／USERPROFILE／CODEX_HOME／CLAUDE_CONFIG_DIR、npm cache、TEMP。`data/` 沒有被讀寫；沒有執行 `pnpm build`；port 3399；沒有 publish、沒有登入 npm。bundle 的 Web UI 是直接複製現有 `apps/web/dist`。

## 3. Q1：哪些地方假設「一定有 checkout」

「獨立套件」指的是 `<套件>/bin/work-intelligence.mjs` + `<套件>/libexec/apps/{server,mcp}/dist/*.js`（原型保留 repo 版面，因為 `APP_VERSION`、agent 資源、doctor 都用相對路徑 `../../..` 讀取）。

| 位置 | 目前行為 | 在獨立套件裡會怎樣（原型觀察） | 需要的修改 | 難度 |
| --- | --- | --- | --- | --- |
| `apps/server/src/config.ts` | `repositoryRoot = ../../..`；預設 DB `<root>/data/work-intelligence.sqlite`；相對的 `WORK_INTELLIGENCE_DB` 以 repo 根為基準 | 預設 DB 會落在 `<套件>/libexec/data/`，也就是 `node_modules` 裡，升級時被抹掉。原型靠 bin 在未設定時先設 `WORK_INTELLIGENCE_DB=~/.work-intelligence/data/...` 繞過 | 伺服器改用 MCP 已有的 `databasePathFor`／`standaloneDatabasePath`（`STANDALONE` 旗標），讓 server、CLI、doctor、服務共用同一個解析；相對路徑的基準改為 config 目錄或 cwd（見第 7 節） | 低 |
| `apps/server/src/index.ts`、`static-files.ts`、`WORK_INTELLIGENCE_WEB_DIST` | Web 目錄只來自環境變數，`scripts/start.mjs` 設定它 | 靜態檔案處理沒有問題（`/` 回 200、JS asset 502 KiB 正常、CSP 標頭照舊）。需要有人設 `WEB_DIST`；原型由 bin 設定 | `STANDALONE` 時預設為 `<bundle>/../web`（以 `import.meta.url` 推算）；`server.ts` 的 `defaultAllowedOrigins` 也依賴這個變數，要一起處理 | 低 |
| `scripts/start.mjs` | 檢查 `apps/web/dist/index.html` 與 `apps/server/dist/index.js`，載入 `startup-check.js` 提示 Agent skill／hook 過期 | 套件內不存在。原型的 `start` 直接 import server bundle，所以**少了 startup hint** | 把 hint 邏輯併進 bin 的 `start`；缺檔訊息改成「重新安裝」 | 低 |
| `scripts/bootstrap.mjs`（`pnpm bootstrap`） | 安裝、建置、連接 Agent、可選服務、doctor | 與獨立套件無關（沒有 install/build） | 不需要移植；新增 `work-intelligence setup`（連接 Agent + 可選服務 + 檢查）。更新流程改為 `npm i -g ...@latest` 或下載新 tarball，再執行 `setup` | 中 |
| `apps/server/src/user-service.ts`、`scripts/service-runner.mjs` | Task Scheduler／launchd／systemd 以 `node scripts/service-runner.mjs <repo> <db> <backup> <pnpm 絕對路徑> <log>` 啟動，runner 以 `pnpm start` 在 repo 執行；找不到 pnpm 會 throw | 套件內沒有 `scripts/`、沒有 pnpm；`ROOT_DIRECTORY` 指向 `libexec`。原型未安裝服務（不碰使用者的服務） | 新增「直接 `node <bin> start`」的執行模式：runner 不再需要 pnpm，工作目錄改為安裝根目錄，記下 `process.execPath`；預覽文字（「執行命令：pnpm start」）也要改。要處理 node 路徑隨版本管理員（nvm/fnm）變動 | 高 |
| `apps/server/src/agent-setup.ts`（`setup:agents`） | 把 `node <repo>/apps/mcp/dist/index.js` 與兩個 hook script 寫入 Codex／Claude 設定；缺檔就要求 `pnpm build`；用 `git -C <repo>` 取得歷史 skill 雜湊；判斷「是不是這個 repo 的 MCP」靠 `repositoryRoot` | 在暫存 HOME 套用 plan（用拋棄式 harness 呼叫同一個模組，`repositoryRoot=<套件>/libexec`）成功：8 個變更，Claude 設定寫入 `node <套件>/libexec/apps/mcp/dist/index.js`。沒有 git 時 `publishedSkillHashes` 回空集合，行為保守（拒絕覆寫非自己擁有的 skill）而不是失敗 | 讓 `repositoryRoot` 可以是安裝根目錄；偵測路徑含 `_npx` 時拒絕並說明（第 6 節）；註冊時一併寫入 `WORK_INTELLIGENCE_DB`（見第 7 節）；錯誤訊息的 `pnpm build` 換成通用說明 | 中 |
| `apps/server/src/setup-agents.ts`、`service-cli.ts`、`cli.ts` 的「作為入口才執行」判斷 | 以 `import.meta.url === pathToFileURL(argv[1])` 判斷 | 不能被一般 `import` 觸發。原型用 `process.argv = [node, target, ...]` 再動態 import 解決，沒有 spawn 子行程（避免 Windows 殺不掉孫行程） | 正式實作可把 `main()` 匯出，由 bin 直接呼叫，去掉這個 hack | 低 |
| `apps/server/src/doctor.ts`（`pnpm check`） | 檢查 pnpm 版本、`apps/*/dist`、`packages/*/dist`、`src` 與 dist 的新舊、repo 根目錄的 `*.sqlite` | 可以執行，但輸出**誤導**：「pnpm 專案要求未知」、「缺少 `packages/*/dist`」、「請執行 pnpm build」、「請執行 pnpm start」。另外它仍會唯讀查詢**真實**的登入服務（顯示「正在執行」，同時印出的 DB 路徑是環境變數指到的暫存庫） | 加 `STANDALONE` 模式：略過 pnpm／dist／src／root sqlite 檢查，改查套件完整性（libexec 檔案、版本一致）；建議文字改為 `work-intelligence ...` | 中 |
| `packages/shared/src/mcp-runtime.ts` | 租約目錄 `os.tmpdir()/work-intelligence/mcp-runtime/<repo 路徑雜湊>`；以 `apps/mcp/dist` 與 `packages/*/dist` 的雜湊計算 build identity，MCP 啟動時嵌入、之後與磁碟比對，用來通知「請重新連線 MCP」 | `STANDALONE` 時 MCP 完全跳過註冊與重啟偵測（`index.ts`），server 的 System Status 的 MCP runtime 會是「0 個可監測」。全域安裝**就地更新**時，執行中的 MCP 已載入舊檔，卻不會收到 `restartRequired` | 把 identity 改為「套件 `package.json` 版本 + bundle 檔案雜湊」；租約目錄以安裝根目錄為 key；建置步驟要替換 `__WORK_INTELLIGENCE_BUILD_HASH__` 佔位字串（原型沒有做，所以 `runningBuild` 為 undefined） | 中 |
| `apps/mcp/src/index.ts`、`database-location.ts`、`agent-resources.ts` | MCP 已有 `STANDALONE`（`build-plugin.mjs` 定義），資料庫順序：`WORK_INTELLIGENCE_DB` → plugin-link 指向的 checkout → `~/.work-intelligence/data`；agent 資源讀 `<root>/.agents/...`、`docs/...` | 已可用：`resources/read` 讀到 28,517 字元的 skill；`work_get_project_status` 對暫存 DB 正常 | 只需處理與 server 不一致的資料庫解析（第 7 節）；資源路徑可維持原型的版面 | 低 |
| `scripts/plugin-link.mjs`、`plugins/work-intelligence/scripts/launch.mjs` | 把 checkout 路徑記到 `~/.work-intelligence/plugin-link.json`，plugin 靠它找 checkout | 與套件無關，但**會互相影響**：連結仍在時，直接啟動 MCP bundle 會讀 checkout 的 `data/` | 新增 `work-intelligence plugin-link` 或讓 launch.mjs 先找已安裝的 `work-intelligence`；文件說明優先順序 | 中 |
| `apps/server/src/cli.ts`、`track-cli.ts`、`database-busy-diagnosis.ts`、`listen-error.ts`、`startup-check.ts` | 訊息固定寫 `pnpm db:*`、`pnpm track`、`pnpm start`、`pnpm check`；`track` 用 pnpm 設定的 `INIT_CWD` 當相對路徑基準；診斷用 `repositoryRoot` | 功能正常（`track` 寫入暫存 DB，MCP 隨後看到 `tracked`；`db backups` 正常），只有字串是錯的。bin 設 `INIT_CWD ??= cwd` 補上基準 | 訊息改成依模式選擇命令名（`pnpm x` 或 `work-intelligence x`）；以 cwd 取代 `INIT_CWD` | 低 |
| `scripts/build-plugin.mjs`、`release.yml` | 已經能打包 MCP 為 zip／mcpb | 只含 MCP，不含 server 與 Web | 作為新打包腳本的基礎（原型基本上是它的擴充） | 低 |

沒有找到阻擋性的假設：所有硬編碼都是路徑與文案，沒有結構性問題。

## 4. Q2、Q3：原型結果

### Q2 單一 bundle、無原生相依

- 入口：server（`index`、`cli`、`doctor`、`setup-agents`、`service-cli`）與 MCP（`index`、`finalize-reminder`、`codex-finalize-reminder`），共 8 個檔案；沿用 `build-plugin.mjs` 的作法（`@work-intelligence/*` 直接解析到 TS 原始碼，所以不依賴 `packages/*/dist`，也沒有動到它們）。
- 打進 bundle 的 npm 套件（依大小）：zod 730 KiB、`@modelcontextprotocol/sdk` 229 KiB、ajv 206 KiB、smol-toml 56 KiB、zod-to-json-schema 53 KiB、fast-uri 49 KiB、ajv-formats 16 KiB、json-schema-traverse 2 KiB、fast-deep-equal 1 KiB。**全部是純 JS，沒有 `.node` 原生模組。**
- bundle 外部 import 只剩內建模組：`node:child_process`、`crypto`、`fs`、`fs/promises`、`http`、`net`、`os`、`path`、`process`、`readline/promises`、`sqlite`、`stream/promises`、`url`。
- `node:sqlite`：Node 22.13 / 23.4 起不需要 `--experimental-sqlite`，目前文件標示 Stability 1.2（release candidate，v25.7.0 起）。這與目前 `engines.node >= 22.13` 一致，不是新增的風險。

大小（1.5.3，未壓縮與壓縮是同一份程式碼）：

| 項目 | 大小 |
| --- | --- |
| 8 個 bundle，未壓縮 | 4,074 KiB（server index 1,041 KiB、mcp index 1,615 KiB、cli 950 KiB） |
| 同樣 bundle，minify | 2,314 KiB，gzip 後 605 KiB |
| `apps/web/dist` | 1,049 KiB |
| agent 資源 | 46 KiB |
| 套件目錄總和 | 5,171 KiB |
| `npm pack` tarball | 1,149 KiB（71 個檔案） |

原型沒有 minify（保留可讀的錯誤堆疊與 diff）；minify 可再省約 1.7 MiB 解開後大小，但 tarball（已 gzip）差距不大。每個入口各自打包導致 zod、MCP SDK 在多個檔案重複；若在乎大小可以改 `splitting`，這是低優先的優化。

### Q3 驗證結果（全部在暫存環境，port 3399，合成 DB）

| # | 項目 | 結果 |
| --- | --- | --- |
| 1 | `node bin/work-intelligence.mjs start` | 成功。`/api/health` 回 `ok:true, version 1.5.3, schemaVersion 30, database connected`；`/`（Accept: text/html）200、1,155 字元的 `index.html`；`/assets/*.js` 200、`text/javascript`、502,305 bytes。關閉後 3399 不再 listen |
| 1b | 未設 `WORK_INTELLIGENCE_DB` | 資料庫建立在 `WORK_INTELLIGENCE_CONFIG_DIR/data/`（沒有落在套件或 repo 內） |
| 2 | MCP stdio：`initialize`、`tools/list`、`work_read`/`work_get_project_status`、`resources/read` skill | 成功。serverInfo `work-intelligence 1.5.3`；4 個工具；skill 資源 28,517 字元 |
| 2b/2c | `track <資料夾> --yes`，再用 MCP 查狀態 | 成功，寫入暫存 DB，MCP 回報 `tracked` |
| 2d | `db backups` | 成功 |
| 2e | `check`（doctor） | 能跑、退出碼 0，但輸出有誤導（見第 3 節） |
| 2f/2g | `setup-agents` 預覽；在暫存 HOME 套用 plan | 預覽正常、非互動不寫入；套用成功，MCP 註冊為 `node <套件>/libexec/apps/mcp/dist/index.js` |
| 3a | `npm pack` | `work-intelligence-1.5.3.tgz`，1,149 KiB，71 檔 |
| 3b/3c | `npm i --prefix <暫存> <tgz>`，執行 `.bin/work-intelligence.cmd start` | 成功；套件內沒有 `node_modules`（沒有執行期相依需要安裝）；health/UI/asset 全通過 |
| 3d | `npx ./work-intelligence-1.5.3.tgz start` | 成功 |
| 3e | `npx file:<絕對路徑>.tgz start` | 成功 |

遇到的問題與結論：

1. **`npx <Windows 絕對路徑>.tgz` 靜默失敗**：在 Git Bash 以 `C:\...\x.tgz` 直接傳給 npx，退出碼 0、沒有任何輸出、沒有啟動。改用 `./x.tgz` 或 `file:` URL 才正常。這是 npm 對 Windows 路徑的解析問題，文件與安裝說明要避免給使用者這種寫法。（驗證時的 npm 11.13.0。）
2. 一開始 `/` 回 404，是原型自己的檢查漏帶 `Accept: text/html`（`static-files.ts` 只對接受 HTML 的請求回退到 `index.html`）。這是既有、合理的行為，不是 bug。
3. 在 Windows 上殺掉 `bin` 是 `TerminateProcess`，沒有走 graceful shutdown；原型因此選擇在行程內執行入口，不再多一層子行程。
4. 原型沒有安裝登入服務，也沒有寫入使用者的 Agent 設定；這兩項只用「暫存 HOME」與讀程式碼驗證。登入服務的新模式是最大的未驗證區塊。

## 5. Q4：發行管道比較

| 面向 | (a) npm 套件（`npx`／`npm i -g`） | (b) GitHub Release tarball／zip | (c) 維持 checkout + bootstrap |
| --- | --- | --- | --- |
| 安裝步驟 | `npm i -g work-intelligence`，`work-intelligence setup`（2 步） | 下載、解壓到固定位置、`node <path>/bin/... setup`（3 步；可提供 install 腳本） | `git clone`、`pnpm bootstrap`（2 步，但需要 git、pnpm、完整 build） |
| 更新 | `npm i -g work-intelligence@latest` + 重啟服務／MCP | 重新下載解壓覆蓋 + 重啟；沒有內建更新檢查 | `git pull` + `pnpm bootstrap` + `pnpm service:install` |
| 登入服務與 Agent MCP 註冊 | 全域安裝路徑穩定，可註冊；**npx 不行**（第 6 節） | 解壓位置固定即可註冊；路徑由使用者決定 | 已經支援 |
| Node 版本 | `engines.node >= 22.13`（npm 只警告，除非 `engine-strict`）；全域路徑會隨 nvm/fnm 的 Node 版本變動 | 同左；使用者自己用 `node` 執行，路徑變動風險較小 | 22.13 + pnpm 11.16 |
| 維護成本 | 最高：名稱、發佈流程、npm 帳號、版本與 tag 同步、deprecate 流程 | 低：`release.yml` 已存在，加一個打包步驟 | 最低（現狀） |
| 供應鏈風險 | 使用者最熟悉，但 npm 是常見攻擊面；要靠 2FA、Trusted Publishing／provenance（GitHub Actions、`id-token: write`、公開 repo） | 風險較小（沒有新的註冊表）；可附 SHA-256，也可用 GitHub artifact attestation | 與現在相同（git + pnpm 依賴） |
| 使用者需要 npm 帳號 | 安裝不需要；**發佈者**需要 | 不需要 | 不需要 |
| 對開發者友善度 | 一行安裝，npx 可臨時使用 `track`／`check` | 中等 | 最適合貢獻者與要改程式的人 |

名稱可用性（唯讀 `npm view`，2026-10-15）：`work-intelligence`、`worklog-ai`、`workintelligence`、`@ponpon55837/work-intelligence`、`work-intelligence-cli` **全部 404（尚未被使用）**。404 不保證能發佈（npm 對相似名稱有限制，也可能被取消發佈後保留），實際可用性要在第一次發佈時才確定；若要保險，scoped 名稱最安全。

建議：(b) 先做、(a) 後做、(c) 永遠保留給貢獻者。

## 6. npx 快取路徑問題

- npx（`npm exec`）把套件裝在 npm cache 的 `_npx/<雜湊>/` 之下，路徑含雜湊，且會在版本變動、快取清除或 `--cache` 不同時改變（官方文件只說明套件安裝到快取資料夾並加入 PATH，沒有保證路徑穩定）。把這個路徑寫進 Codex／Claude 的 MCP 設定或 Task Scheduler／launchd／systemd，等於下次更新或清快取就壞掉，而且壞掉時是靜默的。
- **全域安裝能解決**：`npm i -g work-intelligence` 把套件放在 `<npm prefix>/node_modules/work-intelligence/`，升級是就地覆蓋，路徑不隨版本變動。殘留風險是 `<npm prefix>` 在 nvm/fnm/volta 下會因 Node 版本而不同，切換 Node 版本後路徑失效。對策：註冊時存入 `realpath` 後的 `libexec` 絕對路徑以及 `process.execPath`，並由 `check` 偵測「已註冊路徑不存在」。
- **`setup:agents` 需要的修改**：
  1. 以執行中 bundle 自身位置（`import.meta.url`）推算安裝根目錄，不再假設 repo；
  2. 若路徑包含 `_npx`（或位於 npm cache 內），拒絕註冊並顯示「請先 `npm i -g work-intelligence`，再重新執行」；
  3. 優先寫入 `node <絕對 libexec>/apps/mcp/dist/index.js`（與目前格式相容），不要寫 `work-intelligence mcp`——GUI 啟動的 Agent 不一定有 shell 的 PATH；
  4. 註冊時帶上 `WORK_INTELLIGENCE_DB`（第 7 節）。
- **`service:install` 需要的修改**：服務定義存 `node <bin> start` 的絕對路徑與固定的 `WORK_INTELLIGENCE_DB`／備份目錄；不再依賴 pnpm；更新後仍需重新執行（預覽並確認）以重啟服務，這與目前 `pnpm bootstrap` 的提醒一致；`check` 要比對服務指向的路徑是否存在、版本是否為目前安裝版本。
- 解壓型（管道 b）天然是固定路徑，風險取決於使用者是否把它放在會被清掉的位置（Downloads、暫存），`setup` 可以警告。

## 7. Q5：資料與遷移

- **獨立套件預設位置**：`~/.work-intelligence/data/work-intelligence.sqlite`（`WORK_INTELLIGENCE_CONFIG_DIR` 可覆蓋；備份在資料庫旁的 `backups/`）。這是 MCP 的 `standaloneDatabasePath` 已經使用的位置，原型的 bin 讓 server 也用它。
- **從 checkout 遷移到套件（只寫流程，原型沒有搬移任何資料）**，兩種方式：
  1. **就地沿用**（建議，風險最低）：把 `WORK_INTELLIGENCE_DB` 設為舊的絕對路徑（例如 `<舊 checkout>/data/work-intelligence.sqlite`），在 `setup`／`service:install` 時寫進服務與 Agent 註冊。資料不動，隨時可以退回 checkout。缺點：舊 checkout 不能被刪除。
  2. **匯出再還原**：停止 server 與所有 MCP → `pnpm db:export <檔>.sqlite`（整庫）→ 新套件 `work-intelligence db restore <檔>`（會先自動備份目前資料；專案路徑變動時用 `--remap-root`）。可攜式 JSON 的 `db:export --all`／`db:import` 也可用於合併。
  兩種方式都應該先 `db:backup`；服務與 MCP 需先停用，避免 SQLite 被占用（現有的 `database-busy-diagnosis` 訊息要更新）。
- **與 1.5.2 資料庫路徑修正的交互**（`WORK_INTELLIGENCE_DB` 統一解析、相對路徑以 repo 根為基準、拒絕磁碟相對路徑）：
  1. 「以 repo 根為基準」在套件中沒有意義（根在 `node_modules` 內），要改成 config 目錄或 cwd，否則相對路徑會悄悄指進套件目錄；磁碟相對路徑的檢查仍可原樣保留。
  2. **新的分歧風險**：MCP（`STANDALONE`）的順序是 env → plugin-link 指向的 checkout → config 目錄；server 目前直接用 `config.ts`（env → repo/data）。如果使用者同時有 `plugin-link.json` 與獨立套件，直接執行 MCP bundle 會讀 checkout 的 `data/`，而 server 讀 config 目錄，兩邊看到不同資料。對策：server 與 CLI 共用 MCP 的解析函式，且 `setup-agents`／服務註冊時一律寫入明確的 `WORK_INTELLIGENCE_DB`；`check` 比對 server、MCP、服務三者解析結果是否一致（1.5.2 已有類似的 doctor 檢查）。
  3. doctor 目前的「repo 根目錄 `*.sqlite`」警告在套件模式沒有意義，需略過。

## 8. 若要實作：PR 路線

| PR | 範圍 | 主要檔案 | 風險 | 需要使用者決定 |
| --- | --- | --- | --- | --- |
| 1. 路徑與資料庫解析統一 | server、CLI、doctor、服務共用 `databasePathFor`；Web 目錄預設；訊息依模式選命令名；入口 `main()` 匯出；相對路徑基準 | `apps/server/src/config.ts`、`index.ts`、`server.ts`、`cli.ts`、`track-cli.ts`、`packages/shared/src/database-path.ts`、`apps/mcp/src/database-location.ts` | 低；checkout 模式行為必須完全不變（既有測試保護） | 相對 `WORK_INTELLIGENCE_DB` 在套件模式的基準 |
| 2. 打包腳本與 bin | 把原型正式化為 `scripts/build-standalone.mjs` 與 `bin/`（`start`、`mcp`、`check`、`track`、`db`、`setup`、`service`）；minify／splitting 評估；tarball 的 smoke test（含 Windows 路徑案例） | 新增 `scripts/build-standalone.mjs`、`bin/work-intelligence.mjs`；`scripts/build-plugin.mjs` 重用；CI | 低到中 | 套件／指令名稱 |
| 3. Agent 註冊與 MCP 重啟偵測 | `setup:agents` 支援安裝根目錄、拒絕 `_npx`、寫入 DB；build identity 改為版本 + bundle 雜湊；System Status 的 MCP runtime | `agent-setup.ts`、`packages/shared/src/mcp-runtime.ts`、`apps/mcp/src/index.ts`、`build-compatibility.ts`、建置時的雜湊替換 | 中：這是使用者全域設定與更新通知的核心，測試要涵蓋 | 是否也提供 `plugin-link` 等價功能 |
| 4. 登入服務（直接 node，不依 pnpm） | 新增 node 執行模式的 runner 與三平台服務定義；預覽文字；`check` 驗證服務指向 | `user-service.ts`、`scripts/service-runner.mjs`（或新 runner）、`service-cli.ts`、`doctor.ts` | 高：三個作業系統、更新後重啟、node 路徑變動；需要在每個平台實測 | 是否支援 nvm 等路徑變動的自動修復 |
| 5. Release 附件（管道 b） | `release.yml` 增加 tarball／zip 與 SHA-256（可加 attestation）；安裝文件；doctor 的套件模式 | `.github/workflows/release.yml`、`README*`、`docs/`、`doctor.ts` | 低到中；改的是 Release 流程 | 是否接受以 Release 附件作為官方管道；附件命名 |
| 6.（之後）發佈 npm | `release.yml` 以 Trusted Publishing／`--provenance` 發佈；`files`、`publishConfig`、名稱；`private` 旗標移除；`npm i -g` 文件；deprecate 流程 | `package.json` 或獨立的發行 `package.json`、`release.yml` | 中：發佈不可逆（名稱、版本一旦用過就無法重用）；供應鏈 | **是否發佈到 npm、套件名稱（含是否使用 scope）、npm 帳號與 2FA（發佈者）、是否啟用 Trusted Publishing、誰有發佈權限** |

原型的 `package.json` 刻意設為 `"private": true`，即使有人誤執行 `npm publish` 也會被拒絕。

## 9. 風險與未驗證項目

- 登入服務（三平台）、macOS／Linux、Node 版本管理員下的路徑變動都沒有實測。
- 原型的 MCP build identity 佔位字串沒有被替換，所以「請重新連線 MCP」的偵測沒有驗證。
- doctor 在套件模式會唯讀查詢真實的登入服務（Task Scheduler），顯示的資料庫路徑卻來自環境變數；正式實作要避免這種混合輸出。
- 打包沒有 minify／splitting；tarball 內沒有 source map。
- `npm view` 只代表查詢當下沒有同名套件。

## 10. 外部資料來源

- Node.js `node:sqlite`（穩定度、不需 flag 的版本）：https://nodejs.org/api/sqlite.html
- npm provenance 與 Trusted Publishing 條件：https://docs.npmjs.com/generating-provenance-statements
- `npm exec`／npx 的快取行為：https://docs.npmjs.com/cli/v11/commands/npm-exec
- 本機實測：npm 11.13.0、Node 24.16.0、Windows 11（Git Bash）。
