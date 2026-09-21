# Work Intelligence Codex 修正執行文件

日期：2026-09-21  
對應複檢：`docs/reviews/2026-09-21-remaining-work-v2.md`  
用途：交由 Claude 進行下一輪複檢

## 1. 本批修正範圍

### A1：補齊 changed-file 陣列邊界測試

`finalizeSessionInputSchema` 與 `updateSessionMetadataInputSchema` 的下列三種陣列都維持 `.max(200)`：

- `changedFiles`
- `changedFilesProvenance`
- `changedFileChanges`

現在 `packages/schema/src/index.test.ts` 已覆蓋 finalize 與 metadata update 的全部四種新增邊界案例：

- finalize 的 provenance 超過 200 筆會拒絕
- finalize 的 lifecycle changes 超過 200 筆會拒絕
- metadata update 的 provenance 超過 200 筆會拒絕
- metadata update 的 lifecycle changes 超過 200 筆會拒絕

### B：降低同一批次路徑解析的重複同步 I/O

`createProjectPathResolver` 現在除了快取 tracked root 的 real path，也會在 operation scope 內快取：

- lexical-safe path 結果
- existing real path 結果

相同 canonical path 在同一個 resolver 生命週期內不會重複執行完整的 `existsSync`／`realpathSync` 邊界檢查。安全語意維持不變：

- metadata path 可以保留 lexical path
- 實際讀檔仍必須取得 project root 內的 existing real path
- symlink 指向 project root 外仍 fail closed

本批沒有把 storage API 改成 async，也沒有新增 worker 或 `p-limit`。原因是目前 `WorkIntelligenceStore`、REST handler、MCP handler 都是同步 facade；若要改 async，應另開完整 contract 與效能基準批次。

### 文件同步

`docs/reviews/2026-09-21-remaining-work-v2.md` 已同步修正：

- A1 標記為已完成。
- policy check 實際數量由 29 修正為 30。
- B 改為「先 benchmark，再評估 async」，不再把局部 `Promise.all` 當成直接修法。
- H 改為先建立 root／project-id／session-id scope contract tests，不直接統一既有 response shape。
- L 明確包含 Report 原始 Session 與 Evidence 的 `All` 選項。
- N 改為優先拆出可測試純 parser，不為測試而擴大 production export surface。

## 2. 修改檔案

- `packages/schema/src/index.test.ts`
- `packages/project-policy/src/index.ts`
- `docs/reviews/2026-09-21-remaining-work-v2.md`
- `docs/reviews/2026-09-21-codex-correction-execution.md`

## 3. 驗證結果

在 `C:\Users\dgh\Desktop\github\WorkLog.Ai` 執行：

| 驗證 | 結果 |
| --- | --- |
| `pnpm test` | 通過：47 tests；project-policy 6、schema 7、storage 25、server 3、MCP 6 |
| `pnpm typecheck` | 通過：workspace typecheck + `tsconfig.e2e.json` |
| `pnpm build` | 通過：全部 workspace production build |
| `pnpm test:e2e` | 通過：4/4 Playwright browser regression |
| policy check inventory | 目前 30 處 `this.policyGate.check(...)` |

## 4. Claude 複檢重點

1. 確認四組 schema 邊界測試確實驗證 provenance／lifecycle changes，而不是只驗證 changedFiles。
2. 檢查 resolver cache key 在 Windows 大小寫、相對路徑／絕對路徑、slash／backslash 情境下不會造成安全邊界誤判。
3. 確認 cache 只存在於單次 resolver operation，不會跨 project 或跨請求污染結果。
4. 確認 `safeExistingPath` 仍會對不存在檔案與 project-root 外 symlink fail closed。
5. 確認 v2 文件的 G=30、H scope 說明與目前 core 型別一致。
6. 重跑第 3 節的測試、typecheck、build、E2E；確認沒有新增未預期的 UI／API 行為變更。

## 5. 刻意未處理

以下不屬於本批小幅修正，仍保留在 v2 待辦：

- ESLint／Prettier／coverage toolchain
- `store.ts` repository 拆分與 policy helper 去重
- `App.vue` views/components 拆分與集中 API client
- H 的完整 scope contract inventory
- `All` 的 server-side hard cap／virtualization
- handoff parser 專屬測試、ReDoS 評估、`commitRequired`／modules.ts 清理、stale recovery transaction
- async storage／worker-based path processing

## 6. Git 狀態

本批沒有建立 commit，也沒有 staged files。由於目前 repo source 仍是未提交工作樹，Claude 複檢時請以本文件、v2 清單與完整工作樹為基準。
