# R3 研究：把規則從「寫給 Agent 讀」改成「伺服器觀察或擋下」，以及用戶端落差

研究日期：2026-11-13。調查階段，只產出結論與可重複的量測設計，不改產品程式碼。

基準版本：`main` f06c112（1.6.32）。1.6.33 的「伺服器觀察變更檔狀態」尚未合併，在整合分支 `claude/jolly-pascal-18ob5z`（HEAD 7dc8af1），本文對受影響處另註「整合分支」。產品價值取向（使用者明定）：有效沉澱 → 精準再利用 → 持續修正，「越用越好用」最重要。

## 結論先行

### 主題 A（伺服器觀察／擋下取代 Agent 自律）

1. **問題確實存在且可量測。** 真實資料（639 筆 session、2026-07～11）顯示多個「靠 Agent 自報」的欄位缺漏率偏高：`agentModel` codex 幾乎 100% 缺、claude-code 11 月仍缺約 20%；`commitSha`／`gitBranch` 缺 7–25% 且長度不一（7／10／40 碼並存）、`commit_without_branch` 9%；decision origin 缺（unspecified）10% 上下。這些多半是**伺服器本可觀察或擋下**的事實型欄位。
2. **最該搬到伺服器的是 Git 事實類**（branch／commit／changedFiles／changedFileChanges／provenance／baseline）。整合分支已做了其中最小一塊（finalize 時用 Git 補 `changedFileChanges` 狀態），但 `readGitMetadata` 仍只讀 `.git/HEAD`＋loose ref，在 linked worktree 與 packed ref 下失效，且 Agent 自報值仍一律優先、無一致性核對。
3. **固定閱讀量（42,122／42,250）幾乎滿載，core（13,864／14,000）更只剩 136 字餘裕。** 把上述事實改由伺服器觀察後，可從 skill／合約刪除約 1,800–2,000 字（方案 A）；再把 finalize 合約拆成「每次必讀核心」與「出錯時由回條帶出的規則」可再省約 4,000–4,500 字（方案 B），兩案去重後約 −5,500～−6,500 字，固定閱讀可降到約 35,600–36,600。
4. **必須留給 Agent 的**：decision `origin`（語意，且標成 user_requested 會繞過審核，誘因不對稱）、「是否直接驗證完成」、`nextSteps` 內容、Knowledge 忠實度與「是否使用者要求」、是否該畫圖。這些不應由伺服器猜；伺服器只能事後量測或做必要條件檢查。

### 主題 B（用戶端落差）

適配範圍＝Claude Code、Claude Desktop、Codex；其他用戶端只放附表供參考。

1. **三個適配對象的能力差在 hook 與可查證程度。** Claude Code 2.1.323 已用 `claude` CLI 實測（clientInfo、hook payload、同行程多對話、只把 structuredContent 給模型）；Codex 以原始碼為準、未實機；Claude Desktop 依官方文件：hook 只能透過 plugin（Chat 對話自 1.52386.0 起），structuredContent 取捨與 instructions 是否注入未能查證。
2. **「最低保證」只能建立在 MCP 協定本身**（工具回應、伺服器時鐘、專案目錄的 Git），hook 是加值層。規格 2026-07-28 明文反對依 clientInfo 分支行為，也明文說 stdio 行程不是對話。
3. **雙軌回傳要用測試固定。** Claude Code、Codex 只把 structuredContent 給模型；稽核發現兩處 structuredContent 與 text 不一致（`session_unchanged` 少 title/projectId；finalize `skipped`／`idempotency_conflict` 被注入誤導的預設值），見 B-7。原本建議的用戶端 doctor 降為不建議（B-5）。

### 最值得先做的三件事（依對「越用越好用」的貢獻排序）

1. **修 `readGitMetadata`／`observeHeadCommit` 改用 `git rev-parse`，並讓伺服器在 finalize 核對 Git branch/commit 與 changedFiles（不覆蓋、只標來源與警告）。** 事實型、零語意、真實資料顯示缺漏與格式錯誤率最高，且能連帶鞏固整合分支已做的 changedFileChanges 觀察。先沉澱得準，再利用才準。
2. **把 finalize 合約拆成「每次必讀核心」＋「回條帶出的規則」，並把已可由伺服器觀察的欄位（startedAt、git、baseline）降為選填 override。** 直接縮短固定閱讀、替未來新規則騰出預算，是「越用越省、越用越好用」的結構性改善。
3. **修 structuredContent 的兩個落差，並把「structuredContent 是完整結果」寫成 MCP 測試斷言。** Claude Code 與 Codex 只讀 structuredContent，回條裡的 follow-up 與識別欄位一旦漏在 structuredContent 外，Agent 就看不到，「持續修正」的提示就斷了（B-7）。

---

## 主題 A

### A-1 問題大小（真實資料，唯讀彙總）

資料來自上層在私有副本上執行本研究隨附的唯讀腳本 `docs/experiments/observed-rules-field-gap-metrics.mjs`（只輸出數字、月份、正規化後的用戶端桶，不含 id／路徑／專案名／記錄文字）。總計 639 筆（排除 11 筆作廢），`agent_client` 不同值共 5 種。缺漏率（missing_rate）與錯誤率（error_rate）摘要：

| 欄位／檢查 | (missing) n333 | claude-code n230 | codex n76 | 說明 |
|---|---|---|---|---|
| agentModel 缺 | 1.00 | 0.135（11 月 0.197） | 0.987 | MCP 握手拿不到模型 |
| commitSha 缺 | 0.201 | 0.083 | 0.066 | Git 可觀察 |
| gitBranch 缺 | 0.162 | 0.070 | 0.013 | Git 可觀察 |
| commit_without_branch | — | 0.092（11 月） | — | 有 commit 卻沒 branch |
| changedFiles 缺 | 0.207 | 0.200 | 0.263 | 含「刻意空陣列」，見下 |
| changedFileChanges 缺 | 0.147 | 0.096 | 0.013 | 整合分支部分補 |
| changedFilesProvenance 缺 | 0.051 | — | — | 缺省補 `agent` |
| parentSession 缺 | 0.471 | 0.500 | 0.395 | 多數本無前筆，見判讀 |
| decisions_origin_missing | 0.036 | 0.103 | 0.117 | origin=unspecified |
| completedAt_backfilled_before_createdAt | 0.332 | 0.013（11 月 0.125） | — | 補記舊工作 |
| verification_not_final | 0.040 | — | — | in_progress/not_run |

