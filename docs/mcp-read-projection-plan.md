# MCP 精準讀取與任務成本最佳化方案

規劃日期：2026-10-10（Asia/Taipei）。狀態：使用者已納入 1.5.0，P0 基線與 P1／P2 程式修改已完成；本機八項前置檢查通過，三組成本重複程序門檻通過，整合 Chromium158／Firefox103／WebKit100 通過，新 SDK stdio client 的實際 payload 核對通過；最新 PR CI 及主安裝部署／重連結果另依檢查及部署工作記錄核對。檢視基準：`d1fa66092aac53db383b0b08653db5671744708c`，應用程式 1.4.0、SQLite schema 30。時間軸與 Mermaid 維持各自 PR／驗證；本文件只記載 MCP 精準讀取的證據。

## 1. 要解決的問題與成功定義

目標是讓 Agent 用較少成本取得足以正確完成工作的證據。衡量單位是「完成相同任務所需的全部工具輸入、結果與補查」，而不是讓每次回應看起來更短。

使用者要求：性能最佳化、保護其他功能、只做能提升專案價值的改進。因此先量測，再以固定欄位投影與按需載入減少無效工作；新增能力必須證明總成本下降，且不能以降低來源完整性、誤結案或隱藏限制交換。

核心成功條件：

- 既有呼叫不帶新參數時，結果形狀、欄位值、排序、錯誤與追蹤政策保持相容。
- 預設使用精簡讀取的固定任務案例，仍能得出與完整來源一致的判斷。
- 預設用途所需的來源狀態、驗證、限制和後續讀取指標完整保留。
- 在含契約與補查的整段任務量測中節省 token；查詢次數、延遲、SQL 次數與記憶體不得明顯惡化。
- 不新增資料表、持久化快取、通用查詢語言、Web 操作或寫入能力。

## 2. 現況與已存在的能力

以下為本次讀取程式與契約確認的現況，不是待新增功能：

| 現有能力 | 位置／限制 | 對方案的影響 |
| --- | --- | --- |
| 四個 dispatcher 與操作契約 resources | `apps/mcp/src/server.ts`；工具清單已有大小測試 | 沿用現有 dispatcher，不增加一組精簡版工具 |
| 緊湊 JSON | `apps/mcp/src/result.ts` | 不再把移除縮排當成新成果 |
| Context 跨區去重與整份預算 | `context-recall-service.ts`；有焦點 10,000、無焦點 16,000 UTF-16 code units | 不重寫排序，不降低既有預算來製造節省數字 |
| Session digest／recall／search | 已提供來源 id、截短標記與全文讀取路徑 | 不讓 digest 代替結案證據 |
| 原始交接內容預設省略 | `getSessionDetailForAgent`，只回傳 `contentLength` | 目前底層仍先載入完整 raw snapshot，再移除內容；有減少 I/O 的空間 |
| Session 完整 detail | 載入事件、snapshot、Evidence、Knowledge、decision、link、diagram、修改歷史 | 即使只查驗證與限制，仍組裝全部關聯；是第一優先改善點 |
| 知識頁 full／review 模式 | `knowledge-page-service.ts`，目前 24,000 字元預算 | 保留核對來源流程；不先開放任意刪除來源段落 |
| 文字與 structuredContent | Session 結果的 structuredContent 以完整結果展開，再加摘要欄位 | 需量測各 client 實際注入模型的內容，不能直接宣稱 token 一定翻倍 |
| 被動 Agent 讀取稽核 | dispatcher 對實際 result 記錄 id | 投影仍須記錄真正回傳的來源；不能把未讀內容當作已提供 |
| MCP build compatibility fingerprint | 包含操作契約、工具、instructions 等 | 新契約須依現有重連機制生效；純讀取能力不需要資料庫 migration |

本次現有測試：response-size 9 項、tools-list／result contract 9 項，全部通過；規劃文件 Prettier 檢查通過。這些只驗證既有行為，不是新能力。

本次合成基線在 `pnpm test:response-size` 重跑取得：有焦點 Context 9,045、無焦點 Context 15,847、recall 預設 3,799、recall 五筆 2,532、search 預設 7,128。這些是文字 JSON 的 UTF-16 code units，不是 token，也不涵蓋完整 MCP envelope。

