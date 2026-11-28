# 專案現況與未結項

本頁先列目前仍開放或暫緩的工作；已完成階段移到下方歷史段落。實作細節與逐項複檢結果另見 PR、CHANGELOG、正式驗證文件與工作記錄。

> 回到 [README](../README.zh-TW.md)（[English](../README.md)）

- 最後更新：2026-11-28

## 1.6.103（匯入不再把已永久刪除的 Session 帶回來）

- 匯入較舊的匯出檔或另一台電腦的匯出檔時，本機已永久刪除的 Session 會列為「已在本機刪除」衝突，不會寫回，其決策、待結項、事件、證據、連結等關聯資料也不會加入（#513）。詳見 [1.6.103 更新說明](releases/1.6.103.md)。

## 1.6.102（超過最後一頁回空頁、內容沒變的段落不建新版本）

- Agent 審查與未結項清理內容要求的頁碼超過總頁數時回空頁（#502）；知識頁段落儲存內容完全相同且不需複查時列為 unchanged、不建立新版本（#503）。詳見 [1.6.102 更新說明](releases/1.6.102.md)。

## 1.6.101（既有知識改成精簡清單，全部列得出來）

- `existingKnowledge` 改為依狀態與種類分組的標題清單，不帶 id、同組去重，上限提高為有效 300、已封存 100、已駁回 50，放不下時優先保留待審、已駁回、已封存；用真實資料實測，241 筆全部列出（原本漏 89 筆），審查第 1 頁約 23.8k 降為 16.1k 字元（#474 第四步）。詳見 [1.6.101 更新說明](releases/1.6.101.md)。

## 1.6.100（Agent 審查內容同一個 Session 只列一次）

- `work_get_agent_review_context` 每頁改帶一份 `sessions` 清單，項目只標 `sourceSessionId`，`otherDecisions` 不再重複該頁的待審決策；用真實資料完整審查一次（55 筆、6 頁），從約 64.2k 降為約 61.3k 字元（#474 第三步）。詳見 [1.6.100 更新說明](releases/1.6.100.md)。

## 1.6.99（知識頁只看要複查段落時，需要整頁就直接回整頁）

- 以 `reviewOnly` 讀取知識頁時，判定需要整頁讀取（`use_full_read`）或整頁重寫（`full_rewrite`）就在同一個回應附上整頁內容，不必再讀一次；用真實資料維護五個知識頁，從 10 次呼叫、約 63.6k 字元降為 5 次、約 58.4k 字元（#474 第二步）。詳見 [1.6.99 更新說明](releases/1.6.99.md)。

## 1.6.98（維護多個知識頁時不重複讀相同的 Session 預覽）

- 讀取知識頁維護資料時可帶入第一次讀取的 reviewToken，之前看過的新 Session 只回傳摘要識別，不再重複整段預覽；用真實資料維護五個知識頁，回應量約少 13k 字元（#474 第一步）。詳見 [1.6.98 更新說明](releases/1.6.98.md)。

## 1.6.97（網頁操作細節整理）

- 工作歷程搜尋標出符合字詞並顯示摘錄；手機上清單跟著整頁捲動、Session 詳情更好讀；關係圖記得上次的專案並把顯示設定收起；系統狀態偏好移到最上方；不在這台電腦的專案改用中性標示（#490）。詳見 [1.6.97 更新說明](releases/1.6.97.md)。

## 1.6.96（資料備份頁分清楚該用哪一種）

- 資料備份頁先說明換電腦或合併用專案 JSON、整台還原用整份資料；匯出與匯入分開；匯入改用「選擇檔案」按鈕並可拖放，預覽完成會捲過去；每個數字都有說明並可展開各類型明細；沒有要寫入時顯示「沒有需要匯入的變更」，全是衝突時說明原因與做法；匯入後可前往專案清單（#489）。詳見 [1.6.96 更新說明](releases/1.6.96.md)。

## 1.6.95（知識頁與 Knowledge 更好讀）

- 知識頁側邊面板依段落與清單分段、行寬約 72 字，來源收合成「來源（N）」；知識頁分頁依專案分組，同名頁面分得清楚，點標題即可打開；有追蹤專案就能「自訂知識頁」，多個專案時先選專案；Knowledge 列預設只顯示標題、類型、一行摘要與一行資訊，「展開詳情」才看全文（#488）。詳見 [1.6.95 更新說明](releases/1.6.95.md)。

## 1.6.94（待確認決策更快也更安全）

- 待確認決策只有「確認」是主要按鈕，「拒絕」一律先詢問，「整理成 Knowledge」收進「更多」；可勾選多筆一次確認或拒絕；整理成 Knowledge 時內容先帶入、游標停在內容；沒帶分頁開工作知識時，有待確認決策就先顯示它；側欄工作知識顯示待處理數量（#487）。詳見 [1.6.94 更新說明](releases/1.6.94.md)。

## 1.6.93（未結項清單更好用）

- 未結項列變矮、動作收在列尾；完成與不再需要都立即生效並可在提示中「復原」；可一次選取全部篩選結果；手機版清單跟著頁面捲動；側欄新增「未結項」與數量；整理未結項不必先選專案（#486）。詳見 [1.6.93 更新說明](releases/1.6.93.md)。

## 1.6.92（交給 Agent 的流程一致）

- 每個交給 Agent 的流程都用同一個提示區塊：狀態、接下來會發生什麼、可複製的指令；Agent 審查不必先選專案，直接列出有待處理項目的專案與數量；停用的按鈕改成灰色並說明原因（#484）。詳見 [1.6.92 更新說明](releases/1.6.92.md)。

## 1.6.91（未結項清理更順手）

- 同一次清理中先標為已檢查的項目可以之後補判定，匯出匯入也會保留；寫工作記錄時，和新 nextSteps 提到同一個 issue 的待處理項目會排在最前面並標出可能重複；取得清理內容可以直接指定專案（#493）。詳見 [1.6.91 更新說明](releases/1.6.91.md)。

## 1.6.90（篩選與總覽「需要處理」）

- 篩選選單直接顯示套用的值，清單上方列出可移除的篩選標籤；工作歷程與工作知識分頁顯示「篩選後 / 全部」（#485）。
- 總覽「需要處理」有項目時排在統計卡前，每頁 10 筆，同專案同類項目合併成可展開的一列，待確認決策可直接確認或拒絕（#483）。詳見 [1.6.90 更新說明](releases/1.6.90.md)。

## 1.6.89（未結項由 Agent 結案）

- Agent 整理未結項的判斷直接生效，Web 可重新開啟；新增「記錄為已知限制」；寫工作記錄時提醒不該進待辦的內容，並標出可能已完成的未結項（#482）。
- schema 升級到 43。詳見 [1.6.89 更新說明](releases/1.6.89.md)。

## 1.6.88（Knowledge 候選整理）

- 候選頁只列值得整理的 Session，每個專案一列、各自有整理按鈕；Agent 交回候選後自動接著整理下一批，可隨時停止（#481）。
- 不需要升級資料庫。詳見 [1.6.88 更新說明](releases/1.6.88.md)。

## 1.6.87（知識頁誤判與匯入衝突）

- 知識頁引用的 Session 只是被接續、加關聯、附證據或圖表作廢還原時，不再顯示「來源需要核對」；升級時清掉舊的誤判（#475）。
- 兩台電腦互相匯入時，Session 的決策以摘要為準整組比對，過時的一方會被取代，不再永遠是衝突（#477）。
- 永久刪除 Session 後，它處理過的待結項紀錄不再造成匯入衝突（#479）。
- schema 升級到 42。詳見 [1.6.87 更新說明](releases/1.6.87.md)。

## 1.6.86（專案慣例）

- 使用者可以把每個專案最多 5 件 Knowledge 設為專案慣例；Agent 讀取上下文時會收到它們的標題清單，不擠掉和任務相關的內容（#451）。
- 封存、取代、被回報不成立、Agent 改寫標題或內文、匯入改變內容時自動撤回，需要使用者重新確認。
- schema 升級到 41。詳見 [1.6.86 更新說明](releases/1.6.86.md)。

## 1.6.85（簡化 Agent 更新知識頁的流程）

- 存檔時可以一併標記已檢查；來源超過 20 筆時保留最新 20 筆，不再拒絕；存檔衝突時附上重試資料；標記已檢查只回傳精簡結果（#467）。
- 還沒完成的開工記錄不算進知識頁的新 Session，完成後才計入。
- schema 維持 40。詳見 [1.6.85 更新說明](releases/1.6.85.md)。

## 1.6.84（專案選單共用同一個元件，輸入錯誤指出實際欄位）

- 所有頁面的專案選單改用同一個元件，選了專案後仍列出全部可選的專案，可以直接切換；修正工作知識頁選了專案後只剩目前專案的問題。
- 接受兩種格式的欄位驗證失敗時，MCP 與 REST 的錯誤會指出實際的欄位與可用的值（#469）。
- 匯入檔案時，已存在的相同 Session 關聯不再列為衝突（#471）。
- schema 維持 40。詳見 [1.6.84 更新說明](releases/1.6.84.md)。

## 1.6.83（開工記錄收尾時保留開始時間，匯入不再把同一筆 Session 關聯算成衝突）

