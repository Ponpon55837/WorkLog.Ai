# Work Intelligence 使用手冊

Work Intelligence 是本機優先的工作記憶工具。它提供 Web Dashboard、REST API 與供 Codex／Claude 使用的本機 MCP server；只有你明確設為「記錄中」的專案才會被讀取與保存。

## 安裝與正式模式

需求：Node.js 22.5 以上（建議 Node.js 24）與專案指定版本的 pnpm。請在 WorkLog.Ai 專案根目錄執行：

```sh
pnpm install
pnpm build
pnpm start
```

預設在 <http://127.0.0.1:3210> 開啟 Web UI；REST API 也在同一個連接埠，例如 <http://127.0.0.1:3210/api/health>。終端機保持執行，按 `Ctrl+C` 停止。開發時才使用 `pnpm dev`；開發模式的 Web 使用 5966，API 使用 3210。

第一次檢查環境可執行：

```sh
pnpm run doctor
```

請使用 `pnpm run doctor`，不要使用 `pnpm doctor`：pnpm 11 將 `doctor` 保留為套件管理器自己的命令，`pnpm doctor` 不會執行 Work Intelligence 診斷。

資料預設放在 `data/work-intelligence.sqlite`，也可設定 `WORK_INTELLIGENCE_DB` 指定位置。常用設定如下：

| 環境變數 | 用途 |
| --- | --- |
| `WORK_INTELLIGENCE_DB` | 共用 SQLite 檔案位置，API、MCP 與 CLI 應使用同一個檔案 |
| `WORK_INTELLIGENCE_PORT` | Web 與 API 共用的本機連接埠，預設 `3210` |
| `WORK_INTELLIGENCE_BACKUP_DIR` | 備份目錄，預設為資料庫旁的 `backups/`；相對路徑以資料庫所在資料夾為基準，API、MCP、CLI 與 doctor 會指向同一個位置 |
| `WORK_INTELLIGENCE_BACKUP_KEEP` | 手動備份保留份數，預設 14；自動備份另行保留 14 份 |
| `WORK_INTELLIGENCE_BACKUP=off` | 停用每日自動備份 |

設定 MCP 與全域保存提醒 hook 的方式見[連接 Agent](agent-setup.md)。MCP 使用 stdio，由 Codex／Claude 分別啟動；它不使用 Dashboard 的 HTTP 連接埠。

也可以在 build 完成後執行 `pnpm setup:agents`，預覽 Codex／Claude Code 的 MCP、user-level skill 與保存提醒 hook 設定。互動終端輸入 `yes` 才會先備份並套用；詳細內容見[Agent 設定指南](agent-setup.md)。

若希望登入電腦後自動啟動正式模式，可使用 `pnpm service:install`；預覽服務設定內容並確認後，會安裝目前使用者的登入服務。服務狀態與移除方式見[登入自動啟動服務](service.md)。

## 第一次使用

1. 在左側選單開啟「專案」，選「加入專案」，選擇或輸入 workspace 路徑。
2. 新增專案預設為「未註冊」。只有你明確將狀態切換為「記錄中」，Work Intelligence 才會讀取該專案允許範圍內的 handoff、Git 或來源檔案並保存工作記錄。
3. 依[連接 Agent](agent-setup.md)註冊本機 MCP，並在 Agent 對話中確認可連線。
4. 開工前可請 Agent 查詢 Work Intelligence 的相關工作與 Knowledge；完成後請它保存本次工作。

`paused`、`ignored`、`unregistered` 專案不會被讀取或記錄。Agent 不能代替你把專案切換為「記錄中」。

### 永久刪除專案資料

在「專案 → 專案清單」點選專案旁的垃圾桶按鈕，閱讀刪除範圍並輸入完整專案名稱，才可確認永久刪除。WorkLog 會先建立並驗證一份完整 SQLite 備份；備份失敗時不會刪除。完成後會顯示備份檔名。

「專案 → 刪除紀錄」會列出刪除時間、專案 id 與各類資料的刪除筆數。這份唯讀紀錄不保存專案名稱、路徑或已刪除的內容。