provenance 來源分布（session_has_*）顯示 `agent` 為壓倒性多數、`git`／`worktree` 只是 Agent 自稱標籤；`start_source` 全部是 `reported_or_events`（資料取於 1.6.32 剛合併，server_observed 尚未普及）。

判讀（已與上層確認納入）：

- **agentModel** 是「必須靠 Agent 自報但自報率最低」的典型：codex≈100% 缺、claude-code 11 月仍缺約 20%。見 A-3 的可觀察性判斷。
- **changedFiles 缺漏率 15–39% 偏高是定義問題**：腳本把「刻意無變更（`[]`）」也算缺漏。已在腳本新增 `distributions.changed_files_shape`（`non_empty`／`empty_but_confirmed`／`empty_unconfirmed`）以區分「空且已確認」與「真的缺」，重跑可得真實缺漏率。
- **Git 欄位格式不一致**（commitSha 7／10／40 碼並存、commit_without_branch 9%）是伺服器完全可觀察的事實，列為優先。
- **completedAt 回補**在 11 月 claude-code 仍 12.5%；上一輪量到的「完成時間更正」111/112 次是往後推，兩者可能是同一批續做的 Session。腳本新增 `completedAt_backfill_gap` 區間分布（<1h／1-24h／1-7d／>7d）以判斷是補登舊工作還是估計值。
- **parentSession 缺 40–59% 不代表問題**（多數 Session 本無前筆）。有意義的是「實際延續卻沒連結」；需要的是代理指標（短時間內同專案、變更檔高度重疊卻無連結），本輪未實作，列為後續量測設計（A-4）。

### A-2 可觀察性矩陣（摘要）

完整逐列分析見下節表格。縮寫：S=`.agents/skills/work-intelligence/SKILL.md`；SC=`packages/schema/src/index.ts`；ST=`packages/storage/src/store.ts`；CD=`packages/storage/src/session-record-codecs.ts`。強制程度：無／schema／伺服器檢查／伺服器觀察／hook。

三個前提事實：

1. **main 上沒有「changed-file 狀態取自 Git」的實作**；`changedFilesProvenance` 的 `git`／`worktree` 是 Agent 自己宣告的標籤，缺省一律補 `["agent"]`（`CD:350-362`）。唯一的 Git 讀取是 `ST:2193 readGitMetadata`，只讀 `.git/HEAD` 與 loose ref。整合分支新增了 finalize 時用 Git 補 `changedFileChanges` 狀態（見 A-5）。
2. **1.6.32 的 startedAt 模式** = hook 取證據→暫停一次叫 Agent 抄回→伺服器 `SegmentObserver` 觀察值當 fallback→回條 `startedAtSource`。hook 無法替 Agent 填欄位，只能 deny＋訊息（repo 未用 `updatedInput`）。真正不經 Agent 手的只有伺服器端觀察。
3. **伺服器已有跨連線的觀察資料 `agent_read_audit`**（每次唯讀呼叫記 `tool, agent_client, project_id, session_ids, knowledge_ids`，30 天／5,000 列），目前只做統計，沒被任何寫入規則使用。可支撐「applied Knowledge／link／resolved 是否真的讀過」的必要條件檢查。缺點：沒有 conversation id，只有 client 名稱。

