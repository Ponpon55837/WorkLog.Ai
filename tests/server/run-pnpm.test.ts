import { describe, expect, it } from "vitest";
import { buildWindowsPnpmCommandLine, quoteCmdArgument } from "../../scripts/run-pnpm.mjs";

describe("runPnpm Windows command line", () => {
  it("leaves plain arguments unquoted", () => {
    expect(buildWindowsPnpmCommandLine(["--version"])).toBe("pnpm --version");
    expect(buildWindowsPnpmCommandLine(["exec", "playwright", "test", "--project=chromium"])).toBe(
      "pnpm exec playwright test --project=chromium",
    );
    expect(quoteCmdArgument("--output=C:\\temp\\out")).toBe("--output=C:\\temp\\out");
  });

  it("quotes arguments with spaces, parentheses or empty values", () => {
    expect(quoteCmdArgument("C:\\Users\\Test User\\out")).toBe('"C:\\Users\\Test User\\out"');
    expect(quoteCmdArgument("a(b)")).toBe('"a(b)"');
    expect(quoteCmdArgument("")).toBe('""');
  });

  it("doubles trailing backslashes so they cannot escape the closing quote", () => {
    expect(quoteCmdArgument("C:\\Test Dir\\")).toBe('"C:\\Test Dir\\\\"');
  });

  it.each(['a"b', "100%", "a^b", "a&b", "a|b", "a<b", "a>b", "a\nb"])("rejects %j", (argument) => {
    expect(() => quoteCmdArgument(argument)).toThrow();
    expect(() => buildWindowsPnpmCommandLine(["ok", argument])).toThrow();
  });
});