- 開工與收尾之間 MCP 重新啟動時，收尾後的 Session 沿用開工記錄的開始時間與來源紀錄；明確傳入的開始時間仍然優先。
- 改寫開工記錄時保留 Session 關聯的 ID；匯入時同一對 Session、同一種關聯只是 ID 不同，會略過而不是列為衝突。
- schema 維持 40。詳見 [1.6.83 更新說明](releases/1.6.83.md)。

## 1.6.82（Agent 審查請求完成後在 Web 顯示知識頁更新階段）

- Agent 審查請求區塊在請求完成後列出受影響的知識頁，每頁顯示已更新、已檢查、仍待更新或未變動，並可直接開啟該頁；有新的請求進行中時不顯示上一次的清單。
- 請求完成時保存知識頁清單（schema 40），Agent 更新頁面後清單不會變動；匯出與匯入都包含這個欄位。MCP 的回傳格式不變。
- 詳見 [1.6.82 更新說明](releases/1.6.82.md)。

## 1.6.81（工作知識分頁照處理順序排列，交給 Agent 的說法寫明 Work Intelligence）

- 工作知識的分頁改為：待確認決策、候選、Knowledge、知識頁；開啟時仍預設顯示 Knowledge。
- Web 上請你對 Agent 說的話都帶上 Work Intelligence，例如「用 Work Intelligence 處理 Agent 審查請求」，沒有上下文的 Agent 也知道要用哪個工具。
- schema 維持 39；升級後請重新連線 MCP。詳見 [1.6.81 更新說明](releases/1.6.81.md)。

## 1.6.80（開工記錄用同一個 key 再結案一次即完成）

- Agent 開工時以 `verification.status: "in_progress"` 結案一次，留下開工記錄；收尾時用同一個 `idempotencyKey` 再結案一次，就原地完成同一筆 Session，不需要再呼叫三個更新操作。開工記錄可以不填 `nextSteps`，不會產生未結項。
- 進行中記錄的回條不再顯示 `executionStatus: "completed"`，改附一行提示說明怎麼完成。
- 開工記錄不再重置伺服器觀察到的開工時間與 HEAD；用 `completedAtNow` 完成的 Session 也會結束觀察，下一段工作的開工時間不會早於上一段的完成時間。
- schema 維持 39；升級後請重新連線 MCP，讓 Agent 讀到新的結案說明。詳見 [1.6.80 更新說明](releases/1.6.80.md)。

## 1.6.79（同一用戶端同時進行多段工作時，結案回條不再混列 Knowledge）

- 同一個 Agent 用戶端開兩個 MCP 連線同時做兩段工作時，結案回條的 `unreportedKnowledge` 只列該連線自己讀過的 Knowledge。
- schema 升到 39：`agent_read_audit` 新增 `connection_id` 欄位（只在本機，不匯出）。Agent 不需要重新連線；舊版 MCP 程序的讀取沒有連線識別，不會被計入。詳見 [1.6.79 更新說明](releases/1.6.79.md)。

## 1.6.78（Agent 固定閱讀量減少約三成）

- Agent 結案前固定要讀的文字從 42,244 降到 30,099 字元；結案回覆直接寫明每個警告的原因與下一步。
- 四種自相矛盾的結案請求改為拒絕；知識頁儲存會檢查 reviewToken 的涵蓋點。
- 伺服器 instructions 寫明先呼叫 `work_get_context` 再看專案資料夾；A/B 實測未追蹤專案由 0/5 變為 5/5 通過。
- schema 維持 38；升級後請重新連線 MCP。詳見 [1.6.78 更新說明](releases/1.6.78.md)。A/B 結果與決定見 `docs/decisions/2026-11-agent-reading-budget-ab.md`。

## 1.6.77（Agent 審查請求的下一步提示與用量頁版面）

- 建立 Agent 審查請求後，通知與請求區塊會寫明要對 Agent 說「處理 Agent 審查請求」。
- 用量頁左側區塊在分欄時撐滿到畫面底部；同一列的面板高度一致。
- 只調整 Web 畫面，schema 維持 38，Agent 不需要重新連線。詳見 [1.6.77 更新說明](releases/1.6.77.md)。

## 1.6.76（Agent 審查涵蓋有疑慮的 Knowledge）

- Agent 審查請求另外納入可能過時或被指出矛盾的 active Knowledge，判斷規則和注意事項佇列相同；只有 `broadChangesSince` 或只是久未確認的不納入。每筆附內容、`appliesTo`、疑慮原因與最多 5 筆後續 Session 的標題和路徑，和決策、候選共用 500 筆上限與 24,000 字的頁面預算。
- Agent 可以選「仍成立」（確認）、「封存」或「改寫後取代」（新的 Knowledge 帶 `supersedesId`），都要附理由，各自走原本的確認、封存與寫入流程。寫入被拒絕時回 `knowledge_rejected`，項目保持待處理，可以換新的 `idempotencyKey` 重送。
- Web 的知識分頁可以在右側欄建立請求，並在 Knowledge 清單切換到「由 Agent 處理」查看與推翻：撤回確認、還原封存，或封存新的這筆並還原舊的。REST 新增 `GET /api/agent-review-knowledge` 與 `POST /api/knowledge/:knowledgeId/overturn`。
- schema 38 只放寬 `agent_review_request_items` 的 CHECK，重建該表，沒有新增資料表或欄位。Agent 固定讀取量由 42,249 降為 42,244。
- MCP contract 文字改變，Agent 需重新連線 MCP。資料庫升級到 schema 38，升級時自動備份。詳見 [1.6.76 更新說明](releases/1.6.76.md)。

## 1.6.75（刪除自訂知識頁與拆頁前先整理）

- Web 的知識頁面板可以刪除自訂知識頁，確認視窗列出一併刪除的歷史版本數；頁面、版本、更新請求與注意事項設定在同一個交易刪除。三個預設頁不能刪除，REST 回 409 `knowledge_page_default`。MCP 沒有刪除工具；Agent 讀到全是「資料不足」的自訂頁時，回應帶 `emptyPageHint`。
- schema 37 新增不含內容的 `knowledge_page_deletion_audit`，合併匯入較早的匯出檔時把刪掉的頁面列為 `deleted` 衝突，不會加回。刪除只記在本機，不會同步到其他電腦。
- 接近上限時的建議改成先刪掉不再適用的內容，仍放不下才提議移到自訂頁；仍然成立的文字不刪減。上限不變，Agent 固定讀取量維持 42,249。
- MCP contract 文字改變，Agent 需重新連線 MCP。資料庫升級到 schema 37，升級時自動備份。詳見 [1.6.75 更新說明](releases/1.6.75.md)。

## 1.6.74（保存回條提醒讀過但未回報的 Knowledge）

- `work_finalize_session` 的回條另帶 `unreportedKnowledge`：這段工作中同一 MCP 用戶端在同專案以召回工具讀過完整內容、這筆 Session 還沒回報的 active Knowledge，最多 3 筆（`id`、80 字元內的標題），超過時附總數。精簡清單、維護讀取、補登、沒有開始時間或不知道用戶端時都不計算；全部回報過或沒讀過就不帶。請求有回報時另帶 `knowledgeFeedback` 計數。
- `work_update_session_metadata` 可帶 `appliedKnowledgeIds`、`contradictedKnowledgeIds` 補報；同一 Session 已回報過的不再寫入，重送沒有副作用。metadata backfill 不接受這兩個欄位。
- MCP contract 文字改變，Agent 需重新連線 MCP。資料庫維持 schema 36，不需遷移。詳見 [1.6.74 更新說明](releases/1.6.74.md)。

## 1.6.73（未登錄路徑的相符專案提示與知識精簡清單）

- MCP 操作因 `projectRoot` 未登錄而略過時，回應另帶 `matchingProjects`：最多 5 筆 tracked 或 paused 專案的名稱、root 與狀態。相符條件只有路徑位於已登錄 root 之下、資料夾名或專案名稱相同（忽略大小寫）、已登錄 root 位於路徑之下三種；不列 ignored 專案，不讀專案資料、不建立資料列，也不會自動改用相符的專案。沒有相符時回應不變。
- `work_search_knowledge` 新增 `view: "compact"`：每筆只回 `id`、`kind`、`status`、`title`、`updatedAt`、`appliesToCount`、`needsReview`，SQL 不載入內文；50 筆虛構資料的一頁由 87,220 字元降為 10,872 字元。不帶 `view` 時回應不變。
- MCP contract 文字改變，Agent 需重新連線 MCP。資料庫維持 schema 36，不需遷移。詳見 [1.6.73 更新說明](releases/1.6.73.md)。

## 1.6.72（知識頁接近上限時建議拆頁）

- 知識頁有 11 段以上，或段落內容合計 7,200 字以上（8,000 字的 90%）時，`work_get_knowledge_page_context` 的完整讀取、聚焦讀取與只讀待核對段落，以及 `work_save_knowledge_page` 的完整儲存與單段更新回條，都另帶 `size` 與 `splitSuggestion`：接近哪個上限、建議移到自訂頁面的最大幾段（最多 3 段），以及建立自訂頁面的一句指引。沒接近上限時不多回任何欄位。
- 超過上限被拒絕時，`page_limit_exceeded` 與整頁參數錯誤的訊息都改為指向拆頁；上限維持 12 段與 8,000 字，伺服器不會自動拆頁。
- Web 的知識頁與編輯視窗在接近上限時顯示目前用量與建議移出的段落。
- 上限與「接近」的判定集中在 `@work-intelligence/core` 的 `knowledgePageLimits`，儲存、讀取、MCP 與 Web 共用。
- MCP contract 文字改變，Agent 需重新連線 MCP。資料庫維持 schema 36，不需遷移。詳見 [1.6.72 更新說明](releases/1.6.72.md)。