歷史來源已完整核對：Session `74f9d965-a1e6-4a3c-a120-797dd5eae128`（大小基線）、`0719a664-39d1-4419-b666-bf0ba6a1cae5`（去重與預算）、`12bee376-8c2a-4f1a-bd6f-f48df257e9e2`（緊湊 JSON 與保護來源旗標）。部分早期自主決策已被使用者拒絕；本方案依目前程式與契約建立相容要求，不把歷史提案視為再次授權。

## 3. 取捨與範圍

第一版只擴充 `work_get_session`：兩個用途預設加固定白名單欄位選取。新參數為可選，未提供時走舊完整讀取路徑。現有 `includeRawSnapshots` 預設及行為保留。

| 候選方案 | 決定 | 理由 |
| --- | --- | --- |
| 改成所有讀取預設精簡 | 不採用 | 既有 Agent 與整合可能依賴完整結果，不能悄悄移除欄位 |
| 用途預設＋固定 select | 第一版 | 兼顧常見操作與精準補查，schema 可驗證、SQL 可靜態規劃 |
| 只在 MCP 回傳前裁切完整物件 | 不作為終點 | 可減少結果大小，卻不能避免未選資料的 SQL、解析與組裝 |
| 任意 dot path／JSONPath／GraphQL | 不採用 | 增加契約、驗證與維護成本，現階段收益不足 |
| 所有工具一次加入欄位選取 | 不採用 | 混合 Context 與知識頁來源較容易破壞可信度與完整性 |
| 快取整份專案資料 | 不採用 | invalidation、暫停追蹤及作廢處理容易出錯；先移除不必要工作 |
| 讓 LLM 再壓縮來源 | 不採用 | 額外成本、非確定性與證據遺失，不適合替代驗證來源 |
| 加入批次讀取 | 保留候選 | 只有補查次數實測成為瓶頸時才設計，不能先增加 API 複雜度 |

Context 與知識頁是後續有條件階段。完整規劃涵蓋它們，但只有第一版的結果證明價值、且各自有可驗證需求時才實作。

## 4. 第一版的介面契約

新增 `view?: "completion" | "handoff"` 與 `select?: SessionReadField[]`。`view` 和 `select` 互斥；兩者都省略代表既有完整回應。以下為新介面；主安裝須在合併、部署與重新連線後才可使用。

```json
{
  "operation": "work_get_session",
  "arguments": {
    "sessionId": "...",
    "view": "completion"
  }
}
```

用途展開表：

| view | 核心內容 | 使用邊界 |
| --- | --- | --- |
| completion | summary、outcomes、verification、nextSteps、機器驗證狀態、相關 Session links、Verification 修改歷史 | 用於判斷完成程度；不能單憑 `passed` 結案；歷史 nextSteps 不等於目前未結項狀態 |
| handoff | summary、完整五段摘要、decision 來源與 review 狀態、機器驗證、links | 接手工作；涉及實作細節時再查 changed files／Evidence |

白名單第一版包含：`session.summary`、`session.workSummary.outcomes`、`session.workSummary.scope`、`session.workSummary.decisions`、`session.workSummary.verification`、`session.workSummary.nextSteps`、`session.verification`、`session.changedFiles`、`session.git`、`decisions`、`links`、`verificationHistory`、`voidHistory`、`events`、`evidence`、`knowledge`、`diagrams`、`rawSnapshots`。`session.git` 是固定語意群組，對應現有 `session.commitSha`／`session.gitBranch` 欄位；輸出沿用這兩個欄位，不建立 `session.git` 資料物件或資料庫欄位。

第一版共 18 個固定欄位／群組；`select` 限 1–18 個、拒絕重複、未知值、空陣列及任意父路徑。結果欄位按固定 schema 次序輸出，不受請求順序影響。沒有 wildcard，不接受 client 提供 SQL 欄名。

```json
{
  "operation": "work_get_session",
  "arguments": {
    "sessionId": "...",
    "select": [
      "session.changedFiles",
      "evidence"
    ]
  }
}
```

