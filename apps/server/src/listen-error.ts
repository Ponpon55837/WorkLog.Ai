/** Turns a failed `server.listen` into a short, actionable message instead of Node's unhandled-error stack. */
export function describeListenError(error: unknown, port: number): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "EADDRINUSE") {
    return [
      `127.0.0.1:${port} 已被占用，Work Intelligence 沒有啟動。`,
      `可能已有 Work Intelligence 在執行（開啟 http://127.0.0.1:${port} 確認），或其他程式使用了這個 port。`,
      "請停止占用的程式，或設定 WORK_INTELLIGENCE_PORT 改用其他 port；也可以執行 pnpm run doctor 檢查。",
    ].join("\n");
  }
  if (code === "EACCES") {
    return `沒有權限使用 127.0.0.1:${port}。請設定 WORK_INTELLIGENCE_PORT 改用 1024 以上的 port。`;
  }
  return `Work Intelligence 無法在 127.0.0.1:${port} 啟動。請執行 pnpm run doctor 檢查。`;
}
