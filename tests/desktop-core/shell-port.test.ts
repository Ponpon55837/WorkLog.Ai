import { describe, expect, it } from "vitest";
import {
  buildRepairState,
  buildTrayMenu,
  errorHintFor,
  repairInputSchemas,
  setupMessages,
  shellMessages,
} from "../../packages/desktop-core/src/index.js";

describe("the tray no longer carries 「變更連接埠…」 (the port is on the Settings tab)", () => {
  const base = { messages: shellMessages("zh-TW"), owner: "MANAGED" as const, backendRunning: true };

  it("has no port item, set up or not", () => {
    for (const needsSetup of [false, true]) {
      const setup = { messages: setupMessages("zh-TW"), needsSetup };
      const ids: string[] = buildTrayMenu({ ...base, setup }).map((item) => item.id);
      expect(ids).not.toContain("change-port");
      expect(ids).not.toContain("repair");
    }
  });
});

describe("the repair state's port section and the port input", () => {
  it("carries the section main gives, or null", () => {
    const inputs = {
      platform: "linux" as const,
      homeDirectory: "/synthetic/home",
      locale: "en" as const,
      owner: "MANAGED" as const,
      backend: "running" as const,
      databasePath: null,
      databaseStatus: "ok" as const,
      candidates: [],
      recentErrors: [],
      lastBackup: { status: "none" as const },
      retryOperationId: "synthetic",
      busy: false,
    };
    expect(buildRepairState(inputs).port).toBeNull();
    const port = { port: 43_100, activePort: 43_100, focus: true, handoffHeld: true };
    expect(buildRepairState({ ...inputs, port }).port).toEqual(port);
  });

  it("accepts a text or number port and nothing else", () => {
    const schema = repairInputSchemas.portChange;
    expect(schema.safeParse({ port: "43100" }).success).toBe(true);
    expect(schema.safeParse({ port: 43_100 }).success).toBe(true);
    expect(schema.safeParse({ port: null }).success).toBe(false);
    expect(schema.safeParse({ port: "1", extra: 1 }).success).toBe(false);
  });
});

describe("the port error messages", () => {
  it("point at 變更連接埠 and name the OS refusal apart from an occupied port", () => {
    const zh = shellMessages("zh-TW");
    expect(errorHintFor(zh, "PORT_OCCUPIED_BY_OTHER", false)).toContain("連接埠");
    expect(zh.errors.PORT_NOT_PERMITTED.title).not.toBe(zh.errors.PORT_OCCUPIED_BY_OTHER.title);
    const en = shellMessages("en");
    expect(en.errors.PORT_NOT_PERMITTED.hint.length).toBeGreaterThan(0);
  });
});
