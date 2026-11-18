# 相依套件稽核例外

CI 與 release 的「Production dependency audit」執行 `pnpm audit --prod --audit-level high`，這個指令與門檻不變。例外只寫在 `pnpm-workspace.yaml` 的 `auditConfig.ignoreGhsas`，每次只忽略一個指定的 GHSA，不調整 `--audit-level`，也不使用 overrides。

`node scripts/check-audit-ignores.mjs` 會檢查例外是否仍然需要。CI 的 Quality (ubuntu-latest) 在稽核步驟之後執行它。下列情況會失敗：

- 例外清單與腳本中的 `ALLOWED_AUDIT_IGNORES` 不一致，也就是新增或移除例外時沒有同時更新兩處；
- 在移除例外的暫存副本上執行 `pnpm audit --prod`，已不再回報該 GHSA；
- lockfile 已不含任何受影響版本，表示已裝上修補版。

**目前沒有任何例外**（1.6.53 起）。單元測試 `tests/web/scripts/check-audit-ignores.test.ts` 把允許的清單固定為空，清單不會在無人察覺下增加。腳本與每日監看保留為通用機制，清單為空時兩者都會通過。

## 已解除：GHSA-fc5q-39xc-vjpf：picomatch ≤ 4.0.7 ReDoS（high）

- **狀態**：1.6.53 解除。經使用者核准，`apps/web` 的 `vue-router` 由 5.5.0 改回 4.6.5。4.6.5 只依賴 `@vue/devtools-api`，因此 picomatch 不再出現在 production 相依樹中：
  - `pnpm why picomatch --prod -r` 沒有輸出；
  - 不帶任何例外時，`pnpm audit --prod --audit-level high` 通過；
  - `auditConfig.ignoreGhsas` 與 `ALLOWED_AUDIT_IGNORES` 都已清空。

  picomatch 仍以開發工具（例如 Vite）的間接相依存在於 lockfile，不在 `--prod` 稽核範圍內。以下保留 1.6.52 加入時的紀錄。
- **加入**：1.6.52，經使用者核准。
- **相依路徑**：`apps/web` → `vue-router` 5.5.0 → `picomatch` 4.0.7，另經 `tinyglobby`／`fdir`、`unplugin`、`unplugin-utils`（`@vue-macros/common`）引入。lockfile 只有 picomatch 4.0.7 一個版本（`pnpm why picomatch --prod -r`）。
- **只在建置時使用**：picomatch 屬於 vue-router 的建置期工具（檔案路由 plugin），不會進入執行期的程式。`apps/web/vite.config.ts` 沒有使用 vue-router 的建置 plugin。驗證方式：
  - 執行 `pnpm build`；
  - 再執行 `grep -rqE "picomatch|POSIX_REGEX_SOURCE|REGEX_NON_SPECIAL_CHARS|tinyglobby|fdir" apps/web/dist`；
  - 結果沒有相符項目（結束碼 1）。`apps/server/dist` 與 `apps/mcp/dist` 同樣沒有 picomatch。
- **觸發條件無法到達**：要觸發這個漏洞，攻擊者必須能控制 extglob 樣式。即使在建置時，所有 glob 樣式都來自儲存庫本身，從不來自使用者輸入。
- **沒有修補版**：npm 的最新版是 4.0.7，advisory 列出的受影響範圍是 `<=4.0.7`，且沒有修補版本。
- **原定移除條件**（已改由移除相依路徑達成）：picomatch 發布 ≥ 4.0.8 或其他修補版後，升級相依套件，並刪除 `pnpm-workspace.yaml` 的這一項與 `ALLOWED_AUDIT_IGNORES` 的對應項目。`check-audit-ignores.mjs` 會在修補版安裝後或 advisory 不再回報時失敗，提醒移除。

## 每日監看（audit-exceptions-watch）

Dependabot 警示在本儲存庫是關閉的，而 picomatch 是間接相依套件，每週的 Dependabot 版本更新不一定會升級它。因此另設每日排程，在修補版發布時通知維護者：

- **工作流程**：`.github/workflows/audit-exceptions-watch.yml`。每天 UTC 03:37 執行，也可手動觸發（`workflow_dispatch`）。它不是 PR 的必要檢查。
- **權限**：只有 `contents: read`，不需要任何 secret。actions 都以 commit SHA 鎖定。
- **步驟**：checkout，以與 CI 相同的 pnpm 與 Node 版本執行 `node scripts/check-audit-ignores.mjs --registry`。不執行 `pnpm install`，因為腳本只讀取 lockfile 並執行 `pnpm audit` 與 `npm view`，不需要 node_modules，也就不會執行相依套件的安裝腳本。
- **失敗條件**：除了一般檢查（清單一致、lockfile 仍含受影響版本、移除例外後 `pnpm audit --prod` 仍回報）之外，還會用 `npm view <套件> versions --json` 查詢 npm registry。下列任一情況都會讓工作失敗，GitHub 會寄信通知擁有者：
  - registry 已發布高於受影響範圍的正式版（預發布版本不算），例如 picomatch 出現 4.0.8 以上；
  - 移除例外後 `pnpm audit --prod` 不再回報該 GHSA；
  - 無法讀取 registry，以免監看在無聲中失效。
- **失敗訊息會列出移除步驟**：
  1. 升級套件（`pnpm update --recursive <套件>`，或升級鎖定它的上層套件）；
  2. 以 `pnpm install` 重新產生 lockfile；
  3. 刪除 `pnpm-workspace.yaml` 的 `auditConfig.ignoreGhsas` 與 `scripts/check-audit-ignores.mjs` 的 `ALLOWED_AUDIT_IGNORES` 中的項目；
  4. 刪除本文件中對應的段落。
- **判斷邏輯的測試**：`tests/web/scripts/check-audit-ignores.test.ts` 以假的 registry 與 audit 輸出測試判斷邏輯。
- **限制**：
  - 「修補版」以單一上限判斷：高於受影響範圍上限的正式版。若 advisory 涵蓋多條版本線，而在較舊的版本線釋出修補（backport），這個判斷不會察覺。新增這類例外時，須在本文件註明並手動追蹤。
  - GitHub 會在儲存庫 60 天沒有活動後停用排程工作流程，停用時不會通知。有例外存在時，請在 Actions 頁面確認它仍在執行。

## 待重新評估

- **vue-router 5.x**：`.github/dependabot.yml` 忽略 vue-router 5.0.0 以上的版本，因為 5.x 會把 picomatch 帶進 production 相依樹。
  - 符合下列任一條件時，重新評估是否升級：vue-router 5.x 不再依賴 picomatch；或 picomatch 發布修補 GHSA-fc5q-39xc-vjpf 的版本（≥ 4.0.8）。
  - 每日監看只檢查清單中的例外，而清單現在是空的，所以它不會提醒這一項，須以本段手動追蹤。
