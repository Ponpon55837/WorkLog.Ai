import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStoreHarness, jsonResponse } from "../helpers/store-harness.js";
import { useSystemStatusStore } from "../../../apps/web/src/stores/system-status.js";
import { t } from "../../../apps/web/src/i18n/index.js";

const mocks = vi.hoisted(() => ({ showToast: vi.fn() }));

vi.mock("../../../apps/web/src/composables/useToast", () => ({
  useToast: () => ({ showToast: mocks.showToast }),
}));

const STORE_KEYS = new Map<string, string>();

const LEGACY = {
  running: "running",
  removeCommand: "synthetic-remove --legacy",
  fallbackRemoveCommand: "synthetic-fallback --legacy",
};

let harness: ReturnType<typeof createStoreHarness>;

beforeEach(() => {
  mocks.showToast.mockClear();
});

afterEach(async () => {
  await harness.cleanup();
});

describe("system status store, desktop App", () => {
  it("exposes the desktop facts the API reported, and none outside the App", async () => {
    harness = createStoreHarness(({ url }) =>
      url.pathname === "/api/system/status"
        ? { version: "1.0.0", desktop: { managed: true, legacyService: LEGACY } }
        : {},
    );
    const store = useSystemStatusStore();
    store.setSystemStatusActive(true);
    await vi.waitFor(() => expect(store.systemStatus).not.toBeNull());
    expect(store.systemStatus?.desktop).toEqual({ managed: true, legacyService: LEGACY });
    store.setSystemStatusActive(false);
  });

  it("asks the App to open Agent setup and confirms", async () => {
    harness = createStoreHarness(() => ({ ok: true }));
    const store = useSystemStatusStore();
    await store.openDesktopAgentSetup();

    const call = harness.calls.find(({ url }) => url.pathname === "/api/desktop/open-agent-setup");
    expect(call).toMatchObject({ method: "POST", body: {} });
    expect(mocks.showToast).toHaveBeenCalledWith(t("systemStatus.agentSetupOpenedInDesktopApp"), "success");
    expect(store.agentSetupOpening).toBe(false);
  });

  it("reports a failure instead of a confirmation", async () => {
    harness = createStoreHarness(() => jsonResponse({ code: "not_found", error: "no" }, 404));
    const store = useSystemStatusStore();
    await store.openDesktopAgentSetup();

    expect(mocks.showToast).toHaveBeenCalledTimes(1);
    expect(mocks.showToast).toHaveBeenCalledWith(expect.any(String), "danger");
    expect(mocks.showToast).not.toHaveBeenCalledWith(t("systemStatus.agentSetupOpenedInDesktopApp"), "success");
  });

  it("exposes the active port and storage risk the API reported", async () => {
    const desktop = { managed: true, activePort: 40_123, storageRisk: { risk: "removable", migrationBlocked: true } };
    harness = createStoreHarness(({ url }) =>
      url.pathname === "/api/system/status" ? { version: "1.0.0", desktop } : {},
    );
    const store = useSystemStatusStore();
    store.setSystemStatusActive(true);
    await vi.waitFor(() => expect(store.systemStatus).not.toBeNull());
    expect(store.systemStatus?.desktop).toEqual(desktop);
    store.setSystemStatusActive(false);
  });

  it("asks the App to open port settings with the stored whitelisted preferences and the route path", async () => {
    STORE_KEYS.clear();
    STORE_KEYS.set("work-intelligence:theme", "dark");
    STORE_KEYS.set("work-intelligence:token", "secret");
    STORE_KEYS.set("wi.side-panel-width.session", "480");
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => STORE_KEYS.get(key) ?? null,
        setItem: (key: string, value: string) => STORE_KEYS.set(key, value),
      },
    });
    try {
      harness = createStoreHarness(() => ({ ok: true }));
      const store = useSystemStatusStore();
      await store.openDesktopPortSettings("/sessions/abc");

      const call = harness.calls.find(({ url }) => url.pathname === "/api/desktop/open-port-settings");
      expect(call).toMatchObject({
        method: "POST",
        body: { preferences: { theme: "dark", sidePanelWidths: { session: 480 } }, route: "/sessions/abc" },
      });
      expect(mocks.showToast).toHaveBeenCalledWith(t("systemStatus.portSettingsOpenedInDesktopApp"), "success");
      expect(store.portSettingsOpening).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports a port settings failure instead of a confirmation", async () => {
    harness = createStoreHarness(() => jsonResponse({ code: "not_found", error: "no" }, 404));
    const store = useSystemStatusStore();
    await store.openDesktopPortSettings("/");
    expect(mocks.showToast).toHaveBeenCalledTimes(1);
    expect(mocks.showToast).toHaveBeenCalledWith(expect.any(String), "danger");
  });
});
