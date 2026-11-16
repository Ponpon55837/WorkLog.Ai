import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const serverSource = resolve(import.meta.dirname, "../../apps/server/src");

// The entry point itself is not started here: with an invalid WORK_INTELLIGENCE_PORT it deliberately falls back to
// the default port 3210, and a test must never bind that port (see tests/shared/test-isolation.test.ts). The
// fallback value is covered by resolveServerPort in health.test.ts; this only pins that the entry point uses it.
describe("server entry point", () => {
  it("listens on the validated port from resolveServerPort rather than a raw environment value", () => {
    const source = readFileSync(resolve(serverSource, "start-api.ts"), "utf8");

    expect(source).toContain("const port = resolveServerPort();");
    expect(source).toMatch(/server\.listen\(port, "127\.0\.0\.1"/);
    expect(source).not.toMatch(/Number\(process\.env\.WORK_INTELLIGENCE_PORT\)/);
  });
});
