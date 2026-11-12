# 專案現況與未結項

本頁先列目前仍開放或暫緩的工作；已完成階段移到下方歷史段落。實作細節與逐項複檢結果另見 PR、CHANGELOG、正式驗證文件與工作記錄。

> 回到 [README](../README.zh-TW.md)（[English](../README.md)）

- 最後更新：2026-11-12

## 1.6.24（已完成）

這一輪第一次 schema 變更（32 → 33），只新增可為空的欄位與索引，升級路徑以實際 build 驗證：v1.6.8 build 寫入的 schema 31 資料庫與使用者 schema 32 資料庫的副本升級後，49 張資料表列數與內容雜湊全部相同、只建立一份 migration 前備份、再次開啟不再遷移；使用者的匯出檔匯入全新資料庫 0 衝突、各表筆數相同，再次匯入全部略過，升級後再匯出／匯入也 0 衝突。可攜式匯入改為接受 schema 31 起的匯出檔（之前只接受與程式相同 schema 的檔案，升級後會拒絕所有舊檔），較新的檔案仍拒絕並請使用者先更新；守門測試確保之後新增的欄位都有匯入預設值。Knowledge 候選的重疊提示與候選一起保存（只存 id、狀態與分數），Web 候選卡片會顯示並可開啟相似的 Knowledge，重送時回傳保存的提示。`work_list_sessions` 新增 `commitSha`（完整 sha 或至少 7 個十六進位字元的前綴）；記錄的是 finalize 時的 HEAD，可能是工作 commit 之前的那個。部分索引 `sessions(project_id) WHERE voided_at IS NULL` 讓 20,000 筆 Session 時 Dashboard 的 Session 計數由 6.1 降到 0.46 ms，沒有其他查詢計畫變差。仍未做：REST Session 列表的 commit 篩選、schema 31 之前匯出檔的匯入。詳見 [1.6.24 更新說明](releases/1.6.24.md)。

## 1.6.23（已完成）

第二次安全複檢的發現已處理。`appliesTo` glob 比對的成本有上限：比對前先做精確排除，一個 glob 最多 16 個星號（超過的已儲存或匯入樣式仍可讀出但不比對，新增時以驗證錯誤拒絕，更新時回傳 `warnings`），每次掃描另有固定步數預算，用完時以 `appliesToScanTruncated`、`knowledgeToReviewTruncated` 或 `stalenessUnchecked` 標示。30 筆 500 個星號的樣式對 20 個 1,000 字元路徑由約 3.6 秒降到不到 2 ms，一般樣式結果不變（實際資料 59,682 組比對一致）。相關未結項每次最多讀 2,000 筆，超過時帶 `truncated`，實際資料 300 個焦點結果與順序不變。核心 skill 補回 Agent 自主決策只在 Web 審核、不可用 finalize 繞過整理未結項審核兩條規則。`db:redact` 註解更正。Web 尚未顯示新標示。schema 維持 32。

## 1.6.22（已完成）

Agent 開始工作前要讀的內容變少：work-intelligence skill 拆成每次工作都要讀的核心（隱私與追蹤規則、開始工作、證據規則、finalize 流程）與六份按需讀取的流程指南（`reading-records`、`diagrams`、`repair-and-backfill`、`outstanding-cleanup`、`synthesis`、`knowledge`），以 MCP resource 與 skill 資料夾內的 `references/` 檔案提供，plugin、Claude Desktop 擴充與 standalone 套件都會帶上。重複的規則改放在 Agent 需要時會讀到的契約或指南，finalize 專用規則移到只附在 `work_finalize_session` 的收尾契約。固定閱讀量 63,209 → 39,642 字（−37%），核心 skill 35,554 → 12,893 字，記錄格式文件 11,789 → 7,749 字；少用流程最多 29,115 字（原 47,343）。拆分前抽出的 350 條規範性敘述全部仍讀得到（296 條逐字、54 條合併或改寫），並以測試鎖定預算、核心規則與指南 URI。四個 Session 更新工具的 MCP 回應改為回條，實際資料原本 3,534–5,940 字，合成資料現在 303–405 字；REST 與 storage 結果不變。user-level skill 安裝仍只複製 `SKILL.md`，指南經 MCP 讀取。schema 維持 32。

