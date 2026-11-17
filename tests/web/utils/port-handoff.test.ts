import { describe, expect, it, vi } from "vitest";
import { encodePortHandoffFragment } from "../../../packages/schema/src/index.js";
import {
  consumePortHandoff,
  gateHandoffRoute,
  readBrowserPreferences,
  type PortHandoffHost,
} from "../../../apps/web/src/utils/port-handoff.js";

// Synthetic values only.
function createHost(hash: string, initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const replaceUrl = vi.fn();
  const host: PortHandoffHost = {
    hash,
    pathname: "/system-status",
    search: "?tab=a",
    storage: { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => void store.set(key, value) },
    replaceUrl,
  };
  return { host, store, replaceUrl };
}

function toBase64Url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("consumePortHandoff", () => {
  it("stores each whitelisted value under its existing key, clears the hash and returns the route", () => {
    const fragment = encodePortHandoffFragment({
      preferences: {
        locale: "en-US",
        theme: "dark",
        editor: "cursor",
        projectsPolicyDismissed: true,
        sidePanelWidths: { session: 480, "graph-node": 320 },
      },
      route: "/sessions/abc",
    });
    const { host, store, replaceUrl } = createHost(`#${fragment}`);

    expect(consumePortHandoff(host)).toBe("/sessions/abc");
    expect(Object.fromEntries(store)).toEqual({
      "work-intelligence:locale": "en-US",
      "work-intelligence:theme": "dark",
      "work-intelligence:editor": "cursor",
      "wi.projects.policyDismissed": "1",
      "wi.side-panel-width.session": "480",
      "wi.side-panel-width.graph-node": "320",
    });
    expect(replaceUrl).toHaveBeenCalledWith("/system-status?tab=a");
  });

  it("writes nothing for a hash that is not a handoff and leaves the URL alone", () => {
    for (const hash of ["", "#section-2", "#other=abc"]) {
      const { host, store, replaceUrl } = createHost(hash);
      expect(consumePortHandoff(host)).toBeUndefined();
      expect(store.size).toBe(0);
      expect(replaceUrl).not.toHaveBeenCalled();
    }
  });

  it("writes nothing from a malicious or malformed fragment, but still clears it", () => {
    const hashes = [
      "#wi-handoff=@@@",
      `#wi-handoff=${toBase64Url("not json")}`,
      `#wi-handoff=${toBase64Url('{"v":2,"preferences":{"theme":"dark"}}')}`,
      `#wi-handoff=${"A".repeat(5000)}`,
    ];
    for (const hash of hashes) {
      const { host, store, replaceUrl } = createHost(hash);
      expect(consumePortHandoff(host)).toBeUndefined();
      expect(store.size).toBe(0);
      expect(replaceUrl).toHaveBeenCalledWith("/system-status?tab=a");
    }
  });

  it("ignores a prototype-pollution attempt", () => {
    const text = '{"v":1,"preferences":{"__proto__":{"theme":"dark"},"constructor":{"theme":"dark"}},"route":"/x"}';
    const { host, store } = createHost(`#wi-handoff=${toBase64Url(text)}`);
    expect(consumePortHandoff(host)).toBe("/x");
    expect(store.size).toBe(0);
    expect(({} as Record<string, unknown>).theme).toBeUndefined();
  });

  it("drops unknown keys and bad values and falls back to the home route", () => {
    const text = JSON.stringify({
      v: 1,
      preferences: {
        theme: "light",
        locale: "xx",
        token: "secret",
        "wi.evil": "1",
        sidePanelWidths: { session: 5, "../x": 300 },
      },
      route: "//evil.example",
    });
    const { host, store } = createHost(`#wi-handoff=${toBase64Url(text)}`);
    expect(consumePortHandoff(host)).toBe("/");
    expect(Object.fromEntries(store)).toEqual({ "work-intelligence:theme": "light" });
  });

  it("survives a storage that throws", () => {
    const replaceUrl = vi.fn();
    const throwing = () => {
      throw new Error("blocked");
    };
    const fragment = encodePortHandoffFragment({ preferences: { theme: "dark" }, route: "/x" });
    const host: PortHandoffHost = {
      hash: `#${fragment}`,
      pathname: "/",
      search: "",
      storage: { getItem: throwing, setItem: throwing },
      replaceUrl,
    };
    expect(consumePortHandoff(host)).toBe("/x");
    expect(replaceUrl).toHaveBeenCalledWith("/");
    expect(consumePortHandoff({ ...host, storage: undefined })).toBe("/x");
  });
});