精簡回應仍使用 `outcome: "session_detail"`，新增 `projection` 表明這是部分資料；core 定義獨立投影結果型別，不能強制轉型為完整 `SessionDetailResult`。

固定回傳的識別／安全欄位：Session id、project id、title、lifecycle status、execution status、completedAt、updatedAt（原資料存在時）、voided（原資料存在時）。不重複整份 Project，且不把缺少的歷史時間補成現在。

`projection` 至少包含 `version: 1`、採用的 `view`（若有）、展開後排序的 `includedFields`。未選取欄位由白名單與 includedFields 的差集判斷，不另回傳重複的 excludedFields 清單。selected-but-missing 欄位列在 `unavailableFields`，不補空陣列或 `passed`。必要 metadata 不列為可排除欄位。

必須明確區分：

| 情況 | 輸出語意 |
| --- | --- |
| 未選取 | 欄位不出現且不在 includedFields；不表示資料為空 |
| 已選取且查無關聯資料 | 回傳 `[]` |
| 已選取但歷史記錄沒提供欄位 | 不偽造值，列入 unavailableFields；沿用歷史驗證狀態語意 |
| 已選取但回應受既有長度限制 | 保留截短／省略數量與補讀資訊；不得標成完整 |
| skipped／not_found | 沿用現有結果及錯誤，不加入會洩漏來源的投影 metadata |

`includeRawSnapshots: true` 在完整模式仍按舊行為工作；精簡模式必須同時明確選取 `rawSnapshots`，否則回傳驗證錯誤，不能默默忽略。兩個 view 都不選取 raw。選取 `rawSnapshots` 但未開啟內容時保留既有 summary／contentLength 語意。

## 5. 證據完整性與舊功能保護

1. `session.workSummary.decisions` 被選取時，自動加入 `decisions`，保留決策來源／審查狀態；展開後 includedFields 顯示這項依賴。不可只呈現文字而隱藏已拒絕的 decision。
2. `session.verification` 被選取時，自動加入 `verificationHistory`，讓覆寫／更正可追溯。必須維持機器驗證與工作摘要驗證分離，兩者矛盾時要求查證，不能自動推導通過。
3. 被選取的 Knowledge 保留 `possiblyStale`、`needsReview` 與相應來源資訊；Evidence／diagram／link 保留既有作廢標記。不得為省 token 丟掉這些 metadata。
4. 來源已作廢時，固定 Session metadata 仍揭露狀態。投影僅供讀取；不改可結案條件、cleanup request 快照保護、Web 人工審查或寫入註解。
5. `completion` 提供判斷需要的摘要與更正，但完成某個未結項仍須按既有規則核對該項來源、時點及實際證據；select 是明確的局部讀取，不等於完整來源已讀。
6. 書面契約與技能須將「完整讀取」細化為「本次判斷相關欄位完整且無截短，必要時補讀」；未完成這項工作流驗證前，沿用原完整來源要求，不能先宣稱 token 節省可實現。
7. SQL 與 response 投影走 Agent 讀取路徑；REST Session detail、Web、報告、匯出／匯入、搜尋索引、永久刪除及寫入結果不變。
8. 多個 SELECT 在單次讀取中使用一致的 SQLite 讀取 snapshot；不能使用寫鎖實現唯讀一致性。跨次補讀的 updatedAt 不能被當成所有關聯資料的版本保證；在結案／覆寫前重讀必要狀態，遵守既有寫入交易內驗證。

## 6. 讀取流程與演算法

執行順序：schema 驗證 → 輕量查找 Session 所屬 project → 追蹤政策 → 展開欄位依賴 → 靜態 read plan → 按需讀取與組裝 → 依實際回傳來源稽核 → MCP 序列化。

全程維持 default-deny。未 tracked project 只允許既有政策查找，不執行事件／全文／Knowledge 等關聯讀取，也不能因快取命中繞過 gate。欄位選取只改輸出與執行成本，不擴大存取能力。

使用能帶來實際改善的演算法方法：

