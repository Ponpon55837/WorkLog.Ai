# 設計紀錄：降低 Agent 固定閱讀量（1.6.78 設計階段）

- 日期：2026-11-26
- 狀態：設計中，待維護者確認第 7 節的問題後才實作
- 需求來源：Issue #440 本文與三則留言（三種禁令處理方式、五類機制、`reviewToken` 案例與防退化要求）
- 方法沿用：[`2026-11-agent-guidance-ab.md`](2026-11-agent-guidance-ab.md) 與 [`ab-report.md`](../experiments/retrieval-baseline/ab-report.md)
- 這份文件只記錄設計。A/B 的結論會另寫一份決策紀錄，不覆寫既有紀錄。

字元數一律是 UTF-16 code unit，與 `tests/mcp/agent-reading-budget.test.ts` 的算法相同。標「量測」的數字是本次在 main（`0999fe2`，1.6.76）實際跑出來的；標「估計」的是設計推算，附把握程度。

## 1. 現況量測

### 1.1 量測方式

- `pnpm build` 之後執行 `pnpm --filter @work-intelligence/mcp exec vitest run --root ../.. --config apps/mcp/vitest.config.ts tests/mcp/agent-reading-budget.test.ts --disableConsoleIntercept`，5 個測試全過，讀取 `Agent reading` 那一行輸出。
- 各操作契約與 resource 的長度，另用同一種 in-memory MCP 連線（`createWorkIntelligenceMcpServer` + `InMemoryTransport`）逐一 `resources/read` 取得。這支量測腳本只放在暫存目錄，沒有加進倉庫。
- 契約內部的分段（說明、schema、驗證規則、各子契約）是依契約文字中的標記切開計算的。

### 1.2 固定閱讀量（量測）

| 內容 | 字元數 | 預算 | 剩餘 |
|---|---:|---:|---:|
| 伺服器 instructions | 1,934 | — | — |
| tools/list | 4,476 | — | — |
| 核心 skill | 13,918 | 14,000 | 82 |
| 操作索引 | 4,774 | — | — |
| `work_get_context` 契約 | 4,803 | — | — |
| `work_finalize_session` 契約 | 12,339 | — | — |
| **固定閱讀量合計** | **42,244** | **42,250** | **6** |

Issue 記載的 1.6.74 數字是 42,249 與 13,923；1.6.75、1.6.76 之後核心 skill 少了 5 個字元，其餘不變。

其他預算（量測）：

| 內容 | 字元數 | 預算 |
|---|---:|---:|
| `work-record-and-report-format.md` | 8,083 | 8,500 |
| 最大的 guide（`knowledge`） | 8,987 | 9,000 |
| `reading-records` guide | 8,885 | 9,000 |
| `agent-review` guide | 7,494 | 9,000 |
| `synthesis` guide | 7,303 | 9,000 |
| `repair-and-backfill` guide | 4,093 | 9,000 |
| `outstanding-cleanup` guide | 2,797 | 9,000 |
| `diagrams` guide | 1,459 | 9,000 |
| 罕見流程（核心 + 格式 + 最大 guide） | 30,988 | 31,000 |

`knowledge` 與 `reading-records` 兩份 guide 也只剩 13 與 115 字元，所以從固定閱讀量移出的文字不能直接塞進這兩份 guide。

### 1.3 固定閱讀量的內部組成（量測）

`work_finalize_session` 契約 12,339：

| 部分 | 字元數 |
|---|---:|
| 標頭（Dispatcher、Title、Annotations） | 230 |
| 「Use and limits」一般說明 | 1,888 |
| Work record contract | 1,843 |
| Closing contract | 742 |
| Diagrams 規則 | 477 |
| JSON schema（含欄位 description） | 6,854 |
| 驗證規則（2 條） | 305 |

schema 中最大的欄位：`workSummary` 1,151（其中五個區段的中文 description 合計 222，其餘是結構）、`diagrams` 537、`events` 431、`changedFilesProvenance` 411、`maintainedKnowledgePages` 397、`changedFileChanges` 325、`supersededOutstandingItemIds` 294、`completedAt` 268、`startedAt` 258。全部欄位的 description 文字合計 1,840。

`work_get_context` 契約 4,803：標頭 152、說明 4,118、schema 533。

核心 skill 13,918（依段落）：

| 段落 | 字元數 |
|---|---:|
| frontmatter 與開頭 | 670 |
| Privacy and project policy | 1,760 |
| MCP dispatcher calls | 1,236 |
| Guides to read on demand | 1,046 |
| Start of work | 1,099 |
| Rely only on what a source supports | 1,101 |
| Finalize a completed work session | 6,177 |
| Other requests | 830 |

tools/list 4,476：四個 dispatcher 分別是 `work_read` 1,351、`work_write_idempotent` 1,227、`work_write_additive` 853、`work_write_overwrite` 1,030。大部分是 operation 名稱的 enum，description 只有幾句。

操作索引 4,774：標頭 452、55 行操作 4,323。55 行中的「→ dispatcher」部分合計 1,049 字元；同樣的對應已經寫在 tools/list 每個 dispatcher 的 `operation` enum 裡。

### 1.4 三個階段實際要讀的量（量測值相加）

固定閱讀量把結案時才需要的 finalize 契約也算進「第一次有用呼叫之前」。依 Issue 第三則留言，另外分階段報告。下表是各 resource 的量測長度相加，不含工具回應本身。

**開工**（確認專案、取得 context、開始改檔）

| 項目 | 字元數 |
|---|---:|
| 必讀：instructions + tools/list + 核心 skill + 操作索引 + `work_get_context` 契約 | 29,905 |
| 常見另讀：`work_get_file_history` 契約 2,049、`work_recall` 契約 4,528 | 6,577 |
| 常見合計 | 36,482 |

**結案**（儲存記錄並處理回條）

| 項目 | 字元數 |
|---|---:|
| 必讀：`work_finalize_session` 契約 | 12,339 |
| 回條帶 `startedAtFollowUp`、`unreportedKnowledge`、`changedFileChangesFollowUp` 或 `timestampWarnings` 時：`work_update_session_metadata` 契約 | 4,893 |
| 結案未結項：`work_resolve_outstanding_items` 契約 | 3,481 |
| 附圖表：`diagrams` guide 1,459 + `architecture-diagram-v1` 2,737 | 4,196 |
| 全部都用到時的上限 | 24,909 |

**特殊任務**（在開工必讀之外另讀）

| 任務 | 讀的內容 | 字元數 |
|---|---|---:|
| 知識頁維護 | `knowledge` guide、`work_get_knowledge_page_context`、`work_save_knowledge_page`、`work_mark_knowledge_page_checked` | 23,183 |
| Agent review | `agent-review` guide、`work_request_agent_review`、`work_get_agent_review_context`、`work_submit_agent_review_verdicts` | 22,286 |
| 報告整理 | `synthesis` guide、`work_list_report_synthesis_requests`、`work_get_report_context`、`work_save_report_summary`、`worklog-report-writing` SKILL 與 zh-TW 參考 | 23,348 |
| 整理未結項 | `outstanding-cleanup` guide 與三個操作契約 | 9,361 |
| 修正已存記錄 | `repair-and-backfill` guide、`work_update_session_metadata`、`work_update_session_work_summary` | 14,815 |
| 讀過去的記錄 | `reading-records` guide、`work_get_session`、`work_recall` | 16,800 |

這些數字只是閱讀量。工具回應的字元數（例如 context 上限 10,000／16,000）與 Agent 實際 token 要另外量（見第 5 節）；固定閱讀量下降不代表端到端成本下降。

## 2. 規則盤點表

### 2.1 範圍與標記方式

- 逐條列出：核心 skill（`.agents/skills/work-intelligence/SKILL.md`；`plugins/work-intelligence/skills/work-intelligence/SKILL.md` 與它逐位元相同，md5 一致，所以不另列）、`work_finalize_session` 契約、`work_get_context` 契約、操作索引、伺服器 instructions、tools/list 的 description。
- `.claude/skills/work-intelligence/SKILL.md` 是指向 `.agents` 版本的指標檔，只有 description 與一段轉址說明，沒有規則，不列入。它的 description 比 `.agents` 版少了「recall related past work…」一句，實作時要一併同步（另見 6.4）。
- 「目前把關」：只有實際查到程式碼才標「已有程式檢查」並附 `file:line`；查不到就標「僅文字」。行號以 `0999fe2` 為準。
- 「建議機制」用 Issue 第二則留言的五類，一條只標主要的一類：強制阻擋、自動處理、即時警告、事實注入、Agent 指引保留。
- 「處置」：保留（原文留著）、縮短（留一句）、移出（改由別處承擔，固定閱讀中刪除）、去重（同一句在別處已有，這裡刪除）。
- ★ 表示這條在 `CORE_RULES` 清單中。

### 2.2 核心 skill（S）

