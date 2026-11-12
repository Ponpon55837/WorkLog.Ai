# 專案現況與未結項

本頁先列目前仍開放或暫緩的工作；已完成階段移到下方歷史段落。實作細節與逐項複檢結果另見 PR、CHANGELOG、正式驗證文件與工作記錄。

> 回到 [README](../README.zh-TW.md)（[English](../README.md)）

- 最後更新：2026-11-12

## 1.6.17（已完成）

新增 `work_get_file_history`：Agent 修改檔案前，一次呼叫取得該檔案的完整歷史統計（Session 數、首末日期、各驗證狀態數量、有 decisions 的 Session 數、仍 pending 的未結項）、最新幾筆 Session 摘要、較早的驗證失敗／未執行 Session，以及 `appliesTo` 涵蓋該路徑的 active Knowledge；只採用已記錄的 changed files，單一路徑回應上限 4,000 字。實際資料（328 筆 Session）五個最常修改的檔案，統計與直接計數完全一致，回應 1,685–2,640 字、約 2 ms，取代原本約 7 次呼叫、27,000–60,000 字仍只涵蓋 5 筆 Session 的做法。`work_get_context` 對前 3 個指定路徑一律顯示熱點提示並附整段歷史數量。schema 維持 32。

## 1.6.16（已完成）

完成方向研究 C4：`work_search_knowledge` 嚴格比對沒有結果時，改用 recall 的斷詞與排序在同一範圍與狀態內做寬鬆比對，回傳最多 3 筆標示共有詞元的 `relaxedMatches`，並以 `otherStatusMatches` 計數告知被狀態篩選隱藏的符合記錄；嚴格搜尋也比對 `appliesTo` 路徑。實際資料（64 筆 Knowledge、41 個查詢）：空回答由 30 降到 0，7 個 active 目標漏查全部以第 1 名找回，21 個 archived 目標查詢全部附上數量。讀取稽核記錄 strict／relaxed／none，recall 的 `termHits` 不再列虛字與未斷詞的中文片段。schema 維持 32。

## 1.6.15（已完成）

Agent 讀取更精簡：`work_get_context` 的 `omitted` 改為每區只有數量、讀取工具、最多 3 個 id 與核對旗標，不再重複知識頁核對明細；實際資料（328 筆 Session）帶 task 時 omitted 由約 5,800–6,800 字降到 1,700–2,100 字，省下的預算改留相關內容，五個 task context 全部回到 10,000 字上限內。沒有焦點時保留最新 3 筆 Session。以 `projectRoot` 限定的呼叫只在頂層列一次專案（context、recall、Session 清單、未結項、知識搜尋）。完成方向研究 C3：知識頁 `not_found` 回傳原因代碼、現有 slug、id 誤用與最接近的 slug，原因代碼記入讀取稽核。schema 維持 32。

## 1.6.14（已完成）

修正 `pnpm bootstrap` 結尾提示：不再每次都要求重新連線 MCP。第一次連接 Agent 時開新對話或重啟 Agent；之後更新由 launcher 自動切換新版，只有 Agent 回報 `restartRequired` 時才重連一次。無程式行為變更，schema 維持 32。

## 1.6.13（已完成）

兩台電腦（例如 Mac 與 Windows）都記錄同一專案並互相匯入時不再大量衝突：相同專案 ID 自動沿用本機根路徑；新增 `newer-wins` 策略（Web 預設）依時間欄位取較新者、保留本機較新的列；各機自行衍生的欄位不算差異；知識頁版本撞號依時間重新編號並存；衝突依原因彙總；單一專案匯出帶入引用該專案的跨專案報告。schema 維持 32。

## 1.6.12（已完成）

文件版：README 的 16 張 Web UI 截圖重新壓縮為最多 256 色的 PNG，合計由 4.19 MB 降到 1.34 MB（約 -68%），文字仍清楚，無程式行為變更。

## 1.6.11（已完成）

文件版：英文與繁體中文 README 加入 8 張 Web UI 截圖（專案名稱與記錄文字已模糊），無程式行為變更。

## 1.6.10（已完成）

修正 1.6.9 期間發現的三個既有小問題（#320）。

| 項目 | 結果 |
| --- | --- |
| 圖表作廢／還原 | 改在同一交易內重讀再寫入；重複作廢保留原時間與原因，狀態改變才更新所屬 Session 的 `updatedAt` |
| finalize 帶 parent／related 建立關聯 | 被關聯的 Session 也更新 `updatedAt`，與 `work_link_sessions` 一致 |
| build 失敗留下 `.work-intelligence-build-in-progress` | 編譯或 finalize 失敗時只移除自己建立的標記；行程被終止時仍保留 |

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
| 方向研究的改進候選 | C1、C2、C5 已於 1.6.9 完成，C3 已於 1.6.15 完成，C4 已於 1.6.16 完成；剩 [C6](experiments/direction-research-2026-11-07.md)：report synthesis 拆段 | 累積 C5 的耗時與錯誤代碼資料後，依最慢工具與失敗類型排序；C1 採用率看稽核 `session_unchanged` 次數，C2 成效看 `work_get_project_status` 占比，C3 看稽核中 `work_get_knowledge_page_context` 的 not_found 原因代碼分布，C4 看稽核中 `work_search_knowledge` 的 `knowledge_relaxed`／`knowledge_none` 比例 |
| 歷史 Mermaid 圖表整理成 architecture 快照 | 不阻擋任何功能；歷史圖表以原始碼保留 | 使用者選定要整理的圖表後，逐張核對原工作來源再建立新快照 |
| TypeSafe Adapter（Insight Provider Phase 2） | 等待外部契約 | 產品方定稿 SDK 或 HTTP endpoint、credential／egress 規則、request／response／error schema，以及 timeout／retry／circuit-breaker 契約前不新增依賴或網路呼叫 |
| Async path resolver | 刻意延後 | 只有在提高 metadata 上限、加入批次 ingest，或實測到 server／UI 阻塞時才重新量測並評估 |

## 已完成歷史

各輪（第五至第九輪、1.5.x 健康檢查、Mermaid 移除、五項功能整合、MCP 精準讀取、1.6.7 後端效能 P0／P1、1.6.8 無 checkout 發行第一階段與 launcher、1.6.9 讀取稽核與 Session 輕量重讀）的交付都已合併；逐項內容見對應 PR、[CHANGELOG](../CHANGELOG.md) 與[更新說明](releases/)。仍被引用的實測證據：

- 第八輪工作記錄來源核對：[agent-data-source-audit-2026-09-30.md](experiments/agent-data-source-audit-2026-09-30.md)
- 未結項清理建議的合成準確度（12 項正確建議、8 項證據不足保留，沒有更改真實未結項）：[outstanding-cleanup-accuracy-2026-10-01.md](experiments/outstanding-cleanup-accuracy-2026-10-01.md)
- 其餘合成探測與成本數據：見[測試文件的實驗資料表](testing.md#實驗資料)
