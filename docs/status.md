# 專案現況與未結項

本頁先列目前仍開放或暫緩的工作；已完成階段移到下方歷史段落。實作細節與逐項複檢結果另見 PR、CHANGELOG、正式驗證文件與工作記錄。

> 回到 [README](../README.zh-TW.md)（[English](../README.md)）

- 最後更新：2026-11-06

## 後端效能改善

System Status 的登入服務查詢已改為非同步，成功結果快取 30 秒並共用進行中的查詢；SQLite 連線的頁面快取設定為 16,000 KiB。P0 PR #282 的 schema 31 revision 通知、P1 5.1 PR #283 與 5.6 PR #284 已合併。PR #284 合併後 main 為 `8bdd045`，main run `42138658788` 全綠；逐瀏覽器 E2E 結果見下方 PR #284 驗證段落。

Knowledge 過時判斷（`possiblyStale`，由 `work_get_context`、`work_recall`、`searchKnowledge`、`getAttention` 共用）改為每個專案建一次「正規化檔案路徑 → Session 索引」，每個不同的 `appliesTo` pattern 只對不同檔案比對一次並快取，再依各 Knowledge 的時間界線與排除 Session 合併；回傳內容（計數、首個 Session、paths、排序）與原演算法一致，由 `tests/storage/knowledge-staleness-equivalence.test.ts` 以保留的舊實作作 oracle 驗證。合成資料（20 筆 Knowledge × 2,500 Sessions，每個 Session 2 個檔案）在負載平均約 260 的繁忙機器上，4 輪交錯、以 `process.cpuUsage()` 取各案例 15 次中位數：recall 約 119 → 59 ms CPU，searchKnowledge 約 106 → 41 ms CPU；牆鐘時間受機器負載影響僅供參考。完整 `pnpm test:performance` 交由 CI，未調整任何門檻。

P1 5.3 在分支 `perf/finalize-related-items` 實作：新建 finalize 與冪等重送的提醒查詢都在最外層 IMMEDIATE commit 後執行，包含 MCP 的 `withCompatibleSchema` 外層交易；候選篩選保留原本關鍵字、來源 Session、路徑條件與排序。三組 5,000 Sessions 合成基準中，操作 p90 為 89.77 → 83.79、114.06 → 112.98、146.99 → 146.95 ms，交易 p90 為 54.67 → 23.14、75.40 → 31.06、126.44 → 46.88 ms。操作門檻仍為 250 ms，交易新增 50 ms 上限；focused bench 通過兩項門檻。PR #285 的程式碼 head `8fa4329` 在 CI run `42180612043` 的 Quality 三平台與 E2E 均通過：Chromium 177 passed、1 skipped、1 flaky（`report-presentation.spec.ts:227` 首次 `route.continue: Route is already handled!`，重試通過），Firefox 123 passed，WebKit 120 passed。PR 未合併且未設 auto-merge，等待 Claude 複檢。

P1 5.1 在獨立 worktree 實作：備份、整庫匯出、專案資料匯出與匯入預覽使用專用 worker connection；自動備份延至 server 啟動 60 秒後，shutdown 會先等 HTTP 請求與 worker 排空，再關閉 SQLite。worker 使用唯讀連線並核對主程序傳入的 schema 版本；專案資料匯出以 transfer UTF-8 bytes 回傳。快照發布優先使用原子 hard link；不支援 hard link 時用 `openSync(target, "wx")` 專有佔位再 rename，rename 失敗會刪除佔位。完成後目標目錄不留 `.wi-publish-*` 鎖檔或 staging。

340ff3e（加入 transfer bytes 前）本機以 5,000 Sessions、11.2 MiB 合成快取資料庫量測；同一資料庫跑三輪，每輪交錯 control／worker，各案例 5 次取 p90，再取三輪 p90 的中位數。操作總時間與 `/api/health` 分開量測；health pass 在重工作期間每 10 ms 探測，事件迴圈以 10 ms `monitorEventLoopDelay` 連續量測。主機為 Windows／Node 24.16／12 個邏輯處理器；命令序列執行，沒有同時跑其他測試，受限執行環境無法讀取整台主機的 CPU 負載，因此絕對值仍可能有背景負載雜訊。下表的操作與 health 門檻均維持原值；事件迴圈阻塞上限依 Ubuntu CI p90 11.26–44.83 ms 的兩倍 89.66 ms 進位為 100 ms。

| HTTP 路徑 | 操作總 p90：control → worker | health p90：control → worker | 事件迴圈阻塞 p90：control → worker | 門檻（操作／health／阻塞） |
| --- | ---: | ---: | ---: | ---: |
| 手動備份 | 834.87 → 763.89 ms | 832.89 → 13.43 ms | 824.18 → 25.79 ms | 300／300／100 ms |
| 整庫匯出 | 1,044.40 → 1,044.73 ms | 39.09 → 9.61 ms | 773.32 → 48.96 ms | 300／300／100 ms |
| 專案資料匯出 | 914.41 → 1,029.37 ms | 868.50 → 12.29 ms | 791.67 → 106.30 ms | 400／400／100 ms |
| 匯入預覽 | 2,556.72 → 2,729.26 ms | 2,554.20 → 12.83 ms | 2,539.65 → 106.69 ms | 1,500／1,500／100 ms |

