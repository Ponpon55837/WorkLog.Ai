import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageProjectsResponse, UsageScanResponse } from "@work-intelligence/core";
import { createStoreHarness, jsonResponse } from "../helpers/store-harness.js";
import { useUsageStore } from "../../../apps/web/src/stores/usage.js";
import {
  buildUsageScanRequest,
  canScanUsage,
  usageErrorMessage,
  usageProblemMessage,
} from "../../../apps/web/src/utils/usage.js";
import { t } from "../../../apps/web/src/i18n/index.js";

const mocks = vi.hoisted(() => ({ copyWithToast: vi.fn() }));

vi.mock("../../../apps/web/src/composables/useToast", () => ({
  useToast: () => ({ copyWithToast: mocks.copyWithToast, showToast: vi.fn() }),
}));

const PROJECTS: UsageProjectsResponse = {
  items: [
    { id: "p1", name: "Alpha", current: true, sources: { claudeFolders: 2, codexFiles: 1 } },
    { id: "p2", name: "Beta", current: false, sources: { claudeFolders: 0, codexFiles: 0 }, problem: "none-found" },
  ],
  groups: [{ projects: ["p1", "p2"], claudeFolders: 1, codexFiles: 0 }],
};

const SCAN: UsageScanResponse = {
  totals: {
    sessions: 2,
    turns: 10,
    assistantMessages: 12,
    toolCalls: 40,
    workIntelligenceCalls: 10,
    workIntelligenceShare: 0.25,
  },
  tokens: { input: 100, output: 50, cacheRead: 1000, cacheCreation: 200, primary: 150, cacheReadShare: 1000 / 1300 },
  models: [
    {
      agent: "claude-code",
      model: "model-a",
      tokens: { input: 100, output: 50, cacheRead: 1000, cacheCreation: 200 },
      primary: 150,
      responses: 12,
    },
  ],
  daily: [{ date: "2026-11-18", tokens: { input: 100, output: 50, cacheRead: 1000, cacheCreation: 200 } }],
  blocks: [],
  operations: [{ key: "work_read/work_get_session", calls: 4, resultChars: 4000, avgChars: 1000 }],
  sessions: [
    {
      label: "session-1",
      turns: 6,
      toolCalls: 20,
      tokens: { input: 1, output: 1, cacheRead: 1, cacheCreation: 1 },
      primary: 2,
    },
  ],
  otherTools: [{ name: "Bash", calls: 30 }],
  forAgentText: "Agent usage report\nTurns: 10",
  cache: { reused: 1, appended: 0, parsed: 2 },
  allocation: { groups: [] },
  durationMs: 120,
  range: { since: "2026-11-16T00:00:00.000Z", until: null },
  problems: [{ projectId: "p2", problem: "none-found" }],
};

let harness: ReturnType<typeof createStoreHarness>;

beforeEach(() => {
  mocks.copyWithToast.mockReset().mockResolvedValue(true);
});

afterEach(async () => {
  await harness.cleanup();
});

describe("usage store", () => {
  it("loads tracked projects and runs a scan", async () => {
    harness = createStoreHarness(({ url }) => (url.pathname === "/api/usage/projects" ? PROJECTS : SCAN));
    const store = useUsageStore();
    store.setUsageActive(true);
    await vi.waitFor(() => expect(store.projectsLoaded).toBe(true));
    expect(store.projects.map((project) => project.name)).toEqual(["Alpha", "Beta"]);

    await store.runScan({ projectIds: ["p1"], range: "7d" });
    expect(store.scanResult?.totals.workIntelligenceShare).toBe(0.25);
    expect(store.scanResult?.operations[0]?.key).toBe("work_read/work_get_session");
    expect(store.scanResult?.tokens.primary).toBe(150);
    expect(store.scanResult?.models[0]?.model).toBe("model-a");
    expect(harness.calls.find(({ url }) => url.pathname === "/api/usage/scan")).toMatchObject({
      method: "POST",
      body: { projectIds: ["p1"], range: "7d" },
    });
    expect(store.scanError).toBe("");
    store.setUsageActive(false);
  });

  it("copies the server text verbatim and nothing before a scan", async () => {
    harness = createStoreHarness(() => SCAN);
    const store = useUsageStore();
    expect(await store.copyForAgent()).toBe(false);
    expect(mocks.copyWithToast).not.toHaveBeenCalled();

    await store.runScan({ all: true, range: "30d" });
    expect(await store.copyForAgent()).toBe(true);
    expect(mocks.copyWithToast).toHaveBeenCalledWith("Agent usage report\nTurns: 10", t("usage.copied"));
  });

  it("keeps an empty scan result for the empty state", async () => {
    const empty: UsageScanResponse = {
      ...SCAN,
      totals: {
        sessions: 0,
        turns: 0,
        assistantMessages: 0,
        toolCalls: 0,
        workIntelligenceCalls: 0,
        workIntelligenceShare: 0,
      },
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, primary: 0, cacheReadShare: null },
      models: [],
      daily: [],
      operations: [],
      sessions: [],
      otherTools: [],
    };
    harness = createStoreHarness(() => empty);
    const store = useUsageStore();
    await store.runScan({ all: true, range: "7d" });
    expect(store.scanResult?.totals.turns).toBe(0);
    expect(store.scanResult?.operations).toEqual([]);
    expect(store.scanResult?.tokens.cacheReadShare).toBeNull();
  });

  it.each([
    ["usage_timeout", "usage.errorTimeout"],
    ["usage_cancelled", "usage.errorCancelled"],
    ["usage_failed", "usage.errorFailed"],
  ] as const)("explains the %s server code", async (code, key) => {
    harness = createStoreHarness(() => jsonResponse({ code, error: "internal detail" }, 500));
    const store = useUsageStore();
    await store.runScan({ all: true, range: "7d" });
    expect(store.scanResult).toBeNull();
    expect(store.scanError).toBe(t(key));
    expect(store.scanError).not.toContain("internal detail");
  });
});

describe("usage helpers", () => {
  it("builds the request without echoing blank folders and bounds custom dates", () => {
    const request = buildUsageScanRequest({
      all: false,
      projectIds: ["p1"],
      range: "custom",
      since: "2026-11-01",
      until: "2026-11-05",
      manualFolders: ["  /tmp/x  ", "  "],
    });
    expect(request).toMatchObject({ projectIds: ["p1"], manualFolders: ["/tmp/x"], range: "custom" });
    expect(Date.parse(request.since ?? "")).toBeLessThan(Date.parse(request.until ?? ""));
    expect(
      buildUsageScanRequest({ all: true, projectIds: ["p1"], range: "7d", since: "", until: "", manualFolders: [] }),
    ).toEqual({
      all: true,
      range: "7d",
    });
  });

  it("needs a project, All projects or a folder to scan", () => {
    const base = { all: false, projectIds: [], range: "7d", since: "", until: "", manualFolders: [] } as const;
    expect(canScanUsage(base)).toBe(false);
    expect(canScanUsage({ ...base, all: true })).toBe(true);
    expect(canScanUsage({ ...base, manualFolders: ["/tmp/x"] })).toBe(true);
  });

  it("explains per-project problems and unknown error codes", () => {
    expect(usageProblemMessage("permission-denied")).toBe(t("usage.problemPermissionDenied"));
    expect(usageProblemMessage("claude-dir-missing")).toBe(t("usage.problemClaudeDirMissing"));
    expect(usageErrorMessage("something_else")).toBe(t("usage.errorGeneric"));
  });
});
