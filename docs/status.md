# 專案現況與未結項

本頁先列目前仍開放或暫緩的工作；已完成階段移到下方歷史段落。實作細節與逐項複檢結果另見 PR、CHANGELOG、正式驗證文件與工作記錄。

> 回到 [README](../README.zh-TW.md)（[English](../README.md)）

- 最後更新：2026-11-07

## 後端效能改善（1.6.7 已完成）

依 2026-11-03 的效能交接計畫，P0 與 P1 已全部處理並於 1.6.7 發行；逐項量測、CI 結果與複檢紀錄見各 PR 與工作記錄。

| 項目 | 結果 |
| --- | --- |
| P0：系統狀態非同步、SQLite 頁面快取、Agent 讀取不再觸發全頁重抓（schema 31） | 已合併（#279、#281、#282） |
| 5.1 備份、匯出、匯入預覽移至 worker | 已合併（#283） |
| 5.6 metadata follow-up 改 SQL 聚合 | 已合併（#284） |
| 5.3 finalize 提醒延至 commit 後，失敗不影響已保存的 Session | 已合併（#285） |
| 5.4 Graph 只讀必要欄位與可顯示候選，RSS 降約 130–180 MB | 已合併（#292） |
| 5.5 Session 文字搜尋改走 FTS | 不合入：既有 FTS 斷詞無法保留子字串語意；改以 300 ms CI 門檻監控（#287） |
| 5.7 Recall 主要原始片段判定 | 不合入：量測慢約 15–20%（#289 已關閉） |
| 5.2 重量級讀取移至 worker | 不做：worker 常駐約 +43 MB，超過 40 MB 停止條件（#293 已關閉） |
| 第 6 節：Knowledge 過時判斷倒排索引、年報決策查詢固定計畫、attention fingerprint 摘要化 | 已合併（#294、#297） |

同期另完成：CI 平行化（總時間約 23 分降至 6.5 分，#288）、效能 gate 失敗案例重量一次（#291）、Storage 覆蓋率逐檔門檻（#295）、E2E 路由競態修正（#296）、Knowledge Health 唯讀研究（No-Go，#286）。

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

## 已完成歷史

各輪（第五至第九輪、1.5.x 健康檢查、Mermaid 移除、五項功能整合、MCP 精準讀取）的交付都已合併；逐項內容見對應 PR、[CHANGELOG](../CHANGELOG.md) 與[更新說明](releases/)。仍被引用的實測證據：

- 第八輪工作記錄來源核對：[agent-data-source-audit-2026-09-30.md](experiments/agent-data-source-audit-2026-09-30.md)
- 未結項清理建議的合成準確度（12 項正確建議、8 項證據不足保留，沒有更改真實未結項）：[outstanding-cleanup-accuracy-2026-10-01.md](experiments/outstanding-cleanup-accuracy-2026-10-01.md)
- 其餘合成探測與成本數據：見[測試文件的實驗資料表](testing.md#實驗資料)