| # | 規則摘要 | 出處（段落與行） | 字元 | 目前把關 | 程式可判定 | 建議機制 | 處置 | 重複位置 | 風險 |
|---|---|---|---:|---|---|---|---|---|---|
| S1 | 對使用者用自然語言，不要求工具名、request ID、JSON、呼叫順序 | 開頭 L10 | 257 | 僅文字 | 否 | Agent 指引保留 | 縮短 | N8 | 低 |
| S2 ★ | 記錄採明確 opt-in；專案必須 `tracked` 才能讀寫任何專案資料 | Privacy L14 | 174 | 已有程式檢查（MCP 範圍）：`packages/storage/src/store.ts:1821`、`packages/storage/src/context-recall-service.ts:447`；Agent 自己讀檔不受程式管 | 部分 | Agent 指引保留（安全規則） | 保留 | N1、F5、C9 | 高：安全規則，不可移 |
| S3 ★ | 讀專案檔案前先呼叫一次 `work_get_context`；不要再呼叫 `work_get_project_status`；未 tracked 或無法確認就停止，不先掃 handoff 或 Git | Privacy L15 | 507 | 「停止」僅文字；skip 結果由程式產生 `context-recall-service.ts:447` | 部分 | Agent 指引保留 | 縮短：「不要再呼叫 `work_get_project_status`」與 C9 的說明刪除，只留在 instructions | N4、C9、`work_get_project_status` description | 中：刪去的是效率說明，不影響安全 |
| S4 ★ | unregistered／paused／ignored 安靜略過，不建立任何資料；有 `matchingProjects` 時問使用者，不自行切換 | Privacy L16 | 329 | 已有程式檢查：寫入一律 skip（`store.ts:1821`）；`matchingProjects` 由 `apps/mcp/src/matching-projects.ts:23` 加入；「不自行切換」僅文字 | 部分 | Agent 指引保留 | 縮短：`matchingProjects` 的處理方式改寫在 skip 結果的 hint（事實注入） | N1 | 中 |
| S5 ★ | 使用者說不要存的內容包在 `<private>…</private>`，必須有結尾標籤 | Privacy L17 | 215 | 已有程式檢查（移除區塊）：`packages/storage/src/secret-redaction.ts:640`；Agent 是否包起來僅文字 | 否（要不要包是判斷） | Agent 指引保留 | 保留；另加即時警告：偵測到未閉合 `<private>` 時回條提示 | — | 高：安全規則 |
| S6 ★ | 不把機密、token、個資寫進記錄、圖表、Knowledge | Privacy L18 | 145 | 已有程式檢查（遮蔽）：`secret-redaction.ts:738`（`redactText`），finalize 在 `store.ts:1864-1879` 套用 | 部分 | Agent 指引保留 | 保留 | F9、F12 | 高：安全規則 |
| S7 ★ | 尊重每個 skip；不改用檔案系統直接讀取 | Privacy L19 | 127 | 僅文字 | 否 | Agent 指引保留 | 保留 | — | 高：安全規則 |
| S8 ★ | 問的是本專案時留在範圍內；不以全倉庫掃描取代缺少的記錄 | Privacy L20 | 224 | 僅文字 | 否 | Agent 指引保留 | 保留 | — | 中 |
| S9 | 四個 dispatcher 與 `{ operation, arguments }` 的呼叫方式；讀取一律用 `work_read` | Dispatcher L24 | 401 | 已有程式檢查：dispatcher 的 `operation` enum（`apps/mcp/src/server.ts:258-278`、`407-411`） | 是 | 強制阻擋（已有） | 縮短成一句 | N3、I1、T1 | 低 |
| S10 ★ | 第一次呼叫某操作前（寫入前一定要）先讀完整契約 | Dispatcher L25 | 349 | 僅文字 | 否（伺服器無法可靠判斷 Agent 讀過與否） | Agent 指引保留 | 縮短：保留 ★ 句，刪去「不要從精簡 schema 推論規則」的解釋 | N3、I1、T1（write dispatcher description） | 中 |
| S11 ★ | `restartRequired` 為 true 時停止並請使用者重新連線；`updateAvailable` 照常讀寫、結案提醒一次；`monitoringAvailable` 為 false 時不聲稱連線是最新的 | Dispatcher L26 | 457 | 已有程式檢查（寫入擋下）：`apps/mcp/src/server.ts:612-622` 回 `MCP_RESTART_REQUIRED` | 部分 | 強制阻擋（已有） | 縮短：保留 ★ 句；`monitoringAvailable` 的說明改為 `server` 物件內的 hint（事實注入） | T1（`work_read` description） | 低 |
| S12 | 各 guide 何時讀（7 項清單） | Guides L28-38 | 1,046 | 測試檢查清單與檔案一致：`tests/mcp/agent-reading-budget.test.ts` 第 4 個測試 | 否 | Agent 指引保留 | 保留 | N2 | 中：刪掉觸發條件會讓 Agent 不讀 guide |
| S13 | Session 記錄格式在 `work-record-and-report-format.md` | L40 | 140 | 僅文字 | 否 | Agent 指引保留 | 保留 | — | 低 |
| S14 ★ | 確認 tracked 後記下工作開始前已變更的路徑（`baselineChangedFiles`），保留到結案 | Start L44 | 200 | 僅文字；伺服器只記段落起點的 HEAD commit（`server.ts:628-631`），不記 dirty 路徑 | 否（現況） | Agent 指引保留 | 保留 | F3、schema description | 高：沒有 baseline 會吸收無關變更 |
| S15 | 規劃前先讀回傳的 Knowledge、相關 Session 的決策與未結項 | Start L45 | 182 | 僅文字 | 否 | Agent 指引保留 | 保留 | — | 中 |
| S16 | 改有歷史的檔案前呼叫 `work_get_file_history` | Start L46 | 122 | 僅文字 | 否 | Agent 指引保留 | 去重：保留 skill 這句，instructions 刪除 | N5 | 低 |
| S17 | 出現錯誤時先用錯誤訊息 recall | Start L47 | 185 | 僅文字 | 否 | Agent 指引保留 | 保留 | N5 | 低 |
| S18 | 使用者問過去的工作：用原話 recall、沒命中就換說法、把「上週」換成日期 | Start L48 | 304 | 僅文字；日期換算依據由 context 的 `clock` 提供 | 否 | Agent 指引保留 | 縮短 | `reading-records` guide | 低 |
| S19 | 工作開始時使用者要求的記錄走 repair guide | Start L49 | 81 | 僅文字 | 否 | Agent 指引保留 | 保留 | — | 低 |
| S20 | hit、digest、preview 只是指標；用到細節前讀完整來源並引用 id | Rely L53 | 280 | 僅文字（回應帶 `omitted.readWith` 指標，但沒有檢查 Agent 是否讀了） | 否 | Agent 指引保留 | 縮短 | C7、`reading-records` L24 | 中 |
| S21 ★ | `confidence` 只代表字面覆蓋；`none` 時不得當證據 | Rely L54 | 278 | 已有程式檢查（計算與清空）：`packages/storage/src/search-repository.ts:526`、`context-recall-service.ts:1299` | 部分 | 事實注入 | 縮短：保留 ★ 句 | C4 | 中 |
| S22 | possiblyStale／needsReview 的 Knowledge 先對照程式碼；與程式碼矛盾就相信程式碼 | Rely L55 | 285 | 僅文字（旗標由程式計算並附在回應，例如 `packages/storage/src/knowledge-service.ts:243`；處理方式沒有檢查） | 否 | Agent 指引保留 | 縮短 | `reading-records` L32、C6 | 中 |
| S23 ★ | 沒有來源支持就說 `資料不足`，不從字面重疊、排名、時間推論 | Rely L56 | 213 | 僅文字 | 否 | Agent 指引保留 | 保留 | N8、C10、`SOURCE_SUPPORT_GUIDANCE`（`server.ts:224`，附加在多個工具 description） | 中 |
| S24 ★ | 結案是生命週期事件，不是 commit；commit 可選，不可要求或推論 | Finalize L60 | 254 | 已有程式檢查（`git` 選填，缺少時伺服器自己讀）：`store.ts:1880` | 部分 | Agent 指引保留 | 縮短：保留 ★ 句 | F1、F10 | 低 |
| S25 ★ | 結案前帶實際變更路徑與 `linkedSessionIds` 重取一次 context；被 skip 就不準備任何東西，一句話告訴使用者 | Finalize 步驟 1，L62 | 287 | 已有程式檢查（skip）：`context-recall-service.ts:447-455`；「一句話告知」僅文字 | 部分 | Agent 指引保留 | 保留 | — | 中 |
| S26a ★ | `resolvedOutstandingItemIds` 只放這次工作直接驗證完成的項目；不以排名、措辭、提醒當完成證據；不確定就不動 | 步驟 2，L63 | 約 330 | 僅文字（伺服器無法驗證「做完了沒」） | 否 | Agent 指引保留 | 保留 | F11、N8、schema description | 高：錯誤結案會讓未結項消失 |
| S26b | `supersededOutstandingItemIds` 需要非空 `nextSteps` | 步驟 2，L63 | 約 120 | 已有程式檢查：`store.ts:2006`（`nextSteps` 為空時一律不套用，回 `outstandingItemWarnings`，`store.ts:2126`） | 是 | 強制阻擋（建議由警告升級，見 4.3） | 移出 | F11、schema description | 低 |
| S26c ★ | 被進行中整理未結項請求持有的項目，不可用兩個欄位繞過 | 步驟 2，L63 | 約 240 | 已有程式檢查：`packages/storage/src/outstanding-item-service.ts:695-702`（持有中的項目不會被轉換，回警告） | 是 | 強制阻擋（已有，維持警告形式，見 4.3） | 移出，由回條逐項說明原因 | `outstanding-cleanup` guide | 低：程式已擋 |
| S27a ★ | 只認這次任務刻意改的檔案；不吸收工作前就有的無關變更；沒記 baseline 就省略，不事後重建 | 步驟 3，L64 | 約 420 | baseline 排除由程式做：`store.ts:1832-1850`；「刻意」與「無關」僅文字 | 否 | Agent 指引保留 | 保留 | F3 | 高 |
| S27b | 每個路徑給 `changedFileChanges` 狀態；伺服器只補 Git 看得到的，其他列在 `changedFileChangesFollowUp` | 步驟 3，L64 | 約 220 | 已有程式檢查：Git 觀察 `apps/mcp/src/finalize-observation.ts:14`、套用 `store.ts:1851-1861`；follow-up `store.ts:419` 與回條 `apps/mcp/src/finalize-receipt.ts:141-148` | 是 | 自動處理 | 移出，由回條說明 | F3、schema description | 低 |
| S28a ★ | `summary` 一句結果優先；`workSummary` 五個陣列 | 步驟 4，L65 | 約 180 | 已有程式檢查（五個陣列必填）：MCP schema `packages/schema/src/index.ts:420-422`；寫法僅文字 | 部分 | Agent 指引保留 | 去重：細節只留在 F10 | F10、schema description、格式文件 | 中 |
| S28b ★ | `nextSteps` 只放之後仍待處理的項目；不捏造建議、路線圖；任務內暫時狀態不算 | 步驟 4，L65 | 約 420 | 暫時狀態由關鍵字比對警告：`packages/storage/src/transient-next-steps.ts:91`，finalize 在 `store.ts:2139` 套用；捏造僅文字 | 部分（關鍵字比對可能誤判） | 即時警告 | 縮短：保留 ★ 句，暫時狀態的類別清單只留在 `nextStepsWarnings` 訊息 | F10 | 中 |
| S28c ★ | 不猜決策來源；Agent 自主決策進 Web 審查佇列，確認、駁回、升級為 Knowledge 只在 Web，除非使用者開 Agent review | 步驟 4，L65 | 約 280 | 已有程式檢查：MCP 沒有確認決策的操作（操作索引中沒有）；verdict 只在請求開啟時接受 `packages/storage/src/agent-review-service.ts:541`；來源猜測僅文字 | 部分 | Agent 指引保留 | 縮短：「不猜決策來源」保留；Web-only 一句改短（需同步更新 ★ 字串） | F10、C8 | 中 |
| S28d | `in_progress` 不等於通過；Git 欄位只放觀察到的值；`agentModel` 只在系統提示寫明時給 | 步驟 4，L65 | 約 250 | 僅文字（`agentModel` 規則另寫在 schema description） | 否 | Agent 指引保留 | 去重：只留在 F10 與 schema description | F2、F10、schema description | 低 |
| S29a ★ | 時間不要估計 | 步驟 5，L66 | 162 | 已有程式檢查：未來時間拒絕 `packages/schema/src/index.ts:236-253` | 部分 | Agent 指引保留 | 保留 | F4、schema description | 高 |
| S29b ★ | 剛完成的工作省略 `completedAt`；補登時才給，帶 UTC offset | 步驟 5，L67 | 325 | 已有程式檢查：未來時間拒絕（同上）；超過 24 小時警告 `packages/storage/src/work-timestamps.ts:18` | 部分 | Agent 指引保留 | 縮短：保留 ★ 句；offset 與 `Z` 的說明移到 schema description（已有） | F4、schema description | 中 |
| S29c | `startedAt` 是本段第一則訊息；hook 會給；Claude Code 缺少時暫停一次 | 步驟 5，L68 | 309 | 已有程式檢查：Claude Code hook 暫停 `apps/mcp/src/finalize-reminder.ts:412-427`；伺服器觀察 `server.ts:628`、`store.ts:1884`；回條 `startedAtFollowUp` `finalize-receipt.ts:115,128` | 是（有無）；否（值是否正確） | 事實注入 | 移出，由 hook 訊息與回條承擔 | F4、schema description | 中：Codex 無暫停 hook，靠回條 |
| S29d | 接續已結案的 Session 用 `completedAtNow: true` | 步驟 5，L69 | 161 | 已有程式檢查：`packages/schema/src/index.ts:1010`（`refineCompletedAtNow`） | 是 | Agent 指引保留 | 移出到 `repair-and-backfill` guide | `work_update_session_metadata` 契約 | 低 |
| S29e | 回條有 `startedAtFollowUp` 時同一回合依證據補上；`server_observed` 的意思 | 步驟 5，L70 | 180 | 回條內已有完整說明：`finalize-receipt.ts:42-43` | 是 | 事實注入 | 移出 | F4 | 低 |
| S29f | `timestampWarnings` 用 `work_update_session_metadata` 修正，不作廢重建 | 步驟 5，L71 | 167 | 警告由程式產生 `store.ts:1891-1897`；訊息已寫做法 `work-timestamps.ts:25,38` | 是 | 即時警告 | 移出：在警告訊息加上「用 work_update_session_metadata 修正」 | F4 | 低 |
| S30 ★ | 只回報實際用上的 Knowledge（applied／contradicted）；回條的 `unreportedKnowledge` 不要為了清掉而回報 | 步驟 6，L72 | 483 | 事實注入：`store.ts:2194-2205`、回條 hint `finalize-receipt.ts:46-47`；專案歸屬檢查 `packages/storage/src/knowledge-service.ts:319-321` | 部分 | Agent 指引保留 | 縮短：保留 ★ 句，補報方式只留在回條 hint | F4、schema description | 中 |
| S31 | 接續前一個 Session 時給 parent link，其他確認的關係用 related | 步驟 7，L73 | 235 | 連結合法性檢查：`packages/storage/src/session-record-service.ts:226-238`（自身、不存在、未 tracked），回 `linkWarnings` `store.ts:2078-2083` | 部分 | Agent 指引保留 | 縮短 | F4、schema description | 低 |
| S32 | 跨模組流程、狀態機等工作主動附圖；單檔、文案、設定、相依、純測試不附 | 步驟 8，L74 | 284 | 圖表格式驗證：`packages/schema/src/index.ts:307-314`；何時附圖僅文字 | 否 | Agent 指引保留 | 移出：條件只留在 `diagrams` guide，核心留一句觸發 | F12、schema description | 中：A/B 要看附圖率 |
| S33a ★ | 同 key 同內容重試不得建立第二筆 Session | 步驟 9，L75 | 約 120 | 已有程式檢查：`store.ts:1908-1934`（重複回原 Session，`duplicate: true`） | 是 | 自動處理 | 移出（★ 移出，見 4.5） | F6 | 低 |
| S33b | 同 key 不同 summary 視為衝突，明確更新既有 Session | 步驟 9，L75 | 約 200 | 已有程式檢查：`store.ts:1911-1921`（`idempotency_conflict` 附 `suggestedTool`） | 是 | 強制阻擋（已有） | 縮短成「用穩定的 key」 | F6 | 低 |
| S34 | 讀回條：直接驗證的 continued／related 未結項用一次 `work_resolve_outstanding_items` 關閉；`knowledgeToReview` 逐項確認或告知使用者 | 步驟 10，L76 | 497 | 事實注入：`store.ts:2151-2190`；處理方式僅文字 | 否 | 事實注入 | 移出：做法寫進回條 hint（`knowledgeToReview` 目前沒有 hint） | F11 | 中 |
| S35 | 找特定 Session 先 recall 或 list，不猜 sessionId | Other L80 | 218 | 僅文字 | 否 | Agent 指引保留 | 縮短 | `reading-records` guide | 低 |
| S36 ★ | 不為了改文字或 metadata 建立替代 Session | Other L81 | 99 | 僅文字 | 否 | Agent 指引保留 | 保留 | `repair-and-backfill` guide | 中 |
| S37 | `outstandingCleanup` 請求只在結案時提一次，不主動處理 | Other L82 | 84 | 僅文字 | 否 | Agent 指引保留 | 保留 | — | 低 |
| S38 ★ | 只在使用者要求或流程明確要求時記錄或更新 Knowledge | Other L83 | 228 | 僅文字 | 否 | Agent 指引保留 | 保留 | `knowledge` guide | 中 |
| S39 | 回覆時說明存了什麼、驗證與缺口，不把 MCP 細節丟給使用者 | L85 | 175 | 僅文字 | 否 | Agent 指引保留 | 保留 | — | 低 |