## 1.6.71（知識頁只讀待核對段落）

- `work_get_knowledge_page_context` 新增 `reviewOnly: true`：只回需要核對的段落全文，附原因、背後的 Session 預覽、其餘段落的標題與字數，以及頁面相對 12 段與 8,000 字上限的大小，並回傳沿用頁面涵蓋範圍的 `reviewToken`，給單段更新用。沒有要核對的內容時回應很小並標示 `review: "none"`；空白頁或使用者要求更新時標示 `full_rewrite`；要核對的段落超過一半、全文超過 4,000 字或回應不會比全頁小時標示 `use_full_read`，不回段落，請讀全頁。不能和 `query`／`headings` 一起帶。
- 段落要核對的條件：引用的 Session 在儲存後有變動，或有新 Session 對應到它。新 Session 對應段落的規則是與段落引用的 Session 有關聯（任一方向，權重 2），或改過同一個檔案（權重 1），權重平均分給證據指向的段落；指向超過 3 段的證據不算，每筆新 Session 最多對應得分最高的 3 段。對不到段落的新 Session 只列標題；`checkedThroughCandidate` 指出已全部列出的最後一筆新 Session。
- `review` 模式下同時是新 Session 又是有變動來源的 Session 只列一次（`reasons: ["new", "source_changed"]`），只占一次 Session 預算；Session 的欄位由 `reason` 改為 `reasons`。
- MCP contract 文字改變，Agent 需重新連線 MCP。資料庫維持 schema 36，不需遷移。詳見 [1.6.71 更新說明](releases/1.6.71.md)。

## 1.6.70（Agent 審查請求）

- 使用者在「知識」頁對「記錄中」的專案開啟 Agent 審查請求（或請 Agent 代為開啟），把待確認的 Agent 自主決策與已提出的 Knowledge 候選做成快照；Agent 直接套用結論並附理由。決策確認、駁回或升為 Knowledge，候選接受（可附修改）或駁回；沒有證據的維持待確認，快照後被改過或已審查的略過不覆寫。
- 同專案只有一個進行中的請求；快照上限 500 筆並顯示超出筆數；處理超過 30 分鐘變成失敗，可繼續處理；Web 可取消。完成後結果列出有新材料的知識頁，由 Agent 走單段更新，伺服器不改寫頁面。
- 決策與候選記錄審查者（使用者／Agent）、理由、請求與時間，舊資料視為使用者審查。Web 清單可篩選「由 Agent 處理」並顯示理由；使用者可推翻 Agent 的結論，項目回到使用者佇列，由該結論建立且仍使用中的 Knowledge 會封存（已封存或刪除的不變），被推翻的項目不再被之後的請求撿走。
- MCP 新增 `work_request_agent_review`、`work_get_agent_review_context`、`work_submit_agent_review_verdicts` 與按需指引 `references/agent-review.md`；Agent 需重新連線 MCP。REST 新增 `/api/agent-review-requests`（建立、列出、取消）與兩個 overturn 端點，並支援 `status=agent_reviewed`、`reviewedBy=agent` 篩選。
- 未結項清理仍須人工核准，候選的提出方式不變。

資料庫升到 36（升級時自動備份後遷移）；專案匯出入包含新資料，仍可匯入 schema 31–35 的匯出檔；新增 schema 35 升級樣本。詳見 [1.6.70 更新說明](releases/1.6.70.md)。

## 1.6.69（知識頁單段更新）

- `work_save_knowledge_page` 可改帶 `upsertSections` 和／或 `removeHeadings`（皆 1–12 項，必須帶 `reviewToken`，與 `sections` 互斥）只更新幾個段落：同標題（去空白、不分大小寫）原地取代，否則附加在頁尾，其餘段落不變，合併後才檢查 12 段與 8,000 字上限。新結果 `section_not_found` 與 `page_limit_exceeded` 都不寫入。MCP 回傳精簡回條（`page` 狀態與 `sectionChanges`）。
- 單段更新不推進 Session 涵蓋範圍、不移動檢查游標、不清除使用者的更新要求；取代與新增的段落清除 `needsReview`，沒動到的段落保留。
- 聚焦讀取（`query`／`headings`）也回傳 `reviewToken`。
- 已知限制：匯入 1.6.69 的匯出檔到舊版 App 時，單段基準會被忽略，逐段更新過的頁面可能少了一些「來源需核對」標記。

沒有 schema 變更，資料庫維持 35。詳見 [1.6.69 更新說明](releases/1.6.69.md)。

## 1.6.68（收尾回條的暫時狀態提示、知識頁預設問題、用量頁改版）

- `work_finalize_session`、`work_update_session_work_summary`、`POST /api/work/finalize` 與 `PATCH /api/sessions/:id/work-summary` 的結果新增選填的 `nextStepsWarnings`，在已儲存的 `nextSteps` 項目看起來是本次工作內的暫時狀態（尚未 commit、尚未 push、PR 等待合併、CI 執行中、階段尚未開始）時提示。只靠關鍵字，可能誤判；伺服器不刪除、不改寫、不拒絕項目。
- 工作記錄契約與 work-intelligence skill 列出同樣的範例；修復指引要求事後以 `work_update_session_metadata` 補上實際的 commit 與分支；知識頁與知識指引寫明 branch、commit、PR 與合併狀態以 Git 為準，頁面不記錄，且已在 Knowledge 的事實不複製進 Agent 自己的記憶檔。
- 「進行中的工作與未結項」知識頁的預設問題改為「目前有哪些尚未完成或尚未驗證的事項與已知限制？」，不再問進行中的工作。已保存的頁面維持原本的問題。
- 用量頁改版：控制項固定在左欄，只有結果捲動；摘要卡片附每日走勢，5 小時區段卡片顯示時間進度與起訖時間；表格在窄欄改為卡片，沒有內層捲動區。
- 桌面 smoke 測試等到移除作業記錄提交後才走訪家目錄，修正 v1.6.67 Windows 發行驗證的 ENOENT。

沒有 schema 變更，資料庫維持 35。詳見 [1.6.68 更新說明](releases/1.6.68.md)。

## 1.6.67（用量口徑改為輸入 + 輸出、依模型分列、monorepo 分配）

- 用量頁、`pnpm usage:report` 與「複製給 Agent」移除成本估算。主要數字改為輸入 + 輸出（不含快取），快取讀取與寫入另列，並顯示快取讀取佔比。
- 新增依 Agent 與模型分列的 Token、依日趨勢，以及每個 Agent 目前的 5 小時區段（規則同 ccusage `blocks`）。
- 在 monorepo 根目錄開的 Agent 對話，會依 Work Intelligence 呼叫的 `projectRoot`、讀寫檔案的資料夾、工作目錄的順序分給分別註冊的子專案，每段對話只算一次，其餘列為「共用（未分配）」；每個專案的分配依據次數出現在頁面、API、CLI 與複製文字。
- 用量頁改版：摘要卡片、Token 組成、依日堆疊長條與附長條的排行表格，亮暗色與窄螢幕都可閱讀。
- 打包後測試的殘留程序檢查改以程序編號加建立時間確認父程序，避免 Windows 重用編號時誤報。

沒有 schema 變更，資料庫維持 35。詳見 [1.6.67 更新說明](releases/1.6.67.md)。

## 1.6.66（Agent 用量頁面與升級流程檢查）

- Web Dashboard 新增「用量」頁（桌面 App 與 `pnpm bootstrap` 都可用），依已追蹤專案自動對應本機 Claude Code 與 Codex 紀錄，顯示回合、工具呼叫、Work Intelligence 佔比、各類 Token、估算的成本佔比與 Work Intelligence 各操作的呼叫次數；「複製給 Agent」只含加總、專案名稱與對話序號。CLI 為 `pnpm usage:report`。
- `scripts/agent-usage-report.mjs` 依 Work Intelligence 操作分組，只讀呼叫參數的 `operation` 欄位。
- 桌面 smoke 以 schema 34 與 31 樣本檢查升級後一鍵更新；packaged smoke 有時限、即時 log 與失敗也會上傳的紀錄，清理時不再結束 runner 等既有行程。

沒有 schema 變更，資料庫維持 35。詳見 [1.6.66 更新說明](releases/1.6.66.md)。

## 1.6.65（升級後一鍵更新資料庫、語言選項、知識頁維護指引）

- App 升級後若資料庫只需要更新結構，狀態改顯示「需要更新資料庫」，「狀態」與「資料」分頁提供「先備份再更新資料庫」，不必再用「選擇資料庫…」找檔案。資料庫在雲端同步資料夾、卸除式磁碟或硬連結上時，改提供「複製到本機資料夾後更新」，原檔不變。
- 桌面 App「設定」分頁新增「顯示語言」：跟隨系統、繁體中文、English，切換立即生效，並與 App 管理的 Dashboard 同步。
- Agent 知識頁指引新增三個維護步驟（review 與 full 的選擇、`truncated` 時分批讀完、沒變就標記已核對）。A/B 結果與決策見 `docs/experiments/retrieval-baseline/ab-report.md` 與 `docs/decisions/2026-11-agent-guidance-ab.md`；檢索指引不改，不做導航讀模型。