## 1.6.21（已完成）

讀取路徑不再重做工作或卡住，回應內容完全不變（實際資料 220 個結果、合成資料 5,000／20,000 筆 Session 上 37 個讀取路徑，修改前後雜湊相同；排序以舊實作為 oracle 的測試比對）。`work_get_context` 每次都要的 metadata follow-up 計數改依資料庫識別、`data_revision` 與 `schema_version` 快取在每個連線上，任何程序寫入、替換資料庫或 schema 變更都會重新計算，交易中不使用快取；同一次 context 的知識頁記錄只建一次。recall 與寬鬆 Knowledge 搜尋以 `COUNT(*)` 取得詞頻，只在需要時讀取 rowid；索引同步以集合式刪除與重用 statement 批次處理，線上匯入、`db:restore`、`db:redact --apply` 在結束前同步索引；Session 列表文字查詢只掃描一次；最新優先的列表、報告熱點、未結項提醒與 Dashboard 事件數改寫 join 順序。5,000 筆合成 Session：未聚焦 context 37.9 → 19.3 ms、5,000 筆待更新文件的第一次讀取 839 → 572 ms、無符合的列表查詢 47.1 → 22.7 ms；20,000 筆時 context 139.9 → 77.2 ms、週報 61.8 → 26.2 ms、Dashboard 49.6 → 30.6 ms。大量待更新文件的第一次讀取仍約 0.6 秒，未達 100 ms 目標；建議之後的 migration 版本評估部分索引 `sessions(project_id) WHERE voided_at IS NULL`。schema 維持 32。

## 1.6.20（已完成）

finalize 更快、更精簡：相關未結項提醒改為一次讀出 pending 候選、在記憶體評分，規則與同分排序不變（舊 SQL 的特性測試固定排序，實際資料 300 組焦點結果完全相同）；查詢由 5.9 ms 降到 0.9 ms，實際資料 finalize 中位數 16.3 → 6.0 ms，5,000 筆合成 Session 帶 20 個變更路徑的 finalize 35.4 → 15.8 ms，知識頁維護提示移到交易提交後（交易中位數 3.8 → 1.0 ms）。MCP finalize 回應改為回條，不再回顯標題、摘要、workSummary 與 changedFiles，只回傳 id、時間、數量與伺服器推得的事實；實際請求的回應由 5,249／5,453 字（文字／structuredContent）降到 1,500／1,638 字，REST 與 storage 結果不變。新增 `knowledgeToReview`：最多 3 筆 `appliesTo` 直接點名本次變更檔案、且由本次 Session 才第一次讓它可能過時的 active Knowledge，只是提示，不改資料；實際資料最近 50 筆 Session 有 5 筆會收到（較寬的初版規則為 32 筆）。另修正知識頁 context 預覽截斷可能切開輔助平面字元，並讓兩個 lease 目錄不可寫的測試不再依賴權限位元。其他回傳完整 Session 的寫入工具尚未改成回條。schema 維持 32。

## 1.6.19（已完成）