| 做法 | 複雜度／預期收益 | 驗證方式 |
| --- | --- | --- |
| 白名單 id 映射＋Set／bit mask | 解析 O(k)，依賴展開 O(k+d)，k≤18；固定 schema 大小，不掃整份來源找路徑 | 邊界／重複／未知欄位測試 |
| 預先展開兩個 view；自訂 select 每次只展開一次 | 避免反覆判斷、split 與遞迴遍歷；只快取 immutable plan，不快取資料 | profiler 與相同請求重複測量 |
| read plan 決定 SQL family | 未選 events、raw、diagram 等時零查詢；避免讀完整 detail 再裁切 | SQL 計數／spy，及未讀大型資料的測試 |
| 有限白名單生成投影 SQL | 參數化 id，欄名僅來自開發者常數；只讀必要欄位 | SQL 計畫與 injection 驗證 |
| 來源 id／信任 metadata 一次集合化 | 批次傳入既有 withKnowledgeTrustMany，避免每筆 Knowledge 再查一次 | 1／10／100 筆查詢次數不呈 N+1 |
| 序列化既定欄位一次 | 精簡回應按輸出大小 B 做 O(B) 組裝／序列化，不用完整字串來回 parse | CPU／配置量量測 |

「LeetCode 最佳化」落實在避免 N+1、避免反覆掃描、使用 Map／Set、預先規劃與 bounded input；不為固定 18 個欄位引入複雜 trie、通用 interpreter 或自訂 VM。DB I/O、JSON 大型來源與不必要查詢通常更值得先處理，但實際瓶頸以 profiler 確認。

特殊注意：目前 raw `contentLength` 是 JavaScript 字串長度。SQLite `length(text)` 是不同字元語意，不能直接替換而破壞 emoji 等資料的相容結果。先讓未選 raw 的投影完全不讀 raw；保留舊模式的 length，raw summary 的 SQL 省載入另以 Unicode 等價性與效益證據決定。

現有 Context 預算迴圈每次裁減會 `JSON.stringify` 整份結果，候選成本約 O(r·B)（r 為裁減次數，B 為當時字串量），但輸入目前已 bounded。先 profile；只有它佔合成案例顯著 CPU（提案門檻：≥10%）才做獨立最佳化。可將可裁減項目序列化長度記一次、以局部差額更新預算，末尾再完整驗證；要包含 JSON escaping、逗號、省略 metadata 成長與 Unicode。不假設總長度永遠單調，不直接以二分法取代帶旗標的裁減順序。

不修改 FTS ranking；若碰到搜尋 join，沿用專案已有的 FTS 驅動查詢規則並以 EXPLAIN QUERY PLAN 驗證，不把欄位選取變成搜尋重構。

## 7. structuredContent 與契約成本

舊完整回應和寫入結果的 structuredContent 維持相容。第一版投影結果使用專用 serializer，不呼叫會將整份物件展開並補預設值的舊 helper。

投影的 structuredContent 只放真實存在的機器摘要：outcome、sessionId、projection version／view、Session lifecycle、voided（若存在）、verification（僅已選且存在時）、changedFilesCount（僅實際已取得時）。未讀 changedFiles 不能回傳 0，缺少 verification 不能推導 `passed` 或「已完成」。文字 payload 保留選取資料與 includedFields，不在兩處重複大段 workSummary／Evidence／diagram。

client 是否同時向模型注入 content 和 structuredContent，由對照實驗確認。保留三種統計：文字區塊、完整 JSON-RPC 結果、client 實際模型可見結果；不能以 wire bytes 直接當成 token。若某 client 只展示 structuredContent，必須在該 client 驗證可取得投影文字，否則停止對它推廣精簡模式。

契約仍由現有 operation resource 發佈；新增 enum 不在 tools/list 重複攤開全套 output schema。不移除目前的 first-read contract 要求。新增能力計入首回合契約成本及 tools/list 預算；不靠後續每輪不重讀契約來宣稱第一輪也省同樣比例。

## 8. 量測設計與驗收門檻

P0 先建立固定、離線、全合成 fixtures：一般 Session、五段各有長文、大量 Evidence／事件／原生圖表、已作廢／還原、Verification 改為失敗、拒絕／推廣 decision、過時 Knowledge、缺歷史欄位、跨專案來源。文字包含中英混合、emoji、引號、換行及反斜線。不得採集真實使用者資料作為 CI fixture。