| 欄位／規則 | 現況強制 | 伺服器可觀察？來源 | 可擋規則 | 必須留 Agent？ | 主要誤判風險 |
|---|---|---|---|---|---|
| agentModel | 僅長度；無 | 否（握手無 model）；僅 hook／transcript | 只能擋形狀 | 目前是；hook 驗證後可由證據取代 | 模型中途切換、subagent、合成值 |
| agentClient | 伺服器觀察（已完成） | 是：MCP initialize clientInfo.name | — | 否 | name 仍是自報字串，但已是觀察 |
| decision origin | schema 三值；unspecified | 否（語意） | 無機械規則 | **是** | 標 user_requested 繞過審核（誘因不對稱） |
| verification status/summary | schema；缺值 follow-up | 否（測試在 Agent shell 跑） | passed/failed 要求 summary 非空 | 判斷涵蓋範圍留 Agent | 以指令結果推斷 passed＝估計 |
| git branch/commit/dirty | Agent 有給就信任 | **是**：專案根 Git | commitSha regex；核對 HEAD；branch 不符則警告 | 否 | worktree／packed ref 讀不到；工作期間又 commit；多對話同 checkout |
| changedFiles | schema 必填 | **是**：git status/diff；hook transcript editedFiles | 警告（宣稱不符、髒檔未認領）不靜默改寫 | 「有意的變更」意圖留 Agent | 多對話並行；commit 後 status 乾淨；submodule |
| changedFilesProvenance | enum；缺省補 agent | 部分：若伺服器自跑 Git | 核對宣稱的 git/worktree 是否屬實，否則降 agent | 否 | 現況 git/worktree 無法與 agent 區分 |
| changedFileChanges | schema（renamed 需 previousPath） | **是**：git diff --name-status -M | 核對 renamed/deleted | 否 | rename 相似度門檻；commit 後需區間 diff |
| baselineChangedFiles | 路徑排除；**不存** | **是**（最可取代）：首次 context 時快照 HEAD＋髒檔 blob hash | 與觀察不符則警告 | 無觀察時才退回 Agent | 共用程序把別對話修改當基準；首次呼叫晚於已編輯 |
| startedAt | schema 擋未來；hook 暫停；伺服器 fallback | **是**：hook transcript 時間／伺服器第一次呼叫 | reported 早於 observed→警告 | 無 hook 且無觀察時才是 Agent | 共用程序觀察值早於當前對話；觀察是「第一次呼叫」偏晚 |
| completedAt | 預設伺服器時鐘 | **是**：伺服器時鐘 | 已是伺服器值 | 補記舊工作要證據 | offset 寫成 Z 的時區錯位只能靠 >24h 警告 |
| events[].occurredAt（影響 startedAt） | 擋未來 | 否 | events 起點須≥觀察起點才接受 | 是 | Agent 把 event 時間編早 |
| parent/relatedSessionIds | 存在＋tracked；可跨專案 | 部分：read audit 證明讀過 | 未讀過的 id→警告；跨專案→警告 | 「有關係」語意留 Agent | audit 無 conversation id／30 天窗 |
| applied/contradictedKnowledgeIds | 同專案；更新 last_confirmed_at | 部分：read audit record_type=knowledge | applied 未讀過→不計入 | 「真的用上」語意留 Agent | 讀過≠用過；內文看到的會誤擋 |
| nextSteps 不含進度 | 無 | 否（語意） | 只能事後量測（建立後<1h 即 not_needed 的 proxy） | **是** | 啟發式誤傷合法項目 |
| resolvedOutstandingItemIds | 伺服器已查多項 | 部分：read audit 證明讀過來源 Session | 來源未讀過→警告 | 「直接驗證完成」留 Agent | audit 無 conversation id |
| idempotencyKey | 全域 UNIQUE；衝突回舊 | 部分：同專案同 title+summary | 不同 key 但內容完全相同→duplicate_suspected | 取值留 Agent（伺服器簽發會被共用程序併合） | 逾時重試換新 key 產生重複；key 跨專案（privacy） |
| `<private>` 標籤 | 伺服器移除成對；未閉合原樣存 | 是（文字本身） | 未閉合→警告或 fail-closed | 內容決定留使用者 | 自動 fail-closed 吞大段文字 |
| 秘密／個資 | 伺服器遮蔽多數欄位 | 是 | 補洞：changedFiles 路徑、git.branch、agentModel、idempotencyKey 未遮蔽 | 個資語意留 Agent | detector 假陽性 |
| 「只在使用者要求時記 Knowledge／整理」 | 無（Web 審核把關） | 否（意圖在對話中） | 無機械規則 | **是** | — |

判斷原則（伺服器觀察 vs 猜測）：

- **算證據**：MCP initialize 的 clientInfo；伺服器時鐘；專案根下 Git 的輸出與檔案系統；伺服器自己收過的呼叫（第一次呼叫時間、read/write audit）；hook 讀到的 transcript 與時間戳（須標來源）。
- **不算證據**：Agent 自報的任何欄位；伺服器依文字相似度／關鍵字推斷（判斷 nextSteps 是進度、判斷 passed）；把「Git 髒但無人認領」當本任務檔案。
- **落地方式**（與 1.6.32 一致）：伺服器只加註、標來源、發警告，不靜默改寫或補造 Agent 沒給的事實；補值時必標 `*Source`。

### A-3 agentModel 專節（為何難、能不能觀察）

- **MCP initialize 只給 clientInfo（name/version），沒有 model。** repo 只取 `clientInfo.name` 存 `agent_client`（`server.ts:535`），`version` 被丟掉（可無成本保存但仍不是 model）。
- **hook 各用戶端不一**（主題 B 詳述、我實測＋原始碼）：
  - Claude Code 通用 hook payload **沒有 model**，只有 SessionStart 選填 `model`、Pre/PostModelSwitch 有 `from/to_model`。
  - Codex 的 tool/session/prompt hook payload schema **都有 `model`（required）**。
  - Gemini 只在 BeforeModel/AfterModel 的 `llm_request.model`。
  - Claude Desktop 只有裝了帶 hooks 的 plugin 才有 hook，且同 Claude Code schema，共同欄位沒有 model；沒有 plugin 時完全拿不到。
- **transcript 有確切 model**：我實測 Claude Code transcript 每則 assistant 訊息 `message.model = claude-haiku-5-5`。但 repo 目前不讀 transcript 的 model，且 MCP server 與 hook 是不同程序、MCP 無 conversation id，marker 交接會落入「以專案為 key」的多對話混淆。
- **結論**：伺服器無法在 MCP 層直接填 agentModel。可行路徑都經 hook／transcript，且只對有 hook 的用戶端有效。建議：(a) 先保存 `clientInfo.version`（零成本）；(b) 若採 hook/transcript model，另存 `agent_model_source`（observed/reported）以便量測；(c) schema 可加形狀檢查擋掉「I am Claude」這類自然語句；(d) 不建議用 MCP sampling（多一次 LLM 呼叫＋核准，且回報的是 client 挑的 model）。風險與不確定性最高，排在 Git 類之後。

### A-4 可縮短的指引與結構性縮減（主題 A 第 2 題）

固定閱讀現況（UTF-16 單位，整合分支括號內）：

| 元件 | main | 整合分支 |
|---|---|---|
| server instructions | 1,987 | 1,987 |
| tools/list | 4,380 | 4,380 |
| core skill | 13,864（餘 136） | 13,981（餘 19） |
| operation index | 4,656 | 4,656 |
| work_get_context 合約 | 4,908 | 4,840 |
| work_finalize_session 合約 | 12,327 | 12,314 |
| **固定合計** | **42,122（餘 128）** | **42,158（餘 92）** |

core 與 finalize 合約合計 26,191 = 固定閱讀 62%。對這兩者逐句分類（a 每次必要／b 罕見或出錯／c 伺服器可觀察／d 重複）：

