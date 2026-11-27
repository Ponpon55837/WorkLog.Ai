import { describe, expect, it } from "vitest";
import {
  MAX_HANDOFF_ROUTE_LENGTH,
  PORT_HANDOFF_FRAGMENT_KEY,
  decodePortHandoffFragment,
  encodePortHandoffFragment,
  isSafeHandoffRoute,
  openPortSettingsInputSchema,
  sanitizeBrowserPreferences,
  sanitizeHandoffRoute,
} from "../../packages/schema/src/index.js";

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fragmentOf(text: string): string {
  return `#${PORT_HANDOFF_FRAGMENT_KEY}=${toBase64Url(new TextEncoder().encode(text))}`;
}

describe("sanitizeBrowserPreferences", () => {
  it("keeps whitelisted valid values", () => {
    const input = {
      locale: "en-US",
      theme: "dark",
      editor: "vscode",
      projectsPolicyDismissed: true,
      sidePanelWidths: { session: 480, "graph-node": 300 },
    };
    expect(sanitizeBrowserPreferences(input)).toEqual(input);
  });

  it("drops unknown keys and bad values", () => {
    expect(
      sanitizeBrowserPreferences({
        locale: "fr-FR",
        theme: "blue",
        editor: 5,
        projectsPolicyDismissed: false,
        token: "secret",
        sidePanelWidths: { session: 10, "unknown-panel": 400, "graph-node": 1.5, "diagram-reader": 5000 },
      }),
    ).toEqual({});
    expect(sanitizeBrowserPreferences({ theme: "light", extra: 1, sidePanelWidths: { session: 200, x: 1 } })).toEqual({
      theme: "light",
      sidePanelWidths: { session: 200 },
    });
  });

  it("never throws on non-objects", () => {
    for (const value of [undefined, null, 1, "x", [], [1], true, Symbol.for("x")]) {
      expect(sanitizeBrowserPreferences(value)).toEqual({});
    }
    expect(sanitizeBrowserPreferences({ sidePanelWidths: "wide" })).toEqual({});
    expect(sanitizeBrowserPreferences({ sidePanelWidths: [400] })).toEqual({});
    expect(sanitizeBrowserPreferences(JSON.parse('{"__proto__":{"theme":"dark"}}'))).toEqual({});
  });
});

describe("handoff route", () => {
  it("accepts a plain route", () => {
    expect(isSafeHandoffRoute("/sessions/abc")).toBe(true);
    expect(isSafeHandoffRoute("/")).toBe(true);
    expect(isSafeHandoffRoute("/a".repeat(MAX_HANDOFF_ROUTE_LENGTH / 2))).toBe(true);
  });

  it.each([
    ["protocol-relative", "//evil"],
    ["double slash inside", "/a//b"],
    ["backslash", "\\x"],
    ["backslash after slash", "/\\x"],
    ["scheme", "http://x"],
    ["scheme only", "http:"],
    ["query", "/a?b"],
    ["hash", "/a#b"],
    ["too long", "/" + "a".repeat(MAX_HANDOFF_ROUTE_LENGTH)],
    ["non-ASCII", "/會話"],
    ["control character", "/a\nb"],
    ["tab", "/a\tb"],
    ["space", "/a b"],
    ["empty", ""],
    ["no leading slash", "sessions/abc"],
    ["not a string", 42],
  ])("rejects %s", (_name, value) => {
    expect(isSafeHandoffRoute(value)).toBe(false);
    expect(sanitizeHandoffRoute(value)).toBe("/");
  });

  it("accepts exactly the maximum length", () => {
    expect(isSafeHandoffRoute("/" + "a".repeat(MAX_HANDOFF_ROUTE_LENGTH - 1))).toBe(true);
    expect(isSafeHandoffRoute("/" + "a".repeat(MAX_HANDOFF_ROUTE_LENGTH))).toBe(false);
  });
});