### 2.3 `work_finalize_session` 契約（F）

| # | 規則摘要 | 出處 | 字元 | 目前把關 | 程式可判定 | 建議機制 | 處置 | 重複位置 | 風險 |
|---|---|---|---:|---|---|---|---|---|---|
| F1 | 規劃、執行、驗證、收尾都完成才結案 | Use and limits 第 1 句 | 96 | 僅文字 | 否 | Agent 指引保留 | 保留 | S24、N6 | 低 |
| F2 | 必填欄位列表；`in_progress` 的意思 | 第 2 句 | 252 | 已有程式檢查（必填）：`packages/schema/src/index.ts:335-418`、`420-422` | 是（必填） | 強制阻擋（已有） | 縮短：刪去必填列表（schema 已表達），留 `in_progress` 一句 | S28d | 低 |
| F3 | `baselineChangedFiles`、`changedFilesProvenance`、`changedFileChanges` 的用法 | 第 3 句 | 315 | 已有程式檢查：`store.ts:1832-1861`、`finalize-observation.ts:14` | 部分 | 自動處理 | 縮短 | S14、S27、schema description | 低 |
| F4 | 只回報用上的 Knowledge；parent link；時間欄位不估計；未來時間拒絕；`timestampWarnings` 修正方式 | 第 4 句 | 330 | 已有程式檢查（部分）：未來時間 `packages/schema/src/index.ts:236-253`、Knowledge 專案歸屬 `knowledge-service.ts:319-321`；其餘僅文字 | 部分 | 去重 | 去重：刪除，留在 schema description 與核心 | S29、S30、S31、schema description | 低 |
| F5 | 只有 tracked 專案能讀寫，其他安靜略過 | 第 5 句 | 89 | 已有程式檢查：`store.ts:1821-1829` | 是 | 強制阻擋（已有） | 去重：刪除 | S2、N1 | 低（核心與 instructions 仍有） |
| F6 | 同 key 重試回原 Session；不同 summary 衝突 | 第 6 句 | 76 | 已有程式檢查：`store.ts:1908-1934` | 是 | 自動處理 | 保留（這是行為說明，不是禁令） | S33 | 低 |
| F7 | 缺少驗證／檔案／狀態／workSummary 會回 follow-up；未結項轉換的原子性、稽核與衝突處理 | 第 7 句 | 432 | 已有程式檢查：`store.ts:2108-2135`、follow-up 函式 `packages/storage/src/session-record-codecs.ts:720,739,773` | 是 | 事實注入 | 縮短成一句 | S26 | 低 |
| F8 | 回條不是 echo；可能帶 `knowledgePageMaintenanceHint` | 第 8 句 | 173 | 已有程式檢查：`finalize-receipt.ts:83-155`、`store.ts:2146` | 是 | 事實注入 | 縮短 | — | 低 |
| F9 | 機密在儲存前遮蔽，回條只報類型計數 | 第 9 句 | 116 | 已有程式檢查：`store.ts:1864-1879`、`finalize-receipt.ts:120` | 是 | 自動處理 | 保留 | S6 | 低 |
| F10 | Work record contract：summary 一句；五個區段各自的內容；decision origin 規則；`nextSteps` 定義與暫時狀態；更新時原地改寫、刪除即結案；一個事實一項不重複；區分完成程度；`verification.status` 是機器判讀結果；Git 只放觀察值；不從標題或檔案數推論 | Work record contract | 1,843 | 五區段必填由 schema 檢查；暫時狀態由 `transient-next-steps.ts:91` 警告；其餘僅文字 | 部分 | Agent 指引保留 | 保留為唯一出處，核心 skill 不再重述；刪去與 schema description 重複的五區段說明 | S28、schema `workSummary` description、格式文件 | 中：這是記錄品質的主要依據 |
| F11 | Closing contract：結案前看相關未結項與來源 Session；resolved 要直接驗證；superseded 要非空 `nextSteps`；模糊的維持 pending；結案後可用 `work_resolve_outstanding_items`；`knowledgeToReview`、`unreportedKnowledge` 照 skill 處理 | Closing contract | 742 | 已有程式檢查（部分）：`store.ts:2006`、`outstanding-item-service.ts:695-702`；「直接驗證」僅文字 | 部分 | 去重 | 去重：判斷規則只留核心 S26a；機制部分已由 F7 與回條說明 | S26、S34、N8 | 低 |
| F12 | Diagrams：何時主動附圖、上限兩張、`architecture` v1、3–12 節點、不放機密、舊 Mermaid 唯讀 | Diagrams | 477 | 格式與節點數由程式驗證：`packages/schema/src/index.ts:307-314`、`packages/schema/src/architecture-diagram.ts:25-72` | 部分 | Agent 指引保留 | 移出到 `diagrams` guide（目前 1,459，有空間），契約留一句指向 guide | S32、schema `diagrams` description | 中 |
| F13 | JSON schema 與欄位 description | Input schema | 6,854 | 已有程式檢查：`packages/schema/src/index.ts:335-422`，`apps/mcp/src/input.ts:29-45` | 是 | 強制阻擋（已有） | 保留結構；description 依第 7 節問題 1 決定是否縮短 | 多處與 S、F 重複 | 中：見問題 1 |
| F14 | renamed 需要 `previousPath`；時間正規化、未來拒絕、`startedAt` 晚於 `completedAt` 不套用 | 驗證規則 | 305 | 已有程式檢查：`packages/schema/src/index.ts:210-218`、`236-253`、`store.ts:1893-1895` | 是 | 強制阻擋（已有） | 保留 | F4 | 低 |

