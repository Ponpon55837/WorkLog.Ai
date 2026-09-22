# Work Intelligence Codex 執行文件

日期：2026-09-22
基準 commit：`40c1d3b`
最新 commit：`f21c336`
用途：交由 Claude 進行完整複檢，並記錄本輪前端彈窗回歸修正。

## 1. 執行摘要

已完成 `2026-09-21-full-execution-package.md` 所列的主要 D、E、F、G、H、I、J、K、L、M、N、O、P、Q 項目，並保留 B 的 async path resolver 為後續獨立評估項目。

本輪另外修正一個實際回歸：集中 API client 重構期間，`App.vue` 已移除通用 `request<T>()` 解構，但仍有明細與彈窗流程依賴該函式，造成多個原本可開啟的完整內容彈窗失效。現在所有明細、來源、變更紀錄、圖譜節點與 handoff 操作都統一經過 typed `ApiClient`。

## 2. 分批 checkpoint

| 批次 | 項目                                                     | commit    |
| ---- | -------------------------------------------------------- | --------- |
| 1    | D：ESLint / Prettier 安全網                              | `31b880e` |
| 2    | F/G：storage repository 拆分與 policy helper             | `98758a8` |
| 3    | H：skipped response scope contract tests                 | `3e0f4f0` |
| 4    | Structured work summary contract（額外需求）             | `1d97e14` |
| 5    | I/J：Web views 拆分、router、API client、composable      | `7b2a809` |
| 6    | E/N：coverage tooling、handoff parser 與測試             | `90cbca1` |
| 7    | K/L/M：clipboard、All hard cap、handoff parser hardening | `8d246fc` |
| 8    | O/P/Q：legacy 清理與 stale recovery transaction          | `c71a6af` |
| 9    | 明細／彈窗 API 回歸修正                                  | `f21c336` |

## 3. 本輪 `f21c336` 修正

### 根因

`App.vue` 開始使用 `ApiClient` 的 typed methods 後，仍有以下流程使用已被移除的 `request<T>()`：

- Worklog Session Detail
- Knowledge 來源 Session
- Knowledge 變更紀錄
- Knowledge 更新
- Graph 相關 Session
- Project handoff preview / apply
- Metadata backfill preview / request / cancel
- Project create / status update

這會使前端模組在 HMR 或重新編譯後出現請求函式不存在，使用者看到的結果就是按鈕仍在，但完整內容彈窗無法載入或沒有反應。

### 修正

`apps/web/src/api/client.ts` 新增並集中以下 typed endpoint：

- report synthesis request / retry / cancel / delete
- report summary / export
- project create / update
- metadata backfill list / create / cancel / preview
- handoff preview / import
- session detail
- Knowledge history / update

`apps/web/src/App.vue` 的所有資源載入、操作與明細彈窗流程改用上述 client；保留每個流程原有的 AbortController request key、loading、error 與 policy response handling。

### 影響範圍

- 不改 REST endpoint、response shape 或 MCP contract。
- 不改 modal 內容結構、路由或使用者操作流程。
- `All` page-size 仍轉為 API 的 `pageSize=0`，由既有 server hard cap 處理。
- Session id、Knowledge id、summary id、request id、project id 的 path segment 由 client 統一 encode。

## 4. 修改檔案

本輪最新修正：

- `apps/web/src/App.vue`
- `apps/web/src/api/client.ts`
- `docs/reviews/2026-09-22-codex-execution.md`

前序批次的完整檔案清單可由各 checkpoint commit 與 `git diff 40c1d3b..f21c336` 取得。主要模組包含：

- `packages/storage/src/*-repository.ts`
- `packages/storage/src/graph-builder.ts`
- `packages/storage/src/report-builder.ts`
- `packages/storage/src/handoff-parser.ts`
- `packages/project-policy/src/index.ts`
- `packages/schema/src/index.ts`
- `packages/core/src/index.ts`
- `apps/server/src/index.ts`
- `apps/mcp/src/index.ts`
- `apps/web/src/views/*.vue`
- `apps/web/src/components/*.vue`
- `apps/web/src/composables/*.ts`

使用者提供的 `docs/reviews/2026-09-21-full-execution-package.md` 仍是 untracked input 文件，沒有納入任何 commit。

## 5. 驗證結果

以下均在 `C:\Users\dgh\Desktop\github\WorkLog.Ai` 執行：

| 驗證               | 結果                                                                     |
| ------------------ | ------------------------------------------------------------------------ |
| `pnpm test`        | 通過：66 tests；project-policy 6、schema 12、storage 39、server 3、MCP 6 |
| `pnpm typecheck`   | 通過：workspace typecheck + `tsconfig.e2e.json`                          |
| `pnpm build`       | 通過：全部 workspace production build                                    |
| `pnpm test:e2e`    | 通過：5/5 Playwright browser regression                                  |
| `pnpm lint`        | 通過                                                                     |
| `git diff --check` | 通過                                                                     |

E2E 涵蓋：

- 報告提煉卡片與歷史版本
- Worklog / Knowledge 分頁
- Graph filters、sticky header 與節點詳細資料彈窗
- 窄視窗 Session Detail 彈窗
- 直接 `/reports`、`/worklog` 路由

另外使用目前 Chrome 的 `http://127.0.0.1:5966/worklog` 實測確認：

- Worklog Session Detail 可開啟完整內容。
- Knowledge 來源 Session 可開啟完整內容。
- Knowledge 變更紀錄可開啟。
- Graph 專案節點可開啟 Graph Node Detail。
- Reports 工作項目可開啟 Session Detail。
- 瀏覽器 console 沒有新增 error / warning。

## 6. Claude 複檢重點

1. 檢查 `App.vue` 是否已沒有殘留 `request<T>()` 呼叫，所有 API 是否經 `ApiClient` typed method。
2. 檢查 `useApiRequest()` 的 AbortController request key 在 typed client 遷移後仍維持原本的取消與 stale response 保護。
3. 檢查 `getSessionDetail`、`getKnowledgeHistory`、`updateKnowledge`、Graph node detail 與 report source navigation 的 id / query encoding。
4. 以真實瀏覽器重新驗證 Worklog、Knowledge、Reports、Graph 的明細彈窗，不只檢查 route 或按鈕存在。
5. 重跑本文件第 5 節驗證，尤其是 `pnpm test:e2e` 的窄版 Session Detail 與 Graph source detail。
6. 確認使用者提供的 execution package 未被 stage 或 commit。

## 7. 刻意未處理或延後

- B：`ProjectPathResolver` 是否全面 async 化；目前保留同步 facade，應另開 benchmark 與 contract 批次。
- Graph 的真正 virtualized rendering；目前已有 server-side node/edge quota、preview limit 與載入上限。
- `All` 的前端 virtual scroll；目前由 server hard cap + `truncated` page info 保護。
- legacy SQLite `commit_required` physical column；已從 public contract 移除，待 versioned migration 再清除資料欄位。
- `docs/reviews/2026-09-21-full-execution-package.md` 未納入版本控制，供複檢參照。

## 8. Git 狀態

最新 source checkpoint：`f21c336 fix: restore work detail modal requests`。

工作樹中僅保留使用者提供的未追蹤 execution package；本執行文件會另行提交，不會把該 input 文件一起加入 commit。