刪除會移除中央資料庫中該專案的工作記錄、handoff、Evidence、Knowledge、稽核與搜尋資料，以及引用目標 Session 的共享請求和報告。專案資料夾與檔案不會被刪除。刪除前備份是整份資料庫快照，並依手動備份的保留規則管理；它可透過 `pnpm db:restore <備份檔.sqlite>` 還原，但還原會取代目前整份資料庫。MCP 不提供專案刪除工具。

**刪除後資料仍存在於備份中**：刪除前備份，以及刪除前建立的自動、手動、migration 與維護備份，都仍然包含這個專案的完整內容，直到它們依保留規則被輪替掉為止。若需要讓資料立即無法復原，請在確認不再需要後，自行刪除 `backups/`（或 `WORK_INTELLIGENCE_BACKUP_DIR`）中這些備份檔，以及先前匯出的 `.sqlite`／JSON 檔。

## 日常流程

- **開工前**：描述任務，請 Agent 查詢相關過往工作或指定檔案的紀錄；遇到錯誤時也可直接貼上錯誤訊息讓它檢索。
- **工作中**：照常使用 Agent。Work Intelligence 不會替 Agent 推測驗證結果，也不會自動把 Knowledge 候選寫成正式 Knowledge。
- **完成時**：Agent 會先核對與本次工作相關的未結項，只有確認完成才結案；被本次新未結項明確取代的舊項目會標為「不再需要」，並連到取代它的 Session。證據不足就保留未處理，保存後也會提醒仍相關的項目。請 Agent 保存這次工作。每筆 Session 會分開保存成果、範圍、決策、驗證與狀態／未結項。
- **回顧時**：到「工作歷程」搜尋 Session，或到「工作知識」檢視已接受的決策、模式、注意事項、流程與技能。

## 報告與 Knowledge

「工作報告」支援日、週、月、季、年與自訂日期區間；統計依已保存的 Session 計算，AI 整理會保留來源 Session。可以匯出 Markdown 或 JSON。若請 Agent 整理報告，Web 會在請求完成後更新結果。

「工作知識」只顯示明確提交並保存的 Knowledge。Agent 可以提出候選，但須由你接受（可先修改）後才會成為 Knowledge。Knowledge 可以編輯、封存、恢復及查看變更紀錄；封存不會刪除資料。

更完整的資料格式與搜尋行為見[架構與資料契約](architecture.md)及[MCP 工具參考](mcp-tools.md)。

## 各頁面功能

### 工作歷程

- 依關鍵字、專案、完成日期與是否作廢篩選 Session；點一筆開啟 Session 面板。
- 「未結項」可依專案、狀態及來源 Session 完成日期篩選；勾選待處理項目或本頁全部後，批次標記完成／不再需要，每批最多 100 項。「復原本次批次」將本次實際更新的項目一次恢復為待處理；切頁仍可復原，重新載入後不保留此按鈕。同頁背景刷新保留仍待處理且仍在本頁的勾選；切換專案、狀態、日期或頁碼會清空選取。若項目已被其他操作改變，整批復原會拒絕，請重新整理確認。
- Session 面板可編輯主摘要、五段 workSummary 與 verification，連結其他 Session，作廢或還原；Evidence 可逐筆標示錯誤。
- Agent 附上的 Mermaid 圖會顯示在面板的「圖表」區塊；語法有誤時顯示原始文字，也可以作廢。
- 專案設定了 https 儲存庫網址時，commit SHA 會連到 commit 頁面。
- 在「系統狀態 → 個人偏好」選了編輯器（VS Code 或 Cursor）之後，changed files 旁會出現「在編輯器開啟」連結。偏好只存在這個瀏覽器，連結只會指向記錄中專案資料夾內的檔案。

### 整理既有未結項

在工作歷程 → 未結項先選擇一個專案，再開啟「整理未結項」並建立整理請求。請在 Agent 對話輸入：「請整理這個專案的未結項。」Agent 會核對後續 Session，提出附一句理由與證據的「已完成」或「不再需要」建議；證據不足的項目保持未處理。

回到整理側面板可查看核對進度與待審建議；「來源 Session」與「證據」會開啟工作詳情。核對後逐筆接受／拒絕，也可選取本頁最多 100 項批次審核。接受前未結項保持原狀；拒絕不改項目。若項目或證據已變更，接受整批失敗，請重新整理並核對；可拒絕過期建議、取消舊請求後重新建立。審核狀態、請求與頁碼會保存於網址，長清單在固定區域捲動；All 仍每頁最多 100 筆。取消保留既有建議與原項目。取消後清空勾選，既有建議保持唯讀。

