import { describe, expect, it } from "vitest";
import {
  buildRepairState,
  buildTrayMenu,
  canApplyPreview,
  errorHintFor,
  errorMessageFor,
  hasUndiffableFile,
  isFileOpen,
  interpretSecondInstanceData,
  isDeterministicFailure,
  isOpenAgentSetupLaunch,
  maskHome,
  OPEN_AGENT_SETUP_FLAG,
  OPEN_AGENT_SETUP_SECOND_INSTANCE_DATA,
  repairInputSchemas,
  RestartPolicy,
  setupMessages,
  shellMessages,
  type AgentsPreview,
  type RepairStateInputs,
} from "../../packages/desktop-core/src/shell/index.js";
import type { LegacyServiceDetection } from "../../packages/desktop-core/src/legacy-service/types.js";

const zh = shellMessages("zh-TW");
const zhSetup = setupMessages("zh-TW");
const enSetup = setupMessages("en");

const legacyFound: LegacyServiceDetection = {
  kind: "found",
  platform: "linux",
  definitionPath: "/home/tester/.config/systemd/user/work-intelligence.service",
  definitionSource: "file",
  recognised: true,
  running: "running",
};

const repairBase: RepairStateInputs = {
  platform: "linux",
  homeDirectory: "/home/tester",
  locale: "en",
  owner: "NEEDS_REPAIR",
  backend: "stopped",
  databasePath: "/home/tester/data.db",
  databaseStatus: "ok",
  candidates: [],
  recentErrors: [],
  lastBackup: { status: "none" },
  retryOperationId: "op-1",
  busy: false,
};

function keyPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => keyPaths(child, prefix ? `${prefix}.${key}` : key));
}

describe("buildTrayMenu with setup items", () => {
  const setup = (needsSetup: boolean) => ({
    messages: { trayCompleteSetup: "COMPLETE" },
    needsSetup,
  });

  it("puts complete-setup first while the App still needs setup", () => {
    const menu = buildTrayMenu({ messages: zh, owner: "MANAGED", backendRunning: true, setup: setup(true) });
    expect(menu.map((item) => item.id)).toEqual(["complete-setup", "open-dashboard", "open-app", "separator", "quit"]);
    expect(menu[0]).toEqual({ id: "complete-setup", label: "COMPLETE", enabled: true });
  });

  it("drops complete-setup once setup is done (Agent setup is a tab, not a tray item)", () => {
    const menu = buildTrayMenu({ messages: zh, owner: "MANAGED", backendRunning: true, setup: setup(false) });
    expect(menu.map((item) => item.id)).toEqual(["open-dashboard", "open-app", "separator", "quit"]);
  });

  it("leaves the menu unchanged without setup", () => {
    const menu = buildTrayMenu({ messages: zh, owner: "MANAGED", backendRunning: true });
    expect(menu.map((item) => item.id)).toEqual(["open-dashboard", "open-app", "separator", "quit"]);
  });
});

describe("open-agent-setup launch", () => {
  it("recognizes the flag by its exact spelling", () => {
    expect(OPEN_AGENT_SETUP_FLAG).toBe("--open-agent-setup");
    expect(isOpenAgentSetupLaunch(["app", "--open-agent-setup"])).toBe(true);
    expect(isOpenAgentSetupLaunch(["app", "--open-agent-setup=1", "--open-dashboard"])).toBe(false);
  });

  it("interprets exactly { action: 'open-agent-setup' }", () => {
    expect(interpretSecondInstanceData({ action: "open-agent-setup" })).toEqual({ command: "open-agent-setup" });
    expect(interpretSecondInstanceData(OPEN_AGENT_SETUP_SECOND_INSTANCE_DATA)).toEqual({
      command: "open-agent-setup",
    });
  });

  it("rejects extra fields and other spellings", () => {
    const rejected = { command: "open", rejected: true };
    expect(interpretSecondInstanceData({ action: "open-agent-setup", path: "/home/tester/x" })).toEqual(rejected);
    expect(interpretSecondInstanceData({ action: "OPEN-AGENT-SETUP" })).toEqual(rejected);
  });
});

