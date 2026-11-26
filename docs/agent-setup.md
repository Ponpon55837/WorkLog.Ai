# 用 App 設定 Agent

Work Intelligence 的 MCP 伺服器是本機 stdio 程序，由 Codex 或 Claude Code 自己啟動。它與 App 的本機服務使用同一份資料庫。這一頁說明在桌面 App 中設定 Agent 的方式，以及保存提醒 hook 的行為。

> 回到 [README](../README.zh-TW.md)（[English](../README.md)）

## 在桌面 App 設定（建議）

請在 App 視窗的「**Agent**」分頁設定。這個分頁為 Codex 與 Claude Code 各顯示一張卡片；第一次執行的首次設定頁也有「設定 Agent」按鈕，可以直接跳到這裡。

- **只看不寫**：打開分頁不會寫入任何檔案。「預覽變更」會逐檔列出差異，家目錄一律顯示為 `~`。
- **套用**：「套用變更」只套用剛才預覽的那份計畫，並把這次變更記錄下來；計畫有衝突時無法套用。
- **復原**：「復原上次變更」依記錄把檔案還原成套用前的樣子。若檔案在套用後又被 Agent 改寫，App 只撤銷它自己加入的部分，其他內容保留。
- **測試連線**：卡片可以測試 MCP 伺服器能否啟動並回應。
- **移除**：「移除 Agent 設定」使用與設定相同的預覽與確認步驟，只移除 App 加入的內容。
- **使用的資料庫**：App 寫入的設定會指向 App 管理的 launcher。App 換資料庫時，MCP 與 hook 會一起跟著換。

### 卡片狀態

| 卡片上的字 | 意思 | 你要做什麼 |
|---|---|---|
| 已連線 | Agent 已經實際使用過 Work Intelligence 的工具 | 不需要 |
| 已設定，待確認 | 設定已寫入，但 Agent 還沒有使用過工具 | 在 Agent 對話中，對一個記錄中的專案問一句話，例如「這個專案有在 Work Intelligence 記錄嗎？」 |
| 需要重新連線 | Agent 載入的是舊版伺服器 | 關閉該 Agent 的對話，再重新開啟 |
| 設定衝突 | App 無法安全地改寫現有設定 | 依卡片說明處理；通常是改由 App 管理，或手動整理衝突的那段設定 |
| 由其他方式管理 | 設定來自 plugin 或其他安裝方式 | 依卡片說明；App 不會改動你的 plugin |
| 需要信任／授權 | Agent 還需要你先信任或授權 Work Intelligence | 依 Agent 的提示完成信任或授權 |
| 執行環境不相容 | 本機的執行環境版本不符合要求 | 依卡片說明更新執行環境，再預覽並套用 |
| 尚未設定 | 還沒有寫入 | 按「預覽變更」再「套用變更」 |

### 手動加入的設定

如果你曾自己在 Agent 的設定檔裡加入 Work Intelligence（例如指向原始碼資料夾的啟動方式），卡片會顯示「由其他方式管理」或「設定衝突」，並提供「改由桌面 App 管理…」。

- 按下後 App 先顯示差異，確認後才改寫。它只接手能辨識的格式；不認得的項目不會被動到。
- 接手時會移除指向原始碼資料夾的工作目錄，以及指向其他資料庫的設定，讓 MCP 與 hook 跟隨 App 的資料庫。其他的環境變數、其他 MCP 伺服器與你自己的 hook 都會保留。
- 「復原上次變更」後，檔案會與接手前逐位元組相同。

### 只接手同一份資料庫

接手後，hook 會改用 App 的資料庫。所以只有手動設定使用的資料庫就是 App 目前的資料庫時，App 才會接手。若手動設定指向另一份資料庫（明確設定的 `WORK_INTELLIGENCE_DB`，或 checkout 預設的 `data/work-intelligence.sqlite`），App 不會悄悄換過去。卡片會列出那份資料庫，並提供「改用這份資料庫」，由你決定。

### MCP 連線

Web 介面的「系統狀態」頁會顯示 MCP 連線數，並在數字是 0 或偏少時說明原因，例如 MCP 伺服器是舊版、無法寫入連線記錄資料夾、設定指向另一份安裝，或 Agent 已經斷線。

升級後，升級前就開著的 Agent 對話仍在使用舊版 MCP 伺服器，因此不會被計入。關閉並重新開啟該對話即可。

## 保存提醒 hook（選用）

工作記錄要靠 Agent 記得保存。保存提醒 hook 是**全域**設定（和 MCP 一樣，不綁單一專案）。在「記錄中」的專案裡，Agent 改過檔案、這一輪結束卻還沒保存時，hook 會提醒它一次；同一段未保存的工作只提醒一次。Agent 若判斷工作還沒完成，直接結束即可。

- hook 只讀取 transcript 與專案清單（SQLite 唯讀開啟），不寫入資料庫。
- 讀不到資料或判斷失敗時一律放行，不會擋住 Agent。
- 提醒會附上這段工作的開始時間，讓 Agent 保存時可以直接填入 `startedAt`。
- 長對話被壓縮時，壓縮前會請摘要保留未保存的資訊，壓縮後會把提醒放回上下文。這些壓縮 hook 永遠不會擋住壓縮。

> **對象：開發者。** hook 的安裝、移除與設定細節由 App 或 `pnpm setup:agents` 管理。以下說明只供理解行為；不需要手動編輯設定檔。hook 腳本位於 checkout 的 `apps/mcp/dist/`，且只在 `pnpm build` 之後存在。

