# WorkLog.Ai 健康檢查與報告寫作技能評估

- 檢查日期：2026-10-11（Asia/Taipei）。
- 檢查基準：`main`，commit `6c4094c7ca8fa3d83fec0b4bc84cce8fe07ee348`，應用 1.5.0、資料庫 schema 30。
- 開始時工作目錄乾淨。本次交付為檢查報告，未修正應用程式、安裝技能或改寫既有工作資料。
- 方法：程式抽查、既有測試、隔離合成案例、已連線 MCP 操作，以及正式資料的唯讀 UI 閱讀。

## 判斷

目前的建置、型別、資料庫完整性與正式 API 有可靠的驗證基礎。資料政策、來源引用、驗證狀態、可回復的審閱流程及中英介面已有一致設計。健康檢查仍重現報告來源選取缺陷，也發現報告讀取成本、來源涵蓋範圍說明與文字編排需要改善。既有測試通過不代表這些邊界已被涵蓋。

建議加入共用報告寫作技能，內含英文及繁體中文規則。英文採用 ASD-STE100 的清楚寫作原則；繁體中文另訂簡明技術寫作規則。正式 STE 合規與一般報告可讀性應分開評估。優先處理資料來源與涵蓋範圍，再處理去重和語句，避免用較流暢的文字掩蓋來源缺口。

## 驗證結果

| 檢查 | 結果與界線 |
| --- | --- |
| `pnpm build` | 通過。入口 JS 501.72 kB，gzip 163.87 kB；Vite 有超過 500 kB 警告。 |
| `pnpm test` | 通過：880 項、1 項既有略過；包含 lint、format 與八個 package 的單元／整合測試。 |
| `pnpm typecheck` | 通過，包含 E2E 型別檢查。 |
| `pnpm test:coverage` | 獨立重跑通過八個 package 的測試與設定門檻。首輪 Storage 大型匯入案例超過 60 秒，詳見下方限制。 |
| `pnpm run test:performance` | 通過：5,000 筆合成 Session、44 條讀取路徑，各量測 15 次 p90。 |
| `pnpm test:retrieval-quality` | 通過：25 項合成檢索品質案例。 |
| `pnpm test:response-size` | 通過：9 項現有回應大小案例；目前不包含報告合成脈絡的完整序列化預算。 |
| `pnpm run test:recall-eval:example` | 通過，生成合成檢索評估結果。 |
| `pnpm test:e2e` | 首輪 Chromium 173 通過、1 逾時、1 既有略過；因此 wrapper 沒有繼續執行其他瀏覽器。逾時案例單獨重跑 1 通過；Firefox 獨立補跑 119 通過；WebKit 獨立補跑 116 通過。 |
| `pnpm audit --prod --audit-level low` 及 `pnpm audit --audit-level low` | 本次查詢 production 及包含開發相依的完整範圍，均未發現已知弱點。 |
| `pnpm run doctor` | 0 個錯誤、1 個提醒。資料庫 integrity_check 正常、約 10.1 MiB；API 正常、登入服務執行中；Agent skill 複本與 canonical 相同。提醒是沒有資料庫維護紀錄，不是完整性錯誤。 |

首輪沙箱內 HTTP 測試無法 `listen`；`tsx` doctor 的 IPC 亦遭 `EPERM`。在允許本機監聽的環境重跑後，單元／整合測試與正式 API 診斷通過，故未將這些限制列為程式缺陷。誤用 `pnpm doctor` 曾執行套件管理器自身的診斷；本報告只採用 `pnpm run doctor` 的專案診斷。README 已正確說明兩者差異。

覆蓋率首輪與 E2E 同時執行。大型匯入本身為 19,171.9 ms，符合 20 秒匯入門檻，但含合成資料準備的整個案例花費 62,731 ms，超過 60 秒測試 timeout。獨立重跑通過；資源競爭是合理的解釋，但未進一步證明逾時根因。

Chromium 首輪逾時發生於 960 px 繁體中文淺色總覽案例，trace 顯示可及性掃描中兩次執行分別耗時約 11.1 秒及 4.9 秒，沒有得到斷言不符的失敗。單獨以一個 worker 重跑在 6.8 秒內通過。這是需保留的測試穩定性觀察，不能只因重跑成功就宣稱首輪全部通過。

