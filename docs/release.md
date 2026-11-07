# 發行與升級

Work Intelligence 使用 Semantic Versioning。根目錄 `package.json` 是應用程式版本的唯一來源；`/api/health`、MCP metadata／instructions 與 Web 側欄都由它讀取。Schema 版本獨立由 storage migrations 管理，只有資料結構變更時才遞增。

需要實體作業系統、瀏覽器或私人資料才能確認的項目，請依[發行實機驗收清單](release-checklist.md)由使用者操作並填寫結果；CI 不代表這些驗收已完成。

## 發行前檢查

每次發行都先開一般 PR，完成審查與合併，再由維護者決定何時推送 tag。PR 本身不建立 Release。tag workflow 只接受 `v*` tag，並會確認 tag、根目錄版本與 CHANGELOG 版本段落一致；版本不一致或找不到對應段落時會停止。完整檢查通過後才會建立 GitHub Release，並附上 ZIP 與 tar.gz 原始碼封存檔，以及 `pnpm build:plugin` 產生的自帶 MCP plugin（`work-intelligence-plugin-<版本>.zip`）與 Claude Desktop 擴充（`work-intelligence-<版本>.mcpb`）；見 [plugin 指南](plugins.md#不用-checkout-的版本release-附件)。發佈前也會 `pnpm build` 與 `pnpm build:standalone`，用 `node scripts/smoke-standalone.mjs --tarball` 驗證要上傳的獨立套件 `work-intelligence-<版本>.tgz`（見 [獨立套件](standalone.md)），再把所有附件的 SHA-256 寫進 `SHA256SUMS.txt` 一起上傳；smoke test 失敗就不建立 Release。

合併發行 PR 前，逐項確認以下八項本機檢查成功，且 PR 最新 head 的 Quality（Ubuntu、Windows、macOS）與 E2E 四項 CI 都是 success：

```sh
pnpm build
pnpm test
pnpm typecheck
pnpm test:coverage
pnpm run test:performance
pnpm run test:retrieval-quality
pnpm run test:response-size
pnpm test:e2e
```

`pnpm test` 包含 lint 與格式檢查；CI 也會執行合成 recall evaluator smoke test。確認 CHANGELOG 有本次完整版本段落、升級說明正確，且 `package.json` 版本與欲推送的 tag 相同。tag workflow 會再次執行跨平台品質檢查、效能／檢索／回應大小門檻與 Chromium、Firefox、WebKit E2E。

## 推送版本 tag

先確認發行 PR 已合併至 `main`，工作目錄乾淨，且最新 `main` 的八項檢查及 CI 都通過。以下命令以 `1.0.0` 為例；後續版本要同步更新 `package.json` 與 CHANGELOG 段落，再替換版本字串：

```sh
git switch main
git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm typecheck
pnpm test:coverage
pnpm run test:performance
pnpm run test:retrieval-quality
pnpm run test:response-size
pnpm test:e2e
git tag -a v1.0.0 -m "Work Intelligence 1.0.0"
git push origin v1.0.0
```

推送 tag 後，GitHub Actions 會跑完整發行檢查；全部通過後才建立 GitHub Release。發行 workflow（`.github/workflows/release.yml`）的結構比照 CI：Quality（Ubuntu、Windows、macOS）與 E2E（Chromium、Firefox、WebKit 各一個 job，只安裝該瀏覽器）同時開始，每個 OS 的單元與整合測試只跑一次（Ubuntu 為 lint＋format:check＋coverage，Windows 與 macOS 為 `pnpm test`），檢查項目與門檻不變；`Publish GitHub Release` 要等 Quality 三個 OS 與三個瀏覽器 job 全部成功才會開始。

另外，workflow 一開始的 `Detect verified commit` job（只有 `actions: read` 權限）會查詢 tag 指向的 commit 是否已在 `main` 有成功的 CI run：必須是同一個 commit SHA、`ci.yml` 的 push 事件、分支為 `main`、run conclusion 為 success，且 Quality 三個 OS、三個瀏覽器 E2E 與彙總 E2E 共七個 job 都是 success。符合時略過重複的 Quality 與 E2E，只重跑生產依賴稽核（`pnpm audit --prod --audit-level high`，因為安全公告會在 CI 之後更新），再執行發行步驟；tag、版本與 CHANGELOG 一致性、封存檔與 plugin 打包仍照常在 Publish job 執行。查不到 run、job 缺少或非 success、API 查詢失敗或任何不確定時，一律回到完整檢查。這個機制只對「先合併到 `main`、再對該合併 commit 推 tag」的標準流程生效；若在尚未通過 `main` CI 的 commit 上推 tag，會跑完整檢查。E2E 失敗時以 `release-playwright-results-<瀏覽器>` 上傳 `test-results/`。若 workflow 失敗，先修正問題、合併修正，再依修正後的 `main` 建立新的版本 tag；不要把既有 tag 移到不同 commit。

## 從舊版本升級

1. 在舊版專案執行 `pnpm check`，記下它顯示的資料庫位置；可先執行 `pnpm db:backup` 建立額外備份。
2. 從 GitHub Release 下載對應版本的 source archive，或取得該版本的原始碼。若安裝了登入自動啟動服務，先在舊版專案目錄執行 `pnpm service:uninstall`，並關閉 Work Intelligence server 與會啟動 MCP 的 Codex／Claude 工作階段。
3. 在新版專案目錄執行 `pnpm install --frozen-lockfile`、`pnpm build` 與 `pnpm check`。保留既有資料庫檔案及 `WORK_INTELLIGENCE_DB` 設定，並確認新版指向同一個資料庫絕對路徑；使用新的解壓目錄時，不要讓預設相對路徑意外建立空白資料庫。
4. 執行 `pnpm start`。首次以新程式開啟較舊 schema 的資料庫時，Work Intelligence 會先建立 migration 前備份，再自動套用所需 migrations；若備份失敗，升級會停止，不會套用 migration。
5. 確認 Dashboard 與 `/api/health` 正常後，重新連線 Codex／Claude，讓 MCP 載入新版；需要時再依[登入自動啟動指南](service.md)安裝服務。

不要手動修改 SQLite schema 或刪除 migration 記錄。若資料庫的 schema 比目前程式新，請更新 Work Intelligence 至支援該 schema 的版本；API、MCP 與 CLI 會拒絕以舊程式開啟較新的資料庫。
