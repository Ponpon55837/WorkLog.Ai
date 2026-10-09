# Archify 第二階段技術驗證

結論：保留現有 Mermaid，另以本專案擁有的版本化 JSON 與 Vue／SVG 閱讀器支援大型架構圖。採用 Archify 的群組、節點來源與作者定義路徑概念；原始 standalone HTML 無法直接套用目前的正式 CSP。

## 可重現範圍

- 上游固定為 [tt-a1i/archify commit bb990b1](https://github.com/tt-a1i/archify/tree/bb990b17b886e83d633e273221615eb259a92c78)，MIT、package 3.0.1；不將上游 renderer／HTML／字型放進專案，也沒有新增 runtime dependency。
- 2026-10-09 本機 Intel i7-9750H／macOS x64、Node 25.7.0、Mermaid 11.17.2；完整環境及樣本在[驗證資料](experiments/archify-probe-2026-10-09.json)。CI 的 Node 24 不代表同樣的效能值。
- 同一份六節點內容：Web UI → REST routes → Input schema → Store facade → Diagram service → SQLite。另測 10／100／500 節點的線性鏈；兩種來源使用相同名稱和連線。
- Archify CLI 每種規模獨立執行 3 次；現有 `renderMermaid` utility 在每個瀏覽器／主題各繪製 3 次並以 Shadow DOM／CSSStyleSheet 安裝 SVG。
- Chromium、Firefox、WebKit × 明／暗 × 4 種規模；Archify 分別使用無 CSP 與正式 CSP，Mermaid 使用正式 CSP。另驗證三瀏覽器 `zh-TW` fallback，共 75 組結果，預期斷言全通過。
- 探測伺服器直接呼叫 `apps/server/dist/static-files.js` 的 `applyProductionSecurityHeaders`，不是另寫寬鬆 CSP。只服務合成樣本與暫存產物，沒有讀寫現有 SQLite 或主安裝設定。

## CSP、語言及主題

原始 Archify 在無 CSP 時可切換明／暗並啟動縮放；套用正式 CSP 後，24 組樣本皆得到 2 次 `script-src-elem` 與 2 次 `style-src-elem` 的 inline 拒絕，`Archify.view` 無法啟動。Light query 也無法初始化，停在 template 的 dark。這是實際拒絕結果，不是放寬 CSP 後的相容性宣稱。

上游內建 en／zh-CN；三瀏覽器實測 `meta.locale: "zh-TW"` 而沒有 `meta.translations` 時，CLI 明確警告並回退成 `html lang=en`／英文縮放按鈕。[上游翻譯入口](https://github.com/tt-a1i/archify/blob/bb990b17b886e83d633e273221615eb259a92c78/archify/renderers/shared/cli.mjs)允許外加翻譯表，但本輪沒有製作或驗證整套繁體中文表。正式功能沿用本專案既有 zh-TW／en-US 字典及設計 tokens。

現有 Mermaid 的 24 組正式 CSP 樣本均沒有 `securitypolicyviolation`；第一階段 PR #221 已用完整 Session 閱讀流程驗證鍵盤、拖曳、重載、錯誤來源、雙語與主題。這不能當成尚未實作的結構化架構圖閱讀器已通過。

## 產物與生成成本

單位為 bytes／ms。Mermaid SVG 欄包含實際 SVG＋CSS，不包含共用 JS；Archify HTML 包含整套 standalone viewer。因此產物欄不是冷啟動總下載量的公平勝負比較。CLI 生成與瀏覽器繪製也是不同階段，只用來估計導入成本。

| 節點 | Archify JSON bytes | Archify HTML bytes | Mermaid SVG＋CSS bytes 範圍 | Archify CLI 中位 ms（3 次） | Mermaid 各瀏覽器／主題中位 ms 範圍（各 3 次） |
| --- | ---: | ---: | ---: | ---: | ---: |
| 6 | 840 | 747,540 | 17,568–18,496 | 397 | 43–52 |
| 10 | 1,268 | 753,143 | 23,409–24,562 | 401 | 56–67 |
| 100 | 11,942 | 883,014 | 157,053–163,516 | 544 | 449–534 |
| 500 | 61,585 | 1,466,662 | 755,531–785,600 | 1225 | 2373–2884 |

## 縮放到繪製幀成本

每組 10 次交替放大／縮小，表格合併明／暗兩組後取中位數（ms）。Archify 呼叫公開 `view.zoomIn/Out`；Mermaid 對已繪製 SVG 更新 width／height，與第一階段尺寸縮放方式相同；兩者均等兩個 `requestAnimationFrame`。探測頁使用瀏覽器預設字型，沒有載入正式 Web 的字型／CSS。這包含幀排程基線，不是使用者輸入延遲、Vue 完整流程或拖曳 FPS；逾時會明確失敗，不會當成有效測量。

| 瀏覽器 | 方式 | 6 節點 | 10 節點 | 100 節點 | 500 節點 |
| --- | --- | ---: | ---: | ---: | ---: |
| chromium | archify | 31.9 | 31.7 | 32.0 | 32.4 |
| chromium | mermaid | 32.0 | 31.9 | 32.0 | 37.0 |
| firefox | archify | 87.0 | 50.0 | 31.0 | 79.5 |
| firefox | mermaid | 30.0 | 30.0 | 17.5 | 29.5 |
| webkit | archify | 31.0 | 32.0 | 31.0 | 104.5 |
| webkit | mermaid | 31.0 | 31.5 | 31.0 | 38.0 |

500 節點的全圖繪製需數秒，Archify 在 Firefox／WebKit 的縮放也明顯較 100 節點昂貴。正式大型圖應先分組與局部閱讀，不把全圖一次塞進狹窄面板；不能由這組線性圖推論密集多邊、巢狀群組或無上限節點仍流暢。

## 導入決策

1. Mermaid 保持既有 kind／來源格式，沒有一次取代所有 flow／sequence／state 圖。
2. 結構化架構圖保存受 schema 驗證的 JSON，包括版本、節點、連線、群組、來源與作者路徑；不保存可執行 HTML、CSS 或腳本，也不直接接受上游完整 IR。
3. 使用專案內 Vue／SVG 呈現，沿用雙語、主題、鍵盤／焦點與既有圖表生命週期；不改正式 CSP、不額外託管另一個 renderer origin。
4. 下一個資料階段仍需驗證 migration、kind／版本冪等、finalize／attach、轉移、遮蔽、作廢及永久刪除。閱讀器階段仍需驗證群組／局部展開、節點來源／路徑，以及自身效能；本輪沒有宣稱完成。

## 重跑

在另一個資料夾準備乾淨的上游 checkout，固定在上述 commit，並在本專案 worktree 建置及安裝 Playwright 瀏覽器後執行：

```sh
pnpm build
pnpm exec playwright install chromium firefox webkit
pnpm test:archify-probe /path/to/archify-checkout
```

腳本拒絕錯版或有變更的上游；每次建立新的系統暫存資料夾，列出 `Probe output`，保存 environment、generation、locale、browser-results，以及兩種合成來源／HTML。它沒有執行全域 skill 安裝，不自動 clone，也不把上游程式碼當成 Agent 指令。這是選擇性的人工技術探測，不加入無網路上游 checkout 的一般 CI。初次探測曾因 animation enum 不符失敗，另一次 Firefox 探測遭中止；本文數據只採用最後 75 組完整成功的執行。

實機 Safari／觸控、密集圖、巢狀群組、冷啟動下載與完整框架互動成本均未量測。