Firefox 和 WebKit 分別使用 `pnpm exec playwright test --project=firefox --workers=4` 與 `pnpm exec playwright test --project=webkit --workers=4` 補跑，彼此沒有同時執行；各自依專案設定執行跨瀏覽器／可及性案例。Chromium 只重跑原逾時案例，沒有再次執行完整 wrapper。

## 需要處理的發現

P1 表示可能使主要工作流失去必要來源；P2 表示影響準確理解、讀取成本或使用流程；P3 表示非阻斷的診斷／維護改善。以下區分實測與靜態分析。

### P1：報告請求來源會被後來的 Session 擠出

位置：[報告合成來源選取](../packages/storage/src/report-synthesis-service.ts#L643)、[報告最新 200 筆視窗](../packages/storage/src/report-service.ts#L178)。

服務先重建目前期間的最新 200 筆 Session，再用請求保存的來源 ID 過濾。原請求的來源若已不在最新視窗中，尚未作廢且仍屬於 tracked 專案，也會消失。

在記憶體資料庫重現：同一天先寫入 3 筆來源並建立整理請求，再加入 205 筆較晚完成的 Session。

```json
{
  "requestSources": 3,
  "returnedSessions": 0,
  "returnedSources": 0,
  "truncation": { "sessions": false, "evidence": true, "handoffCharacters": false },
  "reportSessionTruncation": { "currentPeriod": true, "previousPeriod": false },
  "reportTotal": 208
}
```

期間截斷旗標仍為 true，因此不能說回應完全沒有警示；缺陷是請求來源變成空集，而且 `truncation.sessions` 只比較過濾後的可用數量，無法呈現原請求來源損失。Agent 以完整讀取補查仍可找回個別 Session，但合成脈絡不再提供它們。

建議直接依請求來源 ID 讀取，並分開回傳 requested、eligible、returned、unavailable 與 budget-omitted 數量及原因。新增「請求建立後新增 Session」、「來源作廢／暫停」、「期間超過 200 筆」回歸案例。現在新建立的 208 筆期間請求本身也只保存 200 個來源 ID；若產品要完整月／季／年整理，需要可分頁的來源契約。

### P2：報告脈絡只有筆數限制，沒有完整回應大小預算

位置：[報告回傳](../packages/storage/src/report-service.ts#L440)、[合成脈絡組裝](../packages/storage/src/report-synthesis-service.ts#L696)、[現有大小測試](../tests/mcp/response-size.test.ts#L31)。

實際 MCP 讀取本專案 2026-10-05 至 2026-10-11 的週報，35 筆 Session、預設 20 筆 Evidence，緊湊 JSON 為 **267,212 字元**。其中 `sessions` 為 194,990 字元，`completedWork` 為 53,693 字元；完成事項再次攜帶部分完整 Session。這是工具文字內容長度，不是 host 注入或帳戶 token 計費。

合成脈絡又同時保存 `report.sessions` 與頂層 `sessions`。100 筆極短合成來源、1 筆 Evidence、無 handoff 的隔離案例仍為 **182,409 字元**，兩份 Session 陣列完全相同。`maxHandoffCharacters` 只限制 handoff，不能限制其他內容。

建議為 Agent 報告讀取提供精簡投影與完整序列化預算，刪除重複內容，以可分頁來源指標取得必要全文。保留 deterministic 全期間統計，不能為了縮小 payload 改用截斷清單計數。加入報告與合成脈絡大小門檻，量測整個任務含契約、補讀與重試的成本。

### P2：來源、統計與證據的不同範圍缺少明確說明

位置：[Evidence 分頁重建](../packages/storage/src/report-synthesis-service.ts#L694)、[整理顯示](../apps/web/src/components/domain/SynthesisPresentation.vue#L106)。

合成回應將 Evidence page info 重設為已選來源的本地數量，但頂層 `truncation.evidence` 仍比較目前全期間的 Evidence 數量。兩個值可能都正確，卻使用不同分母。Agent 若沒有範圍資訊，容易把它們解讀為互相矛盾。

正式 UI 抽查 2026-09-21 至 2026-09-27 的既有整理版本：摘要使用 52 筆來源，文字記載當時全期間 53 筆統計；現在頁面即時計數已為 141 筆。這不證明原報告數字錯誤，因為歷史整理與目前統計有不同時間點。版本日期和來源數在頁尾，但首屏沒有明確的涵蓋範圍提示。

建議先定義請求快照、目前全期間與本次選取來源三種口徑，明確標示時間點、各自的分母與省略原因。UI 在整理摘要上方顯示整理時間和涵蓋範圍；若新資料或來源修改使整理過期，顯示可理解的提示。不要把 count 差異自動當成資料錯誤，也不要讓 Agent 猜測差異原因。

### P2：報告內容重複，技術診斷占據摘要首屏

位置：[報告寫作契約](../apps/mcp/src/contracts.ts#L18)、[正式格式文件](work-record-and-report-format.md)、[整理段落顯示](../apps/web/src/components/domain/SynthesisPresentation.vue)。

同一個歷史週報中，「52／53 筆來源差異」與 Evidence 完整度的說明反覆出現在 executive summary、verification、comparison、risks。摘要含 `truncation`、`evidence=true`、`truncated=false` 等內部欄位名稱。375 px 實際首屏大部分用來呈現這段診斷，讀者尚未看見主題及成果。

本週 35 筆 Session 的五段摘要抽查，共有 193 個 verification 項目，其中 52 個超過 120 字元、18 個超過 200 字元，最大 270 字元。這是內容密度指標，不是中文可讀性的標準或違規判定；完整命令和驗證限制仍需保留。

建議寫作技能先訂定「成果摘要 → 依主題分組 → 一次說清楚限制 → 可追溯技術證據」的編排方式。同一事實有一個主要歸屬，其他段落只在必要時簡短引用。一般讀者先看影響，技術欄位、CI run、檔名和完整命令留在驗證或來源內容。

### P2：整理資料仍在載入時，也顯示沒有整理的空狀態

位置：[SynthesisCard.vue:125](../apps/web/src/components/domain/SynthesisCard.vue#L125)。

靜態分析：Skeleton 與 pending 區塊是兩個獨立 `v-if`。首次載入、`summary` 和 `request` 尚未取得時，兩者條件都成立，會同時呈現載入提示與「這份報告還沒有 AI 整理」。建立按鈕只以 `!report` 禁用，沒有等待整理查詢完成。

這項未另外模擬慢網路重現。建議以 loaded/error/loading 狀態建立互斥顯示，首次來源未知時停用建立動作，並增加延遲或失敗回應的 UI 案例。

### P3：正常 MCP 診斷仍建議重新連線

位置：[doctor.ts:693](../apps/server/src/doctor.ts#L693)。

兩次專案 doctor 都顯示「1 個可監測 MCP 連線均使用目前建置」，下方卻接著建議「尚無可監測的 MCP heartbeat」。程式的 recommendation 分支沒有先排除 `mcpRuntimeHealthy`。

建議健康狀態不回傳這條 recommendation，並涵蓋健康、沒有 heartbeat、版本相容更新與必須重連四種狀態。這是診斷文字錯誤，不是本次 MCP 連線故障。

## 其他工程觀察

- 目前 production audit 沒有已知弱點；這次不是完整滲透測試，也沒有逐一證明所有安全邊界。
- Web 首頁入口 bundle 略超過 500 kB。可先量測初次載入與解析成本，再考慮拆分；沒有實際延遲證據前，不建議大幅重寫依賴或單純調高警告門檻。
- Storage 覆蓋率門檻目前只計算 `handoff-parser.ts`。雖然所有 Storage 測試都會執行，報告合成服務沒有對應的覆蓋率門檻。建議優先補上述來源邊界案例，再逐步擴充高風險服務的 coverage 範圍。
- `store.ts` 約 1,976 行、報告合成服務約 999 行、MCP server 約 1,276 行。這是維護成本訊號，不是行數本身造成錯誤；若修正來源讀取，可將來源選取與涵蓋範圍計算獨立成易測單元，避免無目的的大規模重排。
- 知識頁歷史只顯示最近 50 版，舊版仍留在資料庫與匯出；目前沒有獨立版本清理機制。本次沒有資料庫容量異常，不能將此設計直接判為故障。
- 資料庫沒有維護紀錄，但完整性正常。本次沒有執行需停用服務／MCP 的 `db:maintain`。

## UI／UX 實際檢查

正式 UI 以唯讀方式檢查目前週報及既有週報整理，在 1440／960／375 px 閱讀。375 和 960 px 的頁面及 main 水平溢出均為 0；所檢查頁面的瀏覽器 error／warn 清單為空。手機選單、報告分頁、來源按鈕與段落編輯入口可辨識。合成回歸另以獨立資料庫驗證中英、深淺色、可及性及三種瀏覽器。

優先改善閱讀層次，無須整體視覺重設計：

1. 摘要先讓讀者知道做成哪些事，再指出重要限制。
2. 來源涵蓋範圍使用一個清楚區塊，不把同一個內部診斷分散至多個章節。
3. 長技術證據放在可追溯來源；摘要保留對結論有影響的驗證結果與界線。
4. 呈現歷史整理與目前統計的不同時間點，讓來源差異可理解。
5. 載入、空資料、來源失敗與已有歷史版本的狀態互斥，避免畫面給出尚未確認的結論。

## Agent 實際使用

本次透過四 dispatcher MCP 介面的 `work_read` 執行 scoped context、recall、完整／投影 Session 讀取與 deterministic report 讀取；收尾工作記錄使用指定的冪等寫入 dispatcher。operation 契約在首次使用前讀取；未知 operation 契約會被拒絕，沒有自動猜測寫入。

| 使用案例 | 實測 |
| --- | --- |
| scoped 工作 context | 確認專案 tracked；`restartRequired=false`、`updateAvailable=false`、`monitoringAvailable=true`。低信心查詢保留來源指標與省略資訊。 |
| 無關 recall | 唯一無關詞查詢回傳 `confidence=none`、空 hits，沒有提供猜測來源。 |
| 精準讀取 recall | 以「MCP 精準欄位讀取」及實際檔案路徑查詢，回傳 high 信心與對應規劃／實作／Knowledge 指標。只將結果當作指標，不將截斷文字當作完整證據。 |
| 同一筆 Session 的 completion 與完整讀取 | 2,227 vs 3,438 字元，completion 減少 35.2%；summary、outcomes、verification、verificationHistory、links 與完整讀取相同。這是一筆小型來源的結果，不能推廣為所有任務的 token 節省率。 |
| 預設週報讀取 | 267,212 字元；主要成本在完整來源及重複回傳。 |
| 合成報告來源視窗 | 記憶體資料庫重現請求來源被擠出，正式資料沒有為這個案例新增整理請求。 |

Agent 使用的基礎契約清楚，主要落差在「有界」報告讀取沒有整體字元預算、來源集合與目前期間重新計算混用，以及報告文字中的重複診斷。新增寫作技能應按需載入，不能把完整中英指南和字典灌入每一個工具契約，反而增加每次工作成本。

## ASD-STE100 與繁體中文技能評估

### 是否需要

**需要清楚寫作技能；不建議把所有工作報告設為正式 ASD-STE100 合規文件。** ASD 官方將 STE 定義為英文的受控技術寫作標準，包含寫作規則與受控字典；Issue 9 發布於 2025-01-15。官方說明允許專案技術名詞，也強調軟體與 AI 工具不能取代標準或寫作者的判斷。[官方介紹](https://www.asd-ste100.org/about_STE.html)、[官方工具說明](https://asd-ste100.org/STEsoftware.html)。

英文技術程序與故障排除適合更嚴格的 STE 寫法；成果、決策和限制等工作報告適合採清楚、簡短、一致的原則。中文可以借鑑這些原則，但應標示為本專案的繁體中文簡明寫作規則，不能把英文詞數和字典直接套成中文認證。

本次取得官方網頁及 Issue 9 PDF 的搜尋索引內容，直接開啟部分官方頁面和 PDF 時遭 403，沒有完成全文合規核對。相關英文詞數規則可由官方 PDF 索引確認，但本次不對任何文件作正式 STE 合規判定。[Issue 9 官方 PDF](https://www.asd-ste100.org/assets/files/ASD-STE100_ISSUE9.pdf)。

### 建議技能結構

一個共用 `worklog-report-writing` skill，按需讀取英文／繁體中文 references；不建立兩套獨立且互相重複的來源與報告規則。

| 層次 | 規則 |
| --- | --- |
| 共用資料語意 | 既有五段摘要和報告分組規則優先；保留來源 ID、驗證狀態、完整命令與數值；不得新增原因、效益、未來計畫或沒有證據的完成宣稱。 |
| 共用編排 | 明確讀者與用途；成果先行；按主題分組；同一事實主要呈現一次；限制集中說明；技術證據可追溯。 |
| 英文 | 採主動語態、明確主詞、一句一個主要觀念、術語一致。程序句與描述句分開處理；20／25 words 可用於相應的 STE 模式，正式合規仍需完整規則、字典及技術名詞管理。 |
| 繁體中文 | 用明確動詞；刪除「進行……之作業」等冗詞；拆開長串並列；以句號替代過多分號；中文標點一致；首次出現的非共通術語簡短解釋；保留 API key、命令、路徑與程式識別字。 |
| 長度與例外 | 長度作為警示而非自動刪除門檻。成果摘要與證據段落採不同密度；為追求短句而丟失條件、數值、失敗或未驗證範圍不可接受。 |
| 原始資料 | 只作用於新生成或明確授權編輯的文字；不改 raw handoff、歷史記錄、來源標題、引用或驗證證據。 |

英文詞數參考：[官方 Issue 9 詞數規則](https://www.asd-ste100.org/assets/files/ASD-STE100_ISSUE9.pdf)。技術詞彙及一般寫作可採用的原則參考：[官方 FAQ](https://www.asd-ste100.org/faq.html)。FAQ 舊頁的版本日期已過時，版本資訊以 Issue 9 官方介紹為準。

建議繁體中文術語對照：正文以「來源記錄」「驗證結果」「資料涵蓋範圍」「與前期比較」解釋影響；技術證據仍保留 `Session`、`verification.status`、`truncation` 等實際識別字。這是生成內容的寫作規則，不更改既有 UI 的固定產品詞彙與 JSON key。

### 示例

以下依既有歷史週報的文字示範編排，並未重新核實該週所有交付。

原摘要先列成果，再在同一段長文詳列 52／53 筆差異與多個完整度欄位。可改成：

> 本週成果涵蓋報告分析、知識治理與資料可攜性。這份整理根據 52 筆來源記錄撰寫；資料涵蓋範圍仍有待確認。

再以單一「資料涵蓋範圍」段落保留：當時統計與請求來源的筆數、Evidence 的不同分母，以及未能釐清的界線。驗證章節保留實際測試結果，不再次完整重複同一段範圍診斷。

英文原則示例：

> The report uses 52 source sessions. Its coverage is not fully confirmed. See the coverage notes for the source limits.

這是清楚寫作示例，不宣稱已逐詞通過 STE 字典檢查。

### 如何讓實際 Agent 用到

只在本 repo 增加一份開發用 skill，不會自動讓安裝後的 Codex／Claude 報告整理流程採用。

若導入，需同步：

1. canonical `work-intelligence` skill 的報告入口，讓 Agent 只在生成／編輯記錄和報告時讀取寫作指南。
2. `docs/work-record-and-report-format.md` 的共用語意；`apps/mcp/src/contracts.ts` 只放短規則及入口。
3. `apps/mcp/src/agent-resources.ts` 的按需資源與 `scripts/build-plugin.mjs` 的資源打包清單。
4. plugin skill 複本、手動安裝同步與 doctor hash 檢查，避免開發 checkout 有指南、已安裝 plugin 沒有指南。
5. 契約與產品規則衝突時，來源正確性、相容 key、引用及驗證狀態優先於短句偏好。

### 驗收方式

先用合成日／週／月報、中英文字及具有來源缺口的範例，測試新生成內容；歷史來源只用於唯讀對照。

- 所有數值、驗證狀態、限制與來源連結保留，沒有新增未經證實的效益或完成宣稱。
- 同一筆來源範圍問題不再在每個章節完整重複。
- 摘要首先說明成果與關鍵限制，詳細命令及內部診斷可由來源找到。
- 使用者能回答「完成了什麼」「有哪些限制」「怎麼核實」；不能只用字數、閱讀分數或詞數代理判定改善。
- 量測生成與補讀的完整任務成本，包含額外載入寫作 skill 的成本。
- 若宣稱正式英文 STE 合規，須另做完整規則和字典檢查。本次沒有這個驗收結果。

## 建議處理順序

1. 修正報告請求來源讀取與涵蓋範圍旗標，先保證 Agent 看見正確來源。
2. 為報告讀取去重、增加完整大小預算及可分頁的來源指標。
3. 導入精簡的共用寫作技能及兩種語言規則，配合少量有代表性的範例驗收。
4. 在 UI 顯示整理時間與涵蓋範圍，修正載入空狀態；處理 doctor 的多餘重連建議。
5. 保留 bundle 大小、coverage 範圍與知識頁版本容量為有量測依據的維護項目。

本次沒有執行上述修正或安裝技能。檢查屬於抽查與自動化回歸，不代表逐行審閱全專案、人工驗證實體 Windows／Linux、觸控裝置驗收或已證明寫作技能有讀者研究成效。


## 1.5.1 修正與驗證追蹤

上面的檢查與「本次沒有執行修正」描述屬於初始健康檢查階段。後續修正階段從 2026-10-11 11:38:15.741（Asia/Taipei，對話時間）開始，先保存進行中工作記錄並填入開始時間。

已實作固定請求來源分頁、選取來源證據、MCP 整體 JSON 字元預算與省略指標、目前期間與保存範圍區分、整理卡片的載入／錯誤／空狀態、長摘要展開、健康 doctor 建議，以及按需英文與繁中寫作指南。一般 context 的大量待整理來源改為 5 個指標及明確省略數，完整保存來源未被截斷。報告 context 的其他統計及診斷仍為目前期間資料，不能作為固定請求的完整來源；Agent 必須逐頁完整讀取該請求的來源後才做主張。

實際瀏覽器回歸發現即時更新後清單捲動歸零：項目 ID 相同但列表重建會重設位置。先以真實 SSE 更新重現 240px → 0px，再為未結項與清理列表指定穩定 ID。最終定向六項測試全部通過，包含更新來源標題後保留 240px 位置；375px 畫面人工檢視確認成果區可在首屏讀到，長摘要展開按鈕可用。

本機 build、單元測試（886 通過、1 原有略過）、typecheck、八套件 coverage、47 路效能、25 項檢索品質、11 項 MCP 回應大小及 recall smoke 通過。效能合成資料為 5,000 筆 Session、15 次量測；大量 pending context 的 p90 為 87.68ms，固定來源 context 74ms，Agent budget context 76.16ms。這些是合成門檻，不能推定真實資料庫或帳戶 token 成本。新增 skill 通過官方結構驗證，plugin 資源與 canonical 指南一致。

中途 Chromium 回歸有失敗與中斷：錯誤訊息測試先使用錯誤翻譯 namespace，已改為既有格式訊息；原生 PageDown 與即時更新導致的捲動問題保留失敗證據後修正。首輪 128 通過、2 失敗、1 中斷、47 未跑；下一輪完整回歸 120 通過、1 失敗、57 未跑；修正後重新執行完整三瀏覽器回歸，未放寬原有 timeout 或 axe 門檻。

歷史週報文字未批次改寫，因此初始的歷史重複文字項目仍保留。先前 coverage／axe timeout 的根因未經這次證明，仍保留原檢查限制；這次通過也不代表正式 STE 合規或讀者研究成效。主 bundle 約 502KB 的建置警告仍存在。PR、完整瀏覽器與發布結果以最終工作記錄、PR 檢查及 v1.5.1 發行頁核對。