整理進行中的快照項目會保持待處理，Agent 收尾或移除來源 Session 的 nextSteps 不會直接讓它們結案。Web 人工逐筆／批次更新仍可使用；來源、項目或證據有變更時，原建議會判為過期，接受前需重新核對。

### 工作知識

分成四個分頁：

- **Knowledge**：列出已接受的 Knowledge，顯示被 Session 確認與推翻的次數；變更紀錄面板列出來源 Session。
- **知識頁**：每個記錄中專案有「架構與慣例」「進行中的工作與未結項」「常見陷阱」三頁，也可以新增自訂問題。新 Session 先顯示「有新資料」，Agent 評估後可標記已檢查；只有內容結論需要改變時才建立新版本。引用來源在頁面儲存後被修改、作廢或還原時，頁面會獨立列出受影響段落、來源與原因供核對。
  - 頁面由 Agent 依已記錄的 Session 改寫，每段都標示來源 Session，或寫「資料不足」。
  - 狀態篩選可查看有新資料、來源需要核對、最新、等待撰寫與已要求更新的頁面；也可以手動編輯或查看版本紀錄。
- **候選**：Agent 提出的 Knowledge 候選，接受（可先修改）後才會成為 Knowledge。
- **待確認決策**：Agent 在工作中自行做的決定。可以確認、拒絕，或整理成 Knowledge；每筆都連到來源 Session。

### 工作圖譜

- **關係圖**：Project、Session、Knowledge、Evidence、檔案與 Session 關聯。
  - 實線是記錄下來的關係。可以開啟「推導的關係」，以虛線顯示常被一起修改的檔案。
  - 在節點面板選另一個節點，會逐段說明兩者如何關聯。
- **時間軸**：每個專案一條泳道。
  - 拉遠時每天一根長條，依驗證結果分色；點一下放大到那天。
  - 拉近後，Session 畫成長條或點，關聯畫成弧線，Knowledge 事件畫成標記。
  - 可以放大、縮小、顯示整個期間，或切換成依日期分組的清單；手機寬度自動使用清單。
- **熱點**：被最多 Session 修改的檔案或目錄，附驗證失敗與未執行的比例，以及最近的 Session。工作報告的「風險」也會列出本期熱點。

### 請 Agent 查詢時

- 可以限定期間，例如「上週」「六月」。Agent 會以日期範圍查詢，只回傳那段時間的記錄。
- 開工時提供要改的檔案路徑，若這些檔案最近 30 天常被修改，Agent 會收到熱點提醒。

## 外觀、語言與操作提示

- **淺色／深色主題**：按頁首右側的太陽或月亮按鈕切換。淺色主題使用柔和的灰色底，不是純白，長時間使用較不刺眼。「系統狀態 → 個人偏好 → 外觀主題」有三個選項：跟隨系統、淺色、深色。選「跟隨系統」時，作業系統切換淺色／深色模式，介面會跟著變。
- **介面語言**：頁首的語言選單（「文A」圖示）可切換「繁體中文」與「English」，也可以在「個人偏好 → 介面語言」設定。第一次開啟時依瀏覽器語言決定。只有介面文字會翻譯；Session 摘要、報告、Knowledge 與 Agent 寫入的內容維持原本記錄的語言。
- **指令面板**：`Ctrl`/`⌘` + `K` 除了搜尋 Session、Knowledge 與跳頁，也能輸入「主題」「theme」或「語言」「language」直接切換。
- **載入提示**：換頁或按重新整理時，畫面最上方會出現細長的進度條；很快完成時不會顯示。
- **鍵盤操作**：按 `Tab` 進入頁面時，第一個焦點是「跳至主要內容」，按 `Enter` 可略過頁首與側欄。
- **減少動態效果**：作業系統開啟「減少動態效果」時，所有轉場與動畫都會關閉。

主題與語言設定只存在目前的瀏覽器（localStorage），不會寫入資料庫，也不會影響其他瀏覽器或電腦。

## 備份、匯出與匯入

