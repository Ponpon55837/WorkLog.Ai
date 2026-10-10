# 發行實機驗收清單

> **2026-10-10 本次發行註記：** 使用者取消本次實機驗收，並同意免驗後發布 1.5.0。原實機驗收項目本次均未執行，未執行不阻擋本次 1.5.0 發行；本文步驟保留供日後驗收。

這份清單記錄自動化 CI 無法代替的實體環境驗收。所有項目初始狀態都是「未執行」；只有使用者在目標作業系統或私人資料上實際操作後，才填寫結果。CI、模擬器及本機合成測試不算實機驗收。

請每次驗收填寫日期、Work Intelligence 版本／commit、作業系統與結果。若失敗，記下可重現步驟與錯誤位置；私人題目、工作記錄、完整評估報告和個人路徑不要提交到 repository。

## 結果摘要

| 驗收項目 | 初始狀態 | 平台／版本 | 日期 | 結果或問題連結 |
| --- | --- | --- | --- | --- |
| 原生資料夾選擇視窗 | 未執行 | macOS：＿＿；Windows：＿＿；Linux：＿＿ | ＿＿ | ＿＿ |
| Windows 備份還原與可攜式匯入 | 未執行 | Windows：＿＿ | ＿＿ | ＿＿ |
| Windows Codex hook 載入 | 未執行 | Windows：＿＿；Codex：＿＿ | ＿＿ | ＿＿ |
| Windows 登入自動啟動服務 | 未執行 | Windows：＿＿ | ＿＿ | ＿＿ |
| macOS Safari 主要頁面、圖表與時間軸 | 未執行 | macOS：＿＿；Safari：＿＿ | ＿＿ | ＿＿ |
| 私有 36 題檢索評估 | 未執行 | Work Intelligence：＿＿ | ＿＿ | ＿＿ |
| 另一個真實專案的完整記錄流程 | 未執行 | 專案／Agent：＿＿ | ＿＿ | ＿＿ |

## 驗收前準備

1. 在目標電腦取得已合併的版本，確認 UI 側欄與 `pnpm run doctor` 顯示預期版本；記下版本及 commit。
2. 建立只供驗收使用的資料庫、備份目錄與測試專案。還原測試會取代目前設定的整份資料庫，請勿以唯一的正式資料庫作為還原目標。
3. 需要設定 Agent 或登入服務時，先閱讀預覽的完整路徑與設定內容；只有本人確認後才套用。完成後記下保留或移除的選擇。

## 原生資料夾選擇視窗

在每一種目標作業系統分別執行：macOS、Windows、Linux。

1. 開啟 Work Intelligence 的「專案」頁，新增專案並叫出資料夾選擇視窗。
2. 選擇一個專用測試資料夾，確認視窗能瀏覽磁碟與目錄、顯示所選位置，並能完成選取。
3. 再叫出視窗並取消，確認沒有新增專案或改動既有專案路徑。
4. 回到專案清單，確認成功選取的專案顯示正確名稱與資料夾狀態。

**預期結果：** 原生視窗可開啟、選取及取消；選取後的路徑與資料夾狀態正確，取消不會造成寫入。

- macOS 結果／版本／日期：＿＿＿＿
- Windows 結果／版本／日期：＿＿＿＿
- Linux 結果／版本／日期：＿＿＿＿
- 問題或備註：＿＿＿＿

## Windows：備份還原與可攜式匯入

全程使用可丟棄的驗收資料庫及測試專案。PowerShell 範例：

```powershell
$env:WORK_INTELLIGENCE_DB = "C:\wi-e3-validation\work-intelligence.sqlite"
$env:WORK_INTELLIGENCE_BACKUP_DIR = "C:\wi-e3-validation\backups"
```

1. 在驗收資料庫建立一個測試專案和一筆容易辨認的測試 Session。執行 `pnpm db:backup`，再執行 `pnpm db:backups`，確認備份清單列出剛建立的備份。
2. 執行 `pnpm db:export <快照.sqlite>` 另存整份 SQLite 快照；另以 Web「專案 → 資料備份」或 `pnpm db:export --project <測試專案名稱> --out <專案.json>` 匯出可攜式 JSON。
3. 在快照完成後再新增一筆辨識用 Session，停止 server，並關閉會啟動 MCP 的 Codex／Claude 工作階段。執行 `pnpm db:restore <快照.sqlite>`；還原完成後重新啟動，確認快照內的測試 Session 存在，而快照之後新增的 Session 不存在。確認還原前的目標資料庫備份仍可在備份清單中找到。
4. 為匯入準備乾淨的驗收資料庫及另一個測試專案。先執行 `pnpm db:import <專案.json> --dry-run`，確認預覽列出預期新增項目且沒有寫入；再依互動提示確認匯入。
5. 確認匯入的測試專案與 Session 可讀取、找不到的專案路徑依預覽重新指定或略過後以暫停狀態加入，且目標資料庫原有的測試記錄未被覆寫。

