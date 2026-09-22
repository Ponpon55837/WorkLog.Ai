# WorkLog.Ai follow-up execution record

- 日期：2026-09-22
- 基準：`8c5be4f`
- 本次 commits：`b04469d`、`aa7cd16`
- 目的：收尾 legacy SQLite schema、補強 handoff parser 邊界，並以實測資料決定是否需要 async path resolver 重構。

## 1. 本次完成內容

### O — 移除 legacy `commit_required` 實體欄位

`commit_required` 已不再是公開 Session contract，也不代表 Git commit。這次完成實體清理：

- 新建立的 `sessions` table 不再建立 `commit_required`。
- Work Intelligence 啟動時，若既有 SQLite 還有此歷史欄位，會在 schema migration transaction 中執行 `ALTER TABLE sessions DROP COLUMN commit_required`。
- migration 以欄位存在性判斷，重複啟動不會重複執行。
- legacy migration test 會確認既有 Session 可讀取，且 migration 後欄位已不存在。
- README 已更新，明確說明 Git commit 是可選且獨立的流程。

Commit：`b04469d fix: migrate legacy session commit flag column`

### M — handoff parser 的輸出邊界

既有 handoff input 上限仍為 200,000 字元；本次再補上解析輸出與迭代邊界：

- status signals 最多保留 32 筆。
- changed files 最多解析 200 筆，與公開 schema 上限一致。
- inline changed files 與 section changed files 在達到上限後停止繼續解析。
- 新增測試確認超過上限時不會產生超額結果。

這是低風險的 parser hardening，不改變既有完成／阻塞／待處理判斷語意，也不會替 Agent 猜測 verification 或 changed files。

Commit：`aa7cd16 fix: bound handoff parser metadata extraction`

## 2. B — path resolver benchmark

依原執行包的要求，以目前公開 200 筆 changed files 上限，對 production build 的 `WorkIntelligenceStore.finalizeSession` 做 1 次 warm-up 後 10 次量測。每次使用 200 個不同的相對檔案路徑與 tracked temporary project，結果如下：

| 指標 | 結果 |
| --- | ---: |
| 量測次數 | 10 |
| changed files | 200 |
| 最快 | 170.645 ms |
| 中位數 | 204.697 ms |
| 最慢 | 366.620 ms |

結論：目前同步 path resolver 在公開 metadata 上限下仍落在可觀察但尚未足以支撐同步 facade 大改的範圍。本次不強行 async 化；若未來需要處理更高 metadata 上限、批次 ingest 或 UI thread blocking，再另開 async storage 重構批次，並重新量測真實資料集。

## 3. 驗證結果

- `pnpm test`：通過。包含 lint、format check、project-policy 6 tests、schema 12 tests、storage 40 tests、server 3 tests、MCP 6 tests。
- `pnpm typecheck`：通過。所有 workspace package 與 E2E TypeScript project 均通過。
- `pnpm build`：通過。8 個 workspace build target 均完成，Vue production bundle 正常產生。
- `pnpm test:e2e`：通過，5/5。
  - report synthesis 收合與可讀性
  - Worklog／Knowledge 預設每頁筆數
  - Graph filter 與 source detail navigation
  - 窄 viewport Session detail modal
  - direct page routes

## 4. 目前刻意保留的後續項目

1. `All` 的真正前端 virtual scrolling：目前已先完成 server-side hard cap、`pageInfo.truncated` 與分頁 UX，避免一次把無界資料送入 DOM；真正的 row virtualization 應另開前端效能批次，先定義可見列高度、鍵盤導覽、modal navigation 與 accessibility acceptance criteria。
2. async path resolver：本次 benchmark 尚未顯示需要立即改動同步 facade；保留 benchmark 作為未來比較基準。
3. 使用者提供的 `docs/reviews/2026-09-21-full-execution-package.md` 維持 untracked，沒有加入任何 commit。

## 5. 給 Claude 的複檢重點

- 檢查 legacy SQLite migration 是否只在 `commit_required` 欄位存在時執行，且不改變其他 Session／event／raw snapshot 資料。
- 檢查新 schema 不再建立 `commit_required`，公開 API 仍維持 Git optional 語意。
- 檢查 parser 的 200 changed files／32 status signals 上限是否與 schema contract 一致，且達上限後不會繼續建立超額陣列。
- 重新執行 `pnpm test`、`pnpm typecheck`、`pnpm build` 與 `pnpm test:e2e`。
- 確認未將使用者提供的 untracked execution package 納入 staged 或 commit。