describe("an invalid handoff fragment", () => {
  it("leaves no hash behind, so the router never sees it", () => {
    const { host, replaceUrl } = createHost("#wi-handoff=@@@");
    expect(consumePortHandoff(host)).toBeUndefined();
    expect(replaceUrl).toHaveBeenCalledTimes(1);
    expect(replaceUrl.mock.calls[0]?.[0]).not.toContain("#");
  });
});

describe("gateHandoffRoute", () => {
  const resolve = (route: string) => ({
    matched: route === "/dashboard" ? [{ path: "/dashboard" }] : route === "/" ? [] : [{ path: "/:pathMatch(.*)*" }],
  });

  it("keeps a route that resolves to a real page", () => {
    expect(gateHandoffRoute("/dashboard", resolve)).toBe("/dashboard");
  });

  it("sends the catch-all and an unmatched route to the home route", () => {
    expect(gateHandoffRoute("/nowhere/at/all", resolve)).toBe("/");
    expect(gateHandoffRoute("/", resolve)).toBe("/");
  });
});

describe("readBrowserPreferences", () => {
  it("builds the snapshot from the existing keys and ignores everything else", () => {
    const { host } = createHost("", {
      "work-intelligence:locale": "zh-TW",
      "work-intelligence:theme": "system",
      "work-intelligence:editor": "vscode",
      "wi.projects.policyDismissed": "1",
      "wi.side-panel-width.session": "512",
      "wi.side-panel-width.diagram-reader": "abc",
      "wi.side-panel-width.knowledge-page": "10",
      "work-intelligence:secret": "token",
    });
    expect(readBrowserPreferences(host.storage)).toEqual({
      locale: "zh-TW",
      theme: "system",
      editor: "vscode",
      projectsPolicyDismissed: true,
      sidePanelWidths: { session: 512 },
    });
  });

  it("is empty for missing storage, a legacy locale value, or a policy flag other than 1", () => {
    expect(readBrowserPreferences(undefined)).toEqual({});
    const { host } = createHost("", { "work-intelligence:locale": "en", "wi.projects.policyDismissed": "0" });
    expect(readBrowserPreferences(host.storage)).toEqual({});
  });
});

describe("theme-init.js", () => {
  const sources = import.meta.glob("../../../apps/web/public/theme-init.js", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;
  const source = Object.values(sources)[0] ?? "";

  function run(hash: string, stored?: string, prefersDark = false): string | undefined {
    const documentElement = { dataset: {} as Record<string, string> };
    // The script is a plain browser file, so it is run against fake `window` and `document` objects.
    new Function("window", "document", source)(
      {
        localStorage: { getItem: () => stored ?? null },
        location: { hash },
        matchMedia: () => ({ matches: prefersDark }),
        atob,
      },
      { documentElement },
    );
    return documentElement.dataset.theme;
  }

  it("uses the theme from a handoff fragment for the first paint", () => {
    const fragment = encodePortHandoffFragment({ preferences: { theme: "dark" }, route: "/" });
    expect(run(`#${fragment}`)).toBe("dark");
    const light = encodePortHandoffFragment({ preferences: { theme: "light" }, route: "/" });
    expect(run(`#${light}`, undefined, true)).toBe("light");
    const system = encodePortHandoffFragment({ preferences: { theme: "system" }, route: "/" });
    expect(run(`#${system}`, "light", true)).toBe("dark");
  });

  it("ignores malformed fragments and keeps the saved theme", () => {
    expect(run("#wi-handoff=@@@", "dark")).toBe("dark");
    expect(run(`#wi-handoff=${toBase64Url('{"v":2,"preferences":{"theme":"dark"}}')}`, "light")).toBe("light");
    expect(run(`#wi-handoff=${toBase64Url('{"v":1,"preferences":{"theme":"purple"}}')}`, "light")).toBe("light");
    expect(run("#other", undefined, true)).toBe("dark");
  });
});