**預期結果：** SQLite 還原會先備份目標資料庫，還原後內容與快照一致；JSON 預覽不寫入，確認後只新增缺少的資料且不覆寫既有資料。

- Windows／Work Intelligence 版本／日期：＿＿＿＿
- 還原結果（含備份檔可見性）：＿＿＿＿
- JSON 預覽與匯入結果：＿＿＿＿
- 問題或備註：＿＿＿＿

## Windows：Codex hook 載入

1. 在 Work Intelligence repository 根目錄執行 `pnpm setup:agents`，閱讀預覽中的 Codex 設定路徑、MCP command、hook command 及備份位置。確認它們指向預期安裝，且沒有不認識的衝突。
2. 由使用者本人決定是否確認套用；完成後重新連線 Codex。在 Codex 執行 `/hooks`，確認 Work Intelligence hook 已載入且沒有解析或信任錯誤。
3. 呼叫一個無寫入的 Work Intelligence MCP 工具，確認 Codex 工作階段可啟動 MCP；再依產品提示確認保存提醒 hook 有載入。

**預期結果：** Codex 可讀取 MCP 註冊及 hook；`/hooks` 顯示設定可用，呼叫工具沒有 hook 載入錯誤。設定寫入前已有預覽與備份。

- Windows／Codex 版本／日期：＿＿＿＿
- 預覽與備份結果：＿＿＿＿
- `/hooks` 與 MCP 結果：＿＿＿＿
- 問題或備註：＿＿＿＿

## Windows：登入自動啟動服務

1. 在 Work Intelligence repository 根目錄執行 `pnpm install --frozen-lockfile`、`pnpm build`，再執行 `pnpm service:install`。
2. 閱讀預覽中的完整 Task Scheduler 設定、Node.js／pnpm 路徑、專案根目錄、資料庫、備份及日誌路徑；確認只作用於目前使用者且不要求管理員權限。由使用者本人確認安裝。
3. 執行 `pnpm service:status`，確認服務已登錄、使用目前使用者及預期資料庫；登出再登入 Windows，確認服務啟動且 Dashboard 與 `/api/health` 可用。
4. 確認服務使用的資料庫及日誌路徑正確。若不打算保留服務，執行 `pnpm service:uninstall` 並確認服務註冊移除，而資料庫、備份與日誌仍保留；若保留，記錄此選擇。

**預期結果：** 預覽與實際服務設定一致；登入後服務以使用者層級啟動，狀態與 Dashboard 正常。移除服務不刪除記錄資料。

- Windows／日期：＿＿＿＿
- 安裝預覽、登入後啟動與健康檢查：＿＿＿＿
- 服務最後狀態（保留／已移除）：＿＿＿＿
- 問題或備註：＿＿＿＿

## macOS Safari：主要頁面、圖表與時間軸

1. 使用支援版本的 macOS Safari 開啟 Work Intelligence，逐一檢查 Dashboard、專案、工作歷程／Session、報告、Knowledge 與工作圖譜頁。
2. 在有合成或可分享測試資料的環境中檢查主要圖表、篩選、縮放與日期選擇；在工作圖譜切換到時間軸，檢查專案泳道、Session、Knowledge 標記、縮放／期間選擇、清單檢視及點選 Session。
3. 檢查窄視窗下沒有遮住主要操作的版面問題；開啟 Safari Web Inspector，確認頁面沒有阻止主要操作的 JavaScript 錯誤。

**預期結果：** 主要頁面可載入及操作；圖表標籤和資料可讀；時間軸縮放、選取期間、切換清單與開啟 Session 正常，沒有阻止操作的錯誤。

- macOS／Safari 版本／Work Intelligence 版本／日期：＿＿＿＿
- 頁面與圖表結果：＿＿＿＿
- 時間軸互動結果：＿＿＿＿
- 問題或備註：＿＿＿＿

## 私有 36 題檢索評估

1. 使用自己的私有題目檔與本機唯讀 SQLite 快照執行；不要把題目檔、輸出報告或私人工作記錄放進 repository。

   ```sh
   pnpm eval:recall <private-36-questions.json> --db <readonly-snapshot.sqlite> --out <private-report.json>
   ```