describe("maskHome", () => {
  it("replaces a posix home prefix with ~ wherever it appears", () => {
    expect(maskHome("/home/tester/a and /home/tester/b", "/home/tester", "linux")).toBe("~/a and ~/b");
  });

  it("is case-sensitive on posix", () => {
    expect(maskHome("/HOME/tester/a", "/home/tester", "linux")).toBe("/HOME/tester/a");
  });

  it("matches Windows paths case-insensitively with either slash or escaped backslashes", () => {
    const home = "C:\\Users\\tester";
    expect(maskHome("c:\\users\\TESTER\\file.txt", home, "win32")).toBe("~\\file.txt");
    expect(maskHome("C:/Users/tester/file.txt", home, "win32")).toBe("~/file.txt");
    expect(maskHome('{"path":"C:\\\\Users\\\\tester\\\\x"}', home, "win32")).toBe('{"path":"~\\\\x"}');
  });

  it("leaves text alone without a home directory", () => {
    expect(maskHome("/home/tester/a", "", "linux")).toBe("/home/tester/a");
  });

  it("does not mask a path that merely shares the home prefix", () => {
    expect(maskHome("/home/tester2/a", "/home/tester", "linux")).toBe("/home/tester2/a");
  });
});

describe("LEGACY_SERVICE_ACTIVE restart policy", () => {
  it("is a deterministic failure", () => {
    expect(isDeterministicFailure("LEGACY_SERVICE_ACTIVE")).toBe(true);
  });

  it("never schedules an automatic retry and does not use the retry budget", () => {
    const policy = new RestartPolicy({ clock: () => 0 });
    for (let index = 0; index < 5; index += 1) {
      expect(policy.decide("LEGACY_SERVICE_ACTIVE")).toEqual({ retry: false, reason: "deterministic" });
    }
    expect(policy.decide("BACKEND_CRASHED")).toMatchObject({ retry: true, attempt: 1 });
  });
});

describe("buildRepairState legacyService", () => {
  const actionIds = (state: ReturnType<typeof buildRepairState>) => state.actions.map((action) => action.id);

  it("is null when no legacy service was detected", () => {
    expect(buildRepairState(repairBase).legacyService).toBeNull();
    expect(
      buildRepairState({ ...repairBase, legacyService: { kind: "none" }, legacyBlocked: true }).legacyService,
    ).toBe(null);
  });

  it("projects blocked and portInUse from their own inputs", () => {
    const state = buildRepairState({
      ...repairBase,
      legacyService: legacyFound,
      legacyBlocked: true,
      legacyPortInUse: true,
    });
    expect(state.legacyService).toEqual({
      running: "running",
      blocked: true,
      portInUse: true,
      // No definition digest in the fixture: not one the App may disable.
      canDisable: false,
    });
    const other = buildRepairState({ ...repairBase, legacyService: legacyFound, legacyPortInUse: true });
    expect(other.legacyService).toMatchObject({ blocked: false, portInUse: true });
    const blockedOnly = buildRepairState({ ...repairBase, legacyService: legacyFound, legacyBlocked: true });
    expect(blockedOnly.legacyService).toMatchObject({ blocked: true, portInUse: false });
  });

  it("names the OS place to open by hand per platform, and none where the App has no such place", () => {
    const stateOn = (platform: "darwin" | "linux" | "win32") =>
      buildRepairState({ ...repairBase, legacyService: { ...legacyFound, platform } }).legacyService;
    expect(stateOn("win32")).toMatchObject({ systemSettings: "task-scheduler" });
    expect(stateOn("darwin")).toMatchObject({ systemSettings: "login-items" });
    expect(stateOn("linux")).not.toHaveProperty("systemSettings");
    expect(JSON.stringify(stateOn("win32"))).not.toMatch(/Command|pnpm/);
  });

  it("offers start-anyway only when blocked, enabled while idle", () => {
    expect(actionIds(buildRepairState(repairBase))).not.toContain("start-anyway");
    expect(actionIds(buildRepairState({ ...repairBase, legacyService: legacyFound }))).not.toContain("start-anyway");
    expect(actionIds(buildRepairState({ ...repairBase, legacyPortInUse: true }))).not.toContain("start-anyway");
    const blocked = buildRepairState({ ...repairBase, legacyService: legacyFound, legacyBlocked: true });
    expect(blocked.actions.find((action) => action.id === "start-anyway")).toEqual({
      id: "start-anyway",
      enabled: true,
    });
    const busy = buildRepairState({ ...repairBase, legacyService: legacyFound, legacyBlocked: true, busy: true });
    expect(busy.actions.find((action) => action.id === "start-anyway")?.enabled).toBe(false);
  });
});