每條工作流都有固定問題、來源與正確判斷：

| 任務 | 必須取得的事實 | 量測路徑 |
| --- | --- | --- |
| 是否完成某項工作 | 成果＋驗證更正＋限制＋來源有效性 | 完整讀取 vs completion＋必要補查 |
| 接手後仍要做什麼 | 五段摘要＋決策來源＋links | 完整讀取 vs handoff＋細節補查 |
| 確認實作改動 | changedFiles＋指定 Evidence | 完整讀取 vs select |
| 需要原始交接證據 | 原始內容及來源 | 兩條路徑都讀 raw；不設定必須節省的虛假門檻 |
| 知識頁核對／覆寫 | 全頁、來源狀態、需 review 的完整來源 | 先量測現有模式，後續才能挑選更小的入口 |

統計至少包含：輸入契約與 schema 字元、結果 UTF-16 長度、UTF-8 bytes、完整 envelope、按固定版本 tokenizer 的估算 token、call count、讀取 p50／p90、SQL family 次數、raw／diagram 解析次數、離線程序 peak RSS。tokenizer 只作基準測量的可選開發工具，不能加入 production 讀取依賴；實際帳戶計費與 host 注入方式仍可能不同。

以下是待 P0 驗證的提案驗收門檻，不是已達成果：

- 代表性工作流總 token 中位數至少下降 25%；包含第一次契約讀取和所有補查。小型資料允許無明顯收益，不強迫所有案例都達 25%。
- 固定任務正確判斷 100% 一致；核對欄位和來源旗標覆蓋 100%，不能容忍以少讀降低正確性的案例。
- 若某預設 view 的工作流總 token 增加 >5% 或比完整讀取多超過 1 次補查，先調整 preset；不能靠平均值掩蓋退步並預設推廣。
- 既有 5,000-Session performance cases 全數通過。新增 completion／handoff／custom-heavy 案例，以同機同資料同 Node 前後對照；p90 不超過完整 Agent detail 的 `max(1.10×baseline, baseline+2ms)`，並在 CI 設可攜的絕對上限。相對門檻在多次獨立程序測量後判斷，不能用一次 timing 當 CI 硬門檻。
- 未選重型關聯的 SQL 次數與解析次數為零；帶 Knowledge 的 select 維持批次 trust 計算，不能出現關聯筆數驅動的 N+1。
- 既有回應大小、tools/list、操作契約大小與 coverage gates 全數保留。新增投影逐欄位與最大來源大小測試，不以新增一組更鬆的門檻取代舊門檻。
- 精簡路徑 heavy fixture peak RSS 不高於完整讀取 110%；profiling／RSS 報告用獨立程序，避免平行測試互相干擾。

性能測量先 warm up，再沿用現有 bench 的多輪取樣；分別標出冷啟動、warm request 與含被動 audit 的完整 dispatcher 成本。變更前後固定 fixtures、seed、runtime、host、samples，輸出原始結果以供重跑。

P0 若顯示收益不足，記錄未達門檻的原因，縮小或停止功能；不要為湊出成果減少回傳的必要證據。

## 9. 測試矩陣

| 層級 | 必須覆蓋 |
| --- | --- |
| Schema | 未提供新參數、兩 preset、18 個選項、依賴展開、重複／未知／空值／超長、view+select 衝突、raw opt-in 衝突、未知 key 拒絕 |
| Storage | 按需 SQL、policy gate、單次一致性、JSON 欄位解析、歷史欄位未提供、emoji length 不變、batch trust、invalid input 不讀重型資料 |
| Projection 等價性 | 相同 Session 的 selected 值深度等於完整路徑對應值；固定排序；不修改共享物件；所有合法 select／依賴關係以 seed 隨機組合測試 |
| Lifecycle／證據 | 作廢、還原、Verification 更正、拒絕 decision、linked voided source、Knowledge stale、截短標記不丟失 |
| MCP | dispatcher annotation／未知鍵／操作契約、投影 serializer、structuredContent 的缺值語意、錯誤遮蔽、返回來源 id 的被動 audit、build compatibility／舊連線重連 |
| 舊功能 | 不帶參數 result 深度等價；REST Session detail、報告與 Knowledge page full/review、cleanup 快照、import/export、刪除既有 tests 保持通過 |
| 檢索品質 | 原 hit@5／MRR 與 confidence gates 不變；新工作流不得丟棄問題所需來源 |
| 整合／平台 | Ubuntu／Windows／macOS Quality，既有 Chromium／Firefox／WebKit E2E；代表 MCP client 的文字／structured 顯示與重連 smoke |

