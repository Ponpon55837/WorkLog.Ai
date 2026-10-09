import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const mermaidRequire = createRequire(webRequire.resolve("mermaid"));
const katexEntry = mermaidRequire.resolve("katex");

describe("Mermaid math dependency security", () => {
  it("renders math but refuses inherited trust options after unrelated prototype pollution", () => {
    // A child process prevents this fictional pollution fixture from changing other tests or the app.
    const script = `
      const katex = require(${JSON.stringify(katexEntry)});
      Object.prototype.trust = true;
      try {
        const math = katex.renderToString("x^2", { throwOnError: false });
        const link = katex.renderToString(String.raw\`\\href{javascript:alert(1)}{x}\`, { throwOnError: false, strict: "ignore" });
        process.stdout.write(JSON.stringify({ math: math.includes('class="katex"'), unsafeHref: /href=["']javascript:/i.test(link) }));
      } finally { delete Object.prototype.trust; }
    `;
    const result = JSON.parse(execFileSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 10_000 }));
    expect(result).toEqual({ math: true, unsafeHref: false });
  });
});