沒有 schema 變更，資料庫維持 35。詳見 [1.6.65 更新說明](releases/1.6.65.md)。

## 1.6.64（Agent 讀取回應大小與檢索基準）

- Agent 讀取稽核新增 `responseChars`：每次 MCP 讀取實際送出的回應字元數（JavaScript 字串長度，即 UTF-16 code unit；不是位元組也不是 token），只存數字，不存內容。用來判斷慢與貴是出在 SQLite、過大的回應，還是 Agent 的推理。
- 系統狀態頁的各工具統計新增回應大小的 p50、p95 與總和；schema 35 之前的紀錄是未知，不列入。
- 資料庫 schema 升到 35：`agent_read_audit` 新增可為空的 `response_chars`。稽核表不在專案資料匯出內，匯出與匯入格式不變。
- 新增 Agent 用量解析腳本 `scripts/agent-usage-report.mjs`，只輸出加總數字；Codex 紀錄的支援仍屬實驗性。
- 新增檢索與知識頁基準 `docs/experiments/retrieval-baseline/`：合成資料上檢索 30 題通過 28 題，Policy 案例全過，SQLite 讀取中位數 1.93 ms，不是瓶頸。知識頁端到端 5 題尚未用真實 Agent 執行。

資料庫 schema 升到 35，首次啟動時先自動備份再執行 migration。詳見 [1.6.64 更新說明](releases/1.6.64.md)。

## 1.6.63（知識頁覆蓋範圍與版本衝突）

- 知識頁儲存不再把 Agent 沒看到的 Session 算成已涵蓋：context 截斷時被略過的 Session，以及讀取後才完成的 Session，保存後仍是新資料。
- Agent 帶 `reviewToken`、Web 帶 `baseVersion` 儲存時，頁面若已被別人存過就回 `version_conflict`，不覆蓋較新的版本；Web 編輯框保留草稿。
- 資料庫 schema 升到 34：`knowledge_pages` 新增兩個可為空的欄位，既有頁面行為不變。
- 決定維持原本行為：Web 手動編輯把儲存前完成的所有 Session 算成已涵蓋；Agent 讀取後使用者才提出的更新請求，Agent 儲存時一併清除。
- 同一個 idempotencyKey 帶不同內容重送時回 `idempotency_conflict`，不寫入，也不再回報成重複請求。

資料庫 schema 升到 34，首次啟動時先自動備份再執行 migration。詳見 [1.6.63 更新說明](releases/1.6.63.md)。

## 1.6.62（相依套件更新）

- 更新 Vue、Electron、Vite、ESLint 與開發用的 Node.js 型別。Vite 8 改用較新的 Dashboard 瀏覽器建置目標。
- 修正桌面測試的 Electron mock 解析，單元測試與 coverage 使用同一份設定。
- 英文與繁體中文 README、安裝與 Agent 設定指南改以桌面 App 的操作流程為主。

資料庫 schema 為 33，本版不需 migration。詳見 [1.6.62 更新說明](releases/1.6.62.md)。

## 1.6.61（已完成）

桌面 App 接手早期手寫的 Agent 設定（macOS 1.6.60 實機回報「有衝突，沒有寫入任何檔案」）：

- 「改由桌面 App 管理」認得 `pnpm start:mcp` 註冊（`--dir`、`-C`、`cwd`，含 Windows 的 `pnpm.cmd`），以及用絕對路徑 `node` 執行 checkout 內 hook 的寫法。
- 與 App 的 hook 在同一事件重複的舊 hook 可以移除，可以復原；同群組的第三方 hook 不動。checkout 自己的 `.codex/hooks.json` 不計入衝突。
- 只有 `WORK_INTELLIGENCE_DB` 指向 App 的資料庫才會接手，接手時移除這個變數，之後 MCP 與 hook 一起跟著 App 換資料庫，不會分成兩個資料庫。
- 有衝突時，Agent 卡片直接提供接手選項，或用白話說明原因，不要求輸入指令。

沒有 schema 變更（33），沒有 migration。詳見 [1.6.61 更新說明](releases/1.6.61.md)。

## 1.6.60（已完成）

MCP 連線數一直是 0 的根因（Windows 1.6.59 實機回報）：

- App 內建的 MCP 是獨立套件，原本一律略過 lease 註冊，所以連線數不可能大於 0；現在在 App 內會註冊。
- lease 從作業系統暫存目錄改到設定目錄，不再受 Agent 傳給 MCP 的 `TEMP`／`TMP` 影響；舊位置唯讀相容到 1.8.0。
- lease 註冊失敗會記在 `agent-observations.json`，系統狀態會說明連線數為 0 的原因。
- 修正 1.6.59 審查的正確性項目：啟動失敗過早標為需修復、完整性檢查沒有期限、同一資料庫的另一個伺服器占用連接埠時誤判、備份位置在判斷風險前就建立資料夾、還原時清空 WAL 的時機。

沒有 schema 變更（33），沒有 migration。詳見 [1.6.60 更新說明](releases/1.6.60.md)。

## 1.6.59（已完成）

把 1.6.58 守門清單列出、做了卻沒接上的功能接上：

- 換新電腦時還原：用原生視窗對應這台電腦上不存在的專案資料夾。
- 「資料」分頁整理資料庫（先備份、完整性檢查、VACUUM、重建索引），並顯示可回收空間。
- 設定的連接埠被占用時，改用上次驗證過的連接埠啟動（資料庫與 runtime 不自動回退）。
- 「設定」分頁更換備份位置；既有備份不搬移。
- 診斷摘要帶簡短的安裝標籤。
- 後端也使用與 Agent 的 MCP 相同的 lease 範圍；Web 系統狀態「登入自動啟動」卡片排版修正。
- 新增未使用 export 守門（knip 基準）與使用者文件過時說法守門。

沒有 schema 變更（33），沒有 migration。詳見 [1.6.59 更新說明](releases/1.6.59.md)。

## 1.6.58（已完成）

- 「設定」分頁新增「登入時自動啟動」開關（Windows、macOS），顯示系統實際狀態。
- Web 系統狀態在桌面 App 模式下顯示 App 實際的登入啟動狀態、資料庫與備份目錄。
- 新增 CI 守門：修復通道四方對照、設定欄位讀寫、訊息鍵使用、狀態檔讀寫登錄、Web 不出現指令。

沒有 schema 變更（33），沒有 migration。詳見 [1.6.58 更新說明](releases/1.6.58.md)。

## 1.6.57（已完成）

- 1.6.55 跨版本審查剩下的中、低嚴重度項目：更換資料庫與連接埠等操作經同一個協調器、Windows 結束整個行程樹、還原的改名重試（M-14）、後端健康檢查。
- Codex 移除後重新設定不再顯示衝突（一併處理 Codex 加入的工具核准表）。
- 系統狀態不再誤報 MCP 要重新連線；Agent 卡片能顯示「已連線」。

沒有 schema 變更（33），沒有 migration。詳見 [1.6.57 更新說明](releases/1.6.57.md)。

### 1.6.57–1.6.61 共同未結項

- 實機驗收：使用者已確認 Windows 的登入啟動開關（1.6.58），以及 macOS 1.6.60 手動移除舊設定後 Codex 與 Claude Code 沒有衝突、Agent 卡片「已連線」、MCP 連線數大於 0。Windows 上 1.6.60 之後的 MCP 連線數、1.6.61 的接手流程本身、其餘 Windows 11 與 macOS 項目仍**待實機驗收**。
- 資料庫與 runtime 不會自動回退（只回退連接埠）。
- 桌面 V1 審查（1.6.55）留下的未結項，與版本無關：DT-18 跨 OS 帳號與 XSS 回歸測試未做；DT-29 macOS 安裝位置檢測未做，尚未決定是否取消；DT-34 macOS「移除桌面整合」入口未做。H-02、M-11、M-15 已於 1.6.56 修復，不在此列。

## 1.6.56（已完成）

桌面 App 當機復原、App 內還原與「不需要指令」：

- 啟動時依真實狀態關閉被中斷的操作（換連接埠、換資料庫、複製到本機等），結果顯示在 Status 分頁；孤兒副本自動清除。
- 資料分頁新增「從備份還原」，經 OperationCoordinator 執行，還原前自動備份。
- Agent 分頁新增「移除 Agent 設定」；復原遇到檔案被改寫時，只移除我們自己的條目。
- 舊服務流程不再要求執行任何指令；無法由 App 停用時，引導開啟工作排程器或登入項目。新增守門測試，禁止桌面字串出現 pnpm、npm、終端機或命令列。
- 沒有 schema 變更（33），沒有 migration。M-14（還原最後一步的 rename 重試）已在 1.6.57 修復。Windows 11 與 macOS 實機驗收仍**待實機驗收**。詳見 [1.6.56 更新說明](releases/1.6.56.md)。

## 1.6.55（已完成）

