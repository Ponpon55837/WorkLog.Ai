---
name: worklog-docs-writing
description: Use whenever you write or edit a user-facing document in Work Intelligence (README.md, README.zh-TW.md, docs/user-guide.md, docs/troubleshooting.md, docs/agent-setup.md, docs/service.md, docs/standalone.md, docs/release.md, or any other page a user reads). Covers the desktop-App-first structure, the fixed Traditional Chinese and English terminology for App tabs and features, how to describe App steps without asking users to type commands, how to remove AI-sounding prose in zh-TW and English, and which historical records must not be rewritten. Load it before drafting, before reviewing a docs PR, and when a docs claim needs checking against the code.
---

# Work Intelligence 文件寫作

本 skill 規範「使用者會讀的文件」。它不規範程式碼註解、`docs/releases/`、`docs/desktop/` 的設計與審查文件，或 `docs/status.md` 的歷史段落；這些是紀錄，保留當時的用字。

## 0. 出處

本 skill 的去 AI 腔規則參考下列專案的思路。這些專案的文字沒有被逐句複製；下面的規則是依本專案需要用自己的話整理的。

| 專案 | 用途 | 授權（依 GitHub 倉庫資訊） |
|---|---|---|
| [blader/humanizer](https://github.com/blader/humanizer) | 英文：找出常見的 AI 寫作模式 | MIT |
| [op7418/Humanizer-zh](https://github.com/op7418/Humanizer-zh) | 繁體與簡體中文：同類模式的中文版本 | MIT |
| [hardikpandya/stop-slop](https://github.com/hardikpandya/stop-slop) | 去除套話與空泛句的寫作規則 | MIT |

若日後直接引用這些專案的文字（超過幾個詞），必須在引用處附上原作者、連結與 MIT 授權聲明，並保留原版版權行。目前本 skill 沒有引用任何段落。

## 1. 去 AI 腔（繁中與英文通用）

寫完之後逐項檢查：

- **空泛形容詞**：「強大」「無縫」「直覺」「全面」「高效」沒有具體內容。改成可以驗證的事實，例如「備份保留最近 3 份」。
- **三段式排比與湊數**：「快速、安全、可靠」這種三連不要硬湊。只列真的有幾項的內容。
- **「不僅……更……」「不只是……而是……」**：直接寫結論。
- **過度粗體與標題**：一段只粗體一個真正需要注意的詞；不要每句都粗體。
- **表情符號**：正式文件不用。
- **結尾套話**：「希望這份文件對你有幫助」「讓我們開始吧」「總之」不寫。段落結束在事實上。
- **開場鋪陳**：不先講「在本文中我們將介紹」。第一句就是內容。
- **過度對稱的句型**：「不是 A，而是 B」連續出現時，改寫其中一兩句。
- **中文的歐化與贅詞**：「進行……的動作」「對於……來說」「為了能夠」改成直述。「於」「之後」「該」能省就省。
- **英文的 hedging 堆疊**：「may potentially」「it could be argued」直接說明條件與結果。
- **一句話塞太多**：超過兩個子句、還帶括號的長句拆開。

判斷原則：刪掉形容詞後句子還有資訊，才留下形容詞。

## 2. 本專案用語（固定譯名）

這些譯名在 README、使用手冊、疑難排解與 App 內文字必須一致。

| 概念 | 繁體中文 | English | 備註 |
|---|---|---|---|
| 桌面 App | 桌面 App | desktop App | 第一次提到時寫「Work Intelligence 桌面 App」 |
| App 視窗 | App 視窗 | App window | 不要寫「修復視窗」「工作列視窗」 |
| 狀態分頁 | 「狀態」分頁 | Status tab | |
| Agent 分頁 | 「Agent」分頁 | Agent tab | 分頁名稱保留英文字母 |
| 設定分頁 | 「設定」分頁 | Settings tab | |
| 資料分頁 | 「資料」分頁 | Data tab | |
| 診斷分頁 | 「診斷」分頁 | Diagnostics tab | |
| 工作列 | 工作列 | system tray | 工作列選單用「工作列」，不用「托盤」 |
| MCP | MCP | MCP | 不翻譯 |
| Agent | Agent | Agent | 指 Codex、Claude Code 等 AI 助理，不翻譯 |
| Session | Session | Session | 工作記錄的單位，不翻譯 |
| Knowledge | Knowledge | Knowledge | 已接受的知識條目，不翻譯 |
| 知識頁 | 知識頁 | Knowledge pages | |
| 候選 | 候選 | Candidates | Knowledge 候選 |
| 未結項 | 未結項 | Open items | |
| 記錄中 | 記錄中 | Tracked | 專案狀態；另有「未註冊」「已暫停」「已忽略」 |
| 租約 | 租約（lease） | lease | 第一次出現時附英文 |
| 備份 | 備份 | backup | 「手動備份」「自動備份」分開說 |
| 還原 | 還原 | restore | 不用「復原」指資料庫還原（「復原上次變更」是 Agent 設定的 undo，保留原名） |
| 整理資料庫 | 整理資料庫 | Maintain database | |
| 登入時自動啟動 | 登入時自動啟動 | Start at login | |
| 診斷匯出 | 診斷匯出 | Export diagnostics | |
| 改由桌面 App 管理 | 改由桌面 App 管理 | Manage with the desktop App | 接管手寫註冊的按鈕 |
| 設定 Agent | 設定 Agent | Set up Agents | |
| 移除 Agent 設定 | 移除 Agent 設定 | Remove Agent setup | |
| 已連線 | 已連線 | Connected | Agent 卡片狀態 |
| 需重新連線 | 需重新連線 | Reconnect needed | Agent 卡片狀態 |

App 的實際字串以程式為準。寫文件前先在 `apps/desktop` 或 `packages/desktop-core` 的 i18n 檔確認字串，不要憑印象寫。

## 3. App 內不要求輸入指令

這是本專案的硬規則：**使用者操作一律寫成 App 步驟**，例如「在『資料』分頁按『從備份還原』」。

寫法：

- 使用者段落只寫視窗、分頁、按鈕的名稱，不寫指令。
- 需要命令列的內容（CLI、standalone、開發者流程）放在獨立段落，段首標示對象，例如：

  > **給開發者與 CLI 使用者**：以下命令在 checkout 目錄執行。

- 不要在使用者段落出現 `pnpm`、`npm`、`node`、`終端機`、「複製指令」等字眼。`no-command-copy` 測試會檢查桌面 App 的字串，文件也應遵守同一原則。
- 「手動註冊」「手寫 hook」只能出現在「舊版遺留設定」的說明裡，並告訴使用者改按「改由桌面 App 管理」或「設定 Agent」。
- 當使用者必須做的事情需要命令列（例如 Linux 沒有 App），寫明原因，並把命令放在開發者段落。

## 4. 文件結構（桌面 App 優先）

README 與使用手冊的順序：

1. 這是什麼（兩三句，不列功能清單）
2. 下載與安裝（Windows、macOS；未簽署時如何開啟）
3. 第一次設定（首次執行頁、加入專案、設為「記錄中」）
4. 用 App 設定 Agent
5. 日常使用
6. 資料與備份（App 內還原、整理資料庫、更換備份位置）
7. 疑難排解入口
8. 進階：命令列與 standalone（明確標示對象，放在後面）
9. 文件索引

## 5. 不改寫的歷史文件

以下檔案保留當時的字句，不做去 AI 腔或譯名修正：

- `docs/releases/*.md`、`CHANGELOG.md`
- `docs/desktop/` 下的設計、ADR、審查與票務矩陣
- `docs/status.md` 的歷史版本段落（只有當前版本段落與「未結項」段落隨發行更新）

若歷史文件的說法與現在不符，在當前文件寫現況，不回頭改歷史。

## 6. 核對事實

- App 行為（按鈕、分頁、狀態字串、預設路徑）必須對照程式碼。引用的檔案與行號寫在 PR body，不寫在使用者文件裡。
- 版本號與功能版本以 `package.json` 與 `docs/releases/` 為準。
- 文件中的連結必須有效。站內連結用相對路徑，錨點與標題一致。
- 範例一律使用合成值，例如 `C:\Users\example\Documents\my-project`、`/Users/example/work`。不放任何真實使用者路徑、帳號、資料或截圖。

## 7. 檢查清單（交件前）

- [ ] 沒有 AI 腔的空泛形容詞、三段排比、套話結尾
- [ ] 譯名與本 skill 第 2 節一致
- [ ] 使用者段落沒有命令；命令都在開發者段落
- [ ] 每個 App 行為都能在程式碼中找到
- [ ] 歷史文件沒有被改寫
- [ ] 內部連結有效
- [ ] 範例都是合成資料