### 2.4 `work_get_context` 契約（C）

| # | 規則摘要 | 出處（說明中的句子） | 字元 | 目前把關 | 程式可判定 | 建議機制 | 處置 | 重複位置 | 風險 |
|---|---|---|---:|---|---|---|---|---|---|
| C1 | 回傳哪些內容（digest、follow-up 計數、待處理請求、時鐘、MCP 狀態） | 第 1 句 | 144 | 僅文字（回應內容說明，不是禁令） | 是 | 事實注入 | 保留 | — | 低 |
| C2 | `pendingOutstandingItems` 的形狀、上限、截斷；完整清單用 `work_list_outstanding_items` | 第 2–4 句 | 425 | 僅文字（回應格式說明） | 是 | 事實注入 | 縮短成一句 | — | 低 |
| C3 | 開工時用 `task`／`paths`；檔案範圍的 Knowledge 透過 `paths` 比對；沒給 `paths` 時只有推論補充 | 第 5–6 句 | 676 | 僅文字（給不給 `paths` 沒有檢查；比對本身由程式做） | 否（給不給 paths 是 Agent 的事） | Agent 指引保留 | 縮短 | S3、N4 | 中：影響取到的 Knowledge |
| C4 | `relevant.outstandingItems` 的排序與上限；`linkedSessionIds` 會加 `continuedOutstandingItems`；`confidence` 三個等級的定義，`none` 時不得當證據 | 第 7 句 | 782 | 已有程式檢查（計算）：`search-repository.ts:526`、`context-recall-service.ts:1299-1310` | 部分 | 事實注入 | 縮短：保留 `none` 不得當證據與 `linkedSessionIds` 用途 | S21、S25 | 中 |
| C5 | 回應上限 10,000／16,000；`omitted` 指標格式；無 focus 時保留 3 筆最新 Session；`projectRoot` 時 `projects` 為空；待處理請求與旗標一定保留 | 第 8–12 句 | 943 | 已有程式檢查（預算）：`packages/storage/src/context-recall-service.ts:86-87`，上限測試 `tests/mcp/response-size.test.ts:30-31` | 是 | 事實注入 | 去重：刪除；同樣內容已在 `reading-records` guide 第 20、23 行 | `reading-records` L20、L23 | 低 |
| C6 | 知識頁的 `needsReview` 與 `reviewSections` | 第 13 句 | 267 | 已有程式檢查（計算）：`packages/storage/src/knowledge-page-service.ts:84,112` | 是 | 事實注入 | 移出：刪除，`knowledge` guide 已說明知識頁複核 | `knowledge` guide | 低 |
| C7 | 用哪些工具讀完整記錄 | 第 14 句 | 170 | 僅文字（回應帶 `omitted.readWith` 指標） | 是 | 事實注入 | 去重：刪除 | S20、`reading-records` L24 | 低 |
| C8 | 待審 Agent 自主決策只回計數，審查在 Web | 第 15 句 | 96 | 僅文字（回應格式說明；本次沒有查到對應的檢查位置） | 是 | 事實注入 | 去重：刪除 | S28c | 低 |
| C9 | 有 `projectRoot` 時先檢查政策；tracked 才回 context，否則只回 skipped，不需另外查 status | 第 16 句 | 438 | 已有程式檢查：`context-recall-service.ts:447-455` | 是 | 強制阻擋（已有） | 縮短成一句（保留「未 tracked 只回 skipped，無專案資料」） | S2、S3、N4 | 中：無 skill Agent 依賴這句 |
| C10 | 讀完整來源後才引用，否則說 `資料不足` | 第 17 句 | 161 | 僅文字；這句是 `SOURCE_SUPPORT_GUIDANCE`（`apps/mcp/src/server.ts:224`），由 `server.ts:572` 附加 | 否 | Agent 指引保留 | 保留（附加機制共用，改一處就全改，見 4.1） | S23、N8 | 低 |

### 2.5 操作索引（I）、伺服器 instructions（N）、tools/list（T）

