# 貢獻指南

感謝協助 Work Intelligence。此專案使用 pnpm workspace；請只用 `pnpm` 管理套件與執行 scripts，不要使用 npm CLI。

## 開發環境

需求：Node.js 22.5 以上（建議 24）及 `package.json` 指定版本的 pnpm。

```sh
pnpm install
pnpm build
pnpm dev
```

`pnpm dev` 啟動 Web 開發 server 與 REST API；正式模式則用 `pnpm build` 後執行 `pnpm start`。架構、資料契約與每個 package 的界線見 [docs/architecture.md](docs/architecture.md)。

### Web UI 變更

任何修改 `apps/web` 內 Vue、TypeScript 或 CSS 前，先讀：

- [worklog-ui skill](.agents/skills/worklog-ui/SKILL.md)：設計 token、元件目錄、頁面與無障礙規則。
- [worklog-web-code-style skill](.agents/skills/worklog-web-code-style/SKILL.md)：Vue、TypeScript、CSS 與檔案規範。

## 實作規則

- 新邏輯放在獨立模組，`store.ts` 只保留轉接與既有 public API 相容層。
- 外部輸入以 Zod schema 驗證；錯誤以穩定類別回應，不把 stack trace、SQL 或內部例外訊息送給使用者。
- 重用共用 helper 與既有契約，不複製貼上相同實作。
- 預設不讀取或保存 workspace。任何會接觸專案檔案的流程都要維持明確 opt-in 與 path boundary。
- hook 使用使用者全域設定；不要新增單一專案 Work Intelligence hook，也不要修改使用者的 Agent 設定。
- 測試資料使用虛構合成內容。不要讀寫 `data/work-intelligence.sqlite` 的實際資料；若確有必要以實際 schema 驗證，先用 `sqlite3 -readonly` 複製資料庫，並只在複本上操作。

## 逐步健康檢查

依序執行，每一步成功後才進到下一步；遇到失敗先修正，不要把後續命令當成通過：

```sh
pnpm build
pnpm test
pnpm typecheck
pnpm test:coverage
pnpm test:e2e
```

`pnpm test` 包含 lint、Prettier 檢查與各 workspace 單元測試。E2E 使用獨立暫存資料庫。診斷命令是 `pnpm run doctor`；pnpm 11 的 `pnpm doctor` 是套件管理器保留命令。

## 分支與 Pull Request

1. 從最新 `main` 開始，每個交接項目使用獨立分支與獨立 PR。
2. PR 說明要交代設計取捨、刻意未做的項目及逐步驗證方式；列出哪些命令成功與任何限制。
3. 確認 CI 對應 PR 最新 commit，所有必要檢查均為 success 後才合併。
4. 使用 merge commit；不要 squash。合併後刪除工作分支。

## 工作記錄

每完成一段長任務，就把工作記錄保存到 Work Intelligence；有明確開始時間時填入 `startedAt`。摘要須區分成果、範圍、決策、驗證與狀態／未結項。保存之前先確認專案狀態；只有使用者已授權為「記錄中」時才保存。全域 hook 只是提醒，不會代替保存工作記錄。
