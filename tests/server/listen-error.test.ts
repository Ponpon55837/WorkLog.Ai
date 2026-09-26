import { describe, expect, it } from "vitest";
import { describeListenError } from "../../apps/server/src/listen-error.js";

describe("describeListenError", () => {
  it("explains an occupied port and how to recover", () => {
    const message = describeListenError(Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }), 3210);
    expect(message).toContain("127.0.0.1:3210 已被占用");
    expect(message).toContain("WORK_INTELLIGENCE_PORT");
    expect(message).not.toContain("listen EADDRINUSE");
  });

  it("explains a port the user may not bind", () => {
    expect(describeListenError({ code: "EACCES" }, 80)).toContain("沒有權限使用 127.0.0.1:80");
  });

  it("falls back to a generic message without leaking the original error", () => {
    const message = describeListenError(new Error("secret internal detail"), 4000);
    expect(message).toContain("無法在 127.0.0.1:4000 啟動");
    expect(message).not.toContain("secret internal detail");
  });
});