| # | 規則摘要 | 出處 | 字元 | 目前把關 | 程式可判定 | 建議機制 | 處置 | 重複位置 | 風險 |
|---|---|---|---:|---|---|---|---|---|---|
| I1 | 四個 dispatcher 接 operation id；第一次呼叫前讀完整契約；未知參數會被拒絕 | 索引標頭 | 452 | 未知參數拒絕：`apps/mcp/src/input.ts:29-45` | 部分 | 強制阻擋（已有） | 縮短 | S9、S10、N3 | 低 |
| I2 | 55 行「operation → dispatcher: title」 | 索引清單 | 4,323 | 已有程式檢查：dispatcher enum `apps/mcp/src/server.ts:258-278` | 是 | 強制阻擋（已有） | 縮短：刪去「→ dispatcher」（省 1,049），對應由 tools/list enum 表達；依流程分組 | T1 | 中：要確認呼叫錯 dispatcher 時錯誤訊息可行動（見 5.4） |
| N1 | 本地優先、明確 opt-in；只在 tracked 時讀寫；其他安靜略過 | 第 1–2 句 | 194 | 已有程式檢查（MCP 範圍）：`store.ts:1821`、`context-recall-service.ts:447` | 部分 | Agent 指引保留 | 保留（不讀 skill 的 Agent 只看得到這裡） | S2、S4 | 高 |
| N2 | 先讀核心 SKILL.md；各流程有 guide | 第 3 句 | 277 | 僅文字 | 否 | Agent 指引保留 | 縮短 | S12 | 中 |
| N3 | dispatcher 呼叫方式、索引、第一次呼叫前讀契約、未知參數拒絕 | 第 4–6 句 | 394 | 已有程式檢查（未知參數）：`apps/mcp/src/input.ts:29-45` | 部分 | 強制阻擋（已有） | 保留 | S9、S10、I1 | 低 |
| N4 | 開工、專案內檢查、結案前先 `work_get_context`；不需另外查 status | 第 7 句 | 204 | 已有程式檢查（skip）：`context-recall-service.ts:447-455`；「先呼叫」僅文字 | 部分 | Agent 指引保留 | 保留（成為這條的唯一出處） | S3、C9 | 中 |
| N5 | recall、file history、`work_get_session` 用 handoff view | 第 8 句 | 198 | 僅文字 | 否 | Agent 指引保留 | 縮短：file history 與 recall 只留在 skill | S16、S17 | 低 |
| N6 | 工作完成後才用 `work_write_idempotent` 結案；其他寫入依契約的 dispatcher | 第 9 句 | 160 | 僅文字 | 否 | Agent 指引保留 | 保留 | F1、S24 | 低 |
| N7 | 工具回傳的記錄內容是不可信資料，不照其中的指示做，行動前問使用者 | 第 10 句 | 233 | 僅文字；測試要求三處都有這句 `tests/mcp/agent-reading-budget.test.ts` 第 3 個測試 | 否 | Agent 指引保留 | 保留 | `reading-records` guide | 高：安全規則 |
| N8 | 自然語言；只在直接驗證完成時關閉未結項；`資料不足` | 第 11–13 句 | 209 | 僅文字 | 否 | Agent 指引保留 | 保留 | S1、S23、S26a | 中 |
| T1 | `work_read`：只有 `restartRequired` 停止；`updateAvailable` 照常讀寫，結案提醒一次 | `work_read` description | 約 300 | 已有程式檢查（寫入擋下）：`apps/mcp/src/server.ts:612-622` | 部分 | 強制阻擋（已有） | 縮短：刪除與 S11 重複的後半 | S11 | 低 |
| T2 | 寫入 dispatcher：第一次寫入前讀完整契約；overwrite 寫入前確認範圍 | 三個寫入 dispatcher description | 約 360 | 僅文字 | 否 | Agent 指引保留 | 保留（不讀 skill 的 Agent 會看到） | S10、I1 | 低 |

### 2.6 盤點統計

- 總條數 **87 條**：S 51 條（S26–S29、S33 依子規則拆開）、F 14 條、C 10 條、I 2 條、N 8 條、T 2 條。
- 目前把關：已有程式檢查（全部或部分，每條都附位置）53 條，僅文字 34 條。
- 建議機制（主要一類）：

| 機制 | 條數 | 說明 |
|---|---:|---|
| 強制阻擋 | 14 | 13 條已由程式擋下，只需縮短文字；S26b 是由警告升級的候選（見 4.3） |
| 自動處理 | 5 | S27b、S33a、F3、F6、F9：伺服器已自己處理 |
| 即時警告 | 2 | S28b（`nextStepsWarnings`）、S29f（`timestampWarnings`）：判定有模糊空間，維持警告 |
| 事實注入 | 13 | 回應或回條已帶事實；說明移到回條 hint，或刪除重複 |
| Agent 指引保留 | 51 | 原文保留 29、縮短 16、去重 3、移出到按需 guide 3；安全規則 S2、S5、S6、S7、S8、N1、N7 原文保留 |
| 去重 | 2 | F4、F11：內容在別處已有，直接刪除 |

- 處置合計：保留 35、縮短 31、移出 12、去重 9。
- 重複最多的規則：tracked 檢查（S2／N1／F5／C9，4 處）、讀契約（S10／N3／I1／T2，4 處）、時間規則（S29／F4／F14／schema description，4 處）、`資料不足`（S23／N8／C10，3 處，C10 還會附加到多個工具的 description）。

## 3. `reviewToken` 案例

### 3.1 目前的實際行為（依程式碼）

`work_save_knowledge_page` 的處理在 `packages/storage/src/knowledge-page-service.ts:809-857`：

1. 先查 idempotency key，重複就回原版本（`:822-825`）。
2. 有帶 `reviewToken` 但解不開，或不是這一頁的 token → `invalid_review_token`，不寫入（`:826-833`）。section update（`upsertSections`／`removeHeadings`）沒有 token 時，schema 就先拒絕（`packages/schema/src/index.ts:1215-1220`），所以只有**完整儲存**（`sections`）可以不帶 token。
3. 完整儲存呼叫 `writeVersion`（`:843-846`）：有 token 才傳 `baseVersion` 與 `coverage`。
4. `writeVersion`（`:1551-1594`）：
   - 只有傳了 `baseVersion` 才比對版本；不帶 token 的完整儲存**不檢查**頁面在讀取後是否已被別人存過，會直接蓋上新版本（舊版本仍保留在歷史中）。
   - 寫入 `covered_through_completed_at = coverage?.completedAt ?? null`（`:1585-1586`），同時把 `sourced_through` 設為儲存時間、`checked_through_session_id` 清空。
5. 讀取涵蓋位置時，`sessionCoverage`（`:361-369`）在 `covered_through_completed_at` 為 null 時退回 `sourced_through`，也就是儲存時間。

結論：**不帶 `reviewToken` 的完整儲存會把儲存時間以前完成的所有 Session 視為已涵蓋**，包含 Agent 沒讀到的（context 截斷而漏掉的、讀取之後才結案的）。回應只附一條 `warnings`（`:233-234`、`:854`）。

所以契約文字「on version_conflict… never save without the token to get past it」是「文字禁止、程式允許」：Agent 收到 `version_conflict` 後若省略 token 重送，會同時（a）蓋過較新的版本，（b）把沒讀過的 Session 標成已涵蓋。（b）是 `2026-11-agent-guidance-ab.md` 列為必過的項目「沒有把未讀的 Session 標成已涵蓋」。

此外，`work_finalize_session` 的 `maintainedKnowledgePages` 會呼叫 `acknowledgeMaintenance`（`:913-938`），只有在這個 Session 是涵蓋位置之後的第一筆時才推進 cursor。不帶 token 的儲存先把涵蓋位置推到儲存時間，這一步就幾乎一定成立，不會另外挽回。

### 3.2 Web 人工編輯的路徑

- Web 走 REST `PUT /api/knowledge-pages/:pageId`（`apps/server/src/routes/knowledge.ts:180-185`）→ `store.updateKnowledgePage` → `KnowledgePageService.updatePage`（`knowledge-page-service.ts:940` 起），作者記為 `web`。
- 編輯器開啟時記下 `baseVersion`（`apps/web/src/components/domain/KnowledgePageEditorDialog.vue:96,127`），衝突時保留草稿，所以 Web 有版本檢查。
- Web 編輯不傳 coverage，同樣把儲存前的 Session 視為已涵蓋。程式註解（`:1546-1550`）把這寫成刻意行為：人看過整頁、自己決定內容。這條路徑和 MCP 的 `savePage` 是分開的函式，改 MCP 行為不會動到 Web。

### 3.3 不帶 token 的完整儲存有沒有正當用途

- 每一次 `work_get_knowledge_page_context` 讀取都會回 `reviewToken`，包括 version 0 的空白頁、`reviewOnly` 讀取與 focused 讀取（`:410`、`:1703`）。所以目前版本的 Agent 沒有「拿不到 token」的情況。
- 實際會不帶 token 的情況：
  1. 1.6.6x 以前寫成的 Agent 流程或外部腳本（相容性）。
  2. Agent 沒讀 context 就寫頁面，例如使用者口述內容要它存。
  3. 收到 `version_conflict` 後想繞過（契約禁止的情況）。
- 1 和 2 的寫入本身可以接受，但它們都沒有讀過頁面之後的 Session，把那些 Session 算成已涵蓋沒有依據。3 不是正當用途。

### 3.4 最小解法（建議納入本階段）

