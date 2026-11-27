import { beforeEach, describe, expect, it, vi } from "vitest";

// Only `shell` of Electron is read by this module, and the test gives its own system call.
vi.mock("electron", () => ({ shell: {} }));

const { createDashboard } = await import("../../apps/desktop/src/main/dashboard.js");

const openExternal = vi.fn<(url: string) => Promise<void>>();

const URL_TEXT = "https://github.com/Ponpon55837/WorkLog.Ai/releases";

function setup(record = false) {
  const logs: string[] = [];
  const dashboard = createDashboard({ running: () => undefined, log: (line) => logs.push(line), record, openExternal });
  return { dashboard, logs };
}

beforeEach(() => {
  openExternal.mockReset();
});

describe("opening a link", () => {
  it("says it opened only after the system accepted it", async () => {
    let accept: () => void = () => undefined;
    openExternal.mockImplementation(() => new Promise<void>((resolve) => (accept = resolve)));
    const answer = vi.fn();
    const pending = setup().dashboard.openLink(URL_TEXT).then(answer);
    await Promise.resolve();
    expect(openExternal).toHaveBeenCalledWith(URL_TEXT);
    expect(answer).not.toHaveBeenCalled();
    accept();
    await pending;
    expect(answer).toHaveBeenCalledWith(true);
  });

  it("says it did not open when the system rejects, instead of leaving the rejection unhandled", async () => {
    openExternal.mockRejectedValue(new Error("synthetic: no handler"));
    expect(await setup().dashboard.openLink(URL_TEXT)).toBe(false);
  });

  it("records the URL instead of opening it in a test run", async () => {
    const { dashboard } = setup(true);
    expect(await dashboard.openLink(URL_TEXT)).toBe(true);
    expect(dashboard.recorded).toEqual([URL_TEXT]);
    expect(openExternal).not.toHaveBeenCalled();
  });
});
