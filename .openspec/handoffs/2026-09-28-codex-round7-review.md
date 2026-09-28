# WorkLog.Ai 第七輪：Codex 交 Claude 最終複檢

複檢目的：依第七輪原始交接，核對 A1–D2 的交付、PR head、CI、merge commit 與 Work Intelligence Session；比較 A1 合成回應基準與本輪最後量測；保留使用者指定的暫緩項目。

## 專案與結案狀態

- Repository：[Ponpon55837/WorkLog.Ai](https://github.com/Ponpon55837/WorkLog.Ai)
- 兩次實際資料使用測試的起點：檢索準確度 6.5／10；有 task 的 context 約 26,400–27,000 字元，search 20 筆平均約 17,000 字元。回應大小比較表使用可重現的合成資料，不含使用者資料，也不把字元換算成 token。
- 第七輪功能階段 A1–D2 已完成；PR #147–#155 各自建立並以 merge commit 合併，且各 PR 最新 head 的 Quality Ubuntu、Windows、macOS 與 E2E 四項 CI 均為 SUCCESS。
- 最新功能 PR #155 head：`cd18de50c4a68fba65d67cc5499840cba0e9a908`；merge commit：`34b7f9e64befaa00f31147ee0e9c3a1aeac39991`。
- 第七輪複檢摘要已列入 [`docs/status.md`](../../docs/status.md)。README 已連到該現況頁，無需另改。
- `docs/agent-memory-improvement-plan.md` 是交接前已存在的未追蹤研究文件，沒有納入任何 PR。

## PR、head／merge SHA、CI run 與工作記錄

Head、merge 欄位連到完整 SHA；CI 欄位連到對應 PR head 的 Actions run。每個列出的 run 都有 4 個成功 check：Quality Ubuntu、Quality Windows、Quality macOS，以及 E2E。

| 階段／PR                                                      | 交付                                    | head                                                                                                                                  | CI run                                                                            | merge commit                                                                                                                          | Work Intelligence Session ID           |
| ------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| A1 [#147](https://github.com/Ponpon55837/WorkLog.Ai/pull/147) | 合成回應大小基準與 CI 上限              | [4c7e50a5005f727f5f1ec59727d1d79bacaeed4f](https://github.com/Ponpon55837/WorkLog.Ai/commit/4c7e50a5005f727f5f1ec59727d1d79bacaeed4f) | [36341097149](https://github.com/Ponpon55837/WorkLog.Ai/actions/runs/36341097149) | [9407af525f3903ce60b444997fcbd565ea76e089](https://github.com/Ponpon55837/WorkLog.Ai/commit/9407af525f3903ce60b444997fcbd565ea76e089) | `74f9d965-a1e6-4a3c-a120-797dd5eae128` |
| A2 [#148](https://github.com/Ponpon55837/WorkLog.Ai/pull/148) | Context 跨區去重、整份預算、任務優先    | [34ce55b5ef0bf43e5b4cc70547918cb16e865de2](https://github.com/Ponpon55837/WorkLog.Ai/commit/34ce55b5ef0bf43e5b4cc70547918cb16e865de2) | [36345189409](https://github.com/Ponpon55837/WorkLog.Ai/actions/runs/36345189409) | [fbe239b9fcfd1e94fa6556fcc5f57bd690174c4e](https://github.com/Ponpon55837/WorkLog.Ai/commit/fbe239b9fcfd1e94fa6556fcc5f57bd690174c4e) | `0719a664-39d1-4419-b666-bf0ba6a1cae5` |
| A3 [#149](https://github.com/Ponpon55837/WorkLog.Ai/pull/149) | 精簡 recall／search 結果                | [b794f4f94be2d3940132b10155c93750a937ff14](https://github.com/Ponpon55837/WorkLog.Ai/commit/b794f4f94be2d3940132b10155c93750a937ff14) | [36347921220](https://github.com/Ponpon55837/WorkLog.Ai/actions/runs/36347921220) | [088fc0550c1934fe7b19c4232ad4f4b788c8b476](https://github.com/Ponpon55837/WorkLog.Ai/commit/088fc0550c1934fe7b19c4232ad4f4b788c8b476) | `5675d355-58d3-4f44-a86a-e0d9a550b376` |
| B1 [#150](https://github.com/Ponpon55837/WorkLog.Ai/pull/150) | 無可靠命中時回傳 `confidence: "none"`   | [408f6d1bc590df82a19f32bfa106e9da8671d16f](https://github.com/Ponpon55837/WorkLog.Ai/commit/408f6d1bc590df82a19f32bfa106e9da8671d16f) | [36350637878](https://github.com/Ponpon55837/WorkLog.Ai/actions/runs/36350637878) | [9194a35fc91b47f6b56eb1705d3b8ab62b8b23c0](https://github.com/Ponpon55837/WorkLog.Ai/commit/9194a35fc91b47f6b56eb1705d3b8ab62b8b23c0) | `d984da40-d480-4930-b754-b0ace99c7656` |
| B2 [#151](https://github.com/Ponpon55837/WorkLog.Ai/pull/151) | 重複規劃片段只計一次、完成工作優先      | [5b339ca503b2e7f3265e209194f9a81bbfc67a72](https://github.com/Ponpon55837/WorkLog.Ai/commit/5b339ca503b2e7f3265e209194f9a81bbfc67a72) | [36353721544](https://github.com/Ponpon55837/WorkLog.Ai/actions/runs/36353721544) | [ed9e5d265259ed6c615c7d83d97b5d4b982a73dd](https://github.com/Ponpon55837/WorkLog.Ai/commit/ed9e5d265259ed6c615c7d83d97b5d4b982a73dd) | `6ec4f284-595e-4d1a-ba18-8a27159cddcc` |
| C1 [#152](https://github.com/Ponpon55837/WorkLog.Ai/pull/152) | 已引用來源變動時標示需要核對            | [763e28095181e057cfb6635f36e86ab9c596816d](https://github.com/Ponpon55837/WorkLog.Ai/commit/763e28095181e057cfb6635f36e86ab9c596816d) | [36357990984](https://github.com/Ponpon55837/WorkLog.Ai/actions/runs/36357990984) | [3029f6598fde74799cdfdae93f4a93d91ffaff10](https://github.com/Ponpon55837/WorkLog.Ai/commit/3029f6598fde74799cdfdae93f4a93d91ffaff10) | `b4808385-201e-4a39-9f1d-eb62b2fefb39` |
| C2 [#153](https://github.com/Ponpon55837/WorkLog.Ai/pull/153) | 新 Session 只提示有新資料，可回報已檢查 | [a6c6a3f855032bc1e66c2c110efa3de6d9b32ece](https://github.com/Ponpon55837/WorkLog.Ai/commit/a6c6a3f855032bc1e66c2c110efa3de6d9b32ece) | [36361141630](https://github.com/Ponpon55837/WorkLog.Ai/actions/runs/36361141630) | [d62e38cbcfb25bbca23b0c918e12ebcba340074c](https://github.com/Ponpon55837/WorkLog.Ai/commit/d62e38cbcfb25bbca23b0c918e12ebcba340074c) | `74398c30-622b-49e0-9c3f-a2c469ef360a` |
| D1 [#154](https://github.com/Ponpon55837/WorkLog.Ai/pull/154) | 跨專案檢索隔離情境測試                  | [a952909de90073d79d731cc97d49e605c47779f6](https://github.com/Ponpon55837/WorkLog.Ai/commit/a952909de90073d79d731cc97d49e605c47779f6) | [36363230968](https://github.com/Ponpon55837/WorkLog.Ai/actions/runs/36363230968) | [7454a8736e766801b06d482e65f8dd88e9e36972](https://github.com/Ponpon55837/WorkLog.Ai/commit/7454a8736e766801b06d482e65f8dd88e9e36972) | `342bb04b-e32d-4310-9d2d-30115efbf618` |
| D2 [#155](https://github.com/Ponpon55837/WorkLog.Ai/pull/155) | 嚴格 CSP 下 Mermaid 無 console 警告     | [cd18de50c4a68fba65d67cc5499840cba0e9a908](https://github.com/Ponpon55837/WorkLog.Ai/commit/cd18de50c4a68fba65d67cc5499840cba0e9a908) | [36366793022](https://github.com/Ponpon55837/WorkLog.Ai/actions/runs/36366793022) | [34b7f9e64befaa00f31147ee0e9c3a1aeac39991](https://github.com/Ponpon55837/WorkLog.Ai/commit/34b7f9e64befaa00f31147ee0e9c3a1aeac39991) | `3e843bb1-5718-45d4-bf95-a1b37fff37c8` |

## 階段摘要與 A1 回應大小比較

- **A1–A3**：新增固定合成用量測試與 CI 上限；`work_get_context` 依任務配置整體預算並跨區去重；recall／search 精簡結果但保留可判斷答案相關性的片段與全文讀取入口。
- **B1–B2**：無有意義命中時回傳空結果與 `confidence: "none"`；raw handoff 重複片段不再重複累積分數，結構化完成工作排序提高。新增欄位通過 `project-data-coverage`。
- **C1–C2**：已引用來源被修正、作廢或還原時提示需要核對；新增 Session 只把知識頁標為有新資料，Agent 可記錄檢查游標，無關工作不要求重寫。
- **D1–D2**：跨專案 scoped／unscoped／paused 隔離有回歸測試；Mermaid 在既有嚴格 CSP 下擷取暫存 SVG 樣式，不放寬 CSP。

| MCP 工具與情境              | A1 基線（字元） | 本輪最後量測（字元） |              差異 |
| --------------------------- | --------------: | -------------------: | ----------------: |
| `work_get_context`，無 task |          16,175 |               16,418 |     +243（+1.5%） |
| `work_get_context`，有 task |          26,247 |               11,309 | −14,938（−56.9%） |
| `work_recall`，預設 8 筆    |           6,807 |                3,799 |  −3,008（−44.2%） |
| `work_recall`，5 筆         |           4,741 |                2,532 |  −2,209（−46.6%） |
| `work_search`，預設 20 筆   |          15,896 |                7,128 |  −8,768（−55.2%） |

字元數是合成資料經 MCP transport 的 JavaScript 文字長度，不是 UTF-8 位元組或 token。A1 的 recall／search 是 pretty-printed JSON；B1 起這兩個工具用緊湊 JSON text block，因此它們前後差異也包含移除縮排空白，不全是內容欄位縮減。無 task context 小幅增加，是保留來源資訊的結果。有 task context、recall 5 筆及 search 20 筆均低於本輪上限（12,000／3,500／8,000）。C1 來源核對壓力情境為無 task 18,836、聚焦 context 11,701 字元，分別低於 19,000 與 12,000 上限。

## 驗證結果與限制

- 本機依序通過 `pnpm build`、`pnpm test`、`pnpm typecheck`、`pnpm test:coverage`、`pnpm test:performance`、`pnpm test:retrieval-quality`、`pnpm test:response-size` 與 `pnpm test:e2e`。
- 檢索品質測試 17/17 通過；K／M／S／N／P 類 hit@5 均為 1.00，R 類 MRR 為 0.50。
- 本機 E2E：Chromium 46 passed、1 skipped；Firefox 3 passed；WebKit 2 passed。Playwright WebKit 執行於 Ubuntu，不代表 macOS Safari 實機驗證。
- PR #155 最新 head 的 Actions run `36366793022`：Quality Ubuntu、Windows、macOS 與 E2E 四項均 SUCCESS。
- E2E 使用 `/private/tmp` 下的合成測試資料庫；本輪未讀寫使用者的實際資料庫、Agent 設定或全域 hook。

## 下次複檢 Claude 會特別看

- A1 的回應大小門檻確實在 CI 執行，並查看上方前後比較；輸出縮小時檢索品質仍通過。
- A2 檢查同一來源是否只輸出一次主要內容、省略提示與全文入口是否存在，以及過時／矛盾標記是否能保留在預算內。
- B1 檢查不存在的查詢是否為 0 筆與 `confidence: "none"`，精確查詢排序有無退步。
- B2 檢查重複規劃片段只計一次分數、新欄位納入 `project-data-coverage`。
- C1／C2 檢查已引用來源更正或作廢時會要求核對；無關 Session 與更新頁面本身的工作不要求重寫，Agent 可回報已檢查。
- 工具輸出與 MCP 工具說明、`work-intelligence` skill、`docs/mcp-tools.md` 是否一致。
- D1 檢查 scoped context／recall 不會跨專案，unscoped 有專案來源，paused 專案資料不會外洩。
- D2 檢查嚴格 `style-src-elem 'self'` 保持不變，Mermaid 渲染不產生 CSP console 警告。

## 暫緩項目

依使用者指示，本輪沒有處理下列事項：開機自動啟動、發行／tag／release workflow、版本號升至 1.0.0，以及實機驗證。實機驗證包含原生資料夾選擇視窗、Windows 備份還原與匯入、Windows Codex hook 載入、macOS Safari 與私有 36 題檢索評估。