桌面 App 單一視窗與分頁、設計 token 共用、無障礙與首次設定完成卡片：

- 單一視窗與分頁：Status、Agent、Settings、Data、Diagnostics；Setup 只在需要首次設定時出現。切換設定頁不再需要工作列選單。工作列項目、啟動旗標與 Web 的開啟請求只聚焦同一個視窗。
- 工作列選單縮短；Windows 與 Linux 沒有應用程式選單，macOS 只保留 App、Edit 與 Window 選單（Cmd+W 關閉視窗，不結束 App）。
- 設計 token 移到 `packages/ui-tokens`，與 Web 版共用；視窗即時跟隨系統淺色與深色模式。
- 無障礙：WAI-ARIA tablist、方向鍵與 roving tabindex、可見焦點、分頁忙碌徽章；切換分頁後狀態保留；4 秒輪詢不搶走焦點。
- 首次設定完成後，Status 分頁顯示一次性的「開始使用 Work Intelligence」卡片。
- CI：Desktop smoke 在 Windows、macOS 與 Linux 全部通過（PR #385，head 見 PR）。Windows 11 與 macOS 實機驗收尚未進行，125% 與 150% DPI 未實測，仍為**待實機驗收**。
- 量測：合計 gzip 28,859 → 34,758 B（+20.4%），增加來自功能本身；Windows 修復視窗開啟時間 1543 → 1715 ms（+11%；數字未驗證，以 CI 取樣為準）。效能門檻未變更。

沒有 schema 變更（33），沒有 migration。詳見 [1.6.55 更新說明](releases/1.6.55.md)。

接下來：1.6.55 實機驗收（Windows 11、macOS、DPI）；Agent 分頁在設定完成前可選取的行為待確認。

## 1.6.54（已完成，已合併）

診斷匯出、舊 runtime 延後清理、Windows SQLite 停滯量測、匯入預覽與連接埠變更，以及 hook 與 MCP 狀態辨識：

- 診斷匯出（DT-19）：修復視窗的「匯出診斷資訊」先開啟預覽，顯示將寫入的確切文字與遮蔽摘要。「儲存檔案…」寫入預覽中的同一份文字；只手動匯出，不上傳，沒有遙測（ADR-29）。
- 舊 runtime 延後清理（DT-24）：只有退役滿 7 天、沒有 lease 且可改名移開時才刪除；更新不因檔案鎖失敗（ADR-16）。
- Windows SQLite 量測（僅測試）：`WI_SQLITE_TIMING=1` 只在 Windows CI 的測試工作中開啟，結果以 artifact 上傳；不改變門檻、逾時或斷言。量測結果：5 個測試程序有超過 1 秒的呼叫（最長 5.5 秒，為 `BEGIN IMMEDIATE` 等待寫入鎖）；開啟資料庫與 checkpoint 都不慢。本版不修正。
- 閒置的匯入預覽不再擋住連接埠變更；只有真的捨棄預覽時才顯示提示（ADR-27）。
- Hook 與 MCP 狀態辨識 launcher 形式的安裝：Web 狀態頁與桌面 Agent 頁共用同一個辨識器。
- CI：PR #382 的 23 項必要檢查全部通過（commit d0fa5e4）。Windows 11 與 macOS 實機驗收尚未進行，仍為**待實機驗收**。

沒有 schema 變更（33），沒有 migration。詳見 [1.6.54 更新說明](releases/1.6.54.md)。

接下來：1.6.54 之後進行跨版本的完整檢視。Dependabot 的相依套件更新隨後以獨立 PR 處理。

## 1.6.53（已完成，已合併）

桌面 App 的手動更新檢查（ADR-40）：

- 只在按下「檢查更新」時連線到 GitHub。沒有自動檢查，也沒有開關；按下按鈕即為同意。修復視窗的「更新」卡片與工作列的「檢查更新…」都會開始檢查（1.6.55 起「更新」卡片在「設定」分頁，工作列的「檢查更新…」開啟「設定」分頁並開始檢查）。
- 請求只在主程序發出，不含版本、作業系統、機器識別碼或權杖；不帶憑證，不快取，不接受重新導向。
- 狀態：已是最新版本、有新版本（版本、日期與純文字更新說明）、離線、查詢次數受限（顯示可再試的時間，不自動重試）與錯誤；每個狀態都提供「開啟發行頁面」。
- 下載按鈕在瀏覽器中開啟該平台的安裝檔（Windows x64、macOS arm64 與 x64）；按鈕旁提示以 `SHA256SUMS.txt` 驗證。其他平台只提供發行頁面。App 內不下載、不安裝（ADR-25）；安裝檔未簽署（ADR-38）。
- 經使用者核准，`vue-router` 由 5.5.0 改回 4.6.5，picomatch 不再出現在 production 相依樹；稽核例外 GHSA-fc5q-39xc-vjpf 已移除，不帶例外即通過稽核。Dependabot 忽略 vue-router ≥ 5，待重新評估。
- 每日的 `audit-exceptions-watch` 工作流程：npm 出現修補版時失敗並通知維護者；目前沒有例外，保留為通用機制（見[相依套件稽核例外](security/audit-exceptions.md)）。
- 測試：單元測試 82 項、桌面 smoke 24 項（`apps/desktop/tests/desktop-smoke/update-check.spec.ts`）。
- CI：PR #375 的 23 項必要檢查全部通過（commit c8efde0）。Windows 11 與 macOS 實機驗收為**待實機驗收**。

沒有 schema 變更（33），沒有 migration。詳見 [1.6.53 更新說明](releases/1.6.53.md)。

## 1.6.52（已完成，已合併）

v1.6.52 一併發布 1.6.51 的全部變更（1.6.51 沒有單獨發布）。資料庫升級、還原與多程序寫入的驗證：

- migration 前備份與 N→N+1 樣本升級測試（DT-32）：三份真實舊版（v1.6.8、v1.6.21、1.6.51）的樣本升級；以真實程序中斷 migration、備份與還原；桌面 smoke 確認 migration 開始後不回到舊服務。
- 還原前先驗證遷移後的副本：`quick_check` 與 `foreign_key_check` 通過才取代現行資料庫；失敗回傳 `RESTORE_VERIFY_FAILED`，現行資料庫不變。
- 多程序 WAL 寫入與 checkpoint 壓力測試（DT-07）：`pnpm test:sqlite-stress`，CI 在 Linux、Windows 與 macOS 執行；拋出的 `SQLITE_BUSY` 設門檻（寫入程序 ≤ max(5, 2%)，其他角色 0）；必要檢查增為 23 項。
- 相依套件稽核例外：經使用者核准，只忽略 GHSA-fc5q-39xc-vjpf（picomatch ≤ 4.0.7，只在建置時使用，目前沒有修補版）；`scripts/check-audit-ignores.mjs` 在例外過時時失敗。1.6.53 已移除。詳見 [相依套件稽核例外](security/audit-exceptions.md)。

CI：PR #374 的 23 項必要檢查全部通過（commit 6916e49）。Windows 11 與 macOS 實機驗收尚未進行。

詳見 [1.6.52 更新說明](releases/1.6.52.md)。

## 1.6.51（已完成，隨 v1.6.52 發布）

桌面版換連接埠與檔案系統風險政策：

- 在 App 內變更連接埠（DT-14）：修復視窗與工作列的「連接埠」設定（1.6.55 起只在「設定」分頁，工作列已無此項）；Web 狀態頁只請 App 開啟該區段。App 先驗證，停止服務、在新連接埠啟動並驗證，成功後才寫入設定；失敗回到舊連接埠。新位址的 Dashboard 只還原白名單內的偏好與路由。
- 檔案系統風險政策（DT-08）：啟動與選擇資料庫時判定資料庫位置。網路磁碟不能作為 App 的資料庫；可移除、雲端同步與硬連結的位置不提供一鍵沿用、不自動更新 schema，可「複製到本機磁碟並改用」（原檔不變）；無法判定時只阻擋一鍵選擇。

CI 20/20 通過（PR #373，a4b212c）。Windows 11 與 macOS 實機驗收尚未進行。

沒有 schema 變更（33），沒有 migration。詳見 [1.6.51 更新說明](releases/1.6.51.md)。

## 1.6.50（已完成）

桌面版階段 4 的舊服務處理與 Agent 接管收尾：

- 在 App 內一鍵「停用舊的登入服務」：只處理辨識得出的定義，先預覽，再以系統對話框確認，只動預覽過的那一份；先證明服務已停下才移除設定；停用後先以唯讀 `quick_check` 檢查 App 的資料庫；只在手動開啟、後端沒有在執行時提供「立即啟動」，不會自行啟動。
- Windows 停止舊服務時只結束這個 checkout 的 runner 程序樹，並等其中每個程序都結束（DT-13）。
- 「改由桌面 App 管理」只接管使用 App 資料庫的 checkout 項目；其他資料庫改為提供「改用這份資料庫」。

沒有 schema 變更（33），沒有 migration。詳見 [1.6.50 更新說明](releases/1.6.50.md)。

## 1.6.49（已完成）

桌面版階段 4 的第二部分：