完成方向研究 C6：報告整理 context 的整期報告區塊只在第 1 頁回傳一次，之後的頁面只含該頁 Session、其 evidence 與指向第 1 頁的 `reportBlockOnSessionPage`；直接讀第 N 頁、重試或重啟後再讀第 1 頁即可取得同一個區塊，伺服器不保存分頁狀態。區塊內 projects 與 risks 的來源 id 最多列 8 筆並附數量，evidence 不再重複 Session 標題。實際資料 193 筆 Session 的月份同樣 9 次呼叫，由 180,943 字降到 156,378 字，第 1 頁保留原本被預算移除的 8 條決策與 7 項風險，各頁合計送出 317 筆 evidence（原為 0）；68 筆 Session 的月份 70,849 → 56,259 字，5 筆 Session 的一週 13,385 → 12,561 字。每頁 Session 數維持 24：改為 32 以上時第 1 頁會失去決策或風險。知識頁 context 的每筆 Session 改為 outcomes／decisions／nextSteps 各前 2 項（每項最多 100 字）的預覽，其餘以 `work_get_session` 讀取，並移除與 contract 重複的 `instructions`；三個常駐知識頁由 23,705／20,752／22,670 字降到 14,935／11,982／13,900 字。方向研究的改進候選 C1–C6 全部完成；成效仍以讀取稽核觀察（C1 看 `session_unchanged` 次數、C2 看 `work_get_project_status` 占比、C3 看知識頁 not_found 原因代碼、C4 看 `knowledge_relaxed`／`knowledge_none` 比例）。schema 維持 32。

## 1.6.18（已完成）

Agent 讀取更省：`work_get_session` 新增 `session.files`，每個變更路徑只列一次並附狀態、來源與 references，`view: "handoff"` 包含它；Agent 指引預設改用 handoff，只有需要原始 provenance、events 或 evidence 時才完整讀取（完整讀取的形狀不變）。實際資料（328 筆 Session）20 筆抽樣 Session 合計由 150,728 字降到 95,720 字（中位數 6,907 → 4,021）。帶 task 的 `work_get_context` 未結項指標只留 id、來源 Session id 與 240 字摘錄，同一 Session 的決策只在第一條附標題與日期；五個 task context 的相關 Session 由 1–2 筆增為 2–3 筆，一跳補充在兩個 context 出現，每個 context 都保留補充的省略指標。Knowledge 候選 context 另列已封存的 Knowledge 與已拒絕的候選標題（19,625 → 17,910 字，列出 69 而非 31 個標題）；送出候選時附參考用的重疊提示，實際資料只標出已知的一組近似重複、沒有誤報；同內容重送回傳原本的候選。安全性：`appliesTo` glob 改用不回溯的比對器，修正大量星號樣式對長路徑的災難性回溯。Web 候選審核畫面尚未顯示重疊提示。schema 維持 32。

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
| 歷史 Mermaid 圖表整理成 architecture 快照 | 不阻擋任何功能；歷史圖表以原始碼保留 | 使用者選定要整理的圖表後，逐張核對原工作來源再建立新快照 |
| TypeSafe Adapter（Insight Provider Phase 2） | 等待外部契約 | 產品方定稿 SDK 或 HTTP endpoint、credential／egress 規則、request／response／error schema，以及 timeout／retry／circuit-breaker 契約前不新增依賴或網路呼叫 |
| Async path resolver | 刻意延後 | 只有在提高 metadata 上限、加入批次 ingest，或實測到 server／UI 阻塞時才重新量測並評估 |

## 已完成歷史

各輪（第五至第九輪、1.5.x 健康檢查、Mermaid 移除、五項功能整合、MCP 精準讀取、1.6.7 後端效能 P0／P1、1.6.8 無 checkout 發行第一階段與 launcher、1.6.9 讀取稽核與 Session 輕量重讀）的交付都已合併；逐項內容見對應 PR、[CHANGELOG](../CHANGELOG.md) 與[更新說明](releases/)。仍被引用的實測證據：

- 第八輪工作記錄來源核對：[agent-data-source-audit-2026-09-30.md](experiments/agent-data-source-audit-2026-09-30.md)
- 未結項清理建議的合成準確度（12 項正確建議、8 項證據不足保留，沒有更改真實未結項）：[outstanding-cleanup-accuracy-2026-10-01.md](experiments/outstanding-cleanup-accuracy-2026-10-01.md)
- 其餘合成探測與成本數據：見[測試文件的實驗資料表](testing.md#實驗資料)
