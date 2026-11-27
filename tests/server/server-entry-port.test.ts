import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const serverSource = resolve(import.meta.dirname, "../../apps/server/src");

// The entry point is not started: an invalid WORK_INTELLIGENCE_PORT falls back to 3210, which a test must never bind. This pins only that it uses resolveServerPort.
describe("server entry point", () => {
  it("listens on the validated port from resolveServerPort rather than a raw environment value", () => {
    const source = readFileSync(resolve(serverSource, "start-api.ts"), "utf8");

    expect(source).toContain("const port = options.port ?? resolveServerPort();");
    expect(source).toMatch(/server\.listen\(port, "127\.0\.0\.1"/);
    expect(source).not.toMatch(/Number\(process\.env\.WORK_INTELLIGENCE_PORT\)/);
  });
});