該 340ff3e A/B 的 worker health 四項通過；操作總時間四項仍超過原門檻，專案匯出與匯入預覽的阻塞 p90 也超過 100 ms。其冷啟動操作 p90（只回報、不設門檻）為 314.64、410.65、633.93、1,302.25 ms；操作 process RSS peak 範圍為備份 279.3–283.6、整庫匯出 193.6–333.5、專案匯出 420.2–537.7、匯入預覽 494.7–512.1 MiB。合成自動備份前 process RSS 為 402.1／428.4／454.9 MiB，尖峰為 405.0／430.9／454.9 MiB，15 秒 idle close 後為 143.2／144.8／144.4 MiB。

加入 UTF-8 bytes transfer 後，完整 `pnpm test:performance` 本機單輪仍未通過：worker 操作總 p90／health p90／event-loop blocking p90 分別為備份 508.47／14.42／27.53 ms、整庫匯出 549.06／10.04／24.74 ms、專案匯出 628.08／14.05／26.02 ms、匯入預覽 2,120.60／10.78／39.78 ms；操作門檻仍為 300／300／400／1,500 ms，blocking 門檻為 100 ms。冷啟動操作 p90（只回報、不設門檻）為 1,370.49、1,609.46、1,975.55、3,988.70 ms。每項操作 process RSS peak 為 509.8、518.2、520.9、554.5 MiB；合成自動備份前 process RSS 為 504.2 MiB、尖峰 524.6 MiB，worker 閒置 15 秒關閉後為 314.7 MiB。此輪在 Windows／Node 24.16／12 個邏輯處理器執行，沒有與其他測試並行；當時 process RSS 已是 504.2 MiB，且系統整體 CPU 負載無法讀取。完整效能 gate 另有 13 個既有 read-path／MCP 案例超標，原始結果保留於暫存 log。

`pnpm test:e2e` 在 340ff3e 本機實跑為 117 passed、15 failed，包含測試／截圖 30 秒 timeout 與一項 visibility assertion；Chromium 執行失敗後 Firefox／WebKit 未執行。此結果不宣稱 E2E 通過；新 head 的 E2E 必須待 CI 實際執行並通過。完整測試與 benchmark 原始 log 保留於本次工作暫存目錄；詳細測法見 [testing.md](testing.md)。

本次 bytes-transfer 修正的新 head 本機 `pnpm test:e2e` 也未取得完整摘要：Chromium 輸出至少 125 個成功與 16 個失敗結果後，連續超過 6 分鐘沒有新 log，確認測試 Node runner 已結束後中止外層命令。此為不完整的本機執行，不當作 E2E 通過或最終測試計數；log 與 Playwright artifacts 保留於隔離 worktree／暫存目錄。新 head 的 CI E2E 仍須實際跑完並通過。