- API 啟動時會檢查每日自動備份，之後每小時檢查一次；依 server 本機日曆日每天最多一份，預設保留最近 14 份。資料庫有待套用 migration 時，程式會先額外建立標有目標 schema 版本的備份。
- 手動備份可在「專案 → 資料備份」選「立即備份」，或執行 `pnpm db:backup`。
- 「專案 → 資料備份」會列出備份種類、時間、大小與總大小；刪除前會顯示檔名與種類並要求確認，刪除唯一一份列出的備份時會額外警告。CLI 可用 `pnpm db:backups` 列出，或在互動終端執行 `pnpm db:backups --delete <檔名>` 確認刪除。
- 專案刪除後，刪除前備份和其他較早的備份仍可能包含該專案資料；可從「專案 → 資料備份」檢視並刪除不再需要的備份。
- 資料庫維護會在執行 `VACUUM` 與重建搜尋索引前建立並驗證一份備份。請先停止 `pnpm start`，並關閉會啟動 MCP 的 Codex／Claude 對話，再執行 `pnpm db:maintain`。命令會先檢查資料庫完整性及獨佔鎖，之後整理 SQLite、更新統計資訊、重建搜尋索引；若無法取得鎖或備份失敗，會停止維護。完成或未完成的結果可由 `pnpm run doctor` 唯讀查看。
- `pnpm db:redact` 只讀掃描並顯示各類型遮蔽數量與受影響 Session 數；確認後先停止 server、關閉 MCP Agent，再用 `pnpm db:redact --apply` 遮蔽目前資料庫。命令會先建立一份包含原始內容的備份。既有備份與先前匯出檔不會被改寫；請在「專案 → 資料備份」檢視並處理不再需要的檔案，必要時重新匯出可攜式 JSON。
- 完整 SQLite 快照可在 Web 介面匯出，或使用 `pnpm db:export <檔案.sqlite>`。快照包含所有專案與工作記錄。
- 可攜式 JSON 支援單一或全部專案：`pnpm db:export --project <專案名稱或 id>`、`pnpm db:export --all`。在 Web 匯入或執行 `pnpm db:import <檔案.json> --dry-run`，先查看新增、略過、衝突及路徑轉換，再確認匯入。匯入不會覆寫既有資料；新專案會以暫停狀態加入。
- JSON 匯出未加密。SQLite 快照與備份也應視同包含私人工作記錄，請存放在可信任位置。

## 換電腦與還原

搬移整份資料前，先停止 Work Intelligence server，並關閉會啟動 MCP 的 Codex／Claude 對話，再從備份或舊電腦匯出完整 SQLite 檔案。在新電腦執行：

```sh
pnpm build
pnpm db:restore <匯出檔.sqlite> --remap-root <舊專案上層路徑>=<新專案路徑>
pnpm start
```

若專案路徑沒有改變，省略 `--remap-root`。可以重複指定多組路徑轉換。還原會檢查 SQLite 完整性與 schema 版本，並在取代目前資料前先備份目前資料庫；若偵測到資料庫仍被 server 或 Agent 開啟，會停止還原。完整選項見[REST API 文件](rest-api.md)與 README 的「備份與換電腦」。

## 更新 Work Intelligence

取得新版原始碼或 Release source archive 後，先停止 Work Intelligence server 與 MCP 用戶端，再於新版專案目錄執行：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm run doctor
pnpm start
```

保留原本的 `WORK_INTELLIGENCE_DB` 設定與資料庫檔案位置。首次由新版程式開啟舊 schema 的資料庫時，系統會先建立 migration 前備份，再自動套用必要的 migration；備份失敗時會停止升級。不要手動刪除 migration 記錄或直接編輯 SQLite。若已安裝登入自動啟動服務，更新程式目錄前先執行 `pnpm service:uninstall`，更新並確認正常後再依[服務指南](service.md)重新安裝。

MCP 只更新實作時，系統狀態顯示「有新版可用」，原連線仍可繼續讀寫。schema／Agent 契約變更或相容性無法判定時，才需要重新啟動或重新連線 Codex／Claude。MCP 卡片分開顯示「需要重新連線」與「有新版可用」的程序數。版本與 schema 可由 `/api/health` 查看，UI 側欄也會顯示程式版本。版本規則、tag 發行及完整升級前檢查見[發行指南](release.md)；變更摘要見 [CHANGELOG](../CHANGELOG.md)。