| 範圍 | a 必要 | b 罕見/出錯 | c 可觀察 | d 重複 |
|---|---|---|---|---|
| core | 8,016 | 3,743 | 879 | 1,226 |
| finalize 合約 | 5,735 | 2,405 | 2,000 | 2,180 |
| **合計** | **13,751（52%）** | **6,148（23%）** | **2,879（11%）** | **3,406（13%）** |

b+c+d 合計約 12,400 字理論上可移出固定閱讀。兩個結構性縮減方案：

- **方案 A（把伺服器已知的事實移出 Agent 契約，c 類）**：伺服器在首次 `work_get_context`（已確認 tracked）記 worktree 快照當 baseline，沿用既有 server_observed 起始時間、`readGitMetadata`、agentClient。`baselineChangedFiles`、`startedAt`、`git`、`agentModel` 變選填 override，schema 只留欄位名。**約省 1,800–2,000 字**，CORE_RULES 只需移除一行（`capture the paths already changed in the worktree`）。前提：伺服器端先實作快照。
- **方案 B（finalize 合約拆核心＋回條，b+d 類）**：合約核心只留必填欄位、workSummary 定義、decisions origin、verification、nextSteps、outstanding id 規則與被測試釘住的字串；diagrams 改指向既有 `work_attach_diagram`；events／maintainedKnowledgePages 去除 description；legacy follow-up 與 receipt 描述刪除（receipt 自說明）；closing contract 與 core 重複段落合併；`knowledgeToReview`／stale/confidence 改由回條帶出。**約省 4,000–4,500 字**，需新增回條欄位並補測試。

**合計去重後約 −5,500～−6,500 字**，固定閱讀降至約 35,600–36,600；建議隨後把 `FIXED_READING_CHARACTER_BUDGET` 下調到約 38,000 避免回彈。只做低風險子集（不動伺服器行為、不碰測試釘句）約 −3,000 字。

既有可承接 b 類規則的回條機制（`apps/mcp/src/finalize-receipt.ts`）：`verificationFollowUp`、`changedFilesFollowUp`、`workSummaryFollowUp`、`startedAtFollowUp`＋`startedAtSource`、`timestampWarnings`、`linkWarnings`、`knowledgeWarnings`、`outstandingItemWarnings`、`knowledgePageMaintenanceHint`、`idempotency_conflict`。**尚缺**（需新增才能搬規則）：`knowledgeToReview` 處置指示、decision origin 缺漏提示、diagram 提示、baseline 缺漏提示。

被測試釘住、改動需同步改測試的字串（節選）：CORE_RULES 的 `capture the paths already changed in the worktree`（c）、`A retry with the same key…`（c）、`Only restartRequired stops operations`、`wrap it in <private>…`（b）、`If no source supports the answer, say 資料不足`（d）；finalize 合約側 `in_progress`、`without being asked`、`skip single-file fixes`、renamed 需 previousPath、offset 轉 UTC、`resolvedOutstandingItemIds`。另有結構釘：Privacy 段落須在 Start of work 與 Finalize 之前。

### A-5 整合分支已做的部分與剩餘缺口

整合分支（1.6.33）只實作一塊：**finalize 時用 Git 補 `changedFileChanges` 狀態**。

- **何時跑**：僅 `work_finalize_session`；有 `completedAt`（補登）、非 tracked、`idempotencyKey` 已存在（重試）、或沒有缺狀態的路徑時都略過。在取寫入鎖前執行，失敗只略過。`work_update_session_metadata` 不觸發。
- **基準 commit**：`SegmentObserver` 新增在本段第一次非 finalize 呼叫時存 `headCommit`，用的是**未改動的** `readGitMetadata`（讀 `.git/HEAD` 檔）。linked worktree 或 packed ref 時回 undefined，基準退回 `HEAD`（本段內已 commit 的變更漏掉）。
- **Git 指令**（最多 3 個行程，`execFile`、逾時 1.5s、最多 200 路徑、清除 `GIT_*`＋`GIT_OPTIONAL_LOCKS=0`、`-c core.fsmonitor=false`）：`merge-base --is-ancestor`、`diff --name-status -M -z`、`ls-files --others`。clean/smudge filter 未處理（`docs/mcp-tools.md:76` 自承可能執行）。
- **Agent 值仍優先**：只補 Agent 沒給狀態的路徑，伺服器不新增檔案（除 rename 的 previousPath）。
- **儲存**：寫入既有 `changed_file_changes_json`（**無新欄位、無 per-entry 來源**）；來源只在一筆 `work_events` note（`source: "server_observed_git"`, `base`, `paths`）；回條多 `changedFileChangesSource.serverObservedGit` 與 `changedFileChangesFollowUp`（皆不入庫）。
- **skill 文字淨值未減**：core 步驟 3 縮短 baseline 兩句（−53）但新增一句教 Agent 補狀態（+170），反而讓 c 類變大。

**剩餘缺口**（本研究建議的後續，排序見「最值得先做的三件事」）：

1. 修 `readGitMetadata`／`observeHeadCommit` 改 `git rev-parse HEAD`（同套 `-C`／環境／逾時），讓 worktree 與 packed ref 也有基準——這同時提升整合分支的 changedFileChanges 品質與 git.branch/commit 觀察。
2. 在 `SegmentObserver` 記開始時 `git status`＋對髒檔 `git hash-object`，使 `baselineChangedFiles` 可被伺服器取代（解決「基準檔後來又被改」），之後才能刪 skill/合約約 800–1,000 字。
3. 對 `changedFileChanges`／git.branch/commit 的 Agent 值做核對警告（不覆蓋），provenance 加觀察標籤 `git_observed`。
4. 持久化 `changedFileChangesSource` 或補 per-entry 來源，否則補值率只能由 note 反推。

### A-6 量測設計（主題 A 第 3 題）

隨附唯讀腳本：`docs/experiments/observed-rules-field-gap-metrics.mjs`。

