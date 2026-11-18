import { describe, expect, it } from "vitest";
import {
  APP_TABS,
  REPAIR_CHANNELS,
  REPAIR_CSP,
  REPAIR_ASSETS,
  TabMemory,
  blockingTab,
  buildRepairState,
  buildAppShellState,
  initialTab,
  isAppTab,
  isTrustedRepairSender,
  repairInputSchemas,
  resolveRepairAsset,
  shellMessages,
  tabForOperation,
  tabsFor,
  type AppTab,
} from "../../packages/desktop-core/src/index.js";

const calm = { needsSetup: false, owner: "MANAGED" as const, legacyHeld: false };

describe("the tab list", () => {
  it("is Status, Agent, Settings, Data, Diagnostics once the App is set up", () => {
    expect(APP_TABS).toEqual(["setup", "status", "agent", "settings", "data", "diagnostics"]);
    expect(tabsFor(false)).toEqual(["status", "agent", "settings", "data", "diagnostics"]);
  });

  it("puts Setup first, and only while the App needs setup", () => {
    expect(tabsFor(true)[0]).toBe("setup");
    expect(tabsFor(true)).toHaveLength(6);
    expect(tabsFor(false)).not.toContain("setup");
  });

  it("recognises only its own ids", () => {
    for (const tab of APP_TABS) expect(isAppTab(tab)).toBe(true);
    for (const value of ["repair", "agents", "", "Status", "__proto__", 1, null, undefined, {}]) {
      expect(isAppTab(value)).toBe(false);
    }
  });
});

describe("blockingTab", () => {
  it("is Status when the service needs repair or the old login service holds the database", () => {
    expect(blockingTab({ ...calm, owner: "NEEDS_REPAIR" })).toBe("status");
    expect(blockingTab({ ...calm, legacyHeld: true })).toBe("status");
  });

  it("is null when nothing blocks, and never while the App still needs setup", () => {
    expect(blockingTab(calm)).toBeNull();
    expect(blockingTab({ needsSetup: true, owner: "NEEDS_REPAIR", legacyHeld: true })).toBeNull();
  });
});

describe("initialTab", () => {
  it("defaults to Setup while the App needs it, else Status", () => {
    expect(initialTab({ ...calm, needsSetup: true })).toBe("setup");
    expect(initialTab(calm)).toBe("status");
  });

  it("prefers the remembered tab to the default", () => {
    expect(initialTab({ ...calm, remembered: "data" })).toBe("data");
    expect(initialTab({ ...calm, needsSetup: true, remembered: "agent" })).toBe("agent");
  });

  it("lets a blocking state beat the remembered tab", () => {
    expect(initialTab({ ...calm, owner: "NEEDS_REPAIR", remembered: "data" })).toBe("status");
    expect(initialTab({ ...calm, legacyHeld: true, remembered: "settings" })).toBe("status");
  });

  it("lets an explicit request beat a blocking state and the remembered tab", () => {
    expect(initialTab({ ...calm, owner: "NEEDS_REPAIR", remembered: "data", requested: "settings" })).toBe("settings");
    expect(initialTab({ ...calm, legacyHeld: true, requested: "agent" })).toBe("agent");
  });

  it("ignores a tab that does not exist for this state", () => {
    expect(initialTab({ ...calm, requested: "setup", remembered: "data" })).toBe("data");
    expect(initialTab({ ...calm, remembered: "setup" })).toBe("status");
  });
});

describe("TabMemory", () => {
  it("starts empty and remembers the last valid tab", () => {
    const memory = new TabMemory();
    expect(memory.recall()).toBeUndefined();
    expect(memory.remember("data", false)).toBe(true);
    expect(memory.recall()).toBe("data");
  });

  it("rejects unknown ids and keeps what it had", () => {
    const memory = new TabMemory();
    memory.remember("agent", false);
    for (const bad of ["repair", "agents", "", "SETTINGS", 7, null, undefined, { tab: "data" }]) {
      expect(memory.remember(bad, false)).toBe(false);
    }
    expect(memory.recall()).toBe("agent");
  });

  it("rejects Setup once the App is set up", () => {
    const memory = new TabMemory();
    expect(memory.remember("setup", false)).toBe(false);
    expect(memory.remember("setup", true)).toBe(true);
  });
});