[PR #283](https://github.com/Ponpon55837/WorkLog.Ai/pull/283) 已於 `e888dd8` 合併。Main workflow run `41984113718` 第 2 次執行的 Quality 三平台與 CI E2E 全綠。各瀏覽器結果：Chromium 178 passed／1 skipped，Firefox 123 passed，WebKit 119 passed／1 flaky（重試後通過）。5.6 從這個最新 main 開始，延續原效能門檻；操作與 health 分開量測，事件迴圈阻塞門檻維持 100 ms。

P1 5.6 將 `work_get_context` 的 metadata follow-up totals 改由 SQLite 聚合計算，避免為了筆數載入並映射所有預覽項目；完整 metadata preview 與既有回傳形狀不變。`read-paths.bench.mjs` 新增 5,000 Sessions count-only 案例，要求 totals 與完整 JavaScript preview 一致並設 100 ms 門檻。`publishSnapshotNoClobber` 的 hard-link 備援路徑也確保 reservation fd 只關閉一次。

5.6 合成基準在相同 5,000 Sessions 資料上交錯比較完整 JavaScript preview 與 SQL totals，三輪合併 p90 為 111.99 → 95.45 ms（下降 14.8%）；完整 read-path bench 的 count-only p90 為 66.52 ms，低於 100 ms 門檻。`getContext (project with pages)` p90 為 232.76 → 202.49 ms；`getContext (related pending items)` 則為 541.65 → 566.53 ms，沒有改善。完整 `pnpm test:performance` 未通過：這個 count case 通過，但 related-pending、MCP runtime／recall 及四項 worker 操作總時間超標；worker health 與 event-loop blocking 均在門檻內，門檻未放寬。機器為 Windows／Node 24.16／12 個邏輯處理器，使用暫存目錄與合成資料，量測依序執行；當時程序 RSS 高且系統 CPU 狀態無法讀取，數據有背景負載變異，完整 log 保留於暫存目錄。

第 8 節其餘本機結果：`pnpm build`、`pnpm typecheck`、`pnpm test:retrieval-quality`（25/25）通過；`pnpm test` 與 `pnpm test:coverage` 各為 370 passed、6 failed、1 expected fail，storage 的 5 項大資料案例逾時、1 項 Windows symlink 建立回 `EPERM`。storage 失敗後分開跑的 Server 為 243 passed、16 failed、1 skipped（setup hardlink 與 junction 回 `EPERM`）；MCP 99/99、Web 189/189 通過。`pnpm test:e2e` 本機 run 因 Chromium／UI cases 逾時而在部分 cases 後中止；留下 Playwright artifacts 與 log，不當作通過，Firefox／WebKit 本機沒有執行。最新 PR #284 head `430d6003` 的 CI run `42016889108` 四項檢查全綠。E2E：Chromium 178 passed／1 skipped／0 flaky、Firefox 123／0／0、WebKit 120／0／0；`report-presentation.spec.ts:227` 三瀏覽器均通過，本輪未出現 `Route is already handled` 或重試。

Ubuntu 效能 gate 使用 5,000 筆合成 Sessions，操作時間與 health 探測分開量測。操作／health／event-loop blocking p90：備份 125.87／4.06／10.73 ms、整庫匯出 225.27／25.47／13.47 ms、專案匯出 390.01／15.40／11.99 ms、匯入預覽 959.68／1.26／24.71 ms；RSS peak 537.7／598.3／664.3／744.3 MB。操作門檻仍為 300／300／400／1,500 ms，blocking 門檻 100 ms。冷啟動操作 p90 308／380.9／571.89／1,297.15 ms（只回報）；metadata follow-up counts p90 16.57 ms／100 ms 門檻。

## 知識品質 Roadmap（已完成）

2026-10-22 至 10-30 依實測逐階段執行：Phase 0 建立私有題庫與規模基線；Phase 2 與 P0（PR #261～#263、#268～#271）改善 recall 排序並補上答案性規則，confidence 計算維持不變；Phase 1、Phase 3 C1–C4 與 Phase 4 D2 經量測沒有實際失敗而不做，D3 經使用者決定不做；Phase 4 D1 以 PR #275 加入有界的 `relevant.supplements`，parent／related 觸及率 28.3% → 37.6%、active applied Knowledge 7.4% → 18.5%，私有題庫指標不變。計畫文件已刪除，逐輪數字見各 PR 與 CHANGELOG；長期規模問題只在實測出現瓶頸時再處理。

## 使用者待辦

| 項目 | 狀態與範圍 |
| --- | --- |
| 實機驗收 | 1.5.0 起依使用者指示免驗，未寫成實測通過；[清單](release-checklist.md)保留原生資料夾選擇、Windows 備份還原／hook／登入服務／bootstrap、macOS Safari、私有 36 題檢索評估與另一個真實專案的完整流程 |

## 其他暫緩工作

| 項目 | 狀態 | 再次評估條件 |
| --- | --- | --- |
| 不需要 checkout 的發行方式 | [研究](experiments/standalone-distribution-spike-2026-10-15.md)完成、未實作；Release 已附自帶 MCP 的 plugin 與 `.mcpb` | 使用者決定是否以 Release 附件為官方管道，以及是否發佈 npm（套件名稱、帳號、2FA） |
| 歷史 Mermaid 圖表整理成 architecture 快照 | 不阻擋任何功能；歷史圖表以原始碼保留 | 使用者選定要整理的圖表後，逐張核對原工作來源再建立新快照 |
| TypeSafe Adapter（Insight Provider Phase 2） | 等待外部契約 | 產品方定稿 SDK 或 HTTP endpoint、credential／egress 規則、request／response／error schema，以及 timeout／retry／circuit-breaker 契約前不新增依賴或網路呼叫 |
| Async path resolver | 刻意延後 | 只有在提高 metadata 上限、加入批次 ingest，或實測到 server／UI 阻塞時才重新量測並評估 |
| Graph 總數計算 | 觀察中 | 目前合成效能基準仍在既定門檻內；出現可重現的效能問題時再評估 |
| Storage 覆蓋率範圍 | 門檻目前只計算 `handoff-parser.ts` | 納入報告合成、提醒聚合等高風險服務前，先量測目前覆蓋率再訂門檻 |

## 已完成歷史

各輪（第五至第九輪、1.5.x 健康檢查、Mermaid 移除、五項功能整合、MCP 精準讀取）的交付都已合併；逐項內容見對應 PR、[CHANGELOG](../CHANGELOG.md) 與[更新說明](releases/)。仍被引用的實測證據：

- 第八輪工作記錄來源核對：[agent-data-source-audit-2026-09-30.md](experiments/agent-data-source-audit-2026-09-30.md)
- 未結項清理建議的合成準確度（12 項正確建議、8 項證據不足保留，沒有更改真實未結項）：[outstanding-cleanup-accuracy-2026-10-01.md](experiments/outstanding-cleanup-accuracy-2026-10-01.md)
- 其餘合成探測與成本數據：見[測試文件的實驗資料表](testing.md#實驗資料)
