# 五項功能整合先行研究

日期：2026-10-09（Asia/Taipei）。狀態：**研究完成；A1 提醒聚合已實作及本機驗證，其餘階段尚未完成**。下列研究規格保留設計依據；實際已實作範圍、API 與限制以末節、REST 文件及程式碼為準，擬議資料表不可當成已存在。

## 1. 建議結論與範圍

五項都值得保留，但應放進既有流程，避免使用者多學一套系統。

| 項目               | 整合位置                                  | 首次交付的最小範圍                                                 | 刪減／延後                                           |
| ------------------ | ----------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------- |
| 整合既有提醒       | 總覽既有「待處理」Box，完整清單沿用領域頁 | 依專案聚合提醒、證據與直接操作；保留各領域狀態                     | 不新增側欄提醒中心、不做桌面通知／定時掃描／全部結案 |
| 提示可能相關的工作 | Session 詳情下方「可能相關」              | 同專案、共同修改檔案、最多五筆、理由與來源                         | 不自動連結、不猜 continues、不做全圖推薦／embeddings |
| 報告段落操作       | 報告的 Agent 整理卡片                     | 以既有七種段落群組釘選／隱藏／恢復；群組內逐塊編輯，保留原文與引用 | 不編輯統計、不做富文字／拖曳排序／跨版本自動套用     |
| 首頁洞察           | 總覽 KPI 下方一列，最多兩句               | 完整本週統計的規則文字，點擊進報告或對應清單                       | 不用 LLM、不新增評分／排行榜、不把工期當工時         |
| 複製報告           | 報告頁操作區／整理卡片                    | 基本報告與目前整理版本兩個明確選項，Markdown 預覽及複製失敗退路    | 不自動匯出目錄、不新增 rich HTML clipboard／背景複製 |

採兩條產品流程：**看到待處理 → 看證據 → 在原領域處理**；**讀工作／報告 → 整理呈現 → 預覽並複製**。相關提示屬探索，不進待處理數量，也不製造必須消除的紅點。

先保留使用者指定的研究順序：提醒 → 相關工作，以及段落操作 → 首頁洞察 → 複製。工程拆分另見第 10 節，段落與複製共用同一投影，避免輸出與畫面不一致。

## 2. 已核對基線與來源

本專案基線：Work Intelligence 1.4.0，schema 27，commit `21376c1891eb88ddd18b9fa607f84e55e19c8aea`。使用者兩個參考對話均已讀取；開工先讀「架構與慣例」「常見陷阱」知識頁、八筆知識點與相關工作記錄，之後核對程式碼。

| 現有能力              | 實際位置                                                                                                           | 整合含意                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| 總覽已有待處理聚合    | `apps/web/src/stores/dashboard.ts`、`views/DashboardView.vue`                                                      | 目前只有 synthesis/backfill 請求；不能把提醒中心當成從零建立                                    |
| 領域提醒與原子審核    | `knowledge-service.ts`、`knowledge-page-service.ts`、`outstanding-cleanup-service.ts`、`session-record-service.ts` | 提醒是呈現投影；來源版本、活躍整理快照與人工審核由原服務決定                                    |
| 共同檔案／人工關聯    | `packages/storage/src/graph-builder.ts`、`session-record-service.ts`、`search-repository.ts`                       | `co_changed` 是「檔案－檔案」推導；Session－Session 候選是新的讀取投影，不直接改現有圖譜邊      |
| 完整期間 SQL 統計     | `packages/storage/src/report-service.ts`                                                                           | totals、comparison、專案分布完整；trends／成果／風險／決策／證據依最多 200 筆來源，兩者不可混用 |
| Agent 報告版本與引用  | `report-synthesis-service.ts`、`apps/web/src/components/domain/SynthesisCard.vue`、`SynthesisBlock.vue`            | 已有七類群組、版本歷史與逐塊 `sourceSessionIds`；沒有使用者編輯層                               |
| Markdown 匯出與剪貼簿 | `report-builder.ts`、`stores/reports.ts`、`composables/useClipboard.ts`、`ui/UiCopyButton.vue`                     | 現有匯出是 deterministic report，不含獨立的 Agent synthesis；不能把匯出全文誤叫目前整理版       |

外部只借鑑概念，不執行上游 skill、安裝對方產品或引入其依賴。公開來源以 gh clone 核對固定提交：