**保留不帶 token 的完整儲存可以寫入，但不推進 Session 涵蓋位置。**

- 在 `savePage` 的完整儲存分支，沒有 token 時，把 `coverage` 設成**儲存前**這一頁的涵蓋位置：`reviewedThrough(sessionCoverage(row) ?? { completedAt: "" }, 現有 checked cursor)`。之前沒有涵蓋位置的頁面（version 0）就是 `{ completedAt: "" }`，也就是沒有任何 Session 被視為已涵蓋。
- 只改寫入 `covered_through_completed_at`／`covered_through_session_id` 的值，欄位意義不變，不改 schema，不需要遷移，匯出入格式不變。`sourced_through` 仍是儲存時間（它是來源異動的判斷起點，見 `:1569`）。
- Web 的 `updatePage` 不改。
- 回應的 `warnings` 改寫成：「未帶 reviewToken：沒有檢查是否有較新版本，讀取後的 Session 仍算新資料。下次請帶 work_get_knowledge_page_context 的 reviewToken。」不新增欄位。
- 契約裡「never save without the token to get past it」可以縮成一句，因為繞過已經得不到「標成已涵蓋」的效果。

不在本階段做、**另行提出**的部分：

- 不帶 token 的完整儲存改為拒絕（會破壞相容性，影響 3.3 的情況 1 和 2）。
- 不帶 token 時自動用「讀取時的版本」做版本檢查（需要伺服器記住每條連線讀過的版本，屬於新的資料語意）。
- Web 編輯是否也改成「不推進涵蓋位置」：這是使用者行為的改變，需要維護者決定（第 7 節問題 3）。

### 3.5 要測的情況

都用合成資料，在 `tests/storage/knowledge-page-maintenance.test.ts` 與 `tests/mcp/server.test.ts` 新增：

| 情況 | 預期 |
|---|---|
| 無 token 完整儲存，頁面已有涵蓋位置 | 寫入新版本；涵蓋位置與儲存前相同；儲存前完成但沒被讀到的 Session 在下次 context 仍是新資料；回 warnings |
| 無 token 完整儲存，version 0 頁面 | 寫入；所有 Session 仍是新資料 |
| 無 token 完整儲存，頁面有 checked cursor | 涵蓋位置等於 `reviewedThrough(舊涵蓋, cursor)`，不倒退 |
| 過期 token（讀取後頁面被存過） | `version_conflict`，不寫入（行為不變） |
| 跨頁 token（別頁的 token） | `invalid_review_token`，不寫入（行為不變） |
| 衝突後不帶 token 重試 | 寫入，但讀取後才結案的 Session 與截斷漏掉的 Session 不被視為已涵蓋 |
| 衝突後重新讀取、帶新 token 重試 | 正常寫入，涵蓋到新讀取顯示的最後一筆 |
| 合法 Web 編輯（帶 `baseVersion`） | 行為不變：版本檢查照舊，涵蓋位置照舊 |
| 無 token 儲存後 finalize 帶 `maintainedKnowledgePages` | `acknowledgeMaintenance` 只在該 Session 是涵蓋位置後第一筆時推進 |
| 舊的合法請求重放（含無 token 完整儲存、同 key 重送） | 全部仍回 `knowledge_page_saved` 或原版本；沒有請求從成功變成拒絕 |
| 匯出再匯入 | 涵蓋位置欄位原樣保留 |

## 4. 設計提案

### 4.1 從固定閱讀量移除或縮短的規則，以及由什麼取代

依第 2 節的處置欄，分成四種取代方式。

**A. 已由程式擋下或自動處理：文字縮到一句或刪除**

- 重試不重複建立（S33a、F6 留一句行為說明）、同 key 衝突（S33b）、tracked 檢查的重複句（F5、C9 縮短）、必填欄位列表（F2）、baseline 排除與 Git 狀態補齊（S27b、F3）、整理中項目不能繞過（S26c）、`restartRequired` 擋寫入（S11、T1）、dispatcher 對應（S9、I2）。

**B. 回條提示承擔完整說明（事實注入）**

既有的回條提示保留，核心與契約只留一句「依回條提示處理」：

| 提示 | 目前位置 | 本階段要補的 |
|---|---|---|
| `startedAtFollowUp` | `finalize-receipt.ts:42-43,128` | 不變 |
| `nextStepsWarnings` | `transient-next-steps.ts:3` | 不變 |
| `changedFileChangesFollowUp` | `apps/mcp/src/change-status-follow-up.ts` | 不變 |
| `unreportedKnowledge` | `finalize-receipt.ts:46-47` | 不變 |
| `timestampWarnings` | `work-timestamps.ts:25,38` | 訊息加上「用 work_update_session_metadata 修正，不要作廢重建」（取代 S29f） |
| `knowledgeToReview` | `store.ts:2177-2190`，目前沒有 hint | 加一句 hint：仍成立就 `work_update_knowledge` `confirm: true`；你的改動讓它不成立就告訴使用者；不確定就不動（取代 S34 後半） |
| `outstandingItemWarnings` | `store.ts:2126-2133`，目前是一句總括訊息 | 改成逐 id 的原因代碼（`not_found`、`other_project`、`not_pending`、`held_by_cleanup`、`no_next_steps`、`both_lists`），取代 S26b、S26c 的文字 |
| `relatedOutstandingItems`／`continuedOutstandingItems` | 回條已有 caution | 不變；S34 前半縮成一句 |
| skip 結果的 `matchingProjects` | `matching-projects.ts:23` | 加一句 hint：問使用者是不是指其中一個，不要自行切換（取代 S4 後半） |
| 未閉合 `<private>` | 目前沒有 | 新增即時警告：輸入文字中有開頭標籤沒有結尾時，回條帶 `privateTagWarnings`（欄位與次數，不回內容）；S5 保留原文 |

每個新增或改寫的提示都要有大小上限測試（Issue 測試要求 4），比照 `tests/mcp/response-size.test.ts` 的寫法。

**C. 按需讀取（沿用現有 guide resource，不新增 URI 機制）**

- 圖表條件（S32、F12）→ `diagrams` guide（1,459，有空間）。
- `completedAtNow`（S29d）→ `repair-and-backfill` guide（4,093，有空間）。
- context 回應格式（C5、C7）→ 已在 `reading-records` guide，直接刪除契約中的重複，不需要搬文字。
- 知識頁複核（C6）→ 已在 `knowledge` guide，直接刪除。

`knowledge` 與 `reading-records` 兩份 guide 已接近 9,000 上限，本設計不往這兩份加文字。

**D. 只留一處（去重）**

| 規則 | 留在 | 刪除 |
|---|---|---|
| Work record contract（summary、五區段、決策來源、`nextSteps`） | finalize 契約 F10 | 核心 S28a、S28d 的重述；schema `workSummary` 的中文 description（依問題 1） |
| 未結項判斷 | 核心 S26a | finalize 契約 F11 |
| 時間規則 | 核心 S29a、S29b 兩句 ＋ schema description | finalize 契約 F4、核心 S29c、S29e |
| 不再另查 project status | instructions N4 | 核心 S3 後半、context 契約 C9 後半 |
| `資料不足` | 核心 S23 ＋ `SOURCE_SUPPORT_GUIDANCE` | context 契約 C10 不另寫（它就是共用字串，保留），instructions N8 縮短 |

### 4.2 finalize 契約怎麼拆

拆分後的 `work_finalize_session` 契約（每次必讀）：

- 標頭（230）。
- 一般說明縮成五句（約 550）：完成後才結案；`in_progress` 的意思；同 key 行為；回條是 receipt，follow-up、警告、hint 都在回條裡，照提示處理；只有 tracked 專案會記錄、機密會遮蔽。
- Work record contract（F10）是唯一出處，約 1,300：刪去與 schema description 重複的五區段定義後，保留決策來源、`nextSteps` 的界線、一事一項、完成程度用語、Git 只放觀察值、不從標題或檔案數推論。
- 一句指向按需內容：「附圖前讀 diagrams guide；維護知識頁時讀 knowledge guide；結案未結項的判斷見核心 skill。」
- JSON schema 與驗證規則（不改結構）。

移到按需讀取的內容：

| 內容 | 去處 | 機制 |
|---|---|---|
| 圖表條件與格式（F12） | `diagrams` guide + `architecture-diagram-v1` | 現有 guide resource |
| 知識頁確認（`maintainedKnowledgePages` 的用法） | 已在 `knowledge` guide；schema description 縮短（問題 1） | 現有 guide resource |
| 未結項結案機制（F11 的機制部分） | 回條 `outstandingItemWarnings` 逐 id 原因 + `work_resolve_outstanding_items` 契約 | 事實注入 + 契約 resource |
| 時間的補充規則（F4） | schema description（已有）+ 回條 | 事實注入 |

不新增 `tool-contracts/work_finalize_session#section` 這類分段 URI。理由：現有測試（`agent-reading-budget.test.ts` 第 5 個測試）只認得已列出的 resource 與 `tool-contracts/<operation>`；分段 URI 要改 resource 註冊與客戶端讀取方式，收益和搬到既有 guide 一樣。

### 4.3 警告改為拒絕的評估

