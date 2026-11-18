import { describe, expect, it, vi } from "vitest";
import { followSystemTheme, LIGHT_SCHEME_QUERY, themeFor } from "../../apps/desktop/src/renderer/repair/theme.js";

function fakeQuery(matches: boolean) {
  let listener: (() => void) | undefined;
  const query = {
    matches,
    addEventListener: vi.fn((_type: string, next: () => void) => {
      listener = next;
    }),
  };
  return {
    query: query as unknown as MediaQueryList,
    change: (next: boolean) => ((query.matches = next), listener?.()),
  };
}

describe("the theme follows the system", () => {
  it("is light only when the system prefers light", () => {
    expect(themeFor(true)).toBe("light");
    expect(themeFor(false)).toBe("dark");
    expect(LIGHT_SCHEME_QUERY).toBe("(prefers-color-scheme: light)");
  });

  it("is set before anything is drawn and follows a change of the system setting", () => {
    const root = { dataset: {} as Record<string, string> } as unknown as HTMLElement;
    const { query, change } = fakeQuery(true);
    followSystemTheme(root, query);
    expect(root.dataset["theme"]).toBe("light");
    change(false);
    expect(root.dataset["theme"]).toBe("dark");
    change(true);
    expect(root.dataset["theme"]).toBe("light");
  });
});