- 用 `node:sqlite`（Node ≥22.12）以 `{ readOnly: true }`＋`PRAGMA query_only=1` 開啟 argv[2] 的 DB；只輸出聚合 JSON（月份×正規化 client 的 sessions／缺漏率／錯誤率／分布），**不印 id／路徑／專案名／記錄文字**；缺欄位列在 `meta.absent`，作廢 session 排除並記在 `meta.voided_excluded`。
- client 名稱依子字串歸入 `claude-code`／`codex`／`claude-desktop`／`cursor`／`vscode`／`other`／`(missing)`。
- 執行：`node docs/experiments/observed-rules-field-gap-metrics.mjs <db> --month-basis=created 2>/dev/null`（需真實數字時寫唯讀腳本、以 `send_message` 交由上層在私有副本上執行，不臆測）。
- 本輪新增分布：`changed_files_shape`（區分「空且已確認」與「真的缺」）、`commit_sha_length`（釐清 7/10/40 碼）、`completedAt_backfill_gap`（區間）、整合分支的 `change_status_source`（server_observed_git／agent_reported／none，依 `work_events` note 判斷）與 `missing.changedFileChangesPartial`。
- **尚待補的量測**：(a) 「實際延續卻未連結」的代理指標（短時間內同專案、changedFiles 高度重疊卻無 link）；(b) finalize 各類警告率——目前 `timestampWarnings`／`linkWarnings`／`knowledgeWarnings`／`outstandingItemWarnings` 只在回應、未持久化，需新增一張小表或 `work_events` note 記錄 warning code 計數才能算警告率；(c) `redaction_count` 只存總數，未分 private_block 與 secret。

---

## 主題 B

適配範圍（使用者 2026-11-13 定案）：**Claude Code、Claude Desktop、Codex**。Cursor、VS Code Copilot、Windsurf（現 Devin）、Gemini CLI 不在適配範圍，下面只放在「僅供參考」附表，不據以提建議。

### B-1 問題大小

三個適配對象中，只有 Claude Code 在本容器實機驗證過（`claude` CLI 2.1.323）。Codex 只讀原始碼，本容器沒有 `codex` CLI，實機行為照實標為未驗證。Claude Desktop 是封閉原始碼，依官方文件判斷；文件沒寫的照實標「未能查證」。

### B-2 適配用戶端能力對照表

標記：[實測]＝我在本容器實跑；[源碼]＝讀原始碼；[文件]＝官方文件；[未能查證]＝公開資料查不到。

| 項目 | Claude Code 2.1.323 | Codex CLI（@69231e11） | Claude Desktop（Chat／Cowork；Code 分頁即 Claude Code） |
|---|---|---|---|
| tool hook（Pre/Post） | [文件][實測] 有，MCP 工具會觸發，payload 有 `mcp_server` | [源碼] 有（PreToolUse/PostToolUse），MCP 會觸發 | [文件] 有，但**只透過 plugin 或 Claude Code managed settings**：Chat 對話自 1.52386.0 起跑 plugin hooks；Cowork 也跑；採 Claude Code hooks schema，MCP 工具以 `mcp__<server>__<tool>` 比對，另有 `Elicitation`／`ElicitationResult` 事件 |
| UserPromptSubmit/SessionStart 注入 context | [文件][實測] 可（additionalContext） | [源碼] 可 | [文件] 可（`hookSpecificOutput.additionalContext`，同 Claude Code schema） |
| hook payload 有 model | [文件][實測] 共同欄位沒有；SessionStart 選填、Pre/PostModelSwitch 有 from/to | [源碼] tool/session/prompt 皆有（required） | [文件] 同 Claude Code schema：共同欄位沒有，只有 SessionStart 可能有 → 實際是否帶值 [未能查證] |
| 能否取得開始時間 | [實測] hook 執行時間可當開始時間；payload 本身沒有 timestamp | [源碼] 同左（hook 執行時刻） | [文件] 有 hook 時同左；沒裝 plugin 時只剩伺服器觀察的第一次工具呼叫時間 |
| MCP clientInfo.name | [實測] `claude-code`（title "Claude Code", version 2.1.323） | [源碼] `codex-mcp-client`（title "Codex"） | [未能查證]（封閉原始碼，文件未載） |
| 宣告 capabilities | [實測] roots(listChanged) + elicitation(form,url) | [源碼] elicitation；無 roots/sampling | [文件] 不支援 sampling、resource subscriptions、「advanced or draft capabilities」；roots／elicitation [未能查證] |
| tool result 送模型 | [實測] 同時有 content.text 與 structuredContent 時**只送 structuredContent**（text 被丟） | [源碼] 同上，只送 structuredContent | [未能查證]（文件只列「Text and image-based tool results」，沒說兩者並存時取哪個） |
| server `instructions` 注入 | [實測] 有注入；[文件] >4096 字截斷 | [源碼] 放進 tool namespace 描述 | [未能查證] |
| resources（list/read/subscribe） | [文件] @ 引用＋自動工具；subscribe 查不到 | [源碼] 三個 resource 工具；subscribe 未見 | [文件] 支援 resources（text＋binary）、prompts、MCP Apps；**明文不支援 subscriptions** |
| elicitation | [文件][實測宣告] 支援（form/url） | [源碼] 支援 | [未能查證]（hooks schema 有 Elicitation 事件，但 connector 文件沒有把 elicitation 列進支援清單） |
| plugin／skill | [文件] 支援 plugin（含 skills、hooks、`.mcp.json`）與 skills | [未能查證]（本研究未查 Codex 的 plugin／skill 機制） | [文件] 支援 plugin、skills、connector；格式與 Claude Code 共用 marketplace；`org-plugins/` 目錄的 plugin 在 Code 分頁不載入 skills/hooks |
| 同行程多對話 | [實測] 子代理與父對話**共用同一 MCP 行程**（同 pid、同 session_id） | [源碼] 2026-07-28 本機 stdio 由 process 層級 pool 跨 chat 共享（未實機） | [文件，間接] 本機 server 在 App 啟動時拉起、所有對話可用 → 推斷跨對話共用；明文 [未能查證] |