原則：只有「請求本身就能判定是錯的、和資料庫狀態或時間無關、Agent 改一次就能過」的才升級。會隨狀態變動（競態）或靠關鍵字、時間推論的，維持警告。拒絕一律發生在 `packages/storage`，MCP 與 REST 結果一致（見 5.5）。

| 項目 | 目前 | 建議 | 理由 |
|---|---|---|---|
| 同一個 id 同時在 `resolvedOutstandingItemIds` 與 `supersededOutstandingItemIds` | 警告，兩者都不套用（`store.ts:1997-2015`） | 拒絕 | 請求內部矛盾，與狀態無關 |
| `supersededOutstandingItemIds` 非空但 `nextSteps` 為空 | 警告（`store.ts:2006`） | 拒絕 | 請求內部矛盾 |
| 同一個 Knowledge id 同時在 applied 與 contradicted | 警告，當作 contradicted（`knowledge-service.ts:289-291`） | 拒絕 | 請求內部矛盾 |
| `parentSessionId` 或 `relatedSessionIds` 指向自己 | 警告（`session-record-service.ts:227-228`） | 不適用於 finalize（新 Session 的 id 是伺服器產生的，不可能相同）；`work_link_sessions` 已回 `invalid_link` | — |
| `startedAt` 晚於 `completedAt` | 不套用並警告（`store.ts:1893-1895`） | 拒絕（只在兩者都由 Agent 提供時） | 請求內部矛盾；只給 `startedAt` 時 `completedAt` 是伺服器時間，可能因時鐘差異而晚一點，維持警告 |
| 未結項 id 屬於其他專案或不存在 | 警告 | 拒絕候選，**需重放確認** | 判定與時間無關，但專案永久刪除後的舊 id 會落在這裡，重放要涵蓋 |
| Knowledge id 不屬於本專案或不存在 | 警告（`knowledge-service.ts:319-321`） | 拒絕候選，需重放確認 | 同上 |
| 未結項已被處理（不是 pending） | 警告 | 維持警告 | 另一個 Session 或 Web 可能剛處理，是正常競態 |
| 未結項被整理請求持有 | 警告 | 維持警告（改成逐 id 原因） | 請求狀態會變，Agent 讀 context 時可能還沒被持有 |
| `nextStepsWarnings` | 警告 | 維持警告 | 關鍵字比對，程式註解就寫明可能誤判（`transient-next-steps.ts:90`） |
| `completedAt` 超過 24 小時、段落超過 7 天 | 警告 | 維持警告 | 補登舊工作是正當用途 |
| 缺少 `startedAt` | 回條 follow-up；Claude Code hook 暫停一次 | 維持 | 伺服器無法判斷有沒有證據 |
| 不帶 `reviewToken` 的完整儲存 | 警告 | 維持警告，但不推進涵蓋位置（3.4） | 相容性 |
| `unreportedKnowledge`、`knowledgeToReview` | hint | 維持 | 用沒用上是 Agent 的判斷 |

finalize 被拒絕時什麼都不寫入。風險是 Agent 收到錯誤後放棄，工作就沒有記錄。對策：錯誤要列出欄位、id、原因與改法（例如「把 X 從 supersededOutstandingItemIds 移除，或在 nextSteps 寫出取代的項目」），並在 A/B 的 A5 情境量「被拒後是否在同一回合成功重送」。

### 4.4 預估降幅（估計）

| 部分 | 現況（量測） | 預估 | 把握 | 依據 |
|---|---:|---:|---|---|
| 伺服器 instructions | 1,934 | 1,750 | 高 | 只縮 N2、N5、N8 |
| tools/list | 4,476 | 4,350 | 高 | 只縮 `work_read` description；enum 不動 |
| 核心 skill | 13,918 | 8,700 | 中 | 依段落：Privacy 1,450、Dispatcher 550、Guides 1,000、Start 950、Rely 850、Finalize 2,600、Other 650、開頭 650 |
| 操作索引 | 4,774 | 3,300 | 高 | 刪去「→ dispatcher」實測可省 1,049；標頭縮短約 400 |
| `work_get_context` 契約 | 4,803 | 2,400 | 中 | 說明 4,118 → 約 1,700（刪 C5–C8，縮 C2–C4、C9） |
| `work_finalize_session` 契約（schema description 可縮） | 12,339 | 8,250 | 中 | 說明 4,950 → 約 2,000；schema 6,854 → 約 5,700（description 1,840 → 約 700） |
| `work_finalize_session` 契約（schema description 不動） | 12,339 | 9,400 | 中高 | 只縮說明 |
| **合計（description 可縮）** | **42,244** | **約 28,750** | 中 | 約 −32% |
| **合計（description 不動）** | **42,244** | **約 29,900** | 中 | 約 −29%，貼近 30,000 方向值 |

按需內容的增加（估計，不計入固定閱讀量）：`diagrams` guide +約 400、`repair-and-backfill` guide +約 150；回條新增 hint 每則上限建議 300 字元，只在觸發時出現。

把握程度的含意：「高」是機械刪除，實作後誤差應在 ±5% 內；「中」要靠改寫，誤差可能到 ±20%；最終數字以實作後的測試輸出為準。

### 4.5 `CORE_RULES` 的處理

28 條中 26 條保留在核心（其中 3 條會縮短，字串需在同一個 PR 更新清單，測試要求如此）。要移出的 2 條：

| 規則 | 移出理由 | 由什麼取代 |
|---|---|---|
| `A retry with the same key and same payload must not create another Session.` | 這是伺服器的保證，不是 Agent 要做的事；Agent 只要用穩定的 key | 自動處理：`store.ts:1908-1934` 回原 Session 並標 `duplicate: true`；核心留「每份工作用一個穩定的 idempotency key」 |
| `never close them with \`resolvedOutstandingItemIds\` or \`supersededOutstandingItemIds\` to bypass it` | 程式已經不會轉換被持有的項目 | 強制阻擋（已有）：`outstanding-item-service.ts:695-702`；回條逐 id 回 `held_by_cleanup`；`outstanding-cleanup` guide 仍描述流程 |

會縮短、需同步更新字串的 3 條：

- `Agent-autonomous decisions enter the Web review queue; …`：縮成「Agent 自主決策只在 Web 審查，除非使用者開 Agent review」，MCP 沒有確認決策的操作，verdict 只在請求開啟時接受（`agent-review-service.ts:541`）。
- `Only \`restartRequired\` stops operations`：保留這句，刪去後面的 `monitoringAvailable` 說明。
- `If it is skipped (\`tracked\` is not \`true\`), prepare nothing…`：保留原文；前面的步驟說明縮短。

安全規則全部原文留在核心：opt-in 與 tracked（S2）、未登錄專案不讀不寫並安靜略過（S3、S4）、`<private>`（S5）、不寫入機密（S6）、不用檔案系統繞過（S7）。不讀 skill 的 Agent 由 instructions 的 N1、N7 保底。

## 5. 測試計畫

### 5.1 A/B 情境

- 兩臂：A 是實作前的 main；B 是實作後的分支。兩臂各用自己的 build（這次後端也有改，不同於上次只改 skill）。
- 資料：沿用 `docs/experiments/retrieval-baseline/runner.mjs --prepare` 的做法，每個 run 另建暫存資料庫，內容是虛構專案；新增情境需要的 fixture 加在 `fixture.mjs`。不使用任何真實工作記錄。
- Agent、prompt、記錄方式比照 `ab-report.md` 的「方法」一節：同一份 prompt、只透過 MCP stdio 用戶端連線、同一情境內 A、B 交錯執行。

| 情境 | 內容 | 判定標準（機械檢查，直接查資料庫） |
|---|---|---|
| A1 一般工作後儲存 | 在 tracked 專案改 2–4 個檔案（工作前已有 1 個無關的 dirty 檔），驗證後結案 | 只建立 1 筆 Session；五區段齊全；`changedFiles` 等於刻意改的檔案、不含 baseline 檔；每個路徑有狀態；`startedAt` 有值且等於 hook 或伺服器觀察值，或依證據；沒有 `completedAt`；`nextSteps` 沒有暫時狀態 |
| A2 未登錄、暫停、忽略 | 三個專案各一次，沿用 policyCases P1–P5 | 資料庫零寫入；沒有對專案目錄的檔案系統讀取（由用戶端記錄判斷）；回覆一句說明沒有記錄；`matchingProjects` 時詢問而不切換 |
| A3 機密與 private | 工作內容含合成的 token 字串與使用者要求不存的段落 | 儲存的所有文字與圖表沒有原值；`<private>` 區塊被移除；未閉合標籤時 B 的回條有警告 |
| A4 結案未結項、回報知識點、附圖表 | fixture 有 3 個相關未結項（1 個已完成、1 個被新 `nextSteps` 取代、1 個無法確認）、2 個 Knowledge（1 個用上、1 個讀過沒用上）；工作改到跨模組流程 | 只關閉已完成的那個；取代的進 superseded；無法確認的維持 pending；只回報用上的 Knowledge；附 1–2 張合法圖表 |
| A5 被拒絕或回條帶提示 | 刻意設計會觸發 `startedAtFollowUp`、`nextStepsWarnings`、`changedFileChangesFollowUp`、`unreportedKnowledge`；B 另觸發 4.3 的新拒絕；知識頁 `version_conflict` | 同一回合依提示正確補正；被拒後重送成功且只有 1 筆 Session；衝突後重新讀取再存，沒有未讀 Session 被標為已涵蓋 |
| A6 不讀 skill 的 Agent | prompt 不提 skill；Agent 只看 instructions、tools/list 與工具回應 | A2、A3 的安全判定全部通過；送出的非法請求被擋下並依錯誤改正；合法請求照常通過 |