describe("openPortSettingsInputSchema", () => {
  it("accepts an empty body and both fields, and refuses unknown fields", () => {
    expect(openPortSettingsInputSchema.safeParse({}).success).toBe(true);
    expect(openPortSettingsInputSchema.safeParse({ preferences: { theme: "dark" }, route: "/x" }).success).toBe(true);
    expect(openPortSettingsInputSchema.safeParse({ extra: 1 }).success).toBe(false);
    expect(openPortSettingsInputSchema.safeParse({ route: 5 }).success).toBe(false);
  });
});

describe("port handoff fragment", () => {
  it("round-trips a handoff", () => {
    const handoff = {
      preferences: { locale: "zh-TW" as const, theme: "system" as const, sidePanelWidths: { session: 512 } },
      route: "/sessions/abc",
    };
    const fragment = encodePortHandoffFragment(handoff);
    expect(fragment.startsWith(`${PORT_HANDOFF_FRAGMENT_KEY}=`)).toBe(true);
    expect(decodePortHandoffFragment(`#${fragment}`)).toEqual(handoff);
    expect(decodePortHandoffFragment(fragment)).toEqual(handoff);
  });

  it("encodes only sanitized content", () => {
    const fragment = encodePortHandoffFragment({
      preferences: { theme: "dark", token: "secret" } as never,
      route: "//evil",
    });
    expect(decodePortHandoffFragment(fragment)).toEqual({ preferences: { theme: "dark" }, route: "/" });
  });

  it("rejects a wrong key", () => {
    expect(decodePortHandoffFragment(`#other=${toBase64Url(new TextEncoder().encode('{"v":1}'))}`)).toBeUndefined();
    expect(decodePortHandoffFragment("")).toBeUndefined();
    expect(decodePortHandoffFragment(`#${PORT_HANDOFF_FRAGMENT_KEY}=`)).toBeUndefined();
  });

  it("rejects bad base64", () => {
    expect(decodePortHandoffFragment(`#${PORT_HANDOFF_FRAGMENT_KEY}=@@@`)).toBeUndefined();
    expect(decodePortHandoffFragment(`#${PORT_HANDOFF_FRAGMENT_KEY}=a`)).toBeUndefined();
    expect(decodePortHandoffFragment(`#${PORT_HANDOFF_FRAGMENT_KEY}=eyJ2IjoxfQ==`)).toBeUndefined();
  });

  it("rejects invalid UTF-8 and non-JSON", () => {
    const invalid = `#${PORT_HANDOFF_FRAGMENT_KEY}=${toBase64Url(new Uint8Array([0xff, 0xfe, 0xfd]))}`;
    expect(decodePortHandoffFragment(invalid)).toBeUndefined();
    expect(decodePortHandoffFragment(fragmentOf("not json"))).toBeUndefined();
    expect(decodePortHandoffFragment(fragmentOf("null"))).toBeUndefined();
    expect(decodePortHandoffFragment(fragmentOf("[1]"))).toBeUndefined();
  });

  it("rejects a version other than 1", () => {
    expect(decodePortHandoffFragment(fragmentOf('{"v":2,"preferences":{},"route":"/"}'))).toBeUndefined();
    expect(decodePortHandoffFragment(fragmentOf('{"preferences":{},"route":"/"}'))).toBeUndefined();
    expect(decodePortHandoffFragment(fragmentOf('{"v":"1"}'))).toBeUndefined();
  });

  it("rejects an oversize payload", () => {
    const big = JSON.stringify({ v: 1, preferences: {}, route: "/", pad: "x".repeat(5000) });
    expect(decodePortHandoffFragment(fragmentOf(big))).toBeUndefined();
  });

  it("re-sanitizes what it decodes", () => {
    const text = JSON.stringify({
      v: 1,
      preferences: { theme: "dark", locale: "xx", token: "secret", sidePanelWidths: { session: 1 } },
      route: "//evil",
    });
    expect(decodePortHandoffFragment(fragmentOf(text))).toEqual({ preferences: { theme: "dark" }, route: "/" });
    expect(decodePortHandoffFragment(fragmentOf('{"v":1}'))).toEqual({ preferences: {}, route: "/" });
  });
});