describe("legacy service messages", () => {
  it.each(["zh-TW", "en"] as const)("defines a LEGACY_SERVICE_ACTIVE error message in %s", (locale) => {
    const messages = shellMessages(locale);
    const message = errorMessageFor(messages, "LEGACY_SERVICE_ACTIVE");
    expect(message).toBe(messages.errors.LEGACY_SERVICE_ACTIVE);
    expect(message).not.toBe(messages.errors.REPAIR_REQUIRED);
    expect(message.title.length).toBeGreaterThan(0);
    expect(message.hint.length).toBeGreaterThan(0);
  });

  it("words the zh-TW legacy warning exactly", () => {
    expect(zhSetup.legacyWarning).toBe("偵測到舊的登入服務也在使用這份資料庫；同時執行兩個後端可能造成問題");
  });

  it("defines the same keys in both setup locales", () => {
    expect(keyPaths(enSetup).sort()).toEqual(keyPaths(zhSetup).sort());
    expect(keyPaths(enSetup).length).toBeGreaterThan(20);
  });
});

describe("Agent hook texts", () => {
  it("names who manages a working hook and says a checkout's setup keeps working", () => {
    expect(zhSetup.agentHookInstalled).toEqual({
      app: "已安裝（由 App 管理）",
      checkout: "已安裝（由 checkout 管理）",
      plugin: "已安裝（由 plugin 管理）",
    });
    expect(zhSetup.agentHookNotInstalled).toEqual({
      stale: "需要更新",
      missing: "未設定",
      disabled: "已停用",
      unknown: "無法判斷",
    });
    expect(zhSetup.agentsHookCheckoutNote).toContain(zhSetup.agentsPreviewAdopt);
    expect(zhSetup.agentsHookCheckoutNote).toContain("選用");
    expect(enSetup.agentsHookCheckoutNote).toContain("optional");
  });

  it("defines the same hook keys in both setup locales", () => {
    for (const name of ["agentHookInstalled", "agentHookNotInstalled"] as const) {
      expect(keyPaths(enSetup[name])).toEqual(keyPaths(zhSetup[name]));
    }
  });
});

describe("LEGACY_SERVICE_ACTIVE hint selection", () => {
  it.each(["zh-TW", "en"] as const)("names 'start anyway' only where the button exists (%s)", (locale) => {
    const messages = shellMessages(locale);
    const withButton = errorHintFor(messages, "LEGACY_SERVICE_ACTIVE", true);
    const without = errorHintFor(messages, "LEGACY_SERVICE_ACTIVE", false);
    expect(withButton).toBe(messages.errors.LEGACY_SERVICE_ACTIVE.hint);
    expect(without).toBe(messages.legacyActiveNoOverrideHint);
    // Both hints say where to turn the service off, in the one wording, and neither asks for a command.
    expect(withButton).toContain(locale === "zh-TW" ? "「狀態」分頁" : "Status tab");
    expect(without).toContain(locale === "zh-TW" ? "「狀態」分頁" : "Status tab");
    expect(without).not.toMatch(/仍要啟動|Start anyway/);
  });

  it("leaves every other code's hint alone", () => {
    const messages = shellMessages("en");
    expect(errorHintFor(messages, "DB_MISSING", false)).toBe(messages.errors.DB_MISSING.hint);
    expect(errorHintFor(messages, "UNKNOWN_CODE", false)).toBe(messages.errors.REPAIR_REQUIRED.hint);
  });

  it("words the large-file note and the acknowledgement in both languages", () => {
    expect(shellMessages("zh-TW").agentsTooLargeNote).toBe("檔案過大，無法顯示差異");
    expect(shellMessages("zh-TW").agentsAckUndiffable).toBe("我了解有檔案無法顯示差異");
    expect(shellMessages("en").agentsTooLargeNote.length).toBeGreaterThan(0);
    expect(shellMessages("en").agentsAckUndiffable.length).toBeGreaterThan(0);
  });
});