先加入能顯示目前無選取、重型關聯全讀取或回應重複的失敗測試，再改實作。測試確認可觀察行為與證據，不只複製白名單實作。純規劃階段不聲稱任何投影功能測試已通過。

## 10. 實作位置與分期交付

| 階段 | 工作與交付物 | 停止／前進條件 |
| --- | --- | --- |
| P0 基線 | 擴充 response-size fixture；任務級輸入／輸出／補查矩陣；profile、SQL 次數及完整 envelope 報告 | 找出可省成本來源，固定驗收門檻後才進 P1 |
| P1 Session 精準讀取 | core projection 型別／固定欄位；schema 新可選參數；storage 按需 read plan；MCP 專用 serializer；兩 preset 和 select | 所有舊相容、來源完整性、效能與任務成本 gates 通過 |
| P2 工作流與文件 | 契約、skill、mcp-tools、testing、status、CHANGELOG；first-read／補讀指引；client smoke | 接手、結案與來源覆寫等實際工作流無缺證，才可推荐使用 preset |
| P3 有條件擴大 | Context sections 選取、知識頁「先核對哪些來源」入口，分開 PR 與工作流量測 | 只有已辨識額外收益時實作；收益不足就保留完整模式 |

P1 建議位置：`packages/core/src/index.ts`、`packages/schema/src/index.ts`、新 `packages/storage/src/session-agent-read-service.ts`（由 store facade 委派）、共用既有 repository／codecs、`apps/mcp/src/server.ts`、`apps/mcp/src/result.ts` 或獨立 projection serializer。讓新 Agent 投影不擴張已有完整 `session-record-service.ts`，避免 Web／REST 路徑被連動改壞。

新 service 只把必要 SQL／組裝分開；不用為每個欄位建立新檔案或另一套通用 repository framework。依實作 diff 決定共用方法抽取，但共用部分必須由舊相容性測試保護。

P3 的 Context 介面若成立，採固定區段 enum，依賴展開後先按需載入再預算；clock、server、policy、scope、pending request／來源 review 警示與 omitted coverage 不能因選取消失。未選區段標明「未要求」，不冒充「沒有資料」。不得改 relevant confidence、排序與來源去重優先順序。

P3 的知識頁入口保留現有 full/review 模式和覆寫要求，可先提供「頁面、需核對來源與有新資料 id」的概覽；它不能用於直接全頁覆寫或推進 checked cursor。真正評估／保存仍取得所需的完整來源、全部被標示需核對的 sections 與 coverage。此介面名稱／分頁／schema 在 P3 自己的 P0 中決定，不預先塞入第一版。

Context 的 O(r·B) 預算最佳化與批次讀取都作為獨立、量測驅動的候選；不與第一版綁成必要的大型重構。

## 11. 上線、回退與收尾

先在隔離 worktree 實作與驗證，基於當時已穩定主線重跑基線，不直接覆寫正在發布的工作。使用者已明確將第一版精準讀取納入 1.5.0；完成必要驗證後隨本次版本交付。

開 PR 前依序：`pnpm build`、`pnpm test`、`pnpm typecheck`、`pnpm test:coverage`、`pnpm test:performance`、`pnpm test:retrieval-quality`、`pnpm test:response-size`、`pnpm test:e2e`。建置、coverage、E2E 不在同一 worktree 同時執行，避免 dist 清理競態。每階段保存工作記錄，文件與知識頁依已確認成果更新，規劃不得標為功能交付。

每個 PR 以最新 head 的四項既有 CI 成功為合併條件。契約 fingerprint 更新後執行一次重連與舊 client smoke；不繞過 restartRequired。第一版 opt-in；需完整來源時省略新參數即回舊路徑。

