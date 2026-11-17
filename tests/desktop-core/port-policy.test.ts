import { describe, expect, it } from "vitest";
import {
  BROWSER_RESTRICTED_PORTS,
  PORT_HANDOFF_TTL_MS,
  PortHandoffStore,
  dashboardUrlFor,
  isDashboardOpenUrl,
  isDeterministicFailure,
  portMessages,
  validatePortChange,
} from "../../packages/desktop-core/src/index.js";
import { encodePortHandoffFragment } from "../../packages/schema/src/index.js";

describe("the browser-restricted ports", () => {
  it("are exactly the Chromium and Firefox lists restricted to 1024-65535", () => {
    // Chromium net/base/port_util.cc kRestrictedPorts plus Firefox netwerk/base/nsIOService.cpp gBadPortList (4190, 6679).
    expect([...BROWSER_RESTRICTED_PORTS]).toEqual([
      1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
    ]);
  });
});

describe("validatePortChange", () => {
  it("accepts a decimal string or number from 1024 to 65535", () => {
    expect(validatePortChange("43210", 3210)).toEqual({ kind: "ok", port: 43_210 });
    expect(validatePortChange(" 1024 ", 3210)).toEqual({ kind: "ok", port: 1024 });
    expect(validatePortChange(65_535, 3210)).toEqual({ kind: "ok", port: 65_535 });
  });

  it("answers `same` for the current port", () => {
    expect(validatePortChange("3210", 3210)).toEqual({ kind: "same", port: 3210 });
    expect(validatePortChange(3210, null)).toEqual({ kind: "ok", port: 3210 });
  });

  it("refuses what is not a decimal integer", () => {
    for (const input of [
      "",
      "abc",
      "12.5",
      "-1",
      "0x400",
      "1e4",
      "１２３４５",
      undefined,
      null,
      {},
      12.5,
      Number.NaN,
    ]) {
      expect(validatePortChange(input, 3210)).toEqual({ kind: "invalid", problem: "not-a-number" });
    }
  });

  it("refuses ports out of range and below 1024", () => {
    expect(validatePortChange("65536", 3210)).toEqual({ kind: "invalid", problem: "out-of-range" });
    expect(validatePortChange(-5, 3210)).toEqual({ kind: "invalid", problem: "out-of-range" });
    for (const port of ["0", "1", "80", "1023"]) {
      expect(validatePortChange(port, 3210)).toEqual({ kind: "invalid", problem: "below-1024" });
    }
  });

  it("refuses every browser-restricted port", () => {
    for (const port of BROWSER_RESTRICTED_PORTS) {
      expect(validatePortChange(String(port), 3210)).toEqual({ kind: "invalid", problem: "browser-restricted" });
    }
    expect(validatePortChange("6670", 3210)).toEqual({ kind: "ok", port: 6670 });
  });
});

describe("portFailureCode", () => {
  it("is a failure a retry cannot fix", () => {
    expect(isDeterministicFailure("PORT_NOT_PERMITTED")).toBe(true);
  });
});

describe("PortHandoffStore", () => {
  it("hands the sanitized snapshot out once", () => {
    let now = 1000;
    const store = new PortHandoffStore(() => now);
    expect(store.holds()).toBe(false);
    store.put({ locale: "en-US", theme: "dark", secret: "x", sidePanelWidths: { session: 400 } }, "/reports");
    expect(store.holds()).toBe(true);
    expect(store.take()).toEqual({
      preferences: { locale: "en-US", theme: "dark", sidePanelWidths: { session: 400 } },
      route: "/reports",
    });
    expect(store.take()).toBeUndefined();
    expect(store.holds()).toBe(false);
    now += 1;
  });

  it("expires after two minutes and a new snapshot replaces the old one", () => {
    let now = 0;
    const store = new PortHandoffStore(() => now);
    store.put({ theme: "dark" }, "/a");
    now = PORT_HANDOFF_TTL_MS - 1;
    expect(store.holds()).toBe(true);
    now = PORT_HANDOFF_TTL_MS;
    expect(store.holds()).toBe(false);
    expect(store.take()).toBeUndefined();
    store.put({ theme: "dark" }, "/a");
    store.put({ theme: "light" }, "https://evil.example/");
    expect(store.take()).toEqual({ preferences: { theme: "light" }, route: "/" });
  });
});

describe("the Dashboard address after a port change", () => {
  it("is the plain root, or the root with exactly the handoff fragment", () => {
    expect(dashboardUrlFor(43_210)).toBe("http://127.0.0.1:43210/");
    const handoff = { preferences: { theme: "dark" as const }, route: "/reports" };
    const url = dashboardUrlFor(43_210, handoff);
    expect(url).toBe(`http://127.0.0.1:43210/#${encodePortHandoffFragment(handoff)}`);
    expect(isDashboardOpenUrl(url, 43_210)).toBe(true);
    expect(isDashboardOpenUrl("http://127.0.0.1:43210/", 43_210)).toBe(true);
  });

  it("refuses any other path, query, fragment, port or host", () => {
    const fragment = encodePortHandoffFragment({ preferences: {}, route: "/" });
    expect(isDashboardOpenUrl("http://127.0.0.1:43210/reports", 43_210)).toBe(false);
    expect(isDashboardOpenUrl("http://127.0.0.1:43210/?a=1", 43_210)).toBe(false);
    expect(isDashboardOpenUrl("http://127.0.0.1:43210/#other=1", 43_210)).toBe(false);
    expect(isDashboardOpenUrl("http://127.0.0.1:43210/#wi-handoff=!!!", 43_210)).toBe(false);
    expect(isDashboardOpenUrl(`http://127.0.0.1:43211/#${fragment}`, 43_210)).toBe(false);
    expect(isDashboardOpenUrl(`http://localhost:43210/#${fragment}`, 43_210)).toBe(false);
    expect(isDashboardOpenUrl(`http://127.0.0.1:43210/#${fragment}`, null)).toBe(false);
    expect(isDashboardOpenUrl("not a url", 43_210)).toBe(false);
  });
});

describe("portMessages", () => {
  it("defines a sentence for every problem in both languages", () => {
    for (const locale of ["zh-TW", "en"] as const) {
      const text = portMessages(locale);
      for (const problem of ["not-a-number", "out-of-range", "below-1024", "browser-restricted"] as const) {
        expect(text.problems[problem].length).toBeGreaterThan(0);
      }
      expect(text.trayChangePort.length).toBeGreaterThan(0);
    }
  });
});