- 首次執行頁（DT-01）：只在全新安裝時顯示；第一個畫面就有「使用預設設定開始」。由 1.6.47、1.6.48 升級的安裝不會看到。
- 在 App 內設定 Agent：預覽差異、只套用預覽過的計畫、測試連線、復原。
- 「改由桌面 App 管理」：把 checkout 的 Agent 設定改由 App 管理，先預覽，可復原。
- Web 狀態頁的「在桌面 App 設定 Agent」：只在由桌面 App 管理時出現。
- 固定 launcher 讓 Agent 使用 App 的資料庫（ADR-39）。
- 以唯讀方式偵測舊的登入服務（`pnpm bootstrap`）：顯示警告與移除指令。服務正在執行時，同一個資料庫要按「仍要啟動」才啟動；服務只是會在登入時啟動時，登入時的背景啟動不啟動後端，由工作列提供「仍要啟動」。一鍵停用在 1.6.50 提供。
- 效能（CI）：首次執行頁第一次繪製 Windows 210 ms、macOS 104 ms；每次 hook 讀取 App 設定的中位數 Windows 0.08 ms、macOS 0.073 ms（預算 5 ms）。

PR #371 的 20 項 CI 檢查全部通過。沒有 schema 變更（33），沒有 migration。詳見 [1.6.49 更新說明](releases/1.6.49.md)。

## 1.6.48（已完成）

桌面版階段 4 的大型傳輸部分：專案資料匯入、預覽與匯出改由背景子行程串流處理（記憶體不隨檔案大小增加，子行程記憶體不足只結束子行程，後端繼續運作）；匯入上限由 50 MiB 提高到 256 MiB（可用磁碟需為檔案 2.5 倍）；Web UI 改為把原始檔案上傳到伺服器暫存（`/api/import/staged`），瀏覽器不再解析檔案；桌面 App 圖示與 WI 品牌標誌一致，修復成功後顯示回饋並開啟 Dashboard 一次。新增傳輸記憶體效能門檻，並在桌面 smoke 的三個 OS 執行。CI 結果待 PR 檢查完成後補上。沒有 schema 變更（33），沒有 migration。詳見 [1.6.48 更新說明](releases/1.6.48.md)。1.6.47 的已知風險（Node 24 上 worker heap 耗盡可能結束後端）已修正。

## 1.6.47（已完成）