Claude Desktop 來源：claude.com/docs/connectors/building.md（支援能力清單）、claude.com/docs/third-party/claude-desktop/extensions.md（plugin、skills、hooks 執行位置與版本）、code.claude.com/docs/en/hooks.md（hooks schema）、support.claude.com 的 local MCP server 入門文章（App 重啟才載入 server）。注意 extensions.md 是第三方部署版文件，但該頁明說功能「as standard Claude Desktop does」。

我的實測細節（Claude Code 2.1.323，`claude -p`，stdio 原始 JSON-RPC 探測 server）：

- 第一則訊息為 `server/discover`，`_meta` 帶 `io.modelcontextprotocol/protocolVersion: 2026-07-28`、`clientInfo{name:claude-code, title, version:2.1.323, description, websiteUrl}`、`clientCapabilities{roots.listChanged, elicitation{form,url}}`；隨後 `initialize` protocolVersion `2025-11-25`。
- `tools/call` 的 `params._meta = {claudecode/toolUseId, progressToken}`；此 `toolUseId` == hook 的 `tool_use_id` == transcript assistant 的 `tool_use` id（三者一致，可跨 hook／transcript／MCP 關聯同一次呼叫，但仍沒有 conversation id 把 MCP 連線對應到 hook 的 session_id）。
- 工具回傳 `content:[{text:"TEXT_MARKER_A"}]` ＋ `structuredContent:{marker:"STRUCT_MARKER_B"}`：模型只看到 `{"marker":"STRUCT_MARKER_B"}`（transcript tool_result 與 PostToolUse tool_response 也只有 structuredContent）。
- server `instructions` 的 secret word 被模型讀到（確認 instructions 會注入）。
- hook payload 欄位：SessionStart{cwd, hook_event_name, scratchpad_dir, session_id, source, transcript_path}；UserPromptSubmit（＋prompt, prompt_id, permission_mode）；PreToolUse（＋effort, mcp_server, tool_input, tool_name, tool_use_id）；PostToolUse（＋duration_ms, tool_response）；Stop（＋last_assistant_message）。**無 `model`**。
- transcript JSONL 每則 assistant `message.model` 有確切模型 id。
- 子代理 MCP 呼叫走**同一 MCP 行程**（同 pid）、同 hook session_id、同父 transcript_path；PreToolUse 另帶 `agent_id`＋`agent_type`。

#### 僅供參考（不在適配範圍）

| 用戶端 | 要點 | 來源 |
|---|---|---|
| Gemini CLI | [源碼] BeforeTool/AfterTool hook；tool result **只送 content、不送 structuredContent**；不支援 elicitation | 原始碼 @b9776560 |
| VS Code Copilot | [源碼] 有 structuredContent 時只送 `JSON.stringify(structuredContent)`、丟 text；`tools/call` `_meta` 帶私有 `vscode.conversationId`；hooks 無 MCP 專屬事件、無 model | vscode `mcpLanguageModelToolContribution.ts`、`mcpServer.ts` |
| Cursor | [文件] `beforeMCPExecution`／`afterMCPExecution`，payload 有 `conversation_id`、`model`；structuredContent 處理未能查證 | cursor.com/docs/hooks.md |
| Windsurf（現 Devin） | [文件] 文件已改導 docs.devin.ai；hook 事件改名為 PreToolUse 等；structuredContent 處理未能查證 | docs.devin.ai |

### B-3 沒有 hook 時，只靠 MCP 協定能補到什麼

MCP 規格最新版是 **2026-07-28**（破壞性改版：取消 `initialize` 握手，版本、身分、能力改為每個 request 的 `_meta` 攜帶；roots 與 sampling 標為 deprecated）。對 WorkLog 有用的結論：

- **用戶端身分**：`clientInfo{name, version}` 可記錄，但規格明文「SHOULD NOT use them to change the behavior」，只能拿來顯示與統計，**不能依名稱分支行為**；要分支請看 `clientCapabilities`（2026-07-28 起每個 request 必填）。
- **開始／結束時間**：伺服器時鐘＋`SegmentObserver`（第一次非 finalize 呼叫），不需 hook。精度是「第一次工具呼叫」而非「第一則使用者訊息」，偏晚。
- **Git 事實**：伺服器讀專案根 Git（branch/commit/status/diff），與用戶端無關。
- **缺漏補救**：工具回應帶 follow-up。規格的向後相容條款原文：「For backwards compatibility, a tool that returns structured content SHOULD also return the serialized JSON in a TextContent block.」三個適配對象中 Claude Code、Codex 已確認只把 structuredContent 給模型，所以 **follow-up 必須在 structuredContent 裡**（見 B-7）。
- **elicitation**：Claude Code、Codex 支援；Claude Desktop 未能查證 → 不能當最低保證。
- **server `instructions`**：規格是 MAY，Claude Code 有注入、Codex 放進工具描述、Claude Desktop 未能查證 → 重要約束仍要寫在工具描述與回條裡。
- **拿不到的**：model（只能靠 hook／transcript）；conversation id（stdio 從來沒有；2026-07-28 更明文「a server must not treat connection or process identity as a proxy for conversation or session continuity」）。所以「同行程多對話」在無 hook 時無解，只能用 `SegmentObserver` 的專案根 key＋時間上限緩解。

### B-4 最低保證與加值層（主題 B 第 3 題）