若投影／serializer 發生缺證或 client 顯示不相容，停止推廣新參數，回復使用完整讀取；需要程式回退則 revert 對應獨立 PR、重建、重連。沒有資料 migration，所以沒有資料回滾；不可藉回退刪除工作記錄或 audit。

完成標準：功能、舊契約、性能、任務成本、平台與 client 驗證都有實際結果，文件／工作記錄能區分完成與限制。任何階段未達效益門檻，就保存原因並停止擴大，而不是增加更多功能來彌補沒有被證實的收益。

## 12. 本次規劃的驗證與限制

已檢視現行 MCP、storage、schema、result helper、來源核對與現有回應大小／性能測試設計，並核對上述三筆歷史 Session。重跑的現有合成測試結果記錄在規劃工作 Session。

原規劃保存時沒有新增 view／select 的實作，也沒有其效能改善、token 下降比例或 client 模型注入方式的實測；本次實作狀態及證據另記於下一節。P0 必須補齊完整 envelope、tokenizer／client、Session-heavy fixture、SQL 及任務級成本基線；驗收門檻均為本方案的設計要求，不是對改善成效的承諾。


## 13. 1.5.0 第一版實作與驗證進度

P0 的舊完整路徑基線已先量測；P1／P2 已在 `codex/session-read-projection` 實作 opt-in 投影、按需 SQL、一致讀取交易、專用 serializer、被動來源稽核與文件。未選欄位不讀取；未確認的歷史空 changed files 列入 unavailableFields，明確確認的空清單維持 `[]`。Raw 長度保留 UTF-16 語意。沒有 migration，schema 30 保持。

本機 build、完整單元測試、typecheck、coverage、44 項效能、25 項檢索與 9 項 response-size 已通過；大型投影真實 SDK 回應與安全旗標、WAL 並行讀取一致性皆有回歸。整合 E2E 結果與新 client 核對見下方 2026-10-11 註記；最新提交 CI／主安裝部署與重連結果另以 PR 及工作記錄確認。Context、知識頁與批次 P3 沒有足夠的額外收益證據，維持原模式。

成本以每個獨立任務計入 initialize instructions、tools/list、operation index、完整 skill、操作契約和全部補查；JSON-RPC frames 為 in-memory transport 捕捉後的序列化大小，不是網路封包或計費量。`o200k_base` 只作固定參考 tokenizer，不能代表 Codex 實際注入／帳戶扣款。小型交接在不計啟動指引的文字 payload 會增加成本，故 skill 建議小型 handoff 保留完整讀取；大型來源才適合投影加一次補查。三組獨立程序的參考文字 token 降幅中位數為 30.45%–30.95%，相對 p90 與 peak RSS 門檻均通過。小型 handoff 的含啟動參考文字 token 增加 4.21%–4.55%，沒有普遍節省；大型三種任務下降 60.68%–84.20%。原始結果與門檻判斷保存於 `docs/experiments/session-read-projection-2026-10-10.json`，不以單次 timing 宣稱普遍收益。

### 2026-10-11 整合驗證

整合 UI、原生圖表與 1.5.0 版號後，build、完整單元 880 通過／1 既有略過、typecheck、coverage、效能44／檢索25／response-size9通過。正式 runner Chromium158／Firefox103通過；WebKit首輪96通過、1背景攔截 teardown失敗、3未跑，保留原紀錄。等待 route handler 收尾後，同案例三瀏覽器各兩次全通過，完整WebKit重跑100通過，沒有放寬timeout或刪除斷言。

三組整合前後獨立程序的完整任務參考文字token降幅中位數30.39%–30.77%，小型handoff增加4.16%–4.49%，大型來源三任務下降60.55%–84.12%；相對p90、補查及peak RSS門檻全部通過。原先三組與整合三組數據分開保存在實驗JSON，未拿tokenizer參考值冒充帳戶計費。

隔離1.5.0建置透過新SDK stdio連線讀取已tracked資料庫，核對完整／completion／select的值、驗證修改歷史及明確選取的voidHistory、固定生命週期旗標、structured metadata與非法raw組合拒絕。這驗證真實SDK回應；不宣稱Codex host的注入方式或扣款相同。主安裝重連的實際結果以部署記錄核對。