describe("applying a preview with a file that has no diff shown", () => {
  const file = (display: string, tooLarge: boolean): AgentsPreview["files"][number] => ({
    display,
    label: "config",
    change: "update",
    tooLarge,
    hunks: [],
  });
  const preview = (files: AgentsPreview["files"], conflicts: string[] = []): AgentsPreview => ({
    id: "11111111-1111-4111-8111-111111111111",
    mode: "install",
    adopt: false,
    files,
    actions: [],
    conflicts,
  });

  it("finds an undiffable file", () => {
    expect(hasUndiffableFile(preview([file("~/a", false)]))).toBe(false);
    expect(hasUndiffableFile(preview([file("~/a", false), file("~/b", true)]))).toBe(true);
  });

  it("needs the acknowledgement only when a file is undiffable", () => {
    expect(canApplyPreview(preview([file("~/a", false)]), false)).toBe(true);
    expect(canApplyPreview(preview([file("~/a", false), file("~/b", true)]), false)).toBe(false);
    expect(canApplyPreview(preview([file("~/a", false), file("~/b", true)]), true)).toBe(true);
  });

  it("never applies an empty or conflicting plan", () => {
    expect(canApplyPreview(preview([]), true)).toBe(false);
    expect(canApplyPreview(preview([file("~/a", false)], ["conflict"]), true)).toBe(false);
  });

  it("accepts the acknowledgement flag in the apply input and rejects anything else", () => {
    const schema = repairInputSchemas.agentsApply;
    const previewId = "11111111-1111-4111-8111-111111111111";
    expect(schema.safeParse({ previewId }).success).toBe(true);
    expect(schema.safeParse({ previewId, acknowledgeUndiffable: true }).success).toBe(true);
    expect(schema.safeParse({ previewId, acknowledgeUndiffable: "yes" }).success).toBe(false);
    expect(schema.safeParse({ previewId, extra: 1 }).success).toBe(false);
  });

  it("lets the preview name the Agents to set up, at least one and only known ones (M-17)", () => {
    const schema = repairInputSchemas.agentsPreview;
    expect(schema.safeParse({ adopt: false }).success).toBe(true);
    expect(schema.safeParse({ adopt: false, agents: ["claude-code"] }).success).toBe(true);
    expect(schema.safeParse({ adopt: true, agents: ["codex", "claude-code"] }).success).toBe(true);
    expect(schema.safeParse({ adopt: false, agents: [] }).success).toBe(false);
    expect(schema.safeParse({ adopt: false, agents: ["claude-desktop"] }).success).toBe(false);
    expect(schema.safeParse({ adopt: false, agents: "codex" }).success).toBe(false);
  });

  it("lets the page name only a known Agent when it asks to use the checkout's database, never a path", () => {
    const schema = repairInputSchemas.agentsUseCheckoutDatabase;
    expect(schema.safeParse({ agent: "codex" }).success).toBe(true);
    expect(schema.safeParse({ agent: "claude-code" }).success).toBe(true);
    expect(schema.safeParse({ agent: "claude-desktop" }).success).toBe(false);
    expect(schema.safeParse({ agent: "codex", path: "/synthetic/other.sqlite" }).success).toBe(false);
  });
});

describe("which diffs stay open across a refresh", () => {
  it("opens the first file by default and keeps the user's choice", () => {
    const chosen = new Map<string, boolean>();
    expect(isFileOpen(chosen, "~/a", 0)).toBe(true);
    expect(isFileOpen(chosen, "~/b", 1)).toBe(false);
    chosen.set("~/b", true);
    chosen.set("~/a", false);
    expect(isFileOpen(chosen, "~/b", 1)).toBe(true);
    expect(isFileOpen(chosen, "~/a", 0)).toBe(false);
  });
});