- **最低保證（三個適配對象都成立，不依賴 hook）**：
  - 以 `clientInfo` 記錄 client 名稱與版本（只記錄，不分支）。
  - 寫入時 schema 驗證與伺服器檢查（tracked gate、時間擋未來、路徑不逃出專案根、idempotency）。
  - 伺服器觀察的事實：agentClient、startedAt（第一次呼叫）、completedAt（伺服器時鐘）、Git branch/commit/changedFiles 狀態。
  - 回條帶 follow-up，且 **structuredContent 必須是完整結果**（Claude Code、Codex 只讀它），text 保留同內容的 JSON 作規格要求的相容層。
- **加值層**：
  - Claude Code／Codex 的 hook：SessionStart/Stop 補生命週期與較準的 startedAt；Codex hook payload 有 model。
  - Claude Desktop：只有在使用者或管理員裝了帶 hooks 的 plugin 時才有 hook；WorkLog 若要在 Desktop 取得 hook 加值，得走 plugin 發佈，不能假設存在。
  - 支援 elicitation 的用戶端（Claude Code、Codex）：缺關鍵欄位時即時索取。

### B-5 用戶端相容性自檢（doctor）：降為不建議

使用者已把適配範圍收斂到三個用戶端，其中兩個（Claude Code、Codex）的關鍵行為已確認，剩下 Claude Desktop 的差異點（structuredContent 取捨、instructions）用一次性人工探測就能補，不值得做成給使用者跑的通用 doctor。改為：

- 把「structuredContent 是完整結果」寫成 MCP 測試的固定斷言（見 B-7 的建議規則），由 CI 守住，不靠使用者自檢。
- Claude Desktop 的未查證項目，若之後需要，用 B-2 所述的 marker 探測 server（回傳 TEXT／STRUCT 兩個 marker 的最小 stdio server，不入 repo）手動跑一次即可，看模型讀到哪個 marker。

### B-6 建議（做／不做／先做小實驗）

- **做**：
  1. 修 B-7 的兩個 structuredContent 落差，並把「structuredContent ⊇ text 的內容」寫成測試，固定雙軌回傳。
  2. `clientInfo.version` 保存（只供統計）。
  3. Git 事實由伺服器觀察（主題 A）。
- **先做小實驗**：(a) 在有 `codex` CLI 的環境實測 apply_patch 失敗 payload 與同行程多對話；(b) 在 Claude Desktop 用 marker 探測 server 確認 structuredContent／instructions 行為；(c) 用 elicitation 在缺 agentModel 時索取（只限支援的用戶端）。
- **不做**：通用 doctor（B-5）；依 clientInfo 名稱分支行為（規格反對）；用 MCP sampling 或 roots（已 deprecated）；把 hook 當最低保證；不引入向量庫、額外 LLM 服務、大型依賴。

### B-7 各操作 text 與 structuredContent 一致性稽核（整合分支 1.6.33 候選）

方法：

1. 在整合分支 `claude/jolly-pascal-18ob5z`（HEAD 7dc8af1）的 worktree，用 vitest setupFiles 攔截 `Client.prototype.callTool`，跑完整 MCP 測試套件，記錄每次回應的 `content[0].text` 解析結果與 `structuredContent`，逐鍵比對（忽略值為 `undefined` 的鍵，那是 `JSON.stringify` 丟掉的，非落差）。共 380 次呼叫。
2. 用 esbuild 打包整合分支的 MCP server，對暫存資料庫與暫存 tracked／paused 專案以原始 JSON-RPC 直接呼叫，複驗落差情境。
3. 原計畫再用真實 `claude` CLI 讓模型回報收到的內容；**這一步被中斷，未完成**。Claude Code 只讀 structuredContent 這件事本身已在 B-2 用探測 server 實測確認，但 WorkLog 各操作在模型端的實際內容沒有實機確認。

結果：

| 類別 | 操作 | text vs structuredContent |
|---|---|---|
| 只回 text（278 次） | 所有讀取（`work_get_context`、recall、`search_knowledge`、`knowledge_page_context`、`file_history`、各 `list_*`、投影讀取 view/select）、所有錯誤（`isError`）、非 session 寫入 | 一致（沒有 structuredContent，各用戶端都讀 text） |
| 兩者都有（102 次） | finalize `finalized`、`work_update_session_metadata`／`summary`／`title`／`work_summary`、`work_void_session`、`work_get_session`（session_detail） | 一致：structuredContent 是 text 的超集（多出 `executionStatus`、`changedFilesCount`、`verification` 摘要） |
| **落差 1** | `work_get_session` 帶 `knownRevision` 回 `session_unchanged` | structuredContent 只有 `outcome`／`sessionId`／`revision`／`voided`，**少了 text 裡的 `session.title`、`session.projectId`**。只讀 structuredContent 的 Claude Code／Codex 看不到這兩欄 |
| **落差 2** | finalize 回 `skipped`（專案暫停／未追蹤）與 `idempotency_conflict` | `sessionTextResult` 對非 session 結果仍注入預設值：`sessionId:null`、`executionStatus:"completed"`、`changedFilesCount:0`、`verification:null`。text 裡沒有這些；只讀 structuredContent 的用戶端會看到「已完成、0 個檔案」的誤導值 |

建議統一規則：**structuredContent 要嘛是完整結果（text 的 JSON 與它逐鍵相同或為其子集），要嘛不給**；不對非 session 結果注入 Session 預設值；`session_unchanged` 保留識別欄位（title、projectId）。

對回應大小的影響：用戶端只把其中一份送給模型（Claude Code／Codex 送 structuredContent），所以模型端看到的大小不變；傳輸上本來就是兩份。現有 response-size 測試若量的是 text，規則改成「structuredContent ＝完整結果」後應改量 structuredContent（或兩者取大），才量得到模型實際讀到的大小。

---

## 借鑑對象整理

只借做法，不複製程式碼，不引入向量庫／額外 LLM／大型依賴。DNS 被網路政策擋住而未能一手查證者已標「未查證」。

