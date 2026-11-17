# 相依套件稽核例外

CI 與 release 的「Production dependency audit」執行 `pnpm audit --prod --audit-level high`，這個指令與門檻不變。例外只寫在 `pnpm-workspace.yaml` 的 `auditConfig.ignoreGhsas`，每次只忽略一個指定的 GHSA，不調整 `--audit-level`，也不使用 overrides。

`node scripts/check-audit-ignores.mjs` 會檢查例外是否仍然需要。CI 的 Quality (ubuntu-latest) 在稽核步驟之後執行它。下列情況會失敗：

- 例外清單與腳本中的 `ALLOWED_AUDIT_IGNORES` 不一致，也就是新增或移除例外時沒有同時更新兩處；
- 在移除例外的暫存副本上執行 `pnpm audit --prod`，已不再回報該 GHSA；
- lockfile 已不含任何受影響版本，表示已裝上修補版。

單元測試 `tests/web/scripts/check-audit-ignores.test.ts` 把允許的清單固定為下方這一項，清單不會在無人察覺下增加。

## GHSA-fc5q-39xc-vjpf：picomatch ≤ 4.0.7 ReDoS（high）

- **加入**：1.6.52，經使用者核准。
- **相依路徑**：`apps/web` → `vue-router` 5.5.0 → `picomatch` 4.0.7，另經 `tinyglobby`／`fdir`、`unplugin`、`unplugin-utils`（`@vue-macros/common`）引入。lockfile 只有 picomatch 4.0.7 一個版本（`pnpm why picomatch --prod -r`）。
- **只在建置時使用**：picomatch 屬於 vue-router 的建置期工具（檔案路由 plugin），不會進入執行期的程式。`apps/web/vite.config.ts` 沒有使用 vue-router 的建置 plugin。驗證方式：
  - 執行 `pnpm build`；
  - 再執行 `grep -rqE "picomatch|POSIX_REGEX_SOURCE|REGEX_NON_SPECIAL_CHARS|tinyglobby|fdir" apps/web/dist`；
  - 結果沒有相符項目（結束碼 1）。`apps/server/dist` 與 `apps/mcp/dist` 同樣沒有 picomatch。
- **觸發條件無法到達**：要觸發這個漏洞，攻擊者必須能控制 extglob 樣式。即使在建置時，所有 glob 樣式都來自儲存庫本身，從不來自使用者輸入。
- **沒有修補版**：npm 的最新版是 4.0.7，advisory 列出的受影響範圍是 `<=4.0.7`，且沒有修補版本。
- **移除條件**：picomatch 發布 ≥ 4.0.8 或其他修補版後，升級相依套件，並刪除 `pnpm-workspace.yaml` 的這一項與 `ALLOWED_AUDIT_IGNORES` 的對應項目。`check-audit-ignores.mjs` 會在修補版安裝後或 advisory 不再回報時失敗，提醒移除。