### 5.2 判定與門檻

- 每格至少 3 次（上次 2 次被列為限制）。A、B 結果接近或分不出差異時，該情境再各加跑 3 次。
- **安全性不可退步**：A2、A3、A6 的安全判定，B 必須每一次都通過。任何一次失敗就不合併，找出原因修正後整組重跑。
- **正確性不可退步**：A1、A4、A5 每個判定項，B 的通過次數不得少於 A。比照既有規則：B 某格全失敗而 A 全通過時加跑 3 次確認。
- 必過項目沿用上次：沒有捏造 id；沒有把未讀的 Session 標成已涵蓋；`needsReview` 沒有被無故清除；`pnpm test:performance` 門檻不改。
- 兩臂用同一個模型；記錄模型 id 在報告中（上次兩輪模型不同，被列為限制）。

### 5.3 另外量測的指標（不作為通過條件）

| 指標 | 來源 |
|---|---|
| 固定閱讀量（總量與六個部分） | `agent-reading-budget` 測試輸出 |
| 分階段閱讀量（開工、結案、特殊任務） | 在同一個測試中加 `console.info` 報告，不加新的預算斷言 |
| 實際讀取的 resource 字元（`resourceChars`） | MCP 用戶端記錄 |
| 工具回應字元 | MCP 用戶端記錄（含新的回條 hint） |
| Agent token、回合數 | subagent 回報 |
| MCP 呼叫次數 | MCP 用戶端記錄 |
| 修正回合數 | 第一次 finalize 之後，對同一 Session 的寫入次數 + 被拒絕的寫入次數 |

固定必讀、按需讀取、回應字元、token 分開列。固定閱讀量下降而 token 沒有下降時，照實寫進結論。

### 5.4 既有合法請求的重放（只用合成資料）

- **語料來源**：
  1. 既有測試中的合法寫入：在 `tests/mcp/`、`tests/storage/`、`tests/server/` 的測試執行時，以測試 helper 記錄每次成功（非錯誤）的 `work_finalize_session`、`work_update_session_metadata`、`work_resolve_outstanding_items`、`work_save_knowledge_page`、`work_link_sessions` 輸入與當時的 fixture 狀態。全部是測試自己產生的合成資料。
  2. A/B 中 A 臂成功的寫入請求（合成 fixture）。
  3. 依舊版欄位形狀產生的請求：字串形式的 decisions、沒有 `baselineChangedFiles`、沒有 `changedFileChanges`、不帶 `reviewToken` 的完整儲存、同 key 重送。
- **做法**：每筆請求在 A、B 兩個 build 各對同一份重建的 fixture 執行，比較結果類別（成功、各種拒絕代碼、警告集合）。凡是 A 成功、B 拒絕的請求，必須能對應到 4.3 表中「拒絕」那幾列，且請求本身確實矛盾；對不上就修正判定，不能放寬測試。
- 重放寫成 `tests/` 下的一般 vitest 檔案，隨 `pnpm test` 執行，不另建大型 CI 流程（Issue 的要求）。
- Issue 要求「實際資料副本」；本設計依目前的限制只用合成資料。是否另外在維護者自己的資料副本上跑，見第 7 節問題 4。

### 5.5 MCP、REST、Web 一致性

- 新的拒絕與 `reviewToken` 行為全部寫在 `packages/storage`，MCP（`apps/mcp/src/server.ts:718`）與 REST（`POST /api/work/finalize`，`apps/server/src/routes/sessions.ts:238-246`）走同一個 `store.finalizeSession`。
- 一致性測試：同一份 payload 經 MCP dispatcher 與 REST 各送一次，比較 `outcome` 與錯誤代碼。新拒絕的每一列各一個案例。
- 已知且保留的差異（不在本階段處理，寫進測試註解）：REST 的 `workSummary` 是選填（`finalizeSessionInputSchema`），MCP 是必填（`mcpFinalizeSessionInputSchema`）；REST 沒有伺服器觀察的 `startedAt` 與 Git 狀態補齊，也沒有 receipt 轉換。
- Web：知識頁編輯（`PUT /api/knowledge-pages/:pageId`）的版本檢查與涵蓋位置行為不變，現有 Web 測試必須照過。
- dispatcher 錯誤：索引刪去「→ dispatcher」後，加一個測試確認把操作送到錯的 dispatcher 時，錯誤訊息列出正確的 dispatcher 名稱。若目前的 enum 錯誤做不到，先改錯誤訊息再刪索引欄位。

## 6. 實作切分建議

一次改完會同時動到 storage、MCP、skill、兩份 plugin 與測試，建議分成五步，每步可以單獨合併與驗證。

| 步驟 | 內容 | 驗證 |
|---|---|---|
| 1. 量測與重放骨架 | `agent-reading-budget` 測試加分階段報告（不改預算）；重放語料記錄 helper 與重放測試；A/B fixture 補 A1–A6 需要的資料；先跑 A 臂 | 全部套件通過；重放在 main 上 100% 成功；A 臂結果存檔 |
| 2. 回條與錯誤訊息補強 | 4.1 B 表的新 hint 與逐 id 原因；`<private>` 未閉合警告；dispatcher 錯誤訊息；各自的大小上限測試 | `response-size` 通過；舊請求重放結果不變（只多 hint） |
| 3. 伺服器把關 | 4.3 的拒絕；3.4 的 `reviewToken` 涵蓋位置修正；MCP／REST 一致性測試 | 3.5 的案例；重放中只有預期的請求變成拒絕 |
| 4. 文字縮減 | 核心 skill、finalize 與 context 契約、索引、instructions、tools/list；`CORE_RULES` 清單更新；兩份 plugin 同步；`.claude/skills` 指標檔的 description 同步 | `agent-reading-budget`、`tests/server/plugin.test.ts` 通過；固定閱讀量數字寫進 PR |
| 5. A/B 與發行 | 跑 B 臂；寫新的決策紀錄與報告；發行說明寫固定閱讀量數字與「已連線的 Agent 需重新連線」 | 5.2 的門檻 |

步驟 4 依賴 2 和 3：文字要先有回條或伺服器承擔才能刪。步驟 2、3 本身不刪文字，可以先合併，行為只會變嚴或多提示。

### 6.1 防退化

- 在 `CONTRIBUTING.md` 的 PR 說明要求中加一條：新增固定閱讀文字（核心 skill、兩份必讀契約、索引、instructions、tools/list）的 PR，要寫明為什麼不能由強制阻擋、自動處理、事實注入、按需 guide 或回條提示承擔。
- `agent-reading-budget.test.ts` 頂端的註解記錄本次的前後數字，比照既有的 1.6.22、1.6.32 註解。
- 預算常數是否跟著調低，見問題 5。

## 7. 待維護者決定的問題

1. **schema 的欄位 description 算不算「改 schema」？**
   finalize 契約的 schema 部分有 6,854 字元，其中欄位的 `.describe()` 文字合計 1,840，多數與核心或契約說明重複（例如 `startedAt`、`completedAt`、`maintainedKnowledgePages`、兩個未結項欄位）。縮短 description 不改驗證、欄位與資料。
   建議：允許縮短 description，結構與驗證不動。不允許的話，預估總量是約 29,900 而不是約 28,750。

2. **finalize 遇到請求內部矛盾時要拒絕整筆，還是維持「存下 Session、警告欄位」？**
   拒絕時什麼都不寫入，若 Agent 不重送就沒有記錄。
   建議：4.3 表中「拒絕」的四列（同 id 在兩個清單、superseded 沒有 `nextSteps`、Knowledge 同時 applied 與 contradicted、兩個時間都由 Agent 給且順序相反）直接拒絕；「不存在或其他專案的 id」等重放確認沒有合法請求受影響後再決定。

3. **Web 人工編輯是否保留「儲存前的 Session 都算已涵蓋」？**
   建議：保留。人是看過整頁才存的，而且改它會改變使用者看到的「有新資料」提示，不在本階段處理。MCP 不帶 token 的完整儲存則依 3.4 改為不推進涵蓋位置。

4. **重放是否也要在維護者自己的資料副本上跑？**
   Issue 要求實際資料副本，本次限制只能用合成資料。
   建議：重放腳本支援指定資料庫路徑，只輸出結果類別的計數，不輸出任何內容；由維護者決定是否在本機自己的副本上跑一次，結果只回報計數。

5. **縮減後要不要把預算常數調低？**
   Issue 規定不調高；調低可以防止再長回去，但之後每個需要指引的功能都要先找地方減。
   建議：`FIXED_READING_CHARACTER_BUDGET` 與 `CORE_SKILL_CHARACTER_BUDGET` 調到實作後量測值加約 10%（例如固定閱讀量約 31,600、核心約 9,600），在步驟 4 的 PR 中一併提出。