| 類別 | 專案 | 網址 | 授權 | 解決什麼 | 可借鑑的機制 | 不適用／限制 |
|---|---|---|---|---|---|---|
| hook 擷取 | claude-mem | github.com/thedotmack/claude-mem | Apache-2.0 | Agent 不必記得寫紀錄，hook 自動收集 | SessionStart/Stop/SessionEnd 生命週期；系統觸發不受遺忘影響 | 內含 observer agent＋Chroma（違反約束），只借 hook 結構 |
| hook 擷取 | claude-code-hooks-multi-agent-observability | github.com/disler/… | 未查證 | 觀察多 agent hook 事件 | 每事件帶 session_id 串接；SessionStart 取 model；工具名判 MCP | 整體架構過重；payload schema 未全列 |
| hook 擷取 | ccusage | github.com/ryoppippi/ccusage | MIT | 由本機資料推算 model/token，不靠自報 | model/token 由 transcript 推導；依 project 分組 | 離線報表工具非 MCP；JSONL 欄位未查證 |
| 來源認定 | git-ai | github.com/acunniffe/git-ai | Apache-2.0 | 不靠自報記錄 AI 行級歸屬 | 「觀察而非自報」分界；provenance 存 Git Notes 不改作者；rewrite 清單可當測試案例 | 需裝 binary＋agent hook；不處理未納 git 的檔 |
| 來源認定 | aider | github.com/Aider-AI/aider | Apache-2.0 | AI 變更有 commit 並標示 | 把「誰寫的」放進 git 身分欄位，伺服器讀 git 即觀察；先 commit 既有 dirty 切分邊界 | 本身是 coding agent 非紀錄器；預設跳過 hook |
| 來源認定 | SLSA | github.com/slsa-framework/slsa | Community Spec 1.0 / Apache-2.0 | 區分自我聲明與可驗證來源 | 每欄位標 observed/reported/derived | 完整 attestation 過重，只借概念 |
| client 差異 | github-mcp-server | github.com/github/github-mcp-server | MIT | 同 server 服務不同協定版本/能力 | initialize 記 clientInfo＋協商版本；依版本閘控輸出；旗標關寫入工具 | 以版本字串判斷，需對應目標 client 實際能力 |
| client 差異 | MCP 規格 2025-06-18 tools | github.com/modelcontextprotocol/… | 未查證 | 結構化輸出與純文字相容 | 雙軌回傳（structuredContent＋JSON 文字）；驗證失敗回 isError＋具體訊息 | 規格不定義 Agent 如何修正 |
| client 差異 | Playwright MCP | github.com/microsoft/playwright-mcp | Apache-2.0 | 不同情境需要不同工具 | `--caps` 能力旗標控制工具可見 | opt-in 命名不一致，不照抄 |
| 驗證取代規則 | commitlint | github.com/conventional-changelog/commitlint | MIT | 格式不符在寫入時拒絕 | 宣告式規則；寫入邊界拒絕並回錯誤訊息 | 依賴 git hook，我們改在 schema 層拒絕 |
| 驗證取代規則 | Pydantic AI | github.com/pydantic/pydantic-ai | MIT | 輸出過 schema＋I/O 檢查，失敗有限重試 | output validator 放 I/O 檢查（如 session 是否存在）；ModelRetry 有限預算 | Python LLM 層；我們以 isError＋伺服器計數重試對應，schema 用 zod |
| 驗證取代規則 | Guardrails AI | github.com/guardrails-ai/guardrails | Apache-2.0 | validator 失敗要有明確策略 | 每欄位宣告失敗策略（reject/fix/flag） | 依賴大量 LLM 呼叫，只借 on_fail 概念 |
| 自檢 | MCP Inspector | github.com/modelcontextprotocol/inspector | MIT→Apache-2.0 | 不靠 Agent 驗協定行為 | `--cli` 可腳本化 connect/list/call/assert；JSON 輸出 | 只驗協定層，業務規則需自測 |
| 來源認定（未查證） | Agent Trace（Cursor） | github.com/cursor/agent-trace（404） | 未查證 | 記錄程式碼 AI/human 歸屬 | 貢獻者型別 enum；model 設為可選；storage 與格式分離 | 僅二手摘要；我們單位是 session 非行 |

---

## 未能查證的事項

- Claude Desktop：clientInfo 字串、structuredContent 與 text 並存時送哪個給模型、server `instructions` 是否注入、elicitation 與 roots 是否支援、SessionStart hook 是否實際帶 model、本機 server 是否明文跨對話共用。封閉原始碼且官方文件沒寫。
- 被中斷的實機確認：用真實 `claude` CLI 讓模型回報 WorkLog 各操作（finalize tracked／paused、`work_get_session`、帶 `knownRevision`）實際收到的內容，未完成。B-7 的落差由測試攔截與原始 JSON-RPC 確認，模型端實際內容未實機確認。
- Claude Code 的「同行程多對話」生命週期（跨 session 是否共用行程、/clear 與 resume 是否重啟）：官方文件查不到；只實測到子代理與父對話共用同一行程。
- Codex 的實機行為（apply_patch 失敗 payload 形狀、2026-07-28 本機 stdio 多對話共享）：本容器沒有 `codex` CLI，僅原始碼推斷。
- agentModel 走 hook/transcript 的可行性，需在真實 Claude Code／Codex payload 上驗證「是否穩定帶 model」後才能採用。
- 部分借鑑對象的一手頁面（`agent-trace.dev`、`ai.pydantic.dev`、`aider.chat`、`developers.openai.com/codex/hooks`、`docs.cline.bot`）當時被網路政策擋住，改讀 GitHub 鏡像；表中授權標「未查證」者維持原狀。
- 網路異動紀錄：B2 子代理經使用者核可，在環境 WorkLog.Ai 的允許清單加入 `modelcontextprotocol.io`、`cursor.com`、`docs.cursor.com`、`code.visualstudio.com`、`docs.windsurf.com`、`docs.devin.ai`、`docs.github.com`。