describe("the page's tab channels", () => {
  it("names the three tab channels", () => {
    expect(REPAIR_CHANNELS.getTab).toBe("app:get-tab");
    expect(REPAIR_CHANNELS.rememberTab).toBe("app:remember-tab");
    expect(REPAIR_CHANNELS.selectTab).toBe("app:select-tab");
    expect(Object.values(REPAIR_CHANNELS)).not.toContain("app:get-view");
  });

  it("validates app:remember-tab against the allowlist", () => {
    const schema = repairInputSchemas.rememberTab;
    for (const tab of APP_TABS) expect(schema.safeParse({ tab }).success).toBe(true);
    for (const bad of [
      { tab: "repair" },
      { tab: "agents" },
      { tab: "" },
      { tab: 1 },
      { tab: "status", extra: true },
      { tabs: "status" },
      {},
      "status",
      null,
      undefined,
    ]) {
      expect(schema.safeParse(bad).success).toBe(false);
    }
    expect(repairInputSchemas.getTab.safeParse(undefined).success).toBe(true);
    expect(repairInputSchemas.getTab.safeParse({}).success).toBe(false);
  });

  it("is reachable only from the trusted sender", () => {
    const frameUrl = "wi-repair://app/index.html";
    expect(isTrustedRepairSender({ frameUrl, isMainFrame: true, fromRepairWindow: true })).toBe(true);
    expect(isTrustedRepairSender({ frameUrl, isMainFrame: true, fromRepairWindow: false })).toBe(false);
    expect(isTrustedRepairSender({ frameUrl, isMainFrame: false, fromRepairWindow: true })).toBe(false);
    expect(isTrustedRepairSender({ frameUrl: "https://example.com/", isMainFrame: true, fromRepairWindow: true })).toBe(
      false,
    );
  });
});

describe("the shell state", () => {
  it("marks the blocking tab with the attention dot", () => {
    const shell = buildAppShellState({ ...calm, owner: "NEEDS_REPAIR", operation: null });
    expect(shell.blockingTab).toBe("status");
    expect(shell.tabs).toEqual(tabsFor(false));
    expect(shell.badges.status).toEqual({ attention: true, busy: false });
    expect(shell.badges.data).toEqual({ attention: false, busy: false });
  });

  it("puts the busy mark on the tab the running operation belongs to", () => {
    const kinds: [Parameters<typeof tabForOperation>[0], AppTab][] = [
      ["change-port", "settings"],
      ["update-install", "settings"],
      ["change-db", "data"],
      ["restore", "data"],
      ["apply-agent", "agent"],
      ["restart", "status"],
      ["legacy-disable", "status"],
    ];
    for (const [kind, tab] of kinds) {
      const shell = buildAppShellState({ ...calm, operation: kind });
      expect(shell.badges[tab].busy).toBe(true);
      expect(APP_TABS.filter((other) => shell.badges[other].busy)).toEqual([tab]);
    }
    expect(tabForOperation("takeover", true)).toBe("setup");
    expect(tabForOperation("takeover", false)).toBe("status");
  });

  it("is part of the repair state, next to every earlier field", () => {
    const state = buildRepairState({
      platform: "linux",
      homeDirectory: "/synthetic/home",
      locale: "en",
      owner: "NEEDS_REPAIR",
      backend: "stopped",
      databasePath: null,
      databaseStatus: "unknown",
      candidates: [],
      recentErrors: [],
      lastBackup: { status: "none" },
      retryOperationId: "synthetic",
      busy: false,
      legacyBlocked: true,
      operation: "legacy-disable",
    });
    expect(state.shell.blockingTab).toBe("status");
    expect(state.shell.badges.status).toEqual({ attention: true, busy: true });
    expect(state.actions.some((action) => action.id === "start-anyway")).toBe(true);
    expect(state.port).toBeNull();
  });

  it("has a tab label, in both languages, for every tab", () => {
    for (const locale of ["zh-TW", "en"] as const) {
      const messages = shellMessages(locale);
      for (const tab of APP_TABS) expect(messages.tabLabels[tab].length).toBeGreaterThan(0);
      expect(messages.tabListLabel.length).toBeGreaterThan(0);
      expect(messages.tabAttentionLabel.length).toBeGreaterThan(0);
      expect(messages.tabBusyLabel.length).toBeGreaterThan(0);
    }
  });
});

describe("the page's fixed assets and CSP", () => {
  it("serves tokens.css and still refuses everything else", () => {
    expect(resolveRepairAsset("wi-repair://app/tokens.css")).toEqual({
      file: "tokens.css",
      contentType: "text/css; charset=utf-8",
    });
    expect([...REPAIR_ASSETS.keys()].sort()).toEqual(["/index.html", "/repair.css", "/repair.js", "/tokens.css"]);
    for (const url of [
      "wi-repair://app/ui-tokens/tokens.css",
      "wi-repair://app/tokens.css/",
      "wi-repair://app/Tokens.css",
      "wi-repair://app/tokens.css.map",
      "wi-repair://app/base.css",
    ]) {
      expect(resolveRepairAsset(url)).toBeUndefined();
    }
  });

  it("keeps style-src 'self' with no loosening", () => {
    expect(REPAIR_CSP).toContain("style-src 'self';");
    expect(REPAIR_CSP).not.toMatch(/unsafe|\*|https?:/);
  });
});