桌面版階段 3（Agent 整合）的 CI 可驗證部分：Agent 寫入共用 API（`packages/agent-setup`，DT-21，含指紋重驗、操作日誌與補償）、MCP stdio 握手探測與狀態分級（DT-22）、固定 launcher 接線（plugin、MCPB 與獨立版，DT-23 後續）、Dashboard bridge（DT-27），以及 Windows ACL 預熱。階段 3 的 gate 尚未通過：真實 host 的 handshake、Windows 與 macOS 的行為待 CI 或實機確認；App 設定中心尚未接上 Agent API。CI 結果：PR [#369](https://github.com/Ponpon55837/WorkLog.Ai/pull/369) 合併前最後一個 head 的 20 項檢查全部通過：[Desktop package](https://github.com/Ponpon55837/WorkLog.Ai/actions/runs/44038144921)、[Desktop smoke](https://github.com/Ponpon55837/WorkLog.Ai/actions/runs/44038145033)、[Desktop runtime spike](https://github.com/Ponpon55837/WorkLog.Ai/actions/runs/44038144908)、[CI](https://github.com/Ponpon55837/WorkLog.Ai/actions/runs/44038144926)；合併到 main 後的 [CI](https://github.com/Ponpon55837/WorkLog.Ai/actions/runs/44039318088) 也通過。Windows ACL 預熱：首次啟動 ACL 中位數在 CI Windows runner 上由 300 ms 降至 128–214 ms（非實機）。沒有 schema 變更（33），沒有 migration。詳見 [1.6.47 更新說明](releases/1.6.47.md)。已知風險：在 Node 24 上，背景 worker 的 heap 耗盡可能讓整個後端行程結束；已列入 1.6.48 處理。

## 1.6.46（已完成）

發行流程修正：1.6.45 的發行在建立 GitHub Release 前的安裝包名稱檢查失敗（合併下載的安裝包位於子資料夾），所以 1.6.45 只有 tag、沒有 Release。發行流程現在先攤平安裝包再檢查；`pnpm package:desktop -- --dir` 不再因 `--` 而失敗。桌面 App 內容與 1.6.45 相同。下一個階段（桌面版階段 3：Agent 整合）改為 1.6.47。沒有 schema 變更（33），沒有 migration。詳見 [1.6.46 更新說明](releases/1.6.46.md)。

## 1.6.45（已完成，未發行 Release）

桌面版階段 5 的打包部分：以 electron-builder 26.18.1 產出 Windows 11 x64 的 NSIS 一鍵安裝（目前使用者安裝）與 macOS 的 DMG、ZIP（arm64 與 x64 分開建置）。隨包官方 Node.js 24.22.3 在首次啟動時安裝到固定的 launcher root，並以完整雜湊對照內嵌 manifest；Windows ACL 檢查由未實作改為已實作（兩層讀取，fixture 驗證，真實 Windows 行為待 CI）；新增 `--quit` 供安裝程式使用，解除安裝保留資料庫與備份；新增 `desktop-package` CI 與打包後的黑箱煙霧測試。本版沒有自動更新、Developer ID 簽章與公證：Windows 安裝包未簽章，macOS 只做 ad-hoc 簽章，安裝包會出現 SmartScreen 與 Gatekeeper 警告。新增原創應用程式圖示。打包後的 App 閒置記憶體（Linux）PSS 由 352 MiB 降到 292 MiB；匯出效能門檻收緊為 360 ms（量到回應最後一個位元組）；伺服器關閉與備份 worker 的行為調整。打包只在 Linux 本機驗證；Windows 與 macOS 的安裝、CI 數字與實機驗收尚未取得，階段 5 的 gate 尚未通過。沒有 schema 變更（33），沒有 migration。詳見 [1.6.45 更新說明](releases/1.6.45.md)。

## 1.6.44（已完成）

桌面版階段 2（安全最小桌面）的 CI 可驗證部分：Electron 殼（單例、tray／選單列、修復視窗、退出流程）與後端子程序生命週期（DT-11）。子程序以私有 IPC 回報身分，HTTP 就緒以 HMAC 證明；停止順序為 IPC shutdown、POSIX 的 SIGTERM、kill，最後確認 port 釋放。新增 desktop-smoke CI，涵蓋 Windows、macOS 與 Ubuntu（xvfb）。Windows 11 與 macOS 實機驗收未做，三平台 desktop-smoke CI 已通過，階段 2 的 gate 尚未通過；簽章、公證、安裝包、自動更新、完整的來源偵測精靈與完整診斷尚未實作。沒有 schema 變更（33），沒有 migration。詳見 [1.6.44 更新說明](releases/1.6.44.md)。

## 1.6.43（已完成）

桌面版階段 1（runtime spike）的 CI 可驗證部分：比較隨包官方 Node.js 與 Electron 以 Node 模式執行兩種封裝，依量測與安全評估選定隨包官方 Node.js（ADR-04）；新增固定 launcher 與版本化 runtime manifest（DT-23），以及無 Node、離線的煙霧測試與 CI workflow（DT-25）。三平台 CI 量測與檢查全數通過，實機驗收未做，階段 1 的 gate 尚未通過；Windows ACL 檢查、runtime 清理與 Agent 設定接線尚未實作。沒有 schema 變更（33），沒有 migration。詳見 [1.6.43 更新說明](releases/1.6.43.md)。

## 1.6.42（已完成）

桌面版階段 0（契約與測試基座）的 CI 可驗證部分：新增純 TypeScript 套件 `packages/desktop-core`（設定、DB 來源、ServiceOwner 狀態機與操作協調）；DB 身分策略定案為檔案身分加唯讀血統指紋（ADR-36）；啟動前唯讀 preflight 與提交前重驗；舊寫入端實驗（MCP、HTTP、長駐 Store）的結論是方案 1 為主要屏障、方案 2 仍需實作；測試不再觸碰真實家目錄與 3210；備份與匯出 worker 冷啟變快。沒有 schema 變更（33），沒有 migration。實機驗收（Windows 11 與 macOS）、Codex 與 Claude Code plugin、MCPB 與手動 stdio 的組合尚未驗證。桌面設計索引同步更新（見 [desktop 設計索引](desktop/README.md)）。詳見 [1.6.42 更新說明](releases/1.6.42.md)。

## 1.6.41（已完成）

所有 SQLite 寫入交易都檢查 schema 版本（REST 回 503 `server_restart_required`）、Host 檢查加上 port、回報內建 SQLite 是否含 WAL-reset 修補、Windows 改用現代資料夾選擇視窗；沒有 schema 變更。桌面版設計修訂為 R4（見 [desktop 設計索引](desktop/README.md)）。詳見 [1.6.41 更新說明](releases/1.6.41.md)。

## 1.6.40（已完成）

只更新相依套件，沒有行為或 schema 變更：`vue-router` 5.5.0、`vite` 6.4.6（修補 vue-router 5 帶進正式環境依賴的高風險漏洞）、`pinia` 4.1.0、`@vitejs/plugin-vue` 6、`tsx` 4.23.15、`prettier` 3.10（重新格式化 5 個 Vue 範本）、`@types/node` 24。詳見 [1.6.40 更新說明](releases/1.6.40.md)。

## 1.6.39（已完成）

Knowledge 的可能過時判斷不再因大範圍改動單獨觸發：超過 20 檔的後續 Session 改計入 `broadChangesSince`，`possiblyStale` 附上 `reason` 與 `appliesToBreadth`，寫入太寬的 appliesTo 時提示；檢索回報 `knowledgeConfidence`、`knowledgeHint` 與 `matchedVia`，並修正 `termHits` 誤報與格式錯誤的 `changed_files_json`；Web 以次要文字顯示較弱的訊號。新增可行性研究與探針（`docs/experiments`）。沒有 schema 變更（33），沒有 migration；`possiblyStale` 會變少，MCP 回應多了可選欄位，Agent 需重新連線。驗證：format、lint、typecheck、全部單元測試與 coverage、build、performance gate、retrieval quality、response size、三種瀏覽器的 E2E（120 項）與 start smoke 皆通過；真實資料前後比較（私有副本，只回彙總數字）：`possiblyStale` 由 21 則降為 5 則，另 16 則只回報 `broadChangesSince`。見[更新說明](releases/1.6.39.md)。

## 1.6.38（已完成）

工作圖譜時間軸上 Knowledge 被確認的記號改回綠色菱形，圖例把被確認與被取代分開列出；被取代維持空心菱形，被推翻維持叉號。沒有 schema 變更（33），沒有 storage、server 或 MCP 行為變更。見[更新說明](releases/1.6.38.md)。

## 1.6.37（已完成）

修正工作圖譜時間軸的顏色：1.6.36 把長條改成灰色，使驗證通過與未執行無法分辨；本版恢復依驗證結果上色（通過綠、失敗紅、進行中藍、未執行或未提供灰），圖例恢復四種結果。週末底色、固定專案名稱欄與 Knowledge 事件形狀保留。沒有 schema 變更（33），沒有 storage、server 或 MCP 行為變更。見[更新說明](releases/1.6.37.md)。

## 1.6.36（已完成）

Web UI 外觀改版：沿用現有藍色並精修 tokens，拿掉英文大寫小標，重新排版總覽（本週的循環與八週走勢）、工作歷程（時間軸與整日小結）、工作知識（信任條與類型分布）、工作圖譜時間軸與工作報告；專案、系統狀態與 Session 面板套用同一套外觀。共用側邊面板標題列、數字卡格線、雙欄版型與連結按鈕，並修正未定義的 `--fg-attention` 與低於 12px 的圖譜字級。版面行為不變。沒有 schema 變更（33），沒有 storage、server 或 MCP 行為變更，也不需要 migration。驗證：format、lint、typecheck、build、全部單元測試與 coverage、三種瀏覽器的 E2E 與 start smoke 皆通過；版面行為對照三種視窗沒有行為退步；README 截圖已用虛構示意資料重拍。未驗證：對比只經過 axe 檢查；英文版截圖中有兩句 server 端產生的中文。沒做的項目包括沒有資料的數字（引用過去知識的次數、未回報次數）與屬於行為變更的項目。見[更新說明](releases/1.6.36.md)。

## 1.6.35（已完成）

依 axe-core 4.14 的 `label-content-name-mismatch`（WCAG 2.5.3）修正無障礙名稱：架構圖、標題列、圖形畫布、Knowledge、未結項、日曆與表單控制項的名稱改由可見文字產生，並新增 `tests/e2e/accessibility-states.spec.ts`，以 axe 檢查對話框、選單與行動版側欄（zh-TW 與 en-US）。共用計時 helper 讓固定毫秒上限隨同行程的參考工作量放大，時間相關測試更穩定；門檻沒有放寬。沒有 schema 變更（33），也不需要 migration。依賴：`@axe-core/playwright` 4.14.0 與 `smol-toml` 1.9.1（本分支），其餘已合併到 main。未驗證：發行前的完整驗證指令尚未執行。見[更新說明](releases/1.6.35.md)。

## 1.6.34（已完成）

依虛構語料與彙總計數的量測，沒有 schema 變更（33），也不需要 migration。安全性：新建的資料夾為 0700、資料庫檔案為 0600（POSIX），既有且群組或其他人可存取的資料庫、`-wal`、`-shm` 於開啟時收緊為 0600，`pnpm check` 對仍寬鬆的資料夾發出警告；秘密遮蔽在虛構語料上由 29／113 提升為 113／113，45 筆無關字串不變。匯入拒絕巢狀超過 100 層的 `*_json`，並且不再覆寫其他專案擁有的同 ID 資料。交接解析改為線性，200,000 字元上限下 57 種對抗形狀皆低於 200 毫秒；FIFO、socket 與裝置等特殊檔案不再被讀取。伺服器指引與讀取指南明載記錄內容為不可信資料。CI action 固定到 commit 並新增 Dependabot；發行 workflow 新增 `workflow_dispatch` 手動觸發。未驗證：Windows、真實 Agent 用戶端的新指引、GitHub 上的手動發行（尚未執行）。見[更新說明](releases/1.6.34.md)。

## 1.6.33（已完成）

依真實使用資料副本（6 個專案、650 筆 Session）的量測，沒有 schema 變更（33）。變更狀態：Agent 在 `changedFiles` 列出的路徑沒有 `changedFileChanges` 時，保存會向 Git 查詢補上並標示 `changedFileChangesSource`，仍缺的以 `changedFileChangesFollowUp` 請 Agent 補回；真實資料中 3,312 個檔案的 Git 狀態與 Agent 回報有 99.6% 一致，211 個缺漏路徑都能補上。只帶 `task` 的 `work_get_context` 會依相似 Session 改過的檔案提供最多 3 筆 `inferred_path` 指標（至少兩筆相似 Session 支持）；回放中因任務本身而顯示的 Knowledge 配對由 11 組增加到 60 組，推論指標 71% 是預定的 Knowledge，原本顯示的內容沒有遺失。Knowledge 頁可用 `query` 或 `headings` 聚焦讀取；搜尋零結果時回應附 `otherStatusFullMatches`、`effectiveQuery` 與 `queryTruncated`。修正：`db:export --help` 不再寫出快照，CLI 在執行前檢查選項；匯入的專案根目錄以規範化 key 儲存；linked worktree 與 packed refs 的分支與 HEAD 可讀取；保存 hook 忽略失敗的編輯，並以最深的 tracked 根目錄判斷。新增 `pnpm test:start-smoke`。Claude Code 的變更狀態流程以真實 `claude` CLI 驗證四個情境；Codex 與 Windows 未實測。見[更新說明](releases/1.6.33.md)。

## 1.6.32（已完成）

依真實使用資料副本（6 個專案、647 筆 Session）的量測，補上「有效沉澱 → 精準再利用 → 持續修正」實際漏掉的四處，沒有 schema 變更（33）。開始時間：Claude Code 保存前以 PreToolUse hook 告知、Codex 在第一則訊息告知，Agent 仍省略時改用伺服器觀察到的第一次工具呼叫時間並標示 `startedAtSource`，仍沒有時回條附 `startedAtFollowUp`；`work_update_session_metadata` 可省略 `changedFiles`、可用 `completedAtNow`。再利用：`work_get_context`／`work_recall` 帶 `paths` 時比對 Knowledge 的 `appliesTo`，真實資料回放 337 次機會的完整提供率由 3.3% 提高到 67.1%，回應長度變化不到 0.5%。沉澱：Knowledge 候選改依已確認決策、驗證失敗後修復、後續連結與刻意重讀挑選，並以 `pendingRequests.knowledgeBacklog` 顯示未整理數。修正：未結項在同一筆 Session 改寫時保留身分，`work_resolve_outstanding_items` 讓後續 Session 在保存前後附依據結案，`closedBy` 區分結案來源，`work_request_outstanding_cleanup` 讓 Agent 依使用者要求建立整理請求；歷史回放顯示使用者手動結案的 785 筆中 75% 會被列給 Agent。兩個 PreToolUse hook 只有單元測試，未在真實用戶端實測；Agent 是否照新指引結案與帶路徑，要在使用後以 `docs/experiments/` 的兩支腳本量測。見[更新說明](releases/1.6.32.md)。

## 1.6.31（已完成）

`work_get_session` 的精準讀取（`view`／`select`）改為只回傳文字 content，不附 `structuredContent`。先前本體只在文字裡，`structuredContent` 只有識別與狀態欄位；在兩者並存時只把 `structuredContent` 交給模型的用戶端（已在 Claude 桌面版的 Code 分頁觀察到），Agent 讀不到 summary、workSummary、decisions、files 與 links，而 1.6.18 起 `view: "handoff"` 是預設讀法，結果是每次都要再做一次完整讀取。現在每個用戶端都拿得到本體，而且仍只送一次。完整讀取、`session_unchanged`、finalize 與 Session 更新回條不變。其他用戶端（終端機版 Claude Code、Codex、Claude Desktop 擴充）的行為沒有驗證。schema 維持 33。

## 1.6.30（已完成）

匯入前快照只在匯入真的會新增、更新或重新編號資料時才寫入：先在讀取快照上計算計畫，再在寫入交易之前寫入並檢查快照，寫不出仍不匯入。資料都已存在的匯入與計畫階段就失敗的匯入不再寫快照，也就不會擠掉先前真正改過資料的匯入快照；結果新增 `changed`（沒有變更時為 `false`、不帶 `backupFileName`），CLI 與 Web 會說明資料沒有變更。計畫後到取得寫入鎖之間資料改變、重新計算後變成要寫入時，匯入不寫任何東西就釋放鎖，建立快照後再試一次（最多兩次）。`work_recall` 回傳的 Knowledge 會排在自己來源 Session（同一專案）的正上方，只調整已選出的 hits 順序，不改分數、confidence 與回傳的記錄：真實資料複本上 18 題答案為有效 Knowledge 的查詢，排第一由 9 題增為 17 題，原本正確的 9 題都維持；56 題中 11 題順序改變，全部只因這條規則。`pnpm test:retrieval-quality` 五類指標不變。schema 維持 33。仍未做：沒有可重現的方法在指定時點終止背景 worker，所以「worker 在匯入中途被終止時資料庫不變、鎖釋放、快照保留」仍只由程式推論，沒有測試。詳見 [1.6.30 更新說明](releases/1.6.30.md)。

## 1.6.29（已完成）

可攜式匯入不再可能傷到使用者資料，也不再卡住 API。確認匯入前先寫入並檢查 `pre-import-` 快照（獨立保留，份數同自動備份），寫不出就不匯入並回 503 `project_backup_failed`；中途失敗時資料庫不變、快照保留，預覽不寫任何東西。所屬專案、Session、報告請求或原始版本不在檔案裡的列改以 `missing_parent` 計入衝突並在 Web 預覽顯示，匯入的列與先前相同（5,000 個 Session 缺一個專案時 4,999 個照常匯入，另一個不再默默消失）。`POST /api/import` 改由背景 worker 解析、驗證、備份、計畫、寫入並同步索引：匯入 5,000／20,000 個 Session 時 `/api/health` 最慢由 1,453／5,574 ms 降為 7／13 ms；計畫在讀取快照上計算，寫入交易以 `data_revision` 確認計畫仍然有效，寫入鎖由 670／2,440 ms 降為約 330／1,290 ms（之後的索引同步交易約 420 ms／1.7 秒不變）。匯入檔只驗證一次（以只有驗證能建立的 `ValidatedProjectDataImport` 傳遞，測試把每一類無效檔案送進每條路徑）：預覽 5,000／20,000 個 Session 快 45–60%，峰值 RSS 低 12–24%。匯出的遮蔽先找必要字面再跑規則，匯出 bytes 不變，`exportProjectData` 門檻 p90 334 → 245–300 ms。實測過時判斷讀入上限在 1,000 字元路徑下為 1.6 秒、330 MB，並補上解析上限的回歸測試。schema 維持 33。仍未做：索引同步仍是單一交易；一頁 50 筆各 6 個長目錄項目在 20 萬個不同路徑上會用完解析上限。詳見 [1.6.29 更新說明](releases/1.6.29.md)。

## 1.6.28（已完成）

1.6.27 的發行審查因 Knowledge 過時判斷比 1.6.14 慢且沒有上限而不建議發行。過時判斷改為每次呼叫、每個專案建一次「之後改過的不同路徑」索引（每個路徑正規化一次、依路徑段歸檔），每個 `appliesTo` 項目每次呼叫只解析一次、只測試可能符合的路徑，結果與逐一比對相同；審查的 2,000 個 Session × 50 個不同路徑資料一頁 20 筆由 2.97 秒（1.6.14 0.96 秒）降為 0.19 秒，5,000 個 Session 0.49 秒。恢復兩個每次呼叫的固定上限（讀入索引 22 億單位，最大合法歷史用 7.1 億，到上限最多約 2.4 秒；解析項目 5,000 萬單位，一般約 100 萬），15 星號 glob 在上限停止並標 `stalenessUnchecked`。列表搜尋恢復短路求值、Session 事件只在需要時加總一次：寫入上限大小的 Knowledge 757 → 98 ms，Session 三詞 23 → 11 ms（1.6.14 為 75 與 5.6 ms）。真實資料複本 406 個過時相關結果、220 個序列化結果、206 個列表查詢與合成資料 44 個查詢都與先前相同，另有隨機差分測試。schema 維持 33。仍未做：讀入歷史本身仍與歷史大小成正比；列表搜尋仍比 1.6.14 慢（每詞的單筆檢查與 `appliesTo` 欄位）。詳見 [1.6.28 更新說明](releases/1.6.28.md)。

## 1.6.27（已完成）

儲存文字上的有界工作改由盤點驅動：列出所有 MCP／REST 觸發、工作量隨儲存文字長度或呼叫端詞與路徑成長的路徑（精簡表在 [architecture.md](architecture.md)），限制的是「每一筆」的成本，而不是用固定總量截斷合法資料。Knowledge／Session 列表搜尋改用 `instr()`（結果相同），最多 8 個詞、每詞 200 字元，超過單筆上限（256 KiB／4 MiB，高於寫入上限）的記錄不讀並回 `warnings`、`searchSkippedRecords`，Web 列表顯示提示；8 個近似詞的最壞情況由 15.7 秒（200 筆）降為 250 ms，成本隨筆數線性。recall 路徑比對同樣改用 `instr()`。`knowledgeToReview` 所有候選共用一次 Session 掃描（2.9 秒 → 19–23 ms，結果相同），過時判斷逐筆讀取，兩者的預算隨讀到的歷史成長（每筆先授予三倍一般成本），合法資料不會被截斷；相關未結項先計費再評分（2.1 秒 → 156 ms）。在 20,000 個合成 Session、2,000 筆 Knowledge 上一般輸入沒有任何截斷或警告，有固定總量的路徑最多用掉 20%。超過讀入上限的 `appliesTo` 與變更檔案清單在 SQL 端就不載入；JSON 解析改計每字元 4 單位。真實資料複本上 206 個列表查詢、319 個 Session 的 `knowledgeToReview`、220 個序列化結果，以及 5,000 個合成 Session 上的 44 個列表查詢都與先前相同。效能門檻的備份／匯出案例改讀種子後的資料庫複本。升級說明補上從 1.6.8（schema 31）升級時要一併閱讀 1.6.9–1.6.14。schema 維持 33。仍未做：與合法歷史成正比的讀取（metadata backfill 預覽、圖譜、時間軸、熱點）沒有另設預算；Web 不顯示 `stalenessUnchecked` 等截斷標示。詳見 [1.6.27 更新說明](releases/1.6.27.md)。

## 1.6.26（已完成）

appliesTo 比對預算成為實際工作量的上限。每項成本隨儲存項目或呼叫端路徑長度增加的工作（解析與正規化儲存清單、編譯、每組固定成本、開頭／結尾比較、字面片段搜尋、模擬比對）都在執行前以字元操作扣除；字面片段搜尋改用 KMP，每個路徑字元最多比較兩次。性質測試以 140 組上限內的惡意組合與除錯比較計數器，檢查實際比較數不超過已扣單位、預算用完即停。預算依時間目標訂為每次呼叫 20,000,000 單位（開發機約 75–90 ms，實際資料最重 1.5%），staleness 檢查 50,000,000（約 200 ms，實際資料 7%）；近似重複字面片段的情境由約 50 秒改為 75–110 ms 即停。比對只看前 30 項、每項 1,000 字元以內，超過的照原樣顯示但不解析並標示掃描不完整；匯入只拒絕超過 100 筆或 4,096 字元的 `applies_to_json`（比寫入限制寬，因為遮蔽憑證會讓項目變長），實際匯出檔、遮蔽後變長的項目與 schema 31／32 fixture 照常匯入。路徑正規化移除兩個平方時間的正規表示式；未知欄位訊息有長度上限，匯出 body 改用嚴格解析。`commitSha` 改存小寫並也找得到大寫保存的 sha。schema 維持 33。仍未做：staleness 載入後續 Session 的成本隨歷史增加而未計入預算。詳見 [1.6.26 更新說明](releases/1.6.26.md)。

## 1.6.25（已完成）

失敗時說實話、能自行恢復。資料庫已是最新 schema 時開啟只讀取，不需要寫入鎖：另一個行程持有寫入鎖 9 秒時，MCP 由 5.3 秒後回報「migration 失敗、請從備份還原」且之後一直如此，改為 0.3 秒啟動並可讀取；待 migration 時回傳 `DATABASE_BUSY`、不先寫備份，下一次 tool 呼叫再試。唯讀與磁碟已滿有各自代碼（MCP `DATABASE_READ_ONLY`／`DATABASE_DISK_FULL`，REST `database_read_only` 503／`database_disk_full` 507）與 Web 訊息，唯讀時讀取照常。REST 所有 body 與整組送進 schema 的查詢拒絕未知欄位並點名。列表載入失敗時只顯示錯誤，不再同時顯示「還沒有工作紀錄」。MCP 與 REST 文件補齊並加上一致性測試；正式相依套件稽核清空。`db:maintain` 對非 SQLite 檔案回報無效而非使用中，handoff 預覽不再顯示檔案系統訊息與絕對路徑。schema 維持 33。仍未做：只讀取指定名稱的 GET 查詢參數不拒絕其他參數、MCP 未分類錯誤仍由 SDK 回傳原文。詳見 [1.6.25 更新說明](releases/1.6.25.md)。

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