- [veynrel Findings](https://github.com/zinverno/veynrel/blob/3890f74d7d4d057c92ec5bd9d7922db63e2fe3be/docs/health-findings-inbox.md)：證據、稍後提醒／忽略的意圖，與問題是否仍存在分開。其到期處理依後續分析；本提案改用查詢時計算到期，不新增排程。
- [veynrel Connection Opportunities](https://github.com/zinverno/veynrel/blob/3890f74d7d4d057c92ec5bd9d7922db63e2fe3be/docs/connection-opportunities.md)：候選是查閱提示；比較稀疏語意邊與顯式連結，保留覆蓋範圍。本提案只用共同檔案，不套用 cosine 或語意準確度宣稱。
- [Work-Review 段落投影](https://github.com/wm94i/Work-Review/blob/739058e4003f2d211c4e7c48bf70d634cf268232/src/routes/report/reportSections.ts)：釘選與隱藏保留原內容。其 Markdown marker／index 不直接套用到本專案結構化 ReportSummary。
- [Work-Review 報告入口](https://github.com/wm94i/Work-Review/blob/739058e4003f2d211c4e7c48bf70d634cf268232/src/routes/report/Report.svelte)：複製與段落操作的入口參考。
- [Work-Review 首頁洞察](https://github.com/wm94i/Work-Review/blob/739058e4003f2d211c4e7c48bf70d634cf268232/src/routes/Overview.svelte)：規則組句的呈現概念；我們不採應用活動時數語意。
- [Clipboard writeText 文件](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/writeText)：需安全來源且可能遭拒；複製成功只能在 Promise 成功後顯示。

## 3. UIUX：位置與操作負擔

以下為文字線框，使用合成數字，尚非瀏覽器原型。沿用 Primer token、Box／Label／ActionMenu、lucide、Pinia Colada 與目前側欄。正式介面需繁中／英文、明暗主題；不新增 hero 或介紹區塊占用第一屏。

```text
總覽
──────────────────────────────────────────────────────────
OVERVIEW 總覽                         [本週報告] [工作歷程]
[記錄中專案] [本週完成 Sessions] [Verification] [待處理]
本週有 12 筆工作記錄；2 筆驗證進行中。             [查看報告]
┌ 待處理 5                 [全部專案 ▾] [檢視全部] ┐
│ 需要核對　知識頁「架構與慣例」來源已更正         │
│ Alpha · 引用工作已修改                 [查看來源] │
│ 待審閱　2 項未結項整理建議             [前往審閱] │
│ 有新資料　知識頁累積 3 筆工作           [檢查知識頁]│
└ 顯示 3 / 5；1 類提醒暫時無法載入 [重試] ─────────┘
活動日曆／最近完成的工作                    專案狀態

Session 側面板
摘要／驗證／檔案／既有關聯
┌ 可能相關 · 共同檔案的提示，不代表依賴 ─────────────┐
│ 修正 API 驗證　2026-10-07                          │
│ 共同修改 2 個檔案 · src/validator.ts… [查看工作]    │
└ 此工作沒有可用的 changed files 時顯示原因 ─────────┘

報告整理卡片
「本週整理」版本 3 · 原始 Agent 整理      [整理段落 ▾]
成果                                      [段落操作 ▾]
修正資料匯入 · 引用 2 筆 Sessions                 [編輯]
驗證                                      [段落操作 ▾]
隱藏 1 個段落 [管理隱藏段落]       [複製目前整理版 ▾]
```

提醒列只顯示一個主要動作；稍後提醒與重新顯示放在 ActionMenu。點提醒先開來源 SidePanel，提交編輯用 Dialog，沿用焦點鎖定／Esc／還原焦點。沒有來源的提醒不提供失效按鈕。全清單先做總覽 Box 的「檢視全部」展開、框內捲動與分頁，不新增主側欄頁；依類型檢視再導到既有頁面。

桌機 1440px：保留四張 KPI，洞察最多兩行；待處理優先於活動日曆。960px：依現有版面收成單欄，不額外窄欄。375px：兩欄 KPI、列內操作換行、SidePanel 滿版；英文 1.5 倍長度仍須可讀。不得用 title tooltip 當成唯一取得證據的方法。

所有主要控制可 Tab／Enter 操作，icon-only 有 aria-label，狀態有文字與 icon；成功與錯誤以 live region 宣告。列表保持框內捲動，分頁與篩選在框外；空清單縮短高度。URL 保留 project、kind、page、選取來源；查詢型操作不清掉尚未送出的草稿。背景刷新保持已載入資料與使用者閱讀位置。

## 4. 整合既有提醒：呈現狀態不等於問題狀態

首次納入：報告整理 pending／processing／failed、metadata 請求／缺口、未結項整理 awaiting_review、待確認 Agent 決策、Knowledge needsReview／possiblyStale、知識頁 needsReview／明確要求更新／累積至少三筆新 Session。一般 pending 未結項只顯示按專案的入口與數量，不複製每筆 nextSteps 成提醒，降低重複噪音。

每項包含 `kind`、`scopeType`、`projectId`（全域請求另列所有可見來源專案）、來源識別、可讀理由、來源版本、更新時間、原領域入口、`coverage`。sourceRevision 由影響問題的已知欄位做穩定指紋，不使用讀取時間或翻譯文字；七天截止時間由 server clock 計算。ID 用規範化 tuple 序列化，不以標題、翻譯、日期、分頁位置識別。後端產生白名單 action 類型，前端映射到固定 route；來源文字不提供任意 URL／腳本／命令。

同一來源同時過時與被推翻時只列高優先理由，保留附屬證據；不同來源不可只因同標題合併。排序：來源核對／請求失敗 → 人工待審 → 可能過時 → 明確更新 → 有新資料；同級依 updatedAt 倒序、穩定 id。等候 Agent 的 processing 用中性，不當成使用者必須完成的工作。

| 使用者動作／來源事件     | 提醒呈現                                                | 原來源狀態                   |
| ------------------------ | ------------------------------------------------------- | ---------------------------- |
| 查看                     | 維持顯示                                                | 不改變；不寫「已完成」       |
| 稍後七天                 | 保存 snoozedUntil；到期讀取時計算重新顯示               | 不改變；仍計入來源未處理總數 |
| 此次不顯示               | 對目前 sourceRevision 保存 dismissal                    | 不改變；另可檢視／恢復       |
| 來源有新版本             | 舊 dismissal／snooze 不遮住新問題版本；來源明細重新核對 | 依原領域服務判定             |
| 原領域確認／結案／取消   | 重新讀取後不再列於有效提醒                              | 只有原領域交易能改變         |
| 某類讀取失敗／資料被截短 | 顯示部分載入與 retry／coverage                          | 不推定沒有提醒或已完成       |

稍後／不顯示可撤銷，不需多一個確認 Dialog。原領域已要求確認的取消／刪除流程保持原確認。UI 不新增通用 resolve，也不繞過既有未結項 snapshot 審核。沒有服務可用的項目顯示原因；首次不做一鍵確認 Knowledge，仍到既有審閱流程。

資料選擇：先以來源服務的有界 summary 組成唯讀聚合，避免在 client 拉所有全文或 per-row 查詢。各類清單與 count 必須分開，不能用 limit 50 的長度當總數。現有 dashboard 把失敗吞成 null／[]，整合時改為各領域 `{ status, count?, items, coverage }`，載入失敗不顯示「全部處理完畢」。所有來源成功且無待處理才顯示「目前沒有待處理提醒」，不聲稱整個專案健康。

需要跨瀏覽器保存稍後／不顯示時，擬新增 `attention_preferences`（project、kind、source_id、source_revision、dismissed_at、snoozed_until、revision）；只保存意圖，不複製來源正文。先完成聚合再加偏好是一個可獨立驗收的拆分。首版偏好只對單一專案來源開放；global 報告請求先保留既有操作與呈現，待其跨專案匯出／刪除歸屬定稿再提供 snooze。永久歷史與自動掃描引擎暫不需要。

## 5. 可能相關的工作：局部檢索與可解釋理由

只在開啟一筆有效 tracked Session 時查詢，同專案、排除自己／作廢／已有任一方向顯式關聯。不跨專案暗示；沒有確認的 changed files 或超過 20 檔的來源不推薦，空態說「這筆工作沒有適合比對的檔案記錄」，不說「沒有相關工作」。不查檔案內容、不掃 repository、不依標題猜依賴。

現有 `search_paths` 能提供路徑候選，但只有 doc／basename 索引，沒有 `(project_id, path, doc_type)` 複合索引；正式實作先 EXPLAIN 再決定加索引，新增索引也走 append-only migration。讀前同步必要 search dirty 索引，不能拿未同步的索引宣稱候選完整。

建議排序為 **共同檔案數降序 → Jaccard 比例降序 → completedAt 降序 → id**。共同數表示已記錄的交集，Jaccard 只是排序提示，不標成「相關機率」。理由展示至多三條共同路徑與總數；同路徑先 Set 去重，路徑大小寫及 canonicalization 重用現有搜尋契約，不自行 NFKC 合併不同檔案。可在後續有實證時給常見 lockfile／README 較低權重，首版不先硬編碼漏掉它們。

```text
1. 聚焦 Session 的最多 20 路徑 → 一次查詢 postings。
2. candidateId → Set<sharedPath>（每條共同路徑只計一次）。
3. 一次批次讀候選 metadata／已建立的雙向 links；policy 在 SQL 內篩掉不可見來源。
   對候選重算完整的至多 20 路徑交集，避免熱門路徑截短導致理由少算。
4. Map 一次計分；K=5 用定長有序陣列（最多 5 次比較）或 min-heap。
5. 回傳五筆、查詢範圍／截短狀態／理由，無全圖 Session 配對。
```

對已持有 inverted index 的查詢，令 H 為讀到的 postings、C 為候選數、m 為聚焦路徑數（最多 20）：O(H + C × (m + K))／O(C)，K=5 是常數；通用可變 K 可用 heap 做 O(H + C × m + C log K)。建索引 O(F)（若需另外排序 postings 還有排序成本）並須另算，單次已在記憶體持有完整來源時 O(F) 掃描也合理，不能只量 query 掩蓋 build 成本。避免全配對 O(N² × 路徑成本)；本次合成探測只比較單筆查詢，沒有假稱測了全圖演算法。

初始有界策略：每條聚焦路徑最多 1,000 個候選，最多 20,000 postings、去重候選最多 20,000；每條路徑按 completedAt／id 穩定選取。非常熱門路徑會截短並顯示「只比對部分近期工作」；此時是該候選池的前五名，不能稱全歷史最相關，也不能聲稱沒有結果。正式回應建議最多 20KB，資料不必要時不返完整 workSummary。5000／50000 筆、20 條熱門路徑與稀疏路徑都要量測 SQL／序列化／端到端成本。

首次只提供查看來源。若另階段加「建立相關連結」，用既有 link 服務加 Web 入口與重新核對：對話框兩筆摘要＋共同路徑、固定 `related`、expected source revision、同交易驗證兩端仍 tracked／未作廢／未被連結，再保存稽核。不能由推導關係自動選 continues，不能覆蓋原人工關聯。

## 6. 報告段落：原始整理、呈現與人工改稿分層

統計報告維持 deterministic，不允許改數字；可編輯的是 Agent ReportSummary 的文字塊。首版群組級釘選／隱藏（themes、highlights、verification、comparison、risks、decisions、nextSteps），群組內逐塊 title／detail 編輯；不要誤把 Session 的五段 workSummary 編輯器當成報告編輯器。

原始 ReportSummary 版本保持不可變；為**指定 summaryId** 建獨立的 presentation revision：section key、釘選順序、hidden、文字 override、modifiedAt／actor。現有 block 無 id，基底版本不可變時使用 `(summaryId, sectionKey, originalOrdinal)` 指定 block，絕不使用使用者可修改的 title 當 key。人工操作的新 revision 保持同一 block key；不對 source array 原地插入／刪除。

投影步驟：取指定原版本 → 合法文字 override → 釘選群組按順序＋其餘原順序 → 隱藏群組。來源引用由基底版本提供、不可在編輯表單移除或換成其他 Session；人工改稿標示「已由使用者編輯，來源為原整理引用」，不假稱原來源已驗證使用者新增說法。可以看原文／差異／恢復單塊原文；恢復也產生可追溯 revision。

釘選不改原文；隱藏不是刪除。隱藏群組數與「管理隱藏段落」始終可見，包括全隱藏時。verification／風險／狀態被隱藏，在預覽頁顯示遺漏哪些群組與局部資料限制；警告不因隱藏而消失，不強行把隱藏內容加回剪貼簿。管理面板可恢復單段／全部。

編輯 Dialog 保留原文、輸入框與唯讀來源按鈕，儲存前可取消；未儲存關閉提示由既有 confirm store 處理。保存 `{ expectedRevision }`，兩個視窗同時編輯回 409 並保留草稿，提供重新載入／比對；不靜默覆蓋。SSE 刷新不覆蓋草稿。寫入重新驗證 scope、基底仍存在、block identity、來源有效性；版本刪除或來源作廢時保守拒絕並提示重讀，不只信任 client 表單。

新 Agent 整理產生新 summaryId 時，預設新版本不套用舊 override／hidden；舊版仍可查看。這避免「版本 2 隱藏的風險」意外遮住版本 3 新風險。首次不做跨版 diff 猜測或一鍵合併改稿。選到歷史版本時 UI 明示版本與範圍。

擬用兩表 `report_presentations`（immutable summary FK、revision、created_at、actor）與 `report_presentation_blocks`（presentation FK、section key、original ordinal、text override／hidden／pin）；群組偏好與逐塊文字可分欄／表，正式 schema 設計時依匯出契約定稿。交易保留 revision 歷史，無需重做 report-synthesis pipeline；所有新表與欄位走完整 project-data coverage。報告整理可能跨專案，匯出／刪除須重用既有 global report rules，任一引用專案不可見就拒絕輸出相關整稿，不能漏出另一專案內容。

## 7. 首頁洞察：清楚、可點擊的規則文字

重用 `weekReport.totals`、完整 comparison、projectSummaries；不為一句話新增 LLM 或逐筆請求。規則優先順序：有 failed → 有 in_progress → 有 not_supplied／not_run → 一般期間摘要。最多兩句與一個對應入口，不把所有缺口塞進文字。

| 已知資料（合成例）    | 建議文案                                  | 點擊                                                                |
| --------------------- | ----------------------------------------- | ------------------------------------------------------------------- |
| 本週 12 筆，2 failed  | 本週有 12 筆工作記錄，其中 2 筆驗證失敗。 | 本週報告 Verification 區塊；不能加不存在的 verification 清單 filter |
| 12 筆，2 in_progress  | 本週有 12 筆工作記錄；2 筆驗證進行中。    | 本週報告                                                            |
| 12 筆，3 not_supplied | 本週 3 筆工作記錄尚未回報驗證。           | 原有 metadata 缺口入口；不直接建立回補請求                          |
| 無異常，Alpha 8／12   | 本週完成的 12 筆記錄中，8 筆來自 Alpha。  | 同週 Alpha 報告                                                     |
| 上期為 0              | 本週有 12 筆工作記錄；上期沒有完成記錄。  | 報告比較；不算無限成長率                                            |
| totals 已成功，真實 0 | 本週尚無完成的工作記錄。                  | 工作歷程；不評價生產力                                              |
| API 失敗／尚未載入    | 載入洞察中／無法載入洞察 [重試]           | 不顯示假零或「全部正常」                                            |

首頁不能說「主要推進成果」來自 Session 數量，也不能從來源清單被截短推論所有工作內容。數值只用完整 SQL；模板採 i18n 而不翻譯工作正文。週與日期以 report.range／server timezone 為準；目前 dashboard date 由瀏覽器 new Date 取得，正式整合時補回 server clock／range 語意，須測試瀏覽器與 server 跨日／跨週不同時區，避免前端自行假設當週。

O(P) 取最多專案組成，選最高不必全排序；五種 verification 用固定規則 O(1)。標籤只解釋記錄資料，不做「本週效率提升 X%」。

## 8. 複製：用同一份投影與清楚的輸出範圍

基本報告：沿用現有 `exportReport(format: markdown)`，複製其 deterministic content。整理版：使用第 6 節的指定原版本＋presentation revision serializer，取使用者目前看到的文字。兩者按鈕分別標「複製基本報告」「複製目前整理版」，避免同名「全文」實際內容不同。沒有整理版仍可複製基本報告。

預覽 Dialog 顯示期間、專案、時區、版本、人工改稿標籤、哪些段落隱藏與資料截短；最後另有「複製」按鈕。在明確點擊事件內執行 writeText，先準備文字再讓使用者按最終按鈕，避免長 fetch 使 Safari 的 user activation 失效。成功 toast 只在 await 成功後顯示；失敗保留 readonly textarea、選取／全選提示與既有 Markdown 下載入口。既有 UiCopyButton 的 copied 不可在 copyWithToast 失敗時誤亮勾號，整合時驗證回傳成功值再設定，並在卸載清理短 timer。

整理 Markdown 順序依同一投影；含每塊來源 Session 的可讀引用與版本標記，敏感值套用現有遮罩政策。預設不放 raw handoff、任意本機路徑、私密 evidence、token 或 rich HTML；檔案引用只用受控的專案相對路徑。引用 ID 可在本地追溯，對外複製預覽要清楚讓使用者看見。隱藏群組不輸出，但輸出保留「呈現省略群組」註記和資料範圍警語；JSON 原始匯出不受呈現偏好影響。

來源文字全部純文字顯示，Markdown serializer 逃脫 inline 特殊字元／HTML／連結目的地；不可把文字透過 innerHTML 渲染，也不依 Markdown 內容抓遠端圖片。未來若要 renderer，另外經 allowlist 與 CSP 驗證。

剪貼簿只是使用者觸發的操作；不读取 clipboard、不背景複製、不為此放寬 CSP 或來源安全限制。Serializer 以 array join O(L)，不重複字串累加或逐塊呼叫 API；輸出大小依現有報告上限量測，極大報告可保留下載退路。

## 9. 資料與安全邊界

以下 endpoint 是**擬議**，不得先寫到已上線 REST／MCP 清單：

| 擬議能力                                            | 分層                                                        | 邊界                                                  |
| --------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------- |
| `GET /api/attention`                                | core DTO → schema → attention service → route → Pinia store | 有界分頁、每類 coverage／總數、policy、error masking  |
| `PATCH /api/attention/preferences`                  | 偏好服務，source revision + expected preference revision    | 只改提醒呈現；不能 resolve 領域來源                   |
| `GET /api/sessions/:id/related-suggestions`         | Session candidate read service                              | 聚焦單筆、同專案、雙向 link 排除、回應上限            |
| `GET/PATCH /api/reports/summaries/:id/presentation` | presentation service                                        | immutable base、來源核對、CAS、同交易 revision／audit |
| 整理版 Markdown preview                             | 同一 serializer；先驗證 scope，再輸出                       | 不新增 Agent write operation；基本報告使用已有 export |

UI-only 階段先使用現有可讀資料；只有聚合完整性／持久偏好／寫入需要才做明確 backend 階段。本研究不以 UI skill 的限制推定禁止未來新增必要 API，也不讓 UI 自行繞過缺少的後端契約。

需要新增專案資料時，逐項涵蓋 `PROJECT_DATA_TABLES`、匯出欄位與舊 bundle default、匯入順序與 ID 重映射、永久刪除／引用跨專案規則、db:redact、schema 保護；應可搜尋的人工文字納入既有搜尋索引 dirty 更新，不應搜尋的 snooze bookkeeping 明示理由並加 coverage。匯入提醒偏好時來源 ID／revision 重映射，無法確定時丟棄偏好重新顯示；不可沿用舊 ID 遮住新的問題。

安全檢查聚焦實際風險：

- 所有讀／寫重查 tracked policy，paused／ignored／unregistered 來源不可出現在摘要、count、suggestion 或 clipboard；快取不可越過 scope，跨專案 global synthesis 必須驗證全部來源。
- JSON only、Host／Origin 與既有 CORS 邊界保持；外部輸入 strict Zod、已知類型與長度／數量上限、bound parameters，拒絕任意欄位／foreign key／source ID。
- 來源內容是 untrusted text；固定操作 allowlist、路徑正規化與白名單連結，沒有 eval／命令執行／檔案內容讀取。
- preference、presentation 與 link 如需寫入，在 immediate transaction 內重核 policy／來源版本、CAS、audit；錯誤固定 code，不能輸出 SQLite stack 或來源正文。
- SSE 只通知 changed，不帶內容；Pinia key 含 scope／baseId／presentation revision／filters，離頁取消查詢，不允許晚回應更新已切換的 Session。

## 10. 分階段落地與驗收

每階段獨立 worktree 分支／PR、最新 head 三平台 Quality＋E2E 全成功後 merge commit、保存具證據的開始時間與工作記錄。資料／backend 與 UI 可分小 PR，但不以假資料功能當成正式完成；完整可用的切片才對使用者宣稱交付。

| 階段        | 交付邊界                                               | 必須完成的驗收                                                                                       |
| ----------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| A1 提醒聚合 | 既有總覽、來源理由、領域入口、部分失敗可見；先不做偏好 | 混合來源去重／穩定排序、真總數／截短、paused 不見、來源更改後刷新；empty 不假健康                    |
| A2 提醒意圖 | 稍後／此次不顯示／恢復、revision 與資料生命週期        | 七天到期、版本新問題重現、匯入 ID 重映射、原來源狀態不變、寫入失敗保持前態                           |
| B1 相關候選 | Session 詳情唯讀五筆、共同檔案理由、覆蓋範圍           | 雙向／自己／作廢排除、同名跨專案、重複路徑、20／21 檔、熱路徑截短、並行換 Session                    |
| C1 報告投影 | 群組釘選／隱藏／恢復、基底版本獨立、文字改稿／audit    | 全隱藏可恢復、引用保留、新版本不誤套、409 草稿保留、source void／版本刪除拒絕、匯出／刪除 round trip |
| C2 首頁洞察 | 完整統計的兩句模板與正確入口                           | >200 來源仍用 totals、五種驗證狀態、上期 0、project tie、時區跨週、API 失敗／loading                 |
| C3 複製     | 基本／整理版分開、同投影預覽、clipboard 成功／失敗退路 | 隱藏／釘選／改稿一致，特別字元／惡意 HTML 純文字、巨量輸出、兩版本、Safari 點擊 activation           |

正式 UI 各切片在 1440／960／375px × 明暗 × 繁中／英文檢查，Chromium／Firefox／Playwright WebKit、axe、鍵盤、焦點、loading／empty／partial error、長列表／英文換行。Playwright WebKit 不等同 macOS Safari，剪貼簿與實體觸控另記實機驗證缺口。

每個新讀路徑新增 synthetic performance case，先 profile／EXPLAIN，再訂 p90 gate（初始建議聚合／候選 250ms，實際以含 SQL 與序列化的測量決定；不是本次已通過門檻）。新增索引列出寫入／dirty sync 成本；新增搜尋文字保持 retrieval-quality／response-size 門檻。性能追求可證明的成本與品質，不用 LeetCode 名稱代替資料庫實測。

## 11. 本輪研究驗證與可重現產物

`docs/experiments/related-work-candidates.mjs` 只使用合成 Session；不連資料庫、不讀專案檔案、不發網路請求。以獨立的全掃描 oracle 對照 inverted index 局部檢索，包含：同專案、已有雙向關聯、重複路徑、作廢／停用、>20 檔、平手排序與熱門路徑截短。它是演算法探測，沒有接入 production 或替代端到端效能測試。

```sh
node docs/experiments/related-work-candidates.mjs
node docs/experiments/related-work-candidates.mjs --output /tmp/related-work-candidates.json
```

66 次 oracle 比對與 10 項邊界斷言通過；5000 筆的稀疏索引 query p90 0.038ms、全掃描 1.261ms、建索引 12.453ms；全熱門路徑 query 2.173ms，與全掃描 2.228ms 接近。這是本機 Node v25.7.0／macOS x64 的 15 次樣本，不是產品 SLO。限制 1000 postings 後回報 4000 筆 posting 省略；不冒充全域品質驗證。

結果保存在 [合成探測 JSON](experiments/related-work-candidates-2026-10-09.json)。檢查逐案例輸出一致；基準獨立報告建索引、單筆掃描、已建索引的查詢，不能把記憶體查詢毫秒稱為正式 SQLite/API 效能。五項正式 UI、持久化、REST 與實機體驗尚未實作或量測；本輪交付的是可據此開發與審閱的研究規格。

工作階段紀錄：來源／現況核對 `38dbe25a-5ba1-4e18-b850-859a53582a7e`，開始 `2026-10-09T19:40:24.645+08:00`（本聊天第一則 user message）；整合規格／驗證階段開始 `2026-10-09T19:44:27+08:00`（上一階段保存後的時間工具回傳），已保存 `f3fbe76d-8e8d-4945-bd56-58eaaa861021`；提交／CI／合併階段開始 `2026-10-09T20:12:29+08:00`，完成後另存交付記錄。這些是已觀察時間，不用 commit 時間推估工作起點。

本輪本機回歸：build、test（811 通過／1 既有略過，含 lint／格式）、typecheck、coverage、performance（36）、retrieval-quality（25）、response-size（9）與 prod audit low 均通過。三瀏覽器完整重跑 Chromium 64 通過／1 既有略過、Firefox 9、Playwright WebKit 6 通過。首次 Chromium 的既有未結項清單測試在 960px wheel 後 scrollTop=0；保留失敗 trace，定向全新 server／SQLite 重測 3/3 和完整重跑通過，未修改 UI 或測試，首次失敗根因尚未確認。這些是既有產品回歸，不是五項擬議功能的驗收。

知識維護：架構與慣例 v12、常見陷阱 v11；新增「完整期間 totals 不可由最多 200 筆來源推算」與「co_changed 不等於人工 Session 關聯」兩筆已核對知識點。研究中的擬議 API 與資料表不寫成現有架構能力；原圖表實機／密集圖等三筆未結項未結案。

## 12. 實作進度

### A1 提醒聚合

獨立 worktree 基線為研究 PR #226 合併後的 `23f0af5d2c03963c89d9d9e170c467bbcb0cc66a`。總覽的待處理聚合八種既有來源，支援專案／類型、10／20／50 筆分頁與框內捲動。來源失敗顯示未知；每類最多檢查 200 筆，Knowledge 與知識頁超出窗口時 matching total 為 null，已找到的數量只是下限。其餘來源以 SQL 完整匹配數量與有界列分開，頁尾列出可查閱窗口，側欄與 KPI 始終使用全域未篩選的下限。

Knowledge 提醒以 ID 開啟變更歷史，知識頁以 ID 開啟原有側面板；補填入口保留專案與請求，未結項整理保留原 request 審閱流程。沒有一般 resolve、桌面通知或背景掃描，來源狀態由原服務決定。metadata 缺口入口按專案計數未確認 changed files 或未提供 verification 的 Sessions，不把明確 not_run 改稱未提供。A1 沒有新資料表、migration 或 MCP 操作；sourceRevision 暫供來源辨識，A2 寫入意圖前須按問題版本加強指紋及生命週期。

總覽本週報告省略 browser date，讓 server 時區決定週範圍。報告與提醒獨立載入，來源回報數量未到達前不顯示 0；API 錯誤不會變成空清單。正式 read path 已新增 5,000 Sessions 合成基準與 p90 500 ms 上限，5,000 筆基準實測 median 58.91 ms、p90 62.73 ms、max 69.53 ms，37 項效能門檻均通過。另以 20 筆 Knowledge／三張知識頁混合探測 21 條 SQL 計畫與 100 次 CPU profile；15 次讀取 p90 55 ms，成本主要在既有 Knowledge 過時判定與路徑正規化，沒有依記憶體實驗宣稱資料庫最佳解。結果見 [提醒 SQL／CPU 探測](experiments/attention-query-probe.results.json)，腳本只複製並修改合成資料庫。

A1 本機驗證：build、完整單元測試 823 通過／1 既有略過、typecheck、coverage、37 項 performance、25 項 retrieval、9 項 response-size、production audit high 通過。最後的儲存刷新修正另通過五項 store 測試；完整瀏覽器回歸 Chromium 78／1 既有略過、Firefox 23、Playwright WebKit 20 通過。12 種 locale／theme／viewport 組合的提醒清單可鍵盤及 wheel 框內捲動、URL 還原、axe 無違規；已人工檢查 375px 英文明亮截圖。首次兩次 Chromium 分別暴露 URL 還原後的舊測試假設、重複 invalidation 使已成功儲存誤報 AbortError，後者已去重並用 allSettled 隔離背景刷新結果，新增儲存回歸。最新 8af4832 四項 CI 全數通過，PR #227 已於 2026-10-09T14:57:41Z 合併；main 已快轉至 a4315a5。首次遠端背景刷新 fixture 被 SSE 後續讀取覆蓋，已維持合成回應至選取斷言完成。實機 Safari 尚未驗證。

### B1 相關工作提示

實際端點使用 `GET /api/sessions/:sessionId/related`。Session 詳情提供最多五筆同專案共同檔案的可開啟來源，雙語／主題／375、960、1440px 清單可換行；提示理由為共同檔案，不冒稱依賴或完成證據，不自動連結。無來源、檔案未確認、無檔案、超過 20 檔、錯誤與截短彼此區別。

migration 28 增加可重建的 `related_work_paths`／`related_work_dirty` 派生索引，並非新的使用者資料：不匯出，匯入 Session 後由 trigger 重建；Session／專案永久刪除由 FK cascade 清除。索引僅保存正規化檔案，不處理 handoff 或全文 token；每個最多 20 檔的焦點用 covering index seek 取每檔前 1,000 候選，去重後固定大小 top-5，時間為 O(H+C×(m+5))，H≤20,020（含截短探測列）、m≤20。Jaccard 用整數交叉相乘比較，沒有全候選排序或逐候選 SQL。

SQL EXPLAIN 確認 `idx_related_work_project_path` covering seek，去除不必要 DISTINCT 及其暫存 B-tree。合成資料的最終探測：5,000 筆首次建索引 85.83ms、後續 p90 3.01ms；50,000 筆首次 1208.95ms、後續 p90 30.06ms，熱門路徑明示 partial。首次成本包含同步 dirty 索引，不能用暖查詢毫秒冒稱冷啟動速度。回應各為 1,267／1,332 bytes，完整計畫與 CPU 函數摘要見 [SQLite 探測](experiments/related-query-probe.results.json)。既有完整 FTS 同步方案在 50k 首次約 15.7 秒，已由上述輕量索引取代。

B1 開始時間為 2026-10-09T14:26:47Z（時間工具證據）。本機 build、完整單元 834 通過／1 既有略過、typecheck／coverage、38 項效能、25 retrieval、9 response-budget 已通過；最終完整 UI 回歸 Chromium 91／1 既有略過、Firefox 36、Playwright WebKit 33 通過，375px 英文截圖已人工檢查；最新 e4af097 的三平台 Quality 與 E2E 全 SUCCESS（run 37949833801），PR #228 已於 2026-10-09T15:23:22Z 合併，遠端／本機 related-work 分支已清除；main 更新至 cbb766d。新增回歸也確認已成功作廢／連結不被背景刷新 AbortError 誤報失敗。


### B1 本機服務核對

2026-10-09T15:35:48Z 的 HTTP 回應證據確認，既有 macOS LaunchAgent 已從 schema 27 更新到 28。更新前相關工作端點回傳 404 Route not found；重新建置 main 並重啟既有服務後回傳 200。B1 記錄的 36 個檔案正常回傳 too_many_files，Chrome 畫面顯示「修改檔案超過 20 個，暫不推導相關工作」，無錯誤提示。不存在或不可見的來源回傳 source_unavailable 空 DTO；未將 HTTP 失敗轉成空結果。MCP 在建置期間回報 restartRequired，已停止 MCP 操作；透過最新本機 REST API 補寫原 B1 記錄與相關知識頁，未另建記錄。MCP 本身仍待重連。

### C1 報告段落呈現（本機驗證完成）

原工作於 2026-10-09T15:12:22.033Z 開始；接手訊息時間為 2026-10-09T15:15:57.019Z，均取自聊天工具／transcript，未估計。使用獨立 five-features-takeover worktree 延續原未提交變更。

每份不可變 ReportSummary 的七類群組各自釘選、隱藏及恢復；文字改稿以群組與原始 ordinal 定位，只改 title/detail。migration 29 的 report_presentations 保留 Web revision 歷程，匯出／匯入／遮蔽／專案刪除納入完整生命週期。expectedRevision 在 immediate transaction 中比較，409 保留草稿，載入最新比較後須使用者明確套用。每次讀寫都核對完整來源仍存在、未作廢且 tracked，單專案基底拒絕其他專案來源，全域基底逐一核對全部來源；來源失效時不顯示原文作為成功結果。

完整單元 848 通過／1 既有略過；最後補入來源邊界後 storage 定向 7 通過。build、typecheck、coverage、39 項 p90 效能門檻、25 retrieval、9 response-size、production audit high 均通過；呈現讀取含來源檢查的 5k 合成基準 p90 0.57ms。完整瀏覽器 Chromium 104 通過／1 既有略過、Firefox 49、Playwright WebKit 46 通過；12 組語言／主題／尺寸涵蓋釘選、隱藏、恢復、改稿、axe 與 409 草稿流程。實機 Safari 不在此驗證範圍。首次 Windows CI 暴露測試仍有第二個 DB 開啟時刪除父目錄的 EPERM；改為先關閉全部測試 DB 再刪除。最新 10b688d 四項 CI 全 SUCCESS（run 38013171216），PR #229 於 2026-10-10T01:40:07Z 合併，分支清除並更新 main 至 047c1ee。E2E 先前失敗來自可存取名稱含操作按鈕及 UiField 群組與輸入同名，已用群組身份及 textbox 角色定位；fixture finalize 鍵改為每個合成專案唯一，避免重試引用另一專案的來源。

### C2 首頁洞察（本機驗證完成）

開始時間 2026-10-10T01:22:58Z（時間工具證據），獨立 dashboard-insights 分支，初始 worktree 乾淨。使用完整週報 totals、comparison 與 projects 推導最多兩句洞察；驗證提示依 failed、in_progress、未回報／未執行、passed 優先，沒有把未知算通過。前期為零以文字說明，不計算成長百分比；專案占比以完整總數為分母，O(P) 選最大值，同數量按 ID 決定。日期與時區使用服務回應；連結保留週範圍與專案。載入、空結果與請求錯誤分開呈現。

C2 完整單元 851 通過／1 既有略過，web coverage、typecheck、lint／格式及 build 通過。完整 Chromium 117 通過／1 既有略過、Firefox 62、Playwright WebKit 59 通過；39 項新增定向測試也通過。已檢查 375px 英文明亮洞察截圖，長專案名與文字換行正常、無水平溢出；實機 Safari 未驗證。


### C3 報告複製

開始時間 2026-10-10T01:51:35Z（時間工具證據），獨立 report-copy 分支，基線乾淨。基本版重用現有匯出；整理版在單一 read snapshot 中核對完整來源與 revision，使用和 UI 相同的純投影輸出 Markdown，隱藏正文不復原、保留改稿標記與來源引用。來源失效及 409 都有明確錯誤，沒有成功空結果。預覽後另一次點擊立即啟動剪貼簿寫入，不在寫入前 fetch／await；失敗可選取唯讀文字或下載，成功才顯示成功圖示，切範圍／版本會取消舊預覽。

定向 storage 9、server 6、web 177 與三瀏覽器各 14 項通過，涵蓋雙語／明暗／三尺寸。axe 發現共用對話框的 header／footer 引入第二個全頁 banner，已改為普通容器保留標題與焦點行為。已人工檢查 375px 英文明亮複製預覽；剪貼簿使用 stub，未宣稱實機 Safari 或 OS 剪貼簿通過。完整品質回歸執行中，CI 與合併尚未完成。

## A2 提醒偏好實作（2026-10-10）

總覽沿用既有提醒列與來源入口，列尾選單提供「七天後再提醒」與「隱藏此次」，顯示範圍選單切到隱藏／稍後清單後可重新顯示。所有待處理總數保持原來源計數，UI 明示已檢查視窗內隱藏筆數；全部隱藏與健康空清單採不同文字。範圍保存於 URL，背景刷新保留同一組來源的閱讀位置。

Web PATCH 只寫顯示偏好，來源指紋與偏好修訂雙重 CAS 在 immediate transaction 內核對。outstanding 與 metadata 聚合指紋包含來源 ID／更新狀態，知識頁包含有界清單內每頁的最新 Session 身分；同筆數與同最新時間的替換也會重新顯示。多專案全域請求無法證明單一來源歸屬，僅提供原來源入口。

migration 30、可攜式資料欄位／型別、匯入安全復原、永久刪除計數與來源刪除觸發器一併加入。偏好只含 ID／版本與時間，不存來源文字。批次 lookup 只查已檢查的來源 tuples，沒有逐列 SQL；新增 `getAttention (suppressed preferences)` 5,000 Session p90 門檻 500ms，實際結果於驗證後記錄。