- **Claude Code**：`Stop` 事件為主，另有選用的 `PreToolUse`、`PreCompact` 與 `SessionStart`（matcher `compact`）。
- **Codex**：`PostToolUse` 與 `Stop` 為主，另有選用的 `PreToolUse`、`UserPromptSubmit` 與 `SessionStart`（matcher `compact`）。Codex 會略過尚未信任的 hook，需要在 `/hooks` 中檢查並信任。
- 只有在記錄中的專案內改過檔案才會觸發；只用 Bash 改檔的情況，hook 看不到。

## Plugin 與命令列（進階）

- **Claude Code 與 Codex plugin**：一次安裝 MCP、skill 與提醒 hook。詳見 [plugin 指南](plugins.md)。plugin 與 App 的設定方式二選一；兩者同時存在時，Agent 會看到重複的工具與提醒。
- **命令列**：在 checkout 目錄執行 `pnpm setup:agents` 會預覽同樣的設定；互動終端輸入 `yes` 才會寫入，並會先備份。`pnpm setup:agents --uninstall` 會預覽並移除它記錄的安裝。詳見[使用手冊](user-guide.md#給開發者與命令列使用者安裝與正式模式)。
- **Codex 的使用者 skill** 位於 `$HOME/.agents/skills/`；**Claude Code 的使用者 skill** 位於 `${CLAUDE_CONFIG_DIR:-~/.claude}/skills/`。App 與 `pnpm check` 會檢查它們是否缺少或過期。

### Claude Desktop（進階，手動設定）

桌面 App 目前只為 Codex 與 Claude Code 提供設定流程，Claude Desktop 沒有 App 內的設定步驟。若要在 Claude Desktop 使用 Work Intelligence，需要自己編輯它的設定檔；App 不會替你改寫這個檔案。

1. 先完成 App 的首次設定，讓 App 啟用 runtime。launcher 的固定位置依系統如下（來源：`packages/desktop-core/src/runtime/layout.ts`）：
   - Windows：`%LOCALAPPDATA%\WorkIntelligence\runtime\bin\work-intelligence-launcher.cmd`
   - macOS：`~/Library/Application Support/WorkIntelligence/runtime/bin/work-intelligence-launcher`
   - 其他系統：`$XDG_DATA_HOME/work-intelligence/runtime/bin/work-intelligence-launcher`（未設定 `XDG_DATA_HOME` 時為 `~/.local/share/...`）

   這個路徑是固定的 shim，runtime 更新時不會改變，所以不需要因為升級而重新編輯設定檔。
2. 關閉 Claude Desktop，打開設定檔：
   - Windows：`%APPDATA%\Claude\claude_desktop_config.json`
   - macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`
3. 在 `mcpServers` 中加入下面這一段，並把 `<launcher 完整路徑>` 換成第 1 步對應系統的路徑。如果檔案已有其他 `mcpServers`，只加入 `work-intelligence`，不要整份覆蓋：

```json
{
  "mcpServers": {
    "work-intelligence": {
      "command": "<launcher 完整路徑>"
    }
  }
}
```

4. 儲存後重新啟動 Claude Desktop，從聊天框的 `+` → `Connectors` 確認 tools 已出現。

Claude Desktop 的 local MCP 與 Claude.ai/Cowork 的 remote connector 是不同機制；不能直接從 Claude.ai 使用本機 stdio server。詳見 [Claude Desktop local MCP guide](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop) 與 [Claude custom connector notes](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)。

## 在其他專案貼上使用說明

任何連上 Work Intelligence MCP 的 Agent 都可以讀取完整的使用說明。若 Agent 不會主動使用 skill，可以把下列簡短規則貼到該專案的 `AGENTS.md` 或 `CLAUDE.md`。它不需要引用 Work Intelligence 的檔案：

```markdown
## Work Intelligence

- 在已由使用者明確設為「記錄中」的專案，開始工作前透過 `work_read` 執行一次 `work_get_context`，提供 `projectRoot`、任務與已知路徑。結果為 `skipped` 時不要讀取該專案的任何資料。
- 工作完成後，在完成驗證與交接後透過 `work_write_idempotent` 執行 `work_finalize_session`；只回報實際確認的成果、變更檔案與驗證結果。若專案不是記錄中，或無法確認狀態，不要建立 Work Intelligence 記錄。
- 第一次呼叫某個 operation 前，讀取 `work-intelligence://agent/tool-contracts/<operation>` 取得該操作的完整契約。
```

## 第一次使用

1. 開啟 App，完成首次設定，並把專案設為「記錄中」（見 [README](../README.zh-TW.md#三步驟保存第一筆-session)）。
2. 到「Agent」分頁，對 Codex 與 Claude Code 分別按「預覽變更」，確認後按「套用變更」。
3. 開新的 Agent 對話，問一句「這個專案有在 Work Intelligence 記錄嗎？」，確認卡片變成「已連線」。
4. 工作完成時，請 Agent 保存這次工作，例如「完成了，請把這次工作記錄到 Work Intelligence。」

未記錄的專案會被略過：MCP 會回傳 `outcome: "skipped"`，不會讀取或保存 handoff、Git 或原始碼資料。這是預期行為。Agent 無法替你把專案切換為「記錄中」，這一步只能在 App 中完成。

整理既有未結項由 App 建立整理請求，Agent 只提交附來源的待審建議，不能以保存工作繞過你的審核。

## 疑難排解

Agent 相關的問題見[疑難排解](troubleshooting.md#agent-卡片顯示需要重新連線)。