2. 在本機報告中記錄正例的 hit@5 與 MRR、評估狀態，以及 `expectedNoHitWithHighConfidence` 的題數。Hit@5／MRR 依 evaluator 報告的正例分母計算；另記下失敗題數和需要人工檢視的案例。
3. 若要與先前結果比較，確認兩次使用同一題目版本、相同資料庫快照範圍和相同 evaluator 版本；若條件不同，註明差異，不直接判定退步或進步。

**預期結果：** evaluator 成功唯讀評估，輸出 hit@5、MRR、題目狀態與 no-hit/high-confidence 清單；題目與報告留在使用者指定的本機位置，不上傳也不提交。

- Work Intelligence 版本／題庫版本或日期標籤／日期：＿＿＿＿
- 正例 hit@5：＿＿＿＿；MRR：＿＿＿＿
- 預期查不到卻為 high 的題數：＿＿＿＿；失敗題數：＿＿＿＿
- 題目及報告保存位置（僅本機）：＿＿＿＿
- 問題或備註：＿＿＿＿

## 另一個真實專案：從設定到保存

在 WorkLog.Ai 以外、使用者選定的真實專案進行；此驗收不要求 Agent 閱讀 WorkLog.Ai 原始碼或本 repository 文件。

1. 先在 WorkLog.Ai 根目錄執行 `pnpm setup:agents` 預覽設定。確認 Codex／Claude MCP、skill、hook 路徑與備份內容符合預期；首次使用者設定預期沒有衝突。由使用者本人確認後再套用，然後重新連線使用中的 Agent。Codex 使用者並在 `/hooks` 檢查信任狀態。
2. 在另一個專案的 Agent 工作階段中確認可取得 Work Intelligence 使用說明，並將該專案明確加入追蹤；確認呼叫所用的 `projectRoot` 是另一個專案目錄。
3. 從一項實際工作開始，請 Agent 查詢相關脈絡，完成工作、執行該專案適用的驗證，並以 MCP finalize 保存開始時間、摘要、變更檔案、驗證結果及未結項（如有）。
4. 從該專案再讀取剛保存的 Session 或搜尋內容，確認記錄欄位、專案歸屬、時間與驗證結果正確；確認 Agent 全程沒有為了解如何使用工具而讀取 WorkLog.Ai repository。

**預期結果：** Agent 在另一個專案可依安裝的使用說明連接 MCP、只讀寫該專案範圍，並完成查詢、工作、驗證與保存；Session 可由同一專案再次讀取。

- 目標專案（可使用代稱）／Agent 版本／日期：＿＿＿＿
- setup 預覽與衝突數：＿＿＿＿
- 開工、驗證、finalize 與回讀結果：＿＿＿＿
- 確認未讀取 WorkLog.Ai repository：＿＿＿＿
- 問題或備註：＿＿＿＿

## Claude Code／Codex plugin

依 [plugin 指南](plugins.md) 在一台尚未手動註冊（或已先 `pnpm setup:agents --uninstall`）的電腦上進行。

1. 在 WorkLog.Ai 根目錄執行 `pnpm build` 與 `pnpm plugin:link`，確認只多出 `~/.work-intelligence/plugin-link.json`。
2. Claude Code：`claude plugin marketplace add <repo>`、`claude plugin install work-intelligence@worklog-ai`，重新開啟工作階段；在 `/mcp` 確認 server 已連線，並在另一個追蹤中的專案改檔後結束一輪，確認保存提醒出現一次。
3. Codex：從 `/plugins` 安裝 `work-intelligence`，重新開啟工作階段，確認 MCP 已連線且 skill 可用。
4. 執行 `pnpm run doctor`，確認 Claude Code plugin 顯示正常、沒有要求手動註冊；Web UI、CLI 與既有資料庫照常可用。

**預期結果：** 兩個 Agent 透過 plugin 讀寫同一個 `data/work-intelligence.sqlite`，原有使用方式不受影響。

- Agent 版本／作業系統／日期：＿＿＿＿
- Claude Code 連線與保存提醒結果：＿＿＿＿
- Codex 連線與 skill 結果：＿＿＿＿
- doctor 結果：＿＿＿＿
- 問題或備註：＿＿＿＿

## 待使用者處理

- `pnpm setup:agents` 仍需由使用者檢視預覽後自行決定是否套用；預期 0 衝突。套用後重新連線 Codex／Claude，並在 Codex `/hooks` 確認信任狀態。
- 本文件中所有狀態仍是「未執行」，直到使用者填入各平台的實際結果。

> **2026-10-10 本次待辦狀態：** 使用者取消本次實機驗收，並同意免驗後發布 1.5.0。原實機項目本次未執行，仍維持「未執行」，不阻擋本次 1.5.0 發行；上列待辦與驗收步驟保留供日後處理。
