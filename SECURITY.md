# 安全政策

## 安全邊界

Work Intelligence 是本機優先的單機工具。API 預設只綁定 loopback（`127.0.0.1`）；Host 與 Origin 檢查限制瀏覽器請求來源，正式 Web 另使用內容安全政策與安全標頭。這些限制是為了降低網頁跨站請求與 DNS rebinding 風險，不是用來取代作業系統帳號權限。

專案預設為 `unregistered`。只有使用者明確切換為 `tracked` 後，Agent 才能透過受控流程讀取專案 handoff、Git 或來源檔案並保存工作記錄。暫停、忽略或未註冊的專案會被略過。檔案路徑在讀取前會經過專案根目錄邊界檢查；回應不會揭露暫存匯出檔等 server 內部路徑，也不會把內部例外或 stack trace 當成錯誤訊息回傳。

Web UI 與本機 API 會使用你明確註冊的專案根目錄，以便顯示及管理該專案；Work Intelligence 本身不會把路徑或工作記錄送往遠端服務。使用 MCP 時，Agent host 可能會依其供應商與帳號設定，把工具結果送至遠端模型；該資料處理由 Agent host 的政策決定。未經明確同意，不要把 SQLite、備份、匯出 JSON、Agent transcript 或專案內容附加到公開 issue。可攜式 JSON 未加密。

本機同一個作業系統帳號及可連到 loopback 的本機程式屬於信任邊界。若電腦或帳號已遭入侵，Work Intelligence 無法保護本機資料免受該帳號權限所及的存取。請使用可信任的裝置與磁碟備份，並為系統帳號設定適當權限。

## 敏感資料遮蔽

寫入 Session、Evidence、Knowledge 候選／Knowledge、Agent 報告摘要及可攜式 JSON 匯入時，Work Intelligence 會用固定規則遮蔽 GitHub、OpenAI、Anthropic、Slack、Google、AWS 憑證、PEM 私鑰、JWT、連線字串密碼，以及 `API_KEY`／`SECRET`／`TOKEN`／`PASSWORD` 等常見指定值。遮蔽不呼叫 LLM；寫入工具回應只會列出各類型的數量，不會回傳憑證片段。Session 面板會顯示該筆記錄累積的遮蔽數量。

規則依格式、邊界與長度篩選，避免把常見 UUID、commit SHA 與明確佔位字串當成憑證；但規則不是完整的秘密掃描器，未知格式、二進位資料或沒有被列出的憑證可能不會被發現。若需要其他格式，請先在本機確認，不要把真實憑證放進 issue 或測試原始碼；測試假憑證必須在執行期組合。

`pnpm db:redact` 以唯讀模式掃描既有資料，只輸出各類型數量與受影響 Session 數，不輸出文字。先停止 Work Intelligence server 並關閉會啟動 MCP 的 Agent 對話，再執行 `pnpm db:redact --apply`；命令會取得獨佔鎖、先建立人工保留備份，再以單一交易改寫資料並清除舊搜尋片段、標記索引重建。資料庫以外的既有備份、先前匯出的 SQLite／JSON，以及這次遮蔽前建立的安全備份仍含原始文字；請到「專案 → 資料備份」檢視並自行處理不再需要的備份，也重新匯出需要分享的可攜式 JSON。請參閱[使用者指南的備份、匯出與匯入說明](docs/user-guide.md#備份匯出與匯入)。

## 回報安全問題

請勿在公開 issue、討論區或 pull request 張貼可利用細節、資料庫、真實 Session、專案路徑、憑證或完整 transcript。

若 GitHub repository 的 Security 頁面提供 **Report a vulnerability**，請以私密漏洞回報提交重現步驟、受影響版本、作業系統／Node.js 版本、影響範圍與可行的修正建議。若該功能不可用，請私下聯絡 repository 維護者（GitHub 帳號 `@Ponpon55837`），並先提供不含使用者資料的摘要，再依維護者回覆傳送必要細節。

目前未承諾固定回覆或修補時程。請先給維護者合理時間確認與修補，再公開披露問題。
