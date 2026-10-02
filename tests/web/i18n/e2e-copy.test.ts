import { describe, expect, it } from "vitest";

// Browser specs, read as text. Interface copy must come from the message catalogs through tests/e2e/helpers/i18n.ts.
const SPECS = import.meta.glob("../../e2e/*.spec.ts", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;
const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
/** Calls and options whose text is interface copy the spec looks for. */
const LOCATOR =
  /(getByText|getByLabel|getByPlaceholder|getByTitle|toContainText|toHaveText|selectOption)\(|\b(name|hasText|label):/;
/** Chinese text the server or the fixtures write: records, not interface copy, so they are matched as stored. */
const DATA = new Set([
  "常見陷阱",
  "資料不足",
  "修改了 README.md",
  "磁碟上的 Work Intelligence MCP 建置已更新，請重新連線 MCP。",
  "自訂日期範圍已取得來源工作並完成整理。",
]);

describe("browser specs", () => {
  it("are found", () => {
    expect(Object.keys(SPECS).length).toBeGreaterThan(0);
  });

  it("look up interface copy by message key instead of hard-coding Chinese", () => {
    const hardCoded: string[] = [];
    for (const [file, code] of Object.entries(SPECS)) {
      code.split("\n").forEach((line, index) => {
        if (!CJK.test(line) || !LOCATOR.test(line)) return;
        const literals = [...line.matchAll(/(["'`])((?:(?!\1).)*)\1/g)].map((match) => match[2] ?? "");
        const copy = literals.filter((text) => CJK.test(text) && !DATA.has(text));
        if (copy.length) hardCoded.push(`${file}:${index + 1}: ${copy.join(" | ")}`);
      });
    }
    expect(hardCoded).toEqual([]);
  });
});
