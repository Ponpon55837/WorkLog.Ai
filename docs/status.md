# 專案現況與未結項

本頁先列目前仍開放或暫緩的工作；已完成階段移到下方歷史段落。實作細節與逐項複檢結果另見 PR、CHANGELOG、正式驗證文件與工作記錄。

> 回到 [README](../README.zh-TW.md)（[English](../README.md)）

- 最後更新：2026-11-07

## 1.6.8（已完成）

| 項目 | 結果 |
| --- | --- |
| Node.js 26.9 以上 FTS5 刪除標記使報告、recall 回 500 | 已修正（#305）；CI 加 Node 26 storage 測試 |
| Node.js 最低需求（22.13–22.15、23.x 沒有 FTS5） | 改為 22.16 以上的 22.x 或 24 以上，bootstrap 與 check 會檢查（#307） |
| MCP 更新後不必重連 | 穩定 launcher 替換 server 子行程（#308），發行前審查補上取消、排空與私有回應修正（#311） |
| 無 checkout 發行第一階段 | 資料庫路徑解析統一（#304）、獨立套件與 `work-intelligence` 指令（#309）、Release 附 tarball 與 SHA256SUMS（#310） |
| Web 主 bundle | 514 → 313 kB，gzip 168 → 111 kB（#306） |
| 發行 workflow | E2E 平行化（#299）、已驗證 commit 略過重複檢查（#301）、只發佈驗證過的 commit（#311） |
| 搜尋索引大量重建 | 先刪後插，全部 dirty 時中位數約減半（#311） |
| Windows 快照遷移測試逾時 | 測試回退改單一交易，7.7 → 1.3 秒（#303） |
| README、方向研究 | README 移除版本摘要（#300）；[方向研究](experiments/direction-research-2026-11-07.md)產出改進候選 C1–C6（#302） |

## 知識品質 Roadmap（已完成）

2026-10-22 至 10-30 依實測逐階段執行：Phase 0 建立私有題庫與規模基線；Phase 2 與 P0（PR #261～#263、#268～#271）改善 recall 排序並補上答案性規則，confidence 計算維持不變；Phase 1、Phase 3 C1–C4 與 Phase 4 D2 經量測沒有實際失敗而不做，D3 經使用者決定不做；Phase 4 D1 以 PR #275 加入有界的 `relevant.supplements`，parent／related 觸及率 28.3% → 37.6%、active applied Knowledge 7.4% → 18.5%，私有題庫指標不變。計畫文件已刪除，逐輪數字見各 PR 與 CHANGELOG；長期規模問題只在實測出現瓶頸時再處理。

## 使用者待辦

| 項目 | 狀態與範圍 |
| --- | --- |
| 實機驗收 | 1.5.0 起依使用者指示免驗，未寫成實測通過；[清單](release-checklist.md)保留原生資料夾選擇、Windows 備份還原／hook／登入服務／bootstrap、macOS Safari、私有 36 題檢索評估與另一個真實專案的完整流程 |

## 其他暫緩工作

| 項目 | 狀態 | 再次評估條件 |
| --- | --- | --- |
| 無 checkout 發行的後續階段 | 第一階段（Release tarball、`work-intelligence` 指令）已於 1.6.8 發行；獨立套件尚未提供 Agent 註冊與登入服務 | 依[研究](experiments/standalone-distribution-spike-2026-10-15.md)第 8 節的 PR3（Agent 註冊與 MCP 重啟偵測）、PR4（直接以 node 執行的登入服務）；npm 發佈另待使用者決定名稱、帳號與 2FA |
| 方向研究的改進候選 | [C1–C6](experiments/direction-research-2026-11-07.md)：Session 輕量重讀、狀態確認併入 context、知識頁 not_found 診斷、知識搜尋零命中後備、讀取稽核加耗時與錯誤碼、report synthesis 拆段。C5 已完成：schema 32 的讀取稽核記錄 `duration_ms`／`error_code`（含失敗的讀取），系統狀態顯示各工具次數、p50／p95 與失敗數。C1 已完成：`work_get_session` 回傳內容雜湊 `session.revision`，帶回 `knownRevision` 且未變時回傳 `session_unchanged`，稽核記錄 `session_unchanged`。C2 已完成：帶 `projectRoot` 的 `work_get_context` 頂層回傳 `projectStatus`／`tracked`，非 tracked 只回 `skipped` 狀態；Agent 指引改為開始與 finalize 前各一次 context，不再另呼叫 `work_get_project_status` | C3、C4、C6 待累積 C5 的耗時與錯誤代碼資料後，依最慢工具與失敗類型排序；C1 採用率以稽核 `session_unchanged` 次數衡量，C2 成效以稽核中 `work_get_project_status` 占比下降衡量 |
| 歷史 Mermaid 圖表整理成 architecture 快照 | 不阻擋任何功能；歷史圖表以原始碼保留 | 使用者選定要整理的圖表後，逐張核對原工作來源再建立新快照 |
| TypeSafe Adapter（Insight Provider Phase 2） | 等待外部契約 | 產品方定稿 SDK 或 HTTP endpoint、credential／egress 規則、request／response／error schema，以及 timeout／retry／circuit-breaker 契約前不新增依賴或網路呼叫 |
| Async path resolver | 刻意延後 | 只有在提高 metadata 上限、加入批次 ingest，或實測到 server／UI 阻塞時才重新量測並評估 |

## 已完成歷史

各輪（第五至第九輪、1.5.x 健康檢查、Mermaid 移除、五項功能整合、MCP 精準讀取、1.6.7 後端效能 P0／P1）的交付都已合併；逐項內容見對應 PR、[CHANGELOG](../CHANGELOG.md) 與[更新說明](releases/)。仍被引用的實測證據：

- 第八輪工作記錄來源核對：[agent-data-source-audit-2026-09-30.md](experiments/agent-data-source-audit-2026-09-30.md)
- 未結項清理建議的合成準確度（12 項正確建議、8 項證據不足保留，沒有更改真實未結項）：[outstanding-cleanup-accuracy-2026-10-01.md](experiments/outstanding-cleanup-accuracy-2026-10-01.md)
- 其餘合成探測與成本數據：見[測試文件的實驗資料表](testing.md#實驗資料)
