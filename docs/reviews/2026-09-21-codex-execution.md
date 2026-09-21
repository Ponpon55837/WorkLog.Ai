# Work Intelligence Codex 執行文件

日期：2026-09-21  
執行範圍：`docs/reviews/2026-09-21-remaining-work.md` 第一批高優先修正  
用途：交由 Claude 進行第二輪複檢

## 1. 本次完成

### A. Metadata backfill 的 project-scoped policy skip 契約

修正前，`projectId` 查詢遇到 unknown、paused 或 ignored project 時，回應會錯誤使用 `projectRoot` 欄位。現在新增 `ProjectIdSkippedResult`：

```ts
{
  outcome: "skipped",
  projectId: string,
  projectStatus: "unregistered" | "tracked" | "paused" | "ignored",
  reason: string
}
```

已套用至：

- `createMetadataBackfillRequest`
- `listMetadataBackfillRequests`
- `cancelMetadataBackfillRequest`
- `getMetadataBackfillContext`

root-scoped API 仍保留原本的 `projectRoot` skip contract；只有以 registry `projectId` 為 scope 的 metadata request 才回傳 `projectId`。

新增測試覆蓋：

- 不存在的 project id 不會進入資料掃描，且回傳 `projectId`。
- paused project 的 list、cancel、context 都安靜 skip，且不會寫入。

### B. Changed-file 輸入邊界與路徑解析

- finalize／metadata update 的 `changedFiles`、provenance、lifecycle changes 上限由 500 降為 200。
- `ProjectPathResolver` 會在一次操作中快取 tracked root 的 real path，再逐筆檢查既有 path 的 symlink 邊界。
- metadata normalization 使用 lexical-safe path，因此 deleted 或尚未建立的檔案仍可被保存為 metadata。
- 真正要讀取的 source、handoff、Git path 仍使用 existing real path，symlink 指向 project root 外時 fail closed。
- handoff discovery 也改為同一個 operation-scoped resolver，避免掃描每個檔案時重複解析 project root。

### C. Deterministic graph 批次讀取

`getGraph` 原本在計數查詢後，還會逐 project 呼叫 `listSessions`、`searchKnowledge`，並逐 project 查詢 evidence。現在改為：

- tracked scope 內的 Session 一次查詢並依 project 分組。
- active Knowledge 一次查詢並依 project 分組。
- Evidence 一次查詢並依 Session 分組。
- render 階段只從已載入的分組資料取用，保留原本的排序、`limit`、`maxNodes`、`maxEdges` 與 totals 語意。
- 仍不讀取 project source、handoff 或 Git。

這一批已消除 graph render path 的 per-project N+1 查詢；仍保留 graph 的節點與邊配額。

### D. Spec / MCP 說明同步

- README 補上 200 筆 changed-file 輸入上限。
- README 補上 project-scoped metadata skip 必須保留 `projectId` 的契約。
- MCP server instructions 與 metadata tool contract 明確說明 projectId-scoped skip response 不得誤當成 projectRoot。

## 2. 修改檔案

- `packages/core/src/index.ts`
- `packages/project-policy/src/index.ts`
- `packages/schema/src/index.ts`
- `packages/schema/src/index.test.ts`
- `packages/storage/src/path-safety.ts`
- `packages/storage/src/handoff-importer.ts`
- `packages/storage/src/store.ts`
- `packages/storage/src/store.test.ts`
- `apps/mcp/src/index.ts`
- `README.md`

本執行文件：`docs/reviews/2026-09-21-codex-execution.md`

## 3. 驗證結果

以下均在 `C:\Users\dgh\Desktop\github\WorkLog.Ai` 執行：

| 驗證 | 結果 |
| --- | --- |
| `pnpm test` | 通過：43 tests，project-policy 6、schema 3、storage 25、server 3、MCP 6 |
| `pnpm typecheck` | 通過：workspace typecheck + `tsconfig.e2e.json` |
| `pnpm build` | 通過：core、shared、project-policy、schema、storage、server、MCP、web |
| `pnpm test:e2e` | 通過：4/4 Playwright browser regression |
| `pnpm audit --prod` | `No known vulnerabilities found` |

E2E 通過項目包含：報告提煉卡片、Worklog／Knowledge page-size、Graph filter／source detail、窄視窗 Session modal。

## 4. Claude 複檢清單

1. 檢查 `ProjectIdSkippedResult` 是否只套用在 projectId-scoped metadata API，且沒有破壞 root-scoped `SkippedResult`。
2. 檢查 unknown／paused／ignored project 在 metadata request 的所有讀寫入口是否都先 policy gate，再讀取 Session 或 source。
3. 檢查 `ProjectPathResolver` 的 Windows path、project root symlink、project 內 symlink、deleted path 與不存在 root 行為。
4. 比對 graph 改動前後的 node／edge totals、排序、sourceSessionIds、truncation，以及多 project scope 的結果。
5. 靜態確認 `getGraph` 已不再呼叫 `listSessions`、`searchKnowledge` 或在 project loop 內執行 evidence SQL。
6. 重跑本文件第 3 節的四組驗證，並檢查 build 後 package `dist` 與 source contract 是否同步。
7. 以完整 diff 檢查是否有與本批 A～D 無關的格式化、API 或 UI 行為變更。

## 5. 尚未處理的 remaining work

以下刻意未在本批提前擴大範圍，避免把高風險架構整理與契約修正混在同一批：

- ESLint／Prettier／coverage toolchain 與 coverage gate。
- `store.ts`、`App.vue` 的模組化，以及 API client／composable 抽離。
- skipped result 命名在全體 API 的一致化。
- Graph 超大資料集的 SQL window／chunk／virtualization 策略；本批是 batch query，尚不是完整 virtualized graph。
- `All` page-size 的前端 virtualization，以及 Worklog／Knowledge／Evidence 的大型資料 UX。
- handoff importer 專屬測試、ReDoS／regex budget、stale recovery 的 transaction 強化。
- legacy `commitRequired` 清理與 `packages/core/src/modules.ts` 的實際介面收斂。
- App.vue 剩餘 `document.execCommand("copy")` fallback 的集中化。

## 6. 工作樹狀態

本 repo 目前仍是初始未提交工作樹，沒有建立 commit，也沒有 staged files。Claude 複檢時請以完整工作樹與本文件為基準，不要把 `dist`、`node_modules`、測試資料庫或 E2E 暫存輸出當成 source diff。
